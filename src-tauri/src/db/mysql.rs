use std::time::Instant;

use mysql_async::consts::ColumnType;
use mysql_async::prelude::*;
use mysql_async::{Conn, OptsBuilder, Row, SslOpts, Value};

use super::sqlgen::Dialect;
use super::types::*;

const D: Dialect = Dialect(Driver::Mysql);

fn opts(cfg: &ConnectionConfig, password: Option<&str>, ssl: bool) -> OptsBuilder {
    let verify = cfg.ssl_mode == SslMode::VerifyFull;
    let mut o = OptsBuilder::default()
        .ip_or_hostname(if cfg.host.is_empty() {
            "127.0.0.1".to_string()
        } else {
            cfg.host.clone()
        })
        .tcp_port(if cfg.port == 0 { 3306 } else { cfg.port })
        .user(Some(if cfg.user.is_empty() {
            "root".to_string()
        } else {
            cfg.user.clone()
        }))
        .pass(password.filter(|p| !p.is_empty()).map(String::from))
        .db_name(Some(cfg.database.clone()).filter(|d| !d.is_empty()))
        .prefer_socket(false);
    if ssl {
        o = o.ssl_opts(Some(
            SslOpts::default()
                .with_danger_accept_invalid_certs(!verify)
                .with_danger_skip_domain_validation(!verify),
        ));
    }
    o
}

pub async fn connect(cfg: &ConnectionConfig, password: Option<&str>) -> Result<Conn, String> {
    let fut = async {
        match cfg.ssl_mode {
            SslMode::Disable => Conn::new(opts(cfg, password, false)).await.map_err(err),
            SslMode::Require | SslMode::VerifyFull => {
                Conn::new(opts(cfg, password, true)).await.map_err(err)
            }
            SslMode::Prefer => match Conn::new(opts(cfg, password, true)).await {
                Ok(c) => Ok(c),
                Err(_) => Conn::new(opts(cfg, password, false)).await.map_err(err),
            },
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(10), fut)
        .await
        .map_err(|_| "connection timed out".to_string())?
}

pub fn err(e: mysql_async::Error) -> String {
    match e {
        mysql_async::Error::Server(s) => format!("ERROR {} ({}): {}", s.code, s.state, s.message),
        other => other.to_string(),
    }
}

fn value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::NULL => None,
        Value::Bytes(b) => Some(String::from_utf8_lossy(b).into_owned()),
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(f) => Some(f.to_string()),
        Value::Date(y, mo, d, h, mi, s, us) => Some(if *us > 0 {
            format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}")
        } else {
            format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
        }),
        Value::Time(neg, d, h, m, s, us) => {
            let hours = *d as u64 * 24 + *h as u64;
            let sign = if *neg { "-" } else { "" };
            Some(if *us > 0 {
                format!("{sign}{hours:02}:{m:02}:{s:02}.{us:06}")
            } else {
                format!("{sign}{hours:02}:{m:02}:{s:02}")
            })
        }
    }
}

fn type_name(t: ColumnType) -> String {
    let raw = format!("{t:?}");
    raw.trim_start_matches("MYSQL_TYPE_").to_lowercase()
}

/// Runs SQL over the text protocol; supports multiple result sets.
pub async fn execute(conn: &mut Conn, sql: &str) -> Result<Vec<QueryResult>, String> {
    let started = Instant::now();
    let mut result = conn.query_iter(sql).await.map_err(err)?;
    let mut out = Vec::new();
    loop {
        let columns: Vec<ColumnMeta> = result
            .columns()
            .map(|cols| {
                cols.iter()
                    .map(|c| ColumnMeta {
                        name: c.name_str().into_owned(),
                        type_name: type_name(c.column_type()),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let rows: Vec<Row> = result.collect().await.map_err(err)?;
        let affected = result.affected_rows();
        let has_columns = !columns.is_empty();
        out.push(QueryResult {
            columns,
            rows: rows
                .into_iter()
                .map(|r| r.unwrap().iter().map(value_to_string).collect())
                .collect(),
            affected: if has_columns { None } else { Some(affected) },
            elapsed_ms: 0.0,
        });
        if result.is_empty() {
            break;
        }
    }
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    for r in &mut out {
        r.elapsed_ms = elapsed_ms;
    }
    Ok(out)
}

async fn rows(conn: &mut Conn, sql: &str) -> Result<Vec<Vec<Option<String>>>, String> {
    let mut res = execute(conn, sql).await?;
    // Pad short rows so indexing can't panic on a malformed server response.
    Ok(res
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

pub async fn server_version(conn: &mut Conn) -> String {
    rows(conn, "SELECT VERSION()")
        .await
        .ok()
        .and_then(|r| r.first().and_then(|r| r[0].clone()))
        .unwrap_or_default()
}

pub async fn current_schema(conn: &mut Conn) -> String {
    rows(conn, "SELECT DATABASE()")
        .await
        .ok()
        .and_then(|r| r.first().and_then(|r| r[0].clone()))
        .unwrap_or_default()
}

pub async fn list_schemas(conn: &mut Conn) -> Result<Vec<String>, String> {
    let r = rows(conn, "SHOW DATABASES").await?;
    Ok(r.iter().map(|r| s(&r[0])).collect())
}

pub async fn set_schema(conn: &mut Conn, schema: &str) -> Result<(), String> {
    conn.query_drop(format!("USE {}", D.ident(schema)))
        .await
        .map_err(err)
}

pub async fn list_objects(conn: &mut Conn, schema: &str) -> Result<ObjectList, String> {
    let lit = D.literal(schema);
    let rels = rows(
        conn,
        &format!(
            "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = {lit} ORDER BY TABLE_NAME"
        ),
    )
    .await?;
    let funcs = rows(
        conn,
        &format!(
            "SELECT ROUTINE_NAME FROM information_schema.ROUTINES \
             WHERE ROUTINE_SCHEMA = {lit} ORDER BY ROUTINE_NAME"
        ),
    )
    .await?;
    let mut out = ObjectList::default();
    for r in rels {
        if r[1].as_deref() == Some("VIEW") {
            out.views.push(s(&r[0]));
        } else {
            out.tables.push(s(&r[0]));
        }
    }
    out.functions = funcs.iter().map(|r| s(&r[0])).collect();
    Ok(out)
}

pub async fn structure(
    conn: &mut Conn,
    schema: &str,
    table: &str,
) -> Result<TableStructure, String> {
    let (ls, lt) = (D.literal(schema), D.literal(table));
    let cols = rows(
        conn,
        &format!(
            "SELECT ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, \
                    COLUMN_COMMENT, COLUMN_KEY, EXTRA \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = {ls} AND TABLE_NAME = {lt} \
             ORDER BY ORDINAL_POSITION"
        ),
    )
    .await?;
    let fks = rows(
        conn,
        &format!(
            "SELECT COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = {ls} AND TABLE_NAME = {lt} AND REFERENCED_TABLE_NAME IS NOT NULL"
        ),
    )
    .await?;
    let idx = rows(
        conn,
        &format!(
            "SELECT INDEX_NAME, INDEX_TYPE, NON_UNIQUE, \
                    GROUP_CONCAT(COALESCE(COLUMN_NAME, EXPRESSION) ORDER BY SEQ_IN_INDEX SEPARATOR ', ') \
             FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = {ls} AND TABLE_NAME = {lt} \
             GROUP BY INDEX_NAME, INDEX_TYPE, NON_UNIQUE \
             ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME"
        ),
    )
    .await?;

    let mut primary_key = Vec::new();
    let columns = cols
        .iter()
        .map(|r| {
            let name = s(&r[1]);
            let is_primary = r[6].as_deref() == Some("PRI");
            if is_primary {
                primary_key.push(name.clone());
            }
            ColumnInfo {
                position: s(&r[0]).parse().unwrap_or(0),
                is_primary,
                foreign: fks.iter().find(|f| s(&f[0]) == name).map(|f| ForeignRef {
                    schema: s(&f[1]),
                    table: s(&f[2]),
                    column: s(&f[3]),
                }),
                name,
                data_type: s(&r[2]),
                nullable: r[3].as_deref() == Some("YES"),
                default: mysql_default_sql(r[4].as_deref(), r[7].as_deref()),
                comment: r[5].clone().filter(|c| !c.is_empty()),
                extra: r[7].clone().filter(|c| !c.is_empty()),
            }
        })
        .collect();
    // PRIMARY index lists columns in key order; prefer it.
    if let Some(p) = idx.iter().find(|r| r[0].as_deref() == Some("PRIMARY")) {
        primary_key = s(&p[3]).split(", ").map(String::from).collect();
    }
    let indexes = idx
        .iter()
        .map(|r| IndexInfo {
            name: s(&r[0]),
            algorithm: s(&r[1]),
            unique: r[2].as_deref() == Some("0"),
            primary: r[0].as_deref() == Some("PRIMARY"),
            columns: s(&r[3]),
            condition: None,
        })
        .collect();
    Ok(TableStructure {
        columns,
        indexes,
        primary_key,
    })
}

/// information_schema gives literal defaults unquoted (`pending`); turn them back into SQL so the
/// Structure editor can re-emit them safely: literals are quoted, expressions parenthesised.
fn mysql_default_sql(default: Option<&str>, extra: Option<&str>) -> Option<String> {
    let d = default?;
    let generated = extra.is_some_and(|e| e.to_uppercase().contains("DEFAULT_GENERATED"));
    let upper = d.to_uppercase();
    if upper == "NULL" && !generated {
        return Some("NULL".into());
    }
    if generated {
        let is_now = upper.starts_with("CURRENT_TIMESTAMP")
            || upper.starts_with("NOW(")
            || upper.starts_with("LOCALTIMESTAMP");
        return Some(if is_now {
            d.to_string()
        } else {
            format!("({d})")
        });
    }
    if d.parse::<f64>().is_ok() && !d.is_empty() {
        return Some(d.to_string());
    }
    Some(if d.contains('\\') {
        format!(
            "_utf8mb4 X'{}'",
            d.bytes().map(|b| format!("{b:02X}")).collect::<String>()
        )
    } else {
        format!("'{}'", d.replace('\'', "''"))
    })
}

pub async fn table_info(
    conn: &mut Conn,
    schema: &str,
    table: &str,
) -> Result<Vec<(String, String)>, String> {
    let r = rows(
        conn,
        &format!(
            "SELECT ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, DATA_LENGTH + INDEX_LENGTH, \
                    AUTO_INCREMENT, TABLE_COLLATION, CREATE_TIME, TABLE_COMMENT \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}",
            D.literal(schema),
            D.literal(table)
        ),
    )
    .await?;
    let r = r.into_iter().next().unwrap_or_default();
    let pretty = |v: Option<String>| -> String {
        let Some(n) = v.and_then(|v| v.parse::<f64>().ok()) else {
            return "NULL".into();
        };
        let units = ["bytes", "KB", "MB", "GB", "TB"];
        let mut n = n;
        let mut i = 0;
        while n >= 1024.0 && i < units.len() - 1 {
            n /= 1024.0;
            i += 1;
        }
        if i == 0 {
            format!("{n} {}", units[i])
        } else {
            format!("{n:.0} {}", units[i])
        }
    };
    let get = |i: usize| r.get(i).cloned().flatten();
    Ok(vec![
        ("engine".into(), get(0).unwrap_or_else(|| "NULL".into())),
        (
            "estimated_rows".into(),
            get(1).unwrap_or_else(|| "NULL".into()),
        ),
        ("data_size".into(), pretty(get(2))),
        ("index_size".into(), pretty(get(3))),
        ("total_size".into(), pretty(get(4))),
        (
            "auto_increment".into(),
            get(5).unwrap_or_else(|| "NULL".into()),
        ),
        ("collation".into(), get(6).unwrap_or_else(|| "NULL".into())),
        ("created".into(), get(7).unwrap_or_else(|| "NULL".into())),
        (
            "comment".into(),
            get(8)
                .filter(|c| !c.is_empty())
                .unwrap_or_else(|| "NULL".into()),
        ),
    ])
}

pub async fn ddl(conn: &mut Conn, schema: &str, table: &str) -> Result<String, String> {
    let r = rows(
        conn,
        &format!("SHOW CREATE TABLE {}", D.table(schema, table)),
    )
    .await?;
    Ok(r.into_iter()
        .next()
        .and_then(|r| r.get(1).cloned().flatten())
        .unwrap_or_default()
        + ";")
}

pub const PROCESS_LIST: &str = "SHOW FULL PROCESSLIST";
