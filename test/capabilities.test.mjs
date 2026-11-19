import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPABILITIES,
  SPECIAL_PERMISSIONS,
  allRuntimePermissions,
  allSpecialPermissions,
  capabilityById,
  manifestPermissionNames,
  nextRuntimeBatch,
  requiresConfirm,
  riskLabel,
  summarize
} from '../lib/capabilities.js'

test('能力目录：id 唯一、风险等级合法、每项都有命令', () => {
  const ids = new Set()
  for (const capability of CAPABILITIES) {
    assert.ok(!ids.has(capability.id), `重复的能力 id：${capability.id}`)
    ids.add(capability.id)
    assert.ok(['low', 'medium', 'high', 'critical'].includes(capability.risk), `${capability.id} 风险等级不合法`)
    assert.ok(capability.title.length > 0, `${capability.id} 缺少标题`)
    assert.ok(capability.commands.length > 0, `${capability.id} 没有任何反控命令`)
    assert.ok(capability.runtime.length + capability.special.length > 0, `${capability.id} 没有任何授权`)
  }
})

test('能力目录：特殊授权 id 都能在 SPECIAL_PERMISSIONS 里找到', () => {
  for (const capability of CAPABILITIES) {
    for (const id of capability.special) {
      const special = SPECIAL_PERMISSIONS[id]
      assert.ok(special, `${capability.id} 引用了不存在的特殊授权：${id}`)
      assert.match(special.action, /^android\.settings\./, `${id} 的跳转 action 不合法`)
      assert.match(special.permission, /^android\.permission\.[A-Z_]+$/, `${id} 的权限名不合法`)
    }
  }
})

test('能力目录：普通权限格式合法且不重复声明两次', () => {
  const all = allRuntimePermissions()
  assert.ok(all.length >= 60, `普通权限只有 ${all.length} 项，明显少于预期`)
  for (const name of all) assert.match(name, /^android\.permission\.[A-Z0-9_]+$/)
  assert.equal(new Set(all).size, all.length)
  assert.deepEqual(all, [...all].sort())
})

test('能力目录：高危/极高危能力要求二次确认', () => {
  for (const capability of CAPABILITIES) {
    const expected = capability.risk === 'high' || capability.risk === 'critical'
    assert.equal(requiresConfirm(capability), expected, `${capability.id} 的确认策略不对`)
  }
})

test('summarize：只有整项授权齐全才算已授权', () => {
  const granted = {}
  for (const name of allRuntimePermissions()) granted[name] = true
  for (const special of Object.keys(SPECIAL_PERMISSIONS)) granted[special] = true
  const full = summarize(granted)
  assert.equal(full.total, CAPABILITIES.length)
  assert.equal(full.granted, CAPABILITIES.length)
  assert.equal(full.ratio, 1)
  assert.deepEqual(full.pending, [])

  const partial = summarize({})
  assert.equal(partial.granted, 0)
  assert.equal(partial.pending.length, CAPABILITIES.length)

  const link = capabilityById('link')
  const onlyLink = {}
  for (const name of link.runtime) onlyLink[name] = true
  for (const id of link.special) onlyLink[id] = true
  const one = summarize(onlyLink)
  assert.equal(one.granted, 1)
  assert.ok(!one.pending.includes('link'))
})

test('summarize：byRisk 分桶数量与目录一致', () => {
  const summary = summarize({})
  const total = Object.values(summary.byRisk).reduce((sum, bucket) => sum + bucket.total, 0)
  assert.equal(total, CAPABILITIES.length)
})

test('nextRuntimeBatch：只返回未授权项并按批次截断', () => {
  const all = allRuntimePermissions()
  const granted = {}
  granted[all[0]] = true
  const batch = nextRuntimeBatch(granted, 5)
  assert.equal(batch.length, 5)
  assert.ok(!batch.includes(all[0]))
  assert.equal(nextRuntimeBatch(all.map((name) => name).reduce((acc, name) => ((acc[name] = true), acc), {}), 5).length, 0)
})

test('allSpecialPermissions：按目录顺序去重展开', () => {
  const list = allSpecialPermissions()
  const ids = list.map((item) => item.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.includes('accessibility'))
  assert.ok(ids.includes('notificationListener'))
})

test('manifestPermissionNames：能从清单字符串里取出权限名', () => {
  const manifest = {
    'app-plus': {
      distribute: {
        android: {
          permissions: [
            '<uses-permission android:name="android.permission.INTERNET"/>',
            '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32"/>',
            '<uses-feature android:name="android.hardware.camera"/>'
          ]
        }
      }
    }
  }
  assert.deepEqual(manifestPermissionNames(manifest), [
    'android.permission.INTERNET',
    'android.permission.READ_EXTERNAL_STORAGE'
  ])
})

test('riskLabel：未知等级原样返回', () => {
  assert.equal(riskLabel('critical'), '极高')
  assert.equal(riskLabel('whatever'), 'whatever')
})
