<template>
  <view class="pc-page">
    <view class="pc-row">
      <text class="pc-title">Pilot Client</text>
      <text class="pc-tag">v{{ version }}</text>
    </view>
    <text class="pc-sub">把手机交给电脑端的 Pilot 接管。每张授权卡都能单独收回，收回后对应命令立刻失效。</text>

    <view class="pc-card">
      <view class="pc-row">
        <text class="pc-label">连接状态</text>
        <text class="pc-tag" :class="linkTagClass">{{ linkLabel }}</text>
      </view>
      <view class="pc-row" v-if="link.deviceName">
        <text class="pc-label">电脑</text>
        <text class="pc-value">{{ link.deviceName }}</text>
      </view>
      <view class="pc-row">
        <text class="pc-label">通道</text>
        <text class="pc-value pc-mono">{{ link.detail }}</text>
      </view>
      <view class="pc-btn" @click="go('/pages/pair/index')">和电脑配对</view>
    </view>

    <view class="pc-card">
      <view class="pc-row">
        <text class="pc-label">授权进度</text>
        <text class="pc-value">{{ summary.granted }} / {{ summary.total }}</text>
      </view>
      <view class="pc-progress">
        <view class="pc-progress-bar" :style="{ width: ratioPercent }"></view>
      </view>
      <view class="pc-row" v-for="item in riskRows" :key="item.risk">
        <text class="pc-label">{{ item.label }}风险能力</text>
        <text class="pc-value">{{ item.granted }} / {{ item.total }}</text>
      </view>
      <view class="pc-btn" @click="go('/pages/capabilities/index')">进入授权中心</view>
      <view class="pc-btn pc-btn-ghost" @click="go('/pages/control/index')">打开反控台</view>
    </view>

    <view class="pc-card">
      <view class="pc-row">
        <text class="pc-label">最近操作</text>
        <text class="pc-label" @click="go('/pages/audit/index')">全部记录 ›</text>
      </view>
      <text v-if="recent.length === 0" class="pc-hint">还没有电脑端操作。授权后在这里能看到每一次点击、取文件和授权变更。</text>
      <view v-for="(item, index) in recent" :key="index">
        <text class="pc-mono">{{ formatItem(item) }}</text>
      </view>
    </view>

    <view class="pc-card">
      <view class="pc-row">
        <text class="pc-label">版本</text>
        <text class="pc-tag" :class="hasUpdate ? 'pc-tag-warn' : ''">{{ versionLabel }}</text>
      </view>
      <text v-if="hasUpdate" class="pc-hint">发现 v{{ updateVersion }}，可以直接下载安装。</text>
      <view class="pc-btn" @click="go('/pages/update/index')">{{ hasUpdate ? '安装更新' : '检查更新' }}</view>
    </view>

    <view class="pc-card">
      <text class="pc-value">安全提醒</text>
      <text class="pc-hint">
        授权后这台手机理论上可以由电脑端完全操作：看屏幕、点击、读通知与文件。只给可信的电脑配对；
        在公共网络下先断开；出门前到授权中心把「无障碍服务」和「设备管理器」关掉，是最快的止损方式。
      </text>
    </view>
  </view>
</template>

<script>
import { state, refreshGranted, refreshAudit } from '../../lib/app-state.js'
import { summarize, riskLabel, RISK_ORDER } from '../../lib/capabilities.js'
import { currentAppInfo, downloadState, updateNotice } from '../../lib/update.js'

const LINK_LABELS = {
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
      version: '1.0.1',
      summary: summarize({}),
      // 更新状态不是响应式对象（lib 里保持零依赖，方便 node --test 直接跑源码），
      // 每次 onShow 主动拷一份到 data 里。
      notice: { has: false, version: '', running: '' }
    }
  },
  computed: {
    versionLabel() {
      if (this.notice.has) return `可更新 v${this.notice.version}`
      return this.notice.running ? `v${this.notice.running}` : `v${this.version}`
    },
    hasUpdate() {
      return this.notice.has
    },
    updateVersion() {
      return this.notice.version
    },
    link() {
      return state.link
    },
    connected() {
      return state.link.status === 'online'
    },
    linkLabel() {
      return LINK_LABELS[state.link.status] || '未配对'
    },
    linkTagClass() {
      if (state.link.status === 'online') return 'pc-tag-ok'
      if (state.link.status === 'error') return 'pc-tag-danger'
      return ''
    },
    ratioPercent() {
      return `${Math.round(this.summary.ratio * 100)}%`
    },
    riskRows() {
      return RISK_ORDER.map((risk) => ({
        risk,
        label: riskLabel(risk),
        granted: this.summary.byRisk[risk]?.granted || 0,
        total: this.summary.byRisk[risk]?.total || 0
      }))
    },
    recent() {
      return state.audit.slice(0, 3)
    }
  },
  onShow() {
    refreshGranted()
    refreshAudit()
    this.summary = summarize(state.granted)
    const running = currentAppInfo().version
    const target = updateNotice.target
    this.notice = {
      has: !!target,
      version: target?.version || downloadState.version || '',
      running: running || ''
    }
  },
  methods: {
    go(url) {
      uni.navigateTo({ url })
    },
    formatItem(item) {
      const time = new Date(item.at).toTimeString().slice(0, 8)
      return `${time} ${item.cmd} ${item.ok ? '成功' : item.code || '失败'}`
    }
  }
}
</script>

<style>
.pc-progress {
  height: 12rpx;
  margin: 18rpx 0 22rpx;
  border-radius: 999rpx;
  background-color: #f3f4f6;
  overflow: hidden;
}

.pc-progress-bar {
  height: 100%;
  background-color: #111111;
}
</style>
