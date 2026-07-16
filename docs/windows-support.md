# Windows support

clawd now builds and ships on **macOS and Windows** from a single codebase.
This doc covers what changed to get there, how to build/release for both
platforms, and the caveats that still need eyes on a real Windows machine.

## Status

| Area | State |
| --- | --- |
| Rust core compiles on Windows | ✅ target-gated deps in place |
| Frontend (React/Tauri) | ✅ platform-neutral, unchanged behavior |
| NSIS `-setup.exe` + `.msi` bundles | ✅ produced by `tauri build` on Windows |
| CI compile-check (macOS **and** Windows) | ✅ `.github/workflows/ci.yml` matrix |
| Release pipeline (both platforms, one Release) | ✅ `.github/workflows/release.yml` |
| Cross-platform auto-update (`latest.json`) | ✅ merged from per-platform fragments |
| Visual parity of the transparent overlay on Windows | ⚠️ needs verification on real hardware (see [Caveats](#caveats)) |
| Windows code signing (Authenticode) | ⚠️ not configured — SmartScreen will warn, same spirit as the unsigned macOS DMG |

> The build/release plumbing is complete and verified as far as a Linux CI box
> allows (JSON/YAML validity, frontend `tsc + vite build`, updater-manifest
> merge, `Cargo.lock` resolution). The actual platform compiles and the
> transparent-overlay rendering are validated by the CI runners and by anyone
> testing the produced installer — they can't be exercised from the dev sandbox.

## What changed

### Rust / Cargo (`src-tauri/`)

- **`Cargo.toml`** — the `keyring` crate's native backend is target-specific, so
  it's now split per OS: `apple-native` on macOS, `windows-native` on Windows
  (Credential Manager). `session.rs` uses the same `keyring::Entry` API on both,
  so nothing downstream changed. `Cargo.lock` was refreshed to include the
  Windows backend's deps (`windows-sys`, `byteorder`).
- **`lib.rs`** — the global toggle hotkey is platform-aware: `⌘⇧C` on macOS,
  `Ctrl+Shift+C` on Windows (there is no Command key). The macOS-only
  `set_activation_policy(Accessory)` call was already `#[cfg(target_os = "macos")]`.
- Autostart needs no code change: `tauri-plugin-autostart` is initialized with
  the `MacosLauncher::LaunchAgent` argument, which is simply ignored on Windows —
  there it registers an `HKCU\...\Run` registry key instead.

### Tauri config (`src-tauri/tauri.conf.json`)

- Added a `bundle.windows` block:
  - `webviewInstallMode: downloadBootstrapper` — the installer fetches the
    WebView2 runtime if it's missing (it's preinstalled on Windows 11).
  - `nsis.installMode: currentUser` — a per-user install, no admin prompt, which
    matches the per-user autostart registry key.
- `macOSPrivateApi`, `titleBarStyle`, and the `macOS` bundle block are all
  macOS-only keys that Tauri ignores on Windows, so they're harmless there.

### Frontend (`src/`)

- User-facing strings that hard-coded "macOS" are now platform-neutral (the
  credential-store hint, the autostart toggle tooltip). No behavior change.

### Build & release scripts

- **`scripts/gen-updater-manifest.mjs`** — now auto-detects the platform and
  emits *its slice* of the updater `platforms` map as a fragment file
  (`updater-fragment-<os>.json`): macOS → `darwin-x86_64` + `darwin-aarch64`
  (one universal `.app.tar.gz`), Windows → `windows-x86_64` (the NSIS
  `-setup.exe`).
- **`scripts/merge-updater-manifest.mjs`** (new) — stitches the per-platform
  fragments into the final `latest.json` the updater polls.

## Building locally

### macOS

```sh
npm install
npm run tauri build                 # local .app + .dmg
npm run release:local               # universal DMG (both arches)
```

### Windows

```powershell
npm install
npm run tauri build                 # or: npm run tauri:build:windows
```

Outputs land in:

```
src-tauri\target\release\bundle\nsis\clawd_<version>_x64-setup.exe
src-tauri\target\release\bundle\msi\clawd_<version>_x64_en-US.msi
```

Prerequisites on Windows: **Node ≥ 20**, **Rust (stable, MSVC toolchain)**, the
**MSVC C++ Build Tools**, and the **WebView2 runtime** (preinstalled on
Windows 11).

## Release pipeline

`.github/workflows/release.yml` runs three jobs:

1. **`build-macos`** (`macos-latest`) — builds the universal DMG (+ signed
   `.app.tar.gz`/`.sig` when a signing key is present), then uploads the bundles
   and its updater fragment as workflow artifacts.
2. **`build-windows`** (`windows-latest`) — builds the NSIS `-setup.exe` and
   `.msi` (+ signed `-setup.exe.sig` when keyed), uploaded the same way.
3. **`release`** (`ubuntu-latest`, `needs` both) — downloads every artifact,
   merges the fragments into one `latest.json`, and publishes **a single GitHub
   Release** with all installers. Only this job touches the Release, so the two
   build runners never race to create it.

Triggering is unchanged — push a `v*` tag or use **Actions → Release → Run
workflow** (`workflow_dispatch`, version defaults to `package.json`).

### Updater signing

Auto-update stays **opt-in and off by default**. Only when the
`TAURI_SIGNING_PRIVATE_KEY` (+ `..._PASSWORD`) secrets are set do the builds
emit signed updater artifacts and a `latest.json`; otherwise the Release ships
installers only and the app falls back to opening the Releases page. The **same
minisign key signs both platforms** — set it up once with
`scripts/setup-updater-key.sh`.

## Caveats

- **Transparent / click-through overlay.** The wandering-cat overlay relies on a
  transparent, always-on-top, click-through window. Tauri supports all of this
  on Windows via the same cross-platform APIs the app already uses
  (`set_ignore_cursor_events`, `always_on_top`, `skip_taskbar`), but Windows
  compositing differs from macOS. Expect to fine-tune per-monitor DPI/geometry
  and confirm there's no white/black flash behind the transparent window on real
  hardware — this is the highest-risk item and can't be checked from CI.
- **Code signing / SmartScreen.** The Windows installers are **not
  Authenticode-signed** (no cert configured), so SmartScreen will warn on first
  run — the same posture as the unsigned macOS DMG. Add a cert later if desired;
  the updater signing above is independent of OS code signing.
- **Multi-monitor.** macOS and Windows report monitor work areas and scale
  factors differently; the roam/overlay geometry should be sanity-checked across
  mixed-DPI setups on Windows.
