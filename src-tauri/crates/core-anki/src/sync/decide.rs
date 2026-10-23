//! What a sync does after the server's answer (docs/PROJETO.md 9). Pure, so the rules are tested
//! exhaustively: the first sync of the app always downloads, and nothing ever uploads on its own.

use anki::sync::collection::normal::SyncActionRequired;

use super::FullSyncChoice;

/// The next step of [`crate::AnkiService::sync`]. There is deliberately no upload variant: a
/// full upload only happens through [`crate::AnkiService::sync_full`], after the user chose it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Already in sync: only media.
    Nothing,
    /// Incremental sync.
    Normal,
    /// Backup, then replace the local collection with the server's.
    Download,
    /// Stop and let the user choose (full-sync dialog).
    Ask(FullSyncChoice),
}

/// `first_sync`: the first sync of this account in the app. The local collection is then
/// disposable (an imported `.colpkg`), so the server always wins; an empty server is the only case
/// that asks (upload only on an explicit click).
pub fn decide(first_sync: bool, required: SyncActionRequired) -> Action {
    match (first_sync, required) {
        (_, SyncActionRequired::NoChanges) => Action::Nothing,
        (true, SyncActionRequired::NormalSyncRequired) => Action::Download,
        (false, SyncActionRequired::NormalSyncRequired) => Action::Normal,
        (
            true,
            SyncActionRequired::FullSyncRequired {
                download_ok: true, ..
            },
        )
        | (
            false,
            SyncActionRequired::FullSyncRequired {
                upload_ok: false,
                download_ok: true,
            },
        ) => Action::Download,
        (
            _,
            SyncActionRequired::FullSyncRequired {
                upload_ok,
                download_ok,
            },
        ) => Action::Ask(FullSyncChoice {
            upload_ok,
            download_ok,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full(upload_ok: bool, download_ok: bool) -> SyncActionRequired {
        SyncActionRequired::FullSyncRequired {
            upload_ok,
            download_ok,
        }
    }

    fn choice(upload_ok: bool, download_ok: bool) -> Action {
        Action::Ask(FullSyncChoice {
            upload_ok,
            download_ok,
        })
    }

    #[test]
    fn decision_table() {
        use SyncActionRequired::{NoChanges, NormalSyncRequired};
        let table = [
            // First sync: the server always wins.
            (true, NoChanges, Action::Nothing),
            (true, NormalSyncRequired, Action::Download),
            (true, full(true, true), Action::Download),
            (true, full(false, true), Action::Download),
            // Empty server, local has cards: ask, offering only the upload.
            (true, full(true, false), choice(true, false)),
            (true, full(false, false), choice(false, false)),
            // Later syncs.
            (false, NoChanges, Action::Nothing),
            (false, NormalSyncRequired, Action::Normal),
            // Local empty: nothing to lose, download (rslib desktop does the same).
            (false, full(false, true), Action::Download),
            (false, full(true, true), choice(true, true)),
            (false, full(true, false), choice(true, false)),
            (false, full(false, false), choice(false, false)),
        ];
        for (first, required, expected) in table {
            assert_eq!(decide(first, required), expected, "{first} {required:?}");
        }
    }

    #[test]
    fn never_uploads_automatically_and_first_sync_never_keeps_local_changes() {
        let mut inputs = vec![
            SyncActionRequired::NoChanges,
            SyncActionRequired::NormalSyncRequired,
        ];
        for u in [false, true] {
            for d in [false, true] {
                inputs.push(full(u, d));
            }
        }
        for first in [false, true] {
            for required in &inputs {
                let action = decide(first, *required);
                // The only automatic full sync is a download, and only when it is allowed.
                if action == Action::Download {
                    assert!(
                        !matches!(
                            required,
                            SyncActionRequired::FullSyncRequired {
                                download_ok: false,
                                ..
                            }
                        ),
                        "{first} {required:?}"
                    );
                }
                if first {
                    assert_ne!(
                        action,
                        Action::Normal,
                        "first sync never merges local changes"
                    );
                }
            }
        }
    }
}
