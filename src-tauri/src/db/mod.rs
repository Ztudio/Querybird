pub mod mysql;
pub mod pg;
pub mod sqlgen;
pub mod sqlite;
pub mod tunnel;
pub mod types;
pub mod users;

use tokio::sync::Mutex;

use sqlgen::Dialect;
use types::*;

pub enum Conn {
    Pg(tokio_postgres::Client),
    My(mysql_async::Conn),
    Lite(rusqlite::Connection),
}

/// SQLite calls block; on the app's multi-threaded runtime let other tasks move off this worker.
fn blocking<T>(f: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(h) if h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(f)
        }
        _ => f(),
    }
}

/// One live connection. All work on it is serialized through `conn`.
pub struct Session {
    pub id: String,
    pub config: ConnectionConfig,
    pub server_version: String,
    pub schema: Mutex<String>,
    pub conn: Mutex<Conn>,
    /// Kept alive for as long as the session; dropping it closes the SSH tunnel.
    pub tunnel: Option<tunnel::Tunnel>,
}

/// Opens the SSH tunnel when configured and returns the config to connect with
/// (host/port rewritten to the local end of the tunnel).
pub async fn via_tunnel(
    config: &ConnectionConfig,
) -> Result<(ConnectionConfig, Option<tunnel::Tunnel>), String> {
    let ssh = config
        .ssh
        .as_ref()
        .filter(|s| s.enabled && config.driver != Driver::Sqlite);
    match ssh {
        None => Ok((config.clone(), None)),
        Some(ssh) => {
            let host = if config.host.is_empty() {
                "127.0.0.1"
            } else {
                &config.host
            };
            let port = if config.port != 0 {
                config.port
            } else if config.driver == Driver::Postgres {
                5432
            } else {
                3306
            };
            let t = tunnel::open(ssh, host, port).await?;
            let mut c = config.clone();
            c.host = "127.0.0.1".into();
            c.port = t.local_port;
            Ok((c, Some(t)))
        }
    }
}

impl Session {
    pub async fn open(
        id: String,
        config: ConnectionConfig,
        password: Option<&str>,
    ) -> Result<Session, String> {
        let (target, tunnel) = via_tunnel(&config).await?;
        let (conn, version, schema) = match config.driver {
            Driver::Postgres => {
                let c = pg::connect(&target, password).await?;
                let v = pg::server_version(&c).await;
                let s = pg::current_schema(&c).await;
                (Conn::Pg(c), v, s)
            }
            Driver::Mysql => {
                let mut c = mysql::connect(&target, password).await?;
                let v = mysql::server_version(&mut c).await;
                let s = mysql::current_schema(&mut c).await;
                (Conn::My(c), v, s)
            }
            Driver::Sqlite => {
                let c = blocking(|| sqlite::connect(&target))?;
                let v = sqlite::server_version(&c);
                (Conn::Lite(c), v, "main".to_string())
            }
        };
        let session = Session {
            id,
            config,
            server_version: version,
            schema: Mutex::new(schema),
            conn: Mutex::new(conn),
            tunnel,
        };
        let bootstrap = session.config.bootstrap.trim().to_string();
        if !bootstrap.is_empty() {
            session
                .execute(&bootstrap)
                .await
                .map_err(|e| format!("Bootstrap commands failed: {e}"))?;
        }
        Ok(session)
    }

    /// Runs one statement that must not change anything, enforced by the server rather than by
    /// parsing: single statement only (prepared protocol), read-only first keyword, a deny-list of
    /// side-effecting functions, a READ ONLY transaction that is always rolled back, and timeouts.
    /// Used for AI-generated SQL that runs without asking.
    pub async fn execute_readonly(&self, sql: &str) -> Result<Vec<QueryResult>, String> {
        let trimmed = sql.trim().trim_end_matches(';').trim();
        check_readonly_text(self.config.driver, trimmed)?;
        let mut guard = self.conn.lock().await;
        match &mut *guard {
            Conn::Pg(c) => {
                // Extended-protocol prepare rejects multiple statements.
                c.prepare(trimmed)
                    .await
                    .map_err(|e| format!("Not a single valid statement: {}", pg::err(e)))?;
                c.batch_execute("BEGIN READ ONLY; SET LOCAL statement_timeout = '30s'; SET LOCAL lock_timeout = '2s'")
                    .await
                    .map_err(pg::err)?;
                let res = pg::execute(c, trimmed).await;
                let _ = c.batch_execute("ROLLBACK").await;
                res
            }
            Conn::My(c) => {
                use mysql_async::prelude::Queryable;
                // Server-side prepare rejects multiple statements.
                let stmt = c
                    .prep(trimmed)
                    .await
                    .map_err(|e| format!("Not a single valid statement: {}", mysql::err(e)))?;
                let _ = c.close(stmt).await;
                c.query_drop("SET SESSION MAX_EXECUTION_TIME = 30000")
                    .await
                    .map_err(mysql::err)?;
                c.query_drop("START TRANSACTION READ ONLY")
                    .await
                    .map_err(mysql::err)?;
                let res = mysql::execute(c, trimmed).await;
                let _ = c.query_drop("ROLLBACK").await;
                let _ = c.query_drop("SET SESSION MAX_EXECUTION_TIME = 0").await;
                res
            }
            Conn::Lite(c) => blocking(|| sqlite::execute_readonly(c, trimmed)),
        }
    }

    /// Cheap round trip used to keep idle connections (and tunnels) open.
    pub async fn ping(&self) -> Result<(), String> {
        self.execute("SELECT 1").await.map(|_| ())
    }

    pub fn dialect(&self) -> Dialect {
        Dialect(self.config.driver)
    }

    pub async fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            connection: self.config.clone(),
            server_version: self.server_version.clone(),
            schema: self.schema.lock().await.clone(),
        }
    }

    pub async fn execute(&self, sql: &str) -> Result<Vec<QueryResult>, String> {
        match &mut *self.conn.lock().await {
            Conn::Pg(c) => pg::execute(c, sql).await,
            Conn::My(c) => mysql::execute(c, sql).await,
            Conn::Lite(c) => blocking(|| sqlite::execute(c, sql)),
        }
    }

    pub async fn list_schemas(&self) -> Result<Vec<String>, String> {
        match &mut *self.conn.lock().await {
            Conn::Pg(c) => pg::list_schemas(c).await,
            Conn::My(c) => mysql::list_schemas(c).await,
            Conn::Lite(c) => sqlite::list_schemas(c),
        }
    }

    pub async fn set_schema(&self, schema: &str) -> Result<(), String> {
        match &mut *self.conn.lock().await {
            Conn::Pg(c) => pg::set_schema(c, schema).await?,
            Conn::My(c) => mysql::set_schema(c, schema).await?,
            Conn::Lite(c) => sqlite::set_schema(c, schema)?,
        }
        *self.schema.lock().await = schema.to_string();
        Ok(())
    }

    pub async fn list_objects(&self, schema: &str) -> Result<ObjectList, String> {
        match &mut *self.conn.lock().await {
            Conn::Pg(c) => pg::list_objects(c, schema).await,
            Conn::My(c) => mysql::list_objects(c, schema).await,
            Conn::Lite(c) => sqlite::list_objects(c, schema),
        }
    }

    pub async fn structure(&self, schema: &str, table: &str) -> Result<TableStructure, String> {
        match &mut *self.conn.lock().await {
            Conn::Pg(c) => pg::structure(c, schema, table).await,
            Conn::My(c) => mysql::structure(c, schema, table).await,
            Conn::Lite(c) => sqlite::structure(c, schema, table),
        }
    }

    pub async fn table_info(
        &self,
        schema: &str,
        table: &str,
    ) -> Result<Vec<(String, String)>, String> {
        match &mut *self.conn.lock().await {
            Conn::Pg(c) => pg::table_info(c, schema, table).await,
            Conn::My(c) => mysql::table_info(c, schema, table).await,
            Conn::Lite(c) => blocking(|| sqlite::table_info(c, schema, table)),
        }
    }

    pub async fn ddl(&self, schema: &str, table: &str) -> Result<String, String> {
        match &mut *self.conn.lock().await {
            Conn::Pg(c) => pg::ddl(c, schema, table).await,
            Conn::My(c) => mysql::ddl(c, schema, table).await,
            Conn::Lite(c) => sqlite::ddl(c, schema, table),
        }
    }

    pub fn process_list_sql(&self) -> Result<&'static str, String> {
        match self.config.driver {
            Driver::Postgres => Ok(pg::PROCESS_LIST),
            Driver::Mysql => Ok(mysql::PROCESS_LIST),
            Driver::Sqlite => Err(NO_SERVER.into()),
        }
    }

    pub async fn fetch_table(&self, q: &TableQuery) -> Result<TablePage, String> {
        let capped;
        let q = if q.limit > MAX_PAGE_ROWS {
            capped = TableQuery {
                limit: MAX_PAGE_ROWS,
                ..q.clone()
            };
            &capped
        } else {
            q
        };
        let structure = self.structure(&q.schema, &q.table).await.ok();
        let pk = structure
            .as_ref()
            .map(|s| s.primary_key.clone())
            .unwrap_or_default();
        let (select, count) = self.dialect().select_page(q, &pk);
        let mut results = self.execute(&select).await?;
        let mut result = results.pop().ok_or("no result")?;
        // Column types come from the catalog so table views always know them (MySQL/PG alike).
        if let Some(st) = &structure {
            for c in &mut result.columns {
                if let Some(info) = st.columns.iter().find(|i| i.name == c.name) {
                    c.type_name = info.data_type.clone();
                }
            }
        }
        let unfiltered =
            q.filters.is_empty() && q.raw_where.as_deref().is_none_or(|w| w.trim().is_empty());
        let estimate = if unfiltered {
            self.estimated_rows(&q.schema, &q.table).await
        } else {
            None
        };
        let (total, estimated) = match estimate {
            // Counting huge tables is slow; use the planner's estimate like TablePlus does.
            Some(n) if n > ESTIMATE_THRESHOLD => (n, true),
            _ => (
                self.execute(&count)
                    .await?
                    .pop()
                    .and_then(|r| r.rows.into_iter().next())
                    .and_then(|r| r.into_iter().next().flatten())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0),
                false,
            ),
        };
        Ok(TablePage {
            result,
            total,
            estimated,
            sql: select,
        })
    }

    async fn scalar(&self, sql: &str) -> Option<String> {
        self.execute(sql)
            .await
            .ok()?
            .pop()?
            .rows
            .into_iter()
            .next()?
            .into_iter()
            .next()
            .flatten()
    }

    pub async fn estimated_rows(&self, schema: &str, table: &str) -> Option<u64> {
        let d = self.dialect();
        let sql = match self.config.driver {
            Driver::Postgres => format!(
                "SELECT reltuples::bigint FROM pg_catalog.pg_class WHERE oid = {}::regclass",
                d.literal(&d.table(schema, table))
            ),
            Driver::Mysql => format!(
                "SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}",
                d.literal(schema),
                d.literal(table)
            ),
            // COUNT(*) on a local file is fast enough; there is no planner estimate to read.
            Driver::Sqlite => return None,
        };
        self.scalar(&sql)
            .await?
            .parse::<i64>()
            .ok()
            .map(|n| n.max(0) as u64)
    }

    /// Tables in a schema with row estimates and sizes (TablePlus "Item overview").
    pub async fn overview(&self, schema: &str) -> Result<QueryResult, String> {
        let d = self.dialect();
        let sql = match self.config.driver {
            Driver::Postgres => format!(
                "SELECT c.relname AS name, \
                        CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view' \
                             WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' END AS type, \
                        GREATEST(c.reltuples, 0)::bigint AS estimated_rows, \
                        pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(c.oid)) AS total_size, \
                        pg_catalog.pg_size_pretty(pg_catalog.pg_indexes_size(c.oid)) AS index_size, \
                        pg_catalog.obj_description(c.oid, 'pg_class') AS comment \
                 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = {} AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname",
                d.literal(schema)
            ),
            Driver::Mysql => format!(
                "SELECT TABLE_NAME AS name, LOWER(TABLE_TYPE) AS type, TABLE_ROWS AS estimated_rows, \
                        CONCAT(ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024), ' KB') AS total_size, \
                        CONCAT(ROUND(INDEX_LENGTH / 1024), ' KB') AS index_size, ENGINE AS engine, \
                        TABLE_COLLATION AS collation, NULLIF(TABLE_COMMENT, '') AS comment \
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = {} ORDER BY TABLE_NAME",
                d.literal(schema)
            ),
            Driver::Sqlite => sqlite::overview_sql(schema),
        };
        self.execute(&sql)
            .await?
            .pop()
            .ok_or_else(|| "no result".into())
    }

    /// Finds `term` in any column of any table in `schema` (TablePlus "Search in Database").
    pub async fn search(&self, schema: &str, term: &str) -> Result<Vec<SearchHit>, String> {
        let d = self.dialect();
        let objects = self.list_objects(schema).await?;
        let pattern = d.literal(&format!(
            "%{}%",
            term.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        ));
        let mut hits = Vec::new();
        for table in objects.tables {
            let Ok(st) = self.structure(schema, &table).await else {
                continue;
            };
            if st.columns.is_empty() {
                continue;
            }
            let where_sql = st
                .columns
                .iter()
                .map(|c| match self.config.driver {
                    Driver::Postgres => {
                        format!("CAST({} AS TEXT) ILIKE {pattern}", d.ident(&c.name))
                    }
                    Driver::Mysql => format!("{} LIKE {pattern}", d.ident(&c.name)),
                    // SQLite's LIKE has no default escape character.
                    Driver::Sqlite => format!(
                        "CAST({} AS TEXT) LIKE {pattern} ESCAPE '\\'",
                        d.ident(&c.name)
                    ),
                })
                .collect::<Vec<_>>()
                .join(" OR ");
            let sql = format!(
                "SELECT COUNT(*) FROM {} WHERE {where_sql}",
                d.table(schema, &table)
            );
            let count = self
                .scalar(&sql)
                .await
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            if count > 0 {
                hits.push(SearchHit {
                    table,
                    count,
                    where_sql,
                });
            }
        }
        Ok(hits)
    }

    pub async fn kill_process(&self, pid: &str) -> Result<(), String> {
        let pid: i64 = pid
            .trim()
            .parse()
            .map_err(|_| format!("invalid process id: {pid}"))?;
        let sql = match self.config.driver {
            Driver::Postgres => format!("SELECT pg_terminate_backend({pid})"),
            Driver::Mysql => format!("KILL {pid}"),
            Driver::Sqlite => return Err(NO_SERVER.into()),
        };
        self.execute(&sql).await.map(|_| ())
    }

    /// Runs statements in order. With `transaction`, everything is rolled back on the first error
    /// (MySQL commits DDL implicitly, so DDL there is only as atomic as MySQL allows).
    pub async fn run_statements(
        &self,
        statements: &[String],
        transaction: bool,
    ) -> Result<Vec<String>, String> {
        let mut guard = self.conn.lock().await;
        match &mut *guard {
            Conn::Pg(c) => {
                if transaction {
                    c.batch_execute("BEGIN").await.map_err(pg::err)?;
                }
                for st in statements {
                    if let Err(e) = c.batch_execute(st).await {
                        if transaction {
                            let _ = c.batch_execute("ROLLBACK").await;
                        }
                        return Err(format!("{}\n\n{st}", pg::err(e)));
                    }
                }
                if transaction {
                    c.batch_execute("COMMIT").await.map_err(pg::err)?;
                }
            }
            Conn::My(c) => {
                use mysql_async::prelude::Queryable;
                if transaction {
                    c.query_drop("START TRANSACTION")
                        .await
                        .map_err(mysql::err)?;
                }
                for st in statements {
                    if let Err(e) = c.query_drop(st.as_str()).await {
                        if transaction {
                            let _ = c.query_drop("ROLLBACK").await;
                        }
                        return Err(format!("{}\n\n{st}", mysql::err(e)));
                    }
                }
                if transaction {
                    c.query_drop("COMMIT").await.map_err(mysql::err)?;
                }
            }
            Conn::Lite(c) => blocking(|| sqlite::run_statements(c, statements, transaction))?,
        }
        Ok(statements.to_vec())
    }

    pub fn preview_changes(&self, changes: &[Change]) -> Result<Vec<String>, String> {
        let d = self.dialect();
        changes.iter().map(|c| d.change(c)).collect()
    }

    /// Applies all changes in one transaction; rolls back on the first failure.
    pub async fn apply_changes(&self, changes: &[Change]) -> Result<Vec<String>, String> {
        let statements = self.preview_changes(changes)?;
        self.run_statements(&statements, true).await
    }
}

const ESTIMATE_THRESHOLD: u64 = 500_000;

pub const NO_SERVER: &str =
    "SQLite is a local file: there is no server, process list or user accounts.";

/// Hard cap on rows per page so a request can't make Querybird buffer an unbounded table.
pub const MAX_PAGE_ROWS: u64 = 100_000;

/// Functions that read files, signal other sessions, sleep or take locks even in a read-only transaction.
const DENY_FUNCTIONS: &[&str] = &[
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_read_file",
    "pg_read_binary_file",
    "pg_ls_dir",
    "pg_stat_file",
    "pg_sleep",
    "pg_advisory",
    "pg_try_advisory",
    "set_config",
    "pg_reload_conf",
    "pg_rotate_logfile",
    "pg_switch_wal",
    "lo_import",
    "lo_export",
    "dblink",
    "pg_logical_emit_message",
    "load_file",
    "sleep",
    "benchmark",
    "get_lock",
    "release_lock",
    "sys_exec",
    "sys_eval",
    "load_extension",
    "readfile",
    "writefile",
    "fts3_tokenizer",
];

/// Cheap lexical gate before the server-side checks. Strips string literals and comments first so
/// the deny-list can't be dodged or tripped by quoted text.
pub fn check_readonly_text(driver: Driver, sql: &str) -> Result<(), String> {
    let lower = strip_literals(sql).to_lowercase();
    let first = lower
        .split(|c: char| !c.is_ascii_alphabetic())
        .find(|w| !w.is_empty())
        .unwrap_or("");
    let allowed: &[&str] = match driver {
        Driver::Postgres => &["select", "with", "table", "values", "explain", "show"],
        Driver::Mysql => &[
            "select", "with", "table", "values", "explain", "show", "describe", "desc",
        ],
        Driver::Sqlite => &["select", "with", "values", "explain"],
    };
    if !allowed.contains(&first) {
        return Err(format!(
            "Not a read-only query (starts with {})",
            first.to_uppercase()
        ));
    }
    let words: Vec<&str> = lower
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .collect();
    if first == "explain" && words.contains(&"analyze") {
        return Err("EXPLAIN ANALYZE executes the statement".into());
    }
    if words.windows(2).any(|w| w[0] == "into")
        || words.contains(&"outfile")
        || words.contains(&"dumpfile")
    {
        return Err("SELECT … INTO writes data".into());
    }
    if let Some(f) = called_functions(&lower)
        .into_iter()
        .find(|name| DENY_FUNCTIONS.iter().any(|d| name.starts_with(d)))
    {
        return Err(format!("Calls {f}(), which has side effects"));
    }
    for kw in [
        "insert", "update", "delete", "merge", "drop", "alter", "create", "truncate", "grant",
        "revoke", "copy", "call", "do", "lock", "vacuum", "refresh", "replace", "rename", "load",
        "handler", "set",
    ] {
        if words.contains(&kw)
            && !(kw == "replace" && lower.contains("replace("))
            && !(kw == "set" && !lower.contains(" set "))
        {
            return Err(format!("Contains {}", kw.to_uppercase()));
        }
    }
    Ok(())
}

/// Names directly followed by `(` (function calls), schema prefixes removed.
fn called_functions(lower: &str) -> Vec<String> {
    let chars: Vec<char> = lower.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_alphabetic() || chars[i] == '_' {
            let start = i;
            while i < chars.len()
                && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '.')
            {
                i += 1;
            }
            let mut j = i;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if chars.get(j) == Some(&'(') {
                let name: String = chars[start..i].iter().collect();
                out.push(name.rsplit('.').next().unwrap_or("").to_string());
            }
        } else {
            i += 1;
        }
    }
    out
}

/// Removes quoted strings, quoted identifiers, dollar-quoted bodies and comments.
fn strip_literals(sql: &str) -> String {
    let b: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let n = b.get(i + 1).copied();
        if c == '-' && n == Some('-') || c == '#' {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && n == Some('*') {
            // MySQL executes /*! … */ comments, so keep their contents.
            if b.get(i + 2) == Some(&'!') {
                i += 3;
                continue;
            }
            i += 2;
            while i + 1 < b.len() && !(b[i] == '*' && b[i + 1] == '/') {
                i += 1;
            }
            i += 2;
        } else if c == '\'' || c == '"' || c == '`' {
            i += 1;
            while i < b.len() {
                if b[i] == '\\' && c != '"' {
                    i += 2;
                    continue;
                }
                if b[i] == c {
                    if b.get(i + 1) == Some(&c) {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            i += 1;
            out.push_str(" '' ");
        } else if c == '$' {
            let rest: String = b[i..].iter().take(64).collect();
            let tag_len = rest[1..].find('$').filter(|&k| {
                rest[1..1 + k]
                    .chars()
                    .all(|ch| ch.is_alphanumeric() || ch == '_')
            });
            match tag_len {
                Some(k) => {
                    let tag: String = b[i..i + k + 2].iter().collect();
                    let body: String = b[i + k + 2..].iter().collect();
                    let end = body
                        .find(&tag)
                        .map(|e| i + k + 2 + body[..e].chars().count() + tag.chars().count())
                        .unwrap_or(b.len());
                    i = end;
                    out.push_str(" '' ");
                }
                None => {
                    out.push(c);
                    i += 1;
                }
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod readonly_tests {
    use super::*;

    #[test]
    fn rejects_known_bypasses() {
        let pg = Driver::Postgres;
        for bad in [
            "SELECT * INTO newtab FROM users",
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity",
            "SELECT pg_read_file('/etc/passwd')",
            "select lo_import('/etc/passwd')",
            "SELECT 1; DROP TABLE x",
            "SELECT E'\\'' ; DROP TABLE x; -- '",
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
            "EXPLAIN ANALYZE DELETE FROM t",
            "DO $$BEGIN EXECUTE 'DROP TABLE t'; END$$",
            "SELECT * FROM t /*! ; DROP TABLE t */",
            "SELECT pg_sleep(100)",
            "SELECT dblink_exec('x','DROP TABLE y')",
            "UPDATE t SET a = 1",
        ] {
            assert!(
                check_readonly_text(pg, bad).is_err(),
                "should reject: {bad}"
            );
        }
        assert!(
            check_readonly_text(Driver::Mysql, "SELECT * FROM t INTO OUTFILE '/tmp/x'").is_err()
        );
        assert!(check_readonly_text(Driver::Mysql, "SELECT SLEEP(10)").is_err());
    }

    #[test]
    fn allows_normal_reads() {
        let pg = Driver::Postgres;
        for ok in [
            "SELECT * FROM orders WHERE status = 'drop table' ORDER BY id",
            "SELECT replace(name, 'a', 'b') FROM customers",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "select c.country, count(*) from customers c group by 1 -- update later",
            "EXPLAIN SELECT 1",
            r#"SELECT "update" FROM t"#,
        ] {
            assert!(
                check_readonly_text(pg, ok).is_ok(),
                "should allow: {ok}: {:?}",
                check_readonly_text(pg, ok)
            );
        }
    }
}
