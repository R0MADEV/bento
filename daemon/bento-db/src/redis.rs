use super::*;


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

pub fn db_docker_redis_set(
    container: String,
    host: String,
    port: u16,
    db: String,
    key: String,
    value: String,
    password: String,
) -> Result<(), String> {
    redis_cli(
        &container,
        &host,
        port,
        &db,
        &password,
        &["SET", &key, &value],
    )
    .map(|_| ())
}

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
