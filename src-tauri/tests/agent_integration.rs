use std::process::Command;

#[test]
fn fake_cli_emits_stream_json_protocol() {
    let output = Command::new(env!("CARGO_BIN_EXE_fake_cli"))
        .output()
        .expect("fake cli should launch");
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("fake-session"));
    assert!(stdout.contains("fake response"));
}

#[test]
fn fake_cli_reports_process_failure() {
    let output = Command::new(env!("CARGO_BIN_EXE_fake_cli"))
        .env("FAKE_CLI_FAIL", "1")
        .output()
        .expect("fake cli should launch");
    assert_eq!(output.status.code(), Some(7));
}
