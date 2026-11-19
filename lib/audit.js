/**
 * 操作记录（审计日志）。
 *
 * 反控的每一步都会落到这里：什么时间、电脑端下了哪条命令、带什么参数、成功与否。
 * 参数与结果在入库前统一脱敏 —— 剪贴板正文、短信内容、文件名、手机号都不原样保存，
 * 只留下「操作类型 + 长度/摘要」，这样用户翻记录能看懂发生了什么，拿到日志的人也
 * 不会顺手拿到通讯录和短信。
 *
 * 存储用可注入的 `storage`（App 里传 uni 的同步存储，测试里传内存实现），
 * 不直接依赖 uni，方便单测。
 */

export const AUDIT_KEY = 'pilot-client.audit.v1'
export const AUDIT_LIMIT = 200

const SENSITIVE_KEY = /(password|passwd|token|secret|body|content|payload|clipboard|text|query|filename|path|number|address|^to$|^from$)/i
const PHONE_LIKE = /^\+?\d{7,}$/

/** 长字符串只留头尾，避免把整条短信/整份文件内容写进日志。 */
function clipString(value) {
  const text = String(value)
  if (text.length <= 24) return text
  return `${text.slice(0, 8)}…(${text.length} 字)`
}

export function redactValue(key, value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (SENSITIVE_KEY.test(key) || PHONE_LIKE.test(value)) return `<redacted:${value.length}>`
    return clipString(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return `<array:${value.length}>`
  if (typeof value === 'object') return `<object:${Object.keys(value).length}>`
  return clipString(value)
}

/** 参数整体脱敏：键名敏感的替换成 `<redacted:长度>`，其余截断。 */
export function redactArgs(args) {
  if (!args || typeof args !== 'object') return null
  const out = {}
  for (const [key, value] of Object.entries(args)) out[key] = redactValue(key, value)
  return out
}

export function createAuditLog(options = {}) {
  const limit = options.limit || AUDIT_LIMIT
  const storage = options.storage || null
  const now = options.now || (() => Date.now())
  let entries = load()

  function load() {
    if (!storage) return []
    try {
      const raw = storage.get(AUDIT_KEY)
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  function persist() {
    if (!storage) return
    try {
      storage.set(AUDIT_KEY, JSON.stringify(entries))
    } catch {
      // 存储写失败不能影响反控本身，记录只在内存里留一份。
    }
  }

  return {
    record(entry = {}) {
      const item = {
        at: entry.at || now(),
        cmd: entry.cmd || '',
        level: typeof entry.level === 'number' ? entry.level : null,
        ok: entry.ok === true,
        code: entry.code || null,
        args: redactArgs(entry.args),
        ms: typeof entry.ms === 'number' ? entry.ms : null
      }
      entries.push(item)
      if (entries.length > limit) entries = entries.slice(entries.length - limit)
      persist()
      return item
    },
    list() {
      return entries.slice()
    },
    latest(count = 3) {
      return entries.slice(Math.max(0, entries.length - count))
    },
    clear() {
      entries = []
      persist()
    },
    exportText() {
      return entries
        .map((item) => {
          const time = new Date(item.at).toISOString().replace('T', ' ').slice(0, 19)
          const verdict = item.ok ? 'OK' : `FAIL(${item.code || 'error'})`
          const args = item.args ? ` ${JSON.stringify(item.args)}` : ''
          return `${time} L${item.level ?? '-'} ${item.cmd} ${verdict}${args}`
        })
        .join('\n')
    }
  }
}
