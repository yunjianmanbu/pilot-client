/**
 * App 在线更新（增量 wgt + 全量 APK）。
 *
 * 下载站为被控端单独提供一份清单：
 *   https://download.medpilot.cc/pilot/client-android/latest.json
 *
 * 清单顶层是**全量安装包**，`wgt` 是可选的前端资源包（增量更新）。选择规则与
 * Pilot Link 一致，叫「原生优先」：
 *
 * - 壳（安装包）比清单顶层旧 → 必须先装全量 APK。原生能力（新权限、前台服务、
 *   device owner 之类的改动）只能随 APK 下发，先装 wgt 会把运行版本号顶到全量包
 *   的版本上，用户之后再也收不到原生修复。
 * - 壳已经跟上全量包 → 用 wgt 做小步更新（几 MB 对 30MB）。
 *
 * 只有 App（plus 运行时）能更新；H5 预览里调用会直接返回不支持，页面只显示当前版本。
 */

import { createSha256 } from './sha256.js'

export const MANIFEST_URL = 'https://download.medpilot.cc/pilot/client-android/latest.json'
export const DOWNLOAD_PAGE_URL = 'https://download.medpilot.cc/pilot/client-android/PilotClient-latest.apk'
export const DOWNLOAD_HOST = 'download.medpilot.cc'

/** 启动时静默检查的节流窗口：6 小时内不重复请求清单。 */
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

const STORAGE_WGT_VERSION = 'pilot-client.update-wgt.v1'
const STORAGE_CHECKED_AT = 'pilot-client.update-checked-at.v1'

/** 目标版本号比较：按数字段比，"1.0.10" > "1.0.9"。 */
export function compareVersionNames(a, b) {
  const split = (value) =>
    String(value || '')
      .split(/[^0-9]+/)
      .filter(Boolean)
      .map(Number)
  const left = split(a)
  const right = split(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0)
    if (difference) return difference > 0 ? 1 : -1
  }
  return 0
}

/** 全量安装包是否比当前版本新。 */
export function isNewerVersion(manifest, current) {
  if (!manifest || !current) return false
  if (manifest.versionCode > 0 && current.versionCode > 0) {
    return manifest.versionCode > current.versionCode
  }
  return compareVersionNames(manifest.version, current.version) > 0
}

/**
 * 选择这次真正要装的产物（wgt 优先还是 APK 优先，见文件头）。
 * 返回 null 表示已经是最新，不需要下载。
 */
export function resolveUpdateTarget(manifest, current) {
  if (!manifest || !current) return null
  if (isNewerVersion(manifest, current)) {
    return {
      kind: 'apk',
      version: manifest.version,
      url: manifest.url,
      sha256: manifest.sha256,
      size: manifest.size
    }
  }
  const wgt = manifest.wgt
  if (wgt && compareVersionNames(wgt.version, current.version) > 0) {
    return {
      kind: 'wgt',
      version: wgt.version,
      url: wgt.url,
      sha256: wgt.sha256,
      size: wgt.size
    }
  }
  return null
}

/** 校验下载地址：必须 https、主机名恰好是下载站、端口只能是默认 443。 */
export function normalizeDownloadUrl(value) {
  if (typeof value !== 'string') return ''
  const match = /^https:\/\/([^/?#:]+)(?::(\d+))?([/?#]|$)/i.exec(value)
  if (!match) return ''
  if (match[1].toLowerCase() !== DOWNLOAD_HOST) return ''
  if (match[2] && match[2] !== '443') return ''
  return value
}

function normalizeSha(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : ''
}

function normalizeSize(value) {
  const size = Number(value)
  return Number.isFinite(size) && size > 0 ? Math.floor(size) : 0
}

function normalizeWgt(value) {
  if (!value || typeof value !== 'object') return null
  const version = typeof value.version === 'string' ? value.version.trim() : ''
  const url = normalizeDownloadUrl(value.url)
  const sha256 = normalizeSha(value.sha256)
  const size = normalizeSize(value.size)
  // 资源包会被直接解压进 App 私有目录，必须带 sha256，不能靠大小兜底。
  if (!version || !url || !sha256 || !size) return null
  return { version, url, sha256, size }
}

/**
 * 校验并规整下载站返回的清单，任何不合规字段都让整份清单失效。
 * 传入字符串时先剥 BOM 再 JSON.parse（个别中间层会加 BOM）。
 */
export function normalizeManifest(value) {
  let data = value
  if (typeof data === 'string') {
    try {
      const text = data.charCodeAt(0) === 0xfeff ? data.slice(1) : data
      data = JSON.parse(text.trim())
    } catch {
      return null
    }
  }
  if (!data || typeof data !== 'object') return null
  const version = typeof data.version === 'string' ? data.version.trim() : ''
  const url = normalizeDownloadUrl(data.url)
  const sha256 = normalizeSha(data.sha256)
  const size = normalizeSize(data.size)
  if (!version || !url || !sha256 || !size) return null
  const versionCode = Number(data.versionCode)
  return {
    version,
    versionCode: Number.isFinite(versionCode) && versionCode > 0 ? Math.floor(versionCode) : 0,
    url,
    sha256,
    size,
    notes: typeof data.notes === 'string' ? data.notes : '',
    force: data.force === true,
    // wgt 坏掉只丢弃该字段，不影响同一份清单里的全量包。
    wgt: normalizeWgt(data.wgt)
  }
}

function hasPlus() {
  try {
    return typeof plus !== 'undefined' && !!plus?.runtime
  } catch {
    return false
  }
}

function hasNativeDownloader() {
  try {
    return typeof plus !== 'undefined' && !!plus?.downloader && typeof plus.downloader.createDownload === 'function'
  } catch {
    return false
  }
}

function storageGet(key) {
  try {
    return uni.getStorageSync(key)
  } catch {
    return ''
  }
}

function storageSet(key, value) {
  try {
    uni.setStorageSync(key, value)
  } catch {
    // 存储不可用时只是失去节流与兜底，不影响更新流程。
  }
}

/** 通过 wgt 装上的版本号：个别机型 plus.runtime.version 不刷新，用本地记录兜底。 */
export function loadAppliedWgtVersion() {
  const value = storageGet(STORAGE_WGT_VERSION)
  return typeof value === 'string' ? value : ''
}

export function saveAppliedWgtVersion(version) {
  storageSet(STORAGE_WGT_VERSION, String(version || ''))
}

export function loadUpdateCheckAt() {
  const value = Number(storageGet(STORAGE_CHECKED_AT))
  return Number.isFinite(value) ? value : 0
}

export function saveUpdateCheckAt(at) {
  storageSet(STORAGE_CHECKED_AT, String(at || Date.now()))
}

/**
 * 当前运行版本。
 *
 * version 取 plus.runtime.version（装过 wgt 后是资源包版本），壳版本取
 * plus.runtime.getProperty 的 version——它读的是安装包本身，不会随 wgt 变。
 */
export function currentAppInfo() {
  const fallback = { version: '', versionCode: 0, shellVersion: '', supported: false }
  if (!hasPlus()) return fallback
  let version = ''
  let versionCode = 0
  try {
    version = String(plus.runtime.version || '')
  } catch {
    version = ''
  }
  let info = null
  try {
    info = plus.runtime.getProperty?.(plus.runtime.appid) || null
  } catch {
    info = null
  }
  const shellVersion = info?.version ? String(info.version) : ''
  const code = Number(info?.versionCode)
  if (Number.isFinite(code) && code > 0) versionCode = Math.floor(code)
  const applied = loadAppliedWgtVersion()
  // 装了 wgt 但运行时没刷新版本号时，用记录里的版本，避免反复提示同一个更新。
  if (applied && compareVersionNames(applied, version) > 0) version = applied
  return {
    version,
    versionCode,
    shellVersion,
    supported: !!version
  }
}

/** 当前 App 是否可能在运行时刷新版本号（决定是否需要兜底记录）。 */
export function supportsWgtInstall() {
  try {
    return hasPlus() && typeof plus.runtime.install === 'function'
  } catch {
    return false
  }
}

/** 请求清单；网络或格式问题统一返回 null，调用方只关心「有没有新版本」。 */
export function fetchManifest() {
  return new Promise((resolve) => {
    try {
      uni.request({
        url: MANIFEST_URL,
        method: 'GET',
        // 清单必须拿新的，命中缓存会让用户看不到已发布的版本。
        timeout: 15000,
        success: (response) => {
          if (response?.statusCode && response.statusCode !== 200) {
            resolve(null)
            return
          }
          resolve(normalizeManifest(response?.data))
        },
        fail: () => resolve(null)
      })
    } catch {
      resolve(null)
    }
  })
}

/** 最近一次检查的结果，首页据此显示「可更新 vX」角标。 */
export const updateNotice = { target: null, checkedAt: 0 }

/**
 * 检查更新。返回 { manifest, target, current }：
 * - target 为 null 表示已是最新；
 * - manifest 为 null 表示这次没拿到清单（离线 / 清单不合法）。
 */
export async function checkForUpdate() {
  const current = currentAppInfo()
  const manifest = await fetchManifest()
  saveUpdateCheckAt(Date.now())
  if (!manifest) return { manifest: null, target: null, current }
  const target = resolveUpdateTarget(manifest, current)
  updateNotice.target = target
  updateNotice.checkedAt = Date.now()
  return { manifest, target, current }
}

/** 启动时静默检查：6 小时内只查一次，没有新版本就不打扰用户。 */
export async function autoCheckUpdate() {
  if (!hasPlus()) return null
  if (Date.now() - loadUpdateCheckAt() < AUTO_CHECK_INTERVAL_MS) return null
  const result = await checkForUpdate()
  return result.target || null
}

/** 下载状态：页面用 reactive 共享同一份，避免首页和更新页各显示一套。 */
export const downloadState = {
  status: 'idle', // idle | downloading | verifying | ready | installing | error
  kind: '',
  version: '',
  progress: 0,
  received: 0,
  total: 0,
  error: '',
  path: ''
}

let activeTask = null
let pendingTarget = null

/** 下载中没有字节增长超过这个时长就判定停滞，避免界面永远停在某个百分比。 */
const STALL_TIMEOUT_MS = 60 * 1000
/** 校验分块大小：HTML5+ 桥接一次传太大的 ArrayBuffer 可能不回调。 */
const VERIFY_CHUNK_SIZE = 512 * 1024
/** 校验整体超时：纯 JS 摘要按大小给预算，小包 20s、大包最多 3 分钟。 */
const VERIFY_TIMEOUT_MIN_MS = 20000
const VERIFY_TIMEOUT_MAX_MS = 180000
/** 每 MB 允许的校验时间（手机端纯 JS SHA-256 约 1~2s/MB，留足余量）。 */
const VERIFY_TIMEOUT_PER_MB_MS = 4000
/** 本机桥接读文件不可用的记录键（按壳区分，换壳后重试哈希）。 */
const HASH_UNSUPPORTED_KEY = 'pilot-client.update-hash-unsupported.v1'

function resetState(patch) {
  Object.assign(downloadState, {
    status: 'idle',
    kind: '',
    version: '',
    progress: 0,
    received: 0,
    total: 0,
    error: '',
    path: ''
  }, patch || {})
}

/**
 * 下载中的进度百分比：下载阶段最多显示 99，避免「100% 却还在装」的错觉；
 * 下载结束由调用方显式置 100。
 */
export function computeDownloadProgress(received, total) {
  const bytes = Number(received) || 0
  const size = Number(total) || 0
  if (!(size > 0)) return 0
  if (bytes >= size) return 99
  return Math.max(0, Math.min(99, Math.round((bytes * 100) / size)))
}

function downloadPathFor(target) {
  // plus.downloader 只允许写到 _downloads/、_doc/ 或 _documents/ 下；
  // _doc 是 App 私有目录，不依赖存储权限。
  const name = target.kind === 'wgt' ? `pilot-client-${target.version}.wgt` : `pilot-client-${target.version}.apk`
  return `_doc/${name}`
}

function removeLocalFile(path) {
  // 重新下载前清掉同名残留，避免半个文件导致校验失败。
  return new Promise((resolve) => {
    try {
      plus.io.resolveLocalFileSystemURL(
        path,
        (entry) => entry.remove(() => resolve(), () => resolve()),
        () => resolve()
      )
    } catch {
      resolve()
    }
  })
}

/** 取文件对象（不读内容），用于读大小与分块摘要。 */
function resolveFileObject(path) {
  return new Promise((resolve, reject) => {
    try {
      plus.io.resolveLocalFileSystemURL(
        path,
        (entry) => {
          entry.file(
            (file) => resolve(file),
            () => reject(new Error('读取更新包失败'))
          )
        },
        () => reject(new Error('读取更新包失败'))
      )
    } catch {
      reject(new Error('读取更新包失败'))
    }
  })
}

function fileSizeOf(path) {
  return resolveFileObject(path).then((file) => Number(file?.size) || 0)
}

/** 读取一段文件，返回 Uint8Array。 */
function readFileSlice(file, start, end) {
  return new Promise((resolve, reject) => {
    let target = file
    try {
      if (typeof file.slice === 'function') target = file.slice(start, end)
    } catch {
      target = file
    }
    const reader = new plus.io.FileReader()
    reader.onload = (event) => {
      const result = event?.target?.result
      if (!result) {
        reject(new Error('读取更新包失败'))
        return
      }
      resolve(new Uint8Array(result))
    }
    reader.onerror = () => reject(new Error('读取更新包失败'))
    reader.readAsArrayBuffer(target)
  })
}

/**
 * 分块读取并增量计算 SHA-256。
 *
 * 不整文件 readAsArrayBuffer：HTML5+ 桥接层一次读取几分之一 MB 以上时可能
 * 一直不回调，界面就永远停在「正在校验」。同仓库 pilot/pilot-link 的更新模块里
 * 已经因为这个问题改成同样的分块写法。
 */
async function sha256File(path) {
  const file = await resolveFileObject(path)
  const size = Number(file?.size) || 0
  const hasher = createSha256()
  let offset = 0
  while (offset < size) {
    const end = Math.min(offset + VERIFY_CHUNK_SIZE, size)
    hasher.update(await readFileSlice(file, offset, end))
    offset = end
    // 每块让出一次事件循环，避免长时间占住 JS 线程导致界面卡住。
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return hasher.digest()
}

/**
 * 校验预算：wgt（几百 KB）给 20s，30MB 全量包给到上限 3 分钟。
 * 超时只有「大小完全一致」时才退回大小校验，否则直接报错。
 */
export function verifyTimeoutFor(size) {
  const bytes = Number(size) || 0
  const scaled = Math.ceil((bytes / (1024 * 1024)) * VERIFY_TIMEOUT_PER_MB_MS)
  return Math.max(VERIFY_TIMEOUT_MIN_MS, Math.min(VERIFY_TIMEOUT_MAX_MS, scaled))
}

function withTimeout(promise, timeout, message) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(message))
    }, timeout)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function hashUnsupported() {
  try {
    return uni.getStorageSync(HASH_UNSUPPORTED_KEY) === '1'
  } catch {
    return false
  }
}

function markHashUnsupported() {
  try {
    uni.setStorageSync(HASH_UNSUPPORTED_KEY, '1')
  } catch {
    // 记不住只是下次再等一次超时，不影响更新流程。
  }
}

/**
 * 校验下载到的更新包，返回摘要（退回大小校验时返回空串）。
 *
 * 顺序与 pilot/pilot-link 一致：先比大小（便宜且能抓住截断），再算哈希；
 * 只有「读文件接口整体超时 + 大小完全等于清单」这一种情况才退回大小校验，
 * 并记住本机桥接不可用，后续更新不再空等。
 */
async function verifyDownload(path, target) {
  let actualSize = 0
  try {
    actualSize = await fileSizeOf(path)
  } catch {
    actualSize = 0
  }
  if (actualSize > 0 && actualSize !== target.size) throw new Error('更新包不完整，请重新下载')
  const sizeMatches = actualSize > 0 && actualSize === target.size
  if (hashUnsupported()) {
    if (!sizeMatches) throw new Error('更新包校验失败，请重新下载')
    return ''
  }
  try {
    return await withTimeout(sha256File(path), verifyTimeoutFor(target.size), '校验更新包超时')
  } catch (error) {
    if (!sizeMatches) throw error
    markHashUnsupported()
    return ''
  }
}

async function startNativeDownload(target) {
  // 先清掉同名残留：半截文件会让大小/哈希校验直接失败，用户看到的是「下完了装不上」。
  await removeLocalFile(downloadPathFor(target))
  return new Promise((resolve, reject) => {
    const path = downloadPathFor(target)
    let task
    let finished = false
    let lastActivityAt = Date.now()
    let lastReceived = -1
    let watchdog = null

    const stopWatchdog = () => {
      if (watchdog) {
        clearInterval(watchdog)
        watchdog = null
      }
    }
    const settle = (fn, value) => {
      if (finished) return
      finished = true
      stopWatchdog()
      activeTask = null
      fn(value)
    }
    const fail = (message) => settle(reject, new Error(message))
    const markDone = (download) => {
      // 下载完成立刻把进度推到 100，后面是校验阶段：否则界面会停在 99% 一动不动。
      Object.assign(downloadState, {
        status: 'verifying',
        progress: 100,
        received: Number(download?.totalSize) || target.size,
        total: Number(download?.totalSize) || target.size
      })
    }

    try {
      task = plus.downloader.createDownload(
        target.url,
        // timeout 按秒计；retry 让弱网下的抖动不会直接失败。
        { filename: path, timeout: 120, retry: 3, retryInterval: 5 },
        (download, status) => {
          const code = Number(status)
          if (code !== 200) {
            fail(code ? `下载失败（${code}），请重试` : '下载失败，请检查网络后重试')
            return
          }
          markDone(download)
          settle(resolve, download?.filename || path)
        }
      )
      task.addEventListener('statechanged', (download) => {
        const state = Number(download?.state)
        if (state === 3) {
          // 3 = 接收数据；部分服务器不给总大小，退回清单里的大小。
          const total = Number(download.totalSize) || target.size
          const received = Number(download.downloadedSize) || 0
          if (received !== lastReceived) {
            lastReceived = received
            lastActivityAt = Date.now()
          }
          Object.assign(downloadState, {
            status: 'downloading',
            total,
            received,
            progress: computeDownloadProgress(received, total)
          })
        } else if (state === 4) {
          // 4 = 完成：回调有时比 statechanged 晚，这里先把进度置满。
          markDone(download)
        }
      })
      activeTask = task
      task.start()
    } catch (error) {
      fail(error?.message || '无法开始下载')
      return
    }
    // 停滞看门狗：长时间没有新字节就主动失败，而不是永远停在 99%。
    watchdog = setInterval(() => {
      if (finished) return
      if (Date.now() - lastActivityAt < STALL_TIMEOUT_MS) return
      try {
        if (task && typeof task.abort === 'function') task.abort()
      } catch {
        // 任务已结束时忽略。
      }
      fail('下载停滞超时，请重试')
    }, 5000)
  })
}

/**
 * 开始下载目标产物（wgt 或 APK）。
 * 校验顺序：SHA-256 优先；读取接口不可用时退回大小校验（此时返回 false 语义的 hashSkipped）。
 */
export async function startUpdateDownload(target) {
  if (!target) return { ok: false, error: '没有可安装的更新' }
  if (!hasNativeDownloader()) return { ok: false, error: '当前环境不支持应用内下载' }
  if (downloadState.status === 'downloading' || downloadState.status === 'verifying') {
    return { ok: false, error: '已有下载在进行' }
  }
  pendingTarget = target
  resetState({ status: 'downloading', kind: target.kind, version: target.version, total: target.size })
  try {
    const path = await startNativeDownload(target)
    if (downloadState.status === 'idle') return { ok: false, error: '下载已取消' }
    // 下载已完成，进入校验：页面显示「校验中」，进度条停在 100 而不是 99。
    Object.assign(downloadState, {
      status: 'verifying',
      progress: 100,
      received: target.size,
      total: target.size
    })
    let digest = ''
    try {
      digest = await verifyDownload(path, target)
    } catch (error) {
      await removeLocalFile(path)
      throw error
    }
    if (downloadState.status === 'idle') return { ok: false, error: '下载已取消' }
    // 退回大小校验时 digest 为空，此时只认「大小与清单一致」。
    if (digest && digest !== target.sha256) {
      await removeLocalFile(path)
      throw new Error('更新包校验失败，请重新下载')
    }
    Object.assign(downloadState, {
      status: 'ready',
      progress: 100,
      received: target.size,
      total: target.size,
      path
    })
    return { ok: true, path }
  } catch (error) {
    const message = String(error?.message || '下载失败').slice(0, 120)
    resetState({ status: 'error', kind: target.kind, version: target.version, error: message })
    return { ok: false, error: message }
  }
}

/** 取消下载：停掉任务并清空状态。 */
export function cancelDownload() {
  try {
    if (activeTask && typeof activeTask.abort === 'function') activeTask.abort()
  } catch {
    // 任务已结束时忽略。
  }
  activeTask = null
  pendingTarget = null
  resetState()
}

/**
 * 安装已经下载好的更新。
 *
 * wgt 与 apk 都交给 plus.runtime.install：wgt 会被运行时解压覆盖 www，
 * apk 会交给系统安装器（同一签名，覆盖安装保留设置与授权）。
 */
export function installDownloadedUpdate() {
  const path = downloadState.path
  if (!path) return Promise.resolve({ ok: false, error: '没有可安装的更新包' })
  if (!hasPlus() || typeof plus.runtime.install !== 'function') {
    return Promise.resolve({ ok: false, error: '当前环境不支持应用内安装' })
  }
  const kind = downloadState.kind
  const version = downloadState.version
  downloadState.status = 'installing'
  return new Promise((resolve) => {
    try {
      plus.runtime.install(
        path,
        { force: true },
        () => {
          if (kind === 'wgt') saveAppliedWgtVersion(version)
          resetState()
          resolve({ ok: true, kind, version })
        },
        (error) => {
          resetState({ status: 'error', kind, version, error: String(error?.message || '安装失败').slice(0, 120) })
          resolve({ ok: false, error: '安装失败' })
        }
      )
    } catch (error) {
      resetState({ status: 'error', kind, version, error: String(error?.message || '安装失败').slice(0, 120) })
      resolve({ ok: false, error: '安装失败' })
    }
  })
}

/** 重启 App 让 wgt 生效（原生安装成功后运行时通常自己重启，这里给手动兜底）。 */
export function restartApp() {
  try {
    plus.runtime.restart()
  } catch {
    // 忽略
  }
}

/** 用系统浏览器打开下载页，给「应用内更新走不通」的用户兜底。 */
export function openDownloadPage() {
  try {
    plus.runtime.openURL(DOWNLOAD_PAGE_URL)
  } catch {
    uni.setClipboardData({ data: DOWNLOAD_PAGE_URL })
    uni.showToast({ title: '下载页地址已复制', icon: 'none' })
  }
}
