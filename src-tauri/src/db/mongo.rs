//! Los comandos MongoDB. La lógica está en `bento_db::mongo`.

use bento_db::ForeignKey;

#[tauri::command]
pub fn db_docker_list_mongo(
    container: String,
    host: String,
    port: u16,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    bento_db::mongo::db_docker_list_mongo(container, host, port, user, password)
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
    bento_db::mongo::db_docker_mongo_collections(container, host, port, db, user, password)
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
    bento_db::mongo::db_docker_mongo_docs(container, host, port, db, collection, user, password)
}

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
    bento_db::mongo::db_docker_mongo_query(container, host, port, db, script, user, password)
}

#[tauri::command]
pub fn db_docker_mongo_refs(
    container: String,
    host: String,
    port: u16,
    db: String,
    user: String,
    password: String,
) -> Result<Vec<ForeignKey>, String> {
    bento_db::mongo::db_docker_mongo_refs(container, host, port, db, user, password)
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
    bento_db::mongo::db_docker_mongo_update(container, host, port, db, collection, doc, user, password)
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
    bento_db::mongo::db_docker_mongo_delete(container, host, port, db, collection, doc, user, password)
}
