//! The daemon's process lifecycle, shared by every client that may launch it
//! (the desktop app and the CLI) and by the daemon itself, which reports
//! whether it is running an outdated binary.

use std::process::{Child, Command, Stdio};
use std::time::SystemTime;

/// The IPC protocol this build speaks. Bump it whenever a client starts
/// relying on something an older daemon lacks: the app then replaces a daemon
/// on another protocol (a CLI-started one from another build, say) instead of
/// talking past it. Daemons from before this existed count as protocol 1.
/// 2: flow control (`terminal.subscribe { flow }`, `terminal.ack`).
pub const PROTOCOL: u32 = 2;

/// Where a detached daemon writes its output — the same file the launchd
/// service uses, so there is one place to look whoever started it.
pub const LOG_PATH: &str = "/tmp/bento-daemon.log";

/// Whether the binary on disk was rebuilt or replaced after the process that
/// runs it started — the running daemon is then old code and should be
/// restarted. An unreadable binary (deleted, moved) counts as replaced.
pub fn binary_replaced(binary_modified: Option<SystemTime>, started: SystemTime) -> bool {
    binary_modified.is_none_or(|modified| modified > started)
}

/// `binary_replaced` for the current process's own executable.
pub fn running_binary_replaced(started: SystemTime) -> bool {
    let modified = std::env::current_exe()
        .and_then(std::fs::metadata)
        .and_then(|meta| meta.modified())
        .ok();
    binary_replaced(modified, started)
}

/// Launch the daemon so it outlives whoever launched it: its own session (no
/// SIGHUP when that terminal or app goes away) and no inherited stdio — a
/// daemon still writing to the pipe of an app that has quit panics on its
/// next log line.
pub fn spawn_detached(mut cmd: Command) -> std::io::Result<Child> {
    cmd.stdin(Stdio::null()).stdout(log_sink()).stderr(log_sink());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // setsid(), not process_group(0): a new process group still leaves the
        // child in our *session*, so closing the terminal that started it sends
        // it SIGHUP and the daemon dies minutes later, looking like a crash.
        // setsid() leaves the session too — and it gives the child its own
        // group as well, so asking for both would make setsid() fail with
        // EPERM for already being a group leader.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    cmd.spawn()
}

fn log_sink() -> Stdio {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(LOG_PATH)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const STARTED: SystemTime = SystemTime::UNIX_EPOCH;

    #[test]
    fn a_binary_rebuilt_after_the_start_is_replaced() {
        assert!(binary_replaced(Some(STARTED + Duration::from_secs(5)), STARTED));
    }

    #[test]
    fn a_binary_older_than_the_start_is_current() {
        let built_before = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
        assert!(!binary_replaced(Some(STARTED), built_before));
    }

    #[test]
    fn an_unreadable_binary_is_replaced() {
        assert!(binary_replaced(None, STARTED));
    }

    /// A process outlives the terminal or app that started it only if it is
    /// in its own session; this is the difference the daemon was missing.
    #[cfg(unix)]
    #[test]
    fn the_spawned_process_leaves_our_session() {
        let mut sleep = Command::new("/bin/sleep");
        sleep.arg("5");
        let mut child = spawn_detached(sleep).expect("could not spawn");
        let pid = child.id() as i32;

        let ours = unsafe { libc::getsid(0) };
        let theirs = unsafe { libc::getsid(pid) };
        let _ = child.kill();
        let _ = child.wait();

        assert_ne!(theirs, -1, "the child is gone: its session could not be checked");
        assert_ne!(theirs, ours, "the child is still in our session and will die with it");
    }
}
