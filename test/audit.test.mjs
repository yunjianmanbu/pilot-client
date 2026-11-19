import test from 'node:test'
import assert from 'node:assert/strict'

import { AUDIT_KEY, createAuditLog, redactArgs, redactValue } from '../lib/audit.js'

function makeStorage() {
  const map = new Map()
  return {
    map,
    get(key) {
      return map.has(key) ? map.get(key) : null
    },
    set(key, value) {
      map.set(key, value)
    }
  }
}

test('脱敏：敏感键只留长度，不存原文', () => {
  const secret = '你的验证码是 123456'
  assert.equal(redactValue('text', secret), `<redacted:${secret.length}>`)
  assert.equal(redactValue('body', '短信正文'), `<redacted:${'短信正文'.length}>`)
  const path = '/sdcard/secret.txt'
  assert.equal(redactValue('path', path), `<redacted:${path.length}>`)
  assert.equal(redactValue('x', 120), 120)
  assert.equal(redactValue('on', true), true)
  // 手机号这种纯数字串即使键名不敏感也要抹掉
  assert.equal(redactValue('to', '13800000000'), '<redacted:11>')
})

test('脱敏：非敏感长字符串截断，短字符串保留', () => {
  assert.equal(redactValue('cmd', 'rc.input.tap'), 'rc.input.tap')
  const long = 'a'.repeat(100)
  assert.match(redactValue('title', long), /…\(100 字\)$/)
})

test('脱敏：整个参数对象按字段处理', () => {
  assert.deepEqual(redactArgs({ x: 1, text: 'hello', key: 'home' }), {
    x: 1,
    text: '<redacted:5>',
    key: 'home'
  })
  assert.equal(redactArgs(null), null)
})

test('审计：记录要点写全，参数已脱敏', () => {
  const log = createAuditLog({ storage: makeStorage(), now: () => 1700000000000 })
  const item = log.record({ cmd: 'rc.sms.send', level: 3, ok: true, args: { to: '13800000000', text: '在开会' }, ms: 12 })
  assert.equal(item.cmd, 'rc.sms.send')
  assert.equal(item.level, 3)
  assert.equal(item.ok, true)
  assert.equal(item.ms, 12)
  assert.equal(item.args.text, '<redacted:3>')
  assert.equal(item.args.to, '<redacted:11>')
})

test('审计：最多保留 200 条，超出丢最旧的', () => {
  const log = createAuditLog({ storage: makeStorage() })
  for (let i = 0; i < 205; i++) log.record({ cmd: 'rc.ping', ok: true })
  const list = log.list()
  assert.equal(list.length, 200)
  assert.equal(log.latest(3).length, 3)
})

test('审计：写入后能重新读出来（重启 App 不丢）', () => {
  const storage = makeStorage()
  const first = createAuditLog({ storage })
  first.record({ cmd: 'rc.device.lock', level: 3, ok: false, code: 'not_granted' })
  assert.ok(storage.map.has(AUDIT_KEY), '记录应写进存储')

  const second = createAuditLog({ storage })
  assert.equal(second.list().length, 1)
  assert.equal(second.list()[0].code, 'not_granted')
})

test('审计：存储坏掉不影响记录写入内存', () => {
  const storage = {
    get() {
      throw new Error('boom')
    },
    set() {
      throw new Error('boom')
    }
  }
  const log = createAuditLog({ storage })
  log.record({ cmd: 'rc.ping', ok: true })
  assert.equal(log.list().length, 1)
})

test('审计：清空与导出文本', () => {
  const log = createAuditLog({ storage: makeStorage(), now: () => Date.UTC(2026, 10, 17, 8, 30, 0) })
  log.record({ cmd: 'rc.ping', level: 0, ok: true })
  log.record({ cmd: 'rc.input.tap', level: 2, ok: false, code: 'timeout', args: { x: 1, y: 2 } })
  const text = log.exportText()
  assert.match(text, /L0 rc\.ping OK/)
  assert.match(text, /L2 rc\.input\.tap FAIL\(timeout\)/)
  log.clear()
  assert.deepEqual(log.list(), [])
})
