<template>
  <view class="pc-page">
    <text class="pc-title">连接电脑</text>
    <text class="pc-sub">在电脑端 Pilot 里生成配对码，手机扫码或粘贴即可。配对只交换房间与密钥，不上传手机里的任何内容。</text>

    <view class="pc-card">
      <text class="pc-label">配对码</text>
      <textarea
        class="pc-input"
        v-model="code"
        placeholder="粘贴电脑端生成的配对串"
        :maxlength="2048"
        auto-height
      />
      <view class="pc-btn" :class="busy ? 'pc-btn-busy' : ''" @click="connect">{{ connectLabel }}</view>
      <view class="pc-btn pc-btn-ghost" @click="scan">扫码</view>
    </view>

    <view class="pc-card">
      <view class="pc-row">
        <text class="pc-label">当前状态</text>
        <text class="pc-tag" :class="tagClass">{{ statusLabel }}</text>
      </view>
      <text class="pc-hint">{{ link.detail }}</text>
      <view class="pc-row" v-if="link.deviceName">
        <text class="pc-label">已配对电脑</text>
        <text class="pc-value">{{ link.deviceName }}</text>
      </view>
      <view class="pc-row" v-if="link.pairedAt">
        <text class="pc-label">配对时间</text>
        <text class="pc-mono">{{ pairTime }}</text>
      </view>
      <view v-if="canRetry" class="pc-btn pc-btn-ghost" @click="retry">重新连接</view>
      <view v-if="paired" class="pc-btn pc-btn-ghost" @click="disconnect">断开并忘记这台电脑</view>
    </view>

    <view class="pc-card">
      <text class="pc-value">连接前请确认</text>
      <text class="pc-hint">1. 这台手机和电脑只在这个房间里说话，房间密钥只存在两台设备上。</text>
      <text class="pc-hint">2. 电脑端能下发的命令受「授权中心」限制，没授权的能力会被直接拒绝。</text>
      <text class="pc-hint">3. 每一步操作都会写进「操作记录」，电脑端也看得到同一份。</text>
    </view>
  </view>
</template>

<script>
import { state, linkManager } from '../../lib/app-state.js'

const LABELS = {
  local: '未配对',
  pairing: '配对中',
  connecting: '连接中',
  online: '已连接',
  offline: '已断开',
  error: '连接失败'
}

export default {
  data() {
    return {
      code: '',
      busy: false
    }
  },
  computed: {
    link() {
      return state.link
    },
    paired() {
      return Boolean(linkManager.paired)
    },
    statusLabel() {
      return LABELS[state.link.status] || '未配对'
    },
    tagClass() {
      if (state.link.status === 'online') return 'pc-tag-ok'
      if (state.link.status === 'error') return 'pc-tag-danger'
      return ''
    },
    connectLabel() {
      if (this.busy) return '正在配对…'
      return this.paired ? '换个配对码重连' : '连接'
    },
    canRetry() {
      return state.link.status === 'offline' && this.paired
    },
    pairTime() {
      const at = state.link.pairedAt
      if (!at) return ''
      try {
        return new Date(at).toLocaleString()
      } catch {
        return at
      }
    }
  },
  methods: {
    async connect() {
      if (this.busy) return
      const code = this.code.trim()
      if (!code) {
        uni.showToast({ title: '先粘贴电脑端的配对串', icon: 'none' })
        return
      }
      this.busy = true
      try {
        await linkManager.pair(code)
        // 配对成功；后续握手状态由 PairedLink 推回 state.link
        this.code = ''
        uni.showToast({ title: '配对成功', icon: 'none' })
      } catch (error) {
        uni.showToast({ title: error?.message || '配对失败，请重试', icon: 'none' })
      } finally {
        this.busy = false
      }
    },
    retry() {
      if (!linkManager.retry()) {
        uni.showToast({ title: '还没有配对记录', icon: 'none' })
      }
    },
    disconnect() {
      uni.showModal({
        title: '断开连接',
        content: '断开后这台手机会忘记配对，下次要在电脑端重新生成配对码。',
        success: (res) => {
          if (!res.confirm) return
          linkManager.disconnect()
          uni.showToast({ title: '已断开', icon: 'none' })
        }
      })
    },
    scan() {
      uni.scanCode({
        success: (res) => {
          this.code = res?.result || ''
        },
        fail: () => {
          uni.showToast({ title: '扫码需要相机授权', icon: 'none' })
        }
      })
    }
  }
}
</script>

<style>
.pc-input {
  width: 100%;
  min-height: 140rpx;
  margin: 16rpx 0 24rpx;
  padding: 20rpx;
  box-sizing: border-box;
  border: 1px solid #e5e7eb;
  border-radius: 16rpx;
  font-size: 26rpx;
}

.pc-btn-busy {
  opacity: 0.6;
}
</style>
