//! Roam mode: the cat wanders the screen on its own.
//!
//! A single background thread ticks a smooth easing animation between random
//! targets. It only moves while the app is in Roam mode (click-through); Grab
//! mode freezes it instantly so the user can drag/click. The wander cadence and
//! step size scale with the cat's current mood (`CatState`), which the frontend
//! keeps up to date via the `set_cat_state` command.
//!
//! Everything here runs off the main thread. Tauri window methods
//! (`set_position`, `current_monitor`, …) proxy to the event loop, so they're
//! safe to call from a plain `std::thread`.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, PhysicalPosition};

use crate::AppState;

/// Frame time while an easing animation is in flight (~60 fps). Between hops we
/// poll much more slowly to stay off the CPU.
const FRAME_MS: u64 = 16;
const IDLE_POLL_MS: u64 = 200;

/// Grace period before the first hop, and after returning from Grab mode, so
/// the cat doesn't lurch the instant it's placed or released.
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
    /// Base seconds between the *start* of one hop and the next.
    interval: f64,
    /// Step distance range in physical px.
    dist: (f64, f64),
    /// Per-hop travel duration range in ms.
    dur: (f64, f64),
}

/// Map a `CatState` name to wander parameters. `None` means "hold still".
fn params(state: &str) -> Option<HopParams> {
    Some(match state {
        // Deep rest — don't move at all.
        "sleeping" => return None,
        // Happy and lively: big, frequent hops.
        "playing" => HopParams { interval: 10.0, dist: (100.0, 300.0), dur: (400.0, 1200.0) },
        "curious" => HopParams { interval: 12.0, dist: (80.0, 250.0), dur: (500.0, 1100.0) },
        "active" => HopParams { interval: 8.0, dist: (100.0, 250.0), dur: (400.0, 1000.0) },
        // On edge: small, infrequent shivers.
        "alert" => HopParams { interval: 15.0, dist: (20.0, 40.0), dur: (300.0, 600.0) },
        // Agitated: tiny, restless, frequent fidgets.
        "angry" => HopParams { interval: 5.0, dist: (15.0, 30.0), dur: (200.0, 400.0) },
        // Wiped out: barely twitches.
        "exhausted" => HopParams { interval: 30.0, dist: (10.0, 20.0), dur: (600.0, 1200.0) },
        // Anything unknown behaves like `curious`.
        _ => HopParams { interval: 12.0, dist: (80.0, 250.0), dur: (500.0, 1100.0) },
    })
}

/// Cubic ease-in-out.
fn ease(t: f64) -> f64 {
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        let f = -2.0 * t + 2.0;
        1.0 - f * f * f / 2.0
    }
}

struct Anim {
    from: (f64, f64),
    to: (f64, f64),
    start: Instant,
    dur: Duration,
}

/// Launch the wander loop. Cheap when idle or grabbed.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut rng = Rng::new();
        let mut anim: Option<Anim> = None;
        // When the next hop may begin. `None` => (re)arm with a grace delay.
        let mut next_hop: Option<Instant> = None;

        loop {
            let animating = tick(&app, &mut rng, &mut anim, &mut next_hop);
            let dt = if animating { FRAME_MS } else { IDLE_POLL_MS };
            std::thread::sleep(Duration::from_millis(dt));
        }
    });
}

/// One iteration. Returns `true` while an animation is in flight (so the caller
/// polls at frame rate instead of the idle cadence).
fn tick(
    app: &AppHandle,
    rng: &mut Rng,
    anim: &mut Option<Anim>,
    next_hop: &mut Option<Instant>,
) -> bool {
    // Grab mode (or no state yet) → freeze and re-arm the grace timer.
    if !app.state::<AppState>().is_roam() {
        *anim = None;
        *next_hop = None;
        return false;
    }

    let Some(win) = app.get_webview_window("cat") else {
        return false;
    };

    // Advance an in-flight hop.
    if let Some(a) = anim.as_ref() {
        let dur = a.dur.as_secs_f64().max(0.001);
        let t = (a.start.elapsed().as_secs_f64() / dur).clamp(0.0, 1.0);
        let e = ease(t);
        let x = a.from.0 + (a.to.0 - a.from.0) * e;
        let y = a.from.1 + (a.to.1 - a.from.1) * e;
        let _ = win.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
        // macOS Sequoia+ can drop click-through after a move; re-assert it.
        let _ = win.set_ignore_cursor_events(true);
        if t >= 1.0 {
            *anim = None;
        }
        return true;
    }

    let now = Instant::now();

    // Between hops: honour the scheduled start (and the startup / post-grab
    // grace period when `next_hop` was just re-armed).
    match *next_hop {
        Some(at) if now < at => return false,
        None => {
            *next_hop = Some(now + GRACE);
            return false;
        }
        _ => {}
    }

    let cat_state = app.state::<AppState>().cat_state();
    let Some(p) = params(&cat_state) else {
        // Sleeping: check back in a couple of seconds.
        *next_hop = Some(now + Duration::from_secs(2));
        return false;
    };

    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
        return false;
    };

    // Clamp the target into the active monitor's work area (menu bar / dock
    // excluded) so the cat never wanders behind them or off-screen.
    let (min_x, min_y, max_x, max_y) = match win.current_monitor() {
        Ok(Some(m)) => {
            let wa = m.work_area();
            let ax = wa.position.x;
            let ay = wa.position.y;
            let right = ax + wa.size.width as i32 - size.width as i32;
            let bottom = ay + wa.size.height as i32 - size.height as i32;
            (ax, ay, right.max(ax), bottom.max(ay))
        }
        _ => (0, 0, (pos.x).max(0), (pos.y).max(0)),
    };

    // Pick a random direction + distance from the current spot.
    let angle = rng.range(0.0, std::f64::consts::TAU);
    let dist = rng.range(p.dist.0, p.dist.1);
    let tx = (pos.x as f64 + angle.cos() * dist).clamp(min_x as f64, max_x as f64);
    let ty = (pos.y as f64 + angle.sin() * dist).clamp(min_y as f64, max_y as f64);

    let dur_ms = rng.range(p.dur.0, p.dur.1);
    *anim = Some(Anim {
        from: (pos.x as f64, pos.y as f64),
        to: (tx, ty),
        start: Instant::now(),
        dur: Duration::from_millis(dur_ms as u64),
    });

    // Schedule the next hop relative to this one's start, with ±20% jitter.
    let jitter = rng.range(0.8, 1.2);
    *next_hop = Some(now + Duration::from_secs_f64(p.interval * jitter));
    true
}
