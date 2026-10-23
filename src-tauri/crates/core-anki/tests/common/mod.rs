//! Shared helpers for the core-anki integration tests: the fixture collection (built in code,
//! docs/PROJETO.md 20) opened through an `AnkiService`.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use core_anki::fixture::{self, FixtureInfo, FixtureOptions};
use core_anki::{AnkiService, Collection};
use tempfile::TempDir;

pub struct Fixture {
    pub tmp: TempDir,
    pub svc: AnkiService,
    pub info: FixtureInfo,
}

impl Fixture {
    pub fn dir(&self) -> PathBuf {
        self.tmp.path().join("anki")
    }
}

/// Builds the fixture in a fresh temp dir and opens it.
pub fn fixture() -> anyhow::Result<Fixture> {
    fixture_with(FixtureOptions::default())
}

pub fn fixture_with(opts: FixtureOptions) -> anyhow::Result<Fixture> {
    let tmp = tempfile::tempdir()?;
    let dir = tmp.path().join("anki");
    let info = fixture::build(&dir, opts)?;
    let svc = AnkiService::open(&dir)?;
    Ok(Fixture { tmp, svc, info })
}

/// Opens an empty collection in `dir`.
pub fn empty(dir: &Path) -> anyhow::Result<AnkiService> {
    Ok(AnkiService::open(dir)?)
}

/// Single-value SQL query (test-only escape hatch).
pub fn sql_i64(col: &mut Collection, sql: &str) -> core_anki::Result<i64> {
    Ok(col
        .storage
        .db()
        .query_row(sql, [], |r| r.get(0))
        .map_err(core_anki::anki::prelude::AnkiError::from)?)
}

/// Sorted full names of every deck except Default.
pub fn deck_names(col: &mut Collection) -> core_anki::Result<Vec<String>> {
    Ok(core_anki::decks::names(col)?
        .into_iter()
        .filter(|d| d.id != 1)
        .map(|d| d.name)
        .collect())
}
