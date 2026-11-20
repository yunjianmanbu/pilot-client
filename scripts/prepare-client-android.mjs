#!/usr/bin/env node
/**
 * 准备 Pilot Client（被控端，cc.medpilot.pilotclient）的 uni-app 离线打包工程。
 *
 * 为什么需要这个脚本：HBuilderX 只能「生成本地打包 App 资源」得到 www，真正出 APK 要靠
 * DCloud 离线 SDK 里的 HBuilder-Integrate-AS 工程。SDK 和工程产物都在不入库的 .build/ 下，
 * 而下面这些字段必须和 DCloud 后台登记的离线 appkey 严格对应，手改很容易漏一项：
 *
 *   1. build.gradle          namespace / applicationId → cc.medpilot.pilotclient
 *                            versionCode / versionName / minSdkVersion / targetSdkVersion
 *                            全部取自 mobile-client/manifest.json，不再手工同步
 *                            签名 → 环境变量注入的 keystore（模板自带的 test.jks 是公开示例证书，必须换掉）
 *   2. AndroidManifest.xml   dcloud_appkey → 申请的离线 appkey
 *                            补齐 manifest.json 里声明的权限
 *   3. assets/data/dcloud_control.xml   appid → __UNI__3780DD8（不是 Pilot Link 的 __UNI__71B4F08）
 *   4. assets/apps/<appid>/www          ← HBuilderX 生成的本地打包资源
 *   5. res/ 应用名 / 桌面图标 / 启动图   ← mobile-client/static（`npm run icons` 生成）
 *      strings.xml app_name、mipmap-<dpi>/ic_launcher.png、drawable/splash.9.png
 *      离线打包的图标与启动图只认原生 res/，改 www 里的 manifest.icons 不会生效
 *   dependencies 里补 zip4j：wgt 资源包热更靠 plus.runtime.install 解压，模板不自带
 *
 * DCloud 的校验规则是 appid + 包名 + 签名 SHA1 三者同时匹配（官方文档 AppDocs/usesdk/appkey），
 * 任一不符就只报一句「未配置AppKey或配置错误」，所以这四项必须一起改，改一半无法排查。
 * 本脚本使用的证书 SHA1：EC:96:CE:48:53:3B:34:3D:FE:FC:8E:E9:E7:B9:FC:E7:77:81:45:41
 *
 * 用法（在仓库根目录跑，路径全部由脚本自身位置推导）：
 *   node pilot/scripts/prepare-client-android.mjs
 *   node pilot/scripts/prepare-client-android.mjs --www <HBuilderX 资源目录>
 *   node pilot/scripts/prepare-client-android.mjs --force     # 丢弃目标工程，按 SDK 模板重新复制
 *
 * 退出码：0 = 工程就绪且自检通过；1 = 前置条件缺失或自检失败。
 * 打印 www 缺失只影响「能否立刻 assembleRelease」，因此不算失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_ID = '__UNI__3780DD8'
export const PACKAGE_NAME = 'cc.medpilot.pilotclient'
export const APP_KEY = 'aed30a6f925edf13dcbf492bc50df7bd'
export const CERT_SHA1 = 'EC:96:CE:48:53:3B:34:3D:FE:FC:8E:E9:E7:B9:FC:E7:77:81:45:41'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * 本脚本同时活在两种布局里：
 *   主仓库 pilot/scripts/            → 仓库根在上面两级，子项目在 pilot/mobile-client
 *   独立仓库 pilot-client/scripts/   → 仓库根就在上一级，子项目就是仓库根
 * 用「上一级有没有 manifest.json」判断：独立仓库的根目录里有，主仓库的 pilot/ 里没有。
 * 拆仓后如果不认布局，这里会多退一级，拼出 <repo>/pilot/mobile-client/... 这种不存在的路径，
 * CI 里表现为“缺少启动图标源文件”，而不是报告路径算错。
 */
const parentDir = path.resolve(scriptDir, '..')
const standalone = fs.existsSync(path.join(parentDir, 'manifest.json'))
export const REPO_ROOT = standalone ? parentDir : path.resolve(scriptDir, '..', '..')

/** 子项目目录：主仓库里是 pilot/mobile-client，独立仓库里就是仓库根。 */
export const APP_DIR = standalone ? parentDir : path.join(REPO_ROOT, 'pilot', 'mobile-client')

export const MANIFEST_PATH = path.join(APP_DIR, 'manifest.json')
export const BUILD_ROOT = path.join(REPO_ROOT, '.build')
export const TARGET_DIR = path.join(BUILD_ROOT, 'pilot-client-android')

const SIGNING_DEFS = `// Signing material stays outside the repo and is injected at build time:
//   PILOT_KEYSTORE        absolute path to the keystore
//   PILOT_STORE_PASSWORD  keystore password
//   PILOT_KEY_ALIAS       key alias (default: pilot)
//   PILOT_KEY_PASSWORD    key password (default: keystore password)
// DCloud 离线 appkey 校验的是 appid + 包名 + 证书 SHA1，换 keystore 等于换 appkey。
def pilotKeystore = System.getenv('PILOT_KEYSTORE') ?: 'C:/Users/lenovo/.pilot/android-keystore.jks'
def pilotStorePass = System.getenv('PILOT_STORE_PASSWORD')
def pilotKeyAlias = System.getenv('PILOT_KEY_ALIAS') ?: 'pilot'
def pilotKeyPass = System.getenv('PILOT_KEY_PASSWORD') ?: pilotStorePass

`

/** 把 build.gradle 改成本项目的：包名、版本、签名都对齐 manifest.json + 环境变量。 */
export function patchBuildGradle(source, cfg) {
  let out = String(source ?? '')
  out = out.replace(/namespace\s+'[^']*'/, `namespace '${cfg.packageName}'`)
  out = out.replace(/applicationId\s+"[^"]*"/, `applicationId "${cfg.packageName}"`)
  out = out.replace(/minSdkVersion\s+\d+/, `minSdkVersion ${cfg.minSdkVersion}`)
  out = out.replace(/targetSdkVersion\s+\d+/, `targetSdkVersion ${cfg.targetSdkVersion}`)
  out = out.replace(/versionCode\s+\d+/, `versionCode ${cfg.versionCode}`)
  out = out.replace(/versionName\s+"[^"]*"/, `versionName "${cfg.versionName}"`)
  if (cfg.buildTools) out = out.replace(/buildToolsVersion\s+'[^']*'/, `buildToolsVersion '${cfg.buildTools}'`)

  // 模板里的签名是 SDK 自带的 test.jks + 明文口令：公开示例证书，任何人都能签出同包名 APK。
  out = out.replace(/keyAlias\s+'[^']*'/, 'keyAlias pilotKeyAlias')
  out = out.replace(/keyPassword\s+'[^']*'/, 'keyPassword pilotKeyPass')
  out = out.replace(/storeFile file\([^)]*\)/, 'storeFile file(pilotKeystore)')
  out = out.replace(/storePassword\s+'[^']*'/, 'storePassword pilotStorePass')

  if (!out.includes('def pilotKeystore')) out = SIGNING_DEFS + out
  return out
}

/**
 * 把 manifest.json 里声明的权限 / uses-feature 合并进 AndroidManifest.xml。
 * 已经存在的名字不重复插入，因此可反复执行。
 */
export function mergeManifestEntries(xml, entries) {
  const source = String(xml ?? '')
  const present = new Set([...source.matchAll(/android:name="([^"]+)"/g)].map((m) => m[1]))
  const additions = []
  for (const entry of entries ?? []) {
    const raw = String(entry).trim()
    const name = /android:name="([^"]+)"/.exec(raw)?.[1]
    if (!name || present.has(name)) continue
    present.add(name)
    additions.push(raw.replace(/\s*\/>$/, '/>'))
  }
  if (!additions.length) return { xml: source, added: [] }

  const anchor = /<manifest[^>]*>\s*\n/.exec(source)
  if (!anchor) throw new Error('AndroidManifest.xml 里找不到 <manifest> 起始标签')
  const at = anchor.index + anchor[0].length
  const block = `${additions.map((line) => `    ${line}`).join('\n')}\n\n`
  return { xml: source.slice(0, at) + block + source.slice(at), added: additions }
}

/** 写入 dcloud_appkey，并补齐权限。 */
export function patchAndroidManifest(xml, { appKey, permissions }) {
  let out = String(xml ?? '')
  out = out.replace(/(android:name="dcloud_appkey"\s+android:value=")[^"]*"/, `$1${appKey}"`)
  return mergeManifestEntries(out, permissions)
}

/** dcloud_control.xml 决定的 appid 必须和 appkey 申请时填的一致。 */
export function patchControlXml(xml, { appId, appVer }) {
  const source = String(xml ?? '')
  const entry = `<app appid="${appId}" appver="${appVer}"/>`
  if (/<app\s[^>]*\/>/.test(source)) return source.replace(/<app\s[^>]*\/>/, entry)
  return source.replace(/<apps>\s*<\/apps>/, `<apps>\n    ${entry}\n</apps>`)
}

/** 应用商店/桌面图标下显示的名字；模板默认是 HBuilder-SimpleDemo-AS。 */
export const APP_NAME = 'Pilot Client'

/** 品牌资源来源（`npm run icons` 生成）。 */
export const BRAND_DIR = path.join(APP_DIR, 'static')

/** Android 各 dpi 的启动图标尺寸，与 mobile-client/scripts/gen-icons.mjs 的 SIZES 一致。 */
export const LAUNCHER_ICONS = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
]

/** strings.xml 里的 app_name：装到手机上桌面显示的就是它。 */
export function patchAppName(xml, name = APP_NAME) {
  const source = String(xml ?? '')
  if (/<string name="app_name">[^<]*<\/string>/.test(source)) {
    return source.replace(/(<string name="app_name">)[^<]*(<\/string>)/, `$1${name}$2`)
  }
  return source.replace(/<resources>/, `<resources>\n    <string name="app_name">${name}</string>`)
}

/** 桌面图标指向 mipmap/ic_launcher（模板里是 @drawable/icon，也就是 DCloud 默认图标）。 */
export function patchLauncherIcon(xml) {
  return String(xml ?? '').replace(/android:icon="@(?:drawable|mipmap)\/[^"]*"/, 'android:icon="@mipmap/ic_launcher"')
}

/**
 * 把白底黑 P 的品牌资源写进 res/。
 *
 * 离线打包的图标和启动图完全来自原生工程 res/，HBuilderX 生成的 www 里的
 * manifest.icons 只对云打包生效——这正是「改了 static/icons 但 APK 图标没变」的原因。
 *
 * - mipmap-<dpi>/ic_launcher.png  ← static/icons/<size>.png（桌面图标）
 * - drawable/icon.png             ← static/icons/192.png（DCloud 运行时内部引用兜底）
 * - drawable/splash.9.png         ← static/splash.9.png（启动图；必须删掉模板的 splash.png，
 *                                   同一个 drawable/splash 出现两次 aapt2 会直接报错）
 */
export function installBranding(resDir, sourceDir = BRAND_DIR) {
  const written = []
  const valuesDir = path.join(resDir, 'values')
  const stringsPath = path.join(valuesDir, 'strings.xml')
  fs.mkdirSync(valuesDir, { recursive: true })
  const strings = fs.existsSync(stringsPath) ? fs.readFileSync(stringsPath, 'utf8') : '<resources>\n</resources>\n'
  fs.writeFileSync(stringsPath, patchAppName(strings))
  written.push(stringsPath)

  for (const [dpi, size] of LAUNCHER_ICONS) {
    const src = path.join(sourceDir, 'icons', `${size}.png`)
    if (!fs.existsSync(src)) throw new Error(`缺少启动图标源文件 ${src}（先跑 npm run icons）`)
    const dir = path.join(resDir, `mipmap-${dpi}`)
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, 'ic_launcher.png')
    fs.copyFileSync(src, dest)
    written.push(dest)
  }

  const drawableDir = path.join(resDir, 'drawable')
  fs.mkdirSync(drawableDir, { recursive: true })
  const legacyIcon = path.join(drawableDir, 'icon.png')
  fs.copyFileSync(path.join(sourceDir, 'icons', '192.png'), legacyIcon)
  written.push(legacyIcon)

  const splashSrc = path.join(sourceDir, 'splash.9.png')
  if (!fs.existsSync(splashSrc)) throw new Error(`缺少启动图 ${splashSrc}（先跑 npm run icons）`)
  const staleSplash = path.join(drawableDir, 'splash.png')
  if (fs.existsSync(staleSplash)) fs.rmSync(staleSplash, { force: true })
  const splashDest = path.join(drawableDir, 'splash.9.png')
  fs.copyFileSync(splashSrc, splashDest)
  written.push(splashDest)

  return written
}

/**
 * wgt 资源包安装靠 plus.runtime.install 解压，运行时依赖 zip4j；
 * DCloud 离线 SDK 模板的 dependencies 里没有它，漏了表现为「APK 能装、热更失败」。
 */
export function ensureZip4jDependency(text) {
  const source = String(text ?? '')
  if (/zip4j/i.test(source)) return source
  return source.replace(
    /dependencies\s*\{/,
    "dependencies {\n    // wgt 资源包热更（plus.runtime.install 解压）需要 zip4j，离线 SDK 模板不自带。\n    implementation 'net.lingala.zip4j:zip4j:2.11.5'"
  )
}


function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** 读 PNG 头部宽高（不引第三方图像库）。 */
export function readPngSize(file) {
  const head = fs.readFileSync(file).subarray(0, 24)
  if (head.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}

function pickSdkTemplate() {
  if (!fs.existsSync(BUILD_ROOT)) return null
  const candidates = fs
    .readdirSync(BUILD_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('Android-SDK@'))
    .map((d) => d.name)
    .sort()
  for (const name of candidates.reverse()) {
    const template = path.join(BUILD_ROOT, name, 'HBuilder-Integrate-AS')
    if (fs.existsSync(path.join(template, 'simpleDemo', 'build.gradle'))) return { root: path.join(BUILD_ROOT, name), template }
  }
  return null
}

function copyProject(template, target, force) {
  if (force) fs.rmSync(target, { recursive: true, force: true })
  if (fs.existsSync(target)) return false
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(template, target, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src)
      if (base === 'build' || base === '.gradle' || base === '.idea') return false
      if (base.endsWith('.iml')) return false
      return true
    },
  })
  return true
}

/** HBuilderX「生成本地打包 App 资源」的几种可能输出位置。 */
function detectWww() {
  const uni = path.join(APP_DIR, 'unpackage')
  return [
    path.join(uni, 'resources', APP_ID, 'www'),
    path.join(uni, 'release', 'app-plus', 'www'),
    path.join(uni, 'debug', 'app-plus', 'www'),
  ]
}

function installWww(appDir, explicit) {
  const sources = explicit ? [path.resolve(REPO_ROOT, explicit)] : detectWww()
  const found = sources.find((dir) => fs.existsSync(path.join(dir, 'manifest.json')))
  const dest = path.join(appDir, 'www')
  if (!found) return { installed: false, hint: sources[0] }
  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(found, dest, { recursive: true })
  return { installed: true, from: found, dest }
}

function main() {
  const argv = process.argv.slice(2)
  const force = argv.includes('--force')
  const wwwIndex = argv.findIndex((a) => a === '--www')
  const explicitWww = wwwIndex >= 0 ? argv[wwwIndex + 1] : null

  if (!fs.existsSync(MANIFEST_PATH)) fail(`找不到 ${MANIFEST_PATH}`)
  const manifest = readJson(MANIFEST_PATH)
  const android = manifest['app-plus']?.distribute?.android ?? {}
  if (manifest.appid !== APP_ID) fail(`manifest.json 的 appid 是 ${manifest.appid}，应为 ${APP_ID}`)
  if (android.packagename !== PACKAGE_NAME)
    fail(`manifest.json 的 packagename 是 ${android.packagename}，应为 ${PACKAGE_NAME}`)

  const sdk = pickSdkTemplate()
  if (!sdk) fail('.build/ 下找不到 Android-SDK@*/HBuilder-Integrate-AS，先放好 DCloud 离线 SDK')

  const copied = copyProject(sdk.template, TARGET_DIR, force)
  const projectDir = path.join(TARGET_DIR, 'simpleDemo')
  const cfg = {
    packageName: PACKAGE_NAME,
    versionCode: manifest.versionCode,
    versionName: manifest.versionName,
    minSdkVersion: android.minSdkVersion ?? 24,
    targetSdkVersion: android.targetSdkVersion ?? 35,
    buildTools: process.env.PILOT_BUILD_TOOLS || null,
  }

  // 1. build.gradle
  const gradlePath = path.join(projectDir, 'build.gradle')
  let gradlePatched = patchBuildGradle(fs.readFileSync(gradlePath, 'utf8'), cfg)
  gradlePatched = ensureZip4jDependency(gradlePatched)
  fs.writeFileSync(gradlePath, gradlePatched)

  // 2. AndroidManifest.xml
  const manifestXmlPath = path.join(projectDir, 'src', 'main', 'AndroidManifest.xml')
  const patchedManifest = patchAndroidManifest(fs.readFileSync(manifestXmlPath, 'utf8'), {
    appKey: APP_KEY,
    permissions: android.permissions ?? [],
  })
  fs.writeFileSync(manifestXmlPath, patchLauncherIcon(patchedManifest.xml))

  // 3. dcloud_control.xml
  const controlPath = path.join(projectDir, 'src', 'main', 'assets', 'data', 'dcloud_control.xml')
  fs.writeFileSync(controlPath, patchControlXml(fs.readFileSync(controlPath, 'utf8'), {
    appId: APP_ID,
    appVer: manifest.versionName,
  }))

  // 4. www
  const appsDir = path.join(projectDir, 'src', 'main', 'assets', 'apps')
  const appDir = path.join(appsDir, APP_ID)
  fs.mkdirSync(appDir, { recursive: true })
  for (const name of fs.readdirSync(appsDir)) {
    if (name !== APP_ID) fs.rmSync(path.join(appsDir, name), { recursive: true, force: true })
  }
  const www = installWww(appDir, explicitWww)

  // 5. 应用名 / 桌面图标 / 启动图（离线打包只认原生工程 res/，不是 www 里的 manifest）
  const resDir = path.join(projectDir, 'src', 'main', 'res')
  const branding = installBranding(resDir)

  // 自检：重新读盘，逐条确认关键字段
  const checks = []
  const gradleText = fs.readFileSync(gradlePath, 'utf8')
  const manifestText = fs.readFileSync(manifestXmlPath, 'utf8')
  const controlText = fs.readFileSync(controlPath, 'utf8')
  const stringsText = fs.readFileSync(path.join(resDir, 'values', 'strings.xml'), 'utf8')
  const expect = (ok, label, detail) => checks.push({ ok, label, detail })

  const iconPath = path.join(resDir, 'mipmap-xxxhdpi', 'ic_launcher.png')
  const iconSize = fs.existsSync(iconPath) ? readPngSize(iconPath) : null
  const splashPath = path.join(resDir, 'drawable', 'splash.9.png')

  expect(gradleText.includes(`namespace '${PACKAGE_NAME}'`), 'namespace', PACKAGE_NAME)
  expect(gradleText.includes(`applicationId "${PACKAGE_NAME}"`), 'applicationId', PACKAGE_NAME)
  expect(gradleText.includes(`versionCode ${cfg.versionCode}`) && gradleText.includes(`versionName "${cfg.versionName}"`),
    '版本号', `${cfg.versionCode} / ${cfg.versionName}`)
  expect(gradleText.includes(`minSdkVersion ${cfg.minSdkVersion}`), 'minSdkVersion', String(cfg.minSdkVersion))
  expect(gradleText.includes('storeFile file(pilotKeystore)') && !gradleText.includes('test.jks'),
    '签名证书', `环境变量注入，SHA1 ${CERT_SHA1}`)
  expect(manifestText.includes(`android:value="${APP_KEY}"`), 'dcloud_appkey', APP_KEY)
  expect(controlText.includes(`appid="${APP_ID}"`), 'dcloud_control appid', APP_ID)
  expect(www.installed, 'www 资源', www.installed ? www.dest : `缺失（需 HBuilderX 生成 ${www.hint}）`)
  expect(stringsText.includes(`<string name="app_name">${APP_NAME}</string>`), '应用名 app_name', APP_NAME)
  expect(manifestText.includes('android:icon="@mipmap/ic_launcher"'), '桌面图标引用', '@mipmap/ic_launcher')
  expect(iconSize && iconSize.width === 192 && iconSize.height === 192, '图标 mipmap-xxxhdpi',
    iconSize ? `${iconSize.width}×${iconSize.height}，${LAUNCHER_ICONS.length} 档 dpi 已写入` : '缺失')
  expect(fs.existsSync(splashPath) && !fs.existsSync(path.join(resDir, 'drawable', 'splash.png')), '启动图 splash.9',
    fs.existsSync(splashPath) ? `${path.relative(projectDir, splashPath)}（模板 splash.png 已移除）` : '缺失')
  expect(/zip4j/i.test(gradleText), 'wgt 依赖 zip4j', 'plus.runtime.install 解压资源包用')

  process.stdout.write(`\nPilot Client 离线打包工程：${path.relative(REPO_ROOT, TARGET_DIR)}\n`)
  process.stdout.write(`  来源模板  ${path.relative(REPO_ROOT, sdk.template)}${copied ? '（新复制）' : '（已存在，仅改配置）'}\n`)
  if (patchedManifest.added.length) {
    process.stdout.write(`  补权限    ${patchedManifest.added.length} 条\n`)
  }
  process.stdout.write('\n')
  for (const item of checks) {
    process.stdout.write(`  ${item.ok ? '✅' : '⚠️ '} ${item.label.padEnd(20)} ${item.detail}\n`)
  }

  const hardFails = checks.filter((c) => !c.ok && c.label !== 'www 资源')
  if (hardFails.length) {
    process.stderr.write(`\n自检失败 ${hardFails.length} 项，工程不可用。\n`)
    process.exit(1)
  }

  process.stdout.write('\n')
  if (www.installed) {
    process.stdout.write('可以出包了：JAVA_HOME + ANDROID_HOME + PILOT_KEYSTORE/PILOT_STORE_PASSWORD 就绪后，\n')
    process.stdout.write(`  cd ${path.relative(REPO_ROOT, TARGET_DIR)} && ./gradlew assembleRelease\n`)
  } else {
    process.stdout.write('还差 www：HBuilderX 打开 pilot/mobile-client → 发行 → 生成本地打包 App 资源，\n')
    process.stdout.write('然后重跑本脚本即可（会自动复制 www 并清掉别的 appid 目录）。\n')
  }
}

function fail(message) {
  process.stderr.write(`✗ ${message}\n`)
  process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main()
}
