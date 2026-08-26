//! Interactive `bento attach` — puts the local terminal in raw mode and
//! byte-forwards stdin/stdout against a remote PTY over the daemon's IPC
//! socket, instead of the old line-buffered passthrough.

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

#[cfg(unix)]
use std::os::unix::io::RawFd;
#[cfg(unix)]
use tokio::io::AsyncReadExt;
#[cfg(unix)]
use tokio::signal::unix::{signal, SignalKind};
#[cfg(unix)]
use tokio::sync::{mpsc, oneshot};

/// Attach to a terminal: stream its output to stdout and forward stdin to it.
/// On unix with a real tty, this is fully interactive (raw mode, live
/// resize, signals pass through to the remote process). Anything else
/// (piped stdin, non-unix) falls back to the old line-buffered behavior.
pub async fn attach(id: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        if unsafe { libc::isatty(0) } != 0 {
            return attach_unix(id).await;
        }
    }
    attach_fallback(id).await
}

/// Splits `bytes` at the last point where everything before it is valid
/// UTF-8, so a `read()` that lands mid multi-byte character doesn't get
/// mangled into `U+FFFD` — the incomplete tail is left for the caller to
/// prepend to the next read.
fn split_valid_utf8(bytes: &[u8]) -> (String, usize) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), bytes.len()),
        Err(e) => {
            let valid_len = e.valid_up_to();
            // `error_len() == None` means "incomplete but valid so far" (the
            // tail is a truncated multi-byte char — wait for more bytes).
            // `Some(_)` means a genuinely invalid byte — replace just that
            // one so garbage input can't stall the loop forever.
            let consumed = if e.error_len().is_some() { valid_len + 1 } else { valid_len };
            (String::from_utf8_lossy(&bytes[..consumed]).into_owned(), consumed)
        }
    }
}

/// Line-based attach: reads stdin a line at a time and appends `\r`. Used
/// when stdin isn't a real tty (piped input, scripts) and as the whole
/// implementation on non-unix, where raw termios/ioctl aren't available.
async fn attach_fallback(id: &str) -> std::io::Result<()> {
    let stream = TcpStream::connect(crate::addr()).await?;
    let (read_half, mut write_half) = stream.into_split();
    let subscribe = json!({ "id": "1", "cmd": "terminal.subscribe", "pty_id": id }).to_string();
    write_half.write_all(subscribe.as_bytes()).await?;
    write_half.write_all(b"\n").await?;

    tokio::spawn(async move {
        let mut lines = BufReader::new(read_half).lines();
        let mut stdout = tokio::io::stdout();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match value.get("event").and_then(Value::as_str) {
                Some("terminal.output") => {
                    if let Some(data) = value.get("data").and_then(Value::as_str) {
                        let _ = stdout.write_all(data.as_bytes()).await;
                        let _ = stdout.flush().await;
                    }
                }
                Some("terminal.exit") => break,
                _ => {}
            }
        }
    });

    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = stdin.next_line().await? {
        let write =
            json!({ "cmd": "terminal.write", "pty_id": id, "data": format!("{line}\r") }).to_string();
        write_half.write_all(write.as_bytes()).await?;
        write_half.write_all(b"\n").await?;
    }
    Ok(())
}

/// Puts fd 0 in raw mode for its lifetime and restores the original termios
/// on drop (including on panic — the workspace doesn't use `panic =
/// "abort"`, so unwinding still runs `Drop`).
#[cfg(unix)]
struct RawModeGuard {
    fd: RawFd,
    original: libc::termios,
}

#[cfg(unix)]
impl RawModeGuard {
    fn enable(fd: RawFd) -> std::io::Result<Self> {
        let mut original: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(fd, &mut original) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut raw = original;
        unsafe { libc::cfmakeraw(&mut raw) };
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self { fd, original })
    }
}

#[cfg(unix)]
impl Drop for RawModeGuard {
    fn drop(&mut self) {
        unsafe { libc::tcsetattr(self.fd, libc::TCSANOW, &self.original) };
    }
}

#[cfg(unix)]
fn term_size(fd: RawFd) -> Option<(u16, u16)> {
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    if unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) } != 0 {
        return None;
    }
    (ws.ws_row > 0 && ws.ws_col > 0).then_some((ws.ws_row, ws.ws_col))
}

#[cfg(unix)]
async fn attach_unix(id: &str) -> std::io::Result<()> {
    let stream = TcpStream::connect(crate::addr()).await?;
    let (read_half, write_half) = stream.into_split();

    // Single writer task: both the stdin loop and the resize watcher just
    // send lines here, so two tasks never race on the same socket half
    // (matches the daemon's own single-writer pattern in ipc.rs::handle_conn).
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut write_half = write_half;
        while let Some(line) = out_rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err() { break; }
            if write_half.write_all(b"\n").await.is_err() { break; }
        }
    });

    let _ = out_tx.send(json!({ "id": "1", "cmd": "terminal.subscribe", "pty_id": id }).to_string());
    if let Some((rows, cols)) = term_size(0) {
        let _ = out_tx.send(json!({ "cmd": "terminal.resize", "pty_id": id, "rows": rows, "cols": cols }).to_string());
    }

    let (exit_tx, mut exit_rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let mut lines = BufReader::new(read_half).lines();
        let mut stdout = tokio::io::stdout();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
            match value.get("event").and_then(Value::as_str) {
                Some("terminal.output") => {
                    if let Some(data) = value.get("data").and_then(Value::as_str) {
                        let _ = stdout.write_all(data.as_bytes()).await;
                        let _ = stdout.flush().await;
                    }
                }
                Some("terminal.exit") => break,
                _ => {}
            }
        }
        let _ = exit_tx.send(());
    });

    let raw_guard = RawModeGuard::enable(0)?;
    let mut winch = signal(SignalKind::window_change())?;
    let mut term = signal(SignalKind::terminate())?;
    let mut hup = signal(SignalKind::hangup())?;
    let mut quit = signal(SignalKind::quit())?;

    let mut stdin = tokio::io::stdin();
    let mut buf = [0u8; 4096];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        tokio::select! {
            result = stdin.read(&mut buf) => {
                let n = result?;
                if n == 0 { break; }
                pending.extend_from_slice(&buf[..n]);
                let (text, consumed) = split_valid_utf8(&pending);
                if !text.is_empty() {
                    let _ = out_tx.send(json!({ "cmd": "terminal.write", "pty_id": id, "data": text }).to_string());
                }
                pending.drain(..consumed);
            }
            _ = winch.recv() => {
                if let Some((rows, cols)) = term_size(0) {
                    let _ = out_tx.send(json!({ "cmd": "terminal.resize", "pty_id": id, "rows": rows, "cols": cols }).to_string());
                }
            }
            _ = term.recv() => break,
            _ = hup.recv() => break,
            _ = quit.recv() => break,
            _ = &mut exit_rx => break,
        }
    }

    drop(raw_guard);
    drop(out_tx);
    writer.abort();

    // `tokio::io::stdin()` reads run on a dedicated blocking OS thread (fd 0
    // isn't reliably non-blocking-pollable on unix), and that thread stays
    // blocked in its `read()` syscall for as long as nobody types anything
    // or closes stdin. The tokio runtime waits for outstanding blocking
    // threads on shutdown, so a plain return here would hang the process
    // until the next keystroke — even though the attach session is already
    // over. Exit immediately instead (same pattern as `daemon.shutdown` in
    // ipc.rs); the terminal was already restored by `raw_guard` above.
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_valid_utf8_returns_all_of_a_plain_ascii_chunk() {
        let (text, consumed) = split_valid_utf8(b"hola");
        assert_eq!(text, "hola");
        assert_eq!(consumed, 4);
    }

    #[test]
    fn split_valid_utf8_holds_back_a_multibyte_char_split_across_reads() {
        // 'ñ' is 2 bytes (0xC3 0xB1) — simulate a read() that only got the
        // first byte of it.
        let full = "hola ñ".as_bytes();
        let cut = full.len() - 1; // drop the last byte of 'ñ'
        let (text, consumed) = split_valid_utf8(&full[..cut]);
        assert_eq!(text, "hola ");
        assert_eq!(consumed, "hola ".len());

        // Feeding the rest (the held-back byte + the missing one) completes it.
        let mut rest = full[consumed..cut].to_vec();
        rest.push(full[cut]);
        let (text2, consumed2) = split_valid_utf8(&rest);
        assert_eq!(text2, "ñ");
        assert_eq!(consumed2, rest.len());
    }

    #[test]
    fn split_valid_utf8_skips_a_single_invalid_byte_instead_of_stalling() {
        let bytes = [b'h', b'i', 0xFF, b'!'];
        let (text, consumed) = split_valid_utf8(&bytes);
        assert_eq!(text, "hi\u{FFFD}");
        assert_eq!(consumed, 3);
    }

    #[test]
    fn split_valid_utf8_returns_empty_for_empty_input() {
        let (text, consumed) = split_valid_utf8(b"");
        assert_eq!(text, "");
        assert_eq!(consumed, 0);
    }
}
