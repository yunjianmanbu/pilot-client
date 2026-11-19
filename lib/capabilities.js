/**
 * Pilot Client 的能力目录：每一项「反控能力」对应一组 Android 授权。
 *
 * 这个文件是手机端授权的唯一真源：
 * - `manifest.json` 里的 `<uses-permission>` 必须是 `allRuntimePermissions()` 的超集，
 *   由 `test/manifest.test.mjs` 守住，避免「页面写着能远程拍照、清单里却没有 CAMERA」；
 * - 反控命令与能力的归属由 `test/reverse-control.test.mjs` 校验，
 *   每个 `rc.*` 命令必须恰好属于一项能力，能力里列的命令必须真的存在。
 *
 * 授权分三类：
 * - `runtime`：`plus.android.requestPermissions()` 能弹系统授权框的普通/危险权限；
 * - `special`：需要用户去系统设置里单独打开的 AppOp，或需要无障碍 / 通知监听 / 设备管理员
 *   这类「服务式」授权（清单里只声明，真正生效要原生层注册 Service）；
 * - `advanced`：需要 adb / Shizuku / 系统签名才可能拿到，本 App 不申请，只在文档里列出，
 *   避免把「装个 App 就能远程改系统设置」写成假承诺。
 */

export const RISK_ORDER = ['low', 'medium', 'high', 'critical']

const RISK_LABEL = {
  low: '低',
  medium: '中',
  high: '高',
  critical: '极高'
}

/**
 * 需要跳系统设置或原生 Service 才能生效的授权。
 * `action` 是 Android 的 Settings intent action，`native` 为 true 表示还要在原生层
 * 注册 Service（见 native/README.md），仅靠 manifest 声明不生效。
 */
export const SPECIAL_PERMISSIONS = {
  accessibility: {
    id: 'accessibility',
    label: '无障碍服务',
    why: '电脑端在手机上点击、滑动、输入文字、按返回/主页/最近任务。没有它，任何「远程控制」都只能看不能动。',
    action: 'android.settings.ACCESSIBILITY_SETTINGS',
    permission: 'android.permission.BIND_ACCESSIBILITY_SERVICE',
    native: true
  },
  mediaProjection: {
    id: 'mediaProjection',
    label: '屏幕采集',
    why: '把手机屏幕实时投到电脑；每次连接都要用户点一次「开始录制」。',
    action: 'android.settings.action.MANAGE_OVERLAY_PERMISSION',
    permission: 'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
    native: true
  },
  notificationListener: {
    id: 'notificationListener',
    label: '通知使用权',
    why: '读取并撤销通知、按应用分组、把验证码短信之外的通知同步到电脑。',
    action: 'android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS',
    permission: 'android.permission.BIND_NOTIFICATION_LISTENER_SERVICE',
    native: true
  },
  usageStats: {
    id: 'usageStats',
    label: '使用情况访问',
    why: '判断当前前台是哪个应用，反控台才能显示「电脑正在操作什么」。',
    action: 'android.settings.USAGE_ACCESS_SETTINGS',
    permission: 'android.permission.PACKAGE_USAGE_STATS',
    native: false
  },
  overlay: {
    id: 'overlay',
    label: '悬浮窗',
    why: '远程协助时在屏幕上画出手指轨迹与「电脑正在操作」提示条，随时可以点停。',
    action: 'android.settings.action.MANAGE_OVERLAY_PERMISSION',
    permission: 'android.permission.SYSTEM_ALERT_WINDOW',
    native: false
  },
  writeSettings: {
    id: 'writeSettings',
    label: '修改系统设置',
    why: '远程调亮度、屏幕常亮、铃声与振动模式。',
    action: 'android.settings.action.MANAGE_WRITE_SETTINGS',
    permission: 'android.permission.WRITE_SETTINGS',
    native: false
  },
  deviceAdmin: {
    id: 'deviceAdmin',
    label: '设备管理器',
    why: '远程锁屏、设置解锁密码策略、丢机时清空数据。授权后可随时解除。',
    action: 'android.settings.DEVICE_ADMIN_SETTINGS',
    permission: 'android.permission.BIND_DEVICE_ADMIN',
    native: true
  },
  allFiles: {
    id: 'allFiles',
    label: '所有文件访问',
    why: '不限于相册与下载目录，电脑可以按路径读取整机文件，用于取日志、传文件。',
    action: 'android.settings.MANAGE_ALL_FILES_ACCESS_PERMISSION',
    permission: 'android.permission.MANAGE_EXTERNAL_STORAGE',
    native: false
  },
  installPackages: {
    id: 'installPackages',
    label: '安装未知应用',
    why: '电脑端把 APK 推到手机上直接安装（自动化测试、灰度包分发）。',
    action: 'android.settings.MANAGE_UNKNOWN_APP_SOURCES',
    permission: 'android.permission.REQUEST_INSTALL_PACKAGES',
    native: false
  },
  batteryUnrestricted: {
    id: 'batteryUnrestricted',
    label: '电池优化白名单',
    why: '不清后台、断连就少。授权后长连接才能稳定在线。',
    action: 'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
    permission: 'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
    native: false
  },
  exactAlarm: {
    id: 'exactAlarm',
    label: '精确闹钟',
    why: '定时任务（定点截图、定时上报位置）不被系统延迟。',
    action: 'android.settings.REQUEST_SCHEDULE_EXACT_ALARM',
    permission: 'android.permission.SCHEDULE_EXACT_ALARM',
    native: false
  }
}

/**
 * 能力目录。`commands` 里的名字必须在 reverse-control.js 的 COMMANDS 中存在。
 * 顺序即授权中心的展示顺序：先连接，再「能动手机」的重权限。
 */
export const CAPABILITIES = [
  {
    id: 'link',
    title: '连接与保活',
    summary: '与电脑端配对、断线重连、后台常驻。这是所有反控的前提。',
    risk: 'low',
    runtime: [
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.ACCESS_WIFI_STATE',
      'android.permission.CHANGE_WIFI_STATE',
      'android.permission.NEARBY_WIFI_DEVICES',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
      'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
      'android.permission.WAKE_LOCK',
      'android.permission.RECEIVE_BOOT_COMPLETED'
    ],
    special: ['batteryUnrestricted'],
    commands: ['rc.ping', 'rc.status', 'rc.link.report']
  },
  {
    id: 'input',
    title: '屏幕镜像与输入注入',
    summary: '电脑端看到手机实时画面，并在画面上点击、滑动、输入、按导航键。',
    risk: 'critical',
    runtime: [
      'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
      'android.permission.DISABLE_KEYGUARD',
      'android.permission.EXPAND_STATUS_BAR'
    ],
    special: ['accessibility', 'mediaProjection', 'overlay'],
    commands: [
      'rc.screen.capture',
      'rc.input.tap',
      'rc.input.swipe',
      'rc.input.text',
      'rc.input.key',
      'rc.input.paste',
      'rc.clipboard.get',
      'rc.clipboard.set'
    ]
  },
  {
    id: 'notify',
    title: '通知与状态栏',
    summary: '把手机通知同步到电脑、远程划掉通知、读当前状态栏内容。',
    risk: 'medium',
    runtime: [
      'android.permission.ACCESS_NOTIFICATION_POLICY',
      'android.permission.USE_FULL_SCREEN_INTENT'
    ],
    special: ['notificationListener'],
    commands: ['rc.notify.list', 'rc.notify.dismiss', 'rc.statusbar.expand']
  },
  {
    id: 'apps',
    title: '应用管理',
    summary: '列出全部已安装应用、远程打开/结束应用、推送安装包。',
    risk: 'high',
    runtime: [
      'android.permission.QUERY_ALL_PACKAGES',
      'android.permission.REQUEST_INSTALL_PACKAGES',
      'android.permission.REQUEST_DELETE_PACKAGES',
      'android.permission.KILL_BACKGROUND_PROCESSES',
      'android.permission.REORDER_TASKS',
      'android.permission.GET_TASKS'
    ],
    special: ['usageStats', 'installPackages'],
    commands: [
      'rc.apps.list',
      'rc.apps.foreground',
      'rc.app.open',
      'rc.app.kill',
      'rc.app.uninstall'
    ]
  },
  {
    id: 'files',
    title: '文件与媒体',
    summary: '按路径浏览、取走日志与照片、把文件推到手机。',
    risk: 'high',
    runtime: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.MANAGE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_AUDIO',
      'android.permission.READ_MEDIA_VISUAL_USER_SELECTED'
    ],
    special: ['allFiles'],
    commands: [
      'rc.files.list',
      'rc.files.pull',
      'rc.files.push',
      'rc.files.delete',
      'rc.media.thumbnail'
    ]
  },
  {
    id: 'comm',
    title: '通讯录与通话',
    summary: '搜索通讯录、远程拨号、查看通话记录与未接来电。',
    risk: 'critical',
    runtime: [
      'android.permission.READ_CONTACTS',
      'android.permission.WRITE_CONTACTS',
      'android.permission.READ_PHONE_STATE',
      'android.permission.READ_PHONE_NUMBERS',
      'android.permission.CALL_PHONE',
      'android.permission.ANSWER_PHONE_CALLS',
      'android.permission.READ_CALL_LOG',
      'android.permission.WRITE_CALL_LOG'
    ],
    special: [],
    commands: [
      'rc.contacts.list',
      'rc.contacts.search',
      'rc.call.dial',
      'rc.call.answer',
      'rc.call.log'
    ]
  },
  {
    id: 'sms',
    title: '短信',
    summary: '读取最近短信、远程发送短信。Android 与 Google Play 对这类权限有额外审核。',
    risk: 'critical',
    runtime: [
      'android.permission.READ_SMS',
      'android.permission.SEND_SMS',
      'android.permission.RECEIVE_SMS',
      'android.permission.RECEIVE_MMS'
    ],
    special: [],
    commands: ['rc.sms.list', 'rc.sms.send']
  },
  {
    id: 'location',
    title: '定位',
    summary: '取当前位置，或按时间窗拉起持续定位（后台定位需单独授权）。',
    risk: 'high',
    runtime: [
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_BACKGROUND_LOCATION',
      'android.permission.FOREGROUND_SERVICE_LOCATION'
    ],
    special: [],
    commands: ['rc.location.get', 'rc.location.track']
  },
  {
    id: 'camera',
    title: '相机与麦克风',
    summary: '远程拍照/录像、录音、开关手电筒。',
    risk: 'critical',
    runtime: [
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.FLASHLIGHT',
      'android.permission.FOREGROUND_SERVICE_CAMERA',
      'android.permission.FOREGROUND_SERVICE_MICROPHONE',
      'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE'
    ],
    special: [],
    commands: ['rc.camera.photo', 'rc.audio.record', 'rc.torch.set']
  },
  {
    id: 'sensor',
    title: '传感器与活动识别',
    summary: '读取心率等身体传感器、判断走路/开车，用于远程健康与场景判断。',
    risk: 'medium',
    runtime: [
      'android.permission.BODY_SENSORS',
      'android.permission.BODY_SENSORS_BACKGROUND',
      'android.permission.ACTIVITY_RECOGNITION',
      'android.permission.HIGH_SAMPLING_RATE_SENSORS'
    ],
    special: [],
    commands: ['rc.sensor.read']
  },
  {
    id: 'device',
    title: '设备控制',
    summary: '震动、锁屏、调音量/亮度、常亮、蓝牙/NFC、切铃声模式。',
    risk: 'high',
    runtime: [
      'android.permission.VIBRATE',
      'android.permission.SET_WALLPAPER',
      'android.permission.CHANGE_NETWORK_STATE',
      'android.permission.BLUETOOTH',
      'android.permission.BLUETOOTH_ADMIN',
      'android.permission.BLUETOOTH_SCAN',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.BLUETOOTH_ADVERTISE',
      'android.permission.NFC',
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_EXACT_ALARM'
    ],
    special: ['deviceAdmin', 'writeSettings', 'exactAlarm'],
    commands: [
      'rc.device.vibrate',
      'rc.device.lock',
      'rc.device.wake',
      'rc.device.volume',
      'rc.device.brightness',
      'rc.device.toast',
      'rc.device.wallpaper',
      'rc.device.wipe',
      'rc.device.reboot'
    ]
  },
  {
    id: 'calendar',
    title: '日历与日程',
    summary: '查看与新建日程，让电脑端按日程安排提醒或静默期。',
    risk: 'medium',
    runtime: [
      'android.permission.READ_CALENDAR',
      'android.permission.WRITE_CALENDAR',
      'android.permission.READ_SYNC_SETTINGS',
      'android.permission.WRITE_SYNC_SETTINGS'
    ],
    special: [],
    commands: ['rc.calendar.list', 'rc.calendar.create']
  }
]

/** 需要 adb / Shizuku / 系统签名才可能实现的能力，本 App 不申请，仅作为方案记录。 */
export const ADVANCED_PERMISSIONS = [
  {
    id: 'writeSecureSettings',
    label: 'WRITE_SECURE_SETTINGS',
    why: '直接改系统级开关（飞行模式、开发者选项、无障碍开关本身）。',
    how: 'adb shell pm grant cc.medpilot.pilotclient android.permission.WRITE_SECURE_SETTINGS'
  },
  {
    id: 'readLogs',
    label: 'READ_LOGS',
    why: '远程抓取整机 logcat，排查其它应用的崩溃。',
    how: 'adb shell pm grant cc.medpilot.pilotclient android.permission.READ_LOGS'
  },
  {
    id: 'captureAudioOutput',
    label: 'CAPTURE_AUDIO_OUTPUT',
    why: '录制系统内录（游戏、通话对面的声音）。',
    how: '系统签名或 root；普通应用即使用 adb 授予也不会生效。'
  },
  {
    id: 'packageUsage',
    label: 'PACKAGE_USAGE_STATS（Shizuku 授权）',
    why: '免去手动进设置页开「使用情况访问」。',
    how: 'Shizuku / adb appops set cc.medpilot.pilotclient GET_USAGE_STATS allow'
  },
  {
    id: 'reboot',
    label: 'REBOOT',
    why: '远程重启手机。',
    how: '系统签名，或 root 后 su -c reboot。'
  }
]

export function capabilityById(id) {
  return CAPABILITIES.find((capability) => capability.id === id) || null
}

export function specialById(id) {
  return SPECIAL_PERMISSIONS[id] || null
}

/** 声明在 AndroidManifest 里的权限（去重、排序，便于和清单逐条比对）。 */
export function allRuntimePermissions(capabilities = CAPABILITIES) {
  const names = new Set()
  for (const capability of capabilities) {
    for (const permission of capability.runtime || []) names.add(permission)
  }
  return [...names].sort()
}

/** 从 manifest.json 的 `<uses-permission .../>` 字符串里取出权限名。 */
export function manifestPermissionNames(manifest) {
  const list = manifest?.['app-plus']?.distribute?.android?.permissions
  if (!Array.isArray(list)) return []
  const names = []
  for (const line of list) {
    const match = /<uses-permission[^>]*android:name="([^"]+)"/.exec(String(line))
    if (match) names.push(match[1])
  }
  return names
}

/** 每一项能力需要的特殊授权详情，按目录顺序展开，去重。 */
export function allSpecialPermissions(capabilities = CAPABILITIES) {
  const seen = new Set()
  const result = []
  for (const capability of capabilities) {
    for (const id of capability.special || []) {
      if (seen.has(id)) continue
      const special = SPECIAL_PERMISSIONS[id]
      if (special) {
        seen.add(id)
        result.push(special)
      }
    }
  }
  return result
}

/**
 * 统计授权进度。
 * @param {Record<string, boolean>} granted 权限名或特殊授权 id → 是否已授权
 * @returns {{ total:number, granted:number, ratio:number, pending:string[], byRisk:Record<string,{total:number,granted:number}> }}
 */
export function summarize(granted = {}) {
  const total = CAPABILITIES.length
  const byRisk = {}
  let grantedCount = 0
  const pending = []
  for (const capability of CAPABILITIES) {
    const keys = [...(capability.runtime || []), ...(capability.special || [])]
    const ok = keys.length > 0 && keys.every((key) => granted[key] === true)
    if (ok) grantedCount += 1
    else pending.push(capability.id)
    const bucket = byRisk[capability.risk] || (byRisk[capability.risk] = { total: 0, granted: 0 })
    bucket.total += 1
    if (ok) bucket.granted += 1
  }
  return {
    total,
    granted: grantedCount,
    ratio: total === 0 ? 0 : grantedCount / total,
    pending,
    byRisk
  }
}

/**
 * 下一次要弹窗申请的普通权限批次。
 * Android 单次 requestPermissions 建议不超过 16 项，超过会直接失败，所以分批。
 */
export function nextRuntimeBatch(granted = {}, size = 8, capabilities = CAPABILITIES) {
  const batch = []
  for (const permission of allRuntimePermissions(capabilities)) {
    if (granted[permission] === true) continue
    batch.push(permission)
    if (batch.length >= size) break
  }
  return batch
}

export function riskLabel(risk) {
  return RISK_LABEL[risk] || risk
}

/** 高风险能力必须二次确认：这些能力一旦被电脑端控制，等同于把手机交出去。 */
export function requiresConfirm(capability) {
  return capability.risk === 'high' || capability.risk === 'critical'
}
