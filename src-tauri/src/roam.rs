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

use crate::{AppState, ButterflyEvent, SubEvent, WanderEvent, CAT_SIZE, FEED_HOLD, WANDER_MARGIN};

/// Poll cadence. We only schedule hops (not animate), so a lazy tick is plenty.
const TICK_MS: u64 = 200;

/// Yawn / stretch flourishes fire this often (seconds, range) while the cat is
/// resting. Purely a scheduler timer — no polling, no extra thread.
const SUB_EVENT_S: (f64, f64) = (30.0, 120.0);

/// Butterfly chases fire this often (seconds, range) in the playful moods.
const BUTTERFLY_S: (f64, f64) = (60.0, 180.0);

/// Grace before the first hop, and after returning from Grab mode, so the cat
/// doesn't lurch the instant it's placed or released.
const GRACE: Duration = Duration::from_millis(1500);

/// Cat's resting line: how far its top-left sits above the work-area bottom when
/// parked at a ground-level prop (cushion / bowl). Chosen so the 128px cat
/// overlaps the prop art (drawn ~132px tall, 10px off the bottom in CSS).
const FURN_GROUND: f64 = 6.0;

/// Extra lift so an alert / angry cat perches up on the cat-tower platform
/// rather than at floor level.
const TOWER_LIFT: f64 = 54.0;

/// Once within this many logical px of a prop, the cat is "there": it settles
/// (or fidgets, if angry) instead of hopping again.
const ANCHOR_SNAP: f64 = 24.0;

/// Furniture anchor for a mood, as the cat container's target top-left (logical
/// px), or `None` for free roam. The x-fractions match `FURNITURE_X` in the
/// frontend (tower 0.20 / cushion 0.50 / bowl 0.80) so the cat lands on its
/// prop; `h`/`w` are the work-area logical size.
///  - `sleeping`         → curl up on the cushion (center).
///  - `alert` / `angry`  → perch on the cat-tower platform (left, lifted).
///  - `exhausted`        → slump by the food bowl (right).
fn anchor_pos(state: &str, w: f64, h: f64) -> Option<(f64, f64)> {
    let ground_y = h - CAT_SIZE - FURN_GROUND;
    let center = |frac: f64| frac * w - CAT_SIZE / 2.0;
    match state {
        "sleeping" => Some((center(0.50), ground_y)),
        "alert" | "angry" => Some((center(0.20), ground_y - TOWER_LIFT)),
        "exhausted" => Some((center(0.80), ground_y)),
        _ => None,
    }
}

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

/// State the scheduler carries between ticks (all on the wander thread).
struct Sched {
    /// When the next hop may begin. `None` => (re)arm with a grace delay.
    next_hop: Option<Instant>,
    /// When the next yawn/stretch flourish may fire.
    next_sub: Option<Instant>,
    /// When the next butterfly chase may fire.
    next_butterfly: Option<Instant>,
}

/// Launch the wander loop. Cheap when idle or grabbed.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut rng = Rng::new();
        let mut sched = Sched {
            next_hop: None,
            next_sub: None,
            // Don't pester the user with a butterfly the instant the app opens.
            next_butterfly: Some(Instant::now() + Duration::from_secs(45)),
        };

        loop {
            tick(&app, &mut rng, &mut sched);
            std::thread::sleep(Duration::from_millis(TICK_MS));
        }
    });
}

/// Fire a yawn/stretch flourish now and then, but only when the cat is resting
/// (busy / agitated moods look wrong yawning). Re-arms its own timer each call;
/// arming happens lazily so the first flourish is always `SUB_EVENT_S` out.
fn maybe_sub_event(app: &AppHandle, rng: &mut Rng, now: Instant, sched: &mut Sched, cat_state: &str) {
    match sched.next_sub {
        None => {
            sched.next_sub = Some(now + Duration::from_secs_f64(rng.range(SUB_EVENT_S.0, SUB_EVENT_S.1)));
            return;
        }
        Some(at) if now < at => return,
        _ => {}
    }
    // Due: re-arm regardless, then emit only in a resting mood.
    sched.next_sub = Some(now + Duration::from_secs_f64(rng.range(SUB_EVENT_S.0, SUB_EVENT_S.1)));
    let resting = matches!(cat_state, "sleeping" | "exhausted" | "alert" | "curious" | "playing");
    if !resting {
        return;
    }
    let (kind, duration_ms) = if rng.unit() < 0.5 {
        ("yawn", 1200u64)
    } else {
        ("stretch", 1500u64)
    };
    let _ = app.emit(
        "cat-sub-event",
        SubEvent {
            kind: kind.to_string(),
            duration_ms,
        },
    );
}

/// One scheduler iteration.
fn tick(app: &AppHandle, rng: &mut Rng, sched: &mut Sched) {
    let state = app.state::<AppState>();

    // Grab mode (or no window) → freeze everything (hops, flourishes, butterfly)
    // and re-arm the grace timer.
    if !state.is_roam() {
        sched.next_hop = None;
        return;
    }

    let Some(win) = app.get_webview_window("cat") else {
        return;
    };

    // macOS Sequoia+ can silently drop click-through; cheaply re-assert it while
    // roaming so a stray reset never blocks clicks on the full-screen overlay.
    let _ = win.set_ignore_cursor_events(true);

    let now = Instant::now();
    let cat_state = state.cat_state();

    // Yawn/stretch flourishes are scheduled independently of hops so they can
    // fire while the cat is idle *between* hops (the gate below returns early).
    maybe_sub_event(app, rng, now, sched, &cat_state);

    // Just fed? Linger at the bowl — keep re-arming a short hold so the wander
    // loop doesn't drag the cat off its meal (see `feed_cat` in lib.rs).
    if let Some(t) = state.last_feed() {
        if t.elapsed() < FEED_HOLD {
            sched.next_hop = Some(now + Duration::from_millis(300));
            return;
        }
    }

    match sched.next_hop {
        Some(at) if now < at => return,
        None => {
            sched.next_hop = Some(now + GRACE);
            return;
        }
        _ => {}
    }

    let Some(wa) = crate::workarea(&win) else {
        return;
    };
    let (w_log, h_log) = wa.logical_size();
    let max_x = (w_log - CAT_SIZE - WANDER_MARGIN).max(WANDER_MARGIN);
    let max_y = (h_log - CAT_SIZE - WANDER_MARGIN).max(WANDER_MARGIN);

    let (px, py) = state.cat_pos().unwrap_or_else(|| crate::default_cat_pos(&wa));

    // Playful moods occasionally chase a butterfly instead of a plain hop. The
    // butterfly appears just above the cat, flutters off to `target`, and the
    // cat runs after it; the frontend fades the butterfly + plays a pounce when
    // the flutter finishes (see App.tsx).
    if matches!(cat_state.as_str(), "playing" | "curious")
        && sched.next_butterfly.map_or(false, |t| now >= t)
    {
        let base = w_log.min(h_log);
        let dist = rng.range(0.28, 0.5) * base;
        let angle = rng.range(0.0, std::f64::consts::TAU);
        let tx = (px + angle.cos() * dist).clamp(WANDER_MARGIN, max_x);
        let ty = (py + angle.sin() * dist).clamp(WANDER_MARGIN, max_y);
        let bx = (px + CAT_SIZE * 0.5).clamp(WANDER_MARGIN, max_x);
        let by = (py - CAT_SIZE * 0.1).clamp(WANDER_MARGIN, max_y);
        let dur_ms = rng.range(2200.0, 3600.0) as u64;
        let _ = app.emit(
            "cat-butterfly",
            ButterflyEvent {
                x: bx,
                y: by,
                target_x: tx,
                target_y: ty,
                duration_ms: dur_ms,
            },
        );
        let direction = if tx < px { "left" } else { "right" };
        let _ = app.emit(
            "cat-wander",
            WanderEvent {
                x: tx,
                y: ty,
                duration_ms: dur_ms,
                direction: direction.to_string(),
                gait: "run".to_string(),
            },
        );
        state.set_cat_pos(tx, ty);
        sched.next_butterfly =
            Some(now + Duration::from_secs_f64(rng.range(BUTTERFLY_S.0, BUTTERFLY_S.1)));
        sched.next_hop =
            Some(now + Duration::from_millis(dur_ms) + Duration::from_secs_f64(rng.range(1.5, 3.0)));
        return;
    }

    // Mood-anchored props: some moods send the cat to a specific piece of
    // furniture instead of free roaming. Ground props can sit lower than the
    // usual wander margin (the baseline is inside the work area), so `ay` clamps
    // against the screen bottom, not `max_y`.
    if let Some((ax, ay)) = anchor_pos(&cat_state, w_log, h_log) {
        let ax = ax.clamp(WANDER_MARGIN, max_x);
        let ay = ay.clamp(WANDER_MARGIN, (h_log - CAT_SIZE).max(WANDER_MARGIN));
        let dist = ((ax - px).powi(2) + (ay - py).powi(2)).sqrt();

        if dist > ANCHOR_SNAP {
            // Head to the prop; travel time scales with distance and mood pace.
            let (gait, speed) = match cat_state.as_str() {
                "angry" => ("run", 520.0),
                "exhausted" => ("walk", 70.0),
                _ => ("walk", 190.0),
            };
            let dur_ms = ((dist / speed) * 1000.0).clamp(500.0, 4500.0) as u64;
            let direction = if ax < px { "left" } else { "right" };
            let _ = app.emit(
                "cat-wander",
                WanderEvent {
                    x: ax,
                    y: ay,
                    duration_ms: dur_ms,
                    direction: direction.to_string(),
                    gait: gait.to_string(),
                },
            );
            state.set_cat_pos(ax, ay);
            sched.next_hop = Some(now + Duration::from_millis(dur_ms) + Duration::from_millis(400));
            return;
        }

        // Arrived. Angry keeps fidgeting in place; the other anchored moods
        // settle and hold (the frontend then shows the resting pose by mood).
        if cat_state == "angry" {
            let tx = (ax + rng.range(-16.0, 16.0)).clamp(WANDER_MARGIN, max_x);
            let ty = (ay + rng.range(-10.0, 10.0)).clamp(WANDER_MARGIN, max_y);
            let dur_ms = rng.range(150.0, 320.0) as u64;
            let _ = app.emit(
                "cat-wander",
                WanderEvent {
                    x: tx,
                    y: ty,
                    duration_ms: dur_ms,
                    direction: "right".to_string(),
                    gait: "jitter".to_string(),
                },
            );
            state.set_cat_pos(tx, ty);
            sched.next_hop =
                Some(now + Duration::from_millis(dur_ms) + Duration::from_secs_f64(rng.range(0.4, 1.1)));
        } else {
            sched.next_hop = Some(now + Duration::from_secs(2));
        }
        return;
    }

    // Free roam (playing / curious / active / unknown).
    let Some(p) = params(&cat_state) else {
        sched.next_hop = Some(now + Duration::from_secs(2));
        return;
    };

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
    sched.next_hop = Some(now + Duration::from_millis(dur_ms) + Duration::from_secs_f64(pause));
}
