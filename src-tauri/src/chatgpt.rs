//! "Sign in with ChatGPT" — ChatGPT plan usage for open-source apps.
//!
//! Implements OpenAI's documented flow (developers.openai.com/siwc/token-sharing-open-source):
//! browser OAuth (authorization code + PKCE) on a 127.0.0.1 loopback, dynamic client
//! registration via `client_id=dynamic_agent_client`, ID-token validation against OpenAI's
//! JWKS, rotating refresh tokens, revocation on sign-out, and streaming Responses API calls
//! with `store: false`. Tokens live in the OS keychain; the client/host ids are not secret.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::store;

const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
const DISCOVERY_URL: &str = "https://auth.openai.com/.well-known/openid-configuration";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
const CALLBACK_PATH: &str = "/auth/callback";
const PREFERRED_PORT: u16 = 1455;
const KEYCHAIN_ACCOUNT: &str = "ai:chatgpt";
pub const MANAGE_USAGE_URL: &str = "https://chatgpt.com/settings/usage";

/// Serializes refreshes, sign-in and sign-out so nothing races a rotating refresh token.
static REFRESH_LOCK: Mutex<()> = Mutex::const_new(());

/// The short-lived access token is kept in memory only: (token, expires_at).
static ACCESS: std::sync::Mutex<Option<(String, u64)>> = std::sync::Mutex::new(None);

/// Non-secret registration state, kept in the app config dir.
#[derive(Serialize, Deserialize, Default, Clone)]
struct Registration {
    /// Stable opaque host id (`urn:uuid:…`), generated once per installation.
    host_id: String,
    /// Issued `oaiapp_…` client id, reused for later sign-ins to the same account.
    client_id: Option<String>,
    email: Option<String>,
    /// Whether the "You're using your ChatGPT plan" notice has been shown.
    welcomed: bool,
}

/// Long-lived part of the session, kept in the OS keychain. The access token is not stored here
/// (it's ~2 KB and Windows Credential Manager caps entries at 2560 bytes); it lives in memory.
#[derive(Serialize, Deserialize, Clone)]
struct Tokens {
    refresh_token: String,
    scopes: String,
    subject: String,
    email: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptStatus {
    pub signed_in: bool,
    pub email: Option<String>,
    pub plan_usage: bool,
    pub show_welcome: bool,
}

#[derive(Serialize)]
pub struct ModelOption {
    pub id: String,
    pub label: String,
}

fn reg_path(dir: &PathBuf) -> PathBuf {
    dir.join("chatgpt.json")
}

fn load_reg(dir: &PathBuf) -> Registration {
    let mut r: Registration = std::fs::read_to_string(reg_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if r.host_id.is_empty() {
        r.host_id = format!("urn:uuid:{}", uuid::Uuid::new_v4());
        save_reg(dir, &r);
    }
    r
}

fn save_reg(dir: &PathBuf, r: &Registration) {
    if let Ok(json) = serde_json::to_string_pretty(r) {
        let path = reg_path(dir);
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, json).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
            }
            let _ = std::fs::rename(tmp, path);
        }
    }
}

fn load_tokens() -> Option<Tokens> {
    serde_json::from_str(&store::get_password(KEYCHAIN_ACCOUNT)?).ok()
}

fn save_tokens(t: &Tokens) -> Result<(), String> {
    let json = serde_json::to_string(t).map_err(|e| e.to_string())?;
    if cfg!(windows) && json.len() > 1200 {
        return Err(
            "The ChatGPT session token is too large for Windows Credential Manager.".into(),
        );
    }
    store::set_password(KEYCHAIN_ACCOUNT, &json)
}

fn set_access(token: String, expires_in: u64) {
    if let Ok(mut a) = ACCESS.lock() {
        *a = Some((token, now() + expires_in));
    }
}

fn clear_session() {
    store::delete_password(KEYCHAIN_ACCOUNT);
    if let Ok(mut a) = ACCESS.lock() {
        *a = None;
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_b64(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::fill(&mut b[..]);
    URL_SAFE_NO_PAD.encode(b)
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .expect("http client")
}

pub fn status(dir: &PathBuf) -> ChatGptStatus {
    let reg = load_reg(dir);
    let tokens = load_tokens();
    ChatGptStatus {
        signed_in: tokens.is_some(),
        email: tokens.as_ref().and_then(|t| t.email.clone()).or(reg.email),
        plan_usage: tokens
            .as_ref()
            .is_some_and(|t| t.scopes.split_whitespace().any(|s| s == PLAN_SCOPE)),
        show_welcome: tokens.is_some() && !reg.welcomed,
    }
}

pub fn mark_welcomed(dir: &PathBuf) {
    let mut r = load_reg(dir);
    r.welcomed = true;
    save_reg(dir, &r);
}

/// Waits for the OAuth redirect carrying *our* `state`. Requests with a wrong or missing state
/// (another tab, a stray local process) get a 400 and are ignored, and each connection has a
/// short read timeout so a silent client can't stall sign-in.
async fn wait_for_callback(
    listener: TcpListener,
    state: &str,
) -> Result<HashMap<String, String>, String> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let n = match tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf)).await {
            Ok(Ok(n)) => n,
            _ => continue,
        };
        let req = String::from_utf8_lossy(&buf[..n]);
        let target = req.split_whitespace().nth(1).unwrap_or("").to_string();
        let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
        let params: HashMap<String, String> = url_decode_query(query);
        if path != CALLBACK_PATH || params.get("state").map(String::as_str) != Some(state) {
            let _ = sock
                .write_all(
                    b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            continue;
        }
        let ok = params.contains_key("code") && !params.contains_key("error");
        let body = if ok {
            "<html><body style=\"font-family:-apple-system,sans-serif;text-align:center;padding-top:80px\"><h2>Signed in with ChatGPT</h2><p>You can close this tab and return to Querybird.</p></body></html>"
        } else {
            "<html><body style=\"font-family:-apple-system,sans-serif;text-align:center;padding-top:80px\"><h2>Sign-in was not completed</h2><p>Return to Querybird to try again.</p></body></html>"
        };
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = sock.write_all(resp.as_bytes()).await;
        return Ok(params);
    }
}

fn url_decode_query(q: &str) -> HashMap<String, String> {
    q.split('&')
        .filter(|s| !s.is_empty())
        .filter_map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            Some((decode(k), decode(v)))
        })
        .collect()
}

fn decode(s: &str) -> String {
    let bytes = s.replace('+', " ").into_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&String::from_utf8_lossy(&bytes[i + 1..i + 3]), 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<u64>,
    scope: Option<String>,
}

#[derive(Deserialize)]
struct IdClaims {
    sub: String,
    email: Option<String>,
    nonce: Option<String>,
}

/// Verifies the ID token's signature (OpenAI JWKS), issuer, audience, expiry and nonce.
async fn validate_id_token(
    id_token: &str,
    client_id: &str,
    nonce: &str,
) -> Result<IdClaims, String> {
    let discovery: Value = http()
        .get(DISCOVERY_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let jwks_uri = discovery["jwks_uri"]
        .as_str()
        .ok_or("OpenAI discovery document has no jwks_uri")?;
    if !jwks_uri.starts_with("https://auth.openai.com/") {
        return Err("Unexpected JWKS location in OpenAI's discovery document".into());
    }
    let jwks: jsonwebtoken::jwk::JwkSet = http()
        .get(jwks_uri)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let header =
        jsonwebtoken::decode_header(id_token).map_err(|e| format!("ID token header: {e}"))?;
    if header.alg != jsonwebtoken::Algorithm::RS256 {
        return Err("ID token isn't RS256-signed — rejected".into());
    }
    let kid = header
        .kid
        .as_deref()
        .ok_or("ID token has no key id — rejected")?;
    let jwk = jwks
        .find(kid)
        .ok_or("No matching OpenAI signing key for the ID token")?;
    if matches!(
        jwk.common.public_key_use,
        Some(jsonwebtoken::jwk::PublicKeyUse::Encryption)
    ) {
        return Err("OpenAI signing key is not a signature key".into());
    }
    let key = jsonwebtoken::DecodingKey::from_jwk(jwk).map_err(|e| e.to_string())?;
    let mut v = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    v.set_issuer(&[ISSUER]);
    v.set_audience(&[client_id]);
    let data = jsonwebtoken::decode::<IdClaims>(id_token, &key, &v)
        .map_err(|e| format!("ID token validation failed: {e}"))?;
    if data.claims.nonce.as_deref() != Some(nonce) {
        return Err("ID token nonce mismatch — sign-in aborted".into());
    }
    Ok(data.claims)
}

/// Full browser sign-in. Opens the system browser and waits (up to 5 minutes) for the redirect.
pub async fn sign_in(dir: &PathBuf) -> Result<ChatGptStatus, String> {
    let mut reg = load_reg(dir);
    // Prefer the documented port; only the port may change between sign-ins.
    let listener = match TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| e.to_string())?,
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let state = random_b64(32);
    let nonce = random_b64(32);
    let verifier = random_b64(48);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

    let reauth = reg.client_id.clone();
    let mut params: Vec<(&str, String)> = vec![
        (
            "client_id",
            reauth
                .clone()
                .unwrap_or_else(|| "dynamic_agent_client".into()),
        ),
        ("ext_agent_host_id", reg.host_id.clone()),
        ("response_type", "code".into()),
        ("redirect_uri", redirect_uri.clone()),
        ("scope", SCOPES.into()),
        ("resource", RESOURCE.into()),
        ("state", state.clone()),
        ("nonce", nonce.clone()),
        ("code_challenge_method", "S256".into()),
        ("code_challenge", challenge),
    ];
    match (&reauth, &reg.email) {
        (None, _) => params.push(("agent_name_hint", "Querybird".into())),
        (Some(_), Some(email)) => params.push(("login_hint", email.clone())),
        _ => {}
    }
    let url = format!(
        "{AUTHORIZE_URL}?{}",
        params
            .iter()
            .map(|(k, v)| format!("{k}={}", encode(v)))
            .collect::<Vec<_>>()
            .join("&")
    );
    open::that(&url).map_err(|e| format!("Could not open the browser: {e}"))?;

    let cb = tokio::time::timeout(
        Duration::from_secs(300),
        wait_for_callback(listener, &state),
    )
    .await
    .map_err(|_| "Sign-in timed out after 5 minutes".to_string())??;
    if cb.get("state") != Some(&state) {
        return Err("Sign-in response had an unexpected state — aborted for safety".into());
    }
    if let Some(err) = cb.get("error") {
        return Err(if err == "access_denied" {
            "Sign-in was cancelled".into()
        } else {
            format!(
                "Sign-in failed: {err} {}",
                cb.get("error_description").cloned().unwrap_or_default()
            )
        });
    }
    let code = cb
        .get("code")
        .ok_or("Sign-in response had no authorization code")?;
    let client_id = match (&reauth, cb.get("client_id")) {
        (Some(saved), Some(got)) if saved != got => {
            return Err("Sign-in returned a different client id — rejected".into())
        }
        (Some(saved), _) => saved.clone(),
        (None, Some(issued)) if issued != "dynamic_agent_client" => issued.clone(),
        (None, _) => return Err("Registration incomplete: OpenAI did not issue a client id".into()),
    };

    let resp = http()
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client_id.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("resource", RESOURCE),
        ])
        .send()
        .await
        .map_err(|e| format!("Could not reach auth.openai.com: {e}"))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed: {body}"));
    }
    let t: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
    let id_token = t.id_token.ok_or("Token response had no ID token")?;
    let claims = validate_id_token(&id_token, &client_id, &nonce).await?;
    let refresh_token = t
        .refresh_token
        .ok_or("Token response had no refresh token (offline_access not granted)")?;

    let _guard = REFRESH_LOCK.lock().await;
    reg.client_id = Some(client_id);
    reg.email = claims.email.clone();
    save_reg(dir, &reg);
    save_tokens(&Tokens {
        refresh_token,
        scopes: t.scope.unwrap_or_default(),
        subject: claims.sub,
        email: claims.email,
    })?;
    set_access(t.access_token, t.expires_in.unwrap_or(3600));
    drop(_guard);
    Ok(status(dir))
}

/// Returns a valid access token, refreshing it (once, serialized) when close to expiry.
async fn access_token(dir: &PathBuf) -> Result<String, String> {
    let _guard = REFRESH_LOCK.lock().await;
    if let Some((tok, exp)) = ACCESS.lock().ok().and_then(|a| a.clone()) {
        if exp > now() + 120 {
            return Ok(tok);
        }
    }
    let t = load_tokens()
        .ok_or("Not signed in with ChatGPT. Use “Continue with ChatGPT” in Settings → AI.")?;
    let client_id = load_reg(dir)
        .client_id
        .ok_or("Missing ChatGPT client registration — sign in again")?;
    let resp = http()
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("refresh_token", t.refresh_token.as_str()),
            ("resource", RESOURCE),
        ])
        .send()
        .await
        .map_err(|e| format!("Could not reach auth.openai.com: {e}"))?;
    if !resp.status().is_success() {
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        let code = body["error"].as_str().unwrap_or("");
        if matches!(
            code,
            "invalid_grant"
                | "invalid_refresh_token"
                | "token_expired"
                | "refresh_token_expired"
                | "refresh_token_invalidated"
                | "refresh_token_reused"
        ) {
            clear_session();
            return Err(
                "Your ChatGPT session ended. Sign in again with “Continue with ChatGPT”.".into(),
            );
        }
        if code == "invalid_client" {
            return Err(
                "ChatGPT client registration is invalid — sign out and sign in again.".into(),
            );
        }
        return Err(format!(
            "Could not refresh the ChatGPT session ({code}). Try again shortly."
        ));
    }
    let r: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
    // Replace everything together; the refresh token rotates.
    save_tokens(&Tokens {
        refresh_token: r.refresh_token.unwrap_or(t.refresh_token),
        scopes: r.scope.unwrap_or(t.scopes),
        subject: t.subject,
        email: t.email,
    })?;
    set_access(r.access_token.clone(), r.expires_in.unwrap_or(3600));
    Ok(r.access_token)
}

/// Revokes the refresh token and clears local tokens. Keeps the client/host ids for later sign-in.
pub async fn sign_out(dir: &PathBuf) -> Result<String, String> {
    let _guard = REFRESH_LOCK.lock().await;
    let Some(t) = load_tokens() else {
        clear_session();
        return Ok("Signed out".into());
    };
    let client_id = load_reg(dir).client_id.unwrap_or_default();
    let revoked = async {
        let d: Value = http()
            .get(DISCOVERY_URL)
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        let endpoint = d["revocation_endpoint"].as_str()?.to_string();
        for attempt in 0..3 {
            match http()
                .post(&endpoint)
                .form(&[
                    ("token", t.refresh_token.as_str()),
                    ("token_type_hint", "refresh_token"),
                    ("client_id", client_id.as_str()),
                ])
                .send()
                .await
            {
                Ok(r) if r.status().is_success() => return Some(()),
                Ok(r) if r.status().is_client_error() => return None,
                _ => tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await,
            }
        }
        None
    }
    .await;
    clear_session();
    Ok(if revoked.is_some() {
        "Signed out of ChatGPT".into()
    } else {
        "Signed out locally. Remote revocation wasn’t confirmed — you can disconnect Querybird in ChatGPT Settings.".into()
    })
}

/// Models available to the signed-in account (`visibility == "list"`).
pub async fn models(dir: &PathBuf) -> Result<Vec<ModelOption>, String> {
    let token = access_token(dir).await?;
    let v: Value = http()
        .get(format!("{RESOURCE}/models"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let list = v["data"]
        .as_array()
        .or_else(|| v["models"].as_array())
        .cloned()
        .unwrap_or_default();
    Ok(list
        .iter()
        .filter(|m| m["visibility"].as_str().is_none_or(|vis| vis == "list"))
        .filter_map(|m| {
            let id = m["slug"].as_str().or_else(|| m["id"].as_str())?.to_string();
            let label = m["display_name"].as_str().unwrap_or(&id).to_string();
            Some(ModelOption { id, label })
        })
        .collect())
}

fn plan_error(code: &str, message: &str, status: u16) -> String {
    match code {
        "subscription_sharing_usage_limit_exceeded" => {
            format!("ChatGPT plan usage limit reached. Manage usage at {MANAGE_USAGE_URL}")
        }
        "subscription_sharing_user_not_eligible" => {
            "This ChatGPT account isn’t eligible to use its plan in other apps.".into()
        }
        "subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable" => {
            "ChatGPT plan usage is temporarily unavailable. Try again in a moment.".into()
        }
        "subscription_sharing_unsupported_capability" => {
            format!("This request uses a feature the ChatGPT plan route doesn’t support: {message}")
        }
        "subscription_sharing_invalid_user" => {
            "ChatGPT rejected the session. Sign in again with “Continue with ChatGPT”.".into()
        }
        _ if status == 401 => "ChatGPT sign-in is no longer valid (401). Sign in again.".into(),
        _ if status == 403 => format!("ChatGPT plan usage isn’t allowed here (403): {message}"),
        _ => format!(
            "ChatGPT plan request failed ({status}{}): {message}",
            if code.is_empty() {
                String::new()
            } else {
                format!(", {code}")
            }
        ),
    }
}

/// One Responses API call on the user's ChatGPT plan. Returns the concatenated output text.
pub async fn respond(
    dir: &PathBuf,
    model: &str,
    instructions: &str,
    input: Vec<Value>,
    schema: Value,
) -> Result<(String, String), String> {
    let status = status(dir);
    if !status.plan_usage {
        return Err("ChatGPT plan usage wasn’t granted for this sign-in. Sign in again and allow plan usage, or use an OpenAI API key.".into());
    }
    let token = access_token(dir).await?;
    let mut body = json!({
        "model": model,
        "instructions": instructions,
        "input": input,
        "store": false,
        "stream": true,
        "text": { "format": { "type": "json_schema", "name": "sql_answer", "strict": true, "schema": schema } }
    });
    let mut text = call_responses(&token, &body).await;
    // If structured output isn't available on this route, retry once without it (the prompt also asks for JSON).
    if let Err((code, param, _)) = &text {
        if code == "subscription_sharing_unsupported_capability" && param.contains("text") {
            body.as_object_mut().unwrap().remove("text");
            text = call_responses(&token, &body).await;
        }
    }
    text.map_err(|(_, _, msg)| msg)
        .map(|(t, m)| (t, if m.is_empty() { model.to_string() } else { m }))
}

/// Streams `/v1/responses` and assembles output text; succeeds only on `response.completed`.
async fn call_responses(
    token: &str,
    body: &Value,
) -> Result<(String, String), (String, String, String)> {
    let resp = http()
        .post(format!("{RESOURCE}/responses"))
        .bearer_auth(token)
        .header("accept", "text/event-stream")
        .json(body)
        .send()
        .await
        .map_err(|e| {
            (
                String::new(),
                String::new(),
                format!("Could not reach api.openai.com: {e}"),
            )
        })?;
    let status = resp.status().as_u16();
    let request_id = resp
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let raw = resp
        .text()
        .await
        .map_err(|e| (String::new(), String::new(), e.to_string()))?;
    let with_id = |m: String| {
        if request_id.is_empty() {
            m
        } else {
            format!("{m}\n(request id {request_id})")
        }
    };
    if status >= 400 {
        let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let code = v["error"]["code"].as_str().unwrap_or("").to_string();
        let param = v["error"]["param"].as_str().unwrap_or("").to_string();
        let msg = v["error"]["message"].as_str().unwrap_or(&raw).to_string();
        return Err((
            code.clone(),
            param,
            with_id(plan_error(&code, &msg, status)),
        ));
    }
    let mut out = String::new();
    let mut model = String::new();
    for line in raw.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let Ok(ev) = serde_json::from_str::<Value>(data.trim()) else {
            continue;
        };
        match ev["type"].as_str().unwrap_or("") {
            "response.output_text.delta" => out.push_str(ev["delta"].as_str().unwrap_or("")),
            "response.completed" => {
                model = ev["response"]["model"].as_str().unwrap_or("").to_string();
                return Ok((out, model));
            }
            "response.failed" | "error" => {
                let err = if ev["response"]["error"].is_object() {
                    &ev["response"]["error"]
                } else {
                    &ev["error"]
                };
                let code = err["code"].as_str().unwrap_or("").to_string();
                let param = err["param"].as_str().unwrap_or("").to_string();
                let msg = err["message"]
                    .as_str()
                    .unwrap_or("request failed")
                    .to_string();
                return Err((
                    code.clone(),
                    param,
                    with_id(plan_error(&code, &msg, status)),
                ));
            }
            "response.incomplete" => {
                let why = ev["response"]["incomplete_details"]["reason"]
                    .as_str()
                    .unwrap_or("unknown reason");
                return Err((
                    String::new(),
                    String::new(),
                    with_id(format!("The response was incomplete ({why}).",)),
                ));
            }
            _ => {}
        }
    }
    let _ = model;
    Err((
        String::new(),
        String::new(),
        with_id("The stream ended before the response completed.".into()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_roundtrip() {
        let q = url_decode_query("code=a%2Bb&state=x%20y&client_id=oaiapp_1");
        assert_eq!(q["code"], "a+b");
        assert_eq!(q["state"], "x y");
        assert_eq!(
            encode("http://127.0.0.1:1455/auth/callback"),
            "http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback"
        );
    }

    #[test]
    fn pkce_challenge_is_rfc7636() {
        // RFC 7636 appendix B test vector.
        let c = URL_SAFE_NO_PAD.encode(Sha256::digest(
            b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        ));
        assert_eq!(c, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn id_token_verification_has_a_crypto_backend() {
        // jsonwebtoken 10+ panics at runtime without a crypto provider; make sure verifying a
        // (bogus) RS256 token reaches signature checking and returns an error instead.
        let jwk: jsonwebtoken::jwk::Jwk = serde_json::from_value(serde_json::json!({
            "kty": "RSA", "kid": "k", "alg": "RS256", "use": "sig",
            "n": "sXchSjrAb3X2d5ZqYVVw0W0FqNs8P3bp1Y8cGm6E9bQ6Yx1CqJ3x3m0P0p7m3sQ3Y5q8R6uVd7lYyY4G0eH3H9pXx7q3KQ",
            "e": "AQAB"
        }))
        .unwrap();
        let key = jsonwebtoken::DecodingKey::from_jwk(&jwk).unwrap();
        let token = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImsifQ.eyJzdWIiOiJ4In0.c2ln";
        let v = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
        assert!(jsonwebtoken::decode::<serde_json::Value>(token, &key, &v).is_err());
    }

    #[test]
    fn random_values_are_unique() {
        assert_ne!(random_b64(32), random_b64(32));
        assert_eq!(random_b64(32).len(), 43);
    }

    #[test]
    fn plan_errors_are_actionable() {
        assert!(
            plan_error("subscription_sharing_usage_limit_exceeded", "", 429)
                .contains(MANAGE_USAGE_URL)
        );
        assert!(plan_error("", "nope", 403).contains("403"));
    }
}
