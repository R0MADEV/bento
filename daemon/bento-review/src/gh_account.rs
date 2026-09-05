//! Con qué cuenta de GitHub hablar en cada proyecto.
//!
//! `gh` tiene una cuenta activa y es global: no cambia con la carpeta, aunque
//! git sí lo haga. En un repositorio de otra organización eso responde "no
//! existe" —GitHub no distingue entre lo que no hay y lo que no ves—, y no hay
//! PRs que revisar hasta que cambias de cuenta a mano.
//!
//! Aquí se prueban las cuentas que `gh` ya tiene guardadas y se recuerda la que
//! sirve para ese repositorio. El token nunca se guarda: se le pide a `gh` en
//! el momento y viaja sólo en el entorno del proceso hijo.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Lo que dice GitHub cuando el repositorio no existe o no lo ve la cuenta con
/// la que se ha preguntado. Es lo mismo a propósito: enseñar cuáles hay
/// privados sería filtrarlos.
pub(crate) fn is_not_visible(error: &str) -> bool {
    error.contains("Could not resolve to a Repository")
}

/// Las cuentas que `gh auth status` enumera, la activa primero: si la activa
/// funciona no hay nada que probar.
pub(crate) fn accounts_in(status: &str) -> Vec<String> {
    let mut accounts = Vec::new();
    let mut active = None;
    for line in status.lines() {
        if let Some(name) = line.split("Logged in to").nth(1).and_then(account_name) {
            accounts.push(name);
            continue;
        }
        // "Active account: true" viene justo debajo de la suya.
        if line.contains("Active account: true") {
            active = accounts.last().cloned();
        }
    }
    if let Some(active) = active {
        accounts.retain(|a| *a != active);
        accounts.insert(0, active);
    }
    accounts
}

fn account_name(rest: &str) -> Option<String> {
    rest.split("account ").nth(1)?.split_whitespace().next().map(str::to_string)
}

/// Las que quedan por probar: todas menos la que acaba de fallar. Con una
/// sola cuenta —lo normal— eso es ninguna, y no se hace ni una llamada más.
pub(crate) fn others(accounts: &[String], failed: &str) -> Vec<String> {
    accounts.iter().filter(|a| *a != failed).cloned().collect()
}

/// La cuenta que ya se sabe que funciona en este proyecto.
pub(crate) fn remembered(cwd: &str) -> Option<String> {
    known().lock().ok()?.get(cwd).cloned()
}

/// La recuerda, para que las demás llamadas de ese proyecto —el diff del PR,
/// los comentarios, la review— vayan con la misma sin volver a buscarla.
pub(crate) fn remember(cwd: &str, account: &str) {
    if let Ok(mut map) = known().lock() {
        map.insert(cwd.to_string(), account.to_string());
    }
}

fn known() -> &'static Mutex<HashMap<String, String>> {
    static KNOWN: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    KNOWN.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_active_account_is_tried_first() {
        // Probar por orden de listado empezaría por la que ya ha fallado.
        let status = "github.com\n  ✓ Logged in to github.com account R0MADEV (keyring)\n  - Active account: false\n  ✓ Logged in to github.com account R0MANDEV (keyring)\n  - Active account: true\n";

        assert_eq!(super::accounts_in(status), vec!["R0MANDEV", "R0MADEV"]);
    }

    #[test]
    fn every_logged_in_account_is_listed() {
        let status = "  ✓ Logged in to github.com account uno (keyring)\n  ✓ Logged in to github.com account dos (keyring)\n";

        assert_eq!(super::accounts_in(status), vec!["uno", "dos"]);
    }

    #[test]
    fn nothing_logged_in_is_no_accounts() {
        assert!(super::accounts_in("You are not logged into any GitHub hosts").is_empty());
    }

    #[test]
    fn only_the_not_visible_error_is_worth_retrying_with_another_account() {
        // Reintentar con otra cuenta un error que no es de acceso sólo suma
        // llamadas y confunde el mensaje final.
        assert!(super::is_not_visible("GraphQL: Could not resolve to a Repository with the name 'x/y'."));
        assert!(!super::is_not_visible("gh: command not found"));
        assert!(!super::is_not_visible("fatal: not a git repository"));
    }

    #[test]
    fn the_account_that_already_failed_is_not_tried_again() {
        // Con una sola cuenta —lo normal— no hay nada que probar: repetirla
        // es una llamada de más en cada pulsación, y el resultado ya se sabe.
        let one = vec!["R0MADEV".to_string()];
        assert!(super::others(&one, "R0MADEV").is_empty());

        let two = vec!["R0MADEV".to_string(), "R0MANDEV".to_string()];
        assert_eq!(super::others(&two, "R0MADEV"), vec!["R0MANDEV"]);
    }

    #[test]
    fn what_worked_for_a_project_is_remembered_for_the_next_call() {
        super::remember("/tmp/proyecto-x", "R0MANDEV");

        assert_eq!(super::remembered("/tmp/proyecto-x").as_deref(), Some("R0MANDEV"));
        assert_eq!(super::remembered("/tmp/otro"), None);
    }
}
