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
      <view class="pc-btn" @click="connect">连接</view>
      <view class="pc-btn pc-btn-ghost" @click="scan">扫码</view>
    </view>

    <view class="pc-card">
      <view class="pc-row">
        <text class="pc-label">当前状态</text>
        <text class="pc-tag">{{ linkStatus }}</text>
      </view>
      <text class="pc-hint">{{ linkDetail }}</text>
    </view>

    <view class="pc-card">
      <text class="pc-value">连接前请确认</text>
      <text class="pc-hint">
        1. 这台手机和电脑只在这个房间里说话，房间密钥只存在两台设备上；\n
        2. 电脑端能下发的命令受「授权中心」限制，没授权的能力会被直接拒绝；\n
        3. 每一步操作都会写进「操作记录」，电脑端也看得到同一份。
      </text>
    </view>
  </view>
</template>

<script>
import { state } from '../../lib/app-state.js'

export default {
  data() {
    return { code: '' }
  },
  computed: {
    linkStatus() {
      if (state.link.status === 'online') return '已连接'
      if (state.link.status === 'connecting') return '连接中'
      return '未连接'
    },
    linkDetail() {
      return state.link.detail
    }
  },
  methods: {
    connect() {
      state.link = {
        status: 'local',
        code: this.code.trim(),
        detail: this.code.trim()
          ? '加密传输层还在接入中：这一版只完成授权与命令执行，配对通道下一步接上。'
          : '先粘贴电脑端的配对串。'
      }
      uni.showToast({ title: this.code.trim() ? '已记录配对码' : '配对码为空', icon: 'none' })
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
</style>
