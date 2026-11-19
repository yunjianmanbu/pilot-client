<template>
  <view class="pc-page">
    <view class="pc-row">
      <text class="pc-title">反控台</text>
      <text class="pc-tag">本机自测</text>
    </view>
    <text class="pc-sub">电脑端发来的每条命令都走这里。下面这些按钮等价于电脑端下发的同一条命令，用来验证授权是否真的生效。</text>

    <view class="pc-card">
      <view class="pc-row">
        <text class="pc-label">屏幕画面</text>
        <text class="pc-tag">{{ state.granted.mediaProjection ? '可投屏' : '未授权' }}</text>
      </view>
      <view class="pc-screen">
        <text class="pc-hint">屏幕镜像要等原生层 MediaProjection 接上；现在这里显示占位。</text>
      </view>
      <view class="pc-btn pc-btn-ghost" @click="go('/pages/capabilities/index')">去开屏幕采集 / 无障碍</view>
    </view>

    <view class="pc-card">
      <text class="pc-value">免授权即可验证</text>
      <view class="pc-grid">
        <view class="pc-action" v-for="action in safeActions" :key="action.cmd" @click="run(action)">
          <text class="pc-action-title">{{ action.label }}</text>
          <text class="pc-action-cmd pc-mono">{{ action.cmd }}</text>
        </view>
      </view>
    </view>

    <view class="pc-card">
      <text class="pc-value">需要先授权</text>
      <view class="pc-grid">
        <view class="pc-action" v-for="action in riskyActions" :key="action.cmd" @click="run(action)">
          <text class="pc-action-title">{{ action.label }}</text>
          <text class="pc-action-cmd pc-mono">{{ action.cmd }}</text>
        </view>
      </view>
    </view>

    <view class="pc-card" v-if="last">
      <view class="pc-row">
        <text class="pc-label">{{ last.cmd }}</text>
        <text class="pc-tag" :class="last.ok ? 'pc-tag-ok' : 'pc-tag-danger'">{{ last.ok ? '成功' : last.error?.code }}</text>
      </view>
      <text class="pc-mono">{{ detail }}</text>
      <text v-if="last.error?.hint" class="pc-hint">{{ last.error.hint }}</text>
    </view>
  </view>
</template>

<script>
import { state, runCommand } from '../../lib/app-state.js'

export default {
  data() {
    return {
      state,
      safeActions: [
        { cmd: 'rc.status', label: '设备状态', args: {} },
        { cmd: 'rc.clipboard.get', label: '读剪贴板', args: {} },
        { cmd: 'rc.device.vibrate', label: '震动', args: { ms: 200 } },
        { cmd: 'rc.device.volume', label: '音量 60%', args: { level: 0.6 } },
        { cmd: 'rc.device.brightness', label: '亮度 70%', args: { level: 0.7 } },
        { cmd: 'rc.device.wake', label: '屏幕常亮', args: { on: true } },
        { cmd: 'rc.device.toast', label: '弹提示', args: { text: '来自电脑端的提示' } },
        { cmd: 'rc.files.list', label: '列文档目录', args: { path: '_doc' } }
      ],
      riskyActions: [
        { cmd: 'rc.screen.capture', label: '抓屏幕', args: {} },
        { cmd: 'rc.input.tap', label: '点屏幕中心', args: { x: 540, y: 1200 } },
        { cmd: 'rc.input.key', label: '按返回', args: { key: 'back' } },
        { cmd: 'rc.apps.list', label: '列全部应用', args: { limit: 50 } },
        { cmd: 'rc.notify.list', label: '读通知', args: { limit: 10 } },
        { cmd: 'rc.location.get', label: '取定位', args: { accuracy: 'coarse' } },
        { cmd: 'rc.camera.photo', label: '拍一张', args: { facing: 'back' } },
        { cmd: 'rc.device.lock', label: '锁屏', args: {} }
      ]
    }
  },
  computed: {
    last() {
      return state.lastResult
    },
    detail() {
      if (!this.last) return ''
      const payload = this.last.ok ? this.last.data : this.last.error
      const text = JSON.stringify(payload)
      return text && text.length > 600 ? `${text.slice(0, 600)}…` : text
    }
  },
  methods: {
    go(url) {
      uni.navigateTo({ url })
    },
    async run(action) {
      const result = await runCommand(action.cmd, action.args)
      const title = result.ok ? `${action.label}：成功` : `${action.label}：${result.error?.code || '失败'}`
      uni.showToast({ title, icon: 'none' })
    }
  }
}
</script>

<style>
.pc-screen {
  height: 240rpx;
  margin: 20rpx 0;
  border: 1px dashed #d1d5db;
  border-radius: 16rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 24rpx;
}

.pc-grid {
  display: flex;
  flex-wrap: wrap;
  margin-top: 18rpx;
}

.pc-action {
  width: 48%;
  margin: 0 4% 18rpx 0;
  padding: 20rpx;
  box-sizing: border-box;
  border: 1px solid #e5e7eb;
  border-radius: 16rpx;
}

.pc-action:nth-child(2n) {
  margin-right: 0;
}

.pc-action-title {
  font-size: 28rpx;
  font-weight: 600;
}

.pc-action-cmd {
  display: block;
  margin-top: 6rpx;
  color: #9ca3af;
}
</style>
