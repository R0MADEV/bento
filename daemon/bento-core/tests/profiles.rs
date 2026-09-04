//! Los perfiles, contra un fichero de verdad. Cada test con el suyo: la ruta
//! entra por parámetro justo para no tener que mover `HOME`, que es global y
//! pondría a competir a los tests entre ellos.

use bento_core::profiles::{list_in, save_in, Profile};

fn path(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("bento-profiles-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("terminal-profiles.json")
}

fn profile(id: &str, shell: &str) -> Profile {
    Profile {
        id: id.into(),
        name: format!("perfil {id}"),
        shell: shell.into(),
        theme: None,
        font_size: None,
        font_family: None,
    }
}

#[test]
fn saving_and_reading_back_the_profiles() {
    let file = path("ida-y-vuelta");
    save_in(&file, &[profile("uno", "/bin/zsh"), profile("dos", "/bin/bash")]).expect("guardar");

    let saved = list_in(&file);

    assert_eq!(saved.len(), 2);
    assert_eq!(saved[0].shell, "/bin/zsh");
    assert_eq!(saved[1].name, "perfil dos");
}

#[test]
fn no_file_is_no_profiles_rather_than_an_error() {
    assert!(list_in(&path("vacio")).is_empty());
}

#[test]
fn a_corrupt_file_is_no_profiles_either() {
    // El coste de equivocarse es abrir con el shell por defecto; el de reventar,
    // no poder abrir nada.
    let file = path("corrupto");
    std::fs::write(&file, "{no es json").unwrap();

    assert!(list_in(&file).is_empty());
}
