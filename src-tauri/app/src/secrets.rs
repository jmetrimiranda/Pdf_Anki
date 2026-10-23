//! Secrets (spec 18): the Anki sync key (hkey) lives in the system keychain, never in a file or
//! in SQLite. [`KeyringStore`] is the real one (Secret Service on Linux, Credential Manager on
//! Windows, Keychain on macOS/iOS); [`MemoryStore`] is for tests and for debug runs without a
//! keychain (`LEITOR_SECRET_STORE=memory`, debug builds only).
//!
//! There is no fallback: when the keychain is unavailable the secret is simply not kept and the
//! user is told so.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::error::AppError;
use crate::state::lock;

/// Keychain service name: the Tauri identifier.
pub const KEYCHAIN_SERVICE: &str = "dev.jmetri.leitor-estudos";
/// Debug builds: `memory` keeps secrets in memory only (real-app captures without a keyring).
pub const SECRET_STORE_ENV: &str = "LEITOR_SECRET_STORE";

/// Where secrets go. `account` is a stable, non-secret id (see [`sync_account`]).
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, AppError>;
    fn set(&self, account: &str, secret: &str) -> Result<(), AppError>;
    /// Deleting a missing entry is not an error.
    fn delete(&self, account: &str) -> Result<(), AppError>;
}

/// Keychain account of the sync key of `user` at `endpoint` (the normalised URL).
pub fn sync_account(user: &str, endpoint: &str) -> String {
    format!("anki-sync:{user}@{endpoint}")
}

/// The keychain error every caller shows (the details go to the log only).
pub fn keychain_unavailable(detail: impl std::fmt::Display) -> AppError {
    tracing::warn!(%detail, "system keychain unavailable");
    AppError::new(
        "keychain_unavailable",
        "O chaveiro do sistema não está disponível; a chave de sincronização não foi guardada.",
    )
}

/// The system keychain through the `keyring` crate.
#[derive(Debug, Default)]
pub struct KeyringStore;

#[cfg(any(target_os = "linux", windows, target_os = "macos", target_os = "ios"))]
impl KeyringStore {
    fn entry(account: &str) -> Result<keyring::Entry, AppError> {
        keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(keychain_unavailable)
    }
}

#[cfg(any(target_os = "linux", windows, target_os = "macos", target_os = "ios"))]
impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<String>, AppError> {
        match Self::entry(account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_unavailable(e)),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), AppError> {
        Self::entry(account)?
            .set_password(secret)
            .map_err(keychain_unavailable)
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_unavailable(e)),
        }
    }
}

/// Platforms without a supported keychain: nothing is ever stored.
#[cfg(not(any(target_os = "linux", windows, target_os = "macos", target_os = "ios")))]
impl SecretStore for KeyringStore {
    fn get(&self, _account: &str) -> Result<Option<String>, AppError> {
        Ok(None)
    }

    fn set(&self, _account: &str, _secret: &str) -> Result<(), AppError> {
        Err(keychain_unavailable("no keychain on this platform"))
    }

    fn delete(&self, _account: &str) -> Result<(), AppError> {
        Ok(())
    }
}

/// In-memory secrets (tests; debug runs with `LEITOR_SECRET_STORE=memory`).
#[derive(Debug, Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<String, String>>,
}

impl MemoryStore {
    /// Every stored account (tests).
    pub fn accounts(&self) -> Vec<String> {
        let mut out: Vec<String> = lock(&self.entries).keys().cloned().collect();
        out.sort();
        out
    }
}

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, AppError> {
        Ok(lock(&self.entries).get(account).cloned())
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), AppError> {
        lock(&self.entries).insert(account.to_owned(), secret.to_owned());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        lock(&self.entries).remove(account);
        Ok(())
    }
}

/// The store the app uses: the system keychain, or memory in a debug build with
/// `LEITOR_SECRET_STORE=memory`.
pub fn default_store() -> Arc<dyn SecretStore> {
    if cfg!(debug_assertions)
        && std::env::var(SECRET_STORE_ENV).is_ok_and(|v| v.eq_ignore_ascii_case("memory"))
    {
        tracing::warn!("secrets kept in memory only ({SECRET_STORE_ENV}=memory)");
        return Arc::new(MemoryStore::default());
    }
    Arc::new(KeyringStore)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrip() {
        let store = MemoryStore::default();
        let account = sync_account("test", "http://ankisync:8080/");
        assert_eq!(account, "anki-sync:test@http://ankisync:8080/");
        assert_eq!(store.get(&account).unwrap(), None);
        store.set(&account, "k1").unwrap();
        store.set(&account, "k2").unwrap();
        assert_eq!(store.get(&account).unwrap().as_deref(), Some("k2"));
        assert_eq!(store.accounts(), vec![account.clone()]);
        store.delete(&account).unwrap();
        store.delete(&account).unwrap();
        assert_eq!(store.get(&account).unwrap(), None);
    }

    #[test]
    fn keychain_error_is_pt_br() {
        let e = keychain_unavailable("dbus down");
        assert_eq!(e.code, "keychain_unavailable");
        assert!(e.message.contains("chaveiro"));
        assert!(!e.message.contains("dbus"));
    }
}
