/**
 * 授权申请：普通权限走系统弹窗，特殊授权跳设置页，无障碍/通知监听/设备管理器
 * 这类「服务式」授权只能由用户在系统设置里打开，这里负责跳转与回读状态。
 *
 * 所有 plus.android 调用都做了环境判断：没有真机（H5 预览、单测）时返回
 * `available: false`，页面据此提示「需要 Android App 内使用」，不会崩。
 */

import { SPECIAL_PERMISSIONS, allRuntimePermissions, nextRuntimeBatch } from './capabilities.js'

const ACCESSIBILITY_SERVICE = 'cc.medpilot.pilotclient/.PilotAccessibilityService'
const NOTIFICATION_SERVICE = 'cc.medpilot.pilotclient/.PilotNotificationListener'

function android() {
  if (typeof plus === 'undefined' || !plus.android) return null
  return plus.android
}

export function isNative() {
  return android() !== null
}

/**
 * 申请一批普通权限（Android 单次建议 ≤ 16 项）。
 * @returns {Promise<{ok:boolean, granted:string[], denied:string[], deniedAlways:string[], reason?:string}>}
 */
export async function requestRuntime(permissions) {
  const list = (permissions || []).filter((name) => typeof name === 'string')
  if (list.length === 0) return { ok: true, granted: [], denied: [], deniedAlways: [] }
  const bridge = android()
  if (!bridge) return { ok: false, granted: [], denied: list, deniedAlways: [], reason: 'no_runtime' }
  return new Promise((resolve) => {
    bridge.requestPermissions(
      list,
      (result) => {
        resolve({
          ok: true,
          granted: result?.granted || [],
          denied: result?.deniedPresent || [],
          deniedAlways: result?.deniedAlways || []
        })
      },
      (error) => resolve({ ok: false, granted: [], denied: list, deniedAlways: [], reason: error?.message || 'request_failed' })
    )
  })
}

/** 按批次把「还没授权」的普通权限一批批申请完。 */
export async function requestAllRuntime(granted = {}, batchSize = 8) {
  const collected = { granted: [], denied: [], deniedAlways: [] }
  for (let i = 0; i < 12; i++) {
    const batch = nextRuntimeBatch(granted, batchSize)
    if (batch.length === 0) break
    const result = await requestRuntime(batch)
    collected.granted.push(...result.granted)
    collected.denied.push(...result.denied)
    collected.deniedAlways.push(...result.deniedAlways)
    if (!result.ok) break
    for (const name of result.granted) granted[name] = true
    for (const name of result.denied) granted[name] = false
    for (const name of result.deniedAlways) granted[name] = false
  }
  return collected
}

/**
 * 跳系统设置页开启 AppOp 型特殊授权。
 * @returns {{ok:boolean, reason?:string}}
 */
export function openSpecialSettings(id) {
  const special = SPECIAL_PERMISSIONS[id]
  const bridge = android()
  if (!special) return { ok: false, reason: 'unknown_special' }
  if (!bridge) return { ok: false, reason: 'no_runtime' }
  try {
    const main = bridge.runtimeMainActivity()
    const Intent = bridge.importClass('android.content.Intent')
    const Uri = bridge.importClass('android.net.Uri')
    const intent = new Intent(special.action)
    if (id === 'allFiles' || id === 'batteryUnrestricted' || id === 'exactAlarm' || id === 'installPackages') {
      intent.setData(Uri.parse(`package:${main.getPackageName()}`))
    }
    main.startActivity(intent)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error?.message || 'cannot_open_settings' }
  }
}

/** 无障碍服务是否已在系统里启用（按包名 + Service 类名匹配）。 */
export function accessibilityEnabled() {
  return secureSettingContains('enabled_accessibility_services', ACCESSIBILITY_SERVICE)
}

/** 通知监听是否已启用。 */
export function notificationListenerEnabled() {
  return secureSettingContains('enabled_notification_listeners', NOTIFICATION_SERVICE)
}

function secureSettingContains(setting, needle) {
  const bridge = android()
  if (!bridge) return false
  try {
    const main = bridge.runtimeMainActivity()
    const Settings = bridge.importClass('android.provider.Settings')
    const value = Settings.Secure.getString(main.getContentResolver(), setting)
    return typeof value === 'string' && value.includes(needle)
  } catch {
    return false
  }
}

/** 悬浮窗 / 修改系统设置 / 所有文件 / 电池白名单这类 AppOp 授权状态。 */
export function appOpGranted(id) {
  const bridge = android()
  if (!bridge) return false
  try {
    const main = bridge.runtimeMainActivity()
    if (id === 'overlay') {
      const Settings = bridge.importClass('android.provider.Settings')
      return Settings.canDrawOverlays(main) === true
    }
    if (id === 'writeSettings') {
      const Settings = bridge.importClass('android.provider.Settings')
      return Settings.System.canWrite(main) === true
    }
    if (id === 'allFiles') {
      const Environment = bridge.importClass('android.os.Environment')
      return Environment.isExternalStorageManager() === true
    }
    if (id === 'usageStats') {
      const AppOpsManager = bridge.importClass('android.app.AppOpsManager')
      const Process = bridge.importClass('android.os.Process')
      const Context = bridge.importClass('android.content.Context')
      const manager = main.getSystemService(Context.APP_OPS_SERVICE)
      const mode = manager.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), main.getPackageName())
      return mode === AppOpsManager.MODE_ALLOWED
    }
    if (id === 'batteryUnrestricted') {
      const PowerManager = bridge.importClass('android.os.PowerManager')
      const Context = bridge.importClass('android.content.Context')
      const manager = main.getSystemService(Context.POWER_SERVICE)
      return manager.isIgnoringBatteryOptimizations(main.getPackageName()) === true
    }
  } catch {
    return false
  }
  return false
}

/**
 * 读一次当前授权快照：普通权限用 checkSelfPermission，特殊授权按各自方式判断。
 * 页面回到前台时调用，用来刷新「授权中心」的勾选状态。
 */
export function readGrantedSnapshot() {
  const snapshot = {}
  const bridge = android()
  for (const permission of allRuntimePermissions()) snapshot[permission] = false
  if (!bridge) return snapshot
  try {
    const main = bridge.runtimeMainActivity()
    const PackageManager = bridge.importClass('android.content.pm.PackageManager')
    for (const permission of allRuntimePermissions()) {
      snapshot[permission] = main.checkSelfPermission(permission) === PackageManager.PERMISSION_GRANTED
    }
  } catch {
    // 读不到就保持 false，页面会提示「待授权」
  }
  snapshot.accessibility = accessibilityEnabled()
  snapshot.notificationListener = notificationListenerEnabled()
  for (const id of ['overlay', 'writeSettings', 'allFiles', 'usageStats', 'batteryUnrestricted']) {
    snapshot[id] = appOpGranted(id)
  }
  for (const id of ['mediaProjection', 'deviceAdmin', 'exactAlarm', 'installPackages']) {
    snapshot[id] = snapshot[id] === true
  }
  return snapshot
}
