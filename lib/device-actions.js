/**
 * 反控命令的真正实现（uni-app + plus）。
 *
 * 能只靠 uni/plus 做到的（状态、剪贴板、音量、亮度、常亮、震动、提示、应用列表、
 * 目录浏览）在这里直接实现；需要无障碍 / MediaProjection / 通知监听 / 设备管理器的
 * 命令统一返回 `not_granted` + `hint`，提示用户去授权中心打开对应开关，
 * 不假装成功。原生层补齐后，只要在这里替换同名实现即可，网关不用改。
 *
 * 传给 `createHandlers({ plus, uni, granted, confirm })` 的两个全局对象都可注入，
 * 没有真机时可以用假对象跑通代码路径（见 test/reverse-control.test.mjs）。
 */

const err = (code, message, hint) => Object.assign(new Error(message), { code, hint })

export const NATIVE_HINTS = {
  input: '去「授权中心 → 无障碍服务」打开 Pilot Client，再用电脑端点屏幕。',
  screen: '去「授权中心 → 屏幕采集」开始一次屏幕共享，电脑端才能看到画面。',
  notify: '去「授权中心 → 通知使用权」打开 Pilot Client。',
  apps: '去「授权中心 → 使用情况访问」打开，才能读到前台应用。',
  files: '去「授权中心 → 所有文件访问」打开，才能按路径读整机文件。',
  deviceAdmin: '去「授权中心 → 设备管理器」启用，才能远程锁屏或清空数据。',
  camera: '去「授权中心 → 相机与麦克风」允许后重试。',
  sms: '短信权限需要单独允许；Android 与 Google Play 对短信权限有额外限制。',
  contacts: '通讯录权限需要单独允许。',
  phone: '通话权限需要单独允许。',
  location: '定位权限（含「始终允许」）需要单独允许。',
  calendar: '日历权限需要单独允许。'
}

function androidClasses(plus) {
  const { android } = plus || {}
  if (!android || typeof android.importClass !== 'function') return null
  return android
}

/** 需要无障碍注入的命令统一走这里。 */
function nativeOnly(hintKey, granted = {}) {
  return () => {
    const opened = granted[hintKey] === true
    throw err(
      'not_granted',
      opened ? '授权已打开，但这一版还没接上原生服务' : '这一项能力还没接上原生服务',
      NATIVE_HINTS[hintKey]
    )
  }
}

export function createHandlers(deps = {}) {
  // 注意：不能用 `const uni = ... : uni : null`，同名的 const 会遮蔽全局变量并在 TDZ 里引用自己。
  const uniApi = deps.uni || globalThis.uni || null
  const plusApi = deps.plus || globalThis.plus || null
  const granted = deps.granted || {}
  const native = (key) => nativeOnly(key, granted)

  const withUni = (fn) => {
    if (!uniApi) throw err('not_granted', '当前环境没有 uni 运行时', '请在 App 内使用')
    return fn(uniApi)
  }

  return {
    // ---------- L0 ----------
    'rc.ping': () => ({ pong: Date.now() }),

    'rc.status': async () => {
      const base = {
        platform: plusApi ? plusApi.os.name : 'unknown',
        version: plusApi ? plusApi.runtime.version : null,
        model: null,
        battery: null,
        charging: null,
        screen: null,
        network: null
      }
      if (plusApi && typeof plusApi.device.getInfo === 'function') {
        await new Promise((resolve) => {
          plusApi.device.getInfo({
            success: (info) => {
              base.model = info?.model || null
              base.vendor = info?.vendor || null
              resolve()
            },
            fail: () => resolve()
          })
        })
      }
      if (uniApi && typeof uniApi.getBatteryInfo === 'function') {
        await new Promise((resolve) => {
          uniApi.getBatteryInfo({
            success: (info) => {
              base.battery = info?.level ?? null
              base.charging = info?.isCharging ?? null
              resolve()
            },
            fail: () => resolve()
          })
        })
      }
      if (uniApi && typeof uniApi.getNetworkType === 'function') {
        await new Promise((resolve) => {
          uniApi.getNetworkType({
            success: (res) => {
              base.network = res?.networkType || null
              resolve()
            },
            fail: () => resolve()
          })
        })
      }
      return base
    },

    'rc.link.report': (args) => ({ rtt: args.rtt }),

    // ---------- L1 只读 ----------
    'rc.clipboard.get': () =>
      new Promise((resolve, reject) => {
        withUni((u) =>
          u.getClipboardData({
            success: (res) => resolve({ text: res?.data ?? '' }),
            fail: () => reject(err('handler_failed', '读剪贴板失败', 'Android 只在 App 前台允许读取剪贴板'))
          })
        )
      }),

    'rc.notify.list': native('notify'),
    'rc.apps.foreground': native('apps'),
    'rc.media.thumbnail': native('files'),
    'rc.files.list': (args) =>
      new Promise((resolve, reject) => {
        if (!plusApi || !plusApi.io) return reject(err('not_granted', '文件系统不可用', NATIVE_HINTS.files))
        const path = args.path || '_doc'
        plusApi.io.resolveLocalFileSystemURL(
          path,
          (entry) => {
            entry.createReader().readEntries(
              (entries) =>
                resolve({
                  path,
                  items: entries.slice(0, 500).map((item) => ({
                    name: item.name,
                    dir: item.isDirectory === true,
                    size: item.fileSize ?? null,
                    modified: item.lastModifiedDate ? item.lastModifiedDate.getTime() : null
                  }))
                }),
              () => reject(err('handler_failed', '目录读取失败', NATIVE_HINTS.files))
            )
          },
          () => reject(err('handler_failed', '路径不存在或没有权限', NATIVE_HINTS.files))
        )
      }),

    'rc.sensor.read': native('sensor'),

    'rc.apps.list': (args) =>
      new Promise((resolve, reject) => {
        const android = androidClasses(plusApi)
        if (!android) return reject(err('not_granted', '需要真机环境', NATIVE_HINTS.apps))
        const main = android.runtimeMainActivity()
        const pm = main.getPackageManager()
        const packages = pm.getInstalledPackages(0)
        const limit = args?.limit || 200
        const items = []
        for (let i = 0; i < packages.size() && items.length < limit; i++) {
          const info = packages.get(i)
          const isSystem = (info.applicationInfo.flags & 1) !== 0
          items.push({
            pkg: String(info.packageName),
            label: String(pm.getApplicationLabel(info.applicationInfo)),
            version: String(info.versionName || ''),
            system: isSystem
          })
        }
        resolve({ items })
      }),

    // ---------- L2 ----------
    'rc.clipboard.set': (args) =>
      new Promise((resolve, reject) => {
        withUni((u) =>
          u.setClipboardData({
            data: args.text,
            success: () => resolve({ ok: true, chars: args.text.length }),
            fail: () => reject(err('handler_failed', '写剪贴板失败'))
          })
        )
      }),

    'rc.device.vibrate': (args) =>
      new Promise((resolve, reject) => {
        withUni((u) =>
          u.vibrateLong({
            success: () => resolve({ ms: args.ms }),
            fail: () => reject(err('handler_failed', '震动失败'))
          })
        )
      }),

    'rc.device.toast': (args) => {
      withUni((u) => u.showToast({ title: args.text, icon: 'none' }))
      return { shown: true }
    },

    'rc.device.volume': (args) => {
      if (!plusApi || !plusApi.device || typeof plusApi.device.setVolume !== 'function') {
        throw err('not_granted', '系统音量接口不可用')
      }
      plusApi.device.setVolume(args.level)
      return { level: args.level }
    },

    'rc.device.brightness': (args) => {
      if (!plusApi || !plusApi.screen || typeof plusApi.screen.setBrightness !== 'function') {
        throw err('not_granted', '屏幕亮度接口不可用')
      }
      plusApi.screen.setBrightness(args.level)
      return { level: args.level }
    },

    'rc.device.wake': (args) => {
      if (!plusApi || !plusApi.device || typeof plusApi.device.setWakelock !== 'function') {
        throw err('not_granted', '常亮接口不可用')
      }
      plusApi.device.setWakelock(args.on === true)
      return { on: args.on === true }
    },

    'rc.app.open': (args) => {
      const android = androidClasses(plusApi)
      if (!android) throw err('not_granted', '需要真机环境', NATIVE_HINTS.apps)
      const main = android.runtimeMainActivity()
      const intent = main.getPackageManager().getLaunchIntentForPackage(args.pkg)
      if (!intent) throw err('handler_failed', `没装这个应用：${args.pkg}`)
      main.startActivity(intent)
      return { pkg: args.pkg }
    },

    'rc.torch.set': native('camera'),
    'rc.screen.capture': native('screen'),
    'rc.input.tap': native('input'),
    'rc.input.swipe': native('input'),
    'rc.input.text': native('input'),
    'rc.input.key': native('input'),
    'rc.input.paste': native('input'),
    'rc.notify.dismiss': native('notify'),

    'rc.statusbar.expand': native('input'),

    // ---------- L3 / L4（等原生层） ----------
    'rc.app.kill': native('apps'),
    'rc.app.uninstall': native('apps'),
    'rc.device.wallpaper': native('deviceAdmin'),
    'rc.device.lock': native('deviceAdmin'),
    'rc.device.wipe': native('deviceAdmin'),
    'rc.device.reboot': native('deviceAdmin'),
    'rc.sms.list': native('sms'),
    'rc.sms.send': native('sms'),
    'rc.contacts.list': native('contacts'),
    'rc.contacts.search': native('contacts'),
    'rc.call.dial': native('phone'),
    'rc.call.answer': native('phone'),
    'rc.call.log': native('phone'),
    'rc.location.get': native('location'),
    'rc.location.track': native('location'),
    'rc.files.pull': native('files'),
    'rc.files.push': native('files'),
    'rc.files.delete': native('files'),
    'rc.camera.photo': native('camera'),
    'rc.audio.record': native('camera'),
    'rc.calendar.list': native('calendar'),
    'rc.calendar.create': native('calendar')
  }
}
