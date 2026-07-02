//! Menu-bar tray icon: show/hide the cat, reset its position, open settings,
//! and quit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, Manager};

pub fn build(app: &App) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle_cat", "고양이 숨기기 / 보이기", true, None::<&str>)?;
    let reset = MenuItem::with_id(app, "reset_pos", "위치 초기화", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "상세 · 임계값 설정…", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "종료 (Quit)", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &reset, &settings, &sep, &quit])?;

    let mut tray = TrayIconBuilder::with_id("clawd-tray")
        .menu(&menu)
        .tooltip("clawd — Claude Code usage cat");
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.on_menu_event(|app, event| match event.id.as_ref() {
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

    Ok(())
}
