//! Roam mode: the cat wanders inside the full-screen overlay on its own.
//!
//! Unlike the old design (which nudged the native window every frame — janky on
//! macOS), the window is now a fixed full-screen overlay and the cat is a small
//! element moved with CSS transforms. So this thread is a pure *scheduler*: every
//! few seconds it picks a new target and emits a `cat-wander` event, and the
//! frontend tweens there with a GPU-accelerated CSS transition. No per-frame IPC.
//!
//! The cadence, hop distance, travel time, and gait (walk / run / jitter) all
//! scale with the cat's current mood (`CatState`), which the frontend keeps up to
//! date via `set_cat_state`. Grab mode freezes everything.
//!
//! Everything runs off the main thread; Tauri window methods proxy to the event
//! loop, so they're safe to call from a plain `std::thread`.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::{AppState, WanderEvent, CAT_SIZE, WANDER_MARGIN};

/// Poll cadence. We only schedule hops (not animate), so a lazy tick is plenty.
const TICK_MS: u64 = 200;

/// Grace before the first hop, and after returning from Grab mode, so the cat
/// doesn't lurch the instant it's placed or released.
const GRACE: Duration = Duration::from_millis(1500);

/// A tiny self-contained xorshift PRNG — avoids pulling in the `rand` crate.
struct Rng(u64);

impl Rng {
    fn new() -> Self {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9e37_79b9_7f4a_7c15);
        // Must be non-zero for xorshift.
        Rng(seed | 1)
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// Uniform in [0, 1).
    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform in [lo, hi).
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + self.unit() * (hi - lo)
    }
}

/// How lively the wander is, per mood.
struct HopParams {
    /// Idle pause between hops, in seconds (range).
    pause: (f64, f64),
    /// Hop distance as a fraction of the shorter screen dimension (range).
    dist: (f64, f64),
    /// Travel time per hop, in ms (range).
    dur: (f64, f64),
    /// Which SVG gait the frontend plays while moving.
    gait: &'static str,
    /// Restless twitch instead of a directed hop (angry only).
    jitter: bool,
}

/// Map a `CatState` to wander parameters. `None` means "hold still".
fn params(state: &str) -> Option<HopParams> {
    Some(match state {
        // Deep rest — don't move at all.
        "sleeping" => return None,
        // Happy and lively: roomy, unhurried strolls.
        "playing" => HopParams {
            pause: (2.5, 6.0),
            dist: (0.10, 0.35),
            dur: (1400.0, 3200.0),
            gait: "walk",
            jitter: false,
        },
        "curious" => HopParams {
            pause: (3.5, 7.0),
            dist: (0.06, 0.22),
            dur: (1500.0, 3000.0),
            gait: "walk",
            jitter: false,
        },
        // Busy: quick dashes across the screen.
        "active" => HopParams {
            pause: (1.5, 3.5),
            dist: (0.15, 0.45),
            dur: (800.0, 1600.0),
            gait: "run",
            jitter: false,
        },
        // On edge: small, careful, infrequent steps.
        "alert" => HopParams {
            pause: (5.0, 9.0),
            dist: (0.03, 0.09),
            dur: (700.0, 1400.0),
            gait: "walk",
            jitter: false,
        },
        // Agitated: restless fidgeting in place.
        "angry" => HopParams {
            pause: (0.4, 1.1),
            dist: (0.0, 0.0),
            dur: (150.0, 320.0),
            gait: "jitter",
            jitter: true,
        },
        // Wiped out: rare, slow shuffles.
        "exhausted" => HopParams {
            pause: (8.0, 14.0),
            dist: (0.02, 0.09),
            dur: (2200.0, 4200.0),
            gait: "walk",
            jitter: false,
        },
        // Anything unknown behaves like `curious`.
        _ => HopParams {
            pause: (3.5, 7.0),
            dist: (0.06, 0.22),
            dur: (1500.0, 3000.0),
            gait: "walk",
            jitter: false,
        },
    })
}

/// Launch the wander loop. Cheap when idle or grabbed.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut rng = Rng::new();
        // When the next hop may begin. `None` => (re)arm with a grace delay.
        let mut next_hop: Option<Instant> = None;

        loop {
            tick(&app, &mut rng, &mut next_hop);
            std::thread::sleep(Duration::from_millis(TICK_MS));
        }
    });
}

/// One scheduler iteration.
fn tick(app: &AppHandle, rng: &mut Rng, next_hop: &mut Option<Instant>) {
    let state = app.state::<AppState>();

    // Grab mode (or no window) → freeze and re-arm the grace timer.
    if !state.is_roam() {
        *next_hop = None;
        return;
    }

    let Some(win) = app.get_webview_window("cat") else {
        return;
    };

    // macOS Sequoia+ can silently drop click-through; cheaply re-assert it while
    // roaming so a stray reset never blocks clicks on the full-screen overlay.
    let _ = win.set_ignore_cursor_events(true);

    let now = Instant::now();
    match *next_hop {
        Some(at) if now < at => return,
        None => {
            *next_hop = Some(now + GRACE);
            return;
        }
        _ => {}
    }

    let Some(p) = params(&state.cat_state()) else {
        // Sleeping: check back shortly.
        *next_hop = Some(now + Duration::from_secs(2));
        return;
    };

    let Some(wa) = crate::workarea(&win) else {
        return;
    };
    let (w_log, h_log) = wa.logical_size();
    let max_x = (w_log - CAT_SIZE - WANDER_MARGIN).max(WANDER_MARGIN);
    let max_y = (h_log - CAT_SIZE - WANDER_MARGIN).max(WANDER_MARGIN);

    let (px, py) = state.cat_pos().unwrap_or_else(|| crate::default_cat_pos(&wa));

    // Pick a target: a directed hop, or a small in-place twitch (angry).
    let (tx, ty) = if p.jitter {
        (
            (px + rng.range(-30.0, 30.0)).clamp(WANDER_MARGIN, max_x),
            (py + rng.range(-30.0, 30.0)).clamp(WANDER_MARGIN, max_y),
        )
    } else {
        let base = w_log.min(h_log);
        let dist = rng.range(p.dist.0, p.dist.1) * base;
        let angle = rng.range(0.0, std::f64::consts::TAU);
        (
            (px + angle.cos() * dist).clamp(WANDER_MARGIN, max_x),
            (py + angle.sin() * dist).clamp(WANDER_MARGIN, max_y),
        )
    };

    let dur_ms = rng.range(p.dur.0, p.dur.1) as u64;
    let direction = if tx < px { "left" } else { "right" };

    let _ = app.emit(
        "cat-wander",
        WanderEvent {
            x: tx,
            y: ty,
            duration_ms: dur_ms,
            direction: direction.to_string(),
            gait: p.gait.to_string(),
        },
    );
    state.set_cat_pos(tx, ty);

    // Next hop = travel time + a mood-dependent pause (±20% jitter).
    let pause = rng.range(p.pause.0, p.pause.1) * rng.range(0.8, 1.2);
    *next_hop = Some(now + Duration::from_millis(dur_ms) + Duration::from_secs_f64(pause));
}
