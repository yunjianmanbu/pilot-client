# Pilot Client

**English** | [中文](README.zh-CN.md)

[![CI](https://github.com/yunjianmanbu/pilot-client/actions/workflows/ci.yml/badge.svg)](https://github.com/yunjianmanbu/pilot-client/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/yunjianmanbu/pilot-client?color=blue)](https://github.com/yunjianmanbu/pilot-client/releases)
[![Discussions](https://img.shields.io/badge/discussions-open-2ea44f.svg)](https://github.com/yunjianmanbu/pilot/discussions)

**Website & installers:** <https://pilot.medpilot.cc/#client-download> — screenshots, demo video and every download.

> **Use it only on devices you own or are authorized to control.** The defaults are code, not
> promises: destructive commands sit above the policy ceiling, every level-2+ action needs an
> on-phone confirmation, and everything (including refusals) lands in a redacted audit log.
> Covert monitoring, bulk account farming and help-desk scams are out of scope, and the project says
> so in public: [`RESPONSIBLE_USE.md`](RESPONSIBLE_USE.md).

> **Beta.** Pilot Client is early: the authorization model, the audit trail and the command gateway
> are implemented and unit-tested, but every capability that needs a native Android service (screen
> mirroring, input injection, notification reading, SMS/contacts/calls, location, camera) still
> returns an explicit `not_granted` with a hint. Nothing pretends to succeed. Expect the feature set
> to change between releases.

Hand your phone to [Pilot](https://github.com/yunjianmanbu/pilot) on the computer: the desktop can see
the screen, tap it, read notifications and files, and query device state — and every one of those
actions goes through an authorization catalogue, a per-minute rate limit and a redacted audit log.

Three products share one design language:

| Product | Repository | Who controls whom | Icon |
| --- | --- | --- | --- |
| Pilot (desktop) | [`pilot`](https://github.com/yunjianmanbu/pilot) | person → computer | dark, white P, green dot |
| Pilot Link | [`pilot-link`](https://github.com/yunjianmanbu/pilot-link) | phone → computer (a remote control) | green, white P, white dot |
| **Pilot Client** (this repo) | `pilot-client` | **computer → phone (can operate the phone)** | **white, black P, black dot** |

The package name is `cc.medpilot.pilotclient`; Pilot Link is `cc.medpilot.pilot`, so both can be
installed on the same phone.

## What works today

Running and covered by unit tests:

- **An authorization catalogue of 12 capability groups** (`lib/capabilities.js`): each entry states
  what the desktop may do, its risk level, and the runtime permissions or special grants it needs;
- **A gateway for 46 `rc.*` commands** (`lib/reverse-control.js`): argument allowlists, risk ceiling,
  per-minute rate limit, timeouts, per-call confirmation, unknown commands always rejected;
- **Redacted auditing** (`lib/audit.js`): time, level, result and duration of every command, with
  clipboard text, SMS bodies, file paths and phone numbers reduced to their length; the last 200
  entries survive a restart;
- **Working command implementations** (`lib/device-actions.js`): device state, clipboard read/write,
  vibration, volume, brightness, keep-awake, toast, app list, launching apps, directory browsing;
- **Five pages**: home (grant progress + recent actions), pairing, authorization centre, control
  console (local self-test) and action log.

**Not wired to native yet** — these return `not_granted` plus a hint instead of faking success:
screen mirroring, tap/swipe/text injection, notification reading, SMS/contacts/calls, location,
camera and microphone, lock-screen wipe. Each needs a system service registered in `native/android/`
(accessibility, MediaProjection, notification listener, device admin); see the native to-do list in
[`docs/reverse-control-plan.md`](docs/reverse-control-plan.md).

## Run the checks

```bash
npm install
npm test          # capability catalogue / manifest consistency / gateway / audit / device actions / icon pixels
npm run icons     # regenerate the white-background black-P icon set (48/72/96/144/192/1024 + svg)
```

The icon script only writes `static/icons/`. Exit code 0 means everything was generated.

Packaging goes through HBuilderX or a uni-app offline build; the package name must stay
`cc.medpilot.pilotclient`.

## Three invariants

1. **Manifest and capability catalogue stay in sync** — every `<uses-permission>` in `manifest.json`
   must equal `allRuntimePermissions()` plus the `permission` of each special grant. One entry too
   many or too few fails `test/manifest.test.mjs`. Add a capability in `lib/capabilities.js` first,
   then run `npm test` to see what the manifest is missing.
2. **Every command belongs to exactly one capability** (`test/reverse-control.test.mjs`). An
   unassigned `rc.*` command would bypass the authorization centre, so it is not allowed.
3. **Unimplemented means an error** — a handler without an implementation returns `not_granted` plus
   a `hint`, never fake data. Otherwise the desktop would report "screenshot taken" while nothing
   happened.

## Authorization model

- `runtime`: normal and dangerous permissions requested through
  `plus.android.requestPermissions()`, in batches of eight so the system dialog is not overwhelming;
- `special`: opened through system settings, or requiring a native service (accessibility,
  notification listener, device admin, all-files access, overlay, modify system settings, battery
  exemption, ...);
- `advanced`: `WRITE_SECURE_SETTINGS`, `READ_LOGS`, internal audio capture or remote reboot — these
  need adb / Shizuku / a platform signature. The app **does not request them**; they are only
  documented, so that "install an app and reconfigure the system remotely" never becomes a false
  promise.

## Design notes

[`docs/reverse-control-plan.md`](docs/reverse-control-plan.md) holds the layered feature list
(implemented / available once native lands / needs special grants / deliberately not done), which
permission each feature maps to, and why some very attractive features are intentionally out of scope.

## License

[Apache License 2.0](LICENSE), copyright 2026 rigongyizu. Keep the copyright notice and the
[`NOTICE`](NOTICE) file, and state the changes in files you modified. Third-party components are
listed in [`NOTICE`](NOTICE).
