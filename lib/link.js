/**
 * App 层的配对通道：把 uni-app 的 Socket / Storage / 系统信息接到 pairing.js 的
 * joinPairing 与 PairedLink 上，并把电脑端下发的 rc.* 命令交给命令网关。
 *
 * 这一层不 import vue、也不在模块顶层碰 uni：uni 只在 uniSocket/uniStorage 里按需探测，
 * 所以 node --test 能注入假 socket / 假随机源，把整条链路跑完。
 *
 * 状态机（写进 state.link.status，页面只认这几个值）：
 *   local      还没有配对
 *   pairing    正在配对（等电脑确认）
 *   connecting 已配对，正在建立/恢复连接
 *   online     已连接，命令收发中
 *   offline    连接断开（会自动重连）
 *   error      配对失效或连接失败
 */

import {
  PairedLink,
  clearPairing,
  ensurePhoneId,
  joinPairing,
  loadPairing,
  savePairing
} from './pairing.js'
import { sha256 } from './vendor/noble/hashes/sha2.js'

const OPEN = 1
const LOCAL_DETAIL = '还没有配对：在电脑端 Pilot 里生成配对码，扫码或粘贴到上面即可。'

/* ── 随机源（WebCrypto → 原生 UUID → 时间/Math.random 兜底） ───────────── */

function webCryptoBox() {
  try {
    const box = typeof globalThis !== 'undefined' ? globalThis.crypto : null
    return box && typeof box.getRandomValues === 'function' ? box : null
  } catch {
    return null
  }
}

function platformEntropy() {
  const parts = []
  try {
    if (typeof plus === 'undefined') return ''
    if (plus.android) {
      const UUID = plus.android.importClass('java.util.UUID')
      for (let index = 0; index < 4; index += 1) parts.push(String(UUID.randomUUID()))
    } else if (plus.ios) {
      const NSUUID = plus.ios.importClass('NSUUID')
      for (let index = 0; index < 4; index += 1) {
        const uuid = NSUUID.UUID()
        parts.push(String(uuid.UUIDString()))
        try {
          plus.ios.deleteObject(uuid)
        } catch {
          // ignore
        }
      }
    }
  } catch {
    return ''
  }
  return parts.join(':')
}

function fallbackEntropy() {
  let text = `${Date.now()}:`
  try {
    text += `${performance.now()}:`
  } catch {
    // ignore
  }
  for (let index = 0; index < 16; index += 1) {
    text += `${Math.random().toString(36).slice(2)}:`
  }
  return text
}

function concatBytes(...parts) {
  let length = 0
  for (const part of parts) length += part.length
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

let entropySeed = null
let entropyCounter = 0

function nextEntropyBlock() {
  const encoder = new TextEncoder()
  if (!entropySeed) entropySeed = sha256(encoder.encode(platformEntropy() || fallbackEntropy()))
  const block = sha256(concatBytes(entropySeed, encoder.encode(`:${entropyCounter}`)))
  entropyCounter += 1
  return block
}

/** 32 字节 IV / P-256 私钥都用它；没有 WebCrypto 时用原生 UUID 派生后 SHA-256 计数器展开。 */
export function randomBytes(length) {
  const size = Math.max(0, Math.floor(Number(length) || 0))
  const bytes = new Uint8Array(size)
  if (size === 0) return bytes
  const box = webCryptoBox()
  if (box) {
    box.getRandomValues(bytes)
    return bytes
  }
  let offset = 0
  while (offset < size) {
    const block = nextEntropyBlock()
    bytes.set(block.subarray(0, Math.min(block.length, size - offset)), offset)
    offset += block.length
  }
  return bytes
}

/* ── uni-app 适配 ─────────────────────────────────────────────────────── */

export function uniStorage() {
  const memory = new Map()
  return {
    get(key) {
      try {
        if (typeof uni !== 'undefined' && uni.getStorageSync) return uni.getStorageSync(key)
      } catch {
        // 落到内存实现
      }
      return memory.has(key) ? memory.get(key) : null
    },
    set(key, value) {
      try {
        if (typeof uni !== 'undefined' && uni.setStorageSync) {
          uni.setStorageSync(key, value)
          return
        }
      } catch {
        // 落到内存实现
      }
      memory.set(key, value)
    }
  }
}

/**
 * uni.connectSocket → pairing.js 期望的属性式 socket
 * （send/close/readyState + onopen/onmessage/onerror/onclose）。
 * SocketTask 是回调式的，这里做一次转接，并保证 onclose 只触发一次。
 */
export function uniSocket(url) {
  if (typeof uni === 'undefined' || typeof uni.connectSocket !== 'function') {
    throw new Error('当前环境不支持 WebSocket')
  }
  const task = uni.connectSocket({ url, complete: () => {} })
  if (!task) throw new Error('无法建立 WebSocket 连接')
  let closed = false
  const socket = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(text) {
      if (socket.readyState !== OPEN) throw new Error('连接尚未就绪')
      task.send({
        data: text,
        fail: () => socket.close()
      })
    },
    close() {
      try {
        task.close({ complete: () => {} })
      } catch {
        // ignore
      }
      finish()
    }
  }
  function finish() {
    socket.readyState = 3
    if (closed) return
    closed = true
    try {
      socket.onclose?.()
    } catch {
      // 上层回调异常不能回流到宿主
    }
  }
  try {
    task.onOpen(() => {
      if (closed) return
      socket.readyState = OPEN
      try {
        socket.onopen?.()
      } catch {
        // ignore
      }
    })
    task.onMessage((event) => {
      if (closed) return
      try {
        socket.onmessage?.({ data: event?.data })
      } catch {
        // ignore
      }
    })
    task.onError((error) => {
      try {
        socket.onerror?.(error)
      } catch {
        // ignore
      }
      finish()
    })
    task.onClose(finish)
  } catch {
    // 个别宿主缺回调注册接口，交给 pairing.js 的超时兜底
  }
  return socket
}

function systemInfoOf() {
  try {
    if (typeof uni !== 'undefined' && typeof uni.getSystemInfoSync === 'function') {
      return uni.getSystemInfoSync() || {}
    }
  } catch {
    // ignore
  }
  return {}
}

export function uniDeps() {
  return {
    storage: uniStorage(),
    randomBytes,
    connectSocket: uniSocket,
    systemInfo: systemInfoOf
  }
}

/* ── 连接管理器 ───────────────────────────────────────────────────────── */

function deviceLabel(info) {
  const brand = String(info?.deviceBrand || '').trim()
  const model = String(info?.deviceModel || '').trim()
  const label = `${brand} ${model}`.trim()
  return label || '我的手机'
}

function mapLinkState(state, message, paired) {
  switch (state) {
    case 'connected':
      return {
        status: 'online',
        detail: paired?.deviceName ? `已连接：${paired.deviceName}` : '已连接电脑'
      }
    case 'connecting':
      return { status: 'connecting', detail: '正在连接电脑…' }
    case 'reconnecting':
      return { status: 'connecting', detail: message || '连接已断开，正在重连…' }
    case 'disconnected':
      return { status: 'offline', detail: message || '和电脑的连接已断开' }
    case 'error':
      return { status: 'error', detail: message || '连接失败' }
    default:
      return { status: 'local', detail: LOCAL_DETAIL }
  }
}

/**
 * 建一个连接管理器。
 *
 * options：
 * - storage        { get(key), set(key, value) }
 * - randomBytes(n) → Uint8Array
 * - connectSocket(url) → 属性式 socket
 * - systemInfo()   → { platform, deviceBrand, deviceModel }
 * - gateway        { handle({ id, cmd, args }) }（app-state 的 createGateway）
 * - onState(next)  next = { status, detail, deviceName, pairedAt }
 */
export function createLinkManager(options = {}) {
  const storage = options.storage
  const makeRandom = typeof options.randomBytes === 'function' ? options.randomBytes : randomBytes
  const gateway = options.gateway || {
    handle: async () => ({ ok: false, error: { message: '命令网关未接上' } })
  }
  const systemInfo = () => {
    try {
      return options.systemInfo?.() || {}
    } catch {
      return {}
    }
  }

  const deps = {
    randomBytes: makeRandom,
    connectSocket: options.connectSocket,
    phoneId: () => ensurePhoneId(storage, makeRandom),
    phoneName: () => deviceLabel(systemInfo()),
    platform: () => String(systemInfo().platform || '').toLowerCase() || 'android'
  }

  let linked = null
  let paired = null
  let pairing = false

  function emit(next) {
    try {
      options.onState?.({
        ...next,
        deviceName: paired?.deviceName || '',
        pairedAt: paired?.pairedAt || ''
      })
    } catch {
      // 页面回调异常不能影响连接
    }
  }

  function start() {
    if (!paired) return null
    if (linked) {
      const previous = linked
      linked = null
      previous.stop()
    }
    const current = new PairedLink(paired, deps, {
      onState: ({ state, message }) => emit(mapLinkState(state, message, paired)),
      onPersist: (value) => {
        paired = value
        savePairing(storage, value)
      },
      onCommand: (envelope) => gateway.handle(envelope),
      onFatal: ({ code, message }) => {
        linked = null
        if (code === 'revoked' || code === 'expired' || code === 'auth') {
          paired = null
          clearPairing(storage)
          emit({ status: 'local', detail: `${message}。请重新配对。` })
          return
        }
        emit({ status: 'error', detail: message || '连接失败' })
      }
    })
    linked = current
    current.connect()
    return current
  }

  return {
    /** 启动时调用：有落盘配对就直接连，没有就停在未配对。 */
    restore() {
      const saved = loadPairing(storage)
      if (!saved) {
        emit({ status: 'local', detail: LOCAL_DETAIL })
        return null
      }
      paired = { ...saved, phoneId: saved.phoneId || deps.phoneId(), phoneName: deps.phoneName() }
      return start()
    },

    /** 用配对码配对；成功后立刻建立连接。 */
    async pair(code) {
      if (pairing) throw new Error('正在配对中，请稍候')
      const text = String(code || '').trim()
      if (!text) throw new Error('先粘贴电脑端的配对码')
      pairing = true
      if (linked) {
        const previous = linked
        linked = null
        previous.stop()
      }
      emit({ status: 'pairing', detail: '正在和电脑建立加密通道…' })
      try {
        const value = await joinPairing(text, deps, {
          onPending: () =>
            emit({ status: 'pairing', detail: '电脑端已收到请求，等它在屏幕上点「允许」…' })
        })
        paired = value
        savePairing(storage, value)
        emit({ status: 'connecting', detail: '配对完成，正在连接电脑…' })
        start()
        return value
      } catch (error) {
        emit({ status: 'error', detail: error?.message || '配对失败，请重试' })
        throw error
      } finally {
        pairing = false
      }
    },

    /** 重连（不重新配对）。 */
    retry() {
      if (!paired) return null
      const current = linked
      if (current) {
        current.reconnect()
        return current
      }
      return start()
    },

    /** 主动断开并忘掉配对（电脑端下次连接会被拒，需要重新扫码）。 */
    disconnect() {
      if (linked) {
        const previous = linked
        linked = null
        previous.stop()
      }
      paired = null
      clearPairing(storage)
      emit({ status: 'local', detail: LOCAL_DETAIL })
    },

    get paired() {
      return paired
    },

    get link() {
      return linked
    },

    submit(id, ok, data) {
      linked?.respond(id, ok, data)
    },

    request(method, params, timeout) {
      if (!linked) return Promise.reject(new Error('尚未连接电脑'))
      return linked.request(method, params, timeout)
    }
  }
}
