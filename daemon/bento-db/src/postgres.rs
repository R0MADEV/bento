use super::*;
use super::mysql::parse_table;


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


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pg_quote_doubles_single_quotes() {
        assert_eq!(pg_quote("a'b"), "'a''b'");
    }

    #[test]
    fn split_qualified_defaults_to_public() {
        assert_eq!(
            split_qualified("public.users"),
            ("public".into(), "users".into())
        );
        assert_eq!(split_qualified("users"), ("public".into(), "users".into()));
    }
}
