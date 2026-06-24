// Detect database servers (Docker containers + local ports) and list the
// databases inside MySQL/MariaDB and MongoDB. Detection parsing lives in the
// frontend (src/core/db, TDD'd); here we only do the I/O.

use std::net::{SocketAddr, TcpStream};
use std::process::Command;
use std::time::Duration;

// macOS GUI apps don't inherit the shell PATH, so `docker` may not be on PATH.
// Resolve it through a login shell (Unix only; returns None on Windows).
fn login_shell_output(cmd: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = Command::new(shell).arg("-lc").arg(cmd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

// The docker executable: bare `docker` when it's on PATH (Linux/Windows GUI apps
// inherit it), else the path resolved via a login shell (the macOS case).
fn docker_bin() -> Option<String> {
    let on_path = Command::new("docker").arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
    if on_path {
        return Some("docker".into());
    }
    let path = login_shell_output("command -v docker")?;
    let path = path.trim().to_string();
    if path.is_empty() { None } else { Some(path) }
}

// Run docker with the given args, returning stdout on success.
fn docker_output(args: &[&str]) -> Option<String> {
    let bin = docker_bin()?;
    let out = Command::new(bin).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

fn is_safe_container(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

#[tauri::command]
pub fn db_docker_ps() -> String {
    docker_output(&["ps", "--format", "{{.Names}}|{{.Image}}|{{.Ports}}"]).unwrap_or_default()
}

#[tauri::command]
pub fn db_inspect_env(container: String) -> Vec<String> {
    if !is_safe_container(&container) {
        return Vec::new();
    }
    docker_output(&["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", &container])
        .map(|s| s.lines().filter(|l| !l.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

// Run a client INSIDE a container, so DBs work even when the port isn't published
// to the host. Explicit args (not a shell string) keep passwords injection-safe.
fn docker_exec(container: &str, args: &[&str]) -> Result<String, String> {
    if !is_safe_container(container) {
        return Err("contenedor inválido".into());
    }
    let bin = docker_bin().ok_or("docker no encontrado")?;
    let mut full: Vec<&str> = vec!["exec", container];
    full.extend_from_slice(args);
    let out = Command::new(bin).args(&full).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
pub fn db_docker_list_mysql(
    container: String,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    let args = mysql_args(user, password, "SHOW DATABASES".into(), true);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    docker_exec(&container, &refs).map(lines_of)
}

// Run a JS snippet in the container's mongo shell: mongosh (mongo:5+) with a
// fallback to the legacy `mongo` shell.
fn mongo_eval(container: &str, user: &str, password: &str, script: &str) -> Result<String, String> {
    let build = |client: &str| -> Vec<String> {
        let mut a = vec![client.to_string(), "--quiet".to_string()];
        if !user.is_empty() {
            a.extend([
                "-u".into(), user.to_string(), "-p".into(), password.to_string(),
                "--authenticationDatabase".into(), "admin".into(),
            ]);
        }
        a.extend(["--eval".into(), script.to_string()]);
        a
    };
    let run = |args: &[String]| {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        docker_exec(container, &refs)
    };
    run(&build("mongosh")).or_else(|_| run(&build("mongo")))
}

fn lines_of(out: String) -> Vec<String> {
    out.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect()
}

// Reject identifiers that could break out of a backtick (SQL) or single-quote (JS)
// context. Names come from the database's own metadata, so this is belt-and-braces.
fn is_safe_ident(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && !s.contains(['`', '\'', '"', '\\', '\n', '\r', ';'])
}

#[tauri::command]
pub fn db_docker_list_mongo(
    container: String,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    let script = "db.adminCommand('listDatabases').databases.map(function(d){return d.name}).join('\\n')";
    mongo_eval(&container, &user, &password, script).map(lines_of)
}

fn mysql_args(user: String, password: String, query: String, raw: bool) -> Vec<String> {
    // -N drops the header row (used for plain lists); table data keeps it.
    let mut args: Vec<String> = vec!["mysql".into(), "-u".into(), user, "-B".into(), "-e".into(), query];
    if raw {
        args.insert(3, "-N".into());
    }
    if !password.is_empty() {
        args.insert(3, format!("-p{}", password));
    }
    args
}

#[tauri::command]
pub fn db_docker_mysql_tables(
    container: String,
    db: String,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    if !is_safe_ident(&db) {
        return Err("nombre de base inválido".into());
    }
    let args = mysql_args(user, password, format!("SHOW TABLES IN `{}`", db), true);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    docker_exec(&container, &refs).map(lines_of)
}

#[derive(serde::Serialize)]
pub struct TableData {
    columns: Vec<String>,
    rows: Vec<Vec<String>>,
}

#[tauri::command]
pub fn db_docker_mysql_rows(
    container: String,
    db: String,
    table: String,
    user: String,
    password: String,
) -> Result<TableData, String> {
    if !is_safe_ident(&db) || !is_safe_ident(&table) {
        return Err("nombre inválido".into());
    }
    let query = format!("SELECT * FROM `{}`.`{}` LIMIT 200", db, table);
    let args = mysql_args(user, password, query, false);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = docker_exec(&container, &refs)?;
    let mut lines = out.lines();
    let columns: Vec<String> = match lines.next() {
        Some(header) => header.split('\t').map(str::to_string).collect(),
        None => return Ok(TableData { columns: vec![], rows: vec![] }),
    };
    let rows = lines.map(|l| l.split('\t').map(str::to_string).collect()).collect();
    Ok(TableData { columns, rows })
}

fn sql_quote(v: &str) -> String {
    format!("'{}'", v.replace('\\', "\\\\").replace('\'', "\\'"))
}

// Primary-key columns of a table, so an edited cell can build a safe WHERE.
#[tauri::command]
pub fn db_docker_mysql_pk(
    container: String,
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
    let args = mysql_args(user, password, query, true);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    docker_exec(&container, &refs).map(lines_of)
}

// Update one cell, matched by primary-key columns. `wheres` is the PK as
// (column, value) pairs taken from the displayed row.
#[tauri::command]
pub fn db_docker_mysql_update(
    container: String,
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
    if wheres.is_empty() {
        return Err("la tabla no tiene clave primaria".into());
    }
    let mut conds = Vec::new();
    for (col, val) in &wheres {
        if !is_safe_ident(col) {
            return Err("columna inválida".into());
        }
        conds.push(format!("`{}` = {}", col, sql_quote(val)));
    }
    let query = format!(
        "UPDATE `{}`.`{}` SET `{}` = {} WHERE {}",
        db, table, column, sql_quote(&value), conds.join(" AND ")
    );
    let args = mysql_args(user, password, query, false);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    docker_exec(&container, &refs).map(|_| ())
}

// Delete one row by primary key, but refuse if the table is the target of any
// ON DELETE CASCADE foreign key (deleting would silently wipe child rows).
#[tauri::command]
pub fn db_docker_mysql_delete(
    container: String,
    db: String,
    table: String,
    wheres: Vec<(String, String)>,
    user: String,
    password: String,
) -> Result<(), String> {
    if !is_safe_ident(&db) || !is_safe_ident(&table) {
        return Err("nombre inválido".into());
    }
    if wheres.is_empty() {
        return Err("la tabla no tiene clave primaria".into());
    }
    let cascade_query = format!(
        "SELECT TABLE_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='{}' AND REFERENCED_TABLE_NAME='{}' AND DELETE_RULE='CASCADE'",
        db, table
    );
    let cargs = mysql_args(user.clone(), password.clone(), cascade_query, true);
    let crefs: Vec<&str> = cargs.iter().map(String::as_str).collect();
    let cascades = docker_exec(&container, &crefs).map(lines_of)?;
    if !cascades.is_empty() {
        return Err(format!(
            "Bloqueado: borrar aquí arrastraría en cascada (ON DELETE CASCADE) a: {}",
            cascades.join(", ")
        ));
    }
    let mut conds = Vec::new();
    for (col, val) in &wheres {
        if !is_safe_ident(col) {
            return Err("columna inválida".into());
        }
        conds.push(format!("`{}` = {}", col, sql_quote(val)));
    }
    let query = format!("DELETE FROM `{}`.`{}` WHERE {}", db, table, conds.join(" AND "));
    let args = mysql_args(user, password, query, false);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    docker_exec(&container, &refs).map(|_| ())
}

#[tauri::command]
pub fn db_docker_mongo_delete(
    container: String,
    db: String,
    collection: String,
    doc: String,
    user: String,
    password: String,
) -> Result<(), String> {
    if !is_safe_ident(&db) || !is_safe_ident(&collection) {
        return Err("nombre inválido".into());
    }
    let escaped = doc
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', " ")
        .replace('\r', "");
    let script = format!(
        "var d=EJSON.parse('{}');db.getSiblingDB('{}').getCollection('{}').deleteOne({{_id:d._id}})",
        escaped, db, collection
    );
    mongo_eval(&container, &user, &password, &script).map(|_| ())
}

// Replace a document by its _id (mongo can't change _id, so we pull it out of
// the edited doc and use it as the filter).
#[tauri::command]
pub fn db_docker_mongo_update(
    container: String,
    db: String,
    collection: String,
    doc: String,
    user: String,
    password: String,
) -> Result<(), String> {
    if !is_safe_ident(&db) || !is_safe_ident(&collection) {
        return Err("nombre inválido".into());
    }
    let escaped = doc
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', " ")
        .replace('\r', "");
    let script = format!(
        "var d=EJSON.parse('{}');var id=d._id;delete d._id;db.getSiblingDB('{}').getCollection('{}').replaceOne({{_id:id}},d)",
        escaped, db, collection
    );
    mongo_eval(&container, &user, &password, &script).map(|_| ())
}

#[tauri::command]
pub fn db_docker_mongo_collections(
    container: String,
    db: String,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    if !is_safe_ident(&db) {
        return Err("nombre de base inválido".into());
    }
    let script = format!("db.getSiblingDB('{}').getCollectionNames().join('\\n')", db);
    mongo_eval(&container, &user, &password, &script).map(lines_of)
}

#[tauri::command]
pub fn db_docker_mongo_docs(
    container: String,
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
    mongo_eval(&container, &user, &password, &script).map(lines_of)
}

// --- Redis via `docker exec redis-cli` (db index → keys → value by type) ---

fn redis_cli(container: &str, db: &str, password: &str, args: &[&str]) -> Result<String, String> {
    if !is_safe_container(container) || !db.chars().all(|c| c.is_ascii_digit()) || db.is_empty() {
        return Err("parámetro inválido".into());
    }
    let bin = docker_bin().ok_or("docker no encontrado")?;
    let mut full: Vec<&str> = vec!["exec", container, "redis-cli"];
    if !password.is_empty() {
        full.extend_from_slice(&["-a", password, "--no-auth-warning"]);
    }
    full.extend_from_slice(&["-n", db]);
    full.extend_from_slice(args);
    let out = Command::new(bin).args(&full).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
pub fn db_docker_redis_dbs(container: String, password: String) -> Result<Vec<String>, String> {
    // INFO keyspace lists only the logical DBs that hold keys (db0:keys=2,...).
    let out = redis_cli(&container, "0", &password, &["INFO", "keyspace"])?;
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
pub fn db_docker_redis_keys(container: String, db: String, password: String) -> Result<Vec<String>, String> {
    let out = redis_cli(&container, &db, &password, &["--scan"])?;
    Ok(lines_of(out).into_iter().take(1000).collect())
}

#[derive(serde::Serialize)]
pub struct RedisValue {
    kind: String,
    value: String,
}

#[tauri::command]
pub fn db_docker_redis_value(container: String, db: String, key: String, password: String) -> Result<RedisValue, String> {
    let kind = redis_cli(&container, &db, &password, &["TYPE", &key])?.trim().to_string();
    let value = match kind.as_str() {
        "string" => redis_cli(&container, &db, &password, &["GET", &key])?,
        "hash" => redis_cli(&container, &db, &password, &["HGETALL", &key])?,
        "list" => redis_cli(&container, &db, &password, &["LRANGE", &key, "0", "-1"])?,
        "set" => redis_cli(&container, &db, &password, &["SMEMBERS", &key])?,
        "zset" => redis_cli(&container, &db, &password, &["ZRANGE", &key, "0", "-1", "WITHSCORES"])?,
        "stream" => redis_cli(&container, &db, &password, &["XRANGE", &key, "-", "+", "COUNT", "50"])?,
        _ => String::new(),
    };
    Ok(RedisValue { kind, value })
}

// --- PostgreSQL via `docker exec psql` (password through the PGPASSWORD env) ---

fn psql(container: &str, db: &str, user: &str, password: &str, extra: &[&str]) -> Result<String, String> {
    if !is_safe_container(container) || !is_safe_ident(db) || !is_safe_ident(user) {
        return Err("parámetro inválido".into());
    }
    let bin = docker_bin().ok_or("docker no encontrado")?;
    let pgpass = format!("PGPASSWORD={}", password);
    let mut full: Vec<&str> = vec!["exec", "-e", &pgpass, container, "psql", "-U", user, "-d", db];
    full.extend_from_slice(extra);
    let out = Command::new(bin).args(&full).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

// Postgres uses schema-qualified tables (e.g. public.users); split for quoting.
fn split_qualified(name: &str) -> (String, String) {
    match name.split_once('.') {
        Some((schema, table)) => (schema.to_string(), table.to_string()),
        None => ("public".to_string(), name.to_string()),
    }
}

fn pg_quote(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}

#[tauri::command]
pub fn db_docker_pg_databases(container: String, db: String, user: String, password: String) -> Result<Vec<String>, String> {
    let out = psql(&container, &db, &user, &password, &[
        "-t", "-A", "-c",
        "SELECT datname FROM pg_database WHERE datistemplate=false AND datallowconn ORDER BY datname",
    ])?;
    Ok(lines_of(out))
}

#[tauri::command]
pub fn db_docker_pg_tables(container: String, db: String, user: String, password: String) -> Result<Vec<String>, String> {
    let out = psql(&container, &db, &user, &password, &[
        "-t", "-A", "-c",
        "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1",
    ])?;
    Ok(lines_of(out))
}

#[tauri::command]
pub fn db_docker_pg_rows(container: String, db: String, table: String, user: String, password: String) -> Result<TableData, String> {
    let (schema, tbl) = split_qualified(&table);
    if !is_safe_ident(&schema) || !is_safe_ident(&tbl) {
        return Err("nombre inválido".into());
    }
    let query = format!("SELECT * FROM \"{}\".\"{}\" LIMIT 200", schema, tbl);
    let out = psql(&container, &db, &user, &password, &[
        "-A", "-F", "\t", "-P", "footer=off", "-P", "null=NULL", "-c", &query,
    ])?;
    let mut lines = out.lines();
    let columns: Vec<String> = match lines.next() {
        Some(header) => header.split('\t').map(str::to_string).collect(),
        None => return Ok(TableData { columns: vec![], rows: vec![] }),
    };
    let rows = lines.map(|l| l.split('\t').map(str::to_string).collect()).collect();
    Ok(TableData { columns, rows })
}

#[tauri::command]
pub fn db_docker_pg_pk(container: String, db: String, table: String, user: String, password: String) -> Result<Vec<String>, String> {
    let (schema, tbl) = split_qualified(&table);
    if !is_safe_ident(&schema) || !is_safe_ident(&tbl) {
        return Err("nombre inválido".into());
    }
    let query = format!(
        "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid='\"{}\".\"{}\"'::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)",
        schema, tbl
    );
    let out = psql(&container, &db, &user, &password, &["-t", "-A", "-c", &query])?;
    Ok(lines_of(out))
}

#[tauri::command]
pub fn db_docker_pg_update(
    container: String, db: String, table: String,
    column: String, value: String, wheres: Vec<(String, String)>,
    user: String, password: String,
) -> Result<(), String> {
    let (schema, tbl) = split_qualified(&table);
    if !is_safe_ident(&schema) || !is_safe_ident(&tbl) || !is_safe_ident(&column) {
        return Err("nombre inválido".into());
    }
    if wheres.is_empty() {
        return Err("la tabla no tiene clave primaria".into());
    }
    let mut conds = Vec::new();
    for (col, val) in &wheres {
        if !is_safe_ident(col) {
            return Err("columna inválida".into());
        }
        conds.push(format!("\"{}\" = {}", col, pg_quote(val)));
    }
    let query = format!(
        "UPDATE \"{}\".\"{}\" SET \"{}\" = {} WHERE {}",
        schema, tbl, column, pg_quote(&value), conds.join(" AND ")
    );
    psql(&container, &db, &user, &password, &["-c", &query]).map(|_| ())
}

#[tauri::command]
pub fn db_docker_pg_delete(
    container: String, db: String, table: String,
    wheres: Vec<(String, String)>, user: String, password: String,
) -> Result<(), String> {
    let (schema, tbl) = split_qualified(&table);
    if !is_safe_ident(&schema) || !is_safe_ident(&tbl) {
        return Err("nombre inválido".into());
    }
    if wheres.is_empty() {
        return Err("la tabla no tiene clave primaria".into());
    }
    // Guard: child tables referencing this one with ON DELETE CASCADE (confdeltype='c').
    let cascade_query = format!(
        "SELECT conrelid::regclass::text FROM pg_constraint WHERE confrelid='\"{}\".\"{}\"'::regclass AND confdeltype='c'",
        schema, tbl
    );
    let cascades = lines_of(psql(&container, &db, &user, &password, &["-t", "-A", "-c", &cascade_query])?);
    if !cascades.is_empty() {
        return Err(format!("Bloqueado: borrar aquí arrastraría en cascada (ON DELETE CASCADE) a: {}", cascades.join(", ")));
    }
    let mut conds = Vec::new();
    for (col, val) in &wheres {
        if !is_safe_ident(col) {
            return Err("columna inválida".into());
        }
        conds.push(format!("\"{}\" = {}", col, pg_quote(val)));
    }
    let query = format!("DELETE FROM \"{}\".\"{}\" WHERE {}", schema, tbl, conds.join(" AND "));
    psql(&container, &db, &user, &password, &["-c", &query]).map(|_| ())
}

fn is_open(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

#[tauri::command]
pub fn db_check_ports(ports: Vec<u16>) -> Vec<u16> {
    ports.into_iter().filter(|p| is_open(*p)).collect()
}

#[tauri::command]
pub async fn db_list_mysql(
    host: String,
    port: u16,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    use mysql_async::prelude::Queryable;
    let opts = mysql_async::OptsBuilder::default()
        .ip_or_hostname(host)
        .tcp_port(port)
        .user(Some(user))
        .pass(if password.is_empty() { None } else { Some(password) });
    let pool = mysql_async::Pool::new(opts);
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let dbs: Vec<String> = conn.query("SHOW DATABASES").await.map_err(|e| e.to_string())?;
    drop(conn);
    let _ = pool.disconnect().await;
    Ok(dbs)
}

#[tauri::command]
pub async fn db_list_mongo(
    host: String,
    port: u16,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    use mongodb::options::{ClientOptions, Credential, ServerAddress};
    let mut opts = ClientOptions::default();
    opts.hosts = vec![ServerAddress::Tcp { host, port: Some(port) }];
    opts.connect_timeout = Some(Duration::from_secs(5));
    opts.server_selection_timeout = Some(Duration::from_secs(5));
    if !user.is_empty() {
        let mut cred = Credential::default();
        cred.username = Some(user);
        cred.password = Some(password);
        opts.credential = Some(cred);
    }
    let client = mongodb::Client::with_options(opts).map_err(|e| e.to_string())?;
    client.list_database_names(None, None).await.map_err(|e| e.to_string())
}
