use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

// A webview's user-agent is fixed at creation, so we track it and recreate the
// webview when the requested UA changes (e.g. switching Chrome ↔ Safari per site).
struct Panel {
    webview: tauri::Webview,
    ua: Option<String>,
}

#[derive(Default)]
pub struct WebPanelState {
    panels: Mutex<HashMap<String, Panel>>,
}

// add_child embeds the webview inside the main window, positioned with
// window-relative coordinates — exactly what getBoundingClientRect() returns,
// so no screen-coordinate conversion is needed.
#[tauri::command]
pub fn web_panel_navigate(
    app: tauri::AppHandle,
    id: String,
    url: String,
    rect_x: f64,
    rect_y: f64,
    width: f64,
    height: f64,
    user_agent: Option<String>,
    state: tauri::State<'_, WebPanelState>,
) -> Result<(), String> {
    let url_parsed = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let mut panels = state.panels.lock().unwrap();

    if let Some(panel) = panels.get(&id) {
        if panel.ua == user_agent {
            let _ = panel.webview.navigate(url_parsed);
            let _ = panel.webview.set_position(LogicalPosition::new(rect_x, rect_y));
            let _ = panel.webview.set_size(LogicalSize::new(width, height));
            let _ = panel.webview.show();
            return Ok(());
        }
        // UA changed — drop the old webview and fall through to recreate it.
        if let Some(old) = panels.remove(&id) {
            let _ = old.webview.close();
        }
    }

    let window = app.get_window("main").ok_or("main window not found")?;
    let mut builder = WebviewBuilder::new(&id, WebviewUrl::External(url_parsed));
    if let Some(ua) = &user_agent {
        builder = builder.user_agent(ua);
    }
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(rect_x, rect_y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;

    panels.insert(id, Panel { webview, ua: user_agent });
    Ok(())
}

#[tauri::command]
pub fn web_panel_set_bounds(
    id: String,
    rect_x: f64,
    rect_y: f64,
    width: f64,
    height: f64,
    state: tauri::State<'_, WebPanelState>,
) -> Result<(), String> {
    let panels = state.panels.lock().unwrap();
    if let Some(panel) = panels.get(&id) {
        let _ = panel.webview.set_position(LogicalPosition::new(rect_x, rect_y));
        let _ = panel.webview.set_size(LogicalSize::new(width, height));
    }
    Ok(())
}

#[tauri::command]
pub fn web_panel_set_visible(
    id: String,
    visible: bool,
    state: tauri::State<'_, WebPanelState>,
) -> Result<(), String> {
    let panels = state.panels.lock().unwrap();
    if let Some(panel) = panels.get(&id) {
        if visible { let _ = panel.webview.show(); } else { let _ = panel.webview.hide(); }
    }
    Ok(())
}

#[tauri::command]
pub fn web_panel_close(
    id: String,
    state: tauri::State<'_, WebPanelState>,
) -> Result<(), String> {
    let mut panels = state.panels.lock().unwrap();
    if let Some(panel) = panels.remove(&id) {
        let _ = panel.webview.close();
    }
    Ok(())
}

// Webviews live in this (Rust-owned) state for the whole process, so they survive
// a frontend reload as orphans. The frontend calls this on startup to clean them up.
#[tauri::command]
pub fn web_panel_close_all(state: tauri::State<'_, WebPanelState>) -> Result<(), String> {
    let mut panels = state.panels.lock().unwrap();
    for (_, panel) in panels.drain() {
        let _ = panel.webview.close();
    }
    Ok(())
}
