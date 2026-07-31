// Detect database servers (Docker containers + local ports) and explore them:
// list databases/tables/collections/keys, read rows, edit and delete.
// Detection parsing lives in the frontend (src/core/db, TDD'd); here we do the I/O.
//
// One runner (`run_client`) serves both targets: a Docker container (run the
// client inside it) and a local server (run the host's own client with -h/-p).

use crate::docker::{docker_bin, docker_output, is_safe_container};
use std::io::Read;
use std::net::{SocketAddr, TcpStream};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

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

#[derive(serde::Serialize)]
pub struct TableData {
    columns: Vec<String>,
    rows: Vec<Vec<String>>,
}

// Foreign-key relation: table.column → ref_table.ref_column.
#[derive(serde::Serialize)]
pub struct ForeignKey {
    table: String,
    column: String,
    ref_table: String,
    ref_column: String,
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

#[tauri::command]
pub fn db_docker_ps() -> String {
    docker_output(&["ps", "--format", "{{.Names}}|{{.Image}}|{{.Ports}}"]).unwrap_or_default()
}

#[tauri::command]
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

#[tauri::command]
pub fn db_check_ports(ports: Vec<u16>) -> Vec<u16> {
    ports.into_iter().filter(|p| is_open(*p)).collect()
}

// ---------------- MySQL / MariaDB ----------------

fn mysql_op(user: &str, password: &str, query: &str, raw: bool) -> Vec<String> {
    // -N drops the header row (used for plain lists); table data keeps it.
    let mut a: Vec<String> = vec![
        "-u".into(),
        user.into(),
        "-B".into(),
        "-e".into(),
        query.into(),
    ];
    if raw {
        a.insert(2, "-N".into());
    }
    if !password.is_empty() {
        a.insert(2, format!("-p{}", password));
    }
    a
}

fn run_mysql(container: &str, host: &str, port: u16, op: &[String]) -> Result<String, String> {
    let refs: Vec<&str> = op.iter().map(String::as_str).collect();
    run_client(container, host, port, "mysql", &refs, &[])
}

fn sql_quote(v: &str) -> String {
    format!("'{}'", v.replace('\\', "\\\\").replace('\'', "\\'"))
}

#[tauri::command]
pub fn db_docker_list_mysql(
    container: String,
    host: String,
    port: u16,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    let op = mysql_op(&user, &password, "SHOW DATABASES", true);
    run_mysql(&container, &host, port, &op).map(lines_of)
}

#[tauri::command]
pub fn db_docker_mysql_tables(
    container: String,
    host: String,
    port: u16,
    db: String,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    if !is_safe_ident(&db) {
        return Err("nombre de base inválido".into());
    }
    let op = mysql_op(&user, &password, &format!("SHOW TABLES IN `{}`", db), true);
    run_mysql(&container, &host, port, &op).map(lines_of)
}

fn parse_table(out: String) -> TableData {
    // Defensive caps: a SELECT * over a wide JOIN can bring back hundreds of
    // columns and huge cells (HTML, blobs). Unbounded, the payload traveling
    // to the WebView blows it up. We clip cells and rows; the front also limits rendering.
    const MAX_ROWS: usize = 200;
    const MAX_COLS: usize = 80;
    const MAX_CELL: usize = 500;
    const MAX_JSON_CELL: usize = 50_000;
    let clip = |s: &str| -> String {
        let trimmed = s.trim_start();
        let limit = if trimmed.starts_with('{') || trimmed.starts_with('[') {
            MAX_JSON_CELL
        } else {
            MAX_CELL
        };
        if s.chars().take(limit + 1).count() > limit {
            format!("{}…", s.chars().take(limit).collect::<String>())
        } else {
            s.to_string()
        }
    };
    let mut lines = out.lines();
    let columns: Vec<String> = match lines.next() {
        Some(header) => header
            .split('\t')
            .take(MAX_COLS)
            .map(str::to_string)
            .collect(),
        None => {
            return TableData {
                columns: vec![],
                rows: vec![],
            }
        }
    };
    let rows = lines
        .take(MAX_ROWS)
        .map(|l| l.split('\t').take(MAX_COLS).map(clip).collect())
        .collect();
    TableData { columns, rows }
}

#[tauri::command]
pub fn db_docker_mysql_rows(
    container: String,
    host: String,
    port: u16,
    db: String,
    table: String,
    user: String,
    password: String,
) -> Result<TableData, String> {
    if !is_safe_ident(&db) || !is_safe_ident(&table) {
        return Err("nombre inválido".into());
    }
    let op = mysql_op(
        &user,
        &password,
        &format!("SELECT * FROM `{}`.`{}` LIMIT 200", db, table),
        false,
    );
    run_mysql(&container, &host, port, &op).map(parse_table)
}

// Runs free-form SQL against the `db` database. A dev tool over your own local
// databases: the query is intentionally arbitrary (like any client).
#[tauri::command]
pub fn db_docker_mysql_query(
    container: String,
    host: String,
    port: u16,
    db: String,
    sql: String,
    user: String,
    password: String,
) -> Result<TableData, String> {
    if !is_safe_ident(&db) {
        return Err("nombre de base inválido".into());
    }
    let op = mysql_op(&user, &password, &format!("USE `{}`; {}", db, sql), false);
    run_mysql(&container, &host, port, &op).map(parse_table)
}

// Relations (foreign keys) of a MySQL/MariaDB database.
#[tauri::command]
pub fn db_docker_mysql_fks(
    container: String,
    host: String,
    port: u16,
    db: String,
    user: String,
    password: String,
) -> Result<Vec<ForeignKey>, String> {
    if !is_safe_ident(&db) {
        return Err("nombre de base inválido".into());
    }
    let query = format!(
        "SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='{}' AND REFERENCED_TABLE_NAME IS NOT NULL",
        db
    );
    let op = mysql_op(&user, &password, &query, true);
    run_mysql(&container, &host, port, &op).map(parse_fks)
}

#[tauri::command]
pub fn db_docker_mysql_pk(
    container: String,
    host: String,
    port: u16,
    db: String,
    table: String,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    if !is_safe_ident(&db) || !is_safe_ident(&table) {
        return Err("nombre inválido".into());
    }
    let query = format!(
        "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='{}' AND TABLE_NAME='{}' AND CONSTRAINT_NAME='PRIMARY' ORDER BY ORDINAL_POSITION",
        db, table
    );
    let op = mysql_op(&user, &password, &query, true);
    run_mysql(&container, &host, port, &op).map(lines_of)
}

fn mysql_where(wheres: &[(String, String)]) -> Result<String, String> {
    if wheres.is_empty() {
        return Err("la tabla no tiene clave primaria".into());
    }
    let mut conds = Vec::new();
    for (col, val) in wheres {
        if !is_safe_ident(col) {
            return Err("columna inválida".into());
        }
        conds.push(format!("`{}` = {}", col, sql_quote(val)));
    }
    Ok(conds.join(" AND "))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn db_docker_mysql_update(
    container: String,
    host: String,
    port: u16,
    db: String,
    table: String,
    column: String,
    value: String,
    wheres: Vec<(String, String)>,
    user: String,
    password: String,
) -> Result<(), String> {
    if !is_safe_ident(&db) || !is_safe_ident(&table) || !is_safe_ident(&column) {
        return Err("nombre inválido".into());
    }
    let where_clause = mysql_where(&wheres)?;
    let query = format!(
        "UPDATE `{}`.`{}` SET `{}` = {} WHERE {}",
        db,
        table,
        column,
        sql_quote(&value),
        where_clause
    );
    let op = mysql_op(&user, &password, &query, false);
    run_mysql(&container, &host, port, &op).map(|_| ())
}

#[tauri::command]
pub fn db_docker_mysql_delete(
    container: String,
    host: String,
    port: u16,
    db: String,
    table: String,
    wheres: Vec<(String, String)>,
    user: String,
    password: String,
) -> Result<(), String> {
    if !is_safe_ident(&db) || !is_safe_ident(&table) {
        return Err("nombre inválido".into());
    }
    let where_clause = mysql_where(&wheres)?;
    let cascade_query = format!(
        "SELECT TABLE_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='{}' AND REFERENCED_TABLE_NAME='{}' AND DELETE_RULE='CASCADE'",
        db, table
    );
    let cascades = run_mysql(
        &container,
        &host,
        port,
        &mysql_op(&user, &password, &cascade_query, true),
    )
    .map(lines_of)?;
    if !cascades.is_empty() {
        return Err(format!(
            "Bloqueado: borrar aquí arrastraría en cascada (ON DELETE CASCADE) a: {}",
            cascades.join(", ")
        ));
    }
    let query = format!("DELETE FROM `{}`.`{}` WHERE {}", db, table, where_clause);
    run_mysql(
        &container,
        &host,
        port,
        &mysql_op(&user, &password, &query, false),
    )
    .map(|_| ())
}

// ---------------- MongoDB ----------------

// Run a JS snippet in the mongo shell: mongosh (mongo:5+) with a fallback to the
// legacy `mongo` shell.
fn mongo_eval(
    container: &str,
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    script: &str,
) -> Result<String, String> {
    let mut op: Vec<String> = vec!["--quiet".into()];
    if !user.is_empty() {
        op.extend([
            "-u".into(),
            user.into(),
            "-p".into(),
            password.into(),
            "--authenticationDatabase".into(),
            "admin".into(),
        ]);
    }
    op.extend(["--eval".into(), script.into()]);
    let refs: Vec<&str> = op.iter().map(String::as_str).collect();
    run_client(container, host, port, "mongosh", &refs, &[])
        .or_else(|_| run_client(container, host, port, "mongo", &refs, &[]))
}

fn mongo_escape(doc: &str) -> String {
    doc.replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', " ")
        .replace('\r', "")
}

#[tauri::command]
pub fn db_docker_list_mongo(
    container: String,
    host: String,
    port: u16,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    let script =
        "db.adminCommand('listDatabases').databases.map(function(d){return d.name}).join('\\n')";
    mongo_eval(&container, &host, port, &user, &password, script).map(lines_of)
}

#[tauri::command]
pub fn db_docker_mongo_collections(
    container: String,
    host: String,
    port: u16,
    db: String,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    if !is_safe_ident(&db) {
        return Err("nombre de base inválido".into());
    }
    let script = format!("db.getSiblingDB('{}').getCollectionNames().join('\\n')", db);
    mongo_eval(&container, &host, port, &user, &password, &script).map(lines_of)
}

#[tauri::command]
pub fn db_docker_mongo_docs(
    container: String,
    host: String,
    port: u16,
    db: String,
    collection: String,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    if !is_safe_ident(&db) || !is_safe_ident(&collection) {
        return Err("nombre inválido".into());
    }
    let script = format!(
        "db.getSiblingDB('{}').getCollection('{}').find().limit(50).toArray().map(function(d){{return EJSON.stringify(d)}}).join('\\n')",
        db, collection
    );
    mongo_eval(&container, &host, port, &user, &password, &script).map(lines_of)
}

// Runs a free-form mongosh script in the context of `db` (dev tool).
#[tauri::command]
pub fn db_docker_mongo_query(
    container: String,
    host: String,
    port: u16,
    db: String,
    script: String,
    user: String,
    password: String,
) -> Result<String, String> {
    if !is_safe_ident(&db) {
        return Err("nombre de base inválido".into());
    }
    let wrapped = format!("db = db.getSiblingDB('{}'); {}", db, script);
    mongo_eval(&container, &host, port, &user, &password, &wrapped)
}

// Mongo relations (heuristic): *Id/*_id or ObjectId fields that point to
// another collection, guessed by name. References, not enforced FKs.
#[tauri::command]
pub fn db_docker_mongo_refs(
    container: String,
    host: String,
    port: u16,
    db: String,
    user: String,
    password: String,
) -> Result<Vec<ForeignKey>, String> {
    if !is_safe_ident(&db) {
        return Err("nombre de base inválido".into());
    }
    let script = format!(
        r#"var D=db.getSiblingDB('{}');var names=D.getCollectionNames();var out=[];var seen={{}};names.forEach(function(coll){{var docs=D.getCollection(coll).find().limit(20).toArray();docs.forEach(function(doc){{Object.keys(doc).forEach(function(k){{if(k==='_id')return;var key=coll+'|'+k;if(seen[key])return;var v=doc[k];var looksId=/(_id|Id)$/.test(k)||(v instanceof ObjectId);if(!looksId)return;seen[key]=1;var base=k.replace(/(_id|Id)$/,'').toLowerCase();var target='';for(var i=0;i<names.length;i++){{var lc=names[i].toLowerCase();if(lc===base||lc===base+'s'||lc.replace(/s$/,'')===base){{target=names[i];break;}}}}out.push(coll+'\t'+k+'\t'+target);}});}});}});print(out.join('\n'));"#,
        db
    );
    mongo_eval(&container, &host, port, &user, &password, &script).map(parse_mongo_refs)
}

fn parse_mongo_refs(out: String) -> Vec<ForeignKey> {
    out.lines()
        .filter_map(|l| {
            let p: Vec<&str> = l.split('\t').collect();
            if p.len() >= 3 && !p[0].is_empty() && !p[2].is_empty() {
                Some(ForeignKey {
                    table: p[0].into(),
                    column: p[1].into(),
                    ref_table: p[2].into(),
                    ref_column: "_id".into(),
                })
            } else {
                None
            }
        })
        .collect()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn db_docker_mongo_update(
    container: String,
    host: String,
    port: u16,
    db: String,
    collection: String,
    doc: String,
    user: String,
    password: String,
) -> Result<(), String> {
    if !is_safe_ident(&db) || !is_safe_ident(&collection) {
        return Err("nombre inválido".into());
    }
    let script = format!(
        "var d=EJSON.parse('{}');var id=d._id;delete d._id;db.getSiblingDB('{}').getCollection('{}').replaceOne({{_id:id}},d)",
        mongo_escape(&doc), db, collection
    );
    mongo_eval(&container, &host, port, &user, &password, &script).map(|_| ())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn db_docker_mongo_delete(
    container: String,
    host: String,
    port: u16,
    db: String,
    collection: String,
    doc: String,
    user: String,
    password: String,
) -> Result<(), String> {
    if !is_safe_ident(&db) || !is_safe_ident(&collection) {
        return Err("nombre inválido".into());
    }
    let script = format!(
        "var d=EJSON.parse('{}');db.getSiblingDB('{}').getCollection('{}').deleteOne({{_id:d._id}})",
        mongo_escape(&doc), db, collection
    );
    mongo_eval(&container, &host, port, &user, &password, &script).map(|_| ())
}

// ---------------- PostgreSQL ----------------

fn psql(
    container: &str,
    host: &str,
    port: u16,
    db: &str,
    user: &str,
    password: &str,
    extra: &[&str],
) -> Result<String, String> {
    if !is_safe_ident(db) || !is_safe_ident(user) {
        return Err("parámetro inválido".into());
    }
    let mut op: Vec<String> = vec!["-U".into(), user.into(), "-d".into(), db.into()];
    op.extend(extra.iter().map(|s| s.to_string()));
    let refs: Vec<&str> = op.iter().map(String::as_str).collect();
    run_client(
        container,
        host,
        port,
        "psql",
        &refs,
        &[("PGPASSWORD", password)],
    )
}

fn split_qualified(name: &str) -> (String, String) {
    match name.split_once('.') {
        Some((schema, table)) => (schema.to_string(), table.to_string()),
        None => ("public".to_string(), name.to_string()),
    }
}

fn pg_quote(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}

fn pg_where(wheres: &[(String, String)]) -> Result<String, String> {
    if wheres.is_empty() {
        return Err("la tabla no tiene clave primaria".into());
    }
    let mut conds = Vec::new();
    for (col, val) in wheres {
        if !is_safe_ident(col) {
            return Err("columna inválida".into());
        }
        conds.push(format!("\"{}\" = {}", col, pg_quote(val)));
    }
    Ok(conds.join(" AND "))
}

#[tauri::command]
pub fn db_docker_pg_databases(
    container: String,
    host: String,
    port: u16,
    db: String,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    let out = psql(&container, &host, port, &db, &user, &password, &[
        "-t", "-A", "-c",
        "SELECT datname FROM pg_database WHERE datistemplate=false AND datallowconn ORDER BY datname",
    ])?;
    Ok(lines_of(out))
}

#[tauri::command]
pub fn db_docker_pg_tables(
    container: String,
    host: String,
    port: u16,
    db: String,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    let out = psql(&container, &host, port, &db, &user, &password, &[
        "-t", "-A", "-c",
        "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1",
    ])?;
    Ok(lines_of(out))
}

#[tauri::command]
pub fn db_docker_pg_rows(
    container: String,
    host: String,
    port: u16,
    db: String,
    table: String,
    user: String,
    password: String,
) -> Result<TableData, String> {
    let (schema, tbl) = split_qualified(&table);
    if !is_safe_ident(&schema) || !is_safe_ident(&tbl) {
        return Err("nombre inválido".into());
    }
    let query = format!("SELECT * FROM \"{}\".\"{}\" LIMIT 200", schema, tbl);
    let out = psql(
        &container,
        &host,
        port,
        &db,
        &user,
        &password,
        &[
            "-A",
            "-F",
            "\t",
            "-P",
            "footer=off",
            "-P",
            "null=NULL",
            "-c",
            &query,
        ],
    )?;
    Ok(parse_table(out))
}

// Runs free-form SQL against `db` (dev tool; arbitrary query).
#[tauri::command]
pub fn db_docker_pg_query(
    container: String,
    host: String,
    port: u16,
    db: String,
    sql: String,
    user: String,
    password: String,
) -> Result<TableData, String> {
    let out = psql(
        &container,
        &host,
        port,
        &db,
        &user,
        &password,
        &[
            "-A",
            "-F",
            "\t",
            "-P",
            "footer=off",
            "-P",
            "null=NULL",
            "-c",
            &sql,
        ],
    )?;
    Ok(parse_table(out))
}

// Relations (foreign keys) of a PostgreSQL database.
#[tauri::command]
pub fn db_docker_pg_fks(
    container: String,
    host: String,
    port: u16,
    db: String,
    user: String,
    password: String,
) -> Result<Vec<ForeignKey>, String> {
    // schema.table on both sides: Postgres has several schemas, not just public.
    let query = "SELECT tc.table_schema||'.'||tc.table_name, kcu.column_name, ccu.table_schema||'.'||ccu.table_name, ccu.column_name \
        FROM information_schema.table_constraints tc \
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema \
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema \
        WHERE tc.constraint_type='FOREIGN KEY'";
    let out = psql(
        &container,
        &host,
        port,
        &db,
        &user,
        &password,
        &["-t", "-A", "-F", "\t", "-c", query],
    )?;
    Ok(parse_fks(out))
}

#[tauri::command]
pub fn db_docker_pg_pk(
    container: String,
    host: String,
    port: u16,
    db: String,
    table: String,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    let (schema, tbl) = split_qualified(&table);
    if !is_safe_ident(&schema) || !is_safe_ident(&tbl) {
        return Err("nombre inválido".into());
    }
    let query = format!(
        "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid='\"{}\".\"{}\"'::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)",
        schema, tbl
    );
    let out = psql(
        &container,
        &host,
        port,
        &db,
        &user,
        &password,
        &["-t", "-A", "-c", &query],
    )?;
    Ok(lines_of(out))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn db_docker_pg_update(
    container: String,
    host: String,
    port: u16,
    db: String,
    table: String,
    column: String,
    value: String,
    wheres: Vec<(String, String)>,
    user: String,
    password: String,
) -> Result<(), String> {
    let (schema, tbl) = split_qualified(&table);
    if !is_safe_ident(&schema) || !is_safe_ident(&tbl) || !is_safe_ident(&column) {
        return Err("nombre inválido".into());
    }
    let where_clause = pg_where(&wheres)?;
    let query = format!(
        "UPDATE \"{}\".\"{}\" SET \"{}\" = {} WHERE {}",
        schema,
        tbl,
        column,
        pg_quote(&value),
        where_clause
    );
    psql(
        &container,
        &host,
        port,
        &db,
        &user,
        &password,
        &["-c", &query],
    )
    .map(|_| ())
}

#[tauri::command]
pub fn db_docker_pg_delete(
    container: String,
    host: String,
    port: u16,
    db: String,
    table: String,
    wheres: Vec<(String, String)>,
    user: String,
    password: String,
) -> Result<(), String> {
    let (schema, tbl) = split_qualified(&table);
    if !is_safe_ident(&schema) || !is_safe_ident(&tbl) {
        return Err("nombre inválido".into());
    }
    let where_clause = pg_where(&wheres)?;
    let cascade_query = format!(
        "SELECT conrelid::regclass::text FROM pg_constraint WHERE confrelid='\"{}\".\"{}\"'::regclass AND confdeltype='c'",
        schema, tbl
    );
    let cascades = lines_of(psql(
        &container,
        &host,
        port,
        &db,
        &user,
        &password,
        &["-t", "-A", "-c", &cascade_query],
    )?);
    if !cascades.is_empty() {
        return Err(format!(
            "Bloqueado: borrar aquí arrastraría en cascada (ON DELETE CASCADE) a: {}",
            cascades.join(", ")
        ));
    }
    let query = format!(
        "DELETE FROM \"{}\".\"{}\" WHERE {}",
        schema, tbl, where_clause
    );
    psql(
        &container,
        &host,
        port,
        &db,
        &user,
        &password,
        &["-c", &query],
    )
    .map(|_| ())
}

// ---------------- Redis (db index → keys → value by type) ----------------

fn redis_cli(
    container: &str,
    host: &str,
    port: u16,
    db: &str,
    password: &str,
    args: &[&str],
) -> Result<String, String> {
    if db.is_empty() || !db.chars().all(|c| c.is_ascii_digit()) {
        return Err("parámetro inválido".into());
    }
    let mut op: Vec<String> = Vec::new();
    if !password.is_empty() {
        op.extend(["-a".into(), password.into(), "--no-auth-warning".into()]);
    }
    op.extend(["-n".into(), db.into()]);
    op.extend(args.iter().map(|s| s.to_string()));
    let refs: Vec<&str> = op.iter().map(String::as_str).collect();
    run_client(container, host, port, "redis-cli", &refs, &[])
}

#[tauri::command]
pub fn db_docker_redis_dbs(
    container: String,
    host: String,
    port: u16,
    password: String,
) -> Result<Vec<String>, String> {
    // INFO keyspace lists only the logical DBs that hold keys (db0:keys=2,...).
    let out = redis_cli(
        &container,
        &host,
        port,
        "0",
        &password,
        &["INFO", "keyspace"],
    )?;
    let dbs = out
        .lines()
        .filter_map(|l| {
            let idx = l.trim().strip_prefix("db")?.split(':').next()?;
            let numeric = !idx.is_empty() && idx.chars().all(|c| c.is_ascii_digit());
            numeric.then(|| idx.to_string())
        })
        .collect();
    Ok(dbs)
}

#[tauri::command]
pub fn db_docker_redis_keys(
    container: String,
    host: String,
    port: u16,
    db: String,
    password: String,
) -> Result<Vec<String>, String> {
    let out = redis_cli(&container, &host, port, &db, &password, &["--scan"])?;
    Ok(lines_of(out).into_iter().take(1000).collect())
}

#[derive(serde::Serialize)]
pub struct RedisValue {
    kind: String,
    value: String,
}

#[tauri::command]
pub fn db_docker_redis_value(
    container: String,
    host: String,
    port: u16,
    db: String,
    key: String,
    password: String,
) -> Result<RedisValue, String> {
    let kind = redis_cli(&container, &host, port, &db, &password, &["TYPE", &key])?
        .trim()
        .to_string();
    let value = match kind.as_str() {
        "string" => redis_cli(&container, &host, port, &db, &password, &["GET", &key])?,
        "hash" => redis_cli(&container, &host, port, &db, &password, &["HGETALL", &key])?,
        "list" => redis_cli(
            &container,
            &host,
            port,
            &db,
            &password,
            &["LRANGE", &key, "0", "-1"],
        )?,
        "set" => redis_cli(&container, &host, port, &db, &password, &["SMEMBERS", &key])?,
        "zset" => redis_cli(
            &container,
            &host,
            port,
            &db,
            &password,
            &["ZRANGE", &key, "0", "-1", "WITHSCORES"],
        )?,
        "stream" => redis_cli(
            &container,
            &host,
            port,
            &db,
            &password,
            &["XRANGE", &key, "-", "+", "COUNT", "50"],
        )?,
        _ => String::new(),
    };
    Ok(RedisValue { kind, value })
}

#[tauri::command]
pub fn db_docker_redis_set(
    container: String,
    host: String,
    port: u16,
    db: String,
    key: String,
    value: String,
    password: String,
) -> Result<(), String> {
    redis_cli(&container, &host, port, &db, &password, &["SET", &key, &value]).map(|_| ())
}

#[tauri::command]
pub fn db_docker_redis_ttl(
    container: String,
    host: String,
    port: u16,
    db: String,
    key: String,
    password: String,
) -> Result<i64, String> {
    redis_cli(&container, &host, port, &db, &password, &["TTL", &key])
        .map(|s| s.trim().parse::<i64>().unwrap_or(-2))
}

// Runs a free-form redis-cli command against the `db` database (dev tool).
#[tauri::command]
pub fn db_docker_redis_command(
    container: String,
    host: String,
    port: u16,
    db: String,
    command: String,
    password: String,
) -> Result<String, String> {
    let args: Vec<&str> = command.split_whitespace().collect();
    if args.is_empty() {
        return Err("comando vacío".into());
    }
    redis_cli(&container, &host, port, &db, &password, &args)
}

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
    fn mysql_op_orders_password_and_raw() {
        assert_eq!(
            mysql_op("root", "", "SHOW DATABASES", true),
            vec!["-u", "root", "-N", "-B", "-e", "SHOW DATABASES"]
        );
        assert_eq!(
            mysql_op("root", "pw", "Q", false),
            vec!["-u", "root", "-ppw", "-B", "-e", "Q"]
        );
        assert_eq!(
            mysql_op("root", "pw", "Q", true),
            vec!["-u", "root", "-ppw", "-N", "-B", "-e", "Q"]
        );
    }

    #[test]
    fn sql_quote_escapes_quote_and_backslash() {
        assert_eq!(sql_quote("a'b"), "'a\\'b'");
        assert_eq!(sql_quote("a\\b"), "'a\\\\b'");
    }

    #[test]
    fn pg_quote_doubles_single_quotes() {
        assert_eq!(pg_quote("a'b"), "'a''b'");
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
    fn split_qualified_defaults_to_public() {
        assert_eq!(
            split_qualified("public.users"),
            ("public".into(), "users".into())
        );
        assert_eq!(split_qualified("users"), ("public".into(), "users".into()));
    }

    #[test]
    fn mongo_escape_neutralizes_quotes_and_newlines() {
        assert_eq!(mongo_escape("a'b"), "a\\'b");
        assert_eq!(mongo_escape("a\\b"), "a\\\\b");
        assert_eq!(mongo_escape("a\nb"), "a b");
    }

    #[test]
    fn parse_table_reads_header_and_rows() {
        let t = parse_table("id\tname\n1\ta\n2\tb".to_string());
        assert_eq!(t.columns, vec!["id", "name"]);
        assert_eq!(t.rows, vec![vec!["1", "a"], vec!["2", "b"]]);
        assert!(parse_table(String::new()).columns.is_empty());
    }

    #[test]
    fn lines_of_trims_and_drops_empty() {
        assert_eq!(lines_of("a\n\n  b  \n".to_string()), vec!["a", "b"]);
    }

    #[test]
    fn parse_table_caps_rows_cols_and_cells() {
        // 300 rows, 100 columns, 2000-char cells → an unbounded wide JOIN.
        let header = (0..100)
            .map(|c| format!("c{c}"))
            .collect::<Vec<_>>()
            .join("\t");
        let big_cell = "x".repeat(2000);
        let row = (0..100)
            .map(|_| big_cell.clone())
            .collect::<Vec<_>>()
            .join("\t");
        let body = std::iter::repeat(row)
            .take(300)
            .collect::<Vec<_>>()
            .join("\n");
        let t = parse_table(format!("{header}\n{body}"));
        assert_eq!(t.columns.len(), 80, "columnas acotadas");
        assert_eq!(t.rows.len(), 200, "filas acotadas");
        assert_eq!(t.rows[0].len(), 80, "columnas por fila acotadas");
        assert!(t.rows[0][0].chars().count() <= 501, "celda recortada");
    }
}
