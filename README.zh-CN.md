# Pilot Client

[English](README.md) | **中文**

**官网与下载：** <https://pilot.medpilot.cc/zh.html#client-download> —— 截图、演示视频与各平台安装包。

> **Beta（测试版）**：授权模型、审计与命令网关已经实现并有单测覆盖，但所有需要原生 Android 服务的
> 能力（屏幕镜像、点击注入、通知读取、短信 / 通讯录 / 通话、定位、相机）目前都明确返回
> `not_granted` 并给出修复提示，不会假装成功。版本之间功能集合仍会变化。

把手机交给电脑端的 [Pilot](https://github.com/yunjianmanbu/pilot) 接管：电脑端能看屏幕、点屏幕、
读通知与文件、调设备状态 —— 每一个动作都要过授权目录、每分钟限流与脱敏审计。

三个产品共用一套设计语言：

| 产品 | 仓库 | 谁控制谁 | 图标 |
| --- | --- | --- | --- |
| Pilot（桌面端） | [`pilot`](https://github.com/yunjianmanbu/pilot) | 人 → 电脑 | 深色底、白 P、绿点 |
| Pilot Link | [`pilot-link`](https://github.com/yunjianmanbu/pilot-link) | 手机 → 电脑（遥控器） | 绿底、白 P、白点 |
| **Pilot Client**（本仓库） | `pilot-client` | **电脑 → 手机（可以操作手机）** | **白底、黑 P、黑点** |

包名 `cc.medpilot.pilotclient`，与 Pilot Link 的 `cc.medpilot.pilot` 不同，两者可同机共存。

## 这一版做到了什么

已经能跑、有单测覆盖的：

- **12 类反控能力的授权目录**（`lib/capabilities.js`）：每项能力写明「电脑端能做什么」、
  风险等级、需要的普通权限与特殊授权；
- **46 条 `rc.*` 命令的网关**（`lib/reverse-control.js`）：参数白名单校验、危险等级上限、
  每分钟限流、超时、逐次二次确认、未知命令一律拒绝；
- **脱敏审计**（`lib/audit.js`）：每条命令的时间 / 等级 / 结果 / 耗时都记，剪贴板正文、
  短信内容、文件路径、手机号只留长度，最近 200 条，重启不丢；
- **真实可用的命令实现**（`lib/device-actions.js`）：设备状态、剪贴板读写、震动、音量、
  亮度、常亮、提示、应用列表、打开应用、目录浏览；
- **5 个页面**：首页（授权进度 + 最近操作）、配对、授权中心、反控台（本机自测）、操作记录。

**还没接原生层的**（会明确返回 `not_granted` + 修复提示，不会假装成功）：
屏幕镜像、点击 / 滑动 / 输入注入、通知读取、短信 / 通讯录 / 通话、定位、相机录音、锁屏清空。
这些都要在 `native/android/` 里注册系统 Service（无障碍、MediaProjection、通知监听、设备管理器），
见 [`docs/reverse-control-plan.md`](docs/reverse-control-plan.md) 的「原生层待办」。

## 跑起来

```bash
npm install
npm test          # 单测：能力目录 / 清单一致性 / 网关 / 审计 / 设备动作 / 图标像素 / 更新与启动页
npm run icons     # 重新生成白底黑 P 黑点图标（48/72/96/144/192 + icon.png 1024 + svg）与 splash.9.png
```

图标脚本只写 `static/icons/` 与 `static/splash.9.png`，不动其它目录。退出码 0 = 全部写出。
两者都进 APK：`prepare-client-android.mjs` 把图标装成 `res/mipmap-*/ic_launcher.png`、
启动图装成 `res/drawable/splash.9.png`（并删掉模板自带的 `splash.png`，同名的两个会让 aapt2 冲突）。

打包走 HBuilderX 或 uni-app 离线打包流程，包名必须保持 `cc.medpilot.pilotclient`。

离线出 APK 用仓库根目录的一条命令准备 Android 工程（包名、版本、签名、appkey、appid、权限一次改齐，
跑完打印自检表；退出码 0 = 工程就绪）：

```bash
node pilot/scripts/prepare-client-android.mjs          # 生成/更新 .build/pilot-client-android
node pilot/scripts/prepare-client-android.mjs --force  # 按 SDK 模板重新复制
```

DCloud 的离线 appkey 校验 **appid + 包名 + 证书 SHA1** 三者同时匹配，任一不符只报
「未配置AppKey或配置错误」。本项目的三元组：`__UNI__3780DD8` / `cc.medpilot.pilotclient` /
`EC:96:CE:48:53:3B:34:3D:FE:FC:8E:E9:E7:B9:FC:E7:77:81:45:41`。改签名等于改 appkey，需重新申请。

### 出包到发布（完整链路）

```bash
# 1. 用 HBuilderX CLI 生成 www（插件需为 5.34，与 Android-SDK@5.34 配套）
"/d/soft/HBuilderX.4.24.2024072208/HBuilderX/cli.exe" publish app-android \
  --type appResource --project "<仓库绝对路径>\pilot\mobile-client"
# 产物：pilot/mobile-client/unpackage/resources/__UNI__3780DD8/www

# 2. 准备离线工程（确认自检表 www 项变 ✅）
node pilot/scripts/prepare-client-android.mjs --force

# 3. 编译（签名从环境变量注入，见 .build/pilot-client-android/build-release.bat）
cd .build/pilot-client-android && cmd //c build-release.bat assembleRelease
# 产物：simpleDemo/build/outputs/apk/release/simpleDemo-release.apk

# 4. 放进发布目录并写清单 pilot/release/client-android/latest.json（version/size/sha256/url）

# 5. 发布并校验（本地校验 → 上传 → HTTPS 回拉清单+CORS+完整 SHA-256）
.\pilot\scripts\deploy-client-release.ps1 -User root -Server medpilot.cc -RemoteOwner www:www
```

`deploy-client-release.ps1` 退出码：0 = 全部一致，1 = 有校验失败，2 = 缺 `-User/-Server`（只做本地校验）。
下载卡本身由 `pilot\scripts\deploy-site.ps1` 发布；清单缺 `Access-Control-Allow-Origin: *` 时
官网只能显示静态占位值，脚本会直接判定失败。

> 脚本必须是 UTF-8 **带 BOM**：PowerShell 5.1 会把无 BOM 的 UTF-8 当 GBK 读，中文注释里的引号会吃掉后面的语法。

### 增量更新（wgt）

只改了 `pages/`、`lib/`、`App.vue` 时不用重出 30MB 的 APK，出 300KB 的 wgt 就够了：

```bash
# 1. 抬 manifest.json 的 versionName/versionCode（必须**大于**壳版本）
# 2. 生成 www（同上第 1 步）
# 3. 打 wgt：会检查版本大小关系，并打印要填进 latest.json 的 wgt 块
node pilot/scripts/pack-client-wgt.mjs --shell 1.0.1
# 4. 把打印出的 wgt 块写进 pilot/release/client-android/latest.json
# 5. 发布：脚本会校验 wgt 的 size/sha256/url 与版本关系，并回拉确认远程 wgt 与清单一致
.\pilot\scripts\deploy-client-release.ps1 -User root -Server medpilot.cc -RemoteOwner www:www
```

端上的选择规则（`lib/update.js` 的 `resolveUpdateTarget`，与 Pilot Link 同一套）：**壳落后先装全量 APK**，
壳跟上后才用 wgt。先装 wgt 会把运行版本顶到全量包的版本上，用户之后再也收不到原生修复。
运行时要靠 zip4j 解压 wgt，所以 APK 工程必须有该依赖（`prepare-client-android.mjs` 自动补）。

启动时会静默检查一次（6 小时节流），首页「版本」卡与 `pages/update` 都能手动检查、下载、安装；
下载后先校验 SHA-256 再交给 `plus.runtime.install`。

### 卡在 99% 不动的成因与现在的处理

1.0.2 及更早的更新器把「下载完成」压在一个回调上：部分机型只触发 `statechanged`
的 `state=4`、不触发 `createDownload` 的完成回调，Promise 永远不 resolve，进度就钉在
99%（下载阶段本身封顶 99）。同时校验是整文件 `readAsArrayBuffer` + 一次算摘要，
桥接层不回调时同样会卡住，而且没有任何超时。1.0.3 的 `lib/update.js` 改成：

- `state=4` 与完成回调两条路都能推进，重复触发用 `finished` 去重；
- 下载完成立刻进 `verifying`（进度 100，页面显示「正在校验更新包…」），不再停在 99%；
- 分块读取（512 KB/块）+ 增量 SHA-256（`lib/sha256.js` 的 `createSha256`），
  带 `verifyTimeoutFor(size)` 超时；只有「读文件接口整体超时且文件大小完全等于清单」
  才退回大小校验，并记住本机桥接不可用，后续不再空等；
- 下载前先删同名残留；60 秒没有新字节就中止并提示重试，不会无限挂着。

**已经在 1.0.2 上卡住的设备装不上 1.0.3**（修好的代码在新包里）。恢复路径二选一：
先在更新页点「取消下载 → 重新下载」；仍不行就用「用浏览器下载」装回
`PilotClient-1.0.1.apk`（同签名同 versionCode，覆盖安装后运行版本回到 1.0.1），
再检查更新拉 1.0.3 的 wgt。

## 三条不能破的约定

1. **清单与能力目录必须同步**：`manifest.json` 里的 `<uses-permission>` 必须等于
   `allRuntimePermissions()` 加上特殊授权的 `permission`，多一个少一个 `test/manifest.test.mjs` 都会红。
   新增能力时先改 `lib/capabilities.js`，再跑 `npm test` 看缺什么。
2. **命令必须先有归属**：每条 `rc.*` 命令必须恰好属于一项能力（`test/reverse-control.test.mjs`）。
   没归属的命令等于绕过了授权中心，不允许。
3. **没实现就报错**：handler 缺实现时返回 `not_granted` + `hint`，绝不用假数据糊过去 ——
   否则用户在电脑端看到「截图成功」，其实什么都没发生。

## 授权模型

- `runtime`：普通 / 危险权限，`plus.android.requestPermissions()` 能弹系统框，分批申请（每次 8 项）；
- `special`：要跳系统设置打开，或要原生 Service 才能生效（无障碍、通知监听、设备管理器、
  所有文件访问、悬浮窗、修改系统设置、电池白名单……）；
- `advanced`：`WRITE_SECURE_SETTINGS`、`READ_LOGS`、录内音、远程重启这类需要 adb / Shizuku /
  系统签名，本 App **不申请**，只在方案文档里列出，避免把「装个 App 就能远程改系统设置」写成假承诺。

## 反控功能方案

见 [`docs/reverse-control-plan.md`](docs/reverse-control-plan.md)：分层功能清单（已实现 / 接原生即得 /
需特殊权限 / 不建议做）、每条功能对应哪个权限、以及为什么有些「很有用」的功能故意不做。

## 许可

[Apache License 2.0](LICENSE)，版权归 2026 rigongyizu。你需要保留版权声明与 [`NOTICE`](NOTICE)
文件，并在修改过的文件里注明改动。第三方组件见 [`NOTICE`](NOTICE)。
