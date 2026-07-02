//! clawd — a floating cat that reflects Claude Code usage.
//!
//! The Rust side owns everything the WebView can't do well: reading the
//! `~/.claude` session logs, the two interaction modes — **Roam** (click-through
//! + auto-wander) and **Grab** (interactive, frozen) — the wander animation, the
//! tray, and native notifications.

mod presence;
mod roam;
mod tray;
mod usage;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use usage::Usage;

/// How often we rescan the logs and push a fresh snapshot to the frontend.
const POLL_SECS: u64 = 30;

/// The global hotkey that toggles between Roam and Grab mode.
const GRAB_SHORTCUT: &str = "cmd+shift+c";

/// The cat's default mood before the frontend reports one. Drives the wander
/// cadence in Roam mode; see `roam::params`.
const DEFAULT_CAT_STATE: &str = "playing";

// --- Overlay geometry (all in logical / CSS px unless noted) -------------
//
// The cat window is a screen-sized, click-through overlay. The *cat itself* is
// a `CAT_SIZE`-square element moved around inside it via CSS transforms, so the
// Rust side only ever deals in the cat's logical position within the window —
// never in native window moves (which can't animate smoothly on macOS).

/// Side length of the cat container element, in logical px. Must match
/// `.cat-container` in `App.css`.
pub(crate) const CAT_SIZE: f64 = 128.0;

/// Keep-out inset from the work-area edges so the cat never wanders half
/// off-screen or behind the dock/menu bar.
pub(crate) const WANDER_MARGIN: f64 = 40.0;

/// Grab-mode window size, in logical px. Big enough for the cat plus the
/// tooltip/ring that float around it.
const GRAB_W: f64 = 300.0;
const GRAB_H: f64 = 280.0;

/// Feeding: how long the cat lingers at the bowl (Roam pauses hops for this
/// long so it stays put), and the spam-guard cooldown between feeds.
const FEED_HOLD: Duration = Duration::from_secs(4);
const FEED_COOLDOWN: Duration = Duration::from_secs(60);

/// A wander instruction the frontend tweens to via a CSS transition. `x`/`y`
/// are the target top-left of the cat container in window logical px.
#[derive(Clone, serde::Serialize)]
pub(crate) struct WanderEvent {
    pub x: f64,
    pub y: f64,
    pub duration_ms: u64,
    pub direction: String,
    pub gait: String,
}

/// An instant (no-transition) placement of the cat — used on init, reset, and
/// whenever the window is resized between modes.
#[derive(Clone, serde::Serialize)]
struct PlaceEvent {
    x: f64,
    y: f64,
}

/// A short "alive" flourish the frontend plays in place (yawn / stretch) while
/// the cat is resting. Scheduled by the wander loop; see `roam.rs`.
#[derive(Clone, serde::Serialize)]
pub(crate) struct SubEvent {
    /// `"yawn"` or `"stretch"`.
    pub kind: String,
    pub duration_ms: u64,
}

/// A plaything the cat reacts to (butterfly / ball / yarn / bird). `x`/`y` is
/// where it appears; it travels to `target_x`/`target_y` over `duration_ms` and
/// the frontend layers a per-`kind` flourish on top (roll, sway, dip, flutter).
/// The cat is usually sent after it via a parallel `cat-wander`. All coords are
/// the cat window's logical px.
#[derive(Clone, serde::Serialize)]
pub(crate) struct PlaythingEvent {
    /// `"butterfly"` | `"ball"` | `"yarn"` | `"bird"`.
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub target_x: f64,
    pub target_y: f64,
    pub duration_ms: u64,
}

pub struct AppState {
    /// `false` = **Roam** (click-through, auto-wander), `true` = **Grab** (the
    /// cat captures the mouse for drag/click and holds still).
    grabbed: AtomicBool,
    /// Latest `CatState` the frontend reported, used to tune the wander.
    cat_state: Mutex<String>,
    /// The cat's current logical top-left position within the window (CSS px).
    /// `None` until first placed. Shared with the wander loop (`roam.rs`).
    cat_pos: Mutex<Option<(f64, f64)>>,
    /// When the cat was last fed. Drives the feed cooldown and the brief
    /// Roam-mode "linger at the bowl" hold (`roam.rs`).
    last_feed: Mutex<Option<Instant>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            grabbed: AtomicBool::new(false),
            cat_state: Mutex::new(DEFAULT_CAT_STATE.to_string()),
            cat_pos: Mutex::new(None),
            last_feed: Mutex::new(None),
        }
    }
}

impl AppState {
    /// True when in Roam mode (click-through + wandering).
    fn is_roam(&self) -> bool {
        !self.grabbed.load(Ordering::SeqCst)
    }

    /// A snapshot of the last reported cat mood.
    fn cat_state(&self) -> String {
        self.cat_state.lock().unwrap().clone()
    }

    /// The cat's current logical position, if placed yet.
    pub(crate) fn cat_pos(&self) -> Option<(f64, f64)> {
        *self.cat_pos.lock().unwrap()
    }

    pub(crate) fn set_cat_pos(&self, x: f64, y: f64) {
        *self.cat_pos.lock().unwrap() = Some((x, y));
    }

    /// When the cat was last fed, if ever.
    pub(crate) fn last_feed(&self) -> Option<Instant> {
        *self.last_feed.lock().unwrap()
    }

    fn set_last_feed(&self) {
        *self.last_feed.lock().unwrap() = Some(Instant::now());
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Read + aggregate the logs. Runs on a blocking thread so the UI never stalls.
#[tauri::command]
async fn get_usage() -> Usage {
    tauri::async_runtime::spawn_blocking(usage::collect)
        .await
        .unwrap_or_default()
}

/// Switch mode: `grab = true` → Grab (interactive, frozen), `false` → Roam
/// (click-through, wandering).
#[tauri::command]
fn set_mode(app: AppHandle, grab: bool) {
    apply_mode(&app, grab);
}

/// Current mode as `"roam"` / `"grab"` for the frontend to sync against.
#[tauri::command]
fn get_mode(state: tauri::State<'_, AppState>) -> String {
    if state.grabbed.load(Ordering::SeqCst) {
        "grab".into()
    } else {
        "roam".into()
    }
}

/// The frontend reports the cat's current mood so Roam mode can tune how
/// lively the wander is (see `roam::params`).
#[tauri::command]
fn set_cat_state(state: tauri::State<'_, AppState>, cat_state: String) {
    *state.cat_state.lock().unwrap() = cat_state;
}

/// Begin an OS-level window drag (called when dragging the cat in grab mode).
#[tauri::command]
fn start_drag(window: tauri::Window) {
    let _ = window.start_dragging();
}

/// Show + focus the details window.
#[tauri::command]
fn open_details(app: AppHandle) {
    if let Some(w) = app.get_webview_window("details") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn hide_details(app: AppHandle) {
    if let Some(w) = app.get_webview_window("details") {
        let _ = w.hide();
    }
}

/// Feed the cat (from the details window). Rate-limited to once per
/// [`FEED_COOLDOWN`]; returns `false` (a no-op) while cooling down so the UI can
/// keep its button disabled. On success we send the cat trotting to the food
/// bowl (Roam only) and broadcast `feed-cat` so the frontend can sparkle the
/// bowl and show the "just ate" reaction.
#[tauri::command]
fn feed_cat(app: AppHandle, state: tauri::State<'_, AppState>) -> bool {
    if let Some(t) = state.last_feed() {
        if t.elapsed() < FEED_COOLDOWN {
            return false;
        }
    }
    state.set_last_feed();

    // In Roam, walk the cat over to the bowl (right prop, 0.80 of the width).
    // The wander loop then holds it there for `FEED_HOLD` (see `roam.rs`).
    if state.is_roam() {
        if let Some(win) = app.get_webview_window("cat") {
            if let Some(wa) = workarea(&win) {
                let (w, h) = wa.logical_size();
                let max_x = (w - CAT_SIZE - WANDER_MARGIN).max(WANDER_MARGIN);
                let bx = (0.80 * w - CAT_SIZE / 2.0).clamp(WANDER_MARGIN, max_x);
                let by =
                    (h - CAT_SIZE - 6.0).clamp(WANDER_MARGIN, (h - CAT_SIZE).max(WANDER_MARGIN));
                let (px, py) = state.cat_pos().unwrap_or((bx, by));
                let dist = ((bx - px).powi(2) + (by - py).powi(2)).sqrt();
                let dur = ((dist / 190.0) * 1000.0).clamp(500.0, 3000.0) as u64;
                let direction = if bx < px { "left" } else { "right" };
                let _ = app.emit(
                    "cat-wander",
                    WanderEvent {
                        x: bx,
                        y: by,
                        duration_ms: dur,
                        direction: direction.to_string(),
                        gait: "walk".to_string(),
                    },
                );
                state.set_cat_pos(bx, by);
            }
        }
    }

    let _ = app.emit("feed-cat", ());
    true
}

/// Move the cat back to the top-right corner. Forces Roam first so the overlay
/// is full-screen and the placement lands where the user can see it.
#[tauri::command]
fn reset_position(app: AppHandle) {
    apply_mode(&app, false);
    let Some(win) = app.get_webview_window("cat") else {
        return;
    };
    let Some(wa) = workarea(&win) else { return };
    let (x, y) = default_cat_pos(&wa);
    app.state::<AppState>().set_cat_pos(x, y);
    let _ = app.emit("cat-place", PlaceEvent { x, y });
}

/// Move the whole overlay to the monitor the mouse is currently on and park the
/// cat at that screen's default corner. Forces Roam first (so the overlay is the
/// full-screen click-through window) before re-fitting it to the cursor monitor.
#[tauri::command]
fn move_to_cursor_monitor(app: AppHandle) {
    apply_mode(&app, false);
    let Some(win) = app.get_webview_window("cat") else {
        return;
    };
    // Prefer the cursor's monitor; fall back to the window's current one.
    let Some(wa) = cursor_workarea(&app).or_else(|| workarea(&win)) else {
        return;
    };
    expand_to_workarea(&win, &wa);
    let (x, y) = default_cat_pos(&wa);
    app.state::<AppState>().set_cat_pos(x, y);
    let _ = app.emit("cat-place", PlaceEvent { x, y });
}

/// The cat's current logical position, initializing to the default corner on
/// first call. The frontend calls this on mount to paint the cat immediately.
#[tauri::command]
fn get_cat_pos(app: AppHandle, state: tauri::State<'_, AppState>) -> (f64, f64) {
    if let Some(p) = state.cat_pos() {
        return p;
    }
    if let Some(win) = app.get_webview_window("cat") {
        if let Some(wa) = workarea(&win) {
            let p = default_cat_pos(&wa);
            state.set_cat_pos(p.0, p.1);
            return p;
        }
    }
    (WANDER_MARGIN, WANDER_MARGIN)
}

/// Called by the frontend right after it freezes the cat on entering Grab mode.
/// `x`/`y` are the cat's current logical position in the (full-screen) window.
/// We shrink the window down around the cat and reposition it so the cat stays
/// visually put, then hand back the cat's new offset within the small window.
#[tauri::command]
fn enter_grab(app: AppHandle, state: tauri::State<'_, AppState>, x: f64, y: f64) {
    let Some(win) = app.get_webview_window("cat") else {
        return;
    };
    let Some(wa) = workarea(&win) else { return };
    let scale = wa.scale;

    // The full-screen window sits at the work-area origin, so the cat's screen
    // position (physical px) is just the origin plus its logical offset.
    let cat_screen_x = wa.origin_x as f64 + x * scale;
    let cat_screen_y = wa.origin_y as f64 + y * scale;

    // Center the cat in the grab window, then clamp the window on-screen.
    let off_x = (GRAB_W - CAT_SIZE) / 2.0;
    let off_y = (GRAB_H - CAT_SIZE) / 2.0;
    let gw_phys = GRAB_W * scale;
    let gh_phys = GRAB_H * scale;
    let min_ox = wa.origin_x as f64;
    let min_oy = wa.origin_y as f64;
    let max_ox = (min_ox + wa.phys_w as f64 - gw_phys).max(min_ox);
    let max_oy = (min_oy + wa.phys_h as f64 - gh_phys).max(min_oy);
    let ox = (cat_screen_x - off_x * scale).clamp(min_ox, max_ox);
    let oy = (cat_screen_y - off_y * scale).clamp(min_oy, max_oy);

    let _ = win.set_size(PhysicalSize::new(gw_phys as u32, gh_phys as u32));
    let _ = win.set_position(PhysicalPosition::new(ox as i32, oy as i32));
    let _ = win.set_ignore_cursor_events(false);

    // Cat's exact offset inside the (possibly clamped) grab window.
    let cx = (cat_screen_x - ox) / scale;
    let cy = (cat_screen_y - oy) / scale;
    state.set_cat_pos(cx, cy);
    let _ = app.emit("cat-place", PlaceEvent { x: cx, y: cy });
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

fn apply_ignore_cursor(app: &AppHandle, ignore: bool) {
    if let Some(w) = app.get_webview_window("cat") {
        let _ = w.set_ignore_cursor_events(ignore);
    }
}

/// The active monitor's work area (menu bar / dock excluded), in physical px,
/// plus its scale factor. Falls back to the primary monitor.
pub(crate) struct WorkArea {
    pub origin_x: i32,
    pub origin_y: i32,
    pub phys_w: u32,
    pub phys_h: u32,
    pub scale: f64,
}

impl WorkArea {
    /// Window size in logical (CSS) px — what the frontend sees.
    pub fn logical_size(&self) -> (f64, f64) {
        (
            self.phys_w as f64 / self.scale,
            self.phys_h as f64 / self.scale,
        )
    }

    fn from_monitor(monitor: &tauri::Monitor) -> Self {
        let wa = monitor.work_area();
        WorkArea {
            origin_x: wa.position.x,
            origin_y: wa.position.y,
            phys_w: wa.size.width,
            phys_h: wa.size.height,
            scale: monitor.scale_factor(),
        }
    }
}

/// Work area of the monitor the cat window currently sits on (falls back to the
/// primary). Used once the overlay is placed, so all geometry stays on one
/// screen.
pub(crate) fn workarea(win: &WebviewWindow) -> Option<WorkArea> {
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())?;
    Some(WorkArea::from_monitor(&monitor))
}

/// Work area of the monitor under the mouse cursor (falls back to the primary).
/// Multi-monitor placement: on launch and on "이 화면으로 이동" we drop the
/// overlay onto whichever screen the user is actually looking at.
pub(crate) fn cursor_workarea(app: &AppHandle) -> Option<WorkArea> {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    Some(WorkArea::from_monitor(&monitor))
}

/// Default resting spot: top-right corner of the work area, inset by the margin.
pub(crate) fn default_cat_pos(wa: &WorkArea) -> (f64, f64) {
    let (w, _) = wa.logical_size();
    (
        (w - CAT_SIZE - WANDER_MARGIN).max(WANDER_MARGIN),
        WANDER_MARGIN,
    )
}

/// Blow the window up to cover the whole work area (Roam overlay).
fn expand_to_workarea(win: &WebviewWindow, wa: &WorkArea) {
    let _ = win.set_size(PhysicalSize::new(wa.phys_w, wa.phys_h));
    let _ = win.set_position(PhysicalPosition::new(wa.origin_x, wa.origin_y));
}

/// Enter Roam: expand the window to the full work area, keeping the cat visually
/// where it was (translating its logical position from the old, possibly small
/// and user-dragged, window into the full-screen one), then re-arm click-through.
fn enter_roam_window(app: &AppHandle, win: &WebviewWindow) {
    let Some(wa) = workarea(win) else {
        return;
    };
    let scale = wa.scale;

    // Where is the cat on screen right now? old window origin + its offset.
    let screen = match (win.outer_position(), app.state::<AppState>().cat_pos()) {
        (Ok(origin), Some((cx, cy))) => {
            Some((origin.x as f64 + cx * scale, origin.y as f64 + cy * scale))
        }
        _ => None,
    };

    expand_to_workarea(win, &wa);

    let (w, h) = wa.logical_size();
    let max_x = (w - CAT_SIZE - WANDER_MARGIN).max(WANDER_MARGIN);
    let max_y = (h - CAT_SIZE - WANDER_MARGIN).max(WANDER_MARGIN);
    let (nx, ny) = match screen {
        Some((sx, sy)) => (
            ((sx - wa.origin_x as f64) / scale).clamp(WANDER_MARGIN, max_x),
            ((sy - wa.origin_y as f64) / scale).clamp(WANDER_MARGIN, max_y),
        ),
        None => default_cat_pos(&wa),
    };

    app.state::<AppState>().set_cat_pos(nx, ny);
    let _ = app.emit("cat-place", PlaceEvent { x: nx, y: ny });
}

/// Apply a mode. Grab captures the mouse (drag/click) and the wander loop
/// freezes; the frontend then freezes the cat and calls `enter_grab`, which
/// shrinks the window around it. Roam re-expands the window to a full-screen
/// click-through overlay and resumes wandering. Broadcasts `mode-change`
/// (`"roam"` / `"grab"`) so the frontend can react, and keeps the tray in sync.
pub fn apply_mode(app: &AppHandle, grab: bool) {
    app.state::<AppState>()
        .grabbed
        .store(grab, Ordering::SeqCst);

    if grab {
        // Stay click-through for now: the window is still full-screen, so
        // catching clicks here would block the whole desktop. `enter_grab`
        // (called once the frontend freezes the cat and reports its position)
        // shrinks the window and *then* makes it interactive.
    } else if let Some(win) = app.get_webview_window("cat") {
        // Re-assert click-through *before* re-expanding to full-screen so the
        // overlay never blocks clicks during the resize.
        apply_ignore_cursor(app, true);
        enter_roam_window(app, &win);
    }

    let _ = app.emit("mode-change", if grab { "grab" } else { "roam" });
    tray::update_mode(app, grab);
}

/// First-launch overlay setup: size the window to the full work area, place the
/// cat at its default spot, and make it click-through.
fn setup_overlay(app: &AppHandle) {
    let Some(win) = app.get_webview_window("cat") else {
        return;
    };
    // Start on the monitor the cursor is on rather than always the primary.
    if let Some(wa) = cursor_workarea(app).or_else(|| workarea(&win)) {
        expand_to_workarea(&win, &wa);
        let (x, y) = default_cat_pos(&wa);
        app.state::<AppState>().set_cat_pos(x, y);
    }
    apply_ignore_cursor(app, true);
}

// ---------------------------------------------------------------------------
// Background: poll usage and push snapshots to the frontend
// ---------------------------------------------------------------------------

fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        let usage = usage::collect();
        let _ = app.emit("usage", &usage);
        std::thread::sleep(Duration::from_secs(POLL_SECS));
    });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .manage(AppState::default())
        .manage(presence::Presence::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri_plugin_window_state::StateFlags;

        // Self-update. `check()` is driven from the frontend (auto on launch +
        // the tray "새 버전 확인" menu); `process` gives us `relaunch()` after an
        // install. If the release isn't signed (no key configured yet) `check()`
        // simply errors and the frontend falls back to opening the Releases page.
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());

        // The cat window is now a full-screen overlay we size ourselves each
        // launch, so keep the window-state plugin from restoring/persisting its
        // geometry (it still manages the details window). We restrict the saved
        // flags to POSITION + SIZE: the details window opens hidden and toggles
        // via the tray/cat, so restoring VISIBLE/DECORATIONS would fight that.
        builder = builder.plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION | StateFlags::SIZE)
                .with_denylist(&["cat"])
                .build(),
        );
        // Autostart via a macOS LaunchAgent. Registration is opt-in from the
        // details window — we never enable it here, so a fresh install stays off
        // until the user flips the toggle.
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts([GRAB_SHORTCUT])
                .expect("valid grab shortcut")
                .with_handler(|app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    // Toggle Roam <-> Grab.
                    let grabbed = app.state::<AppState>().grabbed.load(Ordering::SeqCst);
                    apply_mode(app, !grabbed);
                })
                .build(),
        );
    }

    builder
        .invoke_handler(tauri::generate_handler![
            get_usage,
            set_mode,
            get_mode,
            set_cat_state,
            start_drag,
            open_details,
            hide_details,
            reset_position,
            move_to_cursor_monitor,
            get_cat_pos,
            enter_grab,
            feed_cat,
            presence::presence_start,
            presence::presence_publish,
            presence::presence_stop,
            presence::presence_peers,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Accessory app: live in the menu bar, no dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Cat starts in Roam mode: a full-screen, click-through overlay with
            // the cat parked at its default corner, ready to wander.
            setup_overlay(&handle);

            // Best-effort multi-monitor upkeep: when the cat window's monitor
            // changes DPI/resolution (e.g. a display is reconfigured or the
            // window is dragged to a different-density screen), re-fit the
            // overlay to the new work area so it doesn't end up mis-sized. Only
            // acts in Roam, where we own the full-screen geometry.
            if let Some(cat) = app.get_webview_window("cat") {
                let h = handle.clone();
                cat.on_window_event(move |event| {
                    if let tauri::WindowEvent::ScaleFactorChanged { .. } = event {
                        if h.state::<AppState>().is_roam() {
                            if let Some(win) = h.get_webview_window("cat") {
                                enter_roam_window(&h, &win);
                            }
                        }
                    }
                });
            }

            // Keep the details window closed rather than destroyed so it can be
            // reopened instantly from the tray / cat.
            if let Some(details) = app.get_webview_window("details") {
                let d = details.clone();
                details.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = d.hide();
                    }
                });
            }

            tray::build(app)?;
            // Reflect the initial mode (Roam) in the freshly-built tray.
            tray::update_mode(&handle, false);
            spawn_poller(handle.clone());
            roam::spawn(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running clawd");
}
