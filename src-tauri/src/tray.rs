//! Menu-bar tray: switch between Roam / Grab mode, show/hide the cat, reset its
//! position, open settings, and quit.
//!
//! The two mode entries are `CheckMenuItem`s used as a radio pair (Tauri has no
//! native radio group), kept mutually exclusive by [`update_mode`]. We stash
//! their handles + the tray icon in [`TrayHandles`] so [`crate::apply_mode`] can
//! reflect the current mode from anywhere (hotkey, command, menu click).

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{App, AppHandle, Manager, Wry};

/// Live handles we need to keep in sync as the mode changes.
pub struct TrayHandles {
    pub roam_item: CheckMenuItem<Wry>,
    pub grab_item: CheckMenuItem<Wry>,
    pub tray: TrayIcon<Wry>,
}

pub fn build(app: &App) -> tauri::Result<()> {
    let roam_item =
        CheckMenuItem::with_id(app, "mode_roam", "🐾 놀기 (Roam)", true, true, None::<&str>)?;
    let grab_item =
        CheckMenuItem::with_id(app, "mode_grab", "🖐️ 잡기 (Grab)", true, false, None::<&str>)?;

    let toggle = MenuItem::with_id(app, "toggle_cat", "고양이 숨기기 / 보이기", true, None::<&str>)?;
    let reset = MenuItem::with_id(app, "reset_pos", "위치 초기화", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "상세 · 설정…", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "종료 (Quit)", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &roam_item, &grab_item, &sep1, &toggle, &reset, &settings, &sep2, &quit,
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
            "settings" => crate::open_details(app.clone()),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    app.manage(TrayHandles {
        roam_item,
        grab_item,
        tray,
    });

    Ok(())
}

/// Reflect the active mode in the tray: check the right radio item and update
/// the icon tooltip + title suffix. macOS template icons can't easily be
/// recolored, so the title suffix is our state indicator.
pub fn update_mode(app: &AppHandle, grab: bool) {
    let Some(h) = app.try_state::<TrayHandles>() else {
        return;
    };
    let _ = h.roam_item.set_checked(!grab);
    let _ = h.grab_item.set_checked(grab);
    // Always set a concrete, non-empty title: on macOS `set_title(None)` doesn't
    // reliably clear a previously-set title, which left the "✋" suffix stuck
    // after switching back to Roam. A per-mode glyph is also a clearer indicator.
    if grab {
        let _ = h.tray.set_tooltip(Some("clawd — 🖐️ 잡기 (Grab)"));
        let _ = h.tray.set_title(Some("✋"));
    } else {
        let _ = h.tray.set_tooltip(Some("clawd — 🐾 놀기 (Roam)"));
        let _ = h.tray.set_title(Some("🐾"));
    }
}
