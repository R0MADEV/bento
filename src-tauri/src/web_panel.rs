use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl};

#[derive(Default)]
pub struct WebPanelState {
    panels: Mutex<HashMap<String, tauri::WebviewWindow>>,
}

#[tauri::command]
pub fn web_panel_navigate(
    app: tauri::AppHandle,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    state: tauri::State<'_, WebPanelState>,
) -> Result<(), String> {
    let mut panels = state.panels.lock().unwrap();

    if let Some(panel) = panels.get(&id) {
        let _ = panel.navigate(url.parse::<tauri::Url>().map_err(|e| e.to_string())?);
        let _ = panel.set_position(tauri::Position::Logical(LogicalPosition::new(x, y)));
        let _ = panel.set_size(tauri::Size::Logical(LogicalSize::new(width, height)));
        let _ = panel.show();
        return Ok(());
    }

    let main = app
        .get_webview_window("main")
        .ok_or("main window not found")?;

    let panel = tauri::WebviewWindowBuilder::new(
        &app,
        &id,
        WebviewUrl::External(url.parse::<tauri::Url>().map_err(|e| e.to_string())?),
    )
    .decorations(false)
    .skip_taskbar(true)
    .resizable(false)
    .position(x, y)
    .inner_size(width, height)
    // Chrome UA so sites like WhatsApp/Jira don't reject the WKWebView engine
    .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
    .parent(&main)
    .map_err(|e| e.to_string())?
    .build()
    .map_err(|e| e.to_string())?;

    panels.insert(id, panel);
    Ok(())
}

#[tauri::command]
pub fn web_panel_set_bounds(
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    state: tauri::State<'_, WebPanelState>,
) -> Result<(), String> {
    let panels = state.panels.lock().unwrap();
    if let Some(panel) = panels.get(&id) {
        let _ = panel.set_position(tauri::Position::Logical(LogicalPosition::new(x, y)));
        let _ = panel.set_size(tauri::Size::Logical(LogicalSize::new(width, height)));
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
        if visible {
            let _ = panel.show();
        } else {
            let _ = panel.hide();
        }
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
        let _ = panel.close();
    }
    Ok(())
}
