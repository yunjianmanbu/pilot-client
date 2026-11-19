import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 离线打包工程里的品牌与热更依赖。
 *
 * 这些函数在 `pilot/scripts/prepare-client-android.mjs` 里，独立仓库（pilot-client）
 * 检出时读不到，所以缺失时只 skip，不判失败。
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let branding = null
try {
  branding = await import('../scripts/prepare-client-android.mjs')
} catch {
  branding = null
}

const skip = branding ? false : '需要仓库根的 pilot/scripts/prepare-client-android.mjs'

test('strings.xml：应用名改成 Pilot Client', { skip }, () => {
  assert.equal(
    branding.patchAppName('<resources>\n    <string name="app_name">HBuilder-SimpleDemo-AS</string>\n</resources>'),
    '<resources>\n    <string name="app_name">Pilot Client</string>\n</resources>'
  )
  // 模板缺这一项时补进去。
  assert.match(branding.patchAppName('<resources></resources>'), /<string name="app_name">Pilot Client<\/string>/)
})

test('AndroidManifest：桌面图标从模板的 @drawable/icon 换成 @mipmap/ic_launcher', { skip }, () => {
  const source = '<application android:icon="@drawable/icon" android:label="@string/app_name">'
  assert.match(branding.patchLauncherIcon(source), /android:icon="@mipmap\/ic_launcher"/)
  // 已经是 mipmap 时保持原样，重复执行不产生漂移。
  assert.equal(branding.patchLauncherIcon(branding.patchLauncherIcon(source)), branding.patchLauncherIcon(source))
})

test('build.gradle：补 zip4j（wgt 热更依赖），已有则不重复加', { skip }, () => {
  const gradle = "dependencies {\n    implementation fileTree(dir: 'libs')\n}"
  const patched = branding.ensureZip4jDependency(gradle)
  assert.match(patched, /implementation 'net\.lingala\.zip4j:zip4j:2\.11\.5'/)
  assert.equal(branding.ensureZip4jDependency(patched), patched, '重复执行不应再加一行')
})

test('res/：写入 5 档 ic_launcher、drawable/icon 与 splash.9，并删掉模板 splash.png', { skip }, () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'pilot-client-res-'))
  try {
    const res = resolve(dir, 'res')
    mkdirSync(resolve(res, 'drawable'), { recursive: true })
    mkdirSync(resolve(res, 'values'), { recursive: true })
    writeFileSync(resolve(res, 'values', 'strings.xml'), '<resources>\n</resources>\n')
    // 模板留下的普通 splash.png：与 splash.9 同名（都叫 splash）会让 aapt2 报重复资源。
    writeFileSync(resolve(res, 'drawable', 'splash.png'), 'stale')

    const written = branding.installBranding(res)

    for (const [dpi, size] of branding.LAUNCHER_ICONS) {
      const file = resolve(res, `mipmap-${dpi}`, 'ic_launcher.png')
      assert.ok(written.includes(file) && existsSync(file), `缺少 mipmap-${dpi}`)
      assert.deepEqual(branding.readPngSize(file), { width: size, height: size }, `${dpi} 尺寸不对`)
    }
    assert.equal(existsSync(resolve(res, 'drawable', 'splash.png')), false, '模板 splash.png 必须删掉')
    const splash = branding.readPngSize(resolve(res, 'drawable', 'splash.9.png'))
    assert.equal(splash.width, 386)
    assert.match(readFileSync(resolve(res, 'values', 'strings.xml'), 'utf8'), /Pilot Client/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('品牌资源：仓库里已生成图标与启动图（npm run icons）', { skip }, () => {
  for (const [, size] of branding.LAUNCHER_ICONS) {
    const file = resolve(ROOT, 'static', 'icons', `${size}.png`)
    assert.ok(existsSync(file), `缺少 ${file}`)
    assert.deepEqual(branding.readPngSize(file), { width: size, height: size })
  }
  assert.ok(existsSync(resolve(ROOT, 'static', 'splash.9.png')))
})
