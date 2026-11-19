//! Ending everything a terminal started: its shell and whatever that shell
//! launched (agents, servers), so closing a terminal frees their memory.

use sysinfo::{Pid, System};

#[cfg(unix)]
pub(crate) fn terminate_process_tree(root: u32) {
    let session = Pid::from_u32(root);
    let members = |system: &System| -> Vec<i32> {
        system
            .processes()
            .iter()
            .filter_map(|(pid, process)| {
                (process.session_id() == Some(session)).then_some(pid.as_u32() as i32)
            })
            .collect()
    };

    let system = System::new_all();
    for pid in members(&system) {
        // SAFETY: the PID comes from the current system process snapshot.
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    std::thread::sleep(std::time::Duration::from_millis(150));
    let system = System::new_all();
    for pid in members(&system) {
        // Agents may ignore SIGTERM; SIGKILL guarantees their memory is released.
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
}

#[cfg(windows)]
pub(crate) fn terminate_process_tree(root: u32) {
    use std::ffi::c_void;

    type Handle = *mut c_void;
    const PROCESS_TERMINATE: u32 = 0x0001;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> Handle;
        fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    let system = System::new_all();
    let mut tree = vec![Pid::from_u32(root)];
    loop {
        let before = tree.len();
        for (pid, process) in system.processes() {
            if process
                .parent()
                .is_some_and(|parent| tree.contains(&parent))
                && !tree.contains(pid)
            {
                tree.push(*pid);
            }
        }
        if tree.len() == before {
            break;
        }
    }

    for pid in tree.into_iter().rev() {
        // SAFETY: handles are checked and closed; PROCESS_TERMINATE is minimal.
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid.as_u32());
            if !handle.is_null() {
                TerminateProcess(handle, 1);
                CloseHandle(handle);
            }
        }
    }
}
