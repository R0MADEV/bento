//! Construir el SQL que el panel enseña y ejecuta. La lógica vive en
//! `bento_db::query`: entrecomillar un nombre o escapar un literal es lo
//! último que conviene tener escrito dos veces.

use bento_db::query::{self, Engine, PreparedQuery};
use bento_db::ForeignKey;

fn engine(kind: &str) -> Result<Engine, String> {
    Engine::from_kind(kind)
}

#[tauri::command]
pub fn db_sql_example(kind: String, name: String) -> Result<String, String> {
    query::example_query(engine(&kind)?, &name)
}

#[tauri::command]
pub fn db_sql_relations(
    kind: String,
    table: String,
    foreign_keys: Vec<ForeignKey>,
) -> Result<String, String> {
    query::relation_query(engine(&kind)?, &table, &foreign_keys)
}

/// `None` cuando esas tablas no están conectadas por sus relaciones.
#[tauri::command]
pub fn db_sql_join(
    kind: String,
    tables: Vec<String>,
    relations: Vec<ForeignKey>,
) -> Result<Option<String>, String> {
    query::join_query(engine(&kind)?, &tables, &relations)
}

#[tauri::command]
pub fn db_sql_insert(
    kind: String,
    db: String,
    table: String,
    values: Vec<(String, Option<String>)>,
) -> Result<String, String> {
    query::insert_statement(engine(&kind)?, &db, &table, &values)
}

#[tauri::command]
pub fn db_sql_set_null(
    kind: String,
    db: String,
    table: String,
    column: String,
    wheres: Vec<(String, String)>,
) -> Result<String, String> {
    query::set_null_statement(engine(&kind)?, &db, &table, &column, &wheres)
}

/// Le pone al SELECT su LIMIT de seguridad y lo adapta al motor.
#[tauri::command]
pub fn db_sql_prepare(
    kind: String,
    sql: String,
    names: Vec<String>,
) -> Result<PreparedQuery, String> {
    Ok(query::prepare(
        engine(&kind)?,
        &sql,
        &names,
        query::DEFAULT_ROW_LIMIT,
    ))
}
