//! Las conversaciones de un PR: las que GitHub sabe dar por resueltas.
//!
//! Resolver es cosa suya —hay una marca por hilo que ve todo el equipo—, no
//! una nota que cada cliente se guarde por su cuenta. Y va por GraphQL, que es
//! por donde se resuelven: la API REST de comentarios no tiene esa marca.

use serde_json::Value;

use crate::vcs::gh_cmd;

/// Los hilos de review de un PR, tal y como los da GitHub: con su id, si están
/// resueltos y sobre qué línea. Resolver de verdad es cosa suya —hay una marca
/// por hilo que ve todo el equipo—, no una nota local de cada cliente.
pub fn review_threads(cwd: &str, pr: u64) -> Result<Value, String> {
    let (owner, name) = owner_and_repo(cwd)?;
    let query = "query($owner:String!,$name:String!,$pr:Int!){\
        repository(owner:$owner,name:$name){pullRequest(number:$pr){\
        reviewThreads(first:100){nodes{id isResolved path line \
        comments(first:100){nodes{databaseId}}}}}}}";
    let out = gh_cmd(cwd, &[
        "api", "graphql", "-f", &format!("query={query}"),
        "-F", &format!("owner={owner}"), "-F", &format!("name={name}"),
        "-F", &format!("pr={pr}"),
        "--jq", ".data.repository.pullRequest.reviewThreads.nodes",
    ])?;
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

/// Marca un hilo como resuelto, o lo reabre.
pub fn set_thread_resolved(cwd: &str, thread: &str, resolved: bool) -> Result<(), String> {
    if !is_thread_id(thread) {
        return Err(format!("id de hilo no válido: {thread}"));
    }
    let field = match resolved {
        true => "resolveReviewThread",
        false => "unresolveReviewThread",
    };
    let query = format!(
        "mutation($id:ID!){{{field}(input:{{threadId:$id}}){{thread{{id isResolved}}}}}}"
    );
    gh_cmd(cwd, &["api", "graphql", "-f", &format!("query={query}"), "-F", &format!("id={thread}")])
        .map(|_| ())
}

/// El id de un hilo es opaco y sólo viaja de vuelta: se comprueba antes de
/// meterlo en una consulta, como con las ramas.
fn is_thread_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-')
}

/// El `owner` y el `name` del repositorio, que GraphQL pide por separado —el
/// `{owner}/{repo}` que sustituye `gh api` sólo vale en las rutas REST.
fn owner_and_repo(cwd: &str) -> Result<(String, String), String> {
    let raw = gh_cmd(cwd, &["repo", "view", "--json", "owner,name", "--jq", ".owner.login + \"/\" + .name"])?;
    raw.trim()
        .split_once('/')
        .map(|(owner, name)| (owner.to_string(), name.to_string()))
        .ok_or_else(|| format!("no se pudo leer el repositorio: {raw}"))
}

/// El hilo al que pertenece un comentario, por el id que ya conocen los
/// clientes: GitHub resuelve hilos, no comentarios sueltos.
pub fn thread_of(threads: &Value, comment: u64) -> Option<String> {
    threads.as_array()?.iter().find_map(|thread| {
        let has = thread
            .get("comments")?
            .get("nodes")?
            .as_array()?
            .iter()
            .any(|c| c.get("databaseId").and_then(Value::as_u64) == Some(comment));
        has.then(|| thread.get("id")?.as_str().map(str::to_string))?
    })
}


#[cfg(test)]
mod tests {
    #[test]
    fn a_comment_leads_to_the_thread_it_belongs_to() {
        // GitHub resuelve hilos, no comentarios sueltos, y los clientes sólo
        // conocen el id del comentario.
        let threads = serde_json::json!([
            {"id": "PRRT_uno", "comments": {"nodes": [{"databaseId": 1}, {"databaseId": 2}]}},
            {"id": "PRRT_dos", "comments": {"nodes": [{"databaseId": 7}]}},
        ]);

        assert_eq!(super::thread_of(&threads, 7).as_deref(), Some("PRRT_dos"));
        assert_eq!(super::thread_of(&threads, 2).as_deref(), Some("PRRT_uno"), "también los de respuesta");
        assert_eq!(super::thread_of(&threads, 99), None);
    }

    #[test]
    fn a_thread_id_that_is_not_one_never_reaches_the_query() {
        assert!(super::is_thread_id("PRRT_kwDOTDL-abc123"));
        assert!(!super::is_thread_id(""));
        assert!(!super::is_thread_id("x\"}) { evil"));
    }
}
