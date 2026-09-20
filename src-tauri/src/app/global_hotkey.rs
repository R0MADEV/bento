//! System-wide hotkey that shows/hides Bento from any app.
//!
//! Registered straight through Carbon because `tauri-plugin-global-shortcut`
//! (global-hotkey 0.8) has no mapping for `kVK_ISO_Section`, the key under Esc
//! on ISO keyboards (º on Spanish layouts).

use std::ffi::c_void;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

type OSStatus = i32;
type EventTargetRef = *mut c_void;
type EventHandlerRef = *mut c_void;
type EventHotKeyRef = *mut c_void;
type EventHandler = extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> OSStatus;

#[repr(C)]
struct EventTypeSpec {
    event_class: u32,
    event_kind: u32,
}

#[repr(C)]
struct EventHotKeyID {
    signature: u32,
    id: u32,
}

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn GetApplicationEventTarget() -> EventTargetRef;
    fn InstallEventHandler(
        target: EventTargetRef,
        handler: EventHandler,
        num_types: u32,
        types: *const EventTypeSpec,
        user_data: *mut c_void,
        out_ref: *mut EventHandlerRef,
    ) -> OSStatus;
    fn RegisterEventHotKey(
        key_code: u32,
        modifiers: u32,
        id: EventHotKeyID,
        target: EventTargetRef,
        options: u32,
        out_ref: *mut EventHotKeyRef,
    ) -> OSStatus;
}

const K_VK_ISO_SECTION: u32 = 0x0a;
const NO_MODIFIERS: u32 = 0;
const K_EVENT_CLASS_KEYBOARD: u32 = u32::from_be_bytes(*b"keyb");
const K_EVENT_HOT_KEY_PRESSED: u32 = 5;
const HOTKEY_SIGNATURE: u32 = u32::from_be_bytes(*b"bnto");

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Must run on the main thread (Tauri's `setup` does).
pub fn register(app: &AppHandle) -> Result<(), String> {
    if APP.set(app.clone()).is_err() {
        return Ok(());
    }
    let pressed = EventTypeSpec {
        event_class: K_EVENT_CLASS_KEYBOARD,
        event_kind: K_EVENT_HOT_KEY_PRESSED,
    };
    let id = EventHotKeyID {
        signature: HOTKEY_SIGNATURE,
        id: 1,
    };
    let mut handler_ref: EventHandlerRef = std::ptr::null_mut();
    let mut hotkey_ref: EventHotKeyRef = std::ptr::null_mut();
    // SAFETY: plain Carbon calls with valid pointers; the handler and hotkey
    // live for the whole process, so their refs are never released.
    unsafe {
        let target = GetApplicationEventTarget();
        let status = InstallEventHandler(target, on_hotkey, 1, &pressed, std::ptr::null_mut(), &mut handler_ref);
        if status != 0 {
            return Err(format!("InstallEventHandler failed ({status})"));
        }
        let status = RegisterEventHotKey(K_VK_ISO_SECTION, NO_MODIFIERS, id, target, 0, &mut hotkey_ref);
        if status != 0 {
            return Err(format!("RegisterEventHotKey failed ({status}); another app may own the key"));
        }
    }
    Ok(())
}

extern "C" fn on_hotkey(_call: *mut c_void, _event: *mut c_void, _data: *mut c_void) -> OSStatus {
    if let Some(app) = APP.get() {
        toggle(app);
    }
    0
}

fn toggle(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let is_frontmost = window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false);
    if is_frontmost {
        let _ = app.hide();
        return;
    }
    let _ = app.show();
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}
