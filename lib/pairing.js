/**
 * Pilot Client 的配对通道：与电脑端 companion server 的 E2E 协议对齐。
 *
 * 协议（与 pilot/pilot/src/main/companion/server.ts、pilot/pilot/companion/app.js 逐字节镜像）：
 * 1. 配对码是 `#p=<base64url(JSON)>` 链接或裸 base64url 串，字段 v/r/d/k/s/p(/l/x/h/a)；
 * 2. 手机生成 P-256 临时密钥，发 `pair.join`（lookup/phoneId/name/phonePub/protocol:2）；
 *    云端 wss 需先发明文 `relay.hello`（room/key/access），收到 `relay.ready` 后业务帧
 *    一律包 `{type:'relay.frame',data}`；局域网 ws 直连不包；
 * 3. 电脑确认后回 `pair.accepted`，其 payload 用 pcToPhone 键 seq=1 加密，内含
 *    `{type:'pair.accept',deviceId,deviceName,token}`；手机校验 deviceId 一致后落盘；
 * 4. 重连走 `hello`（protocol:2）→ `hello.challenge` → `hello.proof`（HMAC(token,challenge)）
 *    → `welcome`；之后业务帧 `{type:'message',payload:envelope}`，envelope=AES-256-GCM，
 *    AAD=String(seq)，双向独立计数，收到 seq≤inSeq 的帧丢弃。
 *
 * 加密实现用 vendored @noble（与 companion PWA 同源），不依赖 WebCrypto：
 * uni-app 的 plus 环境没有 globalThis.crypto.getRandomValues 的保证，随机数走注入的
 * `randomBytes`（App 里用 plus / uni 的实现，测试里用确定性假实现）。
 *
 * WebSocket 也注入：App 里是 uni.connectSocket 包装，测试里是假 socket。
 */

import { gcm } from './vendor/noble/ciphers/aes.js'
import { p256 } from './vendor/noble/curves/nist.js'
import { hkdf } from './vendor/noble/hashes/hkdf.js'
import { hmac } from './vendor/noble/hashes/hmac.js'
import { sha256 } from './vendor/noble/hashes/sha2.js'

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_ENVELOPE = 512 * 1024
const INFO_PC_TO_PHONE = 'pilot-link-e2e-v1:pc-to-phone'
const INFO_PHONE_TO_PC = 'pilot-link-e2e-v1:phone-to-pc'

export const PAIRING_KEY = 'pilot-client.pairing.v1'
export const PHONE_ID_KEY = 'pilot-client.phone-id.v1'
export const PROTOCOL_VERSION = 2

/* ── base64url（不依赖 btoa/atob，uni-app 环境可用） ───────────────────── */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function bytesToBase64(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : ''
    out += i + 2 < bytes.length ? B64[b2 & 63] : ''
  }
  return out
}

function base64ToBytes(text) {
  const size = Math.floor((text.length * 3) / 4)
  const bytes = new Uint8Array(size)
  let pos = 0
  for (let i = 0; i < text.length; i += 4) {
    const n =
      (B64.indexOf(text[i]) << 18) |
      (B64.indexOf(text[i + 1] ?? '') << 12) |
      (B64.indexOf(text[i + 2] ?? '') << 6) |
      B64.indexOf(text[i + 3] ?? '')
    if (pos < size) bytes[pos++] = (n >> 16) & 255
    if (pos < size) bytes[pos++] = (n >> 8) & 255
    if (pos < size) bytes[pos++] = n & 255
  }
  return bytes
}

export function base64url(bytes) {
  return bytesToBase64(bytes)
}

export function fromBase64url(value, label) {
  const text = String(value ?? '')
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error(`${label}格式不正确`)
  return base64ToBytes(text)
}

export const utf8Encode = (text) => new TextEncoder().encode(String(text))
export const utf8Decode = (bytes) => new TextDecoder().decode(bytes)

/* ── E2E crypto（镜像 companion/crypto.js） ────────────────────────────── */

function prefixPublicKey(raw) {
  if (raw.length !== 64) throw new Error('公钥长度不正确')
  const point = new Uint8Array(65)
  point[0] = 4
  point.set(raw, 1)
  return point
}

export function createKeyPair(randomBytes) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const privateKey = randomBytes(32)
    try {
      const publicKey = p256.getPublicKey(privateKey, false)
      if (publicKey.length !== 65) continue
      return { privateKey, publicBase64: base64url(publicKey.subarray(1)) }
    } catch {
      // Random scalars outside the curve order are retried.
    }
  }
  throw new Error('无法生成手机密钥')
}

export function derivePairKeys(privateKey, peerPublicBase64, pairSecretBase64) {
  const peerPoint = prefixPublicKey(fromBase64url(peerPublicBase64, '公钥'))
  const secret = fromBase64url(pairSecretBase64, '配对密钥')
  if (secret.length < 16) throw new Error('配对密钥过短')
  const shared = p256.getSharedSecret(privateKey, peerPoint, true).subarray(1)
  if (shared.length !== KEY_BYTES) throw new Error('共享密钥长度不正确')
  return {
    pcToPhone: Uint8Array.from(
      hkdf(sha256, shared, secret, utf8Encode(INFO_PC_TO_PHONE), KEY_BYTES),
    ),
    phoneToPc: Uint8Array.from(
      hkdf(sha256, shared, secret, utf8Encode(INFO_PHONE_TO_PC), KEY_BYTES),
    ),
  }
}

export function encryptPayload(key, value, seq, randomBytes) {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw new Error('加密密钥不正确')
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('消息序号不正确')
  const iv = randomBytes(IV_BYTES)
  const packed = gcm(key, iv, utf8Encode(String(seq))).encrypt(
    utf8Encode(JSON.stringify(value)),
  )
  return { n: seq, iv: base64url(iv), data: base64url(packed) }
}

export function decryptPayload(key, envelope) {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw new Error('加密密钥不正确')
  if (!envelope || typeof envelope !== 'object') throw new Error('加密消息格式不正确')
  const seq = envelope.n
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('消息序号不正确')
  const iv = fromBase64url(envelope.iv, 'IV')
  if (iv.length !== IV_BYTES) throw new Error('IV 长度不正确')
  const packed = fromBase64url(envelope.data, '密文')
  if (packed.length <= TAG_BYTES || packed.length > MAX_ENVELOPE) {
    throw new Error('密文长度不正确')
  }
  let plaintext
  try {
    plaintext = gcm(key, iv, utf8Encode(String(seq))).decrypt(packed)
  } catch {
    throw new Error('消息解密失败')
  }
  return { seq, value: JSON.parse(utf8Decode(plaintext)) }
}

export function tokenProof(token, challenge) {
  if (typeof token !== 'string' || !token) throw new Error('配对凭证不正确')
  return base64url(hmac(sha256, utf8Encode(token), utf8Encode(String(challenge))))
}

export function importKey(value) {
  const key = fromBase64url(value, '加密密钥')
  if (key.length !== KEY_BYTES) throw new Error('加密密钥不正确')
  return key
}

/* ── 配对码解析（镜像 app.js 的 validatePayload/decodePayload） ────────── */

function normalizeRelayUrl(value) {
  let text = String(value || '').trim()
  if (!text) throw new Error('缺少中继地址')
  if (!/^[a-z]+:\/\//i.test(text)) text = `wss://${text}`
  const match = /^(wss?|https?):\/\/([^/?#]+)([^?#]*)/i.exec(text)
  if (!match) throw new Error('配对链接格式不正确')
  let protocol = match[1].toLowerCase()
  if (protocol === 'https') protocol = 'wss'
  if (protocol === 'http') protocol = 'ws'
  if (protocol !== 'ws' && protocol !== 'wss') throw new Error('中继地址不正确')
  let path = match[3] || ''
  if (!path) path = '/ws'
  path = path.replace(/\/+$/, '')
  return `${protocol}://${match[2]}${path}`
}

export function validatePayload(data) {
  if (!data || typeof data !== 'object') throw new Error('配对链接内容不正确')
  if (data.v !== 1) throw new Error('配对链接版本不受支持')
  if (typeof data.r !== 'string' || !data.r.trim()) throw new Error('配对链接缺少中继地址')
  if (typeof data.d !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(data.d)) {
    throw new Error('配对链接缺少电脑标识')
  }
  if (typeof data.k !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(data.k)) {
    throw new Error('配对链接缺少配对标识')
  }
  if (typeof data.s !== 'string' || data.s.length < 20) throw new Error('配对链接缺少配对密钥')
  if (typeof data.p !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(data.p)) {
    throw new Error('配对链接中的电脑公钥不正确')
  }
  const relayUrl = normalizeRelayUrl(data.r)
  const localRelayUrl =
    typeof data.l === 'string' && data.l.trim() ? normalizeRelayUrl(data.l) : ''
  const room = typeof data.x === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(data.x) ? data.x : ''
  const roomKey =
    typeof data.h === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(data.h) ? data.h : ''
  const access =
    typeof data.a === 'string' && /^[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_-]{16,128}$/.test(data.a)
      ? data.a
      : ''
  if (/^wss:\/\//i.test(relayUrl) && (!room || !roomKey)) {
    throw new Error('配对链接缺少云端连接信息')
  }
  return {
    v: 1,
    relayUrl,
    localRelayUrl,
    room,
    roomKey,
    access,
    deviceId: data.d,
    deviceName: String(data.n || '电脑').slice(0, 80),
    lookup: data.k,
    secret: data.s,
    publicKey: data.p,
  }
}

function decodePayload(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('配对链接缺少配对内容')
  let json
  try {
    json = utf8Decode(fromBase64url(raw.trim(), '配对链接'))
  } catch {
    throw new Error('配对链接格式不正确')
  }
  let data
  try {
    data = JSON.parse(json)
  } catch {
    throw new Error('配对链接内容无法解析')
  }
  return validatePayload(data)
}

export function payloadFromText(text) {
  const value = String(text || '').trim()
  if (!value) throw new Error('请粘贴配对链接')
  const marker = value.indexOf('#p=')
  if (marker >= 0) return decodePayload(value.slice(marker + 3))
  if (/^[A-Za-z0-9_-]{40,}$/.test(value)) return decodePayload(value)
  throw new Error('这看起来不是有效的配对链接')
}

/* ── 连接器 ───────────────────────────────────────────────────────────── */

const OPEN = 1

function isWrappedUrl(url, pairing) {
  return /^wss:\/\//i.test(String(url || '')) && Boolean(pairing?.room && pairing?.roomKey)
}

/**
 * 一次性配对：解析配对码 → 连 relay/LAN → pair.join → 等 pair.accepted。
 * 返回落盘用的 pairing 对象（含密钥与 token）。
 *
 * deps 注入：
 * - `connectSocket(url)` → { send(text), close(), onopen, onmessage, onerror, onclose }
 *   （App 里用 uni.connectSocket 包装，测试里用假实现）
 * - `randomBytes(n)` → Uint8Array
 * - `phoneId()` / `phoneName()` / `platform()`
 */
export function joinPairing(code, deps, options = {}) {
  const payload = payloadFromText(code)
  const pair = createKeyPair(deps.randomBytes)
  const id = deps.phoneId()
  const name = deps.phoneName()
  const platform = deps.platform()
  const urls = [payload.relayUrl, payload.localRelayUrl].filter(
    (url, index, list) => url && list.indexOf(url) === index,
  )
  const attemptTimeout = options.attemptTimeout ?? 15_000
  const totalTimeout = options.totalTimeout ?? 90_000

  return new Promise((resolve, reject) => {
    let socket = null
    let settled = false
    let lastError = ''
    let index = 0
    let attemptTimer = null
    const totalTimer = setTimeout(
      () => finish(new Error('等待电脑确认超时，请在电脑上重新生成二维码')),
      totalTimeout,
    )
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(totalTimer)
      clearTimeout(attemptTimer)
      try {
        socket?.close()
      } catch {
        // ignore
      }
      if (error) reject(error)
      else resolve(result)
    }
    const tryNext = (error) => {
      if (settled) return
      if (error) lastError = error.message || String(error)
      clearTimeout(attemptTimer)
      try {
        socket?.close()
      } catch {
        // ignore
      }
      socket = null
      index += 1
      if (index >= urls.length) {
        finish(new Error(lastError || '与电脑的连接已断开，请重试'))
        return
      }
      open(urls[index], index > 0)
    }
    const open = (url, fallback) => {
      let next
      try {
        next = deps.connectSocket(url)
      } catch (error) {
        lastError = `无法连接电脑：${error?.message || error}`
        tryNext()
        return
      }
      socket = next
      const wrapped = isWrappedUrl(url, payload)
      let ready = false
      const send = (frame, raw = false) => {
        if (socket !== next || settled) return
        try {
          next.send(JSON.stringify(raw || !wrapped ? frame : { type: 'relay.frame', data: frame }))
        } catch (error) {
          lastError = error?.message || String(error)
          tryNext()
        }
      }
      const join = () => {
        send({
          type: 'pair.join',
          lookup: payload.lookup,
          phoneId: id,
          name,
          phonePub: pair.publicBase64,
          platform,
          protocol: PROTOCOL_VERSION,
        })
      }
      attemptTimer = setTimeout(() => {
        if (socket !== next || settled) return
        lastError = fallback ? '局域网连接超时' : '连接电脑超时'
        tryNext()
      }, attemptTimeout)
      next.onopen = () => {
        if (socket !== next || settled) return
        if (wrapped) {
          send(
            {
              type: 'relay.hello',
              role: 'phone',
              room: payload.room,
              key: payload.roomKey,
              protocol: 1,
              ...(payload.access ? { access: payload.access } : {}),
            },
            true,
          )
        } else {
          join()
        }
      }
      next.onmessage = (event) => {
        if (socket !== next || settled) return
        let frame
        try {
          frame = JSON.parse(String(event.data || ''))
        } catch {
          return
        }
        if (!frame || typeof frame.type !== 'string') return
        if (frame.type === 'relay.ready') {
          if (wrapped && !ready) {
            ready = true
            join()
          }
          return
        }
        if (frame.type === 'relay.frame') {
          frame = frame.data
          if (!frame || typeof frame.type !== 'string') return
        }
        if (frame.type === 'relay.error' || frame.type === 'relay.offline') {
          lastError = frame.message || '云端连接器暂时不可用'
          tryNext()
          return
        }
        if (frame.type === 'pair.rejected' || frame.type === 'error') {
          finish(new Error(frame.reason || frame.message || '电脑端拒绝了配对'))
          return
        }
        if (frame.type === 'pair.pending') {
          clearTimeout(attemptTimer)
          options.onPending?.()
          return
        }
        if (frame.type !== 'pair.accepted') return
        clearTimeout(attemptTimer)
        try {
          const keys = derivePairKeys(pair.privateKey, payload.publicKey, payload.secret)
          const decoded = decryptPayload(keys.pcToPhone, frame.payload)
          if (decoded.seq !== 1) throw new Error('配对确认序号不正确')
          const value = decoded.value
          if (!value || value.type !== 'pair.accept') throw new Error('配对确认内容不正确')
          if (value.deviceId !== payload.deviceId) {
            throw new Error('电脑身份与配对链接不一致')
          }
          const token = typeof value.token === 'string' ? value.token : frame.token
          if (typeof token !== 'string' || token.length < 20) {
            throw new Error('电脑没有返回配对凭证')
          }
          const now = new Date().toISOString()
          finish(null, {
            v: 1,
            relayUrl: url,
            fallbackUrl: urls.find((candidate) => candidate !== url) || '',
            room: payload.room,
            roomKey: payload.roomKey,
            access: payload.access || '',
            deviceId: payload.deviceId,
            deviceName: value.deviceName || payload.deviceName,
            phoneId: id,
            phoneName: name,
            token,
            keys: {
              pcToPhone: base64url(keys.pcToPhone),
              phoneToPc: base64url(keys.phoneToPc),
            },
            outSeq: 0,
            inSeq: 1,
            pairedAt: now,
            lastActiveAt: now,
          })
        } catch (error) {
          finish(error)
        }
      }
      next.onerror = () => {
        if (socket !== next || settled) return
        lastError = '连接电脑失败'
      }
      next.onclose = () => {
        if (socket !== next || settled) return
        lastError = lastError || '与电脑的连接已断开，请重试'
        tryNext()
      }
    }
    if (urls.length === 0) {
      finish(new Error('配对链接缺少中继地址'))
      return
    }
    open(urls[0], false)
  })
}

/**
 * 已配对会话的连接器：hello/challenge/proof → welcome → message 收发。
 * 与 app.js 的 RelayClient 同构，但收到的电脑端请求交给 `onCommand`
 * （App 里接 reverse-control 网关），回复用 `respond()`。
 */
export class PairedLink {
  constructor(pairing, deps, handlers = {}) {
    this.pairing = pairing
    this.deps = deps
    this.handlers = handlers
    this.urls = [pairing.relayUrl, pairing.fallbackUrl].filter(
      (url, index, list) => url && list.indexOf(url) === index,
    )
    this.urlIndex = 0
    this.currentUrl = ''
    this.pcToPhone = importKey(pairing.keys.pcToPhone)
    this.phoneToPc = importKey(pairing.keys.phoneToPc)
    this.outSeq = Number(pairing.outSeq) || 0
    this.inSeq = Number(pairing.inSeq) || 0
    this.socket = null
    this.wrapped = false
    this.relayReady = false
    this.connected = false
    this.stopped = false
    this.attempt = 0
    this.lastError = ''
    this.lastFrameAt = 0
    this.lastPingAt = 0
    this.pingFailures = 0
    this.welcomeTimer = null
    this.reconnectTimer = null
    this.pingTimer = null
    this.pending = new Map()
    this.requestSeq = 0
    this.state = 'idle'
  }

  setState(state, message = '') {
    this.state = state
    try {
      this.handlers.onState?.({ state, message })
    } catch {
      // ignore
    }
  }

  connect() {
    if (this.stopped) return
    this.closeSocket()
    this.connected = false
    this.lastError = ''
    this.setState(
      this.attempt > 0 ? 'reconnecting' : 'connecting',
      this.attempt > 0 ? '正在重新连接电脑…' : '正在连接电脑…',
    )
    const url = this.urls[this.urlIndex % Math.max(1, this.urls.length)] || this.pairing.relayUrl
    this.currentUrl = url
    this.wrapped = isWrappedUrl(url, this.pairing)
    this.relayReady = false
    let socket
    try {
      socket = this.deps.connectSocket(url)
    } catch (error) {
      this.lastError = error?.message || String(error)
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    this.welcomeTimer = setTimeout(() => {
      if (this.socket !== socket || this.connected) return
      this.lastError = '电脑没有响应'
      this.closeSocket()
      this.scheduleReconnect()
    }, 15_000)
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return
      this.lastFrameAt = Date.now()
      if (this.wrapped) {
        this.sendSocket({
          type: 'relay.hello',
          role: 'phone',
          room: this.pairing.room,
          key: this.pairing.roomKey,
          protocol: 1,
          ...(this.pairing.access ? { access: this.pairing.access } : {}),
        })
      } else {
        this.sendHello()
      }
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      this.lastFrameAt = Date.now()
      let frame
      try {
        frame = JSON.parse(String(event.data || ''))
      } catch {
        return
      }
      this.handleFrame(frame)
    }
    socket.onerror = () => {
      if (this.socket !== socket) return
      this.lastError = '连接电脑失败'
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.connected = false
      this.stopHeartbeat()
      this.rejectPending('连接已断开')
      if (this.stopped) return
      this.setState('disconnected', this.lastError || '连接已断开')
      this.scheduleReconnect()
    }
  }

  sendSocket(frame) {
    if (!this.socket || this.socket.readyState !== OPEN) return false
    try {
      this.socket.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  sendRaw(frame) {
    const payload = this.wrapped ? { type: 'relay.frame', data: frame } : frame
    return this.sendSocket(payload)
  }

  sendHello() {
    this.sendRaw({
      type: 'hello',
      role: 'phone',
      deviceId: this.pairing.deviceId,
      phoneId: this.pairing.phoneId,
      protocol: PROTOCOL_VERSION,
    })
  }

  send(value) {
    if (!this.connected) throw new Error('尚未连接电脑')
    const seq = this.outSeq + 1
    const envelope = encryptPayload(this.phoneToPc, value, seq, this.deps.randomBytes)
    if (!this.sendRaw({ type: 'message', payload: envelope })) {
      throw new Error('连接已断开')
    }
    this.outSeq = seq
    this.pairing.outSeq = seq
    this.handlers.onPersist?.(this.pairing)
  }

  request(method, params = {}, timeout = 20_000) {
    if (!this.connected) return Promise.reject(new Error('尚未连接电脑'))
    const id = `${++this.requestSeq}-${Date.now().toString(36)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('电脑没有响应，请稍后重试'))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ type: 'request', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** 回复电脑端下发的 rc.* 命令（onCommand 处理后调用）。 */
  respond(id, ok, data) {
    this.send({ type: 'response', id, ok, ...(ok ? { data } : { error: String(data).slice(0, 4000) }) })
  }

  rejectPending(message) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
      this.pending.delete(id)
    }
  }

  handleFrame(frame) {
    if (!frame || typeof frame.type !== 'string') return
    switch (frame.type) {
      case 'relay.ready': {
        if (!this.relayReady) {
          this.relayReady = true
          this.sendHello()
        }
        return
      }
      case 'relay.frame': {
        const inner = frame.data
        if (inner && typeof inner === 'object') this.handleFrame(inner)
        return
      }
      case 'hello.challenge': {
        try {
          const proof = tokenProof(this.pairing.token, String(frame.challenge || ''))
          this.sendRaw({
            type: 'hello.proof',
            deviceId: this.pairing.deviceId,
            phoneId: this.pairing.phoneId,
            proof,
          })
        } catch {
          this.lastError = '配对凭证不正确，请重新扫码'
          this.closeSocket()
          this.scheduleReconnect()
        }
        return
      }
      case 'hello.legacy': {
        this.sendRaw({
          type: 'hello',
          role: 'phone',
          deviceId: this.pairing.deviceId,
          phoneId: this.pairing.phoneId,
          token: this.pairing.token,
        })
        return
      }
      case 'relay.error': {
        this.lastError = String(frame.message || '云端连接器暂时不可用')
        this.closeSocket()
        this.scheduleReconnect()
        return
      }
      case 'welcome': {
        if (
          frame.deviceId !== this.pairing.deviceId ||
          frame.phoneId !== this.pairing.phoneId
        ) {
          this.lastError = '电脑返回的身份信息不一致'
          this.closeSocket()
          this.scheduleReconnect()
          return
        }
        clearTimeout(this.welcomeTimer)
        this.welcomeTimer = null
        this.connected = true
        this.attempt = 0
        this.lastError = ''
        if (this.currentUrl && this.currentUrl !== this.pairing.relayUrl) {
          this.pairing.fallbackUrl = this.pairing.relayUrl
          this.pairing.relayUrl = this.currentUrl
          this.urls = [this.pairing.relayUrl, this.pairing.fallbackUrl].filter(
            (url, index, list) => url && list.indexOf(url) === index,
          )
          this.urlIndex = 0
          this.handlers.onPersist?.(this.pairing)
        }
        this.startHeartbeat()
        this.setState('connected')
        try {
          this.handlers.onReady?.()
        } catch {
          // ignore
        }
        return
      }
      case 'message':
        this.handleEnvelope(frame.payload)
        return
      case 'error':
        this.handleError(frame)
        return
      case 'pair.revoked':
        this.fatal('revoked', String(frame.reason || '电脑已解除这台手机的配对'))
        return
      case 'pong':
        return
      default:
        return
    }
  }

  handleEnvelope(envelope) {
    let decoded
    try {
      decoded = decryptPayload(this.pcToPhone, envelope)
    } catch {
      return
    }
    if (decoded.seq <= this.inSeq) return
    this.inSeq = decoded.seq
    this.pairing.inSeq = decoded.seq
    this.handlers.onPersist?.(this.pairing)
    const value = decoded.value
    if (!value || typeof value !== 'object') return
    if (value.type === 'response') {
      const pending = this.pending.get(value.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(value.id)
      if (value.ok) pending.resolve(value.data)
      else pending.reject(new Error(value.error || '操作失败'))
      return
    }
    if (value.type === 'request') {
      // 电脑端下发的 rc.* 命令：交给网关，结果异步回传。
      const id = typeof value.id === 'string' ? value.id : ''
      const cmd = typeof value.method === 'string' ? value.method : ''
      if (!id || !cmd) return
      Promise.resolve()
        .then(() => this.handlers.onCommand?.({ id, cmd, args: value.params || {} }))
        .then((result) => {
          if (result && typeof result === 'object' && result.ok === false) {
            this.respond(id, false, result.error?.message || '执行失败')
          } else {
            this.respond(id, true, result)
          }
        })
        .catch((error) => {
          this.respond(id, false, error?.message || '执行失败')
        })
      return
    }
    if (value.type === 'event') {
      try {
        this.handlers.onEvent?.(value.data)
      } catch {
        // ignore
      }
      return
    }
    if (value.type === 'pong') {
      this.lastFrameAt = Date.now()
    }
  }

  handleError(frame) {
    const message = String(frame.message || '电脑返回错误').slice(0, 300)
    const code = frame.code
    this.lastError = message
    if (code === 'replaced') {
      this.fatal('replaced', '这个配对正在另一处使用')
    } else if (code === 'auth_failed') {
      this.fatal('auth', message)
    } else if (code === 'pair_expired') {
      this.fatal('expired', '配对已过期，请在电脑上重新生成二维码')
    } else if (code === 'auth_required') {
      this.lastError = '连接已失效，正在重新连接'
      this.rejectPending(this.lastError)
      this.closeSocket()
      this.scheduleReconnect()
    }
  }

  fatal(code, message) {
    this.stopped = true
    this.setState('error', message)
    this.closeSocket()
    try {
      this.handlers.onFatal?.({ code, message })
    } catch {
      // ignore
    }
  }

  closeSocket() {
    clearTimeout(this.welcomeTimer)
    this.welcomeTimer = null
    const socket = this.socket
    this.socket = null
    this.connected = false
    this.lastPingAt = 0
    this.stopHeartbeat()
    if (!socket) return
    try {
      socket.close()
    } catch {
      // ignore
    }
  }

  scheduleReconnect() {
    if (this.stopped) return
    clearTimeout(this.reconnectTimer)
    const attempt = Math.min(this.attempt, 8)
    const delay = Math.min(6_000, 600 * Math.pow(1.7, attempt))
    this.attempt += 1
    this.urlIndex += 1
    this.setState('reconnecting', this.lastError || '连接已断开，正在重连…')
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  reconnect() {
    this.stopped = false
    this.attempt = 0
    this.lastError = ''
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.connect()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.closeSocket()
    this.rejectPending('连接已关闭')
    this.setState('idle')
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.lastFrameAt = Date.now()
    this.lastPingAt = 0
    this.pingFailures = 0
    this.pingTimer = setInterval(() => {
      if (!this.connected) return
      const now = Date.now()
      if (now - this.lastFrameAt > 45_000) {
        this.lastError = '连接超时'
        this.closeSocket()
        this.scheduleReconnect()
        return
      }
      if (this.lastPingAt && this.lastFrameAt < this.lastPingAt) {
        this.pingFailures += 1
        if (this.pingFailures >= 2) {
          this.lastError = '连接无响应'
          this.closeSocket()
          this.scheduleReconnect()
          return
        }
      } else {
        this.pingFailures = 0
      }
      if (!this.sendRaw({ type: 'ping' })) {
        this.pingFailures += 1
        if (this.pingFailures >= 2) {
          this.lastError = '连接已断开'
          this.closeSocket()
          this.scheduleReconnect()
          return
        }
        return
      }
      this.lastPingAt = now
    }, 15_000)
  }

  stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }
}

/* ── 存取（storage 注入，与 app-state.js 同一风格） ───────────────────── */

export function loadPairing(storage) {
  let value = null
  try {
    value = storage.get(PAIRING_KEY)
  } catch {
    return null
  }
  if (!value || value.v !== 1 || typeof value.relayUrl !== 'string') return null
  if (!value.keys?.pcToPhone || !value.keys?.phoneToPc) return null
  if (typeof value.token !== 'string' || value.token.length < 20) return null
  return value
}

export function savePairing(storage, pairing) {
  storage.set(PAIRING_KEY, pairing)
}

export function clearPairing(storage) {
  storage.set(PAIRING_KEY, null)
}

export function ensurePhoneId(storage, randomBytes) {
  let value = ''
  try {
    value = storage.get(PHONE_ID_KEY) || ''
  } catch {
    value = ''
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(value)) {
    value = base64url(randomBytes(12))
    storage.set(PHONE_ID_KEY, value)
  }
  return value
}
