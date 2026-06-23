// macOS traffic lights (close/minimize/zoom) auto-hide: hidden by default,
// shown when the user hovers the title strip at the top of the window.
// On Linux and Windows this is a no-op (those platforms have no traffic lights).

#[tauri::command]
pub fn set_traffic_lights_visible(window: tauri::WebviewWindow, visible: bool) {
    #[cfg(target_os = "macos")]
    set_visible_macos(&window, visible);

    #[cfg(not(target_os = "macos"))]
    let _ = (window, visible);
}

#[cfg(target_os = "macos")]
fn set_visible_macos(window: &tauri::WebviewWindow, visible: bool) {
    use objc::{msg_send, sel, sel_impl, runtime::Object};

    // Tauri 2 exposes the NSWindow pointer directly via Window::ns_window().
    // WebviewWindow delegates to Window internally.
    let Ok(ns_window) = window.ns_window() else { return };
    let ns_window = ns_window as *mut Object;

    // NSWindowButton constants: Close=0, Miniaturize=1, Zoom=2
    for button_kind in 0usize..=2 {
        unsafe {
            let btn: *mut Object = msg_send![ns_window, standardWindowButton: button_kind];
            if btn.is_null() { continue; }
            let hidden: objc::runtime::BOOL = if visible { objc::runtime::NO } else { objc::runtime::YES };
            let _: () = msg_send![btn, setHidden: hidden];
        }
    }
}
