/**
 * 启动图（splash）兜底关闭。
 *
 * 背景：离线条包的原生启动图在等「首屏渲染完成」后才自动关闭，而 pages/launch
 * 会在渲染完成后立刻 reLaunch 到首页，渲染完成事件有时投递不到启动图控制器，
 * 启动图就一直盖在界面上（表现为白屏 / 只有一张图）。切到后台再回前台时运行时会
 * 强制移除启动图，所以看起来「自己恢复了」。
 *
 * 这里按 Pilot Link 同一套做法做纯客户端兜底：多个时间点反复调用 plus.navigator
 * 的关闭接口，并在目标页面渲染完成后再关一次，任何一条路径生效就够。
 * 只有 App（plus）环境需要；H5 直接跳过。
 */

/** 单次兜底关闭的默认延时（毫秒）。 */
export const SPLASH_GUARD_MS = 800

/** 反复兜底关闭的时间点（毫秒）：低端机创建启动图视图可能晚于 800ms。 */
export const SPLASH_RETRY_DELAYS = [300, 1000, 2500, 5000]

function resolvePlus(plusApi) {
  if (plusApi) return plusApi
  try {
    return typeof plus !== 'undefined' ? plus : null
  } catch {
    return null
  }
}

/** 把传入的延时归一成非负毫秒数，非法值用默认值。 */
export function resolveSplashDelay(value, fallback = SPLASH_GUARD_MS) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  return number
}

/** 立刻关掉启动图；任何异常都吞掉，启动图关不掉也不能影响主流程。 */
export function closeSplash(plusApi) {
  const api = resolvePlus(plusApi)
  if (!api) return false
  try {
    if (api.navigator && typeof api.navigator.closeSplashscreen === 'function') {
      api.navigator.closeSplashscreen()
      return true
    }
  } catch {
    // 运行时还没创建启动图视图时调用会抛错，交给后面的重试。
  }
  try {
    if (typeof api.navigator.closeSplashscreen === 'function') {
      api.navigator.closeSplashscreen()
      return true
    }
  } catch {
    // 忽略
  }
  return false
}

/**
 * 挂一组兜底关闭定时器，返回取消函数。
 *
 * @param {object} options
 * @param {number[]} options.delays 覆盖默认时间点（测试用）
 * @param {object} options.plusApi 覆盖 plus 对象（测试用）
 * @param {Function} options.scheduler setTimeout 替身（测试用）
 * @param {Function} options.clearer clearTimeout 替身（测试用）
 */
export function installSplashGuard(options = {}) {
  const api = resolvePlus(options.plusApi)
  if (!api) return () => {}
  const scheduler = options.scheduler || ((fn, ms) => setTimeout(fn, ms))
  const clearer = options.clearer || ((timer) => clearTimeout(timer))
  const delays = Array.isArray(options.delays) && options.delays.length
    ? options.delays
    : SPLASH_RETRY_DELAYS
  let cancelled = false
  const timers = delays.map((item) =>
    scheduler(() => {
      if (cancelled) return
      closeSplash(api)
    }, resolveSplashDelay(item))
  )
  return () => {
    cancelled = true
    for (const timer of timers) {
      try {
        clearer(timer)
      } catch {
        // 定时器已触发时忽略。
      }
    }
  }
}
