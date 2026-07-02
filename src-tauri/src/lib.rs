//! clawd — a floating cat that reflects Claude Code usage.
//!
//! The Rust side owns everything the WebView can't do well: reading the
//! `~/.claude` session logs, the two interaction modes — **Roam** (click-through
//! + auto-wander) and **Grab** (interactive, frozen) — the wander animation, the
//! tray, and native notifications.

mod roam;
mod tray;
mod usage;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use usage::Usage;

/// Default daily spend budget in USD. The cat's "how stressed am I" ratio and
/// the 80%/100% notifications are relative to this. Tunable from the UI.
const DEFAULT_DAILY_BUDGET: f64 = 20.0;

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

pub struct AppState {
    /// `false` = **Roam** (click-through, auto-wander), `true` = **Grab** (the
    /// cat captures the mouse for drag/click and holds still).
    grabbed: AtomicBool,
    /// Latest `CatState` the frontend reported, used to tune the wander.
    cat_state: Mutex<String>,
    /// Daily budget in USD, and whether budget notifications fire.
    daily_budget: Mutex<f64>,
    notify_enabled: AtomicBool,
    /// Which budget thresholds have already fired today, keyed by day so they
    /// re-arm at midnight.
    notified_day: Mutex<String>,
    notified_80: AtomicBool,
    notified_100: AtomicBool,
    /// The cat's current logical top-left position within the window (CSS px).
    /// `None` until first placed. Shared with the wander loop (`roam.rs`).
    cat_pos: Mutex<Option<(f64, f64)>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            grabbed: AtomicBool::new(false),
            cat_state: Mutex::new(DEFAULT_CAT_STATE.to_string()),
            daily_budget: Mutex::new(DEFAULT_DAILY_BUDGET),
            notify_enabled: AtomicBool::new(true),
            notified_day: Mutex::new(String::new()),
            notified_80: AtomicBool::new(false),
            notified_100: AtomicBool::new(false),
            cat_pos: Mutex::new(None),
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

/// Persist the two knobs the Rust side cares about (budget + notifications).
#[tauri::command]
fn set_config(state: tauri::State<'_, AppState>, daily_budget: f64, notify_enabled: bool) {
    if daily_budget > 0.0 {
        *state.daily_budget.lock().unwrap() = daily_budget;
    }
    state.notify_enabled.store(notify_enabled, Ordering::SeqCst);
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
        (self.phys_w as f64 / self.scale, self.phys_h as f64 / self.scale)
    }
}

pub(crate) fn workarea(win: &WebviewWindow) -> Option<WorkArea> {
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())?;
    let wa = monitor.work_area();
    Some(WorkArea {
        origin_x: wa.position.x,
        origin_y: wa.position.y,
        phys_w: wa.size.width,
        phys_h: wa.size.height,
        scale: monitor.scale_factor(),
    })
}

/// Default resting spot: top-right corner of the work area, inset by the margin.
pub(crate) fn default_cat_pos(wa: &WorkArea) -> (f64, f64) {
    let (w, _) = wa.logical_size();
    ((w - CAT_SIZE - WANDER_MARGIN).max(WANDER_MARGIN), WANDER_MARGIN)
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
    app.state::<AppState>().grabbed.store(grab, Ordering::SeqCst);

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
    if let Some(wa) = workarea(&win) {
        expand_to_workarea(&win, &wa);
        let (x, y) = default_cat_pos(&wa);
        app.state::<AppState>().set_cat_pos(x, y);
    }
    apply_ignore_cursor(app, true);
}

// ---------------------------------------------------------------------------
// Background: poll usage + fire notifications
// ---------------------------------------------------------------------------

fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        let usage = usage::collect();
        let _ = app.emit("usage", &usage);
        maybe_notify(&app, &usage);
        std::thread::sleep(Duration::from_secs(POLL_SECS));
    });
}

fn maybe_notify(app: &AppHandle, usage: &Usage) {
    use tauri_plugin_notification::NotificationExt;

    let state = app.state::<AppState>();
    if !state.notify_enabled.load(Ordering::SeqCst) {
        return;
    }

    // Re-arm the flags on a new calendar day.
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    {
        let mut day = state.notified_day.lock().unwrap();
        if *day != today {
            *day = today;
            state.notified_80.store(false, Ordering::SeqCst);
            state.notified_100.store(false, Ordering::SeqCst);
        }
    }

    let budget = *state.daily_budget.lock().unwrap();
    if budget <= 0.0 {
        return;
    }
    let ratio = usage.today_cost / budget;

    if ratio >= 1.0 && !state.notified_100.swap(true, Ordering::SeqCst) {
        let _ = app
            .notification()
            .builder()
            .title("clawd — 예산 초과 😾")
            .body(format!(
                "오늘 ${:.2} · 일일 예산 ${:.0} 100% 도달",
                usage.today_cost, budget
            ))
            .show();
    } else if ratio >= 0.8 && !state.notified_80.swap(true, Ordering::SeqCst) {
        let _ = app
            .notification()
            .builder()
            .title("clawd — 예산 80% ⚠️")
            .body(format!(
                "오늘 ${:.2} · 일일 예산 ${:.0}의 {:.0}%",
                usage.today_cost,
                budget,
                ratio * 100.0
            ))
            .show();
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // The cat window is now a full-screen overlay we size ourselves each
        // launch, so keep the window-state plugin from restoring/persisting its
        // geometry (it still manages the details window).
        builder = builder.plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["cat"])
                .build(),
        );
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
            set_config,
            start_drag,
            open_details,
            hide_details,
            reset_position,
            get_cat_pos,
            enter_grab,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Accessory app: live in the menu bar, no dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Cat starts in Roam mode: a full-screen, click-through overlay with
            // the cat parked at its default corner, ready to wander.
            setup_overlay(&handle);

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
