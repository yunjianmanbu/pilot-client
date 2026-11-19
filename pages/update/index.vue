<template>
  <view class="pc-page">
    <view class="pc-row">
      <text class="pc-title">应用更新</text>
      <text class="pc-tag" :class="state.status === 'error' ? 'pc-tag-danger' : ''">{{ badge }}</text>
    </view>
    <text class="pc-sub">当前版本 v{{ current.version }}<text v-if="current.shellVersion && current.shellVersion !== current.version"> · 安装包 v{{ current.shellVersion }}</text></text>

    <view class="pc-card">
      <view class="pc-row">
        <text class="pc-label">检查结果</text>
        <text class="pc-tag" :class="resultClass">{{ resultText }}</text>
      </view>
      <text v-if="target" class="pc-hint">
        {{ target.kind === 'wgt' ? '可用增量资源包，只下载前端页面，装完自动重启。' : '需要全量安装包，覆盖安装会保留已授权的能力和配对信息。' }}
      </text>
      <text v-if="state.status === 'downloading' || state.status === 'verifying'" class="pc-hint">{{ progressText }}</text>
      <view v-if="state.status === 'downloading' || state.status === 'verifying'" class="pc-progress">
        <view class="pc-progress-bar" :style="{ width: state.progress + '%' }"></view>
      </view>
      <text v-if="state.error" class="pc-hint pc-error">{{ state.error }}</text>
    </view>

    <view class="pc-card">
      <view class="pc-row">
        <text class="pc-label">操作</text>
      </view>
      <view v-if="state.status === 'idle' || state.status === 'error'" class="pc-btn" @click="check">检查更新</view>
      <view v-if="target && (state.status === 'idle' || state.status === 'error')" class="pc-btn" @click="download">下载并安装 v{{ target.version }}</view>
      <view v-if="state.status === 'downloading'" class="pc-btn" @click="cancel">取消下载</view>
      <view v-if="state.status === 'verifying'" class="pc-btn pc-btn-busy">正在校验更新包…</view>
      <view v-if="state.status === 'ready'" class="pc-btn" @click="install">立即安装</view>
      <view class="pc-btn pc-btn-ghost" @click="openPage">用浏览器下载</view>
      <text class="pc-hint">应用内下载会先校验 SHA-256 再安装；增量包校验不过时会提示重试。</text>
    </view>

    <view v-if="manifest && manifest.notes" class="pc-card">
      <text class="pc-label">更新说明</text>
      <text class="pc-hint">{{ manifest.notes }}</text>
    </view>
  </view>
</template>

<script>
import {
  cancelDownload,
  checkForUpdate,
  currentAppInfo,
  downloadState,
  installDownloadedUpdate,
  openDownloadPage,
  startUpdateDownload
} from '../../lib/update.js'

export default {
  data() {
    return {
      current: { version: '', shellVersion: '', supported: false },
      manifest: null,
      target: null,
      checked: false,
      // downloadState 是模块级普通对象（lib 保持零依赖），这里定时同步一份快照。
      state: { ...downloadState },
      timer: null
    }
  },
  computed: {
    badge() {
      if (this.state.status === 'downloading') return '下载中'
      if (this.state.status === 'verifying') return '校验中'
      if (this.state.status === 'ready') return '待安装'
      if (this.state.status === 'installing') return '安装中'
      if (this.state.status === 'error') return '出错'
      return this.checked ? '已检查' : '未检查'
    },
    resultClass() {
      if (this.state.status === 'error') return 'pc-tag-danger'
      if (this.target) return 'pc-tag-warn'
      return this.checked ? 'pc-tag-ok' : ''
    },
    resultText() {
      if (!this.current.supported) return '仅手机 App 支持'
      if (!this.checked) return '点击「检查更新」'
      if (!this.manifest) return '暂时拿不到清单'
      if (!this.target) return '已是最新'
      return `v${this.target.version}（${this.target.kind === 'wgt' ? '增量' : '全量'}）`
    },
    progressText() {
      const total = this.state.total || this.target?.size || 0
      const received = this.state.received || 0
      if (this.state.status === 'verifying') return `已下载 ${formatSize(received)} / ${formatSize(total)}，正在校验…`
      return `${Math.round(this.state.progress)}% · ${formatSize(received)} / ${formatSize(total)}`
    }
  },
  onLoad() {
    this.current = currentAppInfo()
    // 首页点进来时可能已经知道有新版本，直接显示，不用再查一次。
    if (downloadState.version) {
      this.target = this.target || {
        kind: downloadState.kind,
        version: downloadState.version,
        size: downloadState.total,
        url: '',
        sha256: ''
      }
    }
    this.sync()
    this.timer = setInterval(() => this.sync(), 300)
  },
  onUnload() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  },
  methods: {
    sync() {
      this.state = { ...downloadState }
      const active = downloadState.status === 'downloading'
        || downloadState.status === 'verifying'
        || downloadState.status === 'ready'
      if (active) {
        if (downloadState.version && (!this.target || this.target.version !== downloadState.version)) {
          this.target = this.target || {
            kind: downloadState.kind,
            version: downloadState.version,
            size: downloadState.total,
            url: '',
            sha256: ''
          }
        }
      }
    },
    async check() {
      uni.showLoading({ title: '检查中…', mask: true })
      const result = await checkForUpdate()
      uni.hideLoading()
      this.current = result.current
      this.manifest = result.manifest
      this.target = result.target
      this.checked = true
      this.sync()
      if (!result.manifest) uni.showToast({ title: '拿不到更新清单，请检查网络', icon: 'none' })
      else if (!result.target) uni.showToast({ title: '已是最新版本', icon: 'none' })
    },
    async download() {
      const result = await startUpdateDownload(this.target)
      if (!result.ok) {
        uni.showToast({ title: result.error || '下载失败', icon: 'none' })
        return
      }
      uni.showModal({
        title: `更新 v${this.target.version} 已下载`,
        content: this.target.kind === 'wgt'
          ? '资源包已校验完成。安装后 App 会自动重启，配对与授权都会保留。'
          : '安装包已校验完成，覆盖安装会保留配对与授权。',
        confirmText: '立即安装',
        cancelText: '稍后',
        success: (response) => {
          if (response.confirm) this.install()
        }
      })
    },
    cancel() {
      cancelDownload()
    },
    async install() {
      const result = await installDownloadedUpdate()
      if (!result.ok) {
        uni.showToast({ title: result.error || '安装失败', icon: 'none' })
        return
      }
      uni.showToast({ title: '正在重启应用', icon: 'none' })
    },
    openPage() {
      openDownloadPage()
    }
  }
}

function formatSize(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
</script>

<style>
.pc-tag-warn {
  background-color: #fef3c7;
  color: #92400e;
}

.pc-error {
  color: #b91c1c;
}

.pc-btn-ghost {
  margin-top: 16rpx;
  background-color: #f3f4f6;
  color: #111111;
  border: 1px solid #e5e7eb;
}

.pc-btn-busy {
  background-color: #e5e7eb;
  color: #6b7280;
}

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
