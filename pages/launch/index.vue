<template>
  <view class="launch" :class="{ leaving }">
    <image class="logo" src="/static/icons/192.png" mode="aspectFit" />
    <text class="name">Pilot Client</text>
    <text class="hint">{{ hint }}</text>
  </view>
</template>

<script>
import { closeSplash } from '../../lib/splash.js'
import { currentAppInfo } from '../../lib/update.js'

/** 启动页停留时长（毫秒）：先稳稳显示品牌页，再淡出。 */
export const HOLD_MS = 420
/** 淡出动画时长（毫秒），与样式里的 .leaving 过渡一致。 */
export const FADE_MS = 260

export default {
  data() {
    return {
      hint: '正在准备…',
      leaving: false,
      version: '',
      timers: []
    }
  },
  onLoad() {
    const info = currentAppInfo()
    this.version = info.version
  },
  onReady() {
    // 首页 WebView 已经就绪：马上关掉原生启动图，避免它等不到渲染回调一直盖着。
    closeSplash()
    this.timers.push(setTimeout(() => { this.leaving = true }, HOLD_MS))
    this.timers.push(setTimeout(() => this.enter(), HOLD_MS + FADE_MS))
  },
  onUnload() {
    this.clearTimers()
  },
  methods: {
    clearTimers() {
      for (const timer of this.timers) clearTimeout(timer)
      this.timers = []
    },
    enter() {
      this.clearTimers()
      closeSplash()
      uni.reLaunch({
        url: '/pages/home/index',
        // reLaunch 在个别 ROM / 低内存时会失败，兜底用 redirectTo，绝不停在启动页。
        fail: () => uni.redirectTo({ url: '/pages/home/index' })
      })
    }
  }
}
</script>

<style>
/* 白底 + 正中黑 P：和原生启动图（drawable/splash.9.png）同一张画面，切换时看不出断层。 */
.launch {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background-color: #ffffff;
  opacity: 1;
  transition: opacity 260ms ease-out;
}

.launch.leaving {
  opacity: 0;
}

.logo {
  width: 148rpx;
  height: 148rpx;
  border-radius: 34rpx;
  box-shadow: 0 18rpx 48rpx rgba(17, 17, 17, 0.12);
}

.name {
  margin-top: 32rpx;
  color: #111111;
  font-size: 40rpx;
  font-weight: 600;
  letter-spacing: 1rpx;
}

.hint {
  margin-top: 16rpx;
  color: #6b7280;
  font-size: 26rpx;
}
</style>
