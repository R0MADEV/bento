#[tauri::command]
pub fn set_decorations(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_decorations(enabled).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    // set_decorations is a thin wrapper over Tauri's WebviewWindow::set_decorations;
    // the Tauri runtime is not available in unit tests so there is nothing to assert here.
    // Integration coverage comes from the frontend preference round-trip tests.
}
