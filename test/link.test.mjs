import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PAIRING_KEY,
  PHONE_ID_KEY,
  base64url,
  createKeyPair,
  decryptPayload,
  derivePairKeys,
  encryptPayload,
  fromBase64url,
  tokenProof
} from '../lib/pairing.js'
import { createLinkManager, randomBytes as systemRandomBytes } from '../lib/link.js'

/* ── 测试替身 ─────────────────────────────────────────────────────────── */

/** 确定性随机源：P-256 标量、IV、手机 ID 都由它生成，跑两次结果一致。 */
function fakeRandom() {
  let seed = 0x51ed270b
  return (n) => {
    const bytes = new Uint8Array(n)
    for (let i = 0; i < n; i += 1) {
      seed ^= seed << 13
      seed >>>= 0
      seed ^= seed >>> 17
      seed ^= seed << 5
      seed >>>= 0
      bytes[i] = seed & 255
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
      if (value === null || value === undefined) map.delete(key)
      else map.set(key, value)
    }
  }
}

/** 属性式假 socket：由测试手动推进 onopen / onmessage / onclose。 */
function fakeSocket() {
  const socket = {
    readyState: 1,
    sent: [],
    closed: false,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(text) {
      socket.sent.push(JSON.parse(text))
    },
    close() {
      socket.closed = true
      socket.readyState = 3
      socket.onclose?.()
    }
  }
  return socket
}

function recv(socket, frame) {
  socket.onmessage({ data: JSON.stringify(frame) })
}

/** 从已发包里取出某个内层帧（云端中继把内层包在 relay.frame.data 里）。 */
function frames(socket, innerType) {
  return socket.sent
    .map((frame) => (frame.type === 'relay.frame' ? frame.data : frame))
    .filter((inner) => inner && inner.type === innerType)
}

function lastFrame(socket, innerType) {
  return frames(socket, innerType).pop()
}

/** 电脑端：一对密钥 + 一个配对密钥，用来生成配对码和加解密下行消息。 */
function makeDesktop(randomBytes) {
  return { keys: createKeyPair(randomBytes), secret: base64url(randomBytes(32)) }
}

function makeCode(desktop, overrides = {}) {
  const payload = {
    v: 1,
    r: 'wss://relay.example.com/ws',
    d: 'pc-device-1234',
    k: 'lookup-key-abcdefghijklmnop',
    s: desktop.secret,
    p: desktop.keys.publicBase64,
    n: '工作电脑',
    x: 'room-abcdefghijklmnop',
    h: 'roomkey-abcdefghijklmnop',
    ...overrides
  }
  return `https://pilot.medpilot.cc/client/#p=${base64url(new TextEncoder().encode(JSON.stringify(payload)))}`
}

function makeManager({ randomBytes, sockets, storage, gateway, states }) {
  return createLinkManager({
    storage,
    randomBytes,
    connectSocket() {
      const socket = sockets.shift()
      if (!socket) throw new Error('测试没有准备更多 socket')
      return socket
    },
    systemInfo: () => ({ platform: 'android', deviceBrand: 'Pixel', deviceModel: '7' }),
    gateway: gateway || { handle: async () => ({ ok: true, data: {} }) },
    onState: (next) => states.push({ ...next })
  })
}

/**
 * 配对阶段：relay.hello → relay.ready → pair.join → （电脑派生密钥）→ pair.accepted。
 * 手机侧的临时密钥由 joinPairing 内部生成，只能在 pair.join 帧里读到。
 */
function drivePairing(socket, desktop, randomBytes, accept = { deviceName: '工作电脑' }) {
  socket.onopen()
  const hello = socket.sent[0]
  assert.equal(hello.type, 'relay.hello', '配对首帧应是 relay.hello')
  assert.equal(hello.room, 'room-abcdefghijklmnop')
  assert.equal(hello.key, 'roomkey-abcdefghijklmnop')
  assert.equal(hello.role, 'phone')

  recv(socket, { type: 'relay.ready' })
  const join = lastFrame(socket, 'pair.join')
  assert.ok(join, 'relay.ready 之后应发 pair.join')
  assert.equal(join.lookup, 'lookup-key-abcdefghijklmnop')
  assert.equal(join.protocol, 2)

  const pcKeys = derivePairKeys(desktop.keys.privateKey, join.phonePub, desktop.secret)
  recv(socket, {
    type: 'relay.frame',
    data: {
      type: 'pair.accepted',
      payload: encryptPayload(
        pcKeys.pcToPhone,
        {
          type: 'pair.accept',
          deviceId: 'pc-device-1234',
          deviceName: accept.deviceName,
          token: 'token-0123456789abcdef'
        },
        1,
        randomBytes
      )
    }
  })
  return pcKeys
}

/** 握手阶段：relay.hello → relay.ready → hello → challenge → proof → welcome。 */
function driveHandshake(socket, pairing) {
  socket.onopen()
  assert.equal(socket.sent[0].type, 'relay.hello', '重连首帧应是 relay.hello')

  recv(socket, { type: 'relay.ready' })
  const hello = lastFrame(socket, 'hello')
  assert.ok(hello, 'relay.ready 之后应发 hello')
  assert.equal(hello.deviceId, pairing.deviceId)
  assert.equal(hello.phoneId, pairing.phoneId)
  assert.equal(hello.protocol, 2)

  recv(socket, { type: 'relay.frame', data: { type: 'hello.challenge', challenge: 'challenge-xyz' } })
  const proof = lastFrame(socket, 'hello.proof')
  assert.ok(proof, '收到 challenge 应回 hello.proof')
  assert.equal(proof.proof, tokenProof(pairing.token, 'challenge-xyz'))

  recv(socket, {
    type: 'relay.frame',
    data: {
      type: 'welcome',
      deviceId: pairing.deviceId,
      phoneId: pairing.phoneId,
      deviceName: pairing.deviceName,
      protocolVersion: 2
    }
  })
}

/** 电脑端下发一条加密消息（seq 从 2 起：配对确认已占用 1）。 */
function deliver(socket, key, value, seq, randomBytes) {
  recv(socket, {
    type: 'relay.frame',
    data: { type: 'message', payload: encryptPayload(key, value, seq, randomBytes) }
  })
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

/* ── randomBytes ──────────────────────────────────────────────────────── */

test('randomBytes：长度正确、两次不同、请求 0 字节返回空', () => {
  assert.equal(systemRandomBytes(32).length, 32)
  assert.equal(systemRandomBytes(0).length, 0)
  assert.notDeepEqual(systemRandomBytes(32), systemRandomBytes(32))
  assert.notDeepEqual(systemRandomBytes(32), new Uint8Array(32))
})

/* ── 配对 → 握手 → online ─────────────────────────────────────────────── */

test('pair：配对成功后自动握手到 online', async () => {
  const randomBytes = fakeRandom()
  const desktop = makeDesktop(randomBytes)
  const storage = memoryStorage()
  const states = []
  const joinSocket = fakeSocket()
  const liveSocket = fakeSocket()
  const manager = makeManager({ randomBytes, sockets: [joinSocket, liveSocket], storage, states })

  const pending = manager.pair(makeCode(desktop))
  drivePairing(joinSocket, desktop, randomBytes)
  const pairing = await pending

  assert.equal(pairing.deviceId, 'pc-device-1234')
  assert.equal(pairing.deviceName, '工作电脑')
  assert.equal(pairing.keys.pcToPhone.length > 40, true)
  assert.equal(storage.get(PAIRING_KEY).token, 'token-0123456789abcdef')
  assert.ok(states.some((s) => s.status === 'pairing'))
  assert.ok(states.some((s) => s.status === 'connecting'), '配对完成后应进入 connecting')

  driveHandshake(liveSocket, pairing)
  const online = states[states.length - 1]
  assert.equal(online.status, 'online')
  assert.equal(online.deviceName, '工作电脑')
  assert.equal(online.detail, '已连接：工作电脑')
  assert.equal(manager.paired.deviceId, 'pc-device-1234')

  manager.disconnect()
})

test('pair：电脑端等确认时提示「允许」，状态仍是 pairing', async () => {
  const randomBytes = fakeRandom()
  const desktop = makeDesktop(randomBytes)
  const storage = memoryStorage()
  const states = []
  const joinSocket = fakeSocket()
  const manager = makeManager({ randomBytes, sockets: [joinSocket], storage, states })

  const pending = manager.pair(makeCode(desktop))
  joinSocket.onopen()
  recv(joinSocket, { type: 'relay.ready' })
  recv(joinSocket, { type: 'relay.frame', data: { type: 'pair.pending' } })

  const waiting = states[states.length - 1]
  assert.equal(waiting.status, 'pairing')
  assert.match(waiting.detail, /允许/)

  const join = lastFrame(joinSocket, 'pair.join')
  const pcKeys = derivePairKeys(desktop.keys.privateKey, join.phonePub, desktop.secret)
  recv(joinSocket, {
    type: 'relay.frame',
    data: {
      type: 'pair.accepted',
      payload: encryptPayload(
        pcKeys.pcToPhone,
        {
          type: 'pair.accept',
          deviceId: 'pc-device-1234',
          deviceName: '工作电脑',
          token: 'token-0123456789abcdef'
        },
        1,
        randomBytes
      )
    }
  })
  await pending
  manager.disconnect()
})

test('pair：电脑端拒绝时报错并停在 error，不落盘', async () => {
  const randomBytes = fakeRandom()
  const desktop = makeDesktop(randomBytes)
  const storage = memoryStorage()
  const states = []
  const joinSocket = fakeSocket()
  const manager = makeManager({ randomBytes, sockets: [joinSocket], storage, states })

  const pending = manager.pair(makeCode(desktop))
  joinSocket.onopen()
  recv(joinSocket, { type: 'relay.ready' })
  recv(joinSocket, { type: 'relay.frame', data: { type: 'pair.rejected', reason: '用户拒绝配对' } })

  await assert.rejects(() => pending, /用户拒绝配对/)
  const last = states[states.length - 1]
  assert.equal(last.status, 'error')
  assert.match(last.detail, /用户拒绝配对/)
  assert.equal(storage.get(PAIRING_KEY), null)
  assert.equal(manager.paired, null)
})

test('pair：不是配对码的文本直接拒绝，也不建连接', async () => {
  const randomBytes = fakeRandom()
  const states = []
  let connects = 0
  const manager = createLinkManager({
    storage: memoryStorage(),
    randomBytes,
    connectSocket() {
      connects += 1
      return fakeSocket()
    },
    systemInfo: () => ({}),
    onState: (next) => states.push(next)
  })

  await assert.rejects(() => manager.pair('这不是配对码'), /配对链接|配对码/)
  await assert.rejects(() => manager.pair('   '), /配对码/)
  assert.equal(connects, 0)
  assert.equal(states[states.length - 1].status, 'error')
})

test('pair：配对码缺云端房间信息时明确报错', async () => {
  const randomBytes = fakeRandom()
  const desktop = makeDesktop(randomBytes)
  const manager = makeManager({
    randomBytes,
    sockets: [],
    storage: memoryStorage(),
    states: []
  })
  await assert.rejects(() => manager.pair(makeCode(desktop, { x: '', h: '' })), /缺少云端连接信息/)
})

/* ── restore / retry / disconnect ─────────────────────────────────────── */

test('restore：没有落盘配对时停在 local', () => {
  const states = []
  const manager = makeManager({
    randomBytes: fakeRandom(),
    sockets: [],
    storage: memoryStorage(),
    states
  })
  assert.equal(manager.restore(), null)
  assert.equal(states.length, 1)
  assert.equal(states[0].status, 'local')
  assert.match(states[0].detail, /还没有配对/)
})

/** 造一份已落盘的配对记录（等价于上次配对成功后存下的内容）。 */
function savedPairing(randomBytes, storage, overrides = {}) {
  const desktop = makeDesktop(randomBytes)
  const phone = createKeyPair(randomBytes)
  const pcKeys = derivePairKeys(desktop.keys.privateKey, phone.publicBase64, desktop.secret)
  const phoneKeys = derivePairKeys(phone.privateKey, desktop.keys.publicBase64, desktop.secret)
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
    phoneName: 'Pixel 7',
    token: 'token-0123456789abcdef',
    keys: {
      pcToPhone: base64url(pcKeys.pcToPhone),
      phoneToPc: base64url(phoneKeys.phoneToPc)
    },
    outSeq: 0,
    inSeq: 1,
    pairedAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
  storage.set(PAIRING_KEY, pairing)
  return { pairing, pcKeys, phoneKeys }
}

test('restore：有落盘配对就直接连，握手后 online', () => {
  const randomBytes = fakeRandom()
  const storage = memoryStorage()
  const { pairing } = savedPairing(randomBytes, storage)
  const states = []
  const liveSocket = fakeSocket()
  const manager = makeManager({ randomBytes, sockets: [liveSocket], storage, states })

  const link = manager.restore()
  assert.ok(link, 'restore 应立刻发起连接')
  assert.equal(states[0].status, 'connecting')

  driveHandshake(liveSocket, pairing)
  const online = states[states.length - 1]
  assert.equal(online.status, 'online')
  assert.equal(online.pairedAt, pairing.pairedAt)

  manager.disconnect()
})

test('disconnect：清掉落盘配对并回到 local', () => {
  const randomBytes = fakeRandom()
  const storage = memoryStorage()
  const { pairing } = savedPairing(randomBytes, storage)
  const states = []
  const liveSocket = fakeSocket()
  const manager = makeManager({ randomBytes, sockets: [liveSocket], storage, states })
  manager.restore()
  driveHandshake(liveSocket, pairing)

  manager.disconnect()
  assert.equal(manager.paired, null)
  assert.equal(storage.get(PAIRING_KEY), null)
  assert.equal(liveSocket.closed, true, '断开时应关闭 socket')
  assert.equal(states[states.length - 1].status, 'local')
})

test('retry：未配对时返回 null，已连接时重开握手', () => {
  const randomBytes = fakeRandom()
  const storage = memoryStorage()
  const states = []
  const manager = makeManager({ randomBytes, sockets: [], storage, states })
  assert.equal(manager.retry(), null)

  const { pairing } = savedPairing(randomBytes, storage)
  const first = fakeSocket()
  const second = fakeSocket()
  const linked = makeManager({ randomBytes, sockets: [first, second], storage, states })
  linked.restore()
  driveHandshake(first, pairing)
  assert.equal(states[states.length - 1].status, 'online')

  const again = linked.retry()
  assert.ok(again)
  assert.equal(first.closed, true, 'retry 应换掉旧 socket')
  driveHandshake(second, pairing)
  assert.equal(states[states.length - 1].status, 'online')

  linked.disconnect()
})

/* ── 命令下发 ─────────────────────────────────────────────────────────── */

test('命令：电脑下发 rc.ping 交给网关，结果加密回传', async () => {
  const randomBytes = fakeRandom()
  const storage = memoryStorage()
  const { pairing } = savedPairing(randomBytes, storage)
  const states = []
  const handled = []
  const liveSocket = fakeSocket()
  const manager = makeManager({
    randomBytes,
    sockets: [liveSocket],
    storage,
    states,
    gateway: {
      handle: async (envelope) => {
        handled.push(envelope)
        return { ok: true, data: { pong: true, at: 1 } }
      }
    }
  })

  manager.restore()
  driveHandshake(liveSocket, pairing)

  const pcToPhone = fromBase64url(pairing.keys.pcToPhone)
  const phoneToPc = fromBase64url(pairing.keys.phoneToPc)
  deliver(liveSocket, pcToPhone, { type: 'request', id: 'req-1', method: 'rc.ping', params: {} }, 2, randomBytes)
  await flush()
  await flush()

  assert.equal(handled.length, 1)
  assert.deepEqual(handled[0], { id: 'req-1', cmd: 'rc.ping', args: {} })

  const reply = frames(liveSocket, 'message').pop()
  assert.ok(reply, '应回一条加密 response')
  const decoded = decryptPayload(phoneToPc, reply.payload)
  assert.equal(decoded.seq, 1)
  assert.equal(decoded.value.type, 'response')
  assert.equal(decoded.value.id, 'req-1')
  assert.equal(decoded.value.ok, true)
  assert.deepEqual(decoded.value.data, { ok: true, data: { pong: true, at: 1 } })

  manager.disconnect()
})

test('命令：网关拒绝时回 ok=false 和原因', async () => {
  const randomBytes = fakeRandom()
  const storage = memoryStorage()
  const { pairing } = savedPairing(randomBytes, storage)
  const states = []
  const liveSocket = fakeSocket()
  const manager = makeManager({
    randomBytes,
    sockets: [liveSocket],
    storage,
    states,
    gateway: {
      handle: async () => ({ ok: false, error: { message: '未授权的操作' } })
    }
  })

  manager.restore()
  driveHandshake(liveSocket, pairing)
  deliver(
    liveSocket,
    fromBase64url(pairing.keys.pcToPhone),
    { type: 'request', id: 'req-2', method: 'rc.tap', params: { x: 1, y: 2 } },
    2,
    randomBytes
  )
  await flush()
  await flush()

  const reply = frames(liveSocket, 'message').pop()
  const decoded = decryptPayload(fromBase64url(pairing.keys.phoneToPc), reply.payload)
  assert.equal(decoded.value.ok, false)
  assert.equal(decoded.value.error, '未授权的操作')

  manager.disconnect()
})

test('命令：网关抛错也回一条失败响应，不让电脑干等', async () => {
  const randomBytes = fakeRandom()
  const storage = memoryStorage()
  const { pairing } = savedPairing(randomBytes, storage)
  const liveSocket = fakeSocket()
  const manager = makeManager({
    randomBytes,
    sockets: [liveSocket],
    storage,
    states: [],
    gateway: {
      handle: async () => {
        throw new Error('设备未授权')
      }
    }
  })

  manager.restore()
  driveHandshake(liveSocket, pairing)
  deliver(
    liveSocket,
    fromBase64url(pairing.keys.pcToPhone),
    { type: 'request', id: 'req-3', method: 'rc.status', params: {} },
    2,
    randomBytes
  )
  await flush()
  await flush()

  const decoded = decryptPayload(
    fromBase64url(pairing.keys.phoneToPc),
    frames(liveSocket, 'message').pop().payload
  )
  assert.equal(decoded.value.ok, false)
  assert.equal(decoded.value.error, '设备未授权')
  manager.disconnect()
})

test('命令：seq 重复的帧直接丢弃，不重复执行', async () => {
  const randomBytes = fakeRandom()
  const storage = memoryStorage()
  const { pairing } = savedPairing(randomBytes, storage)
  const handled = []
  const liveSocket = fakeSocket()
  const manager = makeManager({
    randomBytes,
    sockets: [liveSocket],
    storage,
    states: [],
    gateway: {
      handle: async (envelope) => {
        handled.push(envelope)
        return { ok: true }
      }
    }
  })

  manager.restore()
  driveHandshake(liveSocket, pairing)
  const pcToPhone = fromBase64url(pairing.keys.pcToPhone)
  const envelope = encryptPayload(
    pcToPhone,
    { type: 'request', id: 'req-4', method: 'rc.ping', params: {} },
    2,
    randomBytes
  )
  recv(liveSocket, { type: 'relay.frame', data: { type: 'message', payload: envelope } })
  recv(liveSocket, { type: 'relay.frame', data: { type: 'message', payload: envelope } })
  await flush()
  await flush()

  assert.equal(handled.length, 1, '同一 seq 只应执行一次')
  manager.disconnect()
})

test('命令：手机侧 request 收到电脑响应后 resolve', async () => {
  const randomBytes = fakeRandom()
  const storage = memoryStorage()
  const { pairing } = savedPairing(randomBytes, storage)
  const liveSocket = fakeSocket()
  const manager = makeManager({ randomBytes, sockets: [liveSocket], storage, states: [] })

  manager.restore()
  driveHandshake(liveSocket, pairing)

  const pending = manager.request('rc.status', { verbose: true })
  const sent = frames(liveSocket, 'message').pop()
  const outbound = decryptPayload(fromBase64url(pairing.keys.phoneToPc), sent.payload)
  assert.equal(outbound.value.type, 'request')
  assert.equal(outbound.value.method, 'rc.status')

  deliver(
    liveSocket,
    fromBase64url(pairing.keys.pcToPhone),
    { type: 'response', id: outbound.value.id, ok: true, data: { level: 3 } },
    2,
    randomBytes
  )
  assert.deepEqual(await pending, { level: 3 })
  manager.disconnect()
})

test('命令：没连上时 request 直接报错，不排队', async () => {
  const manager = makeManager({
    randomBytes: fakeRandom(),
    sockets: [],
    storage: memoryStorage(),
    states: []
  })
  await assert.rejects(() => manager.request('rc.ping'), /尚未连接电脑/)
})

/* ── 连接失效 ─────────────────────────────────────────────────────────── */

test('连接：电脑解除配对后清掉落盘记录并回到 local', () => {
  const randomBytes = fakeRandom()
  const storage = memoryStorage()
  const { pairing } = savedPairing(randomBytes, storage)
  const states = []
  const liveSocket = fakeSocket()
  const manager = makeManager({ randomBytes, sockets: [liveSocket], storage, states })

  manager.restore()
  driveHandshake(liveSocket, pairing)
  recv(liveSocket, { type: 'relay.frame', data: { type: 'pair.revoked', reason: '电脑已解除配对' } })

  const last = states[states.length - 1]
  assert.equal(last.status, 'local')
  assert.match(last.detail, /电脑已解除配对/)
  assert.equal(manager.paired, null)
  assert.equal(storage.get(PAIRING_KEY), null)
})

test('连接：socket 断开进入 offline 并自动重连', () => {
  const randomBytes = fakeRandom()
  const storage = memoryStorage()
  const { pairing } = savedPairing(randomBytes, storage)
  const states = []
  const first = fakeSocket()
  const second = fakeSocket()
  const manager = makeManager({ randomBytes, sockets: [first, second], storage, states })

  manager.restore()
  driveHandshake(first, pairing)
  assert.equal(states[states.length - 1].status, 'online')

  first.close()
  const offline = states[states.length - 1]
  assert.ok(
    offline.status === 'offline' || offline.status === 'connecting',
    `断开后应进入 offline/connecting，实际 ${offline.status}`
  )

  // 重连定时器会在 600ms 后拉起第二个 socket；直接等它连上并握手。
  return new Promise((resolve) => {
    setTimeout(() => {
      driveHandshake(second, pairing)
      assert.equal(states[states.length - 1].status, 'online')
      manager.disconnect()
      resolve()
    }, 900)
  })
})

/* ── phoneId ──────────────────────────────────────────────────────────── */

test('phoneId：首次生成后落盘复用，配对里带上同一 ID', async () => {
  const randomBytes = fakeRandom()
  const desktop = makeDesktop(randomBytes)
  const storage = memoryStorage()
  const joinSocket = fakeSocket()
  const liveSocket = fakeSocket()
  const manager = makeManager({ randomBytes, sockets: [joinSocket, liveSocket], storage, states: [] })

  const pending = manager.pair(makeCode(desktop))
  drivePairing(joinSocket, desktop, randomBytes)
  const pairing = await pending

  const phoneId = storage.get(PHONE_ID_KEY)
  assert.match(phoneId, /^[A-Za-z0-9_-]{16}$/)
  assert.equal(pairing.phoneId, phoneId)
  assert.equal(pairing.phoneName, 'Pixel 7')
  manager.disconnect()
})
