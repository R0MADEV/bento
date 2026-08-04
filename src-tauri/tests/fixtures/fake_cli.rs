fn main() {
    if std::env::var("FAKE_CLI_FAIL").is_ok() {
        eprintln!("fake cli failure");
        std::process::exit(7);
    }
    println!(r#"{{"type":"system","session_id":"fake-session"}}"#);
    println!(
        r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"fake response"}}]}}}}"#
    );
    println!(r#"{{"type":"result","is_error":false}}"#);
}
