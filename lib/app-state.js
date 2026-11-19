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
  link: { status: 'local', code: '', detail: '本机自测模式：还没有和电脑端建立加密通道' },
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
}
