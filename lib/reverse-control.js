/**
 * 反控命令引擎（纯逻辑，不碰任何设备 API）。
 *
 * 电脑端发来的是 `rc.*` 命令帧，这一层负责：
 * 1. 认出命令、校验参数（未知命令与畸形参数一律拒绝，不做「尽力而为」）；
 * 2. 按危险等级执行策略：默认最高只放行 L3，L4（擦除、卸载、恢复出厂）必须显式开启；
 * 3. 限流与超时，防止电脑端一个死循环把手机点死；
 * 4. 每一步都写审计（脱敏）。
 *
 * 真正干活的 `handlers` 由调用方注入（App 里是 device-actions.js 的 plus/uni 实现，
 * 测试里是假函数），所以这里能完整单测。
 *
 * 危险等级：
 *   L0 只读且无隐私（心跳、电量、版本）
 *   L1 只读但含隐私（剪贴板、通知列表、应用列表、文件目录）
 *   L2 可逆操作（点击、输入、音量、亮度、截屏、打开应用）
 *   L3 写入/外泄（读短信、拨号、取定位、拉文件、拍照录音）
 *   L4 破坏性（卸载应用、清数据、锁死设备、恢复出厂）
 */

import { CAPABILITIES } from './capabilities.js'

/** 参数字典：type ∈ int/number/string/bool/enum，支持 min/max/maxLength/values。 */
export const COMMANDS = {
  // ---- L0 连接与状态 ----
  'rc.ping': { level: 0, title: '心跳', args: {} },
  'rc.status': { level: 0, title: '读设备状态', args: {} },
  'rc.link.report': { level: 0, title: '上报连接质量', args: { rtt: { type: 'int', min: 0, max: 600000 } } },

  // ---- L1 只读隐私 ----
  'rc.clipboard.get': { level: 1, title: '读剪贴板', args: {} },
  'rc.clipboard.set': { level: 2, title: '写剪贴板', args: { text: { type: 'string', maxLength: 20000 } } },
  'rc.notify.list': { level: 1, title: '读通知列表', args: { limit: { type: 'int', min: 1, max: 50 } } },
  'rc.notify.dismiss': { level: 2, title: '划掉通知', args: { key: { type: 'string', maxLength: 200 } } },
  'rc.statusbar.expand': { level: 2, title: '展开状态栏', args: {} },
  'rc.apps.list': { level: 1, title: '列出应用', args: { limit: { type: 'int', min: 1, max: 500 } } },
  'rc.apps.foreground': { level: 1, title: '当前前台应用', args: {} },
  'rc.files.list': { level: 1, title: '列目录', args: { path: { type: 'string', maxLength: 512 } } },
  'rc.media.thumbnail': { level: 1, title: '取缩略图', args: { path: { type: 'string', maxLength: 512 } } },
  'rc.sensor.read': { level: 1, title: '读传感器', args: { sensor: { type: 'enum', values: ['accelerometer', 'gyroscope', 'light', 'step', 'heart'] } } },

  // ---- L2 可逆操作 ----
  'rc.screen.capture': { level: 2, title: '抓取屏幕', args: {} },
  'rc.input.tap': { level: 2, title: '远程点击', args: { x: { type: 'int', min: 0, max: 20000 }, y: { type: 'int', min: 0, max: 20000 } } },
  'rc.input.swipe': {
    level: 2,
    title: '远程滑动',
    args: {
      x1: { type: 'int', min: 0, max: 20000 },
      y1: { type: 'int', min: 0, max: 20000 },
      x2: { type: 'int', min: 0, max: 20000 },
      y2: { type: 'int', min: 0, max: 20000 },
      duration: { type: 'int', min: 50, max: 5000 }
    }
  },
  'rc.input.text': { level: 2, title: '远程输入文字', args: { text: { type: 'string', maxLength: 4000 } } },
  'rc.input.key': {
    level: 2,
    title: '远程按键',
    args: { key: { type: 'enum', values: ['back', 'home', 'recents', 'enter', 'volumeUp', 'volumeDown', 'power'] } }
  },
  'rc.input.paste': { level: 2, title: '粘贴', args: {} },
  'rc.app.open': { level: 2, title: '打开应用', args: { pkg: { type: 'string', maxLength: 200 } } },
  'rc.app.kill': { level: 3, title: '结束应用', args: { pkg: { type: 'string', maxLength: 200 } } },
  'rc.app.uninstall': { level: 4, title: '卸载应用', args: { pkg: { type: 'string', maxLength: 200 } } },
  'rc.device.vibrate': { level: 2, title: '震动', args: { ms: { type: 'int', min: 10, max: 3000 } } },
  'rc.device.toast': { level: 2, title: '弹提示', args: { text: { type: 'string', maxLength: 200 } } },
  'rc.device.volume': { level: 2, title: '调音量', args: { level: { type: 'number', min: 0, max: 1 } } },
  'rc.device.brightness': { level: 2, title: '调亮度', args: { level: { type: 'number', min: 0, max: 1 } } },
  'rc.device.wake': { level: 2, title: '屏幕常亮', args: { on: { type: 'bool' } } },
  'rc.device.wallpaper': { level: 3, title: '换壁纸', args: { path: { type: 'string', maxLength: 512 } } },
  'rc.device.lock': { level: 3, title: '锁屏', args: {} },
  'rc.torch.set': { level: 2, title: '手电筒', args: { on: { type: 'bool' } } },

  // ---- L3 写入/外泄 ----
  'rc.sms.list': { level: 3, title: '读短信', args: { limit: { type: 'int', min: 1, max: 100 } } },
  'rc.sms.send': { level: 3, title: '发短信', args: { to: { type: 'string', maxLength: 32 }, text: { type: 'string', maxLength: 1000 } } },
  'rc.contacts.list': { level: 3, title: '读通讯录', args: { limit: { type: 'int', min: 1, max: 500 } } },
  'rc.contacts.search': { level: 3, title: '搜通讯录', args: { query: { type: 'string', maxLength: 64 } } },
  'rc.call.dial': { level: 3, title: '拨号', args: { to: { type: 'string', maxLength: 32 } } },
  'rc.call.answer': { level: 3, title: '接听来电', args: {} },
  'rc.call.log': { level: 3, title: '读通话记录', args: { limit: { type: 'int', min: 1, max: 200 } } },
  'rc.location.get': { level: 3, title: '取定位', args: { accuracy: { type: 'enum', values: ['coarse', 'fine'] } } },
  'rc.location.track': { level: 3, title: '持续定位', args: { seconds: { type: 'int', min: 10, max: 3600 } } },
  'rc.files.pull': { level: 3, title: '取走文件', args: { path: { type: 'string', maxLength: 512 } } },
  'rc.files.push': { level: 3, title: '推送文件', args: { path: { type: 'string', maxLength: 512 }, size: { type: 'int', min: 0, max: 268435456 } } },
  'rc.files.delete': { level: 4, title: '删除文件', args: { path: { type: 'string', maxLength: 512 } } },
  'rc.camera.photo': { level: 3, title: '远程拍照', args: { facing: { type: 'enum', values: ['back', 'front'] } } },
  'rc.audio.record': { level: 3, title: '录音', args: { seconds: { type: 'int', min: 1, max: 600 } } },
  'rc.calendar.list': { level: 1, title: '读日程', args: { days: { type: 'int', min: 1, max: 365 } } },
  'rc.calendar.create': { level: 3, title: '建日程', args: { title: { type: 'string', maxLength: 200 }, at: { type: 'int', min: 0, max: 4102444800000 } } },

  // ---- L4 破坏性 ----
  'rc.device.wipe': { level: 4, title: '清空手机', args: {} },
  'rc.device.reboot': { level: 4, title: '重启手机', args: {} }
}

export const ERROR_CODES = {
  BAD_ENVELOPE: 'bad_envelope',
  UNKNOWN_COMMAND: 'unknown_command',
  DENIED_BY_POLICY: 'denied_by_policy',
  DENIED_BY_USER: 'denied_by_user',
  INVALID_ARGS: 'invalid_args',
  NOT_GRANTED: 'not_granted',
  RATE_LIMITED: 'rate_limited',
  TIMEOUT: 'timeout',
  HANDLER_FAILED: 'handler_failed'
}

export const DEFAULT_POLICY = {
  /** 默认最高放行 L3；L4 需要在设置里显式打开且逐次确认。 */
  maxLevel: 3,
  /** 命中这些命令直接拒绝，优先级高于 maxLevel。 */
  deny: [],
  /** 每分钟每条命令的调用上限。 */
  perMinute: 60
}

const DEFAULT_TIMEOUT_MS = 15000

/** 命令 → 能力 id，用于在结果里回带「缺哪个授权」。 */
export function commandCapability(cmd, capabilities = CAPABILITIES) {
  for (const capability of capabilities) {
    if ((capability.commands || []).includes(cmd)) return capability.id
  }
  return null
}

function checkValue(spec, value) {
  if (value === undefined || value === null) return 'missing'
  switch (spec.type) {
    case 'int':
      if (!Number.isInteger(value)) return 'not_integer'
      if (spec.min !== undefined && value < spec.min) return 'too_small'
      if (spec.max !== undefined && value > spec.max) return 'too_large'
      return null
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'not_number'
      if (spec.min !== undefined && value < spec.min) return 'too_small'
      if (spec.max !== undefined && value > spec.max) return 'too_large'
      return null
    case 'string':
      if (typeof value !== 'string') return 'not_string'
      if (spec.maxLength !== undefined && value.length > spec.maxLength) return 'too_long'
      return null
    case 'bool':
      return typeof value === 'boolean' ? null : 'not_bool'
    case 'enum':
      return Array.isArray(spec.values) && spec.values.includes(value) ? null : 'not_allowed'
    default:
      return 'unknown_type'
  }
}

/** 校验参数并返回干净的参数对象（丢弃多余字段，避免把任意内容透传给原生层）。 */
export function validateArgs(cmd, args = {}) {
  const spec = COMMANDS[cmd]
  if (!spec) return { ok: false, code: ERROR_CODES.UNKNOWN_COMMAND, detail: cmd }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, code: ERROR_CODES.INVALID_ARGS, detail: 'args' }
  }
  const clean = {}
  for (const [name, argSpec] of Object.entries(spec.args || {})) {
    const problem = checkValue(argSpec, args[name])
    if (problem) return { ok: false, code: ERROR_CODES.INVALID_ARGS, detail: `${name}:${problem}` }
    clean[name] = args[name]
  }
  return { ok: true, args: clean }
}

function envelopeError(id, code, message, extra = {}) {
  return { id: id || null, ok: false, at: Date.now(), error: { code, message, ...extra } }
}

/**
 * 带超时执行，并在结束时清掉计时器。
 * 只 race 不清理的话，每条成功命令都会残留一个 15s 的定时器，
 * 进程会因此多活十几秒（单测里表现为整个文件莫名耗时 15s）。
 */
export function withTimeout(run, timeoutMs, onTimeout = () => Object.assign(new Error('timeout'), { code: ERROR_CODES.TIMEOUT })) {
  let timer = null
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs)
  })
  return Promise.race([Promise.resolve().then(run), watchdog]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

/**
 * 创建网关。
 * @param {object} options
 * @param {Record<string, (args:object)=>any>} options.handlers 命令实现；缺失的命令视为未授权
 * @param {object} [options.policy] 覆盖 DEFAULT_POLICY
 * @param {{record:Function}} [options.audit] 审计日志（见 audit.js）
 * @param {() => number} [options.now]
 * @param {(cmd:string, level:number, args:object)=>Promise<boolean>|boolean} [options.confirm] 逐次二次确认
 */
export function createGateway(options = {}) {
  const handlers = options.handlers || {}
  const policy = { ...DEFAULT_POLICY, ...(options.policy || {}) }
  const audit = options.audit || { record() {} }
  const now = options.now || (() => Date.now())
  const confirm = options.confirm || null
  const defaultTimeout = options.timeoutMs || DEFAULT_TIMEOUT_MS
  const calls = new Map()

  function rateLimited(cmd) {
    const windowStart = now() - 60000
    const list = (calls.get(cmd) || []).filter((at) => at > windowStart)
    calls.set(cmd, list)
    return list.length >= policy.perMinute
  }

  function remember(cmd) {
    const list = calls.get(cmd) || []
    list.push(now())
    calls.set(cmd, list)
  }

  return {
    commands: COMMANDS,
    policy,

    /** 只做检查不动手，给 UI 预判用。 */
    inspect(cmd) {
      const spec = COMMANDS[cmd]
      if (!spec) return { ok: false, code: ERROR_CODES.UNKNOWN_COMMAND }
      if ((policy.deny || []).includes(cmd)) return { ok: false, code: ERROR_CODES.DENIED_BY_POLICY }
      if (spec.level > policy.maxLevel) return { ok: false, code: ERROR_CODES.DENIED_BY_POLICY }
      if (typeof handlers[cmd] !== 'function') return { ok: false, code: ERROR_CODES.NOT_GRANTED }
      return { ok: true, level: spec.level, capability: commandCapability(cmd) }
    },

    async handle(envelope) {
      const started = now()
      const id = envelope && typeof envelope === 'object' ? envelope.id : null
      if (!envelope || typeof envelope !== 'object' || typeof envelope.cmd !== 'string') {
        audit.record({ at: started, cmd: envelope?.cmd || '', ok: false, code: ERROR_CODES.BAD_ENVELOPE })
        return { ...envelopeError(id, ERROR_CODES.BAD_ENVELOPE, '命令帧格式不正确'), at: started }
      }
      const cmd = envelope.cmd
      const spec = COMMANDS[cmd]

      const fail = (code, message, extra) => {
        audit.record({ at: started, cmd, level: spec?.level ?? null, ok: false, code, args: envelope.args, ms: now() - started })
        return { id, cmd, ok: false, at: started, ms: now() - started, error: { code, message, ...extra } }
      }

      if (!spec) return fail(ERROR_CODES.UNKNOWN_COMMAND, `不支持的命令：${cmd}`)
      if ((policy.deny || []).includes(cmd)) return fail(ERROR_CODES.DENIED_BY_POLICY, '该命令已被用户列入拒绝清单')
      if (spec.level > policy.maxLevel) {
        return fail(ERROR_CODES.DENIED_BY_POLICY, `危险等级 L${spec.level} 超过当前上限 L${policy.maxLevel}`)
      }
      if (rateLimited(cmd)) return fail(ERROR_CODES.RATE_LIMITED, '这台手机上的调用太频繁了')

      const checked = validateArgs(cmd, envelope.args)
      if (!checked.ok) return fail(checked.code, `参数不合法：${checked.detail}`, { detail: checked.detail })

      const handler = handlers[cmd]
      if (typeof handler !== 'function') {
        return fail(ERROR_CODES.NOT_GRANTED, '这一项授权还没打开', { capability: commandCapability(cmd) })
      }

      if (spec.level >= 2 && typeof confirm === 'function') {
        let approved = false
        try {
          approved = await confirm(cmd, spec.level, checked.args)
        } catch {
          approved = false
        }
        if (!approved) return fail(ERROR_CODES.DENIED_BY_USER, '手机上没有确认这次操作')
      }

      remember(cmd)
      const timeoutMs = spec.timeoutMs || defaultTimeout
      try {
        const data = await withTimeout(() => handler(checked.args, { cmd, level: spec.level }), timeoutMs)
        audit.record({ at: started, cmd, level: spec.level, ok: true, args: checked.args, ms: now() - started })
        return { id, cmd, ok: true, at: started, ms: now() - started, data: data === undefined ? null : data }
      } catch (error) {
        const code = error?.code === ERROR_CODES.TIMEOUT ? ERROR_CODES.TIMEOUT : error?.code || ERROR_CODES.HANDLER_FAILED
        audit.record({ at: started, cmd, level: spec.level, ok: false, code, args: checked.args, ms: now() - started })
        return {
          id,
          cmd,
          ok: false,
          at: started,
          ms: now() - started,
          error: { code, message: error?.message || '执行失败', hint: error?.hint || null }
        }
      }
    }
  }
}
