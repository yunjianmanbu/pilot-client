import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COMMANDS,
  DEFAULT_POLICY,
  ERROR_CODES,
  commandCapability,
  createGateway,
  validateArgs,
  withTimeout
} from '../lib/reverse-control.js'
import { CAPABILITIES } from '../lib/capabilities.js'

function makeAudit() {
  const entries = []
  return {
    entries,
    record(entry) {
      entries.push(entry)
    }
  }
}

test('命令与能力目录：每条命令恰好属于一项能力', () => {
  const owners = new Map()
  for (const capability of CAPABILITIES) {
    for (const cmd of capability.commands) {
      assert.ok(COMMANDS[cmd], `${capability.id} 里写了不存在的命令：${cmd}`)
      assert.ok(!owners.has(cmd), `${cmd} 同时属于 ${owners.get(cmd)} 和 ${capability.id}`)
      owners.set(cmd, capability.id)
    }
  }
  const unowned = Object.keys(COMMANDS).filter((cmd) => !owners.has(cmd))
  assert.deepEqual(unowned, [], `这些命令没有归属能力：${unowned.join(', ')}`)
})

test('命令等级：破坏性命令必须是 L4，读屏注入必须是 L2', () => {
  assert.equal(COMMANDS['rc.device.wipe'].level, 4)
  assert.equal(COMMANDS['rc.device.reboot'].level, 4)
  assert.equal(COMMANDS['rc.app.uninstall'].level, 4)
  assert.equal(COMMANDS['rc.input.tap'].level, 2)
  assert.equal(COMMANDS['rc.screen.capture'].level, 2)
  assert.equal(COMMANDS['rc.sms.list'].level, 3)
  assert.equal(COMMANDS['rc.ping'].level, 0)
})

test('commandCapability：能反查归属，未知命令返回 null', () => {
  assert.equal(commandCapability('rc.input.tap'), 'input')
  assert.equal(commandCapability('rc.sms.send'), 'sms')
  assert.equal(commandCapability('rc.not.a.command'), null)
})

test('validateArgs：缺参数、越界、类型不对都拒绝', () => {
  assert.equal(validateArgs('rc.input.tap', { x: 10, y: 20 }).ok, true)
  assert.equal(validateArgs('rc.input.tap', { x: -1, y: 20 }).code, ERROR_CODES.INVALID_ARGS)
  assert.equal(validateArgs('rc.input.tap', { x: 1.5, y: 20 }).code, ERROR_CODES.INVALID_ARGS)
  assert.equal(validateArgs('rc.input.tap', { x: 10 }).code, ERROR_CODES.INVALID_ARGS)
  assert.equal(validateArgs('rc.input.key', { key: 'zoom' }).code, ERROR_CODES.INVALID_ARGS)
  assert.equal(validateArgs('rc.device.volume', { level: 2 }).code, ERROR_CODES.INVALID_ARGS)
})

test('validateArgs：多余字段被丢弃，不透传给原生层', () => {
  const result = validateArgs('rc.input.tap', { x: 10, y: 20, evil: 'rm -rf' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.args, { x: 10, y: 20 })
})

test('网关：未知命令返回 unknown_command 且写审计', async () => {
  const audit = makeAudit()
  const gateway = createGateway({ handlers: {}, audit })
  const result = await gateway.handle({ id: 'a1', cmd: 'rc.nope', args: {} })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, ERROR_CODES.UNKNOWN_COMMAND)
  assert.equal(result.id, 'a1')
  assert.equal(audit.entries.length, 1)
  assert.equal(audit.entries[0].ok, false)
})

test('网关：没有对应实现时返回 not_granted 并带上能力 id', async () => {
  const gateway = createGateway({ handlers: {}, audit: makeAudit() })
  const result = await gateway.handle({ id: 'a2', cmd: 'rc.input.tap', args: { x: 1, y: 2 } })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, ERROR_CODES.NOT_GRANTED)
  assert.equal(result.error.capability, 'input')
})

test('网关：默认策略挡住 L4，显式放开后才执行', async () => {
  let called = 0
  const handlers = { 'rc.device.wipe': () => { called += 1; return { wiped: true } } }
  const blocked = createGateway({ handlers, audit: makeAudit() })
  const denied = await blocked.handle({ id: 'a3', cmd: 'rc.device.wipe', args: {} })
  assert.equal(denied.error.code, ERROR_CODES.DENIED_BY_POLICY)
  assert.equal(called, 0)

  const allowed = createGateway({ handlers, audit: makeAudit(), policy: { maxLevel: 4 } })
  const result = await allowed.handle({ id: 'a4', cmd: 'rc.device.wipe', args: {} })
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, { wiped: true })
  assert.equal(called, 1)
})

test('网关：拒绝清单优先级高于等级', async () => {
  const gateway = createGateway({
    handlers: { 'rc.clipboard.get': () => ({ text: 'x' }) },
    audit: makeAudit(),
    policy: { deny: ['rc.clipboard.get'] }
  })
  const result = await gateway.handle({ id: 'a5', cmd: 'rc.clipboard.get', args: {} })
  assert.equal(result.error.code, ERROR_CODES.DENIED_BY_POLICY)
})

test('网关：限流按每分钟统计，超过直接拒绝', async () => {
  const gateway = createGateway({
    handlers: { 'rc.ping': () => ({ pong: 1 }) },
    audit: makeAudit(),
    policy: { perMinute: 2 }
  })
  assert.equal((await gateway.handle({ id: '1', cmd: 'rc.ping' })).ok, true)
  assert.equal((await gateway.handle({ id: '2', cmd: 'rc.ping' })).ok, true)
  const third = await gateway.handle({ id: '3', cmd: 'rc.ping' })
  assert.equal(third.error.code, ERROR_CODES.RATE_LIMITED)
})

test('网关：处理超时返回 timeout，不把整机拖死', async () => {
  const gateway = createGateway({
    handlers: { 'rc.status': () => new Promise(() => {}) },
    audit: makeAudit(),
    timeoutMs: 30
  })
  const result = await gateway.handle({ id: 'a6', cmd: 'rc.status', args: {} })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, ERROR_CODES.TIMEOUT)
})

test('网关：用户不确认时不下发', async () => {
  let called = 0
  const gateway = createGateway({
    handlers: { 'rc.input.tap': () => { called += 1; return { ok: true } } },
    audit: makeAudit(),
    confirm: () => false
  })
  const result = await gateway.handle({ id: 'a7', cmd: 'rc.input.tap', args: { x: 1, y: 1 } })
  assert.equal(result.error.code, ERROR_CODES.DENIED_BY_USER)
  assert.equal(called, 0)
})

test('网关：用户确认后执行，并把参数原样交给 handler', async () => {
  const seen = []
  const gateway = createGateway({
    handlers: { 'rc.input.swipe': (args) => { seen.push(args); return { ok: true } } },
    audit: makeAudit(),
    confirm: () => true
  })
  const args = { x1: 1, y1: 2, x2: 3, y2: 4, duration: 300 }
  const result = await gateway.handle({ id: 'a8', cmd: 'rc.input.swipe', args })
  assert.equal(result.ok, true)
  assert.deepEqual(seen, [args])
})

test('网关：handler 抛错转成 handler_failed，带上 hint', async () => {
  const gateway = createGateway({
    handlers: {
      'rc.screen.capture': () => {
        throw Object.assign(new Error('没有屏幕采集权限'), { hint: '去授权中心打开屏幕采集' })
      }
    },
    audit: makeAudit()
  })
  const result = await gateway.handle({ id: 'a9', cmd: 'rc.screen.capture', args: {} })
  assert.equal(result.error.code, ERROR_CODES.HANDLER_FAILED)
  assert.equal(result.error.hint, '去授权中心打开屏幕采集')
})

test('网关：畸形帧不崩，返回 bad_envelope', async () => {
  const gateway = createGateway({ handlers: {}, audit: makeAudit() })
  assert.equal((await gateway.handle(null)).error.code, ERROR_CODES.BAD_ENVELOPE)
  assert.equal((await gateway.handle({ id: 'x' })).error.code, ERROR_CODES.BAD_ENVELOPE)
})

test('inspect：只检查不动手，规则与 handle 一致', () => {
  const gateway = createGateway({ handlers: { 'rc.ping': () => ({}) }, audit: makeAudit() })
  assert.deepEqual(gateway.inspect('rc.ping'), { ok: true, level: 0, capability: 'link' })
  assert.equal(gateway.inspect('rc.device.wipe').code, ERROR_CODES.DENIED_BY_POLICY)
  assert.equal(gateway.inspect('rc.input.tap').code, ERROR_CODES.NOT_GRANTED)
})

test('网关：成功命令不残留定时器，进程能立即退出', async () => {
  const started = Date.now()
  const gateway = createGateway({ handlers: { 'rc.ping': () => ({}) }, audit: makeAudit(), timeoutMs: 400 })
  await gateway.handle({ id: 't1', cmd: 'rc.ping' })
  // 若定时器没被清掉，node 会等到 400ms 后才退出；这里用主动等待证明事件循环已空。
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(Date.now() - started < 200, '成功执行后不应等超时计时器')
})

test('withTimeout：超时清计时器，正常结束也清', async () => {
  const slow = await withTimeout(() => new Promise(() => {}), 20).catch((error) => error)
  assert.equal(slow.code, ERROR_CODES.TIMEOUT)
  assert.equal(await withTimeout(() => 42, 50), 42)
})

test('默认策略：最高放行 L3，且没有预置拒绝项', () => {
  assert.equal(DEFAULT_POLICY.maxLevel, 3)
  assert.deepEqual(DEFAULT_POLICY.deny, [])
  assert.ok(DEFAULT_POLICY.perMinute > 0)
})
