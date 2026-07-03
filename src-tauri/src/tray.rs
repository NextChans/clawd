//! Menu-bar tray: switch between Roam / Grab mode, show/hide the cat, reset its
//! position, open settings, and quit.
//!
//! The three mode entries (Roam / Grab / Fishing) are `CheckMenuItem`s used as a
//! radio group (Tauri has no native one), kept mutually exclusive by
//! [`update_mode_str`]. We stash their handles + the tray icon in
//! [`TrayHandles`] so [`crate::apply_mode`] / [`crate::apply_fishing`] can
//! reflect the current mode from anywhere (hotkey, command, menu click).

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{App, AppHandle, Manager, Wry};

/// Live handles we need to keep in sync as the mode changes.
pub struct TrayHandles {
    pub roam_item: CheckMenuItem<Wry>,
    pub grab_item: CheckMenuItem<Wry>,
    pub fish_item: CheckMenuItem<Wry>,
    pub tray: TrayIcon<Wry>,
}

pub fn build(app: &App) -> tauri::Result<()> {
    let roam_item =
        CheckMenuItem::with_id(app, "mode_roam", "🐾 놀기 (Roam)", true, true, None::<&str>)?;
    let grab_item = CheckMenuItem::with_id(
        app,
        "mode_grab",
        "🖐️ 잡기 (Grab)",
        true,
        false,
        None::<&str>,
    )?;
    let fish_item = CheckMenuItem::with_id(
        app,
        "mode_fish",
        "🎣 낚시대 놀이",
        true,
        false,
        None::<&str>,
    )?;
    let feed = MenuItem::with_id(app, "feed", "🍚 먹이 주기", true, None::<&str>)?;

    let toggle = MenuItem::with_id(
        app,
        "toggle_cat",
        "고양이 숨기기 / 보이기",
        true,
        None::<&str>,
    )?;
    let reset = MenuItem::with_id(app, "reset_pos", "위치 초기화", true, None::<&str>)?;
    let move_here = MenuItem::with_id(app, "move_here", "이 화면으로 이동", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "상세 · 설정…", true, None::<&str>)?;
    let check_update = MenuItem::with_id(app, "check_update", "새 버전 확인…", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "종료 (Quit)", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &roam_item,
            &grab_item,
            &fish_item,
            &feed,
            &sep1,
            &toggle,
            &reset,
            &move_here,
            &settings,
            &check_update,
            &sep2,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("clawd-tray")
        .menu(&menu)
        .tooltip("clawd — 🐾 놀기 (Roam)");
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    let tray = builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "mode_roam" => crate::apply_mode(app, false),
            "mode_grab" => crate::apply_mode(app, true),
            "mode_fish" => {
                // Toggle: a second click on the fishing item leaves play.
                let fishing = app.state::<crate::AppState>().is_fishing();
                crate::apply_fishing(app, !fishing);
            }
            "feed" => {
                // Backend rate-limits (FEED_COOLDOWN), so a click while cooling
                // down is simply a no-op.
                crate::do_feed(app);
            }
            "toggle_cat" => {
                if let Some(w) = app.get_webview_window("cat") {
                    if w.is_visible().unwrap_or(true) {
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                    }
                }
            }
            "reset_pos" => crate::reset_position(app.clone()),
            "move_here" => crate::move_to_cursor_monitor(app.clone()),
            "settings" => crate::open_details(app.clone()),
            "check_update" => {
                // Hand off to the frontend's updater (details window): show the
                // window and fire the check event. The hook runs `check()` and,
                // on any failure (e.g. an unsigned release), falls back to
                // opening the Releases page itself. See `useUpdater.ts`.
                use tauri::Emitter;
                crate::open_details(app.clone());
                let _ = app.emit("clawd://check-update", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    app.manage(TrayHandles {
        roam_item,
        grab_item,
        fish_item,
        tray,
    });

    Ok(())
}

/// Reflect the active mode in the tray: check the right radio item and update
/// the icon tooltip + title suffix. `mode` is `"roam"` / `"grab"` / `"fishing"`.
/// macOS template icons can't easily be recolored, so the title suffix is our
/// state indicator.
pub fn update_mode_str(app: &AppHandle, mode: &str) {
    let Some(h) = app.try_state::<TrayHandles>() else {
        return;
    };
    let _ = h.roam_item.set_checked(mode == "roam");
    let _ = h.grab_item.set_checked(mode == "grab");
    let _ = h.fish_item.set_checked(mode == "fishing");
    // Always set a concrete, non-empty title: on macOS `set_title(None)` doesn't
    // reliably clear a previously-set title, which left an old suffix stuck. A
    // per-mode glyph is also a clearer indicator.
    let (tip, title) = match mode {
        "grab" => ("clawd — 🖐️ 잡기 (Grab)", "✋"),
        "fishing" => ("clawd — 🎣 낚시대 놀이", "🎣"),
        _ => ("clawd — 🐾 놀기 (Roam)", "🐾"),
    };
    let _ = h.tray.set_tooltip(Some(tip));
    let _ = h.tray.set_title(Some(title));
}
