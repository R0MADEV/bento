use std::sync::Mutex;

use sysinfo::{Pid, System};
use tauri::State;

pub struct SystemMetricsState(pub Mutex<System>);

impl Default for SystemMetricsState {
    fn default() -> Self {
        Self(Mutex::new(System::new()))
    }
}

// Resident memory used by Bento's host process. Terminal commands and AI agents
// are intentionally excluded: they are external programs and summing their RSS
// also counts shared pages more than once, producing a misleading app total.
#[tauri::command]
pub fn app_memory_usage(state: State<'_, SystemMetricsState>) -> Result<u64, String> {
    let mut system = state.0.lock().map_err(|e| e.to_string())?;
    let pid = Pid::from_u32(std::process::id());
    system.refresh_process(pid);
    system
        .process(pid)
        .map(|process| process.memory())
        .ok_or_else(|| "Could not read Bento memory usage".to_string())
}
