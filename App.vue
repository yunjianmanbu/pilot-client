<script>
import { state, bootstrap } from './lib/app-state.js'
import { closeSplash, installSplashGuard } from './lib/splash.js'
import { autoCheckUpdate } from './lib/update.js'

let cancelSplashGuard = null
let updateTimer = null
let startupErrorHooked = false

/** 任何启动期 JS 异常都不能让原生启动图一直挡在界面上。 */
function hookStartupErrors() {
  if (startupErrorHooked) return
  startupErrorHooked = true
  try {
    if (typeof uni === 'undefined') return
    if (typeof uni.onError === 'function') uni.onError(() => closeSplash())
    if (typeof uni.onUnhandledRejection === 'function') {
      uni.onUnhandledRejection(() => closeSplash())
    }
  } catch {
    // 宿主没有这些接口时跳过。
  }
}

/** 初始化失败也要让 App 继续挂载：页面自己会显示状态，不能停在白屏。 */
function safeBootstrap() {
  try {
    bootstrap()
  } catch (err) {
    console.error('[pilot-client] 启动初始化失败', err)
    closeSplash()
  }
}

export default {
  onLaunch() {
    // 先挂启动图兜底再初始化：bootstrap() 内部任何异常都不能导致兜底没挂上，
    // 否则 alwaysShowBeforeRender 的原生启动图会一直盖在界面上（表现为白屏）。
    if (!cancelSplashGuard) cancelSplashGuard = installSplashGuard()
    hookStartupErrors()
    safeBootstrap()
    // 静默检查更新：6 小时内只查一次，且只在真的拿到新版本时才提示。
    updateTimer = setTimeout(() => {
      autoCheckUpdate().catch(() => {})
    }, 3000)
  },
  onShow() {
    // 从后台回到前台：重新挂上兑底定时器并立刻清启动图（切后台时已取消）。
    if (!cancelSplashGuard) cancelSplashGuard = installSplashGuard()
    closeSplash()
  },
  onHide() {
    if (cancelSplashGuard) {
      cancelSplashGuard()
      cancelSplashGuard = null
    }
  },
  onUnload() {
    if (cancelSplashGuard) {
      cancelSplashGuard()
      cancelSplashGuard = null
    }
    if (updateTimer) clearTimeout(updateTimer)
  }
}
</script>

<style>
/* 全局浅色主题：白底、黑字、灰分割线；只在这里定义一次，页面里不重复写颜色。 */
page {
  background-color: #ffffff;
  color: #111111;
  font-size: 15px;
  line-height: 1.55;
}

.pc-page {
  min-height: 100vh;
  padding: 24rpx 28rpx 80rpx;
  box-sizing: border-box;
  background-color: #ffffff;
}

.pc-title {
  font-size: 40rpx;
  font-weight: 700;
  letter-spacing: 1rpx;
}

.pc-sub {
  margin-top: 8rpx;
  color: #6b7280;
  font-size: 26rpx;
}

.pc-card {
  margin-top: 24rpx;
  padding: 28rpx;
  border: 1px solid #e5e7eb;
  border-radius: 20rpx;
  background-color: #ffffff;
}

.pc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.pc-row + .pc-row {
  margin-top: 18rpx;
}

.pc-label {
  color: #6b7280;
  font-size: 26rpx;
}

.pc-value {
  font-size: 28rpx;
  font-weight: 600;
}

.pc-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 88rpx;
  border-radius: 18rpx;
  background-color: #111111;
  color: #ffffff;
  font-size: 30rpx;
}

.pc-btn + .pc-btn {
  margin-top: 18rpx;
}

.pc-btn-ghost {
  background-color: #ffffff;
  color: #111111;
  border: 1px solid #d1d5db;
}

.pc-tag {
  display: inline-block;
  padding: 4rpx 14rpx;
  border-radius: 999rpx;
  font-size: 22rpx;
  background-color: #f3f4f6;
  color: #374151;
}

.pc-tag-danger {
  background-color: #fef2f2;
  color: #b91c1c;
}

.pc-tag-ok {
  background-color: #ecfdf5;
  color: #047857;
}

.pc-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 24rpx;
  color: #374151;
  word-break: break-all;
}

.pc-hint {
  margin-top: 12rpx;
  color: #6b7280;
  font-size: 24rpx;
}
</style>
