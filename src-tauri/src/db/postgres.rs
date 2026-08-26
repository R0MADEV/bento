//! Los comandos PostgreSQL. La lógica está en `bento_db::postgres`.

use bento_db::{ForeignKey, TableData};

#[tauri::command]
pub fn db_docker_pg_databases(
    container: String,
    host: String,
    port: u16,
    db: String,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    bento_db::postgres::db_docker_pg_databases(container, host, port, db, user, password)
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
    bento_db::postgres::db_docker_pg_tables(container, host, port, db, user, password)
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
    bento_db::postgres::db_docker_pg_rows(container, host, port, db, table, user, password)
}

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
    bento_db::postgres::db_docker_pg_query(container, host, port, db, sql, user, password)
}

#[tauri::command]
pub fn db_docker_pg_fks(
    container: String,
    host: String,
    port: u16,
    db: String,
    user: String,
    password: String,
) -> Result<Vec<ForeignKey>, String> {
    bento_db::postgres::db_docker_pg_fks(container, host, port, db, user, password)
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
    bento_db::postgres::db_docker_pg_pk(container, host, port, db, table, user, password)
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
    bento_db::postgres::db_docker_pg_update(container, host, port, db, table, column, value, wheres, user, password)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
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
    bento_db::postgres::db_docker_pg_delete(container, host, port, db, table, wheres, user, password)
}
