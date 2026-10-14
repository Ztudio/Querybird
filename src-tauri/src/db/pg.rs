use std::time::{Duration, Instant};

use tokio_postgres::{Client, SimpleQueryMessage};

use super::sqlgen::Dialect;
use super::types::*;

const D: Dialect = Dialect(Driver::Postgres);

pub async fn connect(cfg: &ConnectionConfig, password: Option<&str>) -> Result<Client, String> {
    let mut pc = tokio_postgres::Config::new();
    pc.host(if cfg.host.is_empty() {
        "127.0.0.1"
    } else {
        &cfg.host
    })
    .port(if cfg.port == 0 { 5432 } else { cfg.port })
    .user(if cfg.user.is_empty() {
        "postgres"
    } else {
        &cfg.user
    })
    .application_name("Querybird")
    .connect_timeout(Duration::from_secs(10));
    if !cfg.database.is_empty() {
        pc.dbname(&cfg.database);
    }
    if let Some(pw) = password.filter(|p| !p.is_empty()) {
        pc.password(pw);
    }

    match cfg.ssl_mode {
        SslMode::Disable => {
            pc.ssl_mode(tokio_postgres::config::SslMode::Disable);
            let (client, conn) = pc.connect(tokio_postgres::NoTls).await.map_err(err)?;
            tokio::spawn(async move {
                let _ = conn.await;
            });
            Ok(client)
        }
        mode => {
            pc.ssl_mode(if mode == SslMode::Prefer {
                tokio_postgres::config::SslMode::Prefer
            } else {
                tokio_postgres::config::SslMode::Require
            });
            // PREFERRED/REQUIRED encrypt without verifying the certificate (like most GUI clients);
            // VERIFY-FULL checks the chain against the system trust store and the hostname.
            let verify = mode == SslMode::VerifyFull;
            let tls = native_tls::TlsConnector::builder()
                .danger_accept_invalid_certs(!verify)
                .danger_accept_invalid_hostnames(!verify)
                .build()
                .map_err(|e| e.to_string())?;
            let tls = postgres_native_tls::MakeTlsConnector::new(tls);
            let (client, conn) = pc.connect(tls).await.map_err(err)?;
            tokio::spawn(async move {
                let _ = conn.await;
            });
            Ok(client)
        }
    }
}

pub fn err(e: tokio_postgres::Error) -> String {
    if let Some(db) = e.as_db_error() {
        let mut s = format!("ERROR: {}", db.message());
        if let Some(d) = db.detail() {
            s.push_str(&format!("\nDETAIL: {d}"));
        }
        if let Some(h) = db.hint() {
            s.push_str(&format!("\nHINT: {h}"));
        }
        return s;
    }
    let mut msg = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src {
        msg.push_str(&format!(": {s}"));
        src = s.source();
    }
    msg
}

/// Runs SQL through the simple query protocol so every value arrives as text.
/// Column types are looked up via a prepare when the SQL is a single statement.
pub async fn execute(client: &Client, sql: &str) -> Result<Vec<QueryResult>, String> {
    let started = Instant::now();
    let types: Option<Vec<String>> = client.prepare(sql).await.ok().map(|st| {
        st.columns()
            .iter()
            .map(|c| c.type_().name().to_string())
            .collect()
    });

    let messages = client.simple_query(sql).await.map_err(err)?;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;

    let mut out: Vec<QueryResult> = Vec::new();
    let mut current: Option<QueryResult> = None;
    for m in messages {
        match m {
            SimpleQueryMessage::RowDescription(cols) => {
                current = Some(QueryResult {
                    columns: cols
                        .iter()
                        .map(|c| ColumnMeta {
                            name: c.name().to_string(),
                            type_name: String::new(),
                        })
                        .collect(),
                    ..Default::default()
                });
            }
            SimpleQueryMessage::Row(row) => {
                let cur = current.get_or_insert_with(|| QueryResult {
                    columns: row
                        .columns()
                        .iter()
                        .map(|c| ColumnMeta {
                            name: c.name().to_string(),
                            type_name: String::new(),
                        })
                        .collect(),
                    ..Default::default()
                });
                cur.rows.push(
                    (0..row.len())
                        .map(|i| row.get(i).map(str::to_string))
                        .collect(),
                );
            }
            SimpleQueryMessage::CommandComplete(n) => {
                let mut r = current.take().unwrap_or_default();
                if r.columns.is_empty() {
                    r.affected = Some(n);
                }
                r.elapsed_ms = elapsed_ms;
                out.push(r);
            }
            _ => {}
        }
    }
    if let Some(mut r) = current.take() {
        r.elapsed_ms = elapsed_ms;
        out.push(r);
    }
    if let (Some(types), [only]) = (types, out.as_mut_slice()) {
        if types.len() == only.columns.len() {
            for (c, t) in only.columns.iter_mut().zip(types) {
                c.type_name = t;
            }
        }
    }
    Ok(out)
}

async fn rows(client: &Client, sql: &str) -> Result<Vec<Vec<Option<String>>>, String> {
    let mut res = execute(client, sql).await?;
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

pub async fn server_version(client: &Client) -> String {
    rows(client, "SHOW server_version")
        .await
        .ok()
        .and_then(|r| r.first().and_then(|r| r[0].clone()))
        .map(|v| v.split_whitespace().next().unwrap_or("").to_string())
        .unwrap_or_default()
}

pub async fn current_schema(client: &Client) -> String {
    rows(client, "SELECT current_schema()")
        .await
        .ok()
        .and_then(|r| r.first().and_then(|r| r[0].clone()))
        .unwrap_or_else(|| "public".into())
}

pub async fn list_schemas(client: &Client) -> Result<Vec<String>, String> {
    let r = rows(
        client,
        "SELECT nspname FROM pg_catalog.pg_namespace \
         WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY nspname",
    )
    .await?;
    Ok(r.iter().map(|r| s(&r[0])).collect())
}

pub async fn set_schema(client: &Client, schema: &str) -> Result<(), String> {
    client
        .batch_execute(&format!("SET search_path TO {}, public", D.ident(schema)))
        .await
        .map_err(err)
}

pub async fn list_objects(client: &Client, schema: &str) -> Result<ObjectList, String> {
    let lit = D.literal(schema);
    let rels = rows(
        client,
        &format!(
            "SELECT c.relname, c.relkind::text FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = {lit} AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname"
        ),
    )
    .await?;
    let funcs = rows(
        client,
        &format!(
            "SELECT DISTINCT p.proname FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = {lit} ORDER BY p.proname"
        ),
    )
    .await?;
    let mut out = ObjectList::default();
    for r in rels {
        match r[1].as_deref() {
            Some("v") | Some("m") => out.views.push(s(&r[0])),
            _ => out.tables.push(s(&r[0])),
        }
    }
    out.functions = funcs.iter().map(|r| s(&r[0])).collect();
    Ok(out)
}

pub async fn structure(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<TableStructure, String> {
    let (ls, lt) = (D.literal(schema), D.literal(table));
    let cols = rows(
        client,
        &format!(
            "SELECT a.attnum::text, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), \
                    (NOT a.attnotnull)::text, pg_catalog.pg_get_expr(d.adbin, d.adrelid), \
                    pg_catalog.col_description(a.attrelid, a.attnum), \
                    CASE WHEN a.attidentity IN ('a','d') THEN 'identity' WHEN a.attgenerated = 's' THEN 'generated' END \
             FROM pg_catalog.pg_attribute a \
             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             WHERE n.nspname = {ls} AND c.relname = {lt} AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum"
        ),
    )
    .await?;
    let pk = rows(
        client,
        &format!(
            "SELECT a.attname FROM pg_catalog.pg_index i \
             JOIN pg_catalog.pg_class c ON c.oid = i.indrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey) \
             WHERE i.indisprimary AND n.nspname = {ls} AND c.relname = {lt} \
             ORDER BY array_position(i.indkey::int2[], a.attnum)"
        ),
    )
    .await?;
    let fks = rows(
        client,
        &format!(
            "SELECT a.attname, fn.nspname, fc.relname, fa.attname \
             FROM pg_catalog.pg_constraint k \
             JOIN pg_catalog.pg_class c ON c.oid = k.conrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             JOIN pg_catalog.pg_class fc ON fc.oid = k.confrelid \
             JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace \
             JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1] \
             JOIN pg_catalog.pg_attribute fa ON fa.attrelid = k.confrelid AND fa.attnum = k.confkey[1] \
             WHERE k.contype = 'f' AND array_length(k.conkey, 1) = 1 AND n.nspname = {ls} AND c.relname = {lt}"
        ),
    )
    .await?;
    let idx = rows(
        client,
        &format!(
            "SELECT ic.relname, am.amname, i.indisunique::text, i.indisprimary::text, \
                    (SELECT string_agg(pg_catalog.pg_get_indexdef(i.indexrelid, k, true), ', ' ORDER BY k) \
                       FROM generate_series(1, i.indnkeyatts) k), \
                    pg_catalog.pg_get_expr(i.indpred, i.indrelid) \
             FROM pg_catalog.pg_index i \
             JOIN pg_catalog.pg_class c ON c.oid = i.indrelid \
             JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             JOIN pg_catalog.pg_am am ON am.oid = ic.relam \
             WHERE n.nspname = {ls} AND c.relname = {lt} ORDER BY i.indisprimary DESC, ic.relname"
        ),
    )
    .await?;

    let primary_key: Vec<String> = pk.iter().map(|r| s(&r[0])).collect();
    let columns = cols
        .iter()
        .map(|r| {
            let name = s(&r[1]);
            ColumnInfo {
                position: s(&r[0]).parse().unwrap_or(0),
                is_primary: primary_key.contains(&name),
                foreign: fks.iter().find(|f| s(&f[0]) == name).map(|f| ForeignRef {
                    schema: s(&f[1]),
                    table: s(&f[2]),
                    column: s(&f[3]),
                }),
                name,
                data_type: s(&r[2]),
                nullable: r[3].as_deref() == Some("true"),
                default: r[4].clone(),
                comment: r[5].clone(),
                extra: r[6].clone(),
            }
        })
        .collect();
    let indexes = idx
        .iter()
        .map(|r| IndexInfo {
            name: s(&r[0]),
            algorithm: s(&r[1]).to_uppercase(),
            unique: r[2].as_deref() == Some("true"),
            primary: r[3].as_deref() == Some("true"),
            columns: s(&r[4]),
            condition: r[5].clone(),
        })
        .collect();
    Ok(TableStructure {
        columns,
        indexes,
        primary_key,
    })
}

pub async fn table_info(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<Vec<(String, String)>, String> {
    let rel = D.literal(&D.table(schema, table));
    let r = rows(
        client,
        &format!(
            "SELECT pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size({rel}::regclass)), \
                    pg_catalog.pg_size_pretty(pg_catalog.pg_relation_size({rel}::regclass)), \
                    pg_catalog.pg_size_pretty(pg_catalog.pg_indexes_size({rel}::regclass)), \
                    (SELECT reltuples::bigint::text FROM pg_catalog.pg_class WHERE oid = {rel}::regclass), \
                    pg_catalog.obj_description({rel}::regclass, 'pg_class')"
        ),
    )
    .await?;
    let r = r.into_iter().next().unwrap_or_default();
    let labels = [
        "total_size",
        "data_size",
        "index_size",
        "estimated_rows",
        "comment",
    ];
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

pub async fn ddl(client: &Client, schema: &str, table: &str) -> Result<String, String> {
    // Postgres has no SHOW CREATE TABLE; assemble a reasonable approximation.
    let st = structure(client, schema, table).await?;
    let mut lines: Vec<String> = st
        .columns
        .iter()
        .map(|c| {
            let mut l = format!("  {} {}", D.ident(&c.name), c.data_type);
            if !c.nullable {
                l.push_str(" NOT NULL");
            }
            if let Some(d) = &c.default {
                l.push_str(&format!(" DEFAULT {d}"));
            }
            l
        })
        .collect();
    if !st.primary_key.is_empty() {
        let pk = st
            .primary_key
            .iter()
            .map(|c| D.ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("  PRIMARY KEY ({pk})"));
    }
    let mut out = format!(
        "CREATE TABLE {} (\n{}\n);",
        D.table(schema, table),
        lines.join(",\n")
    );
    let defs = rows(
        client,
        &format!(
            "SELECT indexdef FROM pg_catalog.pg_indexes WHERE schemaname = {} AND tablename = {} \
             AND indexname NOT IN (SELECT conname FROM pg_catalog.pg_constraint WHERE contype IN ('p'))",
            D.literal(schema),
            D.literal(table)
        ),
    )
    .await?;
    for d in defs {
        out.push_str(&format!("\n{};", s(&d[0])));
    }
    Ok(out)
}

pub const PROCESS_LIST: &str =
    "SELECT pid, usename, datname, client_addr, state, now() - query_start AS duration, query \
     FROM pg_stat_activity ORDER BY query_start DESC NULLS LAST";
