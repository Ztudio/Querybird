//! "Is there a newer Querybird?" The check runs here, not in the webview, so the webview's
//! content-security policy stays closed. It sends one anonymous request to GitHub's public
//! releases API and nothing about the user or their databases.

use std::time::Duration;

use serde::Serialize;

const LATEST_RELEASE: &str = "https://api.github.com/repos/Ztudio/Querybird/releases/latest";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub latest: String,
    pub url: String,
    pub newer: bool,
}

/// Numeric, dot-separated comparison: "0.10.0" is newer than "0.9.0".
fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> { s.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    parse(latest) > parse(current)
}

#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let release: serde_json::Value = client
        .get(LATEST_RELEASE)
        .header("User-Agent", concat!("querybird/", env!("CARGO_PKG_VERSION")))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let latest = release["tag_name"].as_str().unwrap_or_default().trim_start_matches('v').to_string();
    let url = release["html_url"].as_str().unwrap_or_default().to_string();
    Ok(UpdateInfo { newer: is_newer(&latest, current), latest, url })
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("0.3.0", "0.2.0"));
        assert!(is_newer("0.10.0", "0.9.0"));
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(!is_newer("0.1.9", "0.2.0"));
    }
}
