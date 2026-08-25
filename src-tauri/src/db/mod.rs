//! Los comandos del panel de bases de datos. La detección y todo el
//! trabajo con los clientes (mysql, psql, mongosh, redis-cli) viven en
//! `bento_db`, que comparten el desktop y quien haga falta después.

pub(crate) mod query;

pub(crate) mod mongo;
pub(crate) mod mysql;
pub(crate) mod postgres;
pub(crate) mod redis;

#[tauri::command]
pub fn db_docker_ps() -> String {
    bento_db::db_docker_ps()
}

#[tauri::command]
pub fn db_inspect_env(container: String) -> Vec<String> {
    bento_db::db_inspect_env(container)
}

#[tauri::command]
pub fn db_check_ports(ports: Vec<u16>) -> Vec<u16> {
    bento_db::db_check_ports(ports)
}
