use super::*;


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

pub(super) fn parse_table(out: String) -> TableData {
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


#[cfg(test)]
mod tests {
    use super::*;

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
    fn parse_table_reads_header_and_rows() {
        let t = parse_table("id\tname\n1\ta\n2\tb".to_string());
        assert_eq!(t.columns, vec!["id", "name"]);
        assert_eq!(t.rows, vec![vec!["1", "a"], vec!["2", "b"]]);
        assert!(parse_table(String::new()).columns.is_empty());
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
