use std::collections::HashSet;
use std::sync::Mutex;

use sysinfo::{Pid, Process, System};
use tauri::State;

pub struct SystemMetricsState(pub Mutex<System>);

impl Default for SystemMetricsState {
    fn default() -> Self {
        Self(Mutex::new(System::new()))
    }
}

fn app_processes(system: &System, root: Pid) -> HashSet<Pid> {
    let mut result = HashSet::from([root]);
    loop {
        let before = result.len();
        for (pid, process) in system.processes() {
            if process
                .parent()
                .is_some_and(|parent| result.contains(&parent))
            {
                result.insert(*pid);
            }
        }
        if result.len() == before {
            return result;
        }
    }
}

#[cfg(target_os = "macos")]
fn physical_memory(pid: Pid, fallback: &Process) -> u64 {
    use std::ffi::c_void;

    // rusage_info_v2 is a UUID followed by 18 u64 fields. phys_footprint is the
    // eighth field and is the same footprint metric used by Apple's memory tools.
    #[repr(C)]
    struct RusageInfoV2 {
        uuid: [u8; 16],
        values: [u64; 18],
    }
    unsafe extern "C" {
        fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut c_void) -> i32;
    }

    let mut info = RusageInfoV2 {
        uuid: [0; 16],
        values: [0; 18],
    };
    // SAFETY: info has the C layout and complete size required by RUSAGE_INFO_V2.
    let ok = unsafe {
        proc_pid_rusage(
            pid.as_u32() as i32,
            2,
            (&mut info as *mut RusageInfoV2).cast(),
        )
    } == 0;
    if ok {
        info.values[7]
    } else {
        fallback.memory()
    }
}

#[cfg(target_os = "linux")]
fn physical_memory(pid: Pid, fallback: &Process) -> u64 {
    // PSS charges each process only its proportional share of common pages, so
    // adding a process tree does not multiply shared libraries/WebView mappings.
    let path = format!("/proc/{}/smaps_rollup", pid.as_u32());
    std::fs::read_to_string(path)
        .ok()
        .and_then(|contents| {
            contents.lines().find_map(|line| {
                let value = line
                    .strip_prefix("Pss:")?
                    .trim()
                    .split_whitespace()
                    .next()?;
                value.parse::<u64>().ok().map(|kb| kb * 1024)
            })
        })
        .unwrap_or_else(|| fallback.memory())
}

#[cfg(target_os = "windows")]
fn physical_memory(pid: Pid, fallback: &Process) -> u64 {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};

    type Handle = *mut c_void;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[repr(C)]
    struct ProcessMemoryCountersEx2 {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
        private_usage: usize,
        private_working_set_size: usize,
        shared_commit_usage: u64,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn K32GetProcessMemoryInfo(handle: Handle, counters: *mut c_void, size: u32) -> i32;
    }

    // SAFETY: the handle is closed on every successful OpenProcess path and the
    // output buffer has the exact PROCESS_MEMORY_COUNTERS_EX2 C layout.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid.as_u32());
        if handle.is_null() {
            return fallback.virtual_memory();
        }
        let mut counters: ProcessMemoryCountersEx2 = zeroed();
        counters.cb = size_of::<ProcessMemoryCountersEx2>() as u32;
        let ok = K32GetProcessMemoryInfo(
            handle,
            (&mut counters as *mut ProcessMemoryCountersEx2).cast(),
            counters.cb,
        ) != 0;
        CloseHandle(handle);
        if ok {
            counters.private_working_set_size as u64
        } else {
            fallback.virtual_memory()
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn physical_memory(_pid: Pid, fallback: &Process) -> u64 {
    fallback.memory()
}

// Current physical footprint of Bento plus its WebViews, terminals and agents.
// Each supported OS uses a non-duplicating native metric instead of adding RSS.
#[tauri::command]
pub fn app_memory_usage(state: State<'_, SystemMetricsState>) -> Result<u64, String> {
    let mut system = state.0.lock().map_err(|e| e.to_string())?;
    system.refresh_processes();
    let root = Pid::from_u32(std::process::id());
    let total = app_processes(&system, root)
        .into_iter()
        .filter_map(|pid| {
            system
                .process(pid)
                .map(|process| physical_memory(pid, process))
        })
        .sum();
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_metric_reads_current_process() {
        let mut system = System::new();
        let pid = Pid::from_u32(std::process::id());
        system.refresh_process(pid);
        let process = system.process(pid).expect("current process");
        assert!(physical_memory(pid, process) > 0);
    }
}
