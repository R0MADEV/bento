//! Los comandos MySQL/MariaDB. La lógica está en `bento_db::mysql`.

use bento_db::{ForeignKey, TableData};

#[tauri::command]
pub fn db_docker_list_mysql(
    container: String,
    host: String,
    port: u16,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    bento_db::mysql::db_docker_list_mysql(container, host, port, user, password)
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
    bento_db::mysql::db_docker_mysql_tables(container, host, port, db, user, password)
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
    bento_db::mysql::db_docker_mysql_rows(container, host, port, db, table, user, password)
}

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
    bento_db::mysql::db_docker_mysql_query(container, host, port, db, sql, user, password)
}

#[tauri::command]
pub fn db_docker_mysql_fks(
    container: String,
    host: String,
    port: u16,
    db: String,
    user: String,
    password: String,
) -> Result<Vec<ForeignKey>, String> {
    bento_db::mysql::db_docker_mysql_fks(container, host, port, db, user, password)
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
    bento_db::mysql::db_docker_mysql_pk(container, host, port, db, table, user, password)
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
    bento_db::mysql::db_docker_mysql_update(container, host, port, db, table, column, value, wheres, user, password)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
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
    bento_db::mysql::db_docker_mysql_delete(container, host, port, db, table, wheres, user, password)
}
