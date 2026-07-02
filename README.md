# 🐱 clawd

> Cute floating cat that shows your Claude Code usage on macOS.

A tiny, frameless, always-on-top cat that lives on your desktop and changes its
mood based on how hard you're driving Claude Code. Low activity → it naps and
plays. Burning tokens → it gets alert, then hisses. Near your daily budget →
it's exhausted. It never gets in your way: the window is **click-through** until
you toggle grab mode with **⌘⇧C**.

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
- **Zero interference** — mouse events pass straight through to the window
  behind it. Press **⌘⇧C** to toggle "grab" mode (hover for stats, drag to
  move, click for details); press it again to go back to click-through. A
  glowing ring shows when grab mode is on.
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

That's it — the **⌘⇧C** grab-mode hotkey uses Tauri's global-shortcut plugin
and needs **no Accessibility permission**. (Earlier builds used an `rdev`
keyboard monitor for an Option-key hold; that was removed — see the changelog.)

## Usage

- Default → the cat is **click-through**: mouse events pass to the window behind
  it, so it never gets in your way.
- **⌘⇧C** → toggle **grab mode** on. A glowing ring appears and the cat becomes
  interactive:
  - **hover** → tooltip with today's tokens / cost / rate
  - **drag** → move the cat (position is remembered across launches)
  - **click** → open the details window
- **⌘⇧C** again → grab mode off, back to click-through.
- **Tray menu** → show/hide the cat, reset position, open details/settings, quit.

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
   │  ├─ lib.rs              # window setup, click-through, hotkey, poller
   │  ├─ usage.rs            # ccusage-style aggregation
   │  └─ tray.rs             # menu-bar tray
   ├─ tauri.conf.json        # cat + details window config
   └─ capabilities/default.json
```

## Known limitations (v0.1)

- **Cat art is a hand-drawn draft.** Playing / alert / angry read clearly; the
  other four states are lightweight variations. Refinement welcome.
- The log scan re-reads all files every 30 s — fine for typical histories, but
  not incremental. Large histories could be cached by mtime later.
- macOS only. Windows/Linux would need a different global-shortcut strategy.
- Prices are hardcoded approximations; verify against current Anthropic pricing.

## Changelog

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
