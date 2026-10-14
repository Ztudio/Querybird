//! SSH tunnel: listens on 127.0.0.1:<random> and forwards each accepted socket
//! through a `direct-tcpip` channel to the database host as seen from the SSH server.

use std::sync::{Arc, Mutex};

use russh::client;
use russh::keys::{
    load_secret_key, ssh_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate,
};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use super::types::SshConfig;

struct Handler {
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Host certificates are pinned by the key they certify, like plain host keys.
        let fp = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => {
                key.fingerprint(HashAlg::Sha256).to_string()
            }
            PublicKeyOrCertificate::Certificate(cert) => {
                ssh_key::Fingerprint::new(HashAlg::Sha256, cert.public_key()).to_string()
            }
        };
        *self.seen.lock().unwrap() = Some(fp.clone());
        // Trust on first use; afterwards the saved fingerprint must match.
        Ok(self
            .expected
            .as_deref()
            .is_none_or(|e| e.is_empty() || e == fp))
    }
}

pub struct Tunnel {
    pub local_port: u16,
    /// SHA256 fingerprint of the SSH server's host key.
    pub fingerprint: String,
    task: JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn open(ssh: &SshConfig, target_host: &str, target_port: u16) -> Result<Tunnel, String> {
    let seen = Arc::new(Mutex::new(None));
    let handler = Handler {
        expected: ssh.host_key.clone(),
        seen: seen.clone(),
    };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    });
    let port = if ssh.port == 0 { 22 } else { ssh.port };
    let connect = client::connect(config, (ssh.host.as_str(), port), handler);
    let mut session = match tokio::time::timeout(std::time::Duration::from_secs(10), connect).await
    {
        Err(_) => return Err("SSH connection timed out".into()),
        Ok(Err(e)) => {
            if let Some(fp) = seen.lock().unwrap().clone() {
                if ssh
                    .host_key
                    .as_deref()
                    .is_some_and(|k| !k.is_empty() && k != fp)
                {
                    return Err(format!(
                        "SSH host key for {} changed!\nExpected {}\nGot      {}\nIf this is expected, clear the saved host key in the connection settings.",
                        ssh.host,
                        ssh.host_key.clone().unwrap_or_default(),
                        fp
                    ));
                }
            }
            return Err(format!("SSH: {e}"));
        }
        Ok(Ok(s)) => s,
    };

    let user = if ssh.user.is_empty() {
        "root".to_string()
    } else {
        ssh.user.clone()
    };
    let auth = if let Some(path) = ssh.key_path.as_deref().filter(|p| !p.is_empty()) {
        let path = expand_home(path);
        let key = load_secret_key(&path, ssh.password.as_deref().filter(|p| !p.is_empty()))
            .map_err(|e| format!("SSH key {path}: {e}"))?;
        let hash = session
            .best_supported_rsa_hash()
            .await
            .map_err(|e| e.to_string())?
            .flatten();
        session
            .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
    } else {
        session
            .authenticate_password(user, ssh.password.clone().unwrap_or_default())
            .await
    }
    .map_err(|e| format!("SSH authentication: {e}"))?;
    if !auth.success() {
        return Err("SSH authentication failed (check user, password or key)".into());
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let session = Arc::new(session);
    let host = target_host.to_string();
    // The local end only needs to serve Querybird's own connection (plus one retry, e.g. MySQL's
    // TLS→plain fallback), so stop accepting after that: other local processes can't ride the tunnel.
    let task = tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
        for _ in 0..2 {
            let accepted = tokio::time::timeout_at(deadline, listener.accept()).await;
            let Ok(Ok((mut socket, peer))) = accepted else {
                break;
            };
            let session = session.clone();
            let host = host.clone();
            tokio::spawn(async move {
                let Ok(channel) = session
                    .channel_open_direct_tcpip(
                        host,
                        target_port as u32,
                        peer.ip().to_string(),
                        peer.port() as u32,
                    )
                    .await
                else {
                    return;
                };
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            });
        }
        // Keep the SSH session alive for the forwarded connections.
        std::future::pending::<()>().await;
    });
    let fingerprint = seen.lock().unwrap().clone().unwrap_or_default();
    Ok(Tunnel {
        local_port,
        fingerprint,
        task,
    })
}

fn expand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return format!("{}/{}", home.to_string_lossy(), rest);
        }
    }
    p.to_string()
}
