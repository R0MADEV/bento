use super::safe_prefix;

#[test]
fn safe_prefix_never_splits_utf8() {
    assert_eq!(safe_prefix("aé", 2), "a");
    assert_eq!(safe_prefix("aé", 3), "aé");
}
