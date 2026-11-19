import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CAPABILITIES, allRuntimePermissions, allSpecialPermissions, manifestPermissionNames } from '../lib/capabilities.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'))

test('manifest：应用信息符合「Pilot Client」', () => {
  assert.equal(manifest.name, 'Pilot Client')
  assert.match(manifest.versionName, /^\d+\.\d+\.\d+$/)
  assert.match(manifest.appid, /^__UNI__[0-9A-F]{7}$/)
  const android = manifest['app-plus'].distribute.android
  assert.equal(android.packagename, 'cc.medpilot.pilotclient')
  assert.equal(android.targetSdkVersion, 35)
  assert.deepEqual(android.abiFilters, ['armeabi-v7a', 'arm64-v8a'])
})

test('manifest：图标齐全且指向已生成的白底图标', () => {
  const icons = manifest['app-plus'].distribute.icons.android
  const expected = { mdpi: '48', hdpi: '72', xhdpi: '96', xxhdpi: '144', xxxhdpi: '192' }
  for (const [dpi, size] of Object.entries(expected)) {
    assert.equal(icons[dpi], `static/icons/${size}.png`)
    assert.ok(existsSync(resolve(ROOT, icons[dpi])), `缺少图标 ${icons[dpi]}`)
  }
  assert.ok(existsSync(resolve(ROOT, 'static/icons/icon.png')), '缺少 1024 图标')
  assert.ok(existsSync(resolve(ROOT, 'static/icons/icon.svg')), '缺少 svg 图标')
})

test('manifest：代码里要的普通权限，清单里必须都声明了', () => {
  const declared = new Set(manifestPermissionNames(manifest))
  const missing = allRuntimePermissions().filter((name) => !declared.has(name))
  assert.deepEqual(missing, [], `清单缺少权限：${missing.join(', ')}`)
})

test('manifest：清单里的权限必须能对回能力目录，避免无主权限', () => {
  const wanted = new Set([
    ...allRuntimePermissions(),
    ...allSpecialPermissions().map((special) => special.permission)
  ])
  const orphan = manifestPermissionNames(manifest).filter((name) => !wanted.has(name))
  assert.deepEqual(orphan, [], `清单里有能力目录没解释的权限：${orphan.join(', ')}`)
})

test('manifest：iOS 隐私说明覆盖相机、麦克风、通讯录等敏感能力', () => {
  const privacy = manifest['app-plus'].distribute.ios.privacyDescription
  for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSContactsUsageDescription', 'NSLocationWhenInUseUsageDescription']) {
    assert.ok(privacy[key] && privacy[key].length > 4, `缺少 ${key}`)
  }
})

test('manifest：能力目录覆盖了「看屏幕、能点击」这两件核心事', () => {
  const ids = CAPABILITIES.map((capability) => capability.id)
  assert.ok(ids.includes('input'), '缺少输入注入能力')
  const input = CAPABILITIES.find((capability) => capability.id === 'input')
  assert.ok(input.commands.includes('rc.input.tap'))
  assert.ok(input.commands.includes('rc.screen.capture'))
})
