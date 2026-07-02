# 🐱 clawd

> Cute floating cat that shows your Claude Code usage on macOS.

A tiny, frameless, always-on-top cat that lives on your desktop and changes its
mood based on how hard you're driving Claude Code. Low activity → it naps and
plays. Burning tokens → it gets alert, then hisses. Near your daily budget →
it's exhausted. By default it **roams** — clicks pass straight through and the
cat wanders your screen on its own — until you **grab** it (**⌘⇧C** or the tray)
to drag, click, or configure it.

```
   /\_/\     clawd watches ~/.claude/projects/**/*.jsonl,
  ( o.o )    re-implements ccusage's token+cost aggregation in Rust,
   > ^ <     and maps it onto a 7-state cat.
```

*(Screenshot placeholder — run it and grab one!)*

---

## Concept

- **Floating, no chrome** — transparent background, no title bar, no shadow.
- **Mood = usage** — the cat animates by token rate and daily budget ratio.
- **Two modes — Roam ↔ Grab:**
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

| State       | When                                              | Look                          |
|-------------|---------------------------------------------------|-------------------------------|
| `sleeping`  | idle > 30 min, no active session                  | eyes closed, `z z z`, slow    |
| `playing`   | very low / no rate                                | happy eyes, sparkle, fast tail|
| `curious`   | rate > `low`                                      | wide eyes, `?`                |
| `active`    | rate > `mid`                                      | open eyes, gentle smile       |
| `alert`     | rate > `high` **or** budget > 60%                 | big eyes, raised ears, `!`    |
| `angry`     | rate > `veryHigh` **or** budget > 85%             | flat ears, fangs, hiss        |
| `exhausted` | budget > 95% **and** rate > `high`                | `><` eyes, sweat drop         |

Only `playing`, `alert`, and `angry` are strongly differentiated in this first
draft; the other four reuse the same rig with tweaked expression/pose/color.

## Requirements

- **macOS** (built and tuned for macOS).
- **Node ≥ 20** — `node --version`
- **Rust (stable)** — `rustc --version`. If missing:
  ```sh
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
  ```
- **Xcode Command Line Tools** — `xcode-select --install`

## Run

```sh
npm install
npm run tauri dev
```

## Build

```sh
npm run tauri build
```

The signed/bundled `.app` and `.dmg` land in `src-tauri/target/release/bundle/`.

## Permissions (macOS)

- **Notifications** — for the 80% / 100% daily-budget alerts. Allow when
  prompted (toggle alerts off in the details window if you don't want them).

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
- **Tray menu** → pick Roam / Grab, show/hide the cat, reset position, open
  details/settings, quit. The tray tooltip and a small menu-bar suffix (`✋`)
  show which mode you're in.

## Tuning thresholds

Open the details window (⌘⇧C then click the cat, or tray → *상세 · 임계값 설정*):

- **Daily budget (USD)** — default `$20`. Drives the budget ratio and alerts.
- **Budget alerts** — on/off for the 80% / 100% notifications.
- **State thresholds (tokens/min)** — `curious / active / alert / angry` cutoffs.

Settings persist via the Tauri store (`config.json` in the app config dir) and
sync live between the cat and details windows.

> **Note on token counts:** totals include `cache_read` tokens, which are cheap
> but voluminous, so tokens/min runs large during active sessions. The default
> thresholds account for this; tune to taste.

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
│  ├─ App.tsx                # cat window (drag / click / tooltip)
│  ├─ Details.tsx            # details + settings window
│  ├─ types.ts               # Usage / Config / CatState + defaults
│  ├─ hooks/
│  │  ├─ useUsage.ts         # get_usage + `usage` event subscription
│  │  ├─ useConfig.ts        # Tauri store config, synced across windows
│  │  └─ useCatState.ts      # usage → CatState classifier
│  ├─ components/Cat/        # SVG cat + CSS animations
│  └─ utils/format.ts
└─ src-tauri/                # Rust backend
   ├─ src/
   │  ├─ lib.rs              # window setup, Roam/Grab mode, hotkey, poller
   │  ├─ roam.rs             # wander scheduler (emits cat-wander events)
   │  ├─ usage.rs            # ccusage-style aggregation
   │  └─ tray.rs             # menu-bar tray (mode radio + status)
   ├─ tauri.conf.json        # cat + details window config
   └─ capabilities/default.json
```

## Known limitations

- **Cat art + gaits are a hand-drawn draft.** Playing / alert / angry read
  clearly; the other four states are lightweight variations. The walk / run /
  jitter gaits are an initial pass (body bob + alternating paws + tail) — good
  enough to read as motion, but ripe for refinement.
- **Primary monitor only.** The overlay sizes to the primary monitor's work
  area; the cat won't wander onto secondary displays yet. Multi-monitor support
  is a future improvement (track the monitor under the cat and re-home the
  overlay on display changes).
- The log scan re-reads all files every 30 s — fine for typical histories, but
  not incremental. Large histories could be cached by mtime later.
- macOS only. Windows/Linux would need a different global-shortcut strategy.
- Prices are hardcoded approximations; verify against current Anthropic pricing.

## Changelog

- **v0.4.0** — **New sticker-style cat + coat colors + tooltip auto-flip + tray
  title sync.** Fully redrew the cat as a chunky, thick-line "sticker" — pastel
  fills, big eyes, pink cheeks — with the **viewpoint chosen per pose** for the
  most natural read: `sit` faces you (front view, mood-driven face), `walk`/`run`
  are an elongated side profile sharing one rig, and `sleep` / `alert` / `angry`
  / `exhausted` each get their own angle. Gait animations swing the legs in
  diagonal pairs from the hip, bob the body, stream the tail back at a run, and
  puff it for alert/angry; the profile flips with `scaleX(-1)` when heading left.
  Added **5 coat colors** — cream, black, orange & gray tabbies (with a stripe
  layer), and white — driven by CSS custom properties and switchable from a new
  swatch picker in the details window (persists in config, live-syncs to the cat
  window). The **tooltip now auto-flips**: it measures the cat against the
  (small, edge-clamped) grab window and hugs the near edge — or drops below the
  cat — so it never clips off-window (it also fades only now, so framer-motion no
  longer clobbers the centering transform). The **tray title** reliably reflects
  the mode (🐾 Roam / ✋ Grab) — macOS wouldn't clear a `None` title, so the "✋"
  suffix used to stick after switching back to Roam.
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

## Roadmap (v2 ideas)

- Richer SVG / Lottie animations, more distinct per-state poses.
- Sounds (meow, hiss) — optional, off by default.
- Multiple cats (e.g., team usage split across several kitties).
- Detect Claude usage beyond Claude Code (direct Anthropic API traffic).
- Incremental log tailing instead of full rescans.
- Menu-bar mini stats and a sparkline.

## License

Personal project — do what you like. No warranty. 🐾
