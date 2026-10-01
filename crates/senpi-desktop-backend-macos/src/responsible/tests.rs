use super::*;

#[test]
fn resolves_self_without_replacing_it_with_the_parent() {
    let identity = resolve_with(
        41,
        Some,
        |pid| { assert_eq!(pid, 41); Some(PathBuf::from("/tmp/engine")) },
        |_| None,
    ).unwrap();
    assert_eq!(identity.pid, 41);
    assert_eq!(identity.executable, Path::new("/tmp/engine"));
    assert!(identity.bundle_id.is_none());
}

#[test]
fn resolves_app_path_and_bundle_using_the_responsible_pid() {
    let identity = resolve_with(
        41,
        |_| Some(42),
        |pid| {
            assert_eq!(pid, 42);
            Some(PathBuf::from("/Applications/QA.app/Contents/MacOS/QA"))
        },
        |path| {
            assert_eq!(path, Path::new("/Applications/QA.app/Contents/MacOS/QA"));
            Some("org.example.qa".to_owned())
        },
    ).unwrap();
    assert_eq!(identity.pid, 42);
    assert_eq!(identity.bundle_id.as_deref(), Some("org.example.qa"));
}

#[test]
fn unresolved_responsibility_does_not_guess_a_path() {
    assert!(resolve_with(41, |_| None, |_| panic!("path lookup"), |_| panic!("bundle lookup")).is_none());
}

#[test]
fn unresolved_path_does_not_guess_an_identity() {
    assert!(resolve_with(41, |_| Some(42), |_| None, |_| panic!("bundle lookup")).is_none());
}

fn app_with_info_plist(identifier_entry: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let contents = dir.path().join("QA.app/Contents");
    std::fs::create_dir_all(contents.join("MacOS")).unwrap();
    std::fs::write(contents.join("Info.plist"), format!(
        r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key>{identifier_entry}</dict></plist>"#
    )).unwrap();
    let executable = contents.join("MacOS/QA");
    (dir, executable)
}

#[test]
fn reads_bundle_identifier_from_a_real_plist() {
    let (_dir, executable) = app_with_info_plist("<string>org.example.qa</string>");
    assert_eq!(bundle_id(&executable).as_deref(), Some("org.example.qa"));
}

#[test]
fn oversized_bundle_identifier_is_not_reported() {
    let (_dir, executable) = app_with_info_plist(&format!("<string>{}</string>", "a".repeat(1024 * 1024)));
    assert!(bundle_id(&executable).is_none());
}

#[test]
fn non_string_bundle_identifier_is_not_reported() {
    let (_dir, executable) = app_with_info_plist("<integer>42</integer>");
    assert!(bundle_id(&executable).is_none());
}

#[test]
fn oversized_info_plist_is_not_read() {
    let (_dir, executable) = app_with_info_plist(&format!("<string>org.example.qa</string><key>Pad</key><string>{}</string>", "p".repeat(1024 * 1024 + 1)));
    assert!(bundle_id(&executable).is_none());
}

#[test]
fn bundle_identifier_rejects_characters_outside_reverse_dns() {
    assert!(valid_bundle_id("org.example.qa-1_x"));
    assert!(!valid_bundle_id(""));
    assert!(!valid_bundle_id("org.example qa"));
    assert!(!valid_bundle_id("org\nexample"));
    assert!(!valid_bundle_id(&"a".repeat(256)));
}

#[test]
fn non_app_and_missing_plist_have_no_bundle_identifier() {
    assert!(bundle_id(Path::new("/tmp/engine")).is_none());
    let dir = tempfile::tempdir().unwrap();
    assert!(bundle_id(&dir.path().join("QA.app/Contents/MacOS/QA")).is_none());
}
