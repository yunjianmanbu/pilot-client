import test from 'node:test'
import assert from 'node:assert/strict'

import { createGateway, COMMANDS as ALL_COMMANDS } from '../lib/reverse-control.js'
import { createHandlers, NATIVE_HINTS } from '../lib/device-actions.js'

/** 最小的 uni 假实现：只实现被调用的接口，其余抛错以便发现意外调用。 */
function makeUni(overrides = {}) {
  const calls = []
  const base = {
    getClipboardData(options) {
      calls.push(['getClipboardData'])
      options.success({ data: '剪贴板内容' })
    },
    setClipboardData(options) {
      calls.push(['setClipboardData', options.data])
      options.success()
    },
    vibrateLong(options) {
      calls.push(['vibrateLong'])
      options && options.success && options.success()
    },
    showToast(options) {
      calls.push(['showToast', options.title])
    },
    getBatteryInfo(options) {
      calls.push(['getBatteryInfo'])
      options.success({ level: 88, isCharging: true })
    },
    getNetworkType(options) {
      calls.push(['getNetworkType'])
      options.success({ networkType: 'wifi' })
    }
  }
  return { calls, uni: { ...base, ...overrides } }
}

function makePlus(overrides = {}) {
  const calls = []
  const base = {
    os: { name: 'Android' },
    runtime: { version: '1.0.0' },
    device: {
      getInfo(options) {
        calls.push(['getInfo'])
        options.success({ model: 'Pixel', vendor: 'Google' })
      },
      setVolume(level) {
        calls.push(['setVolume', level])
      },
      setWakelock(on) {
        calls.push(['setWakelock', on])
      }
    },
    screen: {
      setBrightness(level) {
        calls.push(['setBrightness', level])
      }
    },
    io: {
      resolveLocalFileSystemURL(path, success, fail) {
        calls.push(['resolveLocalFileSystemURL', path])
        if (path === '/nope') {
          fail({ code: 1 })
          return
        }
        success({
          createReader: () => ({
            readEntries: (cb) =>
              cb([
                { name: 'a.txt', isDirectory: false, fileSize: 12, lastModifiedDate: new Date(1700000000000) },
                { name: 'sub', isDirectory: true }
              ])
          })
        })
      }
    }
  }
  return { calls, plus: { ...base, ...overrides } }
}

test('handler 覆盖：每条命令都有实现，网关不会因为缺实现而 not_granted', () => {
  const { uni } = makeUni()
  const { plus } = makePlus()
  const handlers = createHandlers({ uni, plus })
  const missing = Object.keys(ALL_COMMANDS).filter((cmd) => typeof handlers[cmd] !== 'function')
  assert.deepEqual(missing, [], `这些命令没有实现：${missing.join(', ')}`)
})

test('rc.status：汇总机型、电量、网络，缺接口的字段留 null', async () => {
  const { uni } = makeUni()
  const { plus } = makePlus()
  const handlers = createHandlers({ uni, plus })
  const status = await handlers['rc.status']()
  assert.equal(status.model, 'Pixel')
  assert.equal(status.battery, 88)
  assert.equal(status.charging, true)
  assert.equal(status.network, 'wifi')
  assert.equal(status.platform, 'Android')
})

test('rc.status：没有 plus 时也能返回，不抛错', async () => {
  const { uni } = makeUni()
  const handlers = createHandlers({ uni, plus: null })
  const status = await handlers['rc.status']()
  assert.equal(status.platform, 'unknown')
  assert.equal(status.battery, 88)
})

test('rc.clipboard.get / set：走 uni，正文不截断', async () => {
  const { uni, calls } = makeUni()
  const handlers = createHandlers({ uni, plus: null })
  assert.deepEqual(await handlers['rc.clipboard.get'](), { text: '剪贴板内容' })
  assert.deepEqual(await handlers['rc.clipboard.set']({ text: 'hi' }), { ok: true, chars: 2 })
  assert.deepEqual(calls.filter((call) => call[0] === 'setClipboardData'), [['setClipboardData', 'hi']])
})

test('rc.device.volume / brightness / wake：透传给 plus', async () => {
  const { plus, calls } = makePlus()
  const handlers = createHandlers({ uni: makeUni().uni, plus })
  assert.deepEqual(handlers['rc.device.volume']({ level: 0.5 }), { level: 0.5 })
  assert.deepEqual(handlers['rc.device.brightness']({ level: 0.2 }), { level: 0.2 })
  assert.deepEqual(handlers['rc.device.wake']({ on: true }), { on: true })
  assert.deepEqual(calls.map((call) => call[0]), ['setVolume', 'setBrightness', 'setWakelock'])
})

test('rc.files.list：目录项映射成 {name,dir,size,modified}', async () => {
  const { plus } = makePlus()
  const handlers = createHandlers({ uni: makeUni().uni, plus })
  const result = await handlers['rc.files.list']({ path: '_doc' })
  assert.equal(result.path, '_doc')
  assert.deepEqual(result.items[0], { name: 'a.txt', dir: false, size: 12, modified: 1700000000000 })
  assert.deepEqual(result.items[1], { name: 'sub', dir: true, size: null, modified: null })
})

test('rc.files.list：坏路径转成 handler_failed + 提示', async () => {
  const { plus } = makePlus()
  const handlers = createHandlers({ uni: makeUni().uni, plus })
  await assert.rejects(() => handlers['rc.files.list']({ path: '/nope' }), (error) => {
    assert.equal(error.code, 'handler_failed')
    assert.equal(error.hint, NATIVE_HINTS.files)
    return true
  })
})

test('没接原生服务的命令只返回 not_granted + 明确 hint，不假装成功', async () => {
  const handlers = createHandlers({ uni: makeUni().uni, plus: null })
  const cases = [
    ['rc.screen.capture', 'screen'],
    ['rc.input.tap', 'input'],
    ['rc.input.text', 'input'],
    ['rc.notify.list', 'notify'],
    ['rc.sms.list', 'sms'],
    ['rc.contacts.list', 'contacts'],
    ['rc.call.dial', 'phone'],
    ['rc.location.get', 'location'],
    ['rc.camera.photo', 'camera'],
    ['rc.device.lock', 'deviceAdmin'],
    ['rc.calendar.list', 'calendar']
  ]
  for (const [cmd, hintKey] of cases) {
    await assert.rejects(
      async () => handlers[cmd]({ x: 1, y: 1, limit: 1, accuracy: 'coarse', facing: 'back', days: 1, to: '1' }),
      (error) => {
        assert.equal(error.code, 'not_granted', `${cmd} 应返回 not_granted`)
        assert.equal(error.hint, NATIVE_HINTS[hintKey], `${cmd} 的提示不对`)
        return true
      },
      `${cmd} 没有按预期拒绝`
    )
  }
})

test('已授权但原生未接：提示改成「还没接上原生服务」，不误导用户去重复授权', async () => {
  const handlers = createHandlers({ uni: makeUni().uni, plus: null, granted: { screen: true } })
  await assert.rejects(
    async () => handlers['rc.screen.capture']({}),
    (error) => {
      assert.equal(error.code, 'not_granted')
      assert.match(error.message, /接上原生服务/)
      assert.equal(error.hint, NATIVE_HINTS.screen)
      return true
    }
  )
})

test('通过网关调用未接原生的命令：错误码与提示能一路传到电脑端', async () => {
  const handlers = createHandlers({ uni: makeUni().uni, plus: null })
  const gateway = createGateway({ handlers, audit: { record() {} } })
  const result = await gateway.handle({ id: 'z1', cmd: 'rc.screen.capture', args: {} })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'not_granted')
  assert.equal(result.error.hint, NATIVE_HINTS.screen)
})

test('rc.app.open：没装应用时报 handler_failed', async () => {
  const android = {
    runtimeMainActivity: () => ({
      getPackageManager: () => ({ getLaunchIntentForPackage: () => null }),
      startActivity() {
        throw new Error('不该走到这里')
      }
    }),
    importClass: () => function Intent() {}
  }
  const { plus } = makePlus({ android })
  const handlers = createHandlers({ uni: makeUni().uni, plus })
  assert.throws(() => handlers['rc.app.open']({ pkg: 'com.nope' }), /没装这个应用/)
})
