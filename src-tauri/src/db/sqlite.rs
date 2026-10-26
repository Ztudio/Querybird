//! SQLite: a local database file opened in-process (no server, users or network).
//! `ConnectionConfig::database` holds the file path; "schemas" are the attached databases (`main`).

use std::path::PathBuf;
use std::time::{Duration, Instant};

use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::types::ValueRef;
use rusqlite::{Batch, Connection, OpenFlags};

use super::sqlgen::Dialect;
use super::types::*;

const D: Dialect = Dialect(Driver::Sqlite);

/// Expands a leading `~` so paths typed by hand work like in a shell.
pub fn file_path(cfg: &ConnectionConfig) -> Result<PathBuf, String> {
    let raw = cfg.database.trim();
    if raw.is_empty() {
        return Err("Choose a database file".into());
    }
    let home = || std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    let path = match raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        Some(rest) => PathBuf::from(home().ok_or("no home folder")?).join(rest),
        None => PathBuf::from(raw),
    };
    Ok(path)
}

/// Opens an existing file only: a typo in the path must not silently create an empty database.
pub fn connect(cfg: &ConnectionConfig) -> Result<Connection, String> {
    let path = file_path(cfg)?;
    if !path.is_file() {
        return Err(format!("File not found: {}", path.display()));
    }
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(err)?;
    conn.busy_timeout(Duration::from_secs(5)).map_err(err)?;
    conn.execute_batch("PRAGMA foreign_keys = ON")
        .map_err(err)?;
    Ok(conn)
}

/// Creates an empty database file (the "New database…" button).
pub fn create(path: &std::path::Path) -> Result<(), String> {
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    let conn = Connection::open(path).map_err(err)?;
    // Writes the header so the file is a valid database even with no tables yet.
    conn.execute_batch("PRAGMA user_version = 0; VACUUM")
        .map_err(err)
}

pub fn err(e: rusqlite::Error) -> String {
    format!("ERROR: {e}")
}

fn text(v: ValueRef<'_>) -> Option<String> {
    match v {
        ValueRef::Null => None,
        ValueRef::Integer(i) => Some(i.to_string()),
        ValueRef::Real(f) => Some(f.to_string()),
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Some(format!(
            "0x{}",
            b.iter().map(|x| format!("{x:02X}")).collect::<String>()
        )),
    }
}

/// Runs every statement in `sql`, one result per statement, like the server drivers.
pub fn execute(conn: &Connection, sql: &str) -> Result<Vec<QueryResult>, String> {
    let mut out = Vec::new();
    let mut batch = Batch::new(conn, sql);
    loop {
        let started = Instant::now();
        let Some(mut stmt) = batch.next().map_err(err)? else {
            break;
        };
        let n = stmt.column_count();
        if n == 0 {
            stmt.raw_execute().map_err(err)?;
            out.push(QueryResult {
                affected: Some(conn.changes()),
                elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
                ..Default::default()
            });
            continue;
        }
        let columns: Vec<ColumnMeta> = stmt
            .columns()
            .map(|c| ColumnMeta {
                name: c.name().to_string(),
                type_name: c.decl_type().unwrap_or("").to_lowercase(),
            })
            .collect();
        let mut rows = Vec::new();
        let mut q = stmt.raw_query();
        while let Some(row) = q.next().map_err(err)? {
            rows.push((0..n).map(|i| row.get_ref(i).ok().and_then(text)).collect());
        }
        out.push(QueryResult {
            columns,
            rows,
            affected: None,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        });
    }
    Ok(out)
}

/// Runs one statement that SQLite itself confirms can't write, with `query_only` as a backstop.
pub fn execute_readonly(conn: &Connection, sql: &str) -> Result<Vec<QueryResult>, String> {
    {
        let stmt = conn
            .prepare(sql)
            .map_err(|e| format!("Not a single valid statement: {}", err(e)))?;
        if !stmt.readonly() {
            return Err("Not a read-only query".into());
        }
    }
    conn.execute_batch("PRAGMA query_only = ON").map_err(err)?;
    let res = execute(conn, sql);
    let _ = conn.execute_batch("PRAGMA query_only = OFF");
    res
}

pub fn run_statements(
    conn: &Connection,
    statements: &[String],
    transaction: bool,
) -> Result<(), String> {
    if transaction {
        conn.execute_batch("BEGIN").map_err(err)?;
    }
    for st in statements {
        if let Err(e) = conn.execute_batch(st) {
            if transaction {
                let _ = conn.execute_batch("ROLLBACK");
            }
            return Err(format!("{}\n\n{st}", err(e)));
        }
    }
    if transaction {
        conn.execute_batch("COMMIT").map_err(err)?;
    }
    Ok(())
}

fn rows(conn: &Connection, sql: &str) -> Result<Vec<Vec<Option<String>>>, String> {
    Ok(execute(conn, sql)?
        .pop()
        .map(|r| r.rows)
        .unwrap_or_default()
        .into_iter()
        .map(|mut row| {
            if row.len() < 16 {
                row.resize(16, None);
            }
            row
        })
        .collect())
}

fn s(v: &Option<String>) -> String {
    v.clone().unwrap_or_default()
}

/// `sqlite_master` of one attached database.
fn master(schema: &str) -> String {
    format!("{}.sqlite_master", D.ident(schema))
}

const NOT_INTERNAL: &str = "name NOT LIKE 'sqlite!_%' ESCAPE '!'";

pub fn server_version(conn: &Connection) -> String {
    rows(conn, "SELECT sqlite_version()")
        .ok()
        .and_then(|r| r.first().and_then(|r| r[0].clone()))
        .unwrap_or_default()
}

pub fn list_schemas(conn: &Connection) -> Result<Vec<String>, String> {
    let r = rows(
        conn,
        "SELECT name FROM pragma_database_list WHERE name <> 'temp' ORDER BY seq",
    )?;
    Ok(r.iter().map(|r| s(&r[0])).collect())
}

pub fn set_schema(conn: &Connection, schema: &str) -> Result<(), String> {
    if list_schemas(conn)?.iter().any(|s| s == schema) {
        Ok(())
    } else {
        Err(format!("No attached database named {schema}"))
    }
}

pub fn list_objects(conn: &Connection, schema: &str) -> Result<ObjectList, String> {
    let r = rows(
        conn,
        &format!(
            "SELECT name, type FROM {} WHERE type IN ('table', 'view') AND {NOT_INTERNAL} ORDER BY name",
            master(schema)
        ),
    )?;
    let mut out = ObjectList::default();
    for row in r {
        match row[1].as_deref() {
            Some("view") => out.views.push(s(&row[0])),
            _ => out.tables.push(s(&row[0])),
        }
    }
    Ok(out)
}

pub fn structure(conn: &Connection, schema: &str, table: &str) -> Result<TableStructure, String> {
    let (ls, lt) = (D.literal(schema), D.literal(table));
    let cols = rows(
        conn,
        &format!(
            "SELECT cid + 1, name, type, \"notnull\", dflt_value, pk, hidden \
             FROM pragma_table_xinfo({lt}, {ls}) ORDER BY cid"
        ),
    )?;
    // Single-column foreign keys; a NULL target column means the referenced table's primary key.
    let fks = rows(
        conn,
        &format!(
            "SELECT f.\"from\", f.\"table\", COALESCE(f.\"to\", \
                    (SELECT p.name FROM pragma_table_info(f.\"table\", {ls}) p WHERE p.pk = 1)) \
             FROM pragma_foreign_key_list({lt}, {ls}) f \
             WHERE (SELECT COUNT(*) FROM pragma_foreign_key_list({lt}, {ls}) g WHERE g.id = f.id) = 1"
        ),
    )?;
    let idx = rows(
        conn,
        &format!(
            "SELECT l.name, l.\"unique\", l.origin, \
                    (SELECT group_concat(COALESCE(x.name, '<expression>'), ', ') FROM \
                       (SELECT name FROM pragma_index_xinfo(l.name, {ls}) WHERE key = 1 ORDER BY seqno) x), \
                    l.partial, m.sql \
             FROM pragma_index_list({lt}, {ls}) l \
             LEFT JOIN {} m ON m.type = 'index' AND m.name = l.name \
             ORDER BY l.origin = 'pk' DESC, l.name",
            master(schema)
        ),
    )?;

    let mut pk: Vec<(i64, String)> = cols
        .iter()
        .filter_map(|r| {
            let n: i64 = s(&r[5]).parse().unwrap_or(0);
            (n > 0).then(|| (n, s(&r[1])))
        })
        .collect();
    pk.sort();
    let primary_key: Vec<String> = pk.into_iter().map(|(_, n)| n).collect();
    let columns = cols
        .iter()
        .map(|r| {
            let name = s(&r[1]);
            ColumnInfo {
                position: s(&r[0]).parse().unwrap_or(0),
                is_primary: primary_key.contains(&name),
                foreign: fks.iter().find(|f| s(&f[0]) == name).map(|f| ForeignRef {
                    schema: schema.to_string(),
                    table: s(&f[1]),
                    column: s(&f[2]),
                }),
                data_type: s(&r[2]),
                nullable: r[3].as_deref() != Some("1"),
                default: r[4].clone(),
                comment: None,
                extra: match r[6].as_deref() {
                    Some("2") | Some("3") => Some("generated".into()),
                    _ => None,
                },
                name,
            }
        })
        .collect();
    let indexes = idx
        .iter()
        .map(|r| {
            let sql = s(&r[5]);
            // Partial indexes keep their WHERE clause only in the CREATE INDEX text.
            let condition = (r[4].as_deref() == Some("1"))
                .then(|| {
                    sql.to_uppercase()
                        .rfind(" WHERE ")
                        .map(|i| sql[i + 7..].trim().to_string())
                })
                .flatten();
            IndexInfo {
                name: s(&r[0]),
                algorithm: "BTREE".into(),
                unique: r[1].as_deref() == Some("1"),
                primary: r[2].as_deref() == Some("pk"),
                columns: s(&r[3]),
                condition,
            }
        })
        .collect();
    Ok(TableStructure {
        columns,
        indexes,
        primary_key,
    })
}

pub fn table_info(
    conn: &Connection,
    schema: &str,
    table: &str,
) -> Result<Vec<(String, String)>, String> {
    let r = rows(
        conn,
        &format!(
            "SELECT t.type, t.ncol, CASE t.wr WHEN 1 THEN 'yes' ELSE 'no' END, \
                    CASE t.strict WHEN 1 THEN 'yes' ELSE 'no' END, \
                    (SELECT COUNT(*) FROM {}) \
             FROM pragma_table_list({}) t WHERE t.schema = {}",
            D.table(schema, table),
            D.literal(table),
            D.literal(schema)
        ),
    )?;
    let r = r.into_iter().next().unwrap_or_default();
    let labels = ["type", "columns", "without_rowid", "strict", "rows"];
    Ok(labels
        .iter()
        .enumerate()
        .map(|(i, l)| {
            (
                l.to_string(),
                r.get(i).cloned().flatten().unwrap_or_else(|| "NULL".into()),
            )
        })
        .collect())
}

/// SQLite keeps the original CREATE text, so the DDL is exact (table first, then its indexes and triggers).
pub fn ddl(conn: &Connection, schema: &str, table: &str) -> Result<String, String> {
    let r = rows(
        conn,
        &format!(
            "SELECT sql FROM {} WHERE tbl_name = {} AND sql IS NOT NULL \
             ORDER BY type IN ('table', 'view') DESC, type, name",
            master(schema),
            D.literal(table)
        ),
    )?;
    Ok(r.iter()
        .map(|r| format!("{};", s(&r[0])))
        .collect::<Vec<_>>()
        .join("\n\n"))
}

pub fn overview_sql(schema: &str) -> String {
    format!(
        "SELECT m.name, m.type, t.ncol AS columns, \
                CASE t.wr WHEN 1 THEN 'yes' ELSE 'no' END AS without_rowid, \
                CASE t.strict WHEN 1 THEN 'yes' ELSE 'no' END AS strict \
         FROM {} m LEFT JOIN pragma_table_list t ON t.schema = {} AND t.name = m.name \
         WHERE m.type IN ('table', 'view') AND m.{NOT_INTERNAL} ORDER BY m.name",
        master(schema),
        D.literal(schema)
    )
}

/// Columns and single-column foreign keys of every table, for the AI schema context.
pub fn schema_context_sql(schema: &str) -> (String, String) {
    let ls = D.literal(schema);
    (
        format!(
            "SELECT m.name, p.name, p.type, CASE WHEN p.\"notnull\" THEN 'false' ELSE 'true' END, \
                    CASE WHEN p.pk > 0 THEN 'true' ELSE 'false' END, \
                    CASE m.type WHEN 'view' THEN 'v' ELSE 'r' END \
             FROM {} m JOIN pragma_table_info(m.name, {ls}) p \
             WHERE m.type IN ('table', 'view') AND m.{NOT_INTERNAL} ORDER BY m.name, p.cid",
            master(schema)
        ),
        format!(
            "SELECT m.name, f.\"from\", f.\"table\", f.\"to\" \
             FROM {} m JOIN pragma_foreign_key_list(m.name, {ls}) f \
             WHERE m.type = 'table' ORDER BY 1, 2",
            master(schema)
        ),
    )
}

/// Copies the database to `dest` (consistent snapshot, compacted).
pub fn backup(cfg: &ConnectionConfig, dest: &str) -> Result<String, String> {
    let conn = connect(cfg)?;
    let dest_path = std::path::Path::new(dest);
    // The save dialog already confirmed overwriting; VACUUM INTO refuses existing files.
    if dest_path.exists() {
        std::fs::remove_file(dest_path).map_err(|e| format!("{dest}: {e}"))?;
    }
    if dest.to_lowercase().ends_with(".sql") {
        return Err("SQLite backups are database files; choose a .sqlite or .db file name".into());
    }
    conn.execute(&format!("VACUUM INTO {}", D.literal(dest)), [])
        .map_err(err)?;
    Ok(String::new())
}

/// Restores from a SQL script (run in one transaction) or replaces the contents with another
/// SQLite database file.
pub fn restore(cfg: &ConnectionConfig, src: &str) -> Result<String, String> {
    let mut conn = connect(cfg)?;
    if src.to_lowercase().ends_with(".sql") {
        let bytes = std::fs::read(src).map_err(|e| format!("{src}: {e}"))?;
        let script = String::from_utf8_lossy(&bytes);
        conn.execute_batch("BEGIN").map_err(err)?;
        if let Err(e) = conn.execute_batch(&script) {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(err(e));
        }
        conn.execute_batch("COMMIT").map_err(err)?;
    } else {
        conn.restore(
            rusqlite::MAIN_DB,
            src,
            None::<fn(rusqlite::backup::Progress)>,
        )
        .map_err(err)?;
    }
    Ok(String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(path: &std::path::Path) -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "name": "t", "driver": "sqlite", "host": "", "port": 0,
            "database": path.display().to_string(),
        }))
        .unwrap()
    }

    #[test]
    fn round_trip() {
        let dir = std::env::temp_dir().join(format!("qb-sqlite-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        assert!(
            connect(&cfg(&path)).is_err(),
            "missing file must not be created"
        );
        create(&path).unwrap();
        let c = connect(&cfg(&path)).unwrap();
        let res = execute(
            &c,
            "CREATE TABLE a (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'x', b BLOB);
             CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id));
             CREATE UNIQUE INDEX a_name ON a(name) WHERE name <> '';
             INSERT INTO a (name, b) VALUES ('one', x'00FF'), ('two', NULL);
             SELECT * FROM a ORDER BY id;",
        )
        .unwrap();
        assert_eq!(res.len(), 5);
        assert_eq!(res[3].affected, Some(2));
        let sel = &res[4];
        assert_eq!(sel.columns[1].type_name, "text");
        assert_eq!(
            sel.rows[0],
            vec![Some("1".into()), Some("one".into()), Some("0x00FF".into())]
        );
        assert_eq!(sel.rows[1][2], None);

        assert_eq!(list_schemas(&c).unwrap(), vec!["main".to_string()]);
        let objs = list_objects(&c, "main").unwrap();
        assert_eq!(objs.tables, vec!["a".to_string(), "b".to_string()]);

        let st = structure(&c, "main", "a").unwrap();
        assert_eq!(st.primary_key, vec!["id".to_string()]);
        assert!(!st.columns[1].nullable);
        assert_eq!(st.columns[1].default.as_deref(), Some("'x'"));
        let ix = st.indexes.iter().find(|i| i.name == "a_name").unwrap();
        assert!(ix.unique);
        assert_eq!(ix.columns, "name");
        assert_eq!(ix.condition.as_deref(), Some("name <> ''"));
        let fk = structure(&c, "main", "b").unwrap().columns[1]
            .foreign
            .clone()
            .unwrap();
        assert_eq!((fk.table.as_str(), fk.column.as_str()), ("a", "id"));

        assert!(ddl(&c, "main", "a").unwrap().starts_with("CREATE TABLE a"));
        let info = table_info(&c, "main", "a").unwrap();
        assert!(info.contains(&("rows".into(), "2".into())));

        assert!(execute_readonly(&c, "SELECT COUNT(*) FROM a").is_ok());
        assert!(execute_readonly(&c, "DELETE FROM a").is_err());
        assert!(execute_readonly(&c, "SELECT 1; DELETE FROM a").is_err());

        let bad = vec![
            "INSERT INTO a (name) VALUES ('three')".to_string(),
            "INSERT INTO nope VALUES (1)".to_string(),
        ];
        assert!(run_statements(&c, &bad, true).is_err());
        assert_eq!(
            rows(&c, "SELECT COUNT(*) FROM a").unwrap()[0][0].as_deref(),
            Some("2")
        );

        let copy = dir.join("copy.sqlite");
        backup(&cfg(&path), &copy.display().to_string()).unwrap();
        execute(&c, "DELETE FROM b; DELETE FROM a").unwrap();
        restore(&cfg(&path), &copy.display().to_string()).unwrap();
        assert_eq!(
            rows(&c, "SELECT COUNT(*) FROM a").unwrap()[0][0].as_deref(),
            Some("2")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn through_session() {
        use crate::db::Session;
        let dir = std::env::temp_dir().join(format!("qb-sqlite-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.db");
        create(&path).unwrap();
        let s = Session::open("t".into(), cfg(&path), None).await.unwrap();
        assert_eq!(s.info().await.schema, "main");
        s.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO t (note) VALUES ('50% off'), ('plain'), (NULL);")
            .await
            .unwrap();
        let page = s
            .fetch_table(&TableQuery {
                schema: "main".into(),
                table: "t".into(),
                limit: 2,
                offset: 0,
                filters: vec![Filter {
                    column: "note".into(),
                    op: "CONTAINS".into(),
                    value: "%".into(),
                }],
                raw_where: None,
                order_by: None,
                order_desc: false,
                sorts: vec![],
            })
            .await
            .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.result.columns[0].type_name, "INTEGER");
        let change = Change {
            kind: ChangeKind::Update,
            schema: "main".into(),
            table: "t".into(),
            key: vec![CellValue {
                column: "id".into(),
                value: Some("2".into()),
                default: false,
            }],
            values: vec![CellValue {
                column: "note".into(),
                value: Some("it's".into()),
                default: false,
            }],
        };
        s.apply_changes(&[change]).await.unwrap();
        let hits = s.search("main", "it's").await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(
            s.search("main", "_").await.unwrap().len(),
            0,
            "LIKE wildcards are escaped"
        );
        assert_eq!(
            s.overview("main").await.unwrap().rows[0][0].as_deref(),
            Some("t")
        );
        let ctx = crate::ai::schema_context(&s).await.unwrap();
        assert!(ctx.contains("note"), "{ctx}");
        assert!(s.kill_process("1").await.is_err());
        assert!(s.list_users().await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
