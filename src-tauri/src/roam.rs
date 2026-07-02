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

use chrono::{Local, Timelike};
use tauri::{AppHandle, Emitter, Manager};

use crate::{AppState, PlaythingEvent, SubEvent, WanderEvent, CAT_SIZE, FEED_HOLD, WANDER_MARGIN};

/// Poll cadence. We only schedule hops (not animate), so a lazy tick is plenty.
const TICK_MS: u64 = 200;

/// Micro-event flourishes (yawn / stretch / ear-wiggle / look-back / blink-hard)
/// fire this often (seconds, range) while the cat is resting. Faster than the
/// old yawn/stretch-only cadence so the resting cat feels more alive. The active
/// time-of-day scales this (see [`sub_event_interval`]).
const SUB_EVENT_S: (f64, f64) = (15.0, 60.0);

/// Plaything appearances (butterfly / ball / yarn / bird) fire this often
/// (seconds, range) in the playful moods; time-of-day scales it.
const PLAYTHING_S: (f64, f64) = (60.0, 180.0);

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
///  - `sleeping`         → curl up on the cushion (bottom-right corner, out of
///                         the way of your work).
///  - `alert` / `angry`  → perch on the cat-tower platform (left, lifted).
///  - `exhausted`        → slump by the food bowl (right).
fn anchor_pos(state: &str, w: f64, h: f64) -> Option<(f64, f64)> {
    let ground_y = h - CAT_SIZE - FURN_GROUND;
    let center = |frac: f64| frac * w - CAT_SIZE / 2.0;
    match state {
        "sleeping" => Some((center(0.88), ground_y)),
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

    /// Weighted pick: returns the index into `weights` chosen with probability
    /// proportional to its weight. Falls back to the last index on rounding slop.
    fn weighted(&mut self, weights: &[f64]) -> usize {
        let total: f64 = weights.iter().sum();
        if total <= 0.0 {
            return 0;
        }
        let mut r = self.unit() * total;
        for (i, w) in weights.iter().enumerate() {
            r -= w;
            if r < 0.0 {
                return i;
            }
        }
        weights.len() - 1
    }
}

/// Coarse local time-of-day, recomputed each tick. Drives how lively the
/// resting flourishes and playthings are — the cat winds down at night, wakes up
/// stretching in the morning, and plays more in the evening.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TimeOfDay {
    /// 22:00–05:59 — winding down / asleep.
    Night,
    /// 06:00–09:59 — waking up (lots of stretching).
    Morning,
    /// 10:00–17:59 — baseline.
    Daytime,
    /// 18:00–21:59 — friskiest (more toys).
    Evening,
}

/// Read the machine's local wall clock and bucket it. For this app "local" is
/// the user's KST, matching how `usage.rs` buckets the day.
fn time_of_day() -> TimeOfDay {
    match Local::now().hour() {
        22..=23 | 0..=5 => TimeOfDay::Night,
        6..=9 => TimeOfDay::Morning,
        10..=17 => TimeOfDay::Daytime,
        _ => TimeOfDay::Evening,
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
    /// When the next micro-event flourish may fire.
    next_sub: Option<Instant>,
    /// When the next plaything (butterfly / ball / yarn / bird) may appear.
    next_plaything: Option<Instant>,
}

/// Launch the wander loop. Cheap when idle or grabbed.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut rng = Rng::new();
        let mut sched = Sched {
            next_hop: None,
            next_sub: None,
            // Don't pester the user with a plaything the instant the app opens.
            next_plaything: Some(Instant::now() + Duration::from_secs(45)),
        };

        loop {
            tick(&app, &mut rng, &mut sched);
            std::thread::sleep(Duration::from_millis(TICK_MS));
        }
    });
}

/// Micro-event interval, scaled by time-of-day: the cat twitches a touch more
/// often at night/morning (winding down / waking up) than during the day.
fn sub_event_interval(rng: &mut Rng, tod: TimeOfDay) -> f64 {
    let base = rng.range(SUB_EVENT_S.0, SUB_EVENT_S.1);
    let factor = match tod {
        TimeOfDay::Night => 0.7,
        TimeOfDay::Morning => 0.8,
        _ => 1.0,
    };
    base * factor
}

/// Micro-event kinds and their play durations (ms). The frontend maps each kind
/// to a CSS flourish (yawn/stretch have expressive sprites on cream; the three
/// smaller twitches are CSS-only). Order matches the weight table below.
const SUB_EVENTS: [(&str, u64); 5] = [
    ("yawn", 1200),
    ("stretch", 1500),
    ("ear_wiggle", 400),
    ("look_back", 500),
    ("blink_hard", 200),
];

/// Pick a micro-event, biasing the mix by time-of-day: yawns/stretches at night,
/// heavy stretching in the morning (the "just woke up" sequence).
fn pick_sub_event(rng: &mut Rng, tod: TimeOfDay) -> (&'static str, u64) {
    // Weights line up with SUB_EVENTS: yawn, stretch, ear_wiggle, look_back, blink_hard.
    let mut w = [1.0, 1.0, 1.2, 1.0, 1.2];
    match tod {
        TimeOfDay::Night => {
            w[0] += 1.6; // yawn
            w[1] += 1.0; // stretch
        }
        TimeOfDay::Morning => {
            w[1] += 3.0; // stretch, hard
            w[0] += 0.4;
        }
        _ => {}
    }
    SUB_EVENTS[rng.weighted(&w)]
}

/// Fire a resting flourish now and then, but only when the cat is resting
/// (busy / agitated moods look wrong twitching). Re-arms its own timer each call;
/// arming happens lazily so the first flourish is always `SUB_EVENT_S` out.
fn maybe_sub_event(app: &AppHandle, rng: &mut Rng, now: Instant, sched: &mut Sched, cat_state: &str) {
    let tod = time_of_day();
    match sched.next_sub {
        None => {
            sched.next_sub = Some(now + Duration::from_secs_f64(sub_event_interval(rng, tod)));
            return;
        }
        Some(at) if now < at => return,
        _ => {}
    }
    // Due: re-arm regardless, then emit only in a resting mood.
    sched.next_sub = Some(now + Duration::from_secs_f64(sub_event_interval(rng, tod)));
    let resting = matches!(cat_state, "sleeping" | "exhausted" | "alert" | "curious" | "playing");
    if !resting {
        return;
    }
    let (kind, duration_ms) = pick_sub_event(rng, tod);
    let _ = app.emit(
        "cat-sub-event",
        SubEvent {
            kind: kind.to_string(),
            duration_ms,
        },
    );
}

/// Plaything interval, scaled by time-of-day: friskier (more toys) in the
/// evening, calmer in the morning.
fn plaything_interval(rng: &mut Rng, tod: TimeOfDay) -> f64 {
    let base = rng.range(PLAYTHING_S.0, PLAYTHING_S.1);
    let factor = match tod {
        TimeOfDay::Evening => 0.7,
        TimeOfDay::Morning => 1.3,
        TimeOfDay::Night => 1.2,
        TimeOfDay::Daytime => 1.0,
    };
    base * factor
}

/// The four plaything kinds. Order matches the weight table in [`pick_plaything`].
const PLAYTHINGS: [&str; 4] = ["butterfly", "ball", "yarn", "bird"];

/// Pick which toy shows up, biased by time-of-day: fewer butterflies in the
/// morning; birds a touch more likely in the morning/evening (dawn/dusk flights).
fn pick_plaything(rng: &mut Rng, tod: TimeOfDay) -> &'static str {
    // Weights: butterfly, ball, yarn, bird.
    let mut w = [3.0, 3.0, 2.0, 2.0];
    match tod {
        TimeOfDay::Morning => {
            w[0] -= 1.5; // fewer butterflies
            w[3] += 1.0; // more birds
        }
        TimeOfDay::Evening => {
            w[0] += 1.0; // butterflies love dusk
            w[3] += 0.5;
        }
        _ => {}
    }
    PLAYTHINGS[rng.weighted(&w)]
}

/// A scheduled plaything: where the toy appears/goes, how long it lasts, and an
/// optional `cat-wander` target (x, y, duration_ms, gait) so the cat reacts.
struct PlayPlan {
    item_x: f64,
    item_y: f64,
    item_tx: f64,
    item_ty: f64,
    dur: u64,
    /// `Some((x, y, duration_ms, gait))` if the cat should move in response.
    cat: Option<(f64, f64, u64, &'static str)>,
    /// How long to hold the cat before it starts chasing, so a toy that's
    /// thrown across the screen (the ball) clearly leads and the cat trails.
    /// `0` for reactions that should start immediately.
    cat_delay: u64,
}

/// Build the appearance + chase plan for a plaything `kind`, given the cat's
/// current position and the wander bounds. Per-kind motion patterns:
///  - `butterfly`: flutters off on a random vector; the cat runs after it.
///  - `ball`: rolls in a straight line across the screen; the cat chases it.
///  - `yarn`: dangles just in front of the cat, which bats at it in place.
///  - `bird`: swoops across the top and exits the far side (out of reach); the
///    cat dashes toward the middle, but the bird gets away.
#[allow(clippy::too_many_arguments)]
fn plaything_plan(
    kind: &str,
    rng: &mut Rng,
    px: f64,
    py: f64,
    w_log: f64,
    h_log: f64,
    max_x: f64,
    max_y: f64,
) -> PlayPlan {
    let clamp_x = |x: f64| x.clamp(WANDER_MARGIN, max_x);
    let clamp_y = |y: f64| y.clamp(WANDER_MARGIN, max_y);
    // Ground props (ball) can sit below the usual wander margin.
    let ground = |y: f64| y.clamp(WANDER_MARGIN, (h_log - CAT_SIZE).max(WANDER_MARGIN));

    match kind {
        "ball" => {
            let from_left = rng.unit() < 0.5;
            let start_x = if from_left { WANDER_MARGIN } else { max_x };
            let end_x = if from_left { max_x } else { WANDER_MARGIN };
            let y = ground(py + CAT_SIZE * 0.45);
            let dur = rng.range(1800.0, 2800.0) as u64;
            // Throw the ball first, then chase. The ball rolls the full width
            // from an edge, but the cat starts mid-screen — nearer the far end
            // than the ball is. If both move over the same `dur`, the cat sits
            // *ahead* of the ball the whole way, so it reads as "cat leads, ball
            // trails" (the reported bug). Instead, hold the cat until the ball
            // has rolled past its x (plus a gap), then let it run the remainder
            // faster and catch up right as the ball settles — so the chase
            // trails the toy and the catch-pounce (fired at the ball's end)
            // lands on arrival.
            let span = (end_x - start_x).abs().max(1.0);
            let t_pass = dur as f64 * ((px - start_x).abs() / span);
            let cat_delay = (t_pass + dur as f64 * 0.12)
                .clamp(dur as f64 * 0.25, (dur as f64 - 300.0).max(0.0))
                as u64;
            let cat_dur = dur.saturating_sub(cat_delay).max(300);
            PlayPlan {
                item_x: start_x,
                item_y: y,
                item_tx: end_x,
                item_ty: y,
                dur,
                // Chase the ball to where it ends up (after the head start).
                cat: Some((clamp_x(end_x), py, cat_dur, "run")),
                cat_delay,
            }
        }
        "yarn" => {
            // Dangle to whichever side has more room, in front of the cat.
            let side = if px < w_log * 0.5 { 1.0 } else { -1.0 };
            let bx = clamp_x(px + CAT_SIZE * 0.55 * side);
            let by = clamp_y(py + CAT_SIZE * 0.2);
            let tx = clamp_x(bx + rng.range(-24.0, 24.0));
            let ty = clamp_y(by + rng.range(-12.0, 24.0));
            let dur = rng.range(1600.0, 2600.0) as u64;
            // A small shuffle toward the yarn, then it bats (frontend pounce).
            let cat_tx = clamp_x(px + CAT_SIZE * 0.18 * side);
            PlayPlan {
                item_x: bx,
                item_y: by,
                item_tx: tx,
                item_ty: ty,
                dur,
                cat: Some((cat_tx, py, rng.range(400.0, 700.0) as u64, "walk")),
                cat_delay: 0,
            }
        }
        "bird" => {
            let from_left = rng.unit() < 0.5;
            let start_x = if from_left { WANDER_MARGIN } else { max_x };
            let end_x = if from_left { max_x } else { WANDER_MARGIN };
            let top_y = WANDER_MARGIN;
            let dur = rng.range(2800.0, 4000.0) as u64;
            // Dash toward the middle, following the fly-over — but it escapes.
            let mid_x = clamp_x((start_x + end_x) / 2.0);
            PlayPlan {
                item_x: start_x,
                item_y: top_y,
                item_tx: end_x,
                item_ty: top_y,
                dur,
                cat: Some((mid_x, py, rng.range(700.0, 1200.0) as u64, "run")),
                cat_delay: 0,
            }
        }
        // "butterfly" (and any unknown kind): flutter off on a random vector.
        _ => {
            let base = w_log.min(h_log);
            let dist = rng.range(0.28, 0.5) * base;
            let angle = rng.range(0.0, std::f64::consts::TAU);
            let tx = clamp_x(px + angle.cos() * dist);
            let ty = clamp_y(py + angle.sin() * dist);
            let bx = clamp_x(px + CAT_SIZE * 0.5);
            let by = clamp_y(py - CAT_SIZE * 0.1);
            let dur = rng.range(2200.0, 3600.0) as u64;
            PlayPlan {
                item_x: bx,
                item_y: by,
                item_tx: tx,
                item_ty: ty,
                dur,
                cat: Some((tx, ty, dur, "run")),
                cat_delay: 0,
            }
        }
    }
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

    // Playful moods occasionally spawn a plaything (butterfly / ball / yarn /
    // bird) instead of a plain hop. Each kind has its own motion pattern and
    // cat reaction (see `plaything_plan`); the frontend fades the toy + plays a
    // pounce when it finishes (see App.tsx).
    if matches!(cat_state.as_str(), "playing" | "curious" | "active")
        && sched.next_plaything.map_or(false, |t| now >= t)
    {
        let tod = time_of_day();
        let kind = pick_plaything(rng, tod);
        let plan = plaything_plan(kind, rng, px, py, w_log, h_log, max_x, max_y);

        let _ = app.emit(
            "cat-plaything",
            PlaythingEvent {
                kind: kind.to_string(),
                x: plan.item_x,
                y: plan.item_y,
                target_x: plan.item_tx,
                target_y: plan.item_ty,
                duration_ms: plan.dur,
            },
        );

        if let Some((cx, cy, cdur, gait)) = plan.cat {
            let direction = if cx < px { "left" } else { "right" };
            let ev = WanderEvent {
                x: cx,
                y: cy,
                duration_ms: cdur,
                direction: direction.to_string(),
                gait: gait.to_string(),
            };
            if plan.cat_delay == 0 {
                let _ = app.emit("cat-wander", ev);
            } else {
                // Hold the chase so the toy leads (see the ball plan). Fire it
                // from a short-lived timer thread, and bail if we've left roam
                // (grabbed / dragged) before it triggers.
                let app2 = app.clone();
                let delay = plan.cat_delay;
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(delay));
                    if app2.state::<AppState>().is_roam() {
                        let _ = app2.emit("cat-wander", ev);
                    }
                });
            }
            state.set_cat_pos(cx, cy);
            sched.next_hop = Some(
                now + Duration::from_millis(plan.cat_delay + cdur)
                    + Duration::from_secs_f64(rng.range(1.5, 3.0)),
            );
        } else {
            sched.next_hop = Some(now + Duration::from_millis(plan.dur));
        }

        sched.next_plaything = Some(now + Duration::from_secs_f64(plaything_interval(rng, tod)));
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
