//! Backup / restore by driving the standard command-line tools (pg_dump, pg_restore, psql,
//! mysqldump, mysql), the same approach TablePlus uses. Works through SSH tunnels too.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::Command;

use crate::db::types::{ConnectionConfig, Driver, SslMode};
use crate::db::via_tunnel;

/// GUI apps on macOS don't inherit the shell PATH, so also look in the usual install locations.
const EXTRA_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/homebrew/opt/libpq/bin",
    "/usr/local/opt/libpq/bin",
    "/opt/homebrew/opt/mysql-client/bin",
    "/usr/local/opt/mysql-client/bin",
    "/Applications/Postgres.app/Contents/Versions/latest/bin",
    "/usr/bin",
    "C:\\Program Files\\PostgreSQL\\17\\bin",
    "C:\\Program Files\\PostgreSQL\\16\\bin",
    "C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin",
    "C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin",
];

pub fn find_tool(name: &str, dir_override: Option<&str>) -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = dir_override.filter(|d| !d.is_empty()) {
        dirs.push(PathBuf::from(d));
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.extend(EXTRA_DIRS.iter().map(PathBuf::from));
    dirs.into_iter()
        // Relative PATH entries (".", "") would run whatever sits in the current directory.
        .filter(|d| d.is_absolute())
        .map(|d| d.join(&exe))
        .find(|p| p.is_file() && trustworthy(p))
}

/// Refuses binaries that any user could have replaced.
fn trustworthy(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let writable_by_others = |q: &Path| {
            std::fs::metadata(q)
                .map(|m| m.permissions().mode() & 0o002 != 0)
                .unwrap_or(true)
        };
        if writable_by_others(p) || p.parent().is_some_and(writable_by_others) {
            return false;
        }
    }
    let _ = p;
    true
}

/// A secret written to a private (0600) temp file for the duration of one tool run.
struct SecretFile(PathBuf);

impl SecretFile {
    fn new(contents: &str) -> Result<SecretFile, String> {
        use std::io::Write;
        let path =
            std::env::temp_dir().join(format!("querybird-{}", uuid::Uuid::new_v4().simple()));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&path).map_err(|e| e.to_string())?;
        f.write_all(contents.as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(SecretFile(path))
    }
}

impl Drop for SecretFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn check_database(name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('-') || name.contains('\0') {
        return Err(format!("Refusing database name {name:?}"));
    }
    Ok(())
}

/// libpq connection string value: single-quoted with `\` and `'` escaped, so `=` or spaces in a
/// database name can't smuggle in other connection parameters.
fn conninfo_value(v: &str) -> String {
    format!("'{}'", v.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn missing(tool: &str) -> String {
    format!(
        "Could not find `{tool}`. Install the {} client tools, or set their folder under Settings → Backup tools.",
        if tool.starts_with("pg") || tool == "psql" { "PostgreSQL" } else { "MySQL" }
    )
}

async fn run(mut cmd: Command, stdin_file: Option<&Path>) -> Result<String, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
    if let Some(f) = stdin_file {
        let file = std::fs::File::open(f).map_err(|e| format!("{}: {e}", f.display()))?;
        cmd.stdin(Stdio::from(file));
    } else {
        cmd.stdin(Stdio::null());
    }
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        Ok(stderr)
    } else {
        Err(if stderr.is_empty() {
            format!("exited with {}", out.status)
        } else {
            stderr
        })
    }
}

/// Password goes in a private PGPASSFILE (not an env var other processes can read).
fn pg_env(
    cmd: &mut Command,
    cfg: &ConnectionConfig,
    password: Option<&str>,
) -> Result<Option<SecretFile>, String> {
    cmd.env_remove("PGPASSWORD");
    cmd.env(
        "PGSSLMODE",
        match cfg.ssl_mode {
            SslMode::Disable => "disable",
            SslMode::Prefer => "prefer",
            SslMode::Require => "require",
            SslMode::VerifyFull => "verify-full",
        },
    );
    let Some(pw) = password.filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    let escaped = pw.replace('\\', "\\\\").replace(':', "\\:");
    let file = SecretFile::new(&format!("*:*:*:*:{escaped}\n"))?;
    cmd.env("PGPASSFILE", &file.0);
    Ok(Some(file))
}

fn pg_conn_args(cmd: &mut Command, cfg: &ConnectionConfig, database: &str) -> Result<(), String> {
    check_database(database)?;
    cmd.arg("-h")
        .arg(&cfg.host)
        .arg("-p")
        .arg(cfg.port.to_string());
    cmd.arg("-U").arg(if cfg.user.is_empty() {
        "postgres"
    } else {
        &cfg.user
    });
    cmd.arg(format!("--dbname=dbname={}", conninfo_value(database)));
    Ok(())
}

/// The password goes in a private option file, which MySQL requires as the very first argument.
fn my_conn_args(
    cmd: &mut Command,
    cfg: &ConnectionConfig,
    password: Option<&str>,
) -> Result<Option<SecretFile>, String> {
    cmd.env_remove("MYSQL_PWD");
    let file = match password.filter(|p| !p.is_empty()) {
        Some(pw) => {
            let quoted = pw.replace('\\', "\\\\").replace('"', "\\\"");
            let f = SecretFile::new(&format!("[client]\npassword=\"{quoted}\"\n"))?;
            cmd.arg(format!("--defaults-extra-file={}", f.0.display()));
            Some(f)
        }
        None => None,
    };
    cmd.arg(format!("--host={}", cfg.host))
        .arg(format!("--port={}", cfg.port))
        .arg("--protocol=TCP");
    cmd.arg(format!(
        "--user={}",
        if cfg.user.is_empty() {
            "root"
        } else {
            &cfg.user
        }
    ));
    cmd.arg(match cfg.ssl_mode {
        SslMode::Disable => "--ssl-mode=DISABLED",
        SslMode::Prefer => "--ssl-mode=PREFERRED",
        SslMode::Require => "--ssl-mode=REQUIRED",
        SslMode::VerifyFull => "--ssl-mode=VERIFY_IDENTITY",
    });
    Ok(file)
}

/// Newer mysql clients can refuse `system`/`\!` lines in restored files.
async fn mysql_supports_skip_system(tool: &Path) -> bool {
    Command::new(tool)
        .arg("--help")
        .output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("skip-system-command"))
        .unwrap_or(false)
}

pub async fn backup(
    cfg: &ConnectionConfig,
    password: Option<&str>,
    database: &str,
    path: &str,
    custom_format: bool,
    tools_dir: Option<&str>,
) -> Result<String, String> {
    if cfg.driver == Driver::Sqlite {
        return sqlite_job(cfg, path, crate::db::sqlite::backup).await;
    }
    check_database(database)?;
    let (target, _tunnel) = via_tunnel(cfg).await?;
    match cfg.driver {
        Driver::Sqlite => unreachable!(),
        Driver::Postgres => {
            let tool = find_tool("pg_dump", tools_dir).ok_or_else(|| missing("pg_dump"))?;
            let mut cmd = Command::new(tool);
            let _secret = pg_env(&mut cmd, &target, password)?;
            pg_conn_args(&mut cmd, &target, database)?;
            cmd.arg("--no-password").arg(format!("--file={path}"));
            if custom_format {
                cmd.arg("-Fc");
            }
            run(cmd, None).await
        }
        Driver::Mysql => {
            let tool = find_tool("mysqldump", tools_dir).ok_or_else(|| missing("mysqldump"))?;
            let mut cmd = Command::new(tool);
            let _secret = my_conn_args(&mut cmd, &target, password)?;
            cmd.arg("--single-transaction")
                .arg("--routines")
                .arg("--triggers");
            cmd.arg(format!("--result-file={path}"))
                .arg("--")
                .arg(database);
            run(cmd, None).await
        }
    }
    .and_then(|log| {
        // Never report success unless the dump actually landed where the user asked.
        match std::fs::metadata(path) {
            Ok(m) if m.len() > 0 => Ok(log),
            _ => Err(format!(
                "The backup tool finished but {path} was not written.\n{log}"
            )),
        }
    })
}

/// Restores a dump. Dump files are executable content (psql meta-commands, mysql `system`), so
/// only restore files you trust; MySQL clients that support it run with `--skip-system-command`.
pub async fn restore(
    cfg: &ConnectionConfig,
    password: Option<&str>,
    database: &str,
    path: &str,
    tools_dir: Option<&str>,
) -> Result<String, String> {
    if cfg.driver == Driver::Sqlite {
        return sqlite_job(cfg, path, crate::db::sqlite::restore).await;
    }
    check_database(database)?;
    let (target, _tunnel) = via_tunnel(cfg).await?;
    let is_sql = path.to_lowercase().ends_with(".sql");
    match cfg.driver {
        Driver::Postgres if is_sql => {
            let tool = find_tool("psql", tools_dir).ok_or_else(|| missing("psql"))?;
            let mut cmd = Command::new(tool);
            let _secret = pg_env(&mut cmd, &target, password)?;
            pg_conn_args(&mut cmd, &target, database)?;
            cmd.arg("--no-password")
                .arg("--no-psqlrc")
                .arg("-v")
                .arg("ON_ERROR_STOP=1")
                .arg("-q")
                .arg(format!("--file={path}"));
            run(cmd, None).await
        }
        Driver::Postgres => {
            let tool = find_tool("pg_restore", tools_dir).ok_or_else(|| missing("pg_restore"))?;
            let mut cmd = Command::new(tool);
            let _secret = pg_env(&mut cmd, &target, password)?;
            pg_conn_args(&mut cmd, &target, database)?;
            cmd.arg("--no-password")
                .arg("--no-owner")
                .arg("--")
                .arg(path);
            run(cmd, None).await
        }
        Driver::Mysql => {
            let tool = find_tool("mysql", tools_dir).ok_or_else(|| missing("mysql"))?;
            let skip_system = mysql_supports_skip_system(&tool).await;
            let mut cmd = Command::new(&tool);
            let _secret = my_conn_args(&mut cmd, &target, password)?;
            if skip_system {
                cmd.arg("--skip-system-command");
            }
            cmd.arg("--").arg(database);
            run(cmd, Some(Path::new(path))).await
        }
        Driver::Sqlite => unreachable!(),
    }
}

/// SQLite needs no external tools: backup and restore run in-process off the async runtime.
async fn sqlite_job(
    cfg: &ConnectionConfig,
    path: &str,
    job: fn(&ConnectionConfig, &str) -> Result<String, String>,
) -> Result<String, String> {
    let (cfg, path) = (cfg.clone(), path.to_string());
    tokio::task::spawn_blocking(move || job(&cfg, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn database_names_cant_become_options_or_conninfo() {
        assert!(check_database("--init-command=x").is_err());
        assert!(check_database("shop").is_ok());
        assert_eq!(conninfo_value("a' host=evil"), "'a\\' host=evil'");
    }
}
