use super::*;


// Run a JS snippet in the mongo shell: mongosh (mongo:5+) with a fallback to the
// legacy `mongo` shell.
fn mongo_eval(
    container: &str,
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    script: &str,
) -> Result<String, String> {
    let mut op: Vec<String> = vec!["--quiet".into()];
    if !user.is_empty() {
        op.extend([
            "-u".into(),
            user.into(),
            "-p".into(),
            password.into(),
            "--authenticationDatabase".into(),
            "admin".into(),
        ]);
    }
    op.extend(["--eval".into(), script.into()]);
    let refs: Vec<&str> = op.iter().map(String::as_str).collect();
    run_client(container, host, port, "mongosh", &refs, &[])
        .or_else(|_| run_client(container, host, port, "mongo", &refs, &[]))
}

fn mongo_escape(doc: &str) -> String {
    doc.replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', " ")
        .replace('\r', "")
}

#[tauri::command]
pub fn db_docker_list_mongo(
    container: String,
    host: String,
    port: u16,
    user: String,
    password: String,
) -> Result<Vec<String>, String> {
    let script =
        "db.adminCommand('listDatabases').databases.map(function(d){return d.name}).join('\\n')";
    mongo_eval(&container, &host, port, &user, &password, script).map(lines_of)
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
    if !is_safe_ident(&db) {
        return Err("nombre de base inválido".into());
    }
    let script = format!("db.getSiblingDB('{}').getCollectionNames().join('\\n')", db);
    mongo_eval(&container, &host, port, &user, &password, &script).map(lines_of)
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
    if !is_safe_ident(&db) || !is_safe_ident(&collection) {
        return Err("nombre inválido".into());
    }
    let script = format!(
        "db.getSiblingDB('{}').getCollection('{}').find().limit(50).toArray().map(function(d){{return EJSON.stringify(d)}}).join('\\n')",
        db, collection
    );
    mongo_eval(&container, &host, port, &user, &password, &script).map(lines_of)
}

// Runs a free-form mongosh script in the context of `db` (dev tool).
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
    if !is_safe_ident(&db) {
        return Err("nombre de base inválido".into());
    }
    let wrapped = format!("db = db.getSiblingDB('{}'); {}", db, script);
    mongo_eval(&container, &host, port, &user, &password, &wrapped)
}

// Mongo relations (heuristic): *Id/*_id or ObjectId fields that point to
// another collection, guessed by name. References, not enforced FKs.
#[tauri::command]
pub fn db_docker_mongo_refs(
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
    let script = format!(
        r#"var D=db.getSiblingDB('{}');var names=D.getCollectionNames();var out=[];var seen={{}};names.forEach(function(coll){{var docs=D.getCollection(coll).find().limit(20).toArray();docs.forEach(function(doc){{Object.keys(doc).forEach(function(k){{if(k==='_id')return;var key=coll+'|'+k;if(seen[key])return;var v=doc[k];var looksId=/(_id|Id)$/.test(k)||(v instanceof ObjectId);if(!looksId)return;seen[key]=1;var base=k.replace(/(_id|Id)$/,'').toLowerCase();var target='';for(var i=0;i<names.length;i++){{var lc=names[i].toLowerCase();if(lc===base||lc===base+'s'||lc.replace(/s$/,'')===base){{target=names[i];break;}}}}out.push(coll+'\t'+k+'\t'+target);}});}});}});print(out.join('\n'));"#,
        db
    );
    mongo_eval(&container, &host, port, &user, &password, &script).map(parse_mongo_refs)
}

fn parse_mongo_refs(out: String) -> Vec<ForeignKey> {
    out.lines()
        .filter_map(|l| {
            let p: Vec<&str> = l.split('\t').collect();
            if p.len() >= 3 && !p[0].is_empty() && !p[2].is_empty() {
                Some(ForeignKey {
                    table: p[0].into(),
                    column: p[1].into(),
                    ref_table: p[2].into(),
                    ref_column: "_id".into(),
                })
            } else {
                None
            }
        })
        .collect()
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
    if !is_safe_ident(&db) || !is_safe_ident(&collection) {
        return Err("nombre inválido".into());
    }
    let script = format!(
        "var d=EJSON.parse('{}');var id=d._id;delete d._id;db.getSiblingDB('{}').getCollection('{}').replaceOne({{_id:id}},d)",
        mongo_escape(&doc), db, collection
    );
    mongo_eval(&container, &host, port, &user, &password, &script).map(|_| ())
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
    if !is_safe_ident(&db) || !is_safe_ident(&collection) {
        return Err("nombre inválido".into());
    }
    let script = format!(
        "var d=EJSON.parse('{}');db.getSiblingDB('{}').getCollection('{}').deleteOne({{_id:d._id}})",
        mongo_escape(&doc), db, collection
    );
    mongo_eval(&container, &host, port, &user, &password, &script).map(|_| ())
}

// ---------------- PostgreSQL ----------------


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mongo_escape_neutralizes_quotes_and_newlines() {
        assert_eq!(mongo_escape("a'b"), "a\\'b");
        assert_eq!(mongo_escape("a\\b"), "a\\\\b");
        assert_eq!(mongo_escape("a\nb"), "a b");
    }
}
