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

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

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

/// Move the cat back to the top-right corner.
#[tauri::command]
fn reset_position(app: AppHandle) {
    place_top_right(&app);
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

fn apply_ignore_cursor(app: &AppHandle, ignore: bool) {
    if let Some(w) = app.get_webview_window("cat") {
        let _ = w.set_ignore_cursor_events(ignore);
    }
}

/// Apply a mode. Grab captures the mouse (drag/click) and the wander loop
/// freezes; Roam passes events through and resumes wandering. Broadcasts a
/// `mode-change` event (`"roam"` / `"grab"`) so the frontend can show its
/// feedback, and keeps the tray in sync.
pub fn apply_mode(app: &AppHandle, grab: bool) {
    let state = app.state::<AppState>();
    state.grabbed.store(grab, Ordering::SeqCst);
    apply_ignore_cursor(app, !grab);
    let _ = app.emit("mode-change", if grab { "grab" } else { "roam" });
    tray::update_mode(app, grab);
}

/// Park the cat near the top-right of the primary monitor with a small inset.
fn place_top_right(app: &AppHandle) {
    let Some(window) = app.get_webview_window("cat") else {
        return;
    };
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let screen = monitor.size();
        let win = window
            .outer_size()
            .unwrap_or(tauri::PhysicalSize::new(240, 210));
        let inset = (24.0 * monitor.scale_factor()) as i32;
        let x = screen.width as i32 - win.width as i32 - inset;
        let y = inset;
        let _ = window.set_position(PhysicalPosition::new(x.max(0), y));
    }
}

/// First-run only: place top-right and drop a marker so later launches let the
/// window-state plugin restore wherever the user last dragged the cat.
fn place_on_first_run(app: &AppHandle) {
    let marker = app
        .path()
        .app_config_dir()
        .ok()
        .map(|d| d.join(".placed"));
    if let Some(marker) = marker {
        if marker.exists() {
            return;
        }
        place_top_right(app);
        if let Some(parent) = marker.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&marker, b"1");
    } else {
        place_top_right(app);
    }
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
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
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
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Accessory app: live in the menu bar, no dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Cat starts in Roam mode: fully click-through and wandering.
            apply_ignore_cursor(&handle, true);
            place_on_first_run(&handle);

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
