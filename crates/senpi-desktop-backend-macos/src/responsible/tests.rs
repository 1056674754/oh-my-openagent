use super::*;

#[test]
fn resolves_self_without_replacing_it_with_the_parent() {
    let identity = resolve_with(
        41,
        |pid| Some(pid),
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

#[test]
fn reads_bundle_identifier_from_a_real_plist() {
    let dir = tempfile::tempdir().unwrap();
    let contents = dir.path().join("QA.app/Contents");
    std::fs::create_dir_all(contents.join("MacOS")).unwrap();
    std::fs::write(contents.join("Info.plist"),
        r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.example.qa</string></dict></plist>"#
    ).unwrap();
    assert_eq!(bundle_id(&contents.join("MacOS/QA")).as_deref(), Some("org.example.qa"));
}

#[test]
fn non_app_and_missing_plist_have_no_bundle_identifier() {
    assert!(bundle_id(Path::new("/tmp/engine")).is_none());
    let dir = tempfile::tempdir().unwrap();
    assert!(bundle_id(&dir.path().join("QA.app/Contents/MacOS/QA")).is_none());
}
