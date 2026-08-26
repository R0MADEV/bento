//! El SQL que el panel enseña y ejecuta: cómo se entrecomilla cada nombre en
//! cada motor, las consultas de ejemplo y de relaciones, el camino de JOINs
//! entre tablas y el LIMIT de seguridad. Estaba en TypeScript, con sus propias
//! reglas de comillas: dos implementaciones del mismo escapado es justo lo que
//! no se quiere tener.

use serde::{Deserialize, Serialize};

use crate::ForeignKey;

/// Cuántas filas devuelve como mucho un SELECT sin cota propia.
pub const DEFAULT_ROW_LIMIT: u32 = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Mysql,
    Postgres,
    Mongodb,
    Redis,
}

impl Engine {
    pub fn from_kind(kind: &str) -> Result<Engine, String> {
        match kind {
            "mysql" | "mariadb" => Ok(Engine::Mysql),
            "postgres" => Ok(Engine::Postgres),
            "mongodb" => Ok(Engine::Mongodb),
            "redis" => Ok(Engine::Redis),
            other => Err(format!("motor desconocido: {other}")),
        }
    }

    fn is_pg(self) -> bool {
        self == Engine::Postgres
    }
}

/// Los nombres vienen del catálogo del propio motor, pero acaban concatenados
/// en una sentencia: si alguno trae una comilla o un punto y coma, no se
/// construye la consulta.
fn check(name: &str) -> Result<(), String> {
    let is_safe = !name.is_empty()
        && name.len() <= 128
        && !name.contains(['`', '\'', '"', '\\', '\n', '\r', ';']);
    if is_safe {
        return Ok(());
    }
    Err(format!("nombre inválido: {name}"))
}

/// Una columna, entrecomillada como la escribe cada motor.
pub fn ident(engine: Engine, name: &str) -> Result<String, String> {
    check(name)?;
    Ok(match engine.is_pg() {
        true => format!("\"{name}\""),
        false => format!("`{name}`"),
    })
}

/// Una tabla. Postgres entrecomilla cada parte por separado para que el punto
/// quede fuera de las comillas (`"schema"."table"`, nunca `"schema.table"`).
pub fn table_ident(engine: Engine, name: &str) -> Result<String, String> {
    check(name)?;
    if !engine.is_pg() {
        return Ok(format!("`{name}`"));
    }
    Ok(name
        .split('.')
        .map(|part| format!("\"{part}\""))
        .collect::<Vec<_>>()
        .join("."))
}

/// La tabla tal y como la direcciona el motor: MySQL la cualifica con la base
/// de datos, Postgres con su propio esquema si lo trae el nombre.
pub fn qualified_table(engine: Engine, db: &str, table: &str) -> Result<String, String> {
    if engine.is_pg() {
        return table_ident(engine, table);
    }
    check(db)?;
    check(table)?;
    Ok(format!("`{db}`.`{table}`"))
}

/// Un literal. Postgres duplica la comilla simple; MySQL escapa con barra, y la
/// barra antes que la comilla para que la comilla siga escapada.
pub fn quote_value(engine: Engine, value: &str) -> String {
    if engine.is_pg() {
        return format!("'{}'", value.replace('\'', "''"));
    }
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// La consulta que rellena el editor al pulsar una tabla.
pub fn example_query(engine: Engine, name: &str) -> Result<String, String> {
    check(name)?;
    Ok(match engine {
        Engine::Mongodb => format!("db.{name}.find().limit(20).toArray()"),
        Engine::Redis => format!("GET {name}"),
        _ => format!("SELECT * FROM {} LIMIT 100", table_ident(engine, name)?),
    })
}

/// Una tabla con todo lo que cuelga de sus claves foráneas.
pub fn relation_query(
    engine: Engine,
    table: &str,
    foreign_keys: &[ForeignKey],
) -> Result<String, String> {
    check(table)?;
    if engine == Engine::Mongodb {
        let stages = foreign_keys
            .iter()
            .map(|fk| {
                check(&fk.ref_table)?;
                check(&fk.column)?;
                Ok(format!(
                    "  {{ $lookup: {{ from: \"{}\", localField: \"{}\", foreignField: \"_id\", as: \"{}\" }} }}",
                    fk.ref_table, fk.column, fk.ref_table
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        return Ok(format!(
            "db.{table}.aggregate([\n{},\n  {{ $limit: 20 }}\n]).toArray()",
            stages.join(",\n")
        ));
    }
    let joins = foreign_keys
        .iter()
        .enumerate()
        .map(|(index, fk)| {
            Ok(format!(
                "JOIN {} r{} ON base.{} = r{}.{}",
                table_ident(engine, &fk.ref_table)?,
                index + 1,
                ident(engine, &fk.column)?,
                index + 1,
                ident(engine, &fk.ref_column)?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(format!(
        "SELECT * FROM {} base\n{}\nLIMIT 100",
        table_ident(engine, table)?,
        joins.join("\n")
    ))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinStep {
    pub from: String,
    pub from_col: String,
    pub to: String,
    pub to_col: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinPlan {
    pub base: String,
    pub steps: Vec<JoinStep>,
}

/// El JOIN que conecta unas tablas, con las intermedias que hagan falta.
/// `None` cuando no hay camino entre ellas.
pub fn join_query(
    engine: Engine,
    tables: &[String],
    relations: &[ForeignKey],
) -> Result<Option<String>, String> {
    let Some(plan) = join_path(tables, relations) else {
        return Ok(None);
    };
    let mut sql = format!("SELECT * FROM {} t0", table_ident(engine, &plan.base)?);
    let mut aliases = vec![(plan.base.clone(), "t0".to_string())];
    for (index, step) in plan.steps.iter().enumerate() {
        let alias = format!("t{}", index + 1);
        let from_alias = aliases
            .iter()
            .find(|(table, _)| table == &step.from)
            .map(|(_, alias)| alias.clone())
            .unwrap_or_default();
        sql.push_str(&format!(
            "\nJOIN {} {alias} ON {from_alias}.{} = {alias}.{}",
            table_ident(engine, &step.to)?,
            ident(engine, &step.from_col)?,
            ident(engine, &step.to_col)?,
        ));
        aliases.push((step.to.clone(), alias));
    }
    Ok(Some(format!("{sql}\nLIMIT 100")))
}

/// Un arco del grafo de relaciones: une dos tablas por sus columnas, y se
/// recorre en los dos sentidos.
struct Edge<'a> {
    a: &'a str,
    a_col: &'a str,
    b: &'a str,
    b_col: &'a str,
}

impl Edge<'_> {
    fn step(&self, from: &str, to: &str) -> JoinStep {
        let forward = from == self.a;
        JoinStep {
            from: from.to_string(),
            from_col: if forward { self.a_col } else { self.b_col }.to_string(),
            to: to.to_string(),
            to_col: if forward { self.b_col } else { self.a_col }.to_string(),
        }
    }
}

/// Constructor de JOINs determinista: dadas unas tablas y las claves foráneas
/// de la base, busca un árbol que las conecte pasando por intermedias si hace
/// falta. Grafo puro, sin IA: siempre da el mismo resultado.
pub fn join_path(tables: &[String], relations: &[ForeignKey]) -> Option<JoinPlan> {
    let mut targets: Vec<&str> = Vec::new();
    for table in tables.iter().filter(|t| !t.is_empty()) {
        if !targets.contains(&table.as_str()) {
            targets.push(table);
        }
    }
    let base = (*targets.first()?).to_string();
    let edges: Vec<Edge> = relations
        .iter()
        .map(|fk| Edge {
            a: &fk.table,
            a_col: &fk.column,
            b: &fk.ref_table,
            b_col: &fk.ref_column,
        })
        .collect();

    let mut connected: Vec<String> = vec![base.clone()];
    let mut steps: Vec<JoinStep> = Vec::new();
    for target in targets.iter().skip(1) {
        if connected.iter().any(|table| table == target) {
            continue;
        }
        let path = shortest_path(&edges, &connected, target)?;
        for (edge, from, to) in path {
            if connected.iter().any(|table| table == &to) {
                continue;
            }
            steps.push(edges[edge].step(&from, &to));
            connected.push(to);
        }
    }
    Some(JoinPlan { base, steps })
}

/// BFS desde todo lo ya conectado hasta `target`: devuelve las aristas del
/// camino más corto, cada una con el sentido en que se recorre.
fn shortest_path(
    edges: &[Edge],
    connected: &[String],
    target: &str,
) -> Option<Vec<(usize, String, String)>> {
    let mut queue: Vec<String> = connected.to_vec();
    let mut visited: Vec<String> = connected.to_vec();
    // nodo → (nodo anterior, arista por la que se llegó)
    let mut previous: Vec<(String, String, usize)> = Vec::new();

    let mut head = 0;
    while head < queue.len() {
        let node = queue[head].clone();
        head += 1;
        if node == target {
            break;
        }
        for (index, edge) in edges.iter().enumerate() {
            let next = match (edge.a == node, edge.b == node) {
                (true, _) => edge.b,
                (_, true) => edge.a,
                _ => continue,
            };
            if visited.iter().any(|seen| seen == next) {
                continue;
            }
            visited.push(next.to_string());
            previous.push((next.to_string(), node.clone(), index));
            queue.push(next.to_string());
        }
    }

    let found = |node: &str| {
        previous
            .iter()
            .find(|(to, _, _)| to == node)
            .map(|(_, from, edge)| (from.clone(), *edge))
    };
    found(target)?;
    let mut path = Vec::new();
    let mut current = target.to_string();
    while let Some((from, edge)) = found(&current) {
        path.insert(0, (edge, from.clone(), current.clone()));
        current = from;
    }
    Some(path)
}

/// Lo que hay que ejecutar de verdad, ya adaptado al motor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PreparedQuery {
    /// La sentencia final, con el prefijo o las comillas que pida el motor.
    pub sql: String,
    /// La consulta sin punto y coma final, para paginar a partir de ella.
    pub base: String,
    /// Si el LIMIT lo hemos puesto nosotros (entonces se puede ofrecer "cargar
    /// más"); si ya lo traía, no.
    pub limited: bool,
}

/// Prepara lo que se va a ejecutar: le pone un LIMIT de seguridad si es un
/// SELECT sin cota, y luego lo adapta al motor.
///
/// Sin cota, un JOIN ancho (`SELECT *` sobre muchas tablas) hace que el motor
/// materialice un resultado enorme: revienta la RAM de la máquina y con ella el
/// WebView. Esto es un navegador de bases de datos de desarrollo, no una
/// herramienta de reporting.
pub fn prepare(engine: Engine, sql: &str, names: &[String], limit: u32) -> PreparedQuery {
    let base = sql.trim().trim_end_matches(';').trim_end().to_string();
    let lower = base.to_lowercase();
    let is_select = starts_with_word(&lower, "select") || starts_with_word(&lower, "with");
    let limited = is_select && !has_row_limit(&lower);
    let limited_sql = match limited {
        true => format!("{base}\nLIMIT {limit}"),
        false => base.clone(),
    };
    PreparedQuery {
        sql: for_engine(engine, &limited_sql, names),
        base,
        limited,
    }
}

/// Postgres respeta las mayúsculas solo si el nombre va entrecomillado; MySQL
/// se atasca planificando JOINs anchos y con `optimizer_search_depth=1` planifica
/// en avaricioso al instante (Postgres no sufre esto).
fn for_engine(engine: Engine, sql: &str, names: &[String]) -> String {
    match engine {
        Engine::Postgres => pg_fix_idents(sql, names),
        Engine::Mysql => format!("SET SESSION optimizer_search_depth=1; {sql}"),
        _ => sql.to_string(),
    }
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn starts_with_word(lower: &str, word: &str) -> bool {
    lower.starts_with(word) && !lower[word.len()..].starts_with(is_word_char)
}

/// `LIMIT` como palabra suelta y seguido de un número: `limit_reached` no
/// cuenta, y `LIMIT` sin número tampoco.
fn has_row_limit(lower: &str) -> bool {
    lower.match_indices("limit").any(|(index, _)| {
        let before_is_word = lower[..index].chars().next_back().is_some_and(is_word_char);
        let rest = &lower[index + "limit".len()..];
        let digit_follows = rest
            .trim_start_matches([' ', '\t', '\n', '\r'])
            .starts_with(|c: char| c.is_ascii_digit());
        let separated = rest.len() != rest.trim_start_matches([' ', '\t', '\n', '\r']).len();
        !before_is_word && separated && digit_follows
    })
}

/// Red de seguridad de Postgres: entrecomilla los nombres conocidos que traigan
/// mayúsculas y vengan sin comillas (Postgres los pasaría a minúsculas y
/// fallaría). Cubre lo que la IA se deja sin entrecomillar.
pub fn pg_fix_idents(sql: &str, names: &[String]) -> String {
    let mut out = sql.to_string();
    // Mal entrecomillado de una pieza: "schema.table" → "schema"."table".
    for full in names.iter().filter(|name| name.contains('.')) {
        out = out.replace(&format!("\"{full}\""), &quote_parts(full));
    }
    for full in names {
        let table = full.rsplit('.').next().unwrap_or(full);
        // Lo demás solo corre peligro por las mayúsculas.
        if !table.chars().any(char::is_uppercase) {
            continue;
        }
        out = replace_bare(&out, full, &quote_parts(full));
        out = replace_bare(&out, table, &format!("\"{table}\""));
    }
    out
}

fn quote_parts(name: &str) -> String {
    name.split('.')
        .map(|part| format!("\"{part}\""))
        .collect::<Vec<_>>()
        .join(".")
}

/// Sustituye `needle` solo donde va suelto: ni pegado a una palabra, ni ya
/// entrecomillado, ni como parte de un nombre cualificado.
fn replace_bare(haystack: &str, needle: &str, replacement: &str) -> String {
    let mut out = String::with_capacity(haystack.len());
    let mut rest = haystack;
    while let Some(index) = rest.find(needle) {
        let before = rest[..index].chars().next_back();
        let after = rest[index + needle.len()..].chars().next();
        let bare = !before.is_some_and(|c| c == '"' || c == '.' || is_word_char(c))
            && !after.is_some_and(|c| c == '"' || is_word_char(c));
        out.push_str(&rest[..index]);
        out.push_str(if bare { replacement } else { needle });
        rest = &rest[index + needle.len()..];
    }
    out.push_str(rest);
    out
}

/// El INSERT de una fila nueva. `None` en un valor es NULL, no la cadena
/// "NULL".
pub fn insert_statement(
    engine: Engine,
    db: &str,
    table: &str,
    values: &[(String, Option<String>)],
) -> Result<String, String> {
    if values.is_empty() {
        return Err("no hay ningún valor que insertar".into());
    }
    let columns = values
        .iter()
        .map(|(column, _)| ident(engine, column))
        .collect::<Result<Vec<_>, String>>()?;
    let literals: Vec<String> = values
        .iter()
        .map(|(_, value)| match value {
            Some(value) => quote_value(engine, value),
            None => "NULL".to_string(),
        })
        .collect();
    Ok(format!(
        "INSERT INTO {} ({}) VALUES ({})",
        qualified_table(engine, db, table)?,
        columns.join(", "),
        literals.join(", ")
    ))
}

/// El UPDATE que vacía una celda. `wheres` identifica la fila.
pub fn set_null_statement(
    engine: Engine,
    db: &str,
    table: &str,
    column: &str,
    wheres: &[(String, String)],
) -> Result<String, String> {
    if wheres.is_empty() {
        return Err("sin WHERE no se actualiza una fila suelta".into());
    }
    let conditions = wheres
        .iter()
        .map(|(col, value)| Ok(format!("{} = {}", ident(engine, col)?, quote_value(engine, value))))
        .collect::<Result<Vec<_>, String>>()?;
    Ok(format!(
        "UPDATE {} SET {} = NULL WHERE {}",
        qualified_table(engine, db, table)?,
        ident(engine, column)?,
        conditions.join(" AND ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fk(table: &str, column: &str, ref_table: &str, ref_column: &str) -> ForeignKey {
        ForeignKey {
            table: table.into(),
            column: column.into(),
            ref_table: ref_table.into(),
            ref_column: ref_column.into(),
        }
    }

    #[test]
    fn each_engine_quotes_names_its_own_way() {
        assert_eq!(ident(Engine::Mysql, "name").unwrap(), "`name`");
        assert_eq!(ident(Engine::from_kind("mariadb").unwrap(), "name").unwrap(), "`name`");
        assert_eq!(ident(Engine::Postgres, "name").unwrap(), "\"name\"");
        // La tabla sí parte por el punto: el punto queda fuera de las comillas.
        assert_eq!(table_ident(Engine::Postgres, "sales.orders").unwrap(), "\"sales\".\"orders\"");
        assert_eq!(qualified_table(Engine::Mysql, "app", "users").unwrap(), "`app`.`users`");
        assert_eq!(qualified_table(Engine::Postgres, "app", "sales.orders").unwrap(), "\"sales\".\"orders\"");
        assert_eq!(qualified_table(Engine::Postgres, "app", "users").unwrap(), "\"users\"");
    }

    #[test]
    fn a_name_that_could_break_out_of_the_quotes_is_refused() {
        assert!(ident(Engine::Mysql, "id`, (SELECT 1)").is_err());
        assert!(table_ident(Engine::Postgres, "users\"; DROP TABLE x--").is_err());
        assert!(qualified_table(Engine::Mysql, "app", "").is_err());
        assert!(example_query(Engine::Mongodb, "users'; db.dropDatabase()").is_err());
    }

    #[test]
    fn literals_are_escaped_the_way_each_engine_expects() {
        assert_eq!(quote_value(Engine::Postgres, "O'Brien"), "'O''Brien'");
        assert_eq!(quote_value(Engine::Mysql, "O'Brien"), "'O\\'Brien'");
        assert_eq!(quote_value(Engine::Mysql, "back\\slash"), "'back\\\\slash'");
        // La barra se escapa antes que la comilla, o la comilla dejaría de estarlo.
        assert_eq!(quote_value(Engine::Mysql, "a\\'b"), "'a\\\\\\'b'");
    }

    #[test]
    fn the_example_query_speaks_the_engines_language() {
        assert!(example_query(Engine::Mongodb, "users").unwrap().contains("find()"));
        assert_eq!(example_query(Engine::Redis, "session").unwrap(), "GET session");
        assert_eq!(
            example_query(Engine::Mysql, "users").unwrap(),
            "SELECT * FROM `users` LIMIT 100"
        );
    }

    #[test]
    fn the_relation_query_joins_every_foreign_key() {
        let relations = [fk("orders", "user_id", "users", "id")];
        let sql = relation_query(Engine::Mysql, "orders", &relations).unwrap();
        assert!(sql.contains("JOIN `users` r1 ON base.`user_id` = r1.`id`"), "{sql}");
        let mongo = relation_query(Engine::Mongodb, "orders", &relations).unwrap();
        assert!(mongo.contains("$lookup"), "{mongo}");
    }

    #[test]
    fn joining_two_tables_uses_the_relation_between_them() {
        let relations = [fk("orders", "user_id", "users", "id")];
        let sql = join_query(Engine::Mysql, &["orders".into(), "users".into()], &relations)
            .unwrap()
            .unwrap();
        assert!(sql.contains("SELECT * FROM `orders` t0"), "{sql}");
        assert!(sql.contains("JOIN `users` t1 ON t0.`user_id` = t1.`id`"), "{sql}");
    }

    #[test]
    fn tables_that_only_connect_through_a_third_one_go_through_it() {
        // orders → users y orders → items: pedir users+items arrastra orders.
        let relations = [
            fk("orders", "user_id", "users", "id"),
            fk("orders", "item_id", "items", "id"),
        ];
        let plan = join_path(&["users".into(), "items".into()], &relations).unwrap();
        assert_eq!(plan.base, "users");
        let visited: Vec<&str> = plan.steps.iter().map(|step| step.to.as_str()).collect();
        assert_eq!(visited, vec!["orders", "items"]);
    }

    #[test]
    fn tables_with_nothing_between_them_have_no_plan() {
        assert!(join_path(&["a".into(), "b".into()], &[]).is_none());
        assert!(join_path(&[], &[]).is_none());
        // Una sola tabla no necesita ningún JOIN.
        assert_eq!(join_path(&["a".into()], &[]).unwrap().steps.len(), 0);
    }

    #[test]
    fn a_select_without_a_limit_gets_one_and_says_so() {
        let prepared = prepare(Engine::Mongodb, "SELECT * FROM users", &[], 200);
        assert_eq!(prepared.sql, "SELECT * FROM users\nLIMIT 200");
        assert_eq!(prepared.base, "SELECT * FROM users");
        assert!(prepared.limited);

        for already_limited in ["SELECT * FROM users LIMIT 10", "select * from users limit 5"] {
            let prepared = prepare(Engine::Mongodb, already_limited, &[], 200);
            assert_eq!(prepared.sql, already_limited);
            assert!(!prepared.limited);
        }
        // Punto y coma final fuera, y el LIMIT después del ORDER BY.
        assert_eq!(
            prepare(Engine::Mongodb, "SELECT * FROM users;", &[], 200).sql,
            "SELECT * FROM users\nLIMIT 200"
        );
        assert_eq!(
            prepare(Engine::Mongodb, "SELECT * FROM t ORDER BY id", &[], 50).sql,
            "SELECT * FROM t ORDER BY id\nLIMIT 50"
        );
        assert!(prepare(Engine::Mongodb, "WITH x AS (SELECT 1) SELECT * FROM x", &[], 200).limited);
    }

    #[test]
    fn what_is_not_a_select_is_left_alone() {
        for statement in ["UPDATE users SET a = 1", "SHOW TABLES", "EXPLAIN SELECT 1"] {
            let prepared = prepare(Engine::Mongodb, statement, &[], 200);
            assert_eq!(prepared.sql, statement);
            assert!(!prepared.limited);
        }
        // `limit_reached` no es un LIMIT, y `LIMIT` sin número tampoco.
        assert!(prepare(Engine::Mongodb, "SELECT limit_reached FROM t", &[], 200).limited);
    }

    #[test]
    fn each_engine_gets_the_prefix_or_the_quoting_it_needs() {
        let mysql = prepare(Engine::Mysql, "SELECT 1", &[], 200);
        assert!(mysql.sql.starts_with("SET SESSION optimizer_search_depth=1; "), "{}", mysql.sql);
        let names = ["public.Client".to_string()];
        let pg = prepare(Engine::Postgres, "SELECT * FROM Client", &names, 200);
        assert!(pg.sql.contains("\"Client\""), "{}", pg.sql);
    }

    #[test]
    fn postgres_only_quotes_the_names_it_was_told_about() {
        let names = ["public.Client".to_string()];
        assert_eq!(pg_fix_idents("SELECT * FROM users", &["users".into()]), "SELECT * FROM users");
        assert_eq!(
            pg_fix_idents("SELECT * FROM \"public.client\"", &["public.client".into()]),
            "SELECT * FROM \"public\".\"client\""
        );
        assert_eq!(pg_fix_idents("SELECT * FROM Client", &names), "SELECT * FROM \"Client\"");
        assert_eq!(
            pg_fix_idents("SELECT * FROM public.Client", &names),
            "SELECT * FROM \"public\".\"Client\""
        );
        // Ya entrecomillado, o desconocido: no se toca.
        assert_eq!(pg_fix_idents("SELECT * FROM \"Client\"", &names), "SELECT * FROM \"Client\"");
        assert_eq!(pg_fix_idents("SELECT * FROM Unknown", &names), "SELECT * FROM Unknown");
    }

    #[test]
    fn writing_a_row_quotes_every_name_and_every_value() {
        let values = [
            ("name".to_string(), Some("O'Brien".to_string())),
            ("note".to_string(), None),
        ];
        assert_eq!(
            insert_statement(Engine::Mysql, "app", "users", &values).unwrap(),
            "INSERT INTO `app`.`users` (`name`, `note`) VALUES ('O\\'Brien', NULL)"
        );
        assert_eq!(
            set_null_statement(Engine::Postgres, "app", "users", "note", &[("id".into(), "7".into())]).unwrap(),
            "UPDATE \"users\" SET \"note\" = NULL WHERE \"id\" = '7'"
        );
    }

    #[test]
    fn a_write_without_values_or_without_a_where_is_refused() {
        assert!(insert_statement(Engine::Mysql, "app", "users", &[]).is_err());
        // Sin WHERE, el UPDATE vaciaría la columna entera.
        assert!(set_null_statement(Engine::Mysql, "app", "users", "note", &[]).is_err());
    }
}
