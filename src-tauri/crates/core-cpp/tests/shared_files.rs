//! `server/runner` keeps byte-identical copies of the validation module and of check.hpp (it is a standalone
//! Cargo project built from its own Docker context, so it can't depend on this crate).

use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn assert_same(ours: &str, theirs: &str) {
    let a = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(ours)).unwrap();
    let path = repo_root().join(theirs);
    let b = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert!(a == b, "{ours} and {theirs} differ: keep them identical");
}

#[test]
fn validation_module_matches_the_runner() {
    assert_same("src/validate.rs", "server/runner/src/validate.rs");
}

#[test]
fn check_header_matches_the_runner() {
    assert_same("check.hpp", "server/runner/check.hpp");
    assert_eq!(core_cpp::CHECK_HPP, include_str!("../check.hpp"));
}
