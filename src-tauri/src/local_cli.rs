//! Ask AI through a locally installed coding-agent CLI — Claude Code (`claude`) or Codex
//! (`codex`) — so requests use the account the user is already signed in with there.
//!
//! Each question runs one headless, single-turn invocation that is locked down to answering:
//! no tools (no shell, files, web, browser or MCP), no saved session, no user hooks/plugins,
//! and an empty private working directory. The prompt goes through stdin and a private temp
//! file, never the command line, so the schema doesn't show up in `ps`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::ai::{parse_result, result_schema, AskResponse};

const TIMEOUT: Duration = Duration::from_secs(240);

fn home() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default()
}

/// GUI apps don't inherit the shell PATH, so also look where the installers put these CLIs.
fn extra_dirs() -> Vec<PathBuf> {
    let h = home();
    [
        format!("{h}/.local/bin"),
        format!("{h}/.claude/local"),
        format!("{h}/.npm-global/bin"),
        format!("{h}/.bun/bin"),
        format!("{h}/.volta/bin"),
        format!("{h}/AppData/Roaming/npm"),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

fn find(name: &str) -> Option<PathBuf> {
    crate::tools::find_tool(name, None).or_else(|| {
        let names: &[String] = &if cfg!(windows) {
            vec![format!("{name}.exe"), format!("{name}.cmd")]
        } else {
            vec![name.to_string()]
        };
        extra_dirs()
            .into_iter()
            .flat_map(|d| names.iter().map(move |n| d.join(n)))
            .find(|p| p.is_file())
    })
}

pub fn claude_path() -> Option<PathBuf> {
    find("claude")
}

pub fn codex_path() -> Option<PathBuf> {
    find("codex")
}

/// PATH for the child: its own folder first (npm-installed CLIs need `node` next to them), then
/// the usual install locations, then whatever we inherited.
fn child_path(bin: &Path) -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = bin.parent().map(Path::to_path_buf).into_iter().collect();
    dirs.extend(extra_dirs());
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// Claude Code finds its keychain sign-in by user name; make sure the child has one.
fn ensure_user(cmd: &mut Command) {
    if std::env::var_os("USER").is_none() {
        let name = std::env::var("LOGNAME").ok().or_else(|| {
            Path::new(&home())
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
        });
        if let Some(n) = name.filter(|n| !n.is_empty()) {
            cmd.env("USER", &n).env("LOGNAME", &n);
        }
    }
}

/// A private, empty working directory for one run; removed afterwards.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Scratch, String> {
        let dir =
            std::env::temp_dir().join(format!("querybird-ai-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        Ok(Scratch(dir))
    }

    fn write(&self, name: &str, contents: &str) -> Result<PathBuf, String> {
        let p = self.0.join(name);
        std::fs::write(&p, contents).map_err(|e| e.to_string())?;
        Ok(p)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Earlier turns and the new question as one plain-text prompt (the CLIs take a single prompt).
pub fn transcript(messages: &[(String, String)]) -> String {
    match messages.split_last() {
        None => String::new(),
        Some((last, [])) => last.1.clone(),
        Some((last, earlier)) => {
            let mut out = String::from("Earlier in this conversation:\n");
            for (role, content) in earlier {
                let who = if role == "assistant" {
                    "You answered"
                } else {
                    "Engineer asked"
                };
                out.push_str(&format!("\n{who}:\n{content}\n"));
            }
            out.push_str(&format!("\nNew question:\n{}", last.1));
            out
        }
    }
}

async fn run(mut cmd: Command, stdin: &str, tool: &str) -> Result<(String, String), String> {
    ensure_user(&mut cmd);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start {tool}: {e}"))?;
    if let Some(mut si) = child.stdin.take() {
        si.write_all(stdin.as_bytes())
            .await
            .map_err(|e| format!("Could not send the prompt to {tool}: {e}"))?;
    }
    let out = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("{tool} didn't answer within {} s", TIMEOUT.as_secs()))?
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() && stdout.trim().is_empty() {
        let tail: Vec<&str> = stderr.lines().rev().take(6).collect();
        let msg = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!(
            "{tool} failed ({}){}",
            out.status,
            if msg.is_empty() {
                String::new()
            } else {
                format!(":\n{msg}")
            }
        ));
    }
    Ok((stdout, stderr))
}

pub async fn claude_code(model: &str, system: &str, prompt: &str) -> Result<AskResponse, String> {
    let bin = claude_path().ok_or(
        "Claude Code isn't installed (the `claude` command wasn't found). Install it, run `claude` once to sign in, or pick another sign-in method under Settings → AI.",
    )?;
    let scratch = Scratch::new()?;
    let system_file = scratch.write("system.txt", system)?;
    let mut cmd = Command::new(&bin);
    cmd.current_dir(&scratch.0)
        .env("PATH", child_path(&bin))
        .args(["-p", "--output-format", "json", "--no-session-persistence"])
        .arg("--system-prompt-file")
        .arg(&system_file)
        .arg("--json-schema")
        .arg(result_schema().to_string())
        // Answer only: no tools at all, no MCP servers, no user/project settings (hooks,
        // plugins), no skills.
        .args([
            "--tools",
            "",
            "--strict-mcp-config",
            "--setting-sources",
            "",
        ])
        .arg("--disable-slash-commands");
    if !model.is_empty() {
        cmd.arg("--model").arg(model);
    }
    let (stdout, stderr) = run(cmd, prompt, "Claude Code").await?;
    let v: Value = serde_json::from_str(stdout.trim()).map_err(|_| {
        format!(
            "Claude Code returned unexpected output:\n{}",
            if stdout.trim().is_empty() {
                &stderr
            } else {
                &stdout
            }
        )
    })?;
    if v["is_error"].as_bool() == Some(true) {
        let msg = v["result"].as_str().unwrap_or("unknown error");
        return Err(
            if msg.to_lowercase().contains("log in") || msg.contains("/login") {
                format!("Claude Code isn't signed in. Run `claude` in a terminal and sign in, then try again.\n({msg})")
            } else {
                format!("Claude Code: {msg}")
            },
        );
    }
    let served = v["modelUsage"]
        .as_object()
        .and_then(|m| m.keys().next().cloned())
        .unwrap_or_else(|| {
            if model.is_empty() {
                "default model".into()
            } else {
                model.into()
            }
        });
    let text = match &v["structured_output"] {
        Value::Object(_) => v["structured_output"].to_string(),
        _ => v["result"].as_str().unwrap_or_default().to_string(),
    };
    parse_result(&text, format!("{served} (Claude Code)"))
}

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliModel {
    pub id: String,
    pub label: String,
    pub description: String,
}

#[derive(serde::Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexModels {
    /// The model Codex uses when none is chosen (from its config.toml).
    pub default: Option<String>,
    pub models: Vec<CliModel>,
}

fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home()).join(".codex"))
}

/// The models Codex itself offers, read from the list it caches from OpenAI (so it stays current
/// without Querybird hard-coding names). Hidden/internal models are left out; best first.
pub fn codex_models() -> CodexModels {
    let dir = codex_home();
    let default = std::fs::read_to_string(dir.join("config.toml"))
        .ok()
        .and_then(|cfg| {
            cfg.lines()
                // Top-level keys only: stop at the first [table].
                .take_while(|l| !l.trim_start().starts_with('['))
                .find_map(|l| {
                    let (k, v) = l.split_once('=')?;
                    (k.trim() == "model").then(|| v.trim().trim_matches('"').to_string())
                })
        })
        .filter(|m| !m.is_empty());
    let cache: Value = std::fs::read_to_string(dir.join("models_cache.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let mut list: Vec<(i64, CliModel)> = cache["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["visibility"].as_str().unwrap_or("list") == "list")
        .filter_map(|m| {
            let id = m["slug"].as_str()?.to_string();
            Some((
                m["priority"].as_i64().unwrap_or(i64::MAX),
                CliModel {
                    label: m["display_name"].as_str().unwrap_or(&id).to_string(),
                    description: m["description"].as_str().unwrap_or("").to_string(),
                    id,
                },
            ))
        })
        .collect();
    list.sort_by_key(|(p, _)| *p);
    CodexModels {
        default,
        models: list.into_iter().map(|(_, m)| m).collect(),
    }
}

/// Codex features that give the agent abilities beyond answering; all turned off.
const CODEX_DISABLED: &[&str] = &[
    "shell_tool",
    "unified_exec",
    "browser_use",
    "browser_use_external",
    "in_app_browser",
    "computer_use",
    "plugins",
    "apps",
];

pub async fn codex(model: &str, system: &str, prompt: &str) -> Result<AskResponse, String> {
    let bin = codex_path().ok_or(
        "Codex CLI isn't installed (the `codex` command wasn't found). Install it and run `codex login`, or pick another sign-in method under Settings → AI.",
    )?;
    let scratch = Scratch::new()?;
    let schema = scratch.write("schema.json", &result_schema().to_string())?;
    let answer = scratch.0.join("answer.json");
    let mut cmd = Command::new(&bin);
    cmd.current_dir(&scratch.0)
        .env("PATH", child_path(&bin))
        .args([
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "-s",
            "read-only",
        ]);
    for f in CODEX_DISABLED {
        cmd.arg("--disable").arg(f);
    }
    cmd.args(["-c", "web_search=\"disabled\"", "-c", "mcp_servers={}"])
        .arg("--output-schema")
        .arg(&schema)
        .arg("-o")
        .arg(&answer);
    if !model.is_empty() {
        cmd.arg("-m").arg(model);
    }
    cmd.arg("-");
    // Codex has no separate system prompt for `exec`; the instructions lead the prompt.
    let input = format!("{system}\n\n---\n\n{prompt}");
    let (_stdout, stderr) = run(cmd, &input, "Codex").await?;
    let text = std::fs::read_to_string(&answer).unwrap_or_default();
    if text.trim().is_empty() {
        let lower = stderr.to_lowercase();
        return Err(
            if lower.contains("login") || lower.contains("not logged in") || lower.contains("401") {
                "Codex isn't signed in. Run `codex login` in a terminal, then try again.".into()
            } else {
                let tail: Vec<&str> = stderr.lines().rev().take(6).collect();
                format!(
                    "Codex didn't return an answer:\n{}",
                    tail.into_iter().rev().collect::<Vec<_>>().join("\n")
                )
            },
        );
    }
    let label = if model.is_empty() {
        "default model"
    } else {
        model
    };
    parse_result(&text, format!("{label} (Codex CLI)"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_codex_models_from_its_cache() {
        let dir = std::env::temp_dir().join(format!("qb-codex-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("config.toml"),
            "model = \"new-b\"\n[profiles.x]\nmodel = \"other\"\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("models_cache.json"),
            r#"{"models":[
                {"slug":"old-a","display_name":"Old A","priority":5,"visibility":"list"},
                {"slug":"new-b","display_name":"New B","description":"Latest","priority":0,"visibility":"list"},
                {"slug":"internal","display_name":"Internal","priority":1,"visibility":"hide"}]}"#,
        )
        .unwrap();
        std::env::set_var("CODEX_HOME", &dir);
        let m = codex_models();
        std::env::remove_var("CODEX_HOME");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(m.default.as_deref(), Some("new-b"));
        let ids: Vec<&str> = m.models.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, vec!["new-b", "old-a"]);
        assert_eq!(m.models[0].label, "New B");
    }

    #[test]
    fn transcript_keeps_turn_order() {
        let one = vec![("user".to_string(), "q1".to_string())];
        assert_eq!(transcript(&one), "q1");
        let many = vec![
            ("user".to_string(), "q1".to_string()),
            ("assistant".to_string(), "SELECT 1".to_string()),
            ("user".to_string(), "q2".to_string()),
        ];
        let t = transcript(&many);
        assert!(t.find("q1").unwrap() < t.find("SELECT 1").unwrap());
        assert!(t.ends_with("New question:\nq2"));
    }

    /// Runs the real CLIs when QUERYBIRD_CLI_TESTS is set (needs them installed and signed in).
    #[tokio::test]
    async fn real_clis() {
        if std::env::var("QUERYBIRD_CLI_TESTS").is_err() {
            return;
        }
        let system = "Write one SQLite SELECT for the engineer's question. Tables: customers(id, name, country). Reply only with the JSON object.";
        let prompt = "How many customers per country?";
        if claude_path().is_some() {
            let r = claude_code("haiku", system, prompt)
                .await
                .expect("claude code");
            assert!(r.sql.to_uppercase().contains("GROUP BY"), "{r:?}");
            assert!(r.model.ends_with("(Claude Code)"));
        }
        if codex_path().is_some() {
            let r = codex("", system, prompt).await.expect("codex");
            assert!(r.sql.to_uppercase().contains("GROUP BY"), "{r:?}");
        }
    }
}
