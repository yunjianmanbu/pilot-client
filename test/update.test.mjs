import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSha256, sha256Hex } from '../lib/sha256.js'
import {
  MANIFEST_URL,
  autoCheckUpdate,
  compareVersionNames,
  computeDownloadProgress,
  currentAppInfo,
  interpretDownloaderState,
  isNewerVersion,
  normalizeManifest,
  resolveUpdateTarget,
  verifyTimeoutFor
} from '../lib/update.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestJson = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'))

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

function manifest(overrides = {}) {
  return {
    version: '1.0.1',
    versionCode: 101,
    url: 'https://download.medpilot.cc/pilot/client-android/PilotClient-1.0.1.apk',
    sha256: SHA_A,
    size: 1000,
    ...overrides
  }
}

test('sha256：与 node:crypto 对同一份字节结果一致', () => {
  const cases = [Buffer.alloc(0), Buffer.from('abc'), Buffer.from('Pilot Client 被控端'), Buffer.alloc(5000, 7)]
  for (const bytes of cases) {
    const expected = createHash('sha256').update(bytes).digest('hex')
    assert.equal(sha256Hex(new Uint8Array(bytes)), expected, `长度 ${bytes.length} 的摘要不一致`)
  }
})

test('sha256：跨 64 字节分块边界仍然正确', () => {
  for (const length of [55, 56, 57, 63, 64, 65, 127, 128, 129]) {
    const bytes = Buffer.alloc(length, 0x5a)
    const expected = createHash('sha256').update(bytes).digest('hex')
    assert.equal(sha256Hex(new Uint8Array(bytes)), expected, `长度 ${length}`)
  }
})

test('sha256：增量 update 任意切块与一次性结果一致（更新包分块校验的前提）', () => {
  const bytes = Buffer.alloc(700 * 1024 + 37, 0x33)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) & 0xff
  const expected = createHash('sha256').update(bytes).digest('hex')
  for (const chunkSize of [1, 63, 64, 65, 4096, 512 * 1024, bytes.length]) {
    const hasher = createSha256()
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      hasher.update(new Uint8Array(bytes.subarray(offset, offset + chunkSize)))
    }
    assert.equal(hasher.digest(), expected, `分块大小 ${chunkSize}`)
  }
})

test('sha256：分块摘要收尾后不再接受 update，且只能 digest 一次', () => {
  const hasher = createSha256().update(new Uint8Array([1, 2, 3]))
  hasher.digest()
  assert.throws(() => hasher.update(new Uint8Array([4])), /digest/)
  assert.throws(() => hasher.digest(), /digest/)
})

test('computeDownloadProgress：下载中最多 99，下满了也不显示 100（100 留给校验完成）', () => {
  assert.equal(computeDownloadProgress(0, 1000), 0)
  assert.equal(computeDownloadProgress(500, 1000), 50)
  assert.equal(computeDownloadProgress(995, 1000), 99)
  assert.equal(computeDownloadProgress(1000, 1000), 99)
  assert.equal(computeDownloadProgress(1200, 1000), 99)
  // 服务器不给总大小时不显示假进度。
  assert.equal(computeDownloadProgress(500, 0), 0)
})

test('verifyTimeoutFor：小包 20s 起步，大包按大小放大但有上限', () => {
  assert.equal(verifyTimeoutFor(310460), 20000)
  assert.equal(verifyTimeoutFor(0), 20000)
  assert.equal(verifyTimeoutFor(10 * 1024 * 1024), 40000)
  assert.equal(verifyTimeoutFor(30 * 1024 * 1024), 120000)
  // 再大也不会无限等，3 分钟封顶。
  assert.equal(verifyTimeoutFor(500 * 1024 * 1024), 180000)
})

test('interpretDownloaderState：state=4 是真正的完成，不是只把界面置满', () => {
  const result = interpretDownloaderState({ state: 4, downloadedSize: 339502, totalSize: 339502, expectedSize: 339502 })
  assert.equal(result.action, 'complete')
  assert.equal(result.progress, 100)
  // 个别机型 state=4 时 totalSize 还没填，用清单大小兜底。
  assert.equal(interpretDownloaderState({ state: 4, downloadedSize: 0, totalSize: 0, expectedSize: 339502 }).action, 'complete')
})

test('interpretDownloaderState：state=5 是失败，不能当成完成或继续等', () => {
  assert.equal(interpretDownloaderState({ state: 5, downloadedSize: 10, totalSize: 100 }).action, 'failed')
})

test('interpretDownloaderState：只发 state=3 的机型——收满判定为 full，半程仍是 progress', () => {
  const half = interpretDownloaderState({ state: 3, downloadedSize: 169751, totalSize: 339502, expectedSize: 339502 })
  assert.equal(half.action, 'progress')
  assert.equal(half.progress, 50)
  const full = interpretDownloaderState({ state: 3, downloadedSize: 339502, totalSize: 339502, expectedSize: 339502 })
  assert.equal(full.action, 'full')
  // 服务器不给总大小时回退到清单大小，收满同样能识别。
  assert.equal(
    interpretDownloaderState({ state: 3, downloadedSize: 339502, totalSize: 0, expectedSize: 339502 }).action,
    'full'
  )
})

test('interpretDownloaderState：三类机型的完成事件序列都能落到 complete 或 full（不再停在 99%）', () => {
  const size = 339502
  // 机型 A：state 3 → 4（不回传 totalSize）。
  const a = interpretDownloaderState({ state: 4, downloadedSize: 0, totalSize: 0, expectedSize: size })
  // 机型 B：只发 state=3，最后一条 downloadedSize 已等于大小。
  const b = interpretDownloaderState({ state: 3, downloadedSize: size, totalSize: 0, expectedSize: size })
  // 机型 C：正常中途，最后靠完成回调（这里只验证中途不会被误判完成）。
  const c = interpretDownloaderState({ state: 3, downloadedSize: size - 1, totalSize: size, expectedSize: size })
  assert.equal(a.action, 'complete')
  assert.equal(b.action, 'full')
  assert.equal(c.action, 'progress')
  assert.equal(c.progress, 99)
})

test('update.js：state=4 必须 resolve 下载 promise，并有轮询与落盘等待兜底', () => {
  const source = readFileSync(resolve(ROOT, 'lib/update.js'), 'utf8')
  // 旧写法只有一个 markDone：只改 UI、不 resolve，只发 state=4 的机型就永远挂着。
  assert.doesNotMatch(source, /const markDone =/)
  assert.match(source, /action === 'complete'/)
  assert.match(source, /settle\(resolve, download\?\.filename \|\| path\)/)
  // statechanged 不触发时的进度轮询（pilot/pilot-link 同款兜底）。
  assert.match(source, /PROGRESS_POLL_INTERVAL_MS/)
  assert.match(source, /COMPLETION_GRACE_MS/)
  // 下载完成后先等文件落盘，否则会读到半个包。
  assert.match(source, /waitForDownloadedFile\(downloaded, target\.size\)/)
  // 安装用绝对路径，避免部分机型把 _doc 解析到别的沙箱目录。
  assert.match(source, /convertAbsoluteFileSystem/)
})

test('update.js：校验阶段是独立状态，且分块读文件而不是整包 readAsArrayBuffer', () => {
  const source = readFileSync(resolve(ROOT, 'lib/update.js'), 'utf8')
  // 下载完成到 ready 之间必须有可显示的阶段，否则界面会停在 99% 一动不动。
  assert.match(source, /status: 'verifying'/)
  // 校验阶段也要挡住第二次下载。
  assert.match(source, /status === 'downloading' \|\| downloadState\.status === 'verifying'/)
  assert.match(source, /readFileSlice\(file, offset, end\)/)
  assert.match(source, /createSha256\(\)/)
  // 一次性读取整包是 99% 卡住的根因（桥接层可能不回调）。
  assert.doesNotMatch(source, /readAsArrayBuffer\(file\)/)
})

test('manifest 地址：指向被控端清单，主机与协议受限于下载站', () => {
  assert.equal(MANIFEST_URL, 'https://download.medpilot.cc/pilot/client-android/latest.json')
})

test('normalizeManifest：合法清单原样保留全量包字段', () => {
  const result = normalizeManifest(JSON.stringify(manifest({ notes: '修图标', force: true })))
  assert.equal(result.version, '1.0.1')
  assert.equal(result.versionCode, 101)
  assert.equal(result.sha256, SHA_A)
  assert.equal(result.size, 1000)
  assert.equal(result.notes, '修图标')
  assert.equal(result.force, true)
  assert.equal(result.wgt, null)
})

test('normalizeManifest：非法字段让整份清单失效', () => {
  assert.equal(normalizeManifest('not json'), null)
  assert.equal(normalizeManifest('null'), null)
  assert.equal(normalizeManifest(manifest({ version: '' })), null)
  assert.equal(normalizeManifest(manifest({ sha256: 'short' })), null)
  assert.equal(normalizeManifest(manifest({ size: 0 })), null)
  assert.equal(normalizeManifest(manifest({ url: 'http://download.medpilot.cc/a.apk' })), null)
  assert.equal(normalizeManifest(manifest({ url: 'https://evil.example.com/a.apk' })), null)
  assert.equal(normalizeManifest(manifest({ url: 'https://download.medpilot.cc:8443/a.apk' })), null)
})

test('normalizeManifest：wgt 缺 sha256 时只丢字段，全量包仍然可用', () => {
  const withWgt = manifest({
    wgt: {
      version: '1.0.2',
      url: 'https://download.medpilot.cc/pilot/client-android/PilotClient-1.0.2.wgt',
      sha256: SHA_B,
      size: 500
    }
  })
  assert.equal(normalizeManifest(withWgt).wgt.version, '1.0.2')
  const broken = manifest({ wgt: { ...withWgt.wgt, sha256: '' } })
  const result = normalizeManifest(broken)
  assert.equal(result.wgt, null)
  assert.equal(result.version, '1.0.1')
})

test('normalizeManifest：带 BOM 的响应体也能解析', () => {
  const body = '\uFEFF' + JSON.stringify(manifest())
  assert.equal(normalizeManifest(body)?.version, '1.0.1')
})

test('compareVersionNames：按数字段比较，不按字典序', () => {
  assert.equal(compareVersionNames('1.0.10', '1.0.9'), 1)
  assert.equal(compareVersionNames('1.0.9', '1.0.10'), -1)
  assert.equal(compareVersionNames('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersionNames('1.0', '1.0.0'), 0)
  assert.equal(compareVersionNames('1.2', '1.10'), -1)
})

test('isNewerVersion：优先比 versionCode', () => {
  assert.equal(isNewerVersion(manifest({ versionCode: 101 }), { version: '1.0.9', versionCode: 99 }), true)
  assert.equal(isNewerVersion(manifest({ versionCode: 99 }), { version: '1.0.1', versionCode: 101 }), false)
  // 清单没有 versionCode 时退回版本名比较。
  assert.equal(isNewerVersion(manifest({ versionCode: 0, version: '1.0.2' }), { version: '1.0.1', versionCode: 0 }), true)
})

test('resolveUpdateTarget：壳落后时先装全量 APK', () => {
  const m = normalizeManifest(manifest({
    wgt: {
      version: '1.0.5',
      url: 'https://download.medpilot.cc/pilot/client-android/PilotClient-1.0.5.wgt',
      sha256: SHA_B,
      size: 500
    }
  }))
  const target = resolveUpdateTarget(m, { version: '1.0.0', versionCode: 100 })
  assert.equal(target.kind, 'apk')
  assert.equal(target.version, '1.0.1')
  assert.equal(target.sha256, SHA_A)
})

test('resolveUpdateTarget：壳已跟上时用增量 wgt', () => {
  const m = normalizeManifest(manifest({
    wgt: {
      version: '1.0.2',
      url: 'https://download.medpilot.cc/pilot/client-android/PilotClient-1.0.2.wgt',
      sha256: SHA_B,
      size: 500
    }
  }))
  const target = resolveUpdateTarget(m, { version: '1.0.1', versionCode: 101 })
  assert.equal(target.kind, 'wgt')
  assert.equal(target.version, '1.0.2')
  assert.equal(target.size, 500)
})

test('resolveUpdateTarget：已是最新返回 null', () => {
  const m = normalizeManifest(manifest())
  assert.equal(resolveUpdateTarget(m, { version: '1.0.1', versionCode: 101 }), null)
  const withOldWgt = normalizeManifest(manifest({
    wgt: {
      version: '1.0.0',
      url: 'https://download.medpilot.cc/pilot/client-android/PilotClient-1.0.0.wgt',
      sha256: SHA_B,
      size: 500
    }
  }))
  assert.equal(resolveUpdateTarget(withOldWgt, { version: '1.0.1', versionCode: 101 }), null)
})

test('currentAppInfo / autoCheckUpdate：非 App 环境安全降级', () => {
  const info = currentAppInfo()
  assert.equal(info.supported, false)
  assert.equal(info.version, '')
  // 没有 plus 时不应发请求，直接 resolve(null)。
  return autoCheckUpdate().then((result) => assert.equal(result, null))
})

test('pages.json：启动页是第一页，更新页已注册', () => {
  const pages = JSON.parse(readFileSync(resolve(ROOT, 'pages.json'), 'utf8'))
  assert.equal(pages.pages[0].path, 'pages/launch/index')
  assert.ok(pages.pages.some((page) => page.path === 'pages/update/index'))
  assert.ok(pages.pages.some((page) => page.path === 'pages/home/index'))
})

test('manifest.json：版本号是合法 semver，versionCode 是数字', () => {
  assert.match(manifestJson.versionName, /^\d+\.\d+\.\d+$/)
  assert.ok(Number.isInteger(Number(manifestJson.versionCode)) && Number(manifestJson.versionCode) > 0)
})
