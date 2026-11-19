<template>
  <view class="pc-page">
    <view class="pc-row">
      <text class="pc-title">授权中心</text>
      <text class="pc-tag">{{ summary.granted }} / {{ summary.total }}</text>
    </view>
    <text class="pc-sub">每一项都是「电脑端能对这台手机做什么」。风险越高的项越应该按需打开，用完就关。</text>

    <view class="pc-btn" @click="grantAll">一键申请全部普通权限</view>

    <view class="pc-card" v-for="capability in capabilities" :key="capability.id">
      <view class="pc-row">
        <text class="pc-value">{{ capability.title }}</text>
        <text class="pc-tag" :class="capabilityTagClass(capability)">{{ riskLabel(capability.risk) }}风险 · {{ grantedOf(capability) }}</text>
      </view>
      <text class="pc-hint">{{ capability.summary }}</text>

      <view v-if="capability.special.length > 0" class="pc-special">
        <view class="pc-row" v-for="id in capability.special" :key="id">
          <text class="pc-label">{{ specialLabel(id) }}</text>
          <text class="pc-tag" @click="openSpecial(id)">{{ state.granted[id] ? '已开启' : '去开启 ›' }}</text>
        </view>
      </view>

      <view v-if="capability.runtime.length > 0" class="pc-row">
        <text class="pc-label">普通权限 {{ runtimeGranted(capability) }} / {{ capability.runtime.length }}</text>
        <text class="pc-tag" @click="grantRuntime(capability)">申请</text>
      </view>

      <text class="pc-hint">电脑端能做：{{ commandTitles(capability) }}</text>
    </view>
  </view>
</template>

<script>
import { state, refreshGranted } from '../../lib/app-state.js'
import {
  CAPABILITIES,
  SPECIAL_PERMISSIONS,
  riskLabel,
  summarize
} from '../../lib/capabilities.js'
import { requestRuntime, requestAllRuntime, openSpecialSettings } from '../../lib/permissions.js'
import { COMMANDS } from '../../lib/reverse-control.js'

export default {
  data() {
    return {
      state,
      capabilities: CAPABILITIES,
      summary: summarize({})
    }
  },
  onShow() {
    refreshGranted()
    this.summary = summarize(state.granted)
  },
  methods: {
    riskLabel,
    specialLabel(id) {
      return SPECIAL_PERMISSIONS[id]?.label || id
    },
    runtimeGranted(capability) {
      return capability.runtime.filter((name) => state.granted[name] === true).length
    },
    grantedOf(capability) {
      const total = capability.runtime.length + capability.special.length
      const done = this.runtimeGranted(capability) + capability.special.filter((id) => state.granted[id] === true).length
      return `${done}/${total}`
    },
    capabilityTagClass(capability) {
      const total = capability.runtime.length + capability.special.length
      const done = this.runtimeGranted(capability) + capability.special.filter((id) => state.granted[id] === true).length
      if (done === total && total > 0) return 'pc-tag-ok'
      return capability.risk === 'critical' || capability.risk === 'high' ? 'pc-tag-danger' : ''
    },
    commandTitles(capability) {
      return capability.commands.map((cmd) => COMMANDS[cmd]?.title || cmd).join('、')
    },
    async grantRuntime(capability) {
      const result = await requestRuntime(capability.runtime)
      if (!result.ok) {
        uni.showToast({ title: '只能在 Android App 内申请', icon: 'none' })
        return
      }
      refreshGranted()
      this.summary = summarize(state.granted)
      uni.showToast({ title: `已授权 ${result.granted.length} 项`, icon: 'none' })
    },
    async grantAll() {
      const result = await requestAllRuntime(state.granted)
      refreshGranted()
      this.summary = summarize(state.granted)
      uni.showToast({
        title: result.granted.length ? `已授权 ${result.granted.length} 项` : '没有可申请的权限',
        icon: 'none'
      })
    },
    openSpecial(id) {
      const result = openSpecialSettings(id)
      if (!result.ok) {
        uni.showToast({ title: '需要更系统后到设置里手动打开', icon: 'none' })
        return
      }
      uni.showToast({ title: '已打开系统设置，找到 Pilot Client 打开开关', icon: 'none' })
    }
  }
}
</script>

<style>
.pc-special {
  margin: 18rpx 0;
  padding: 16rpx 20rpx;
  border-radius: 16rpx;
  background-color: #f9fafb;
}
</style>
