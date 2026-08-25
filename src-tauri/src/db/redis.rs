//! Los comandos Redis. La lógica está en `bento_db::redis`.

use bento_db::redis::RedisValue;

#[tauri::command]
pub fn db_docker_redis_dbs(
    container: String,
    host: String,
    port: u16,
    password: String,
) -> Result<Vec<String>, String> {
    bento_db::redis::db_docker_redis_dbs(container, host, port, password)
}

#[tauri::command]
pub fn db_docker_redis_keys(
    container: String,
    host: String,
    port: u16,
    db: String,
    password: String,
) -> Result<Vec<String>, String> {
    bento_db::redis::db_docker_redis_keys(container, host, port, db, password)
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
    bento_db::redis::db_docker_redis_value(container, host, port, db, key, password)
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
    bento_db::redis::db_docker_redis_set(container, host, port, db, key, value, password)
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
    bento_db::redis::db_docker_redis_ttl(container, host, port, db, key, password)
}

#[tauri::command]
pub fn db_docker_redis_command(
    container: String,
    host: String,
    port: u16,
    db: String,
    command: String,
    password: String,
) -> Result<String, String> {
    bento_db::redis::db_docker_redis_command(container, host, port, db, command, password)
}
