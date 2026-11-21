import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PAIRING_KEY,
  PHONE_ID_KEY,
  PROTOCOL_VERSION,
  base64url,
  clearPairing,
  createKeyPair,
  decryptPayload,
  derivePairKeys,
  encryptPayload,
  ensurePhoneId,
  fromBase64url,
  importKey,
  joinPairing,
  loadPairing,
  payloadFromText,
  savePairing,
  tokenProof,
  validatePayload
} from '../lib/pairing.js'

/* ── 测试工具 ─────────────────────────────────────────────────────────── */

/** 确定性随机源：每次调用推进，可预测但覆盖字节空间。 */
function fakeRandom() {
  let seed = 0x2a2a2a2a
  return (n) => {
    const bytes = new Uint8Array(n)
    for (let i = 0; i < n; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      bytes[i] = (seed >>> 24) & 255
    }
    return bytes
  }
}

function memoryStorage() {
  const map = new Map()
  return {
    map,
    get(key) {
      return map.has(key) ? map.get(key) : null
    },
    set(key, value) {
      if (value === null) map.delete(key)
      else map.set(key, value)
    }
  }
}

/** 电脑端：生成配对码载荷 + pair.accepted 帧（与 server.ts 同一算法）。 */
function makePcSide(randomBytes) {
  const pair = createKeyPair(randomBytes)
  const secret = base64url(randomBytes(32))
  const keys = derivePairKeys(pair.privateKey, null, secret) // 占位，下面用手机公钥重算
  return { pair, secret, keys }
}

/** 完整两端密钥协商：返回 { pc, phone, pcKeys, phoneKeys }。 */
function makeSession(randomBytes) {
  const pc = createKeyPair(randomBytes)
  const phone = createKeyPair(randomBytes)
  const secret = base64url(randomBytes(32))
  const pcKeys = derivePairKeys(pc.privateKey, phone.publicBase64, secret)
  const phoneKeys = derivePairKeys(phone.privateKey, pc.publicBase64, secret)
  assert.deepEqual(pcKeys.pcToPhone, phoneKeys.pcToPhone)
  assert.deepEqual(pcKeys.phoneToPc, phoneKeys.phoneToPc)
  return { pc, phone, secret, pcKeys, phoneKeys }
}

function makePayload(session, overrides = {}) {
  return {
    v: 1,
    r: 'wss://relay.example.com/ws',
    d: 'pc-device-1234',
    k: 'lookup-key-abcdefghijklmnop',
    s: session.secret,
    p: session.pc.publicBase64,
    n: '工作电脑',
    x: 'room-abcdefghijklmnop',
    h: 'roomkey-abcdefghijklmnop',
    ...overrides
  }
}

function encodeCode(payload) {
  return `https://go.example.com/#p=${base64url(new TextEncoder().encode(JSON.stringify(payload)))}`
}

/** 假 socket：手动驱动 onopen/onmessage/onclose。 */
function fakeSocket() {
  const socket = {
    readyState: 1,
    sent: [],
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(text) {
      socket.sent.push(JSON.parse(text))
    },
    close() {
      socket.readyState = 3
      socket.onclose?.()
    }
  }
  return socket
}

function makeDeps(randomBytes, sockets) {
  return {
    randomBytes,
    connectSocket() {
      const socket = sockets.shift()
      if (!socket) throw new Error('没有更多假 socket')
      return socket
    },
    phoneId: () => 'phone-abcdefgh',
    phoneName: () => '测试手机',
    platform: () => 'android'
  }
}

/* ── base64url ────────────────────────────────────────────────────────── */

test('base64url：与标准 base64url 互逆，含边界长度', () => {
  for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'hello pilot 中文 🚀']) {
    const bytes = new TextEncoder().encode(text)
    const encoded = base64url(bytes)
    assert.ok(!/[+/=]/.test(encoded), '不应出现标准 base64 字符')
    assert.deepEqual(fromBase64url(encoded, 'x'), bytes)
  }
})

test('fromBase64url：非法字符直接拒绝', () => {
  assert.throws(() => fromBase64url('a+b/c', 'x'), /格式不正确/)
  assert.throws(() => fromBase64url('abc=', 'x'), /格式不正确/)
})

/* ── 密钥协商与加解密 ─────────────────────────────────────────────────── */

test('derivePairKeys：两端独立计算得到同一组密钥', () => {
  const randomBytes = fakeRandom()
  const session = makeSession(randomBytes)
  assert.equal(session.pcKeys.pcToPhone.length, 32)
  assert.equal(session.pcKeys.phoneToPc.length, 32)
  assert.notDeepEqual(session.pcKeys.pcToPhone, session.pcKeys.phoneToPc)
})

test('derivePairKeys：公钥或密钥格式不对直接拒绝', () => {
  const randomBytes = fakeRandom()
  const phone = createKeyPair(randomBytes)
  assert.throws(() => derivePairKeys(phone.privateKey, 'short', 'secret-1234567890abcdef'), /公钥/)
  assert.throws(
    () => derivePairKeys(phone.privateKey, phone.publicBase64, 'too-short'),
    /配对密钥过短/
  )
})

test('encryptPayload/decryptPayload：往返一致，AAD 绑定序号', () => {
  const randomBytes = fakeRandom()
  const session = makeSession(randomBytes)
  const value = { type: 'pair.accept', deviceId: 'pc-device-1234', token: 't'.repeat(32) }
  const envelope = encryptPayload(session.pcKeys.pcToPhone, value, 1, randomBytes)
  assert.equal(envelope.n, 1)
  const decoded = decryptPayload(session.pcKeys.pcToPhone, envelope)
  assert.deepEqual(decoded.value, value)
  assert.equal(decoded.seq, 1)

  // 换一个序号解不开（AAD 绑定 seq）
  assert.throws(
    () => decryptPayload(session.pcKeys.pcToPhone, { ...envelope, n: 2 }),
    /解密失败/
  )
})

test('encryptPayload/decryptPayload：错误密钥解不开', () => {
  const randomBytes = fakeRandom()
  const session = makeSession(randomBytes)
  const envelope = encryptPayload(session.pcKeys.pcToPhone, { a: 1 }, 1, randomBytes)
  assert.throws(() => decryptPayload(session.pcKeys.phoneToPc, envelope), /解密失败/)
})

test('decryptPayload：畸形信封一律拒绝', () => {
  const randomBytes = fakeRandom()
  const session = makeSession(randomBytes)
  const envelope = encryptPayload(session.pcKeys.pcToPhone, { a: 1 }, 1, randomBytes)
  assert.throws(() => decryptPayload(session.pcKeys.pcToPhone, null), /格式不正确/)
  assert.throws(() => decryptPayload(session.pcKeys.pcToPhone, { ...envelope, n: 0 }), /序号/)
  assert.throws(() => decryptPayload(session.pcKeys.pcToPhone, { ...envelope, iv: 'AAAA' }), /IV/)
  assert.throws(() => decryptPayload(session.pcKeys.pcToPhone, { ...envelope, data: 'AAAA' }), /密文长度/)
})

test('tokenProof：HMAC(token, challenge)，两端一致', () => {
  const proof = tokenProof('token-1234567890abcdef', 'challenge-xyz')
  assert.equal(typeof proof, 'string')
  assert.equal(proof.length, 43)
  assert.equal(proof, tokenProof('token-1234567890abcdef', 'challenge-xyz'))
  assert.notEqual(proof, tokenProof('token-1234567890abcdeg', 'challenge-xyz'))
})

test('importKey：长度不对拒绝', () => {
  assert.throws(() => importKey(base64url(new Uint8Array(16))), /加密密钥/)
})

/* ── 配对码解析 ───────────────────────────────────────────────────────── */

test('payloadFromText：链接、裸串、#p= 片段都能解析', () => {
  const randomBytes = fakeRandom()
  const session = makeSession(randomBytes)
  const payload = makePayload(session)
  const code = encodeCode(payload)
  const fromLink = payloadFromText(code)
  assert.equal(fromLink.deviceId, 'pc-device-1234')
  assert.equal(fromLink.lookup, 'lookup-key-abcdefghijklmnop')
  assert.equal(fromLink.relayUrl, 'wss://relay.example.com/ws')
  assert.equal(fromLink.room, 'room-abcdefghijklmnop')

  const raw = base64url(new TextEncoder().encode(JSON.stringify(payload)))
  assert.equal(payloadFromText(raw).deviceId, 'pc-device-1234')
})

test('payloadFromText：中继地址归一化（补协议、补路径、去尾斜杠）', () => {
  const randomBytes = fakeRandom()
  const session = makeSession(randomBytes)
  const cases = [
    ['relay.example.com', 'wss://relay.example.com/ws'],
    ['wss://relay.example.com', 'wss://relay.example.com/ws'],
    ['wss://relay.example.com/', 'wss://relay.example.com/ws'],
    ['wss://relay.example.com/ws/', 'wss://relay.example.com/ws'],
    ['https://relay.example.com/ws', 'wss://relay.example.com/ws'],
    ['ws://192.168.1.5:8080/ws', 'ws://192.168.1.5:8080/ws']
  ]
  for (const [input, expected] of cases) {
    const payload = payloadFromText(encodeCode(makePayload(session, { r: input })))
    assert.equal(payload.relayUrl, expected, input)
  }
})

test('payloadFromText：坏输入直接拒绝', () => {
  assert.throws(() => payloadFromText(''), /请粘贴/)
  assert.throws(() => payloadFromText('hello world'), /不是有效的配对链接/)
  assert.throws(() => payloadFromText('https://x/#p=%%%'), /格式不正确/)
  const randomBytes = fakeRandom()
  const session = makeSession(randomBytes)
  assert.throws(() => payloadFromText(encodeCode(makePayload(session, { v: 2 }))), /版本/)
  assert.throws(() => payloadFromText(encodeCode(makePayload(session, { d: 'x' }))), /电脑标识/)
  assert.throws(() => payloadFromText(encodeCode(makePayload(session, { k: 'x' }))), /配对标识/)
  assert.throws(() => payloadFromText(encodeCode(makePayload(session, { s: 'x' }))), /配对密钥/)
  assert.throws(() => payloadFromText(encodeCode(makePayload(session, { p: 'x' }))), /公钥/)
  assert.throws(
    () => payloadFromText(encodeCode(makePayload(session, { x: undefined }))),
    /云端连接信息/
  )
})

test('validatePayload：局域网地址可选，云端必须有房间', () => {
  const randomBytes = fakeRandom()
  const session = makeSession(randomBytes)
  const lan = validatePayload(makePayload(session, { r: 'ws://192.168.1.5:8080/ws', x: undefined, h: undefined }))
  assert.equal(lan.room, '')
  assert.equal(lan.localRelayUrl, '')
  const withLan = validatePayload(makePayload(session, { l: 'ws://192.168.1.5:8080/ws' }))
  assert.equal(withLan.localRelayUrl, 'ws://192.168.1.5:8080/ws')
})

/* ── joinPairing：完整首配流程 ────────────────────────────────────────── */

test('joinPairing：云端 wss 走 relay 握手 + pair.join + pair.accepted', async () => {
  const randomBytes = fakeRandom()
  const session = makeSession(randomBytes)
  const payload = makePayload(session)
  const socket = fakeSocket()
  const pending = []
  const deps = makeDeps(randomBytes, [socket])

  const promise = joinPairing(encodeCode(payload), deps, { onPending: () => pending.push(1) })

  // 1. open → relay.hello
  socket.onopen()
  assert.equal(socket.sent[0].type, 'relay.hello')
  assert.equal(socket.sent[0].room, 'room-abcdefghijklmnop')
  assert.equal(socket.sent[0].key, 'roomkey-abcdefghijklmnop')

  // 2. relay.ready → pair.join（包 relay.frame）
  socket.onmessage({ data: JSON.stringify({ type: 'relay.ready' }) })
  const join = socket.sent[1]
  assert.equal(join.type, 'relay.frame')
  assert.equal(join.data.type, 'pair.join')
  assert.equal(join.data.lookup, 'lookup-key-abcdefghijklmnop')
  assert.equal(join.data.phoneId, 'phone-abcdefgh')
  assert.equal(join.data.protocol, PROTOCOL_VERSION)
  assert.ok(join.data.phonePub.length === 64)

  // 3. 电脑确认：pair.accepted（payload 用 pcToPhone seq=1 加密）
  const token = 'token-0123456789abcdef'
  const inner = { type: 'pair.accept', deviceId: 'pc-device-1234', deviceName: '工作电脑', token }
  const envelope = encryptPayload(session.pcKeys.pcToPhone, inner, 1, randomBytes)
  socket.onmessage({ data: JSON.stringify({ type: 'pair.accepted', payload: envelope }) })

  const result = await promise
  assert.equal(result.v, 1)
  assert.equal(result.deviceId, 'pc-device-1234')
  assert.equal(result.deviceName, '工作电脑')
  assert.equal(result.token, token)
  assert.equal(result.relayUrl, 'wss://relay.example.com/ws')
  assert.equal(result.keys.pcToPhone, base64url(session.pcKeys.pcToPhone))
  assert.equal(result.keys.phoneToPc, base64url(session.pcKeys.phoneToPc))
  assert.equal(result.outSeq, 0)
  assert.equal(result.inSeq, 1)
  assert.deepEqual(pending, [])
})

test('joinPairing：局域网直连不包 relay.frame', async () => {
  const randomBytes = fakeRandom()
  const session = makeSession(randomBytes)
  const payload = makePayload(session, { r: 'ws://192.168.1.5:8080/ws', x: undefined, h: undefined })
  const socket = fakeSocket()
  const deps = makeDeps(randomBytes, [socket])

  const promise = joinPairing(encodeCode(payload), deps, {})
  socket.onopen()
  assert.equal(socket.sent[0].type, 'pair.join')
  const token = 'token-0123456789abcdef'
  const inner = { type: 'pair.accept', deviceId: 'pc-device-1234', deviceName: '工作电脑', token }
  const envelope = encryptPayload(session.pcKeys.pcToPhone, inner, 1, randomBytes)
  socket.onmessage({ data: JSON.stringify({ type: 'pair.accepted', payload: envelope }) })
  const result = await promise
  assert.equal(result.relayUrl, 'ws://192.168.1.5:8080/ws')
})

test('joinPairing：pair.pending 触发 onPending 且不中断', async () => {
  const randomBytes = fakeRandom()
  const session = makeSession(randomBytes)
  const payload = makePayload(session)
  const socket = fakeSocket()
  const pending = []
  const deps = makeDeps(randomBytes, [socket])

  const promise = joinPairing(encodeCode(payload), deps, { onPending: () => pending.push(1) })
  socket.onopen()
  socket.onmessage({ data: JSON.stringify({ type: 'relay.ready' }) })
  socket.onmessage({ data: JSON.stringify({ type: 'pair.pending' }) })
  assert.deepEqual(pending, [1])
  const token = 'token-0123456789abcdef'
  const inner = { type: 'pair.accept', deviceId: 'pc-device-1234', deviceName: '工作电脑', token }
  const envelope = encryptPayload(session.pcKeys.pcToPhone, inner, 1, randomBytes)
  socket.onmessage({ data: JSON.stringify({ type: 'pair.accepted', payload: envelope }) })
  await promise
})

test('joinPairing：deviceId 不一致拒绝（防串号）', async () => {
  const randomBytes = fakeRandom()
  const session = makeSession(randomBytes)
  const payload = makePayload(session)
  const socket = fakeSocket()
  const deps = makeDeps(randomBytes, [socket])

  const promise = joinPairing(encodeCode(payload), deps, {})
  socket.onopen()
  socket.onmessage({ data: JSON.stringify({ type: 'relay.ready' }) })
  const inner = { type: 'pair.accept', deviceId: 'other-device-9999', token: 'token-0123456789abcdef' }
  const envelope = encryptPayload(session.pcKeys.pcToPhone, inner, 1, randomBytes)
  socket.onmessage({ data: JSON.stringify({ type: 'pair.accepted', payload: envelope }) })
  await assert.rejects(promise, /电脑身份与配对链接不一致/)
})

test('joinPairing：pair.rejected / error 帧直接失败', async () => {
  const randomBytes = fakeRandom()
  const session = makeSession(randomBytes)
  const payload = makePayload(session)
  const socket = fakeSocket()
  const deps = makeDeps(randomBytes, [socket])

  const promise = joinPairing(encodeCode(payload), deps, {})
  socket.onopen()
  socket.onmessage({ data: JSON.stringify({ type: 'relay.ready' }) })
  socket.onmessage({ data: JSON.stringify({ type: 'pair.rejected', reason: '电脑端已取消' }) })
  await assert.rejects(promise, /电脑端已取消/)
})

test('joinPairing：relay.error 换下一个地址重试', async () => {
  const randomBytes = fakeRandom()
  const session = makeSession(randomBytes)
  const payload = makePayload(session, { l: 'ws://192.168.1.5:8080/ws' })
  const socket1 = fakeSocket()
  const socket2 = fakeSocket()
  const deps = makeDeps(randomBytes, [socket1, socket2])

  const promise = joinPairing(encodeCode(payload), deps, {})
  socket1.onopen()
  socket1.onmessage({ data: JSON.stringify({ type: 'relay.error', message: '云端连接器不可用' }) })
  // 第二个 socket 是局域网直连
  socket2.onopen()
  assert.equal(socket2.sent[0].type, 'pair.join')
  const token = 'token-0123456789abcdef'
  const inner = { type: 'pair.accept', deviceId: 'pc-device-1234', deviceName: '工作电脑', token }
  const envelope = encryptPayload(session.pcKeys.pcToPhone, inner, 1, randomBytes)
  socket2.onmessage({ data: JSON.stringify({ type: 'pair.accepted', payload: envelope }) })
  const result = await promise
  assert.equal(result.relayUrl, 'ws://192.168.1.5:8080/ws')
  assert.equal(result.fallbackUrl, 'wss://relay.example.com/ws')
})

test('joinPairing：全部地址失败时给出可读错误', async () => {
  const randomBytes = fakeRandom()
  const session = makeSession(randomBytes)
  const payload = makePayload(session, { l: 'ws://192.168.1.5:8080/ws' })
  const socket1 = fakeSocket()
  const socket2 = fakeSocket()
  const deps = makeDeps(randomBytes, [socket1, socket2])

  const promise = joinPairing(encodeCode(payload), deps, {})
  socket1.onopen()
  socket1.onclose()
  socket2.onopen()
  socket2.onclose()
  await assert.rejects(promise, /连接已断开/)
})

/* ── 存取 ─────────────────────────────────────────────────────────────── */

test('savePairing/loadPairing/clearPairing：落盘往返与坏数据防御', () => {
  const storage = memoryStorage()
  assert.equal(loadPairing(storage), null)
  const pairing = {
    v: 1,
    relayUrl: 'wss://relay.example.com/ws',
    deviceId: 'pc-device-1234',
    phoneId: 'phone-abcdefgh',
    token: 'token-0123456789abcdef',
    keys: { pcToPhone: base64url(new Uint8Array(32).fill(7)), phoneToPc: base64url(new Uint8Array(32).fill(8)) },
    outSeq: 3,
    inSeq: 5
  }
  savePairing(storage, pairing)
  assert.deepEqual(loadPairing(storage), pairing)
  clearPairing(storage)
  assert.equal(loadPairing(storage), null)

  storage.set(PAIRING_KEY, { v: 2 })
  assert.equal(loadPairing(storage), null)
  storage.set(PAIRING_KEY, { v: 1, relayUrl: 'wss://x/ws', token: 'short' })
  assert.equal(loadPairing(storage), null)
})

test('ensurePhoneId：生成、复用、坏值重建', () => {
  const storage = memoryStorage()
  const randomBytes = fakeRandom()
  const first = ensurePhoneId(storage, randomBytes)
  assert.ok(/^[A-Za-z0-9_-]{16}$}$/.test(first) || /^[A-Za-z0-9_-]{16}$/.test(first))
  assert.equal(ensurePhoneId(storage, randomBytes), first)
  storage.set(PHONE_ID_KEY, 'bad value!')
  const rebuilt = ensurePhoneId(storage, randomBytes)
  assert.notEqual(rebuilt, first)
  assert.ok(/^[A-Za0-9_-]*$/.test(rebuilt) || /^[A-Za-z0-9_-]+$/.test(rebuilt))
})

/* ── PairedLink（重连与消息收发） ─────────────────────────────────────── */

import { PairedLink } from '../lib/pairing.js'

function makePaired(randomBytes) {
  const session = makeSession(randomBytes)
  const pairing = {
    v: 1,
    relayUrl: 'wss://relay.example.com/ws',
    fallbackUrl: '',
    room: 'room-abcdefghijklmnop',
    roomKey: 'roomkey-abcdefghijklmnop',
    access: '',
    deviceId: 'pc-device-1234',
    deviceName: '工作电脑',
    phoneId: 'phone-abcdefgh',
    phoneName: '测试手机',
    token: 'token-0123456789abcdef',
    keys: {
      pcToPhone: base64url(session.pcKeys.pcToPhone),
      phoneToPc: base64url(session.phoneKeys.phoneToPc)
    },
    outSeq: 0,
    inSeq: 0,
    pairedAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z'
  }
  return { session, pairing }
}

function driveWelcome(link, socket, session) {
  socket.onopen()
  socket.onmessage({ data: JSON.stringify({ type: 'relay.ready' }) })
  socket.onmessage({ data: JSON.stringify({ type: 'hello.challenge', challenge: 'challenge-xyz' }) })
  const proof = tokenProof('token-0123456789abcdef', 'challenge-xyz')
  const sentProof = socket.sent.find((f) => f.type === 'relay.frame' && f.data?.type === 'hello.proof')
  assert.ok(sentProof, '应发送 hello.proof')
  assert.equal(sentProof.data.proof, proof)
  socket.onmessage({
    data: JSON.stringify({
      type: 'welcome',
      deviceId: 'pc-device-1234',
      phoneId: 'phone-abcdefgh',
      deviceName: '工作电脑',
      protocolVersion: 2
    })
  })
}

test('PairedLink：hello/challenge/proof → welcome → connected', async () => {
  const randomBytes = fakeRandom()
  const { session, pairing } = makePaired(randomBytes)
  const socket = fakeSocket()
  const states = []
  const link = new PairedLink(pairing, makeDeps(randomBytes, [socket]), {
    onState: (s) => states.push(s.state)
  })
  link.connect()
  driveWelcome(link, socket, session)
  assert.equal(link.connected, true)
  assert.equal(link.state, 'connected')
  assert.ok(states.includes('connecting'))
  assert.ok(states.includes('connected'))
  link.stop()
})

test('PairedLink：request/response 往返（加密信封）', async () => {
  const randomBytes = fakeRandom()
  const { session, pairing } = makePaired(randomBytes)
  const socket = fakeSocket()
  const link = new PairedLink(pairing, makeDeps(randomBytes, [socket]), {})
  link.connect()
  driveWelcome(link, socket, session)

  const pending = link.request('device.info', {})
  await new Promise((resolve) => setImmediate(resolve))
  const message = socket.sent.find((f) => f.type === 'relay.frame' && f.data?.type === 'message')
  assert.ok(message, '应发送 message 帧')
  const decoded = decryptPayload(session.phoneKeys.phoneToPc, message.data.payload)
  assert.equal(decoded.value.type, 'request')
  assert.equal(decoded.value.method, 'device.info')
  assert.equal(decoded.seq, 1)

  // 电脑回包：response 用 pcToPhone seq=1
  const response = encryptPayload(
    session.pcKeys.pcToPhone,
    { type: 'response', id: decoded.value.id, ok: true, data: { deviceName: '工作电脑' } },
    1,
    randomBytes
  )
  socket.onmessage({ data: JSON.stringify({ type: 'message', payload: response }) })
  assert.deepEqual(await pending, { deviceName: '工作电脑' })
  link.stop()
})

test('PairedLink：电脑下发 rc.* 命令，网关结果回传', async () => {
  const randomBytes = fakeRandom()
  const { session, pairing } = makePaired(randomBytes)
  const socket = fakeSocket()
  const commands = []
  const link = new PairedLink(pairing, makeDeps(randomBytes, [socket]), {
    onCommand: async ({ id, cmd, args }) => {
      commands.push({ id, cmd, args })
      return { pong: args.rtt }
    }
  })
  link.connect()
  driveWelcome(link, socket, session)

  const request = encryptPayload(
    session.pcKeys.pcToPhone,
    { type: 'request', id: 'req-1', method: 'rc.ping', params: { rtt: 42 } },
    1,
    randomBytes
  )
  socket.onmessage({ data: JSON.stringify({ type: 'message', payload: request }) })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(commands, [{ id: 'req-1', cmd: 'rc.ping', args: { rtt: 42 } }])
  const reply = socket.sent.find((f) => f.type === 'relay.frame' && f.data?.type === 'message')
  const decoded = decryptPayload(session.phoneKeys.phoneToPc, reply.data.payload)
  assert.equal(decoded.value.type, 'response')
  assert.equal(decoded.value.id, 'req-1')
  assert.equal(decoded.value.ok, true)
  assert.deepEqual(decoded.value.data, { pong: 42 })
  link.stop()
})

test('PairedLink：重放（seq≤inSeq）与坏密文直接丢弃', async () => {
  const randomBytes = fakeRandom()
  const { session, pairing } = makePaired(randomBytes)
  const socket = fakeSocket()
  const events = []
  const link = new PairedLink(pairing, makeDeps(randomBytes, [socket]), {
    onEvent: (data) => events.push(data)
  })
  link.connect()
  driveWelcome(link, socket, session)

  const make = (seq, value) =>
    encryptPayload(session.pcKeys.pcToPhone, value, seq, randomBytes)
  socket.onmessage({
    data: JSON.stringify({ type: 'message', payload: make(1, { type: 'event', data: { a: 1 } }) })
  })
  assert.deepEqual(events, [{ a: 1 }])
  // 重放 seq=1：丢弃
  socket.onmessage({
    data: JSON.stringify({ type: 'message', payload: make(1, { type: 'event', data: { a: 2 } }) })
  })
  assert.deepEqual(events, [{ a: 1 }])
  // 坏密文：丢弃，不崩
  socket.onmessage({
    data: JSON.stringify({ type: 'message', payload: { n: 5, iv: 'AAAAAAAAAAAAAAAA', data: 'AAAAAAAA' } })
  })
  assert.deepEqual(events, [{ a: 1 }])
  link.stop()
})

test('PairedLink：pair.revoked → fatal，不再重连', async () => {
  const randomBytes = fakeRandom()
  const { session, pairing } = makePaired(randomBytes)
  const socket = fakeSocket()
  const fatal = []
  const link = new PairedLink(pairing, makeDeps(randomBytes, [socket]), {
    onFatal: (info) => fatal.push(info)
  })
  link.connect()
  driveWelcome(link, socket, session)
  socket.onmessage({ data: JSON.stringify({ type: 'pair.revoked', reason: '已解除配对' }) })
  assert.equal(link.stopped, true)
  assert.deepEqual(fatal, [{ code: 'revoked', message: '已解除配对' }])
  link.stop()
})

test('PairedLink：welcome 身份不一致拒绝', async () => {
  const randomBytes = fakeRandom()
  const { session, pairing } = makePaired(randomBytes)
  const socket = fakeSocket()
  const link = new PairedLink(pairing, makeDeps(randomBytes, [socket]), {})
  link.connect()
  socket.onopen()
  socket.onmessage({ data: JSON.stringify({ type: 'relay.ready' }) })
  socket.onmessage({ data: JSON.stringify({ type: 'hello.challenge', challenge: 'c' }) })
  socket.onmessage({
    data: JSON.stringify({
      type: 'welcome',
      deviceId: 'other-device-9999',
      phoneId: 'phone-abcdefgh'
    })
  })
  assert.equal(link.connected, false)
  link.stop()
})

test('PairedLink：stop 后 pending 请求被拒绝', async () => {
  const randomBytes = fakeRandom()
  const { session, pairing } = makePaired(randomBytes)
  const socket = fakeSocket()
  const link = new PairedLink(pairing, makeDeps(randomBytes, [socket]), {})
  link.connect()
  driveWelcome(link, socket, session)
  const pending = link.request('device.info', {})
  link.stop()
  await assert.rejects(pending, /连接已关闭/)
})

test('PairedLink：局域网直连不包 relay.frame', async () => {
  const randomBytes = fakeRandom()
  const { session, pairing } = makePaired(randomBytes)
  pairing.relayUrl = 'ws://192.168.1.5:8080/ws'
  pairing.room = ''
  pairing.roomKey = ''
  const socket = fakeSocket()
  const link = new PairedLink(pairing, makeDeps(randomBytes, [socket]), {})
  link.connect()
  socket.onopen()
  assert.equal(socket.sent[0].type, 'hello')
  assert.equal(socket.sent[0].deviceId, 'pc-device-1234')
  socket.onmessage({
    data: JSON.stringify({
      type: 'welcome',
      deviceId: 'pc-device-1234',
      phoneId: 'phone-abcdefgh'
    })
  })
  assert.equal(link.connected, true)
  link.stop()
})

test('PairedLink：outSeq/inSeq 持久化推进', async () => {
  const randomBytes = fakeRandom()
  const { session, pairing } = makePaired(randomBytes)
  const socket = fakeSocket()
  const persisted = []
  const link = new PairedLink(pairing, makeDeps(randomBytes, [socket]), {
    onPersist: (p) => persisted.push({ outSeq: p.outSeq, inSeq: p.inSeq })
  })
  link.connect()
  driveWelcome(link, socket, session)
  link.send({ type: 'request', id: 'x1', method: 'rc.ping', params: {} })
  assert.equal(link.outSeq, 1)
  const response = encryptPayload(
    session.pcKeys.pcToPhone,
    { type: 'response', id: 'x1', ok: true, data: {} },
    1,
    randomBytes
  )
  socket.onmessage({ data: JSON.stringify({ type: 'message', payload: response }) })
  assert.equal(link.inSeq, 1)
  assert.deepEqual(persisted.at(-1), { outSeq: 1, inSeq: 1 })
  link.stop()
})
