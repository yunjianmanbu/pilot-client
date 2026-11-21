# Changelog

Every published version of Pilot Client, the controlled side: instead of driving the desktop from a
phone, the desktop sees and acts on the phone. The title version is the resource-bundle version; the
Android shell it needs is written in each entry.

This file is maintained by hand: add an entry at the top when a version ships. Older history lives on
the [Releases page](https://github.com/yunjianmanbu/pilot-client/releases) and on the website
(<https://pilot.medpilot.cc/>).

Chinese version: [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/).

## [1.0.5] - 2026-11-21

Resource bundle 1.0.5 (shell 1.0.3).

### Fixed

- The in-app incremental update no longer stops at 99% and never installs. The download-complete
  event now advances verification and installation instead of only repainting the progress bar, and
  progress polling, a byte-complete grace window, waiting for the file to close and timeouts around
  bridged file reads let phones that only report `state=4` or only report receive events finish the
  update.

If your phone is on 1.0.4 and the update still stops at 99%, that build carries this very defect:
use "Download in browser" on the update page once to install the full package. Incremental updates
after that work normally.

## [1.0.4] - 2026-11-21

Resource bundle 1.0.4, on the same 1.0.3 shell.

### Added

- The pairing channel is live: scan a QR code or paste a pairing code and the phone really connects
  to the desktop, reconnects after a drop and restores paired devices after a restart.

## [1.0.3] - 2026-11-19

Resource bundle 1.0.3 (shell 1.0.3). First installable build.

> **Beta.** The authorization model, the audit trail and the command gateway are implemented and
> unit-tested. Every capability that needs a native Android service (screen mirroring, input
> injection, notification reading, SMS / contacts / calls, location, camera) still returns an
> explicit `not_granted` with a hint. Nothing pretends to succeed.

### Added

- Capability catalogue with per-capability grants, a per-minute rate limit and a redacted audit log.
- Device actions behind the catalogue: screen, taps, notifications, files, device state.
- The same pairing and end-to-end transport as Pilot Link, so no new server side is needed.
