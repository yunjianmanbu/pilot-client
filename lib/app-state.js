/**
 * App 级共享状态：授权表、审计日志、反控网关。
 *
 * 页面只从这里拿网关和日志，不各自 new 一份，否则「授权中心」里刚打开的开关
 * 到了「反控台」不生效，两份审计也会互相覆盖。
 */
import { reactive } from 'vue'
import { createAuditLog } from './audit.js'
import { createGateway } from './reverse-control.js'
import { createHandlers } from './device-actions.js'
import { SPECIAL_PERMISSIONS, allRuntimePermissions } from './capabilities.js'
import { readGrantedSnapshot } from './permissions.js'
import { createLinkManager, uniDeps } from './link.js'

const memory = new Map()

const storage = {
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

export const state = reactive({
  granted: {},
  audit: [],
  lastResult: null,
  link: {
    status: 'local',
    code: '',
    detail: '还没有配对：在电脑端 Pilot 里生成配对码，扫码或粘贴到上面即可。',
    deviceName: '',
    pairedAt: ''
  },
  policy: { maxLevel: 3, deny: [] }
})

export const audit = createAuditLog({ storage })

const handlers = createHandlers({ granted: state.granted })
handlers['rc.link.report'] = (args) => ({ rtt: args.rtt, mode: state.link.status })

export const gateway = createGateway({
  handlers,
  audit,
  policy: state.policy
})

/**
 * 配对通道：页面只通过它配对/重连/断开，状态写回 state.link（响应式，页面直接读）。
 * uni 适配在 uniDeps() 里按需探测，所以这里在 node --test 里也能 import。
 */
export const linkManager = createLinkManager({
  ...uniDeps(),
  gateway,
  onState: (next) => {
    state.link = { ...next }
  }
})

export function refreshAudit() {
  state.audit = audit
    .list()
    .slice(-30)
    .reverse()
}

export function setGranted(key, on) {
  state.granted[key] = on === true
}

export function refreshGranted() {
  const snapshot = readGrantedSnapshot()
  for (const permission of allRuntimePermissions()) {
    if (typeof snapshot[permission] === 'boolean') state.granted[permission] = snapshot[permission]
  }
  for (const special of Object.keys(SPECIAL_PERMISSIONS)) {
    if (typeof snapshot[special] === 'boolean') state.granted[special] = snapshot[special]
  }
  return state.granted
}

let counter = 0

export async function runCommand(cmd, args) {
  const result = await gateway.handle({ id: `local-${++counter}`, cmd, args: args || {} })
  state.lastResult = result
  refreshAudit()
  return result
}

export function bootstrap() {
  refreshGranted()
  refreshAudit()
  // 有落盘配对就直接连电脑；没有就停在「未配对」。
  try {
    linkManager.restore()
  } catch {
    // 启动阶段连不上不该阻塞首屏，状态会由 PairedLink 的重连推上去
  }
}
