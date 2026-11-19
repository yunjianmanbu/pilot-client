<template>
  <view class="pc-page">
    <view class="pc-row">
      <text class="pc-title">操作记录</text>
      <text class="pc-tag">{{ entries.length }} 条</text>
    </view>
    <text class="pc-sub">参数已脱敏：剪贴板正文、短信内容、文件名只留长度，不存原文。最近 200 条，超出自动丢弃最旧的。</text>

    <text v-if="entries.length === 0" class="pc-hint">还没有记录。去反控台点几个按钮，这里会立刻出现。</text>

    <view class="pc-card" v-for="(item, index) in entries" :key="index">
      <view class="pc-row">
        <text class="pc-value pc-mono">{{ item.cmd }}</text>
        <text class="pc-tag" :class="item.ok ? 'pc-tag-ok' : 'pc-tag-danger'">
          {{ item.ok ? 'L' + item.level + ' 成功' : item.code || '失败' }}
        </text>
      </view>
      <text class="pc-mono">{{ time(item.at) }}<text v-if="item.ms !== null"> · {{ item.ms }}ms</text></text>
      <text v-if="item.args" class="pc-hint">{{ JSON.stringify(item.args) }}</text>
    </view>

    <view class="pc-btn pc-btn-ghost" @click="copy">复制全部记录</view>
    <view class="pc-btn pc-btn-ghost" @click="clear">清空记录</view>
  </view>
</template>

<script>
import { state, audit, refreshAudit } from '../../lib/app-state.js'

export default {
  computed: {
    entries() {
      return state.audit
    }
  },
  onShow() {
    refreshAudit()
  },
  methods: {
    time(at) {
      const date = new Date(at)
      return `${date.toLocaleDateString()} ${date.toTimeString().slice(0, 8)}`
    },
    copy() {
      uni.setClipboardData({ data: audit.exportText() })
    },
    clear() {
      uni.showModal({
        title: '清空操作记录',
        content: '清空后无法恢复。审计只存在这台手机上，电脑端也拿不到历史。',
        success: (res) => {
          if (!res.confirm) return
          audit.clear()
          refreshAudit()
        }
      })
    }
  }
}
</script>
