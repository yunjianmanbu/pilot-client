# 手机反控功能方案（Pilot Client）

目标：电脑端的 Pilot 能像坐在手机前面一样操作手机，同时每一步都可追溯、可随时收回。

比「能不能做到」更重要的是**分级**：哪些装个 App 就能用、哪些要用户去系统设置里点开关、
哪些必须 adb/root/系统签名。把第三类伪装成第一类是这类产品最常见的失信点，
所以下面每一档都写明代价。

## 一、现在就能用（已有单测，不依赖原生 Service）

| 功能 | 命令 | 授权 | 说明 |
| --- | --- | --- | --- |
| 设备状态 | `rc.status` | 无 | 机型、系统版本、电量、充电、网络类型 |
| 心跳 / 链路质量 | `rc.ping`、`rc.link.report` | 无 | 电脑端据此判断延迟 |
| 读/写剪贴板 | `rc.clipboard.get/set` | 系统框 | 手机复制 → 电脑粘贴，反向同理 |
| 震动 | `rc.device.vibrate` | `VIBRATE` | 找到手机、提醒用户看电脑 |
| 弹提示 | `rc.device.toast` | 无 | 「电脑正在操作」的轻提示 |
| 音量 / 亮度 / 屏幕常亮 | `rc.device.volume/brightness/wake` | `WRITE_SETTINGS` | 远程协助时先把屏幕调亮 |
| 已安装应用列表 | `rc.apps.list` | `QUERY_ALL_PACKAGES` | 带包名、名称、版本、是否系统应用 |
| 打开应用 | `rc.app.open` | 同上 | 电脑端点一下打开微信 |
| 目录浏览 | `rc.files.list` | `MANAGE_EXTERNAL_STORAGE` | 按路径列目录、大小、修改时间 |

这一档的价值在于：**不用任何「危险授权」就能验证整条链路是通的**，
反控台的「免授权即可验证」区就是这 9 条。

## 二、接了原生 Service 立刻翻倍（高价值，工作量集中在这里）

### 1. 屏幕镜像 + 输入注入（这是「反控」的本体）

| 能力 | 需要 | 说明 |
| --- | --- | --- |
| 实时画面 | `MediaProjection` + 前台服务 `FOREGROUND_SERVICE_MEDIA_PROJECTION` | 每帧 H.264 / WebP 走现有端到端加密通道；用户每次连接都要点一次「开始录制」 |
| 点击 / 滑动 | 无障碍 `AccessibilityService` 的 `dispatchGesture` | 电脑端的鼠标坐标按比例映射到手机分辨率 |
| 输入文字 | 无障碍 `ACTION_SET_TEXT` 或 `InputConnection` | 中文输入法场景要配合 `ACTION_PASTE` |
| 返回 / 主页 / 最近任务 | 无障碍 `performGlobalAction` | 替代不可用的 `StatusBarManager` |
| 状态栏下拉 | 无障碍 `ACTION_EXPAND_NOTIFICATION_SHADE`（API 31+） | 比 `StatusBarManager.expandNotificationsPanel` 干净 |

价值：手机不在手边也能回消息、点外卖、处理验证码流程、帮长辈操作。
代价：无障碍是 Android 上权限最大的一类服务，能读到屏幕上的全部文字。
**必须做**：可见的悬浮条（`SYSTEM_ALERT_WINDOW`）显示「电脑正在操作」+ 一键断开。

### 2. 通知与状态

| 能力 | 需要 | 价值 |
| --- | --- | --- |
| 通知同步到电脑 | `NotificationListenerService` | 在电脑上直接看手机通知，重要消息不漏 |
| 远程划掉通知 | 同上 + `cancelNotification` | 电脑上处理完，手机不再亮屏 |
| 按应用分组 / 免打扰 | `ACCESS_NOTIFICATION_POLICY` | 开会时一键静音 |

### 3. 应用与任务管理

| 能力 | 需要 | 价值 |
| --- | --- | --- |
| 当前前台应用 | `PACKAGE_USAGE_STATS`（用户手动开「使用情况访问」） | 反控台显示「电脑正在操作什么」 |
| 结束应用 | `KILL_BACKGROUND_PROCESSES` / shizuku | 手机卡顿时远程清后台 |
| 推送安装 APK | `REQUEST_INSTALL_PACKAGES` | 灰度包分发、帮家人装应用 |
| 卸载应用 | `REQUEST_DELETE_PACKAGES` + 系统确认框 | 清理流氓软件 |

### 4. 文件与媒体

| 能力 | 需要 | 价值 |
| --- | --- | --- |
| 按路径取文件 | `MANAGE_EXTERNAL_STORAGE`（「所有文件访问」） | 取日志、取录屏、传文档 |
| 相册缩略图墙 | `READ_MEDIA_IMAGES` + 缩略图 API | 在电脑上看手机照片、批量导出 |
| 推送文件到手机 | 同上 | 电脑下载的文件直接进手机 |

### 5. 通讯、定位、相机

| 能力 | 需要 | 价值 | 风险 |
| --- | --- | --- | --- |
| 通讯录搜索 / 拨号 | `READ_CONTACTS`、`CALL_PHONE` | 电脑上点名字就打电话 | 通讯录全量外泄 |
| 通话记录 | `READ_CALL_LOG` | 未接来电回拨 | Android 10+ 需默认拨号器角色 |
| 短信读写 | `READ_SMS`、`SEND_SMS` | 电脑上处理验证码/短信 | Google Play 对短信权限有单独审核，基本走不通商店分发 |
| 定位 | `ACCESS_FINE_LOCATION`（+ 后台定位） | 找手机、到家自动执行动作 | 长期轨迹泄露 |
| 远程拍照 / 录音 | `CAMERA`、`RECORD_AUDIO` | 找手机时看周围环境 | 隐私红线，必须前台可见提示 |
| 手电筒 | `FLASHLIGHT` | 找东西 | 低 |

### 6. 设备管理

| 能力 | 需要 | 价值 |
| --- | --- | --- |
| 远程锁屏 | 设备管理器 `DeviceAdminReceiver` + `lockNow()` | 手机落家里，一键锁 |
| 换壁纸 / 静音 / 调铃声 | `SET_WALLPAPER`、`WRITE_SETTINGS` | 场景化小功能 |
| 电池白名单 | `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | **长连接能不能稳定在线的关键**，不做这个断连会很频繁 |
| 精确闹钟 | `SCHEDULE_EXACT_ALARM` | 定点截图、定时上报不被延迟 |

### 7. 传感器与健康

`BODY_SENSORS` 心率、`ACTIVITY_RECOGNITION` 走路/开车识别、`HIGH_SAMPLING_RATE_SENSORS`。
价值主要在场景判断（开车时不弹通知）而非健康报告。

## 三、要有 adb / Shizuku / 系统签名，本 App 不申请

| 能力 | 权限 | 为什么不做 |
| --- | --- | --- |
| 改系统级开关（飞行模式、无障碍开关本身） | `WRITE_SECURE_SETTINGS` | 普通应用即使用 adb 授予，多数 ROM 会在重启后失效；做成默认能力会误导用户 |
| 抓全机 logcat | `READ_LOGS` | 会读到所有应用日志，含其它 App 的凭据 |
| 录系统内音 | `CAPTURE_AUDIO_OUTPUT` | 只有系统签名/root 有效 |
| 远程重启 | `REBOOT` | 同上 |
| 跳过「所有文件访问」的手动确认 | Shizuku `appops set` | 需要用户在电脑上装 Shizuku，属于进阶用法，单独出文档 |

这几项的正确做法是**文档告知怎么用 adb 自己开**，而不是在 App 里假装有按钮。

## 四、故意不做的事

1. **静默后台录屏 / 录音**：必须前台可见提示 + 通知栏常驻。没有这一步，产品性质会从
   「远程协助」变成「监控软件」，应用商店、法律和用户信任都不接受。
2. **远程擦机默认开放**：`rc.device.wipe` 存在但默认被策略挡住（`maxLevel: 3`），
   要显式放开 + 二次确认 + 手机端弹框。丢机场景可以用，误触代价太大。
3. **隐藏「正在被操作」的痕迹**：审计记录、悬浮提示、通知栏状态三者都不能关。
   用户至少要有三条独立路径发现「有人在操作我的手机」。
4. **把普通权限当特殊授权糊过去**：`notice`、`not_granted` 一律如实返回，
   不返回假成功（`lib/device-actions.js` 的 `nativeOnly()` 就是干这个的）。

## 五、授权顺序建议

用户第一次打开不应该看到 60 个权限弹窗。按能力分档引导：

1. **连接**（必须有）：网络 + 通知 + 前台服务 + 电池白名单 → 能连上、能保活；
2. **看屏幕**（核心）：屏幕采集 + 悬浮窗 → 电脑端能看到画面；
3. **能操作**（核心）：无障碍 → 电脑端能点、能打字；
4. **按需**：通知、应用、文件、通讯录、定位、相机，用到哪个开哪个；
5. **危险**：设备管理器、短信、清空手机 —— 默认全关，只在设置里逐项打开。

授权中心（`pages/capabilities/index.vue`）就是按这个顺序排的：
`连接与保活 → 屏幕镜像与输入注入 → 通知 → 应用 → 文件 → 通讯录 → 短信 → 定位 → 相机 → 传感器 → 设备控制 → 日历`。

## 六、原生层待办（`native/android/`）

1. `PilotAccessibilityService`（`BIND_ACCESSIBILITY_SERVICE`）：`dispatchGesture`、
   `ACTION_SET_TEXT`、`performGlobalAction`、`ACTION_EXPAND_NOTIFICATION_SHADE`；
2. `PilotNotificationListener`（`BIND_NOTIFICATION_LISTENER_SERVICE`）：
   通知列表 + `cancelNotification`；
3. `PilotScreenService`（`FOREGROUND_SERVICE_MEDIA_PROJECTION`）：`MediaProjection` 取帧，
   `ImageReader` + H.264 编码；
4. `PilotDeviceAdmin`（`BIND_DEVICE_ADMIN`）：`lockNow()`、`wipeData()`；
5. 一个 `PilotBridge` 把上面四个 Service 的入口暴露成 `plus.android` 可调的方法，
   `lib/device-actions.js` 里对应命令从 `nativeOnly()` 换成真实调用即可，网关与授权目录都不用改。

接通后 `manifest.json` 里 `android.permission.*` 不用动（已经全声明了），
唯一要加的是各自 `<service>` 标签与 `BIND_*` 的 intent-filter。
