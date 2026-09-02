//! Los perfiles, contra el fichero de verdad. Su propio binario de test para
//! poder mover `HOME` sin pisar a nadie: `profiles` lo lee al llamarlo.

use bento_core::profiles::{list, save, shell_of, Profile};

fn home() {
    let dir = std::env::temp_dir().join(format!("bento-profiles-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::env::set_var("HOME", &dir);
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
    home();
    save(&[profile("uno", "/bin/zsh"), profile("dos", "/bin/bash")]).expect("guardar");

    let saved = list();

    assert_eq!(saved.len(), 2);
    assert_eq!(saved[0].shell, "/bin/zsh");
    assert_eq!(saved[1].name, "perfil dos");
}

#[test]
fn the_shell_comes_from_the_id_and_only_from_a_saved_one() {
    home();
    save(&[profile("uno", "/bin/zsh")]).expect("guardar");

    assert_eq!(shell_of("uno").as_deref(), Some("/bin/zsh"));
    // Que el cliente mande el id y no el shell es lo que impide pedir por HTTP
    // la ejecución de cualquier cosa.
    assert_eq!(shell_of("inventado"), None);
}

#[test]
fn no_file_is_no_profiles_rather_than_an_error() {
    let dir = std::env::temp_dir().join(format!("bento-profiles-vacio-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::env::set_var("HOME", &dir);

    assert!(list().is_empty());
}
