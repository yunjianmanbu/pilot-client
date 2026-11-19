<script>
import { state, bootstrap } from './lib/app-state.js'
import { closeSplash, installSplashGuard } from './lib/splash.js'
import { autoCheckUpdate } from './lib/update.js'

let cancelSplashGuard = null
let updateTimer = null

export default {
  onLaunch() {
    bootstrap()
    // 原生启动图等首屏渲染回调，启动页切走后可能收不到，这里错开时间点反复关。
    cancelSplashGuard = installSplashGuard()
    try {
      if (typeof uni !== 'undefined' && typeof uni.onError === 'function') {
        uni.onError(() => closeSplash())
      }
    } catch {
      // 宿主没有这个接口时跳过。
    }
    // 静默检查更新：6 小时内只查一次，且只在真的拿到新版本时才提示。
    updateTimer = setTimeout(() => {
      autoCheckUpdate().catch(() => {})
    }, 3000)
  },
  onHide() {
    if (cancelSplashGuard) cancelSplashGuard()
  },
  onUnload() {
    if (cancelSplashGuard) cancelSplashGuard()
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
