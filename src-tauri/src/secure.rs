//! Guards between the webview and things it must not control directly:
//! - files: only paths the user picked in a native dialog can be read or written;
//! - saved secrets: only released to the endpoint they were saved for;
//! - SSH host keys: the stored fingerprint is authoritative, not the one the UI sends.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::db::types::{ConnectionConfig, PasswordMode, SshConfig};
use crate::store::{self, Store};

/// Paths (files or folders) the user picked in a native dialog during this run.
#[derive(Default)]
pub struct PickedPaths(Mutex<HashSet<PathBuf>>);

impl PickedPaths {
    fn remember(&self, p: &Path) {
        if let Ok(mut set) = self.0.lock() {
            set.insert(normalize(p));
        }
    }

    /// Allowed if the path itself was picked, or it sits directly inside a picked folder.
    pub fn check(&self, path: &str) -> Result<PathBuf, String> {
        let p = PathBuf::from(path);
        if !p.is_absolute() {
            return Err("Refusing a relative path".into());
        }
        let p = normalize(&p);
        let set = self.0.lock().map_err(|_| "internal error")?;
        let parent_ok = p.parent().is_some_and(|d| set.contains(&normalize(d)));
        if set.contains(&p) || parent_ok {
            Ok(p)
        } else {
            Err("This file wasn't chosen in a file dialog, so Querybird won't touch it".into())
        }
    }
}

/// Resolves symlinks in the existing part of the path so `..` or links can't escape a picked folder.
fn normalize(p: &Path) -> PathBuf {
    if let Ok(c) = p.canonicalize() {
        return c;
    }
    match (
        p.parent().and_then(|d| d.canonicalize().ok()),
        p.file_name(),
    ) {
        (Some(dir), Some(name)) => dir.join(name),
        _ => p.to_path_buf(),
    }
}

pub async fn pick<R: Runtime>(
    app: AppHandle<R>,
    picked: &PickedPaths,
    mode: String,
    default_name: Option<String>,
    filter_name: Option<String>,
    extensions: Vec<String>,
) -> Result<Option<String>, String> {
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let mut d = app.dialog().file();
        if let Some(n) = default_name {
            d = d.set_file_name(n);
        }
        if !extensions.is_empty() {
            let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
            d = d.add_filter(filter_name.unwrap_or_else(|| "Files".into()), &exts);
        }
        match mode.as_str() {
            "save" => d.blocking_save_file(),
            "folder" => d.blocking_pick_folder(),
            _ => d.blocking_pick_file(),
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(fp) = chosen else { return Ok(None) };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    picked.remember(&path);
    Ok(Some(path.display().to_string()))
}

fn ssh_endpoint(s: &Option<SshConfig>) -> Option<(String, u16, String, Option<String>)> {
    s.as_ref().filter(|s| s.enabled).map(|s| {
        (
            s.host.clone(),
            s.port,
            s.user.clone(),
            s.key_path.clone().filter(|k| !k.is_empty()),
        )
    })
}

fn same_endpoint(a: &ConnectionConfig, b: &ConnectionConfig) -> bool {
    a.driver == b.driver
        && a.host == b.host
        && a.port == b.port
        && a.user == b.user
        && ssh_endpoint(&a.ssh) == ssh_endpoint(&b.ssh)
}

/// Builds the config to actually connect with, plus the DB password to use.
///
/// Secrets saved in the keychain are only used when the requested endpoint matches the saved
/// connection exactly, so a tampered request can't send a saved password to another host.
/// The saved SSH host key always wins over whatever the UI sent.
pub fn prepare(
    store: &Store,
    mut cfg: ConnectionConfig,
    password: Option<String>,
) -> (ConnectionConfig, Option<String>) {
    let stored = if cfg.id.is_empty() {
        None
    } else {
        store.get(&cfg.id)
    };
    let trusted = stored.as_ref().is_some_and(|s| same_endpoint(s, &cfg));

    if let Some(ssh) = cfg.ssh.as_mut() {
        let saved_key = stored
            .as_ref()
            .and_then(|s| s.ssh.as_ref())
            .filter(|s| s.host == ssh.host && s.port == ssh.port)
            .and_then(|s| s.host_key.clone());
        if stored.is_some() {
            ssh.host_key = saved_key;
        }
        if trusted && ssh.password.is_none() {
            ssh.password = store::get_password(&store::ssh_account(&cfg.id));
        }
    }

    let pw = password.or_else(|| {
        if trusted && cfg.password_mode == PasswordMode::Keychain {
            store::get_password(&cfg.id)
        } else {
            None
        }
    });
    (cfg, pw)
}

/// "Copy as URL" built on the backend so the saved password never passes through the webview.
pub fn connection_url(store: &Store, id: &str, with_password: bool) -> Result<String, String> {
    let c = store.get(id).ok_or("Unknown connection")?;
    let pw = if with_password && c.password_mode == PasswordMode::Keychain {
        store::get_password(id)
    } else {
        None
    };
    let enc = |s: &str| -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect()
    };
    let scheme = match c.driver {
        crate::db::types::Driver::Postgres => "postgresql",
        crate::db::types::Driver::Mysql => "mysql",
        crate::db::types::Driver::Sqlite => return Ok(format!("sqlite://{}", c.database)),
    };
    let auth = if c.user.is_empty() {
        String::new()
    } else {
        format!(
            "{}{}@",
            enc(&c.user),
            pw.map(|p| format!(":{}", enc(&p))).unwrap_or_default()
        )
    };
    let port = if c.port == 0 {
        String::new()
    } else {
        format!(":{}", c.port)
    };
    Ok(format!(
        "{scheme}://{auth}{}{port}/{}",
        c.host,
        enc(&c.database)
    ))
}
