//! clawd — a floating cat that reflects Claude Code usage.
//!
//! The Rust side owns everything the WebView can't do well: reading the
//! `~/.claude` session logs, keeping the cat window click-through until the
//! ⌘⇧C grab hotkey flips it interactive, the tray, and native notifications.

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

/// The global hotkey that toggles "grab" mode: the cat becomes interactive
/// (mouse events captured) so you can drag or click it, then passes events
/// through again when toggled off.
const PIN_SHORTCUT: &str = "cmd+shift+c";

pub struct AppState {
    /// When grabbed (⌘⇧C), the cat captures the mouse instead of passing
    /// events through. Named `pinned` for backward compat with the store.
    pinned: AtomicBool,
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
            pinned: AtomicBool::new(false),
            daily_budget: Mutex::new(DEFAULT_DAILY_BUDGET),
            notify_enabled: AtomicBool::new(true),
            notified_day: Mutex::new(String::new()),
            notified_80: AtomicBool::new(false),
            notified_100: AtomicBool::new(false),
        }
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

/// Pin / unpin interactive mode (mouse capture without holding Option).
#[tauri::command]
fn set_pinned(app: AppHandle, pinned: bool) {
    set_grab(&app, pinned);
}

#[tauri::command]
fn get_pinned(state: tauri::State<'_, AppState>) -> bool {
    state.pinned.load(Ordering::SeqCst)
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

/// Toggle "grab" mode: when grabbed the cat captures the mouse (drag/click),
/// otherwise events pass straight through. Also broadcasts a `grab-mode` event
/// so the frontend can show its glowing-ring feedback and stay in sync.
fn set_grab(app: &AppHandle, grabbed: bool) {
    let state = app.state::<AppState>();
    state.pinned.store(grabbed, Ordering::SeqCst);
    apply_ignore_cursor(app, !grabbed);
    let _ = app.emit("grab-mode", grabbed);
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
            .unwrap_or(tauri::PhysicalSize::new(160, 160));
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
                .with_shortcuts([PIN_SHORTCUT])
                .expect("valid pin shortcut")
                .with_handler(|app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let state = app.state::<AppState>();
                    let now = !state.pinned.load(Ordering::SeqCst);
                    set_grab(app, now);
                })
                .build(),
        );
    }

    builder
        .invoke_handler(tauri::generate_handler![
            get_usage,
            set_pinned,
            get_pinned,
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

            // Cat starts fully click-through.
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
            spawn_poller(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running clawd");
}
