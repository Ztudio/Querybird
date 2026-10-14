//! Saved connections live in a JSON file in the app config dir.
//! Passwords never touch that file: they go to the OS keychain.

use std::path::PathBuf;

use crate::db::types::{ConnectionConfig, PasswordMode};

const KEYRING_SERVICE: &str = "dev.querybird.app";
/// Keychain services used under earlier names (NQL, Rowboat); read once and migrated.
const LEGACY_KEYRING_SERVICES: &[&str] = &["dev.nql.app", "dev.rowboat.app"];

pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Store {
        let _ = std::fs::create_dir_all(&dir);
        Store {
            path: dir.join("connections.json"),
        }
    }

    pub fn list(&self) -> Vec<ConnectionConfig> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn get(&self, id: &str) -> Option<ConnectionConfig> {
        self.list().into_iter().find(|c| c.id == id)
    }

    fn write(&self, list: &[ConnectionConfig]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, json).map_err(|e| e.to_string())
    }

    pub fn save(
        &self,
        mut cfg: ConnectionConfig,
        password: Option<String>,
    ) -> Result<ConnectionConfig, String> {
        if cfg.id.is_empty() {
            cfg.id = uuid::Uuid::new_v4().to_string();
        }
        // The SSH password / key passphrase lives in the keychain, never in the JSON file.
        if let Some(ssh) = cfg.ssh.as_mut() {
            if let Some(pw) = ssh.password.take() {
                set_password(&ssh_account(&cfg.id), &pw)?;
            }
        }
        let mut list = self.list();
        match list.iter_mut().find(|c| c.id == cfg.id) {
            Some(existing) => *existing = cfg.clone(),
            None => list.push(cfg.clone()),
        }
        self.write(&list)?;
        match cfg.password_mode {
            PasswordMode::Keychain => {
                if let Some(pw) = password {
                    set_password(&cfg.id, &pw)?;
                }
            }
            PasswordMode::Ask => delete_password(&cfg.id),
        }
        Ok(cfg)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let list: Vec<_> = self.list().into_iter().filter(|c| c.id != id).collect();
        self.write(&list)?;
        delete_password(id);
        delete_password(&ssh_account(id));
        Ok(())
    }

    /// Records the SSH host key seen on first connect (trust on first use).
    pub fn remember_host_key(&self, id: &str, fingerprint: &str) {
        let mut list = self.list();
        if let Some(c) = list.iter_mut().find(|c| c.id == id) {
            if let Some(ssh) = c.ssh.as_mut() {
                if ssh.host_key.as_deref().is_none_or(str::is_empty) {
                    ssh.host_key = Some(fingerprint.to_string());
                    let _ = self.write(&list);
                }
            }
        }
    }

    pub fn rename_group(&self, from: &str, to: &str) -> Result<(), String> {
        let mut list = self.list();
        for c in list.iter_mut().filter(|c| c.group == from) {
            c.group = to.to_string();
        }
        self.write(&list)
    }
}

pub fn ssh_account(id: &str) -> String {
    format!("{id}:ssh")
}

fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| e.to_string())
}

pub fn get_password(id: &str) -> Option<String> {
    if let Some(pw) = entry(id).ok()?.get_password().ok() {
        return Some(pw);
    }
    // Migrate a secret saved under an earlier app name.
    for service in LEGACY_KEYRING_SERVICES {
        let Ok(legacy) = keyring::Entry::new(service, id) else {
            continue;
        };
        if let Ok(pw) = legacy.get_password() {
            if set_password(id, &pw).is_ok() {
                let _ = legacy.delete_credential();
            }
            return Some(pw);
        }
    }
    None
}

pub fn set_password(id: &str, pw: &str) -> Result<(), String> {
    let e = entry(id)?;
    if pw.is_empty() {
        let _ = e.delete_credential();
        return Ok(());
    }
    e.set_password(pw)
        .map_err(|e| format!("could not save password to keychain: {e}"))
}

pub fn delete_password(id: &str) {
    if let Ok(e) = entry(id) {
        let _ = e.delete_credential();
    }
}
