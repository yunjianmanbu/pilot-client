# Pilot Client

[English](README.md) | **中文**

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
npm test          # 单测：能力目录 / 清单一致性 / 网关 / 审计 / 设备动作 / 图标像素
npm run icons     # 重新生成白底黑 P 黑点图标（48/72/96/144/192/1024 + svg）
```

图标脚本只写 `static/icons/`，不动其它目录。退出码 0 = 全部写出。

打包走 HBuilderX 或 uni-app 离线打包流程，包名必须保持 `cc.medpilot.pilotclient`。

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

[Apache License 2.0](../LICENSE)，版权归 2026 rigongyizu。你需要保留版权声明与 [`NOTICE`](../NOTICE)
文件，并在修改过的文件里注明改动。第三方组件见 [`NOTICE`](../NOTICE)。
