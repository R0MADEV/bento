// Detect database servers (Docker containers + local ports) and explore them:
// list databases/tables/collections/keys, read rows, edit and delete.
// Detection parsing lives in the frontend (src/core/db, TDD'd); here we do the I/O.
//
// One runner (`run_client`) serves both targets: a Docker container (run the
// client inside it) and a local server (run the host's own client with -h/-p).

use bento_docker::{docker_bin, docker_output, is_safe_container};
use std::io::Read;
use std::net::{SocketAddr, TcpStream};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub mod mysql;
pub mod mongo;
pub mod postgres;
pub mod redis;

// Cap on client output (mysql/psql/…): a wide SELECT * can spit out hundreds of
// MB (HTML/blob columns) and blow up the backend when read into memory.
const MAX_CLIENT_OUTPUT: usize = 8 * 1024 * 1024;

// Time cap: an unbounded wide JOIN leaves the server computing without returning
// a single row, and the backend stays blocked reading a stdout that never arrives
// (the UI shows "Ejecutando…" forever). Past this, we kill the client.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(20);

// Per-client flags to connect to a local (non-Docker) server over TCP.
fn host_flags(client: &str, host: &str, port: u16) -> Vec<String> {
    let p = port.to_string();
    match client {
        "mysql" => vec!["-h".into(), host.into(), "-P".into(), p],
        "psql" => vec!["-h".into(), host.into(), "-p".into(), p],
        "mongosh" | "mongo" => vec!["--host".into(), host.into(), "--port".into(), p],
        "redis-cli" => vec!["-h".into(), host.into(), "-p".into(), p],
        _ => vec![],
    }
}

// Run a database client. An empty container means a local server: run the host's
// own client with -h/-p (you have it if you installed the DB natively). Otherwise
// run the client inside the container with `docker exec`. `op` is everything after
// the client name; `env` holds vars like PGPASSWORD (passed via -e for Docker).
fn run_client(
    container: &str,
    host: &str,
    port: u16,
    client: &str,
    op: &[&str],
    env: &[(&str, &str)],
) -> Result<String, String> {
    let local = container.is_empty();
    let program: String;
    let mut args: Vec<String> = Vec::new();
    if local {
        program = client.to_string();
        args.extend(host_flags(client, host, port));
        args.extend(op.iter().map(|s| s.to_string()));
    } else {
        if !is_safe_container(container) {
            return Err("contenedor inválido".into());
        }
        program = docker_bin().ok_or("docker no encontrado")?;
        args.push("exec".into());
        for (k, v) in env {
            args.push("-e".into());
            args.push(format!("{}={}", k, v));
        }
        args.push(container.to_string());
        args.push(client.to_string());
        args.extend(op.iter().map(|s| s.to_string()));
    }
    let mut cmd = Command::new(&program);
    cmd.args(&args);
    if local {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|_| format!("'{}' no está disponible (instálalo o usa Docker)", client))?;

    // Watchdog: if the client takes longer than CLIENT_TIMEOUT (query hung on the
    // server), we kill it by pid so the stdout read unblocks. On a normal exit,
    // `finished` stops the thread before killing anything.
    let pid = child.id();
    let finished = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    let watch_finished = finished.clone();
    let watch_timed_out = timed_out.clone();
    let watchdog = std::thread::spawn(move || {
        let step = Duration::from_millis(100);
        let mut waited = Duration::ZERO;
        while waited < CLIENT_TIMEOUT {
            std::thread::sleep(step);
            if watch_finished.load(Ordering::Relaxed) {
                return;
            }
            waited += step;
        }
        watch_timed_out.store(true, Ordering::Relaxed);
        let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
    });

    // stderr on a thread (bounded) to avoid blocking or deadlocking with stdout.
    let stderr_pipe = child.stderr.take();
    let stderr_handle = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(se) = stderr_pipe {
            let _ = se.take(64 * 1024).read_to_string(&mut s);
        }
        s
    });

    // stdout read with a cap: if exceeded, we kill the process and truncate.
    let mut buf: Vec<u8> = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let room = MAX_CLIENT_OUTPUT.saturating_sub(buf.len());
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                    if n > room {
                        let _ = child.kill();
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    finished.store(true, Ordering::Relaxed);
    let _ = watchdog.join();
    let stderr = stderr_handle.join().unwrap_or_default();
    if timed_out.load(Ordering::Relaxed) {
        return Err(format!(
            "La consulta superó el límite de {}s y se canceló. Reduce el número de tablas/JOINs o añade condiciones (WHERE) más selectivas.",
            CLIENT_TIMEOUT.as_secs()
        ));
    }
    if !status.success() && buf.is_empty() {
        return Err(stderr.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

fn lines_of(out: String) -> Vec<String> {
    out.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

// Reject identifiers that could break out of a backtick (SQL) or single-quote (JS)
// context. Names come from the database's own metadata, so this is belt-and-braces.
fn is_safe_ident(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && !s.contains(['`', '\'', '"', '\\', '\n', '\r', ';'])
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct TableData {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

// Foreign-key relation: table.column → ref_table.ref_column.
#[derive(Clone, Debug, serde::Serialize)]
pub struct ForeignKey {
    pub table: String,
    pub column: String,
    pub ref_table: String,
    pub ref_column: String,
}

fn parse_fks(out: String) -> Vec<ForeignKey> {
    out.lines()
        .filter_map(|l| {
            let p: Vec<&str> = l.split('\t').collect();
            if p.len() >= 4 && !p[0].is_empty() && !p[2].is_empty() {
                Some(ForeignKey {
                    table: p[0].into(),
                    column: p[1].into(),
                    ref_table: p[2].into(),
                    ref_column: p[3].into(),
                })
            } else {
                None
            }
        })
        .collect()
}

// ---------------- detection (Docker + local ports) ----------------

pub fn db_docker_ps() -> String {
    docker_output(&["ps", "--format", "{{.Names}}|{{.Image}}|{{.Ports}}"]).unwrap_or_default()
}

pub fn db_inspect_env(container: String) -> Vec<String> {
    if !is_safe_container(&container) {
        return Vec::new();
    }
    docker_output(&[
        "inspect",
        "-f",
        "{{range .Config.Env}}{{println .}}{{end}}",
        &container,
    ])
    .map(|s| {
        s.lines()
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default()
}

fn is_open(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

pub fn db_check_ports(ports: Vec<u16>) -> Vec<u16> {
    ports.into_iter().filter(|p| is_open(*p)).collect()
}

// ---------------- MySQL / MariaDB ----------------


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_flags_per_client() {
        assert_eq!(
            host_flags("mysql", "127.0.0.1", 3306),
            vec!["-h", "127.0.0.1", "-P", "3306"]
        );
        assert_eq!(
            host_flags("psql", "127.0.0.1", 5432),
            vec!["-h", "127.0.0.1", "-p", "5432"]
        );
        assert_eq!(
            host_flags("mongosh", "localhost", 27017),
            vec!["--host", "localhost", "--port", "27017"]
        );
        assert_eq!(
            host_flags("redis-cli", "127.0.0.1", 6379),
            vec!["-h", "127.0.0.1", "-p", "6379"]
        );
        assert!(host_flags("psql", "h", 1).contains(&"-p".to_string())); // lowercase for postgres
        assert!(host_flags("mysql", "h", 1).contains(&"-P".to_string())); // uppercase for mysql
    }

    #[test]
    fn is_safe_ident_rejects_injection() {
        assert!(is_safe_ident("users"));
        assert!(is_safe_ident("public.app_settings"));
        assert!(!is_safe_ident("a`b"));
        assert!(!is_safe_ident("a';DROP"));
        assert!(!is_safe_ident(""));
    }

    #[test]
    fn lines_of_trims_and_drops_empty() {
        assert_eq!(lines_of("a\n\n  b  \n".to_string()), vec!["a", "b"]);
    }
}
