use std::collections::HashSet;
use std::sync::Mutex;

use sysinfo::{Pid, Process, System};
use tauri::State;

struct MetricsState {
    system: System,
    // PIDs in Bento's process group, rebuilt every TREE_REFRESH_EVERY calls so
    // new terminals/agents are picked up without scanning all processes each time.
    cached_pids: HashSet<Pid>,
    calls_since_tree_refresh: u8,
}

const TREE_REFRESH_EVERY: u8 = 5; // full scan every ~15 s (at 3 s poll interval)

pub struct SystemMetricsState(Mutex<MetricsState>);

impl Default for SystemMetricsState {
    fn default() -> Self {
        Self(Mutex::new(MetricsState {
            system: System::new(),
            cached_pids: HashSet::new(),
            calls_since_tree_refresh: TREE_REFRESH_EVERY, // force scan on first call
        }))
    }
}

fn descendant_processes(system: &System, root: Pid) -> HashSet<Pid> {
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

fn app_processes(system: &System, root: Pid) -> HashSet<Pid> {
    // WebKit XPC services are re-parented to launchd on macOS, so a normal
    // parent/child walk misses most of Bento's UI memory. Resource coalitions
    // are the kernel grouping that keeps an app and those services together.
    #[cfg(target_os = "macos")]
    if let Some(root_coalition) = resource_coalition_id(root) {
        let root_process = system.process(root);
        let launched_as_app = root_process
            .and_then(Process::parent)
            .is_some_and(|parent| parent.as_u32() == 1);

        if launched_as_app {
            // A packaged app launched by macOS owns an isolated coalition. This
            // is the authoritative grouping and includes its re-parented XPCs.
            let members: HashSet<Pid> = system
                .processes()
                .keys()
                .copied()
                .filter(|pid| resource_coalition_id(*pid) == Some(root_coalition))
                .collect();
            if !members.is_empty() {
                return members;
            }
        } else if let Some(started_at) = root_process.map(Process::start_time) {
            // `tauri dev` inherits the terminal's long-lived coalition, which can
            // contain hundreds of unrelated/old processes. Keep the real child
            // tree and add only this run's re-parented WebKit XPC services.
            let mut members = descendant_processes(system, root);
            members.extend(system.processes().iter().filter_map(|(pid, process)| {
                (process.start_time() >= started_at
                    && process.name().contains("WebKit")
                    && resource_coalition_id(*pid) == Some(root_coalition))
                .then_some(*pid)
            }));
            return members;
        }
    }

    // Linux and Windows keep the terminal/agent process tree attached to the
    // host process. This is also the safe fallback if coalition lookup fails.
    descendant_processes(system, root)
}

#[cfg(target_os = "macos")]
fn resource_coalition_id(pid: Pid) -> Option<u64> {
    use std::ffi::c_void;

    const PROC_PIDCOALITIONINFO: i32 = 20;
    #[repr(C)]
    struct ProcPidCoalitionInfo {
        // RESOURCE and JETSAM coalition IDs, followed by three reserved fields.
        coalition_id: [u64; 2],
        reserved: [u64; 3],
    }
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut c_void,
            buffer_size: i32,
        ) -> i32;
    }

    let mut info = ProcPidCoalitionInfo {
        coalition_id: [0; 2],
        reserved: [0; 3],
    };
    // SAFETY: info matches proc_pidcoalitioninfo's C layout and buffer size.
    let read = unsafe {
        proc_pidinfo(
            pid.as_u32() as i32,
            PROC_PIDCOALITIONINFO,
            0,
            (&mut info as *mut ProcPidCoalitionInfo).cast(),
            std::mem::size_of::<ProcPidCoalitionInfo>() as i32,
        )
    };
    (read == std::mem::size_of::<ProcPidCoalitionInfo>() as i32).then_some(info.coalition_id[0])
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
// The process tree is rebuilt every TREE_REFRESH_EVERY calls; between rebuilds
// only the known PIDs are refreshed, avoiding a full system-wide scan.
#[tauri::command]
pub fn app_memory_usage(state: State<'_, SystemMetricsState>) -> Result<u64, String> {
    let mut ms = state.0.lock().map_err(|e| e.to_string())?;
    let root = Pid::from_u32(std::process::id());

    if ms.calls_since_tree_refresh >= TREE_REFRESH_EVERY || ms.cached_pids.is_empty() {
        ms.system.refresh_processes();
        ms.cached_pids = app_processes(&ms.system, root);
        ms.calls_since_tree_refresh = 0;
    } else {
        // Copy the small cached set first so refreshing `system` does not
        // mutably borrow `ms` while `cached_pids` is still borrowed.
        let cached_pids: Vec<Pid> = ms.cached_pids.iter().copied().collect();
        for pid in cached_pids {
            ms.system.refresh_process(pid);
        }
        ms.calls_since_tree_refresh += 1;
    }

    let total = ms.cached_pids
        .iter()
        .filter_map(|&pid| {
            ms.system
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

    #[test]
    fn tree_refresh_resets_after_threshold() {
        let state = SystemMetricsState::default();
        let ms = state.0.lock().unwrap();
        assert_eq!(ms.calls_since_tree_refresh, TREE_REFRESH_EVERY);
        assert!(ms.cached_pids.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_metric_reads_current_resource_coalition() {
        let pid = Pid::from_u32(std::process::id());
        assert!(resource_coalition_id(pid).is_some());
    }
}
