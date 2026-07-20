# 🐱 clawd

[**English**](README.md) | [한국어](README.ko.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Latest Release](https://img.shields.io/github/v/release/NextChans/clawd)

> A cute floating cat that lives on your Mac and reacts to how hard you're driving Claude.

A tiny, frameless, always-on-top cat that wanders your desktop and changes its
mood with your Claude usage. Quiet → it plays and (at night) naps; burning
tokens → it perks up, then hisses; nearing your session limit → it tires out.
It reads your local **Claude Code** logs, and can optionally track your **5-hour
session & weekly limits** — which also covers claude.ai **web** usage. By
default it **roams** — clicks pass straight through and the cat wanders on its
own — until you **grab** it (**⌘⇧C** or the tray) to drag, pet, or configure it.
Play with it via a **🎣 fishing wand** and **🍚 feeding** from the tray, and
invite friends' cats over the **network**.

```
   /\_/\     clawd watches ~/.claude/projects/**/*.jsonl (ccusage-style
  ( o.o )    token+cost aggregation, re-implemented in Rust), optionally
   > ^ <     reads your session/weekly limits, and maps it onto a 7-state cat.
```

## Contents

- [Screenshots](#screenshots)
- [Features](#features)
- [Install](#install) · [First run (Gatekeeper)](#first-run-gatekeeper)
- [Concept](#concept) · [Cat states](#cat-states)
- [Requirements](#requirements) · [Run](#run) · [Build](#build) · [Release process](#release-process)
- [Permissions (macOS)](#permissions-macos)
- [Usage](#usage) · [Tuning thresholds](#tuning-thresholds)
- [Session usage (experimental)](#session-usage-experimental)
- [Cat art & coat colors](#cat-art--coat-colors) · [How usage is computed](#how-usage-is-computed)
- [Project layout](#project-layout) · [Known limitations](#known-limitations)
- [Changelog](#changelog) · [Roadmap](#roadmap)
- [Contributing](#contributing) · [Acknowledgments](#acknowledgments) · [License](#license)

## Screenshots

**On your desktop** — the cat roams, its mood tracks your activity, and a tap shows a status tooltip.

![clawd — a cat roaming the desktop with a status tooltip](docs/screenshots/roam.png)

**Usage dashboard** — 5-hour session & weekly gauges, today/week/month tokens, and model · hourly · weekly-activity charts.

![clawd — the usage dashboard with session gauges and charts](docs/screenshots/details.png)

**Fishing play** — move a teaser wand with your cursor and the cat chases the dangling lure.

![clawd — fishing (teaser wand) play](docs/screenshots/fishing.png)

---

## Features

- **🎨 5 coat colors** — cream · black · orange tabby · gray tabby · white,
  swappable live from the details window.
- **🐈 10+ expressive poses** — sit · walk · run · sleep · alert · angry ·
  exhausted · blink · yawn · stretch · pounce · startled · eating · purr …
- **🚶 Screen wandering** — animated walk/run gaits, direction flip, eased random
  walk clamped to the work area.
- **🛋️ State-driven furniture** — a cushion (sleeping), cat tower (alert/angry),
  and food bowl (exhausted/feeding) appear on cue; the tower **evolves through
  three tiers** with daily usage.
- **🐾 Furniture visits** — while it's up and about (curious / active / playing),
  the cat also randomly trots over to a prop — cat tower, cushion, or bowl —
  that fades in for the visit, plays there, then leaves, the same way it chases a
  drifting plaything.
- **🦋 Playthings** — a butterfly, ball, yarn, or bird drifts by and the cat
  chases (and pounces on) it.
- **✨ Micro-events** — ear wiggles, look-backs, and hard blinks keep the resting
  cat alive.
- **🌙 Day/night rhythm** — winds down and naps at night when idle, stretches in
  the morning; during the day an idle cat stays up and plays. A short launch
  grace means it never opens already asleep.
- **🎣 Fishing play** — from the tray, wave a teaser wand with your cursor; the
  feather dangles on a string with real physics and the cat chases it. The
  overlay stays click-through, so other apps stay clickable while you play
  (re-click the tray item to end).
- **🍚 Feeding & 🖐️ petting** — feed from the tray (the cat trots to its bowl);
  hover/hold it in Grab mode for a purr — petting floats up hearts.
- **⚡ Usage reactions** — the cat reacts to your Claude activity in the moment: a
  sudden token burst gives it the **zoomies**, and a fresh **5-hour session
  window** (session-usage integration on) gets a wake-up **stretch**.
- **🎉 Celebrations** — confetti when the **cat-tower evolves** (today's tokens
  cross into a higher tier), plus a hidden **party** if you rapid-click the cat.
- **📊 Session-usage integration (experimental)** — optionally show your **5-hour
  session** and **weekly** limits as live gauges, with a heads-up notification
  near the cap. Because it uses a Claude Code OAuth token, it also reflects
  claude.ai **web** usage — and the cat perks up while you're actively using
  Claude. See [Session usage](#session-usage-experimental). Off by default.
- **📈 Usage visualization** — session/weekly gauges, today/week/month tokens,
  model donut, hourly sparkline, weekly heatmap, and a "vs. yesterday" delta.
- **🐈‍⬛ Social mode (experimental)** — opt in and friends' clawd cats wander onto
  your screen, each showing a nickname and a *coarse* activity vibe (🔥 busy /
  💤 idle). **On the LAN** it's zero-config over mDNS; for friends on **other
  networks**, open an invite-code **room** (P2P over [iroh](https://iroh.computer),
  a public relay as fallback — or [your own relay](docs/self-hosted-relay.md) if
  a firewall blocks the public ones) — **no server of ours**. Only a nickname, coat
  color, mood, and activity bucket are shared; **never** token counts, cost, or
  project names. Off by default.
- **🔄 Auto-update** — checks GitHub Releases on launch and one-click installs a
  signed new build (falls back to opening the Releases page when unsigned).
- **📏 Adjustable size** — a 50–200% character-size slider.
- **🖥️ Multi-monitor** — spawns on the display your cursor is on; "이 화면으로
  이동" re-homes it to the current screen.
- **🚀 Auto-start** — optional macOS Login Item.
- **🔒 Private by design** — no login and no network calls for local stats: it
  parses your `~/.claude` logs and nothing leaves your machine. The two opt-in
  exceptions are Social mode (shares only coarse signals) and the session-usage
  integration (talks to the Anthropic API with a token you provide, stored in
  the macOS Keychain).

---

## Install

**macOS** — grab the latest **`.dmg`** from the
[**Releases**](https://github.com/NextChans/clawd/releases) page, open it, and
drag **clawd.app** into `/Applications`. The build is a **universal binary**
(Apple Silicon + Intel).

**Windows** — grab the latest **`-setup.exe`** (NSIS) from the same
[**Releases**](https://github.com/NextChans/clawd/releases) page and run it (a
per-user install, no admin needed). An `.msi` is also published if you prefer
it. See [docs/windows-support.md](docs/windows-support.md) for details and
current caveats.

> The `.dmg` is **not code-signed or notarized** (no Apple Developer account),
> so macOS Gatekeeper will complain on first launch — see below.

## First run (Gatekeeper)

Because the app is unsigned, double-clicking it the first time shows
*"clawd" cannot be opened because it is from an unidentified developer* (or
*"is damaged"* on newer macOS). To get past it **once**:

1. In `/Applications`, **right-click** (or Ctrl-click) **clawd.app** → **열기 / Open**.
2. In the dialog, click **그래도 열기 / Open** again.

macOS remembers the choice, so subsequent launches open normally. If the
right-click route is blocked, you can also clear the quarantine flag manually:

```sh
xattr -dr com.apple.quarantine /Applications/clawd.app
```

clawd is a **menu-bar app** (no dock icon) — after launch, look for the 🐾/✋
tray icon. It **checks for updates on launch** and via **tray → 새 버전 확인…**;
when a signed newer build exists you get a one-click update in the details
window, otherwise it falls back to opening the Releases page in your browser.

---

## Concept

- **Floating, no chrome** — transparent background, no title bar, no shadow.
- **Mood = usage** — the cat animates by your token **rate** (tokens/min over
  the last 5 min) and the **time of day**; with the optional session-usage
  integration on, nearing your **5-hour session limit** tires it out too, and it
  perks up whenever your usage is actively climbing (incl. claude.ai web).
- **Two modes — Roam ↔ Grab** (plus a transient **🎣 Fishing** play session from
  the tray):
  - **🐾 Roam** (default) — the window is **click-through** (mouse events pass to
    whatever's behind it) and the cat **wanders the screen on its own**. It never
    gets in your way.
  - **🖐️ Grab** — the cat becomes interactive and holds still: hover for stats,
    drag to move it, click to open details. A glowing ring marks Grab mode.
  - Toggle with **⌘⇧C** or the tray. Roam ↔ Grab flips instantly; a short badge
    confirms the switch.
- **Screen wandering** — in Roam mode the cat window is a full-screen,
  transparent, click-through **overlay**, and the cat strolls around *inside* it
  via GPU-accelerated CSS transforms (60fps, no janky native window moves). It
  **walks / runs** with an animated gait, flips to face its heading, and is
  clamped to the active monitor's work area (never behind the menu bar or dock).
  How lively it wanders tracks its mood: `playing` strolls, `active` dashes
  (running), `angry` fidgets in place, `exhausted` barely shuffles, `sleeping`
  stays put.
- **Menu-bar app** — no dock icon; control it from the tray.

## Cat states

| State       | When                                                        | Look                          |
|-------------|-------------------------------------------------------------|-------------------------------|
| `sleeping`  | **at night** (22:00–06:00) and idle > 15 min                | eyes closed, `z z z`, slow    |
| `playing`   | the launch/greeting hello (and the night launch grace)      | happy eyes, sparkle, fast tail|
| `curious`   | very low / no rate — the **daytime idle resting mood**      | wide eyes, `?`                |
| `active`    | rate > `mid`, **or** session usage actively climbing        | open eyes, gentle smile       |
| `alert`     | rate > `high`                                               | big eyes, raised ears, `!`    |
| `angry`     | rate > `veryHigh`                                           | flat ears, fangs, hiss        |
| `exhausted` | sustained high rate for ~30 min, **or** session ≥ 90%       | `><` eyes, sweat drop         |

Mood is picked from whichever signal reads more intense. During the day an idle
cat **pokes around (curious)** rather than sleeping — as your rate climbs past
`mid / high / veryHigh` it steps up to active / alert / angry from there; `playing`
is reserved for the launch greeting. Sleeping is reserved for a quiet night. The
session-based conditions only apply when the (opt-in) session-usage integration
is on.

## Requirements

- **macOS or Windows** (built and tuned for both). See
  [docs/windows-support.md](docs/windows-support.md) for the Windows specifics.
- **Node ≥ 20** — `node --version`
- **Rust (stable)** — `rustc --version`. If missing:
  ```sh
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
  ```
- **macOS:** Xcode Command Line Tools — `xcode-select --install`
- **Windows:** the MSVC C++ Build Tools and WebView2 runtime (preinstalled on
  Windows 11; the installer fetches it if absent). See the Windows doc above.

## Run

```sh
npm install
npm run tauri dev
```

## Build

```sh
npm run tauri build
```

The bundled `.app` and `.dmg` land in `src-tauri/target/release/bundle/`
(**unsigned** — see [First run](#first-run-gatekeeper)).

To produce the **universal** (Apple Silicon + Intel) DMG that Releases ship —
the same artifact CI builds — and open the output folder:

```sh
npm run release:local
# → src-tauri/target/universal-apple-darwin/release/bundle/dmg/
```

> Universal builds compile the Rust core **twice** (both arches), so expect
> 5–15 min, especially the first time.

## Release process

Releases are built by GitHub Actions (`.github/workflows/release.yml`) on two
runners in parallel — `macos-latest` builds the **universal DMG** (+ signed
`clawd.app.tar.gz` + `.sig`) and `windows-latest` builds the **NSIS `-setup.exe`
and `.msi`** (+ signed `-setup.exe.sig`). A final job merges the per-platform
updater fragments into one `latest.json` and publishes a single Release with
auto-generated notes. Two ways to trigger it:

- **Push a `v*` tag** (classic):
  ```sh
  npm run version:bump 0.11.1   # syncs package.json + Cargo.toml + tauri.conf.json
  cd src-tauri && cargo metadata --format-version 1 >/dev/null && cd ..  # refresh Cargo.lock
  git commit -am "chore: bump to 0.11.1"
  git tag v0.11.1 && git push && git push --tags
  ```
- **Or `workflow_dispatch`** — no tag push needed: bump + merge the version, then
  **Actions → Release → Run workflow** (branch `main`; version defaults to
  `package.json`). The workflow mints the `v<version>` tag itself — handy when
  you can't push tags from where you're working.

Watch the run under the **Actions** tab; the assets appear on the Release once
it's green.

> **Cost note:** macOS Actions minutes are limited on the free tier and
> universal builds are slow (~15 min), so release deliberately, not per commit.

**Fallback** if CI is unavailable — build and publish locally with the `gh` CLI:

```sh
npm run release:local   # or: npm run tauri:build:universal
gh release create v0.11.1 --generate-notes \
  src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg
```

## Permissions (macOS)

- **Notifications** — only used by the optional session-usage integration, for
  the heads-up when your **5-hour session or weekly usage crosses ~90%**. Allow
  when prompted the first time it fires; if you never connect the integration,
  no notifications are sent.

That's it — the **⌘⇧C** hotkey uses Tauri's global-shortcut plugin and needs
**no Accessibility permission**. (Earlier builds used an `rdev` keyboard monitor
for an Option-key hold; that was removed — see the changelog.)

## Usage

- **🐾 Roam mode (default)** → the cat is **click-through** (mouse events pass to
  the window behind it) and **wanders the screen on its own**. It never gets in
  your way.
- **⌘⇧C** (or tray → *🖐️ 잡기 (Grab)*) → switch to **Grab mode**. Wandering stops,
  a glowing ring appears, and the cat becomes interactive:
  - **hover** → tooltip with today's tokens / cost / rate
  - **drag** → move the cat (position is remembered across launches)
  - **click** → open the details window
- **⌘⇧C** again (or tray → *🐾 놀기 (Roam)*) → back to Roam; the cat resumes
  wandering from wherever you left it.
- **Tray menu** → the cat's home base:
  - **🐾 놀기 (Roam) / 🖐️ 잡기 (Grab)** — switch modes.
  - **🎣 낚시대 놀이** — start fishing play (move your cursor to wave the wand;
    click the item again to stop). The overlay stays click-through while you
    play, so other apps remain clickable — the lure tracks the cursor via a Rust
    60fps poll rather than by capturing pointer events.
  - **🍚 먹이 주기** — feed the cat (it trots to its bowl; 60 s cooldown).
  - Show/hide the cat, reset position, **이 화면으로 이동** (move to the current
    screen), **상세 · 설정…** (details/settings), check for updates, quit.
  - The tray tooltip and a menu-bar glyph (🐾 / ✋ / 🎣) show the current mode.

## Tuning thresholds

Open the details window (⌘⇧C then click the cat, or tray → *상세 · 설정*):

- **Cat color** — pick one of the five coats.
- **Character size (캐릭터 크기)** — 50–200% render scale for the cat sprite.
- **Auto-start (로그인 시 자동 시작)** — register/unregister the macOS Login Item.
- **State thresholds (tokens/min)** — `curious / active / alert / angry` cutoffs.
  `exhausted` is entered automatically when the rate stays above the `alert`
  threshold for a sustained ~30 min window.

Settings persist via the Tauri store (`config.json` in the app config dir) and
sync live between the cat and details windows.

> **Note on token counts:** totals include `cache_read` tokens, which are cheap
> but voluminous, so tokens/min runs large during active sessions. The default
> thresholds account for this; tune to taste.

## Session usage (experimental)

Claude subscription usage — your rolling **5-hour session** window and **weekly**
limit — has no official public API, so this is opt-in and best-effort. clawd
does what Claude Code does internally: with a **Claude Code OAuth token** it
makes one tiny Messages request and reads the rate-limit headers off the
response.

**Set it up** in the details window, under *세션 사용량 연동 (실험)*:

1. In a terminal, run `claude setup-token` and copy the `sk-ant-oat01…` token.
2. Paste it into the panel and hit **저장**. The token is stored in the **macOS
   Keychain** — never in the config file, never shared.

Once connected you get live **5-hour / weekly gauges** at the top of the details
window, a **near-cap notification** (~90%), and the cat's mood reacts to your
real usage — including **claude.ai web** usage the local logs can't see (the cat
perks up while usage climbs, and tires as you approach the cap).

> **Caveats.** The endpoint + header names are undocumented and may change
> without notice — if they do, clawd just shows a diagnostic and falls back to
> your local logs. Each check sends one `max_tokens: 1` request (~60 s polling).
> The values track the *Claude Code token's* limits, which can differ from the
> numbers on claude.ai's settings page. Disconnect any time with **연동 해제**.

## Cat art & coat colors

The cat renders from **PNG sprites** in `src/assets/cat/<color>/<pose>.png`,
falling back to a built-in **vector cat** (`CatSvg.tsx`) for any sprite that
isn't present — so the app runs fine with the sprite folders empty and you can
fill them in incrementally.

- **Colors** (pick in the details window; persists in config, live-syncs to the
  cat): `cream` · `black` · `orange_tabby` · `gray_tabby` · `white`.
- **Poses**: the core rig — `sit_forward`, `walk_right_a/b`, `run_right_a/b`,
  `sleep_curled`, `alert_arched`, `angry_hiss`, `exhausted_lie` — plus
  expressive one-offs for flourishes and interactions (`yawn`, `stretch`,
  `blink`, `startled`, `playing_pounce`, `eating`, `happy_purr`). Walk/run are
  two-frame flip animations; side poses face right and mirror automatically; any
  sprite that's missing falls back to the vector cat.

See **[`src/assets/cat/README.md`](src/assets/cat/README.md)** for the exact
file layout, image requirements (transparent, square, centered), and a ready-to-
use **Nano Banana / Gemini image prompt** for generating a consistent set.

## How usage is computed

`src-tauri/src/usage.rs` walks `~/.claude/projects/**/*.jsonl`, and for each
assistant turn with a `usage` block it:

1. dedupes by `message.id` + `requestId` (the same message can appear in
   multiple files),
2. prices it from a hardcoded per-model table (Opus / Sonnet / Haiku families;
   see `price_for`),
3. buckets it into today / last-5-min / week / month, plus a "session active in
   the last 30s" flag.

The frontend polls this every 30 s (Rust emits a `usage` event).

The optional **session/weekly limits** come from a separate source
(`src-tauri/src/session.rs`): the rate-limit headers on the Anthropic Messages
API, read with a Claude Code OAuth token — see
[Session usage](#session-usage-experimental). That path is off unless you
connect a token.

### Pricing (USD per 1M tokens, approximate)

| Family | Input | Output | Cache write | Cache read |
|--------|------:|-------:|------------:|-----------:|
| Opus   | 15.00 | 75.00  | 18.75       | 1.50       |
| Sonnet |  3.00 | 15.00  |  3.75       | 0.30       |
| Haiku  |  0.80 |  4.00  |  1.00       | 0.08       |

Unknown models fall back to Sonnet pricing. Update `price_for` in `usage.rs`
when prices change.

## Project layout

```
clawd/
├─ index.html
├─ src/                      # React + TS frontend
│  ├─ main.tsx               # routes cat vs. details window (?window=details)
│  ├─ App.tsx                # cat overlay: wander, fishing play, tooltip, alerts
│  ├─ Details.tsx            # details + settings window (gauges, charts, knobs)
│  ├─ types.ts               # Usage / Config / CatState / Peer + defaults
│  ├─ hooks/
│  │  ├─ useUsage.ts         # local-log usage + `usage` event
│  │  ├─ useConfig.ts        # Tauri store config, synced across windows
│  │  ├─ useUpdater.ts       # self-update (check / download / install)
│  │  ├─ useCatState.ts      # usage (+ session) → CatState classifier
│  │  ├─ usePresence.ts      # social mode: LAN + remote rooms
│  │  ├─ useSessionUsage.ts  # 5h/weekly gauges via an OAuth token
│  │  └─ useSessionAlert.ts  # near-cap notification
│  ├─ components/
│  │  ├─ Cat/                # PNG sprite cat + vector fallback
│  │  ├─ Charts/             # model donut, hourly sparkline, weekly heatmap
│  │  ├─ Playthings/         # butterfly, ball, yarn, bird, fishing lure
│  │  ├─ Furniture/          # cushion, tiered cat tower, food bowl
│  │  └─ Peers/              # visiting peer cats
│  └─ utils/format.ts
├─ scripts/
│  ├─ bump-version.mjs       # sync version across the three manifests
│  ├─ setup-updater-key.sh   # one-time updater signing-key setup (run manually)
│  └─ gen-updater-manifest.mjs  # build latest.json from the signed artifacts
└─ src-tauri/                # Rust backend
   ├─ src/
   │  ├─ lib.rs              # windows, Roam/Grab/Fishing modes, hotkey, poller
   │  ├─ roam.rs             # wander scheduler (emits cat-wander events)
   │  ├─ usage.rs            # ccusage-style local-log aggregation
   │  ├─ session.rs          # 5h/weekly limits via API rate-limit headers
   │  ├─ presence.rs         # social mode (mDNS LAN + iroh remote rooms)
   │  └─ tray.rs             # menu-bar tray (modes, feed, status)
   ├─ tauri.conf.json        # cat + details window config + updater endpoint
   └─ capabilities/default.json
```

## Known limitations

- **Cat art + gaits are a hand-drawn draft.** Playing / alert / angry read
  clearly; the other four states are lightweight variations. The walk / run /
  jitter gaits are an initial pass (body bob + alternating paws + tail) — good
  enough to read as motion, but ripe for refinement.
- **One monitor at a time.** The overlay spawns on the display your cursor is on
  and can be re-homed with **tray → 이 화면으로 이동**, but it lives on a single
  monitor — the cat won't wander across displays simultaneously, and automatic
  re-homing on display reconfiguration is best-effort (fires on DPI/scale
  changes).
- The log scan re-reads all files every 30 s — fine for typical histories, but
  not incremental. Large histories could be cached by mtime later.
- macOS only. Windows/Linux would need a different global-shortcut strategy.
- Prices are hardcoded approximations; verify against current Anthropic pricing.

## Changelog

- **v0.12.3** — **Reverted multi-monitor changes.** v0.12.0 introduced
  positioning regressions — the cat vanished when opening feed / fishing / grab,
  flickered away on first launch, and disappeared intermittently — because the
  union-bounds overlay coordinate system was misaligned. Reverted `lib.rs` /
  `roam.rs` to the v0.11.7 single-display baseline; the cat is back to spawning
  on the cursor's display with "이 화면으로 이동" re-homing. Multi-monitor
  wandering will be re-attempted with a corrected coordinate system. (Also folds
  in the v0.12.2 release-pipeline fix: `version:bump` now syncs `Cargo.lock` so
  CI's `cargo check --locked` passes.)
- **v0.11.7** — **Fishing play stays click-through.** Previously the fishing
  overlay captured the cursor, blocking clicks on other apps. Now the overlay
  stays click-through (like Roam) and the lure tracks the cursor via a Rust
  60fps polling + `fishing-cursor` event pipeline. Other apps remain interactive
  throughout. End the session from the tray menu (Esc removed — the overlay no
  longer receives key events).
- **v0.11.6** — **Remote-room polish.** The nickname field was hidden unless LAN
  presence ("네트워크에서 친구 초대") was on, but remote rooms broadcast the
  nickname too — so remote-only users were stuck with a generated `cat-1234`
  name; it's now always editable. Also stopped your **own cat showing up as a
  visitor** when a payload loops back through a room (self-echo is now dropped)
  (#39).
- **v0.11.5** — **Fix remote rooms never getting a relay.** iroh 0.11's built-in
  default relays point at n0's old `*.relay.n0.iroh.iroh.link` hostnames, whose
  TLS cert no longer matches (n0 moved to `*.relay.n0.iroh.link`) — so the relay
  handshake failed, the endpoint never got a home relay, and **cross-network
  rooms sat stuck on 🟡 "릴레이 없음"** (LAN rooms were unaffected). clawd now
  ships the corrected n0 relay map itself, so remote rooms link up out of the
  box again — no custom relay needed (#38).
- **v0.11.4** — **Custom relay for stubborn networks.** Remote rooms can now
  point at a **self-hosted iroh relay** (상세 · 설정 → 원격 방 → 고급) so rooms
  link up on networks that block n0's public relays — the "🟡 릴레이 없음" case.
  Both peers set the same URL; empty keeps the public relays. Clearer relay
  diagnostics and an actionable no-relay hint. Setup guide:
  [`docs/self-hosted-relay.md`](docs/self-hosted-relay.md) (#37).
- **v0.11.3** — **Curious is the daytime baseline.** An idle daytime cat now
  rests as `curious` (기웃기웃) — poking around rather than the higher-energy
  `playing` — and steps up to active/alert/angry as your usage climbs; `playing`
  is kept for the launch greeting. Furniture visits fire in this resting mood
  too (#35).
- **v0.11.2** — **Furniture visits during play.** Beyond the mood-anchored
  furniture, the cat now randomly trots over to a cat tower, cushion, or bowl
  that fades in for the visit — the same "goes and plays with it" treatment as a
  drifting plaything — so free roam feels less empty (#33).
- **v0.11.1** — **Day/night rhythm + polish.** Naps only at night when idle and
  plays during the day, with a launch grace so it never opens already asleep
  (#26). Roaming now spreads across the whole screen instead of hugging the
  right edge (#27). A cat-toned notification when your 5-hour/weekly usage nears
  ~90%, plus a richer first-run onboarding hint (#28). Launches off the corner
  so its bubbles don't clip (#29).
- **v0.11.0** — **Session-usage integration + details redesign.** Optional
  5-hour/weekly limit **gauges** via a Claude Code OAuth token (stored in the
  Keychain), with the cat's mood driven by whether usage is actively *climbing*
  — so it reflects claude.ai **web** usage too (#20–#23). The teaser-wand fishing
  play got real dangling physics (#19). The details window was regrouped
  (session gauges up top, labelled sections) and **먹이 주기 moved to the tray**
  next to fishing (#24).
- **v0.10.0** — **Fishing play + tag-free releases.** A **🎣 teaser-wand** play
  mode: move the wand and the cat chases the lure (#17). Ball play now throws the
  ball *before* the cat chases it (#15). Releases can be cut via
  `workflow_dispatch` (Actions → Run workflow) with no tag push required (#16).
- **v0.9.0** — **Reliable remote rooms.** A visiting cat no longer vanishes
  mid-session — both sides re-dial a stalled link (message-freshness based, and
  the room opener re-dials too), fixing the "🟢 connected but the cat
  disappeared" case (#12–#13).
- **v0.8.0** — **Remote social rooms (WAN).** Invite a friend on another network
  with a room code — P2P over [iroh](https://iroh.computer) (QUIC hole-punching,
  a public relay as fallback), with connection/relay diagnostics in the UI.
  Sleeping cats now curl up in the bottom-right corner, out of the way.
- **v0.7.0** — **LAN social mode.** Opt in and other clawd cats on your network
  wander onto your screen in 2D and come over to play; discovery is server-less
  over mDNS, sharing only coarse signals. Added a CI build-check.
- **v0.6.0** — **Signed auto-update, character size, multi-monitor.** Turned on
  real signed updater artifacts (`.app.tar.gz` + `.sig` + `latest.json`) so the
  tray "새 버전 확인" and the launch-time check install a new build in place
  (one click) — auto-update works from this release onward. Added a **50–200%
  character-size slider** and **cursor-aware multi-monitor placement** with a
  new **이 화면으로 이동** tray item. Signing is set up once via
  `scripts/setup-updater-key.sh`.
- **v0.5.0** — **Automated DMG releases + in-app update check.** Pushing a
  `v*` tag now builds a **universal (Apple Silicon + Intel) DMG** on GitHub
  Actions and publishes a Release with the DMG attached
  (`.github/workflows/release.yml`). Added `scripts/bump-version.mjs`
  (`npm run version:bump <ver>`) to keep the version in lockstep across
  `package.json`, `src-tauri/Cargo.toml`, and `tauri.conf.json`, plus
  `npm run release:local` for a one-shot local universal build. New tray item
  **새 버전 확인…** opens the Releases page in the browser (the repo is private,
  so this rides the user's existing GitHub session rather than an unauthenticated
  API call). Builds are still **unsigned** — the README documents the Gatekeeper
  first-run step.
- **v0.4.0** — **PNG sprite cat + coat colors + tooltip auto-flip + tray title
  sync.** The cat now renders from **PNG sprites**
  (`src/assets/cat/<color>/<pose>.png`) so the character can be authored as real
  art (e.g. Nano Banana / Gemini image) instead of hand-drawn SVG — with a
  built-in **vector fallback** (`CatSvg.tsx`) for any sprite not present yet, so
  the app runs before the art arrives and degrades gracefully. Walk/run are
  two-frame flip animations; side poses face right and mirror with `scaleX(-1)`.
  Added **5 coat colors** — cream, black, orange & gray tabbies, white —
  selectable from a new swatch picker in the details window (persists in config,
  live-syncs to the cat window); each color is a folder of sprites (and a themed
  palette for the vector fallback). Along the way the vector cat was also redrawn
  chunky/sticker-style with per-pose viewpoints. The **tooltip now auto-flips**:
  it measures the cat against the (small, edge-clamped) grab window and hugs the
  near edge — or drops below the cat — so it never clips off-window (it also
  fades only now, so framer-motion no longer clobbers the centering transform).
  The **tray title** reliably reflects the mode (🐾 Roam / ✋ Grab) — macOS
  wouldn't clear a `None` title, so the "✋" suffix used to stick after switching
  back to Roam.
- **v0.3.0** — **Full-screen overlay + smooth walking/running animation.**
  Reworked wandering from the ground up. The cat window is now a screen-sized,
  transparent, **click-through overlay** and the cat moves *within* it via
  GPU-accelerated CSS `translate3d` transitions — no more nudging the native
  window every frame (which never animated smoothly on macOS). Rust
  (`roam.rs`) is now just a scheduler: every few seconds it emits a `cat-wander`
  event (target, duration, direction, gait) and the browser tweens there at
  60fps. Added **walk / run / jitter** SVG gaits (body bob, alternating paws,
  livelier tail) plus **direction flip** so the cat faces where it's going,
  scaled to mood. Grab mode shrinks the overlay back down around the frozen cat
  (interactive again), then re-expands to full-screen on return — click-through
  is asserted before every resize so **other windows are never blocked** (0
  interference preserved). Tooltip / badge / first-run hint now ride with the
  cat. Primary monitor only for now (see limitations).
- **v0.2.0** — **Roam ↔ Grab modes + screen wandering.** Replaced the old
  "pin" concept with two clear states: **Roam** (default — click-through and the
  cat auto-wanders the screen) and **Grab** (interactive and frozen for
  drag/click/settings). Wandering is a smooth eased random walk clamped to the
  active monitor's work area, with liveliness driven by the cat's mood (`roam.rs`).
  Toggle via **⌘⇧C** or the redesigned tray (Roam/Grab radio + status suffix).
  Also: widened the cat window (240×210) and re-anchored the tooltip inside it so
  stats no longer clip, added mode-switch badges, and a first-run hint.
- **v0.1.1** — Removed the `rdev` global keyboard monitor. It called macOS
  Text Services (`TSMGetInputSourceProperty`) off the main thread, which
  tripped `dispatch_assert_queue` and crashed the app (`SIGTRAP`) whenever a
  screenshot tool (⌘⇧3/4/5) launched or the Option key was pressed. Grab mode
  is now driven solely by the **⌘⇧C** global shortcut (Tauri's
  `global-shortcut` plugin, no Accessibility permission needed), with a glowing
  ring for visual feedback.
- **v0.1.0** — Initial scaffold: floating cat + ccusage integration.

## Roadmap

**Done**

- [x] Roam ↔ Grab modes + full-screen click-through overlay
- [x] Smooth walk/run wandering, direction flip, whole-screen coverage
- [x] Day/night sleep rhythm + launch grace
- [x] 5 coat colors + PNG sprites (vector fallback)
- [x] State-driven furniture (cushion / tower / bowl) + tower tier evolution
- [x] Playthings, micro-events, time-of-day personality
- [x] Petting, feeding, and **🎣 fishing** play (cursor-driven, physics lure)
- [x] Usage viz — session/weekly gauges, model donut, sparkline, heatmap, delta
- [x] **Social mode** — LAN (mDNS) + remote invite-code rooms (iroh P2P)
- [x] **Session-usage integration** — 5h/weekly gauges, activity-aware mood,
      near-cap notification (covers claude.ai web usage)
- [x] Automated universal DMG releases (tag **or** `workflow_dispatch`)
- [x] In-app **auto-update** with signed artifacts
- [x] Adjustable character size · cursor-aware multi-monitor · auto-start

**Next up**

- [ ] Wander across **multiple monitors** simultaneously (not just re-home)
- [ ] Team dashboard — several cats splitting shared usage
- [ ] A companion **CLI** (`clawd status`) for headless usage
- [ ] Daily / weekly usage **summary card**
- [ ] **Notarize** the app so Gatekeeper stops warning on first launch
- [ ] Richer / Lottie animations and more distinct per-state poses
- [ ] Optional sounds (meow, hiss), off by default
- [ ] Incremental log tailing instead of full rescans
- [ ] Windows / Linux support

## Contributing

Fork-and-PR welcome — bug fixes, new poses/colors, and animation polish
especially.

1. **Fork** and branch off `main`.
2. Make your change and keep the two gates green:
   ```sh
   cargo fmt --manifest-path src-tauri/Cargo.toml   # Rust formatting
   npm run build                                    # tsc typecheck + vite build
   ```
   (a `cargo check` in `src-tauri/` doesn't hurt either).
3. Match the surrounding style — the code leans on doc comments that explain the
   *why*; please keep that up for non-obvious logic.
4. Open a PR with a short description and, for anything visual, a screenshot or
   clip. New art goes under `src/assets/cat/<color>/` — see that folder's README.

**Issues:** include your macOS version, how you installed (DMG vs. local build),
and steps to reproduce. Feature ideas are welcome too — check the roadmap first.

## Acknowledgments

clawd stands on some excellent work:

- **[Tauri](https://tauri.app)** — the Rust + WebView shell that makes a tiny,
  native, frameless macOS app possible.
- **[ccusage](https://github.com/ryoppippi/ccusage)** — the inspiration for the
  local-log token/cost aggregation, re-implemented in Rust in `usage.rs`.
- **[iroh](https://iroh.computer)** — QUIC P2P with relay fallback, powering the
  remote invite-code rooms in Social mode.
- **Nano Banana / Gemini** — used to generate the PNG cat sprites; see the
  [art prompt](src/assets/cat/README.md).
- **[Claude Code](https://docs.claude.com/en/docs/claude-code)** — the tool this
  cat watches, and the one it was largely built with.

## License

MIT License. See [LICENSE](./LICENSE). 🐾
