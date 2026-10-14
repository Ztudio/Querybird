//! Dialect-aware SQL generation for table browsing and edits.

use super::types::{Change, ChangeKind, Driver, Filter, TableQuery};

#[derive(Clone, Copy, Debug)]
pub struct Dialect(pub Driver);

impl Dialect {
    pub fn ident(&self, name: &str) -> String {
        match self.0 {
            Driver::Postgres => format!("\"{}\"", name.replace('"', "\"\"")),
            Driver::Mysql => format!("`{}`", name.replace('`', "``")),
        }
    }

    /// String literal that is safe regardless of server/session settings:
    /// - Postgres: `E'…'` escape-string syntax (correct whether `standard_conforming_strings` is on or off).
    /// - MySQL: `_utf8mb4 X'…'` hex string (immune to `NO_BACKSLASH_ESCAPES` and multi-byte client charsets).
    pub fn literal(&self, value: &str) -> String {
        match self.0 {
            Driver::Postgres => format!("E'{}'", value.replace('\\', "\\\\").replace('\'', "''")),
            Driver::Mysql => {
                if value.is_empty() {
                    "''".into()
                } else {
                    let hex: String = value.bytes().map(|b| format!("{b:02X}")).collect();
                    format!("_utf8mb4 X'{hex}'")
                }
            }
        }
    }

    pub fn value(&self, value: &Option<String>) -> String {
        match value {
            None => "NULL".into(),
            Some(v) => self.literal(v),
        }
    }

    fn cell(&self, c: &super::types::CellValue) -> String {
        if c.default {
            "DEFAULT".into()
        } else {
            self.value(&c.value)
        }
    }

    pub fn table(&self, schema: &str, table: &str) -> String {
        if schema.is_empty() {
            self.ident(table)
        } else {
            format!("{}.{}", self.ident(schema), self.ident(table))
        }
    }

    fn as_text(&self, col: &str) -> String {
        match self.0 {
            Driver::Postgres => format!("CAST({} AS TEXT)", col),
            Driver::Mysql => col.to_string(),
        }
    }

    fn like(&self) -> &'static str {
        match self.0 {
            Driver::Postgres => "ILIKE",
            Driver::Mysql => "LIKE",
        }
    }

    /// LIKE pattern with `!` as an explicit escape character (no backslash semantics involved).
    fn like_pattern(&self, prefix: &str, value: &str, suffix: &str) -> String {
        let escaped = value
            .replace('!', "!!")
            .replace('%', "!%")
            .replace('_', "!_");
        format!(
            "{} ESCAPE {}",
            self.literal(&format!("{prefix}{escaped}{suffix}")),
            self.literal("!")
        )
    }

    pub fn filter(&self, f: &Filter) -> Option<String> {
        if f.column.is_empty() {
            return None;
        }
        let col = self.ident(&f.column);
        let v = f.value.as_str();
        let list = || {
            v.split(',')
                .map(|s| self.literal(s.trim()))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let sql = match f.op.as_str() {
            "=" | "<>" | "<" | ">" | "<=" | ">=" => format!("{col} {} {}", f.op, self.literal(v)),
            "IN" => format!("{col} IN ({})", list()),
            "NOT IN" => format!("{col} NOT IN ({})", list()),
            "IS NULL" => format!("{col} IS NULL"),
            "IS NOT NULL" => format!("{col} IS NOT NULL"),
            "LIKE" => format!("{col} LIKE {}", self.literal(v)),
            "NOT LIKE" => format!("{col} NOT LIKE {}", self.literal(v)),
            "CONTAINS" => format!(
                "{} {} {}",
                self.as_text(&col),
                self.like(),
                self.like_pattern("%", v, "%")
            ),
            "NOT CONTAINS" => format!(
                "{} NOT {} {}",
                self.as_text(&col),
                self.like(),
                self.like_pattern("%", v, "%")
            ),
            "BEGINS WITH" => format!(
                "{} {} {}",
                self.as_text(&col),
                self.like(),
                self.like_pattern("", v, "%")
            ),
            "ENDS WITH" => format!(
                "{} {} {}",
                self.as_text(&col),
                self.like(),
                self.like_pattern("%", v, "")
            ),
            "BETWEEN" => {
                let mut parts = v.splitn(2, ',').map(str::trim);
                let a = parts.next().unwrap_or("");
                let b = parts.next().unwrap_or("");
                format!("{col} BETWEEN {} AND {}", self.literal(a), self.literal(b))
            }
            _ => return None,
        };
        Some(sql)
    }

    fn where_clause(&self, q: &TableQuery) -> String {
        let mut parts: Vec<String> = q.filters.iter().filter_map(|f| self.filter(f)).collect();
        if let Some(raw) = q
            .raw_where
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            parts.push(format!("({raw})"));
        }
        if parts.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", parts.join(" AND "))
        }
    }

    /// Returns (page select, count) statements.
    /// `default_order` (usually the primary key) keeps paging stable when no sort is chosen.
    pub fn select_page(&self, q: &TableQuery, default_order: &[String]) -> (String, String) {
        let table = self.table(&q.schema, &q.table);
        let wh = self.where_clause(q);
        let order = match &q.order_by {
            _ if !q.sorts.is_empty() => format!(
                " ORDER BY {}",
                q.sorts
                    .iter()
                    .map(|s| format!(
                        "{} {}",
                        self.ident(&s.column),
                        if s.desc { "DESC" } else { "ASC" }
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Some(c) if !c.is_empty() => {
                format!(
                    " ORDER BY {} {}",
                    self.ident(c),
                    if q.order_desc { "DESC" } else { "ASC" }
                )
            }
            _ if !default_order.is_empty() => {
                format!(
                    " ORDER BY {}",
                    default_order
                        .iter()
                        .map(|c| self.ident(c))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }
            _ => String::new(),
        };
        (
            format!(
                "SELECT * FROM {table}{wh}{order} LIMIT {} OFFSET {}",
                q.limit, q.offset
            ),
            format!("SELECT COUNT(*) FROM {table}{wh}"),
        )
    }

    fn key_clause(&self, c: &Change) -> String {
        c.key
            .iter()
            .map(|k| match &k.value {
                None => format!("{} IS NULL", self.ident(&k.column)),
                Some(v) => format!("{} = {}", self.ident(&k.column), self.literal(v)),
            })
            .collect::<Vec<_>>()
            .join(" AND ")
    }

    pub fn change(&self, c: &Change) -> Result<String, String> {
        let table = self.table(&c.schema, &c.table);
        match c.kind {
            ChangeKind::Update => {
                if c.values.is_empty() {
                    return Err("update has no values".into());
                }
                if c.key.is_empty() {
                    return Err("update has no row key".into());
                }
                let sets = c
                    .values
                    .iter()
                    .map(|v| format!("{} = {}", self.ident(&v.column), self.cell(v)))
                    .collect::<Vec<_>>()
                    .join(", ");
                let limit = if matches!(self.0, Driver::Mysql) {
                    " LIMIT 1"
                } else {
                    ""
                };
                Ok(format!(
                    "UPDATE {table} SET {sets} WHERE {}{limit};",
                    self.key_clause(c)
                ))
            }
            ChangeKind::Delete => {
                if c.key.is_empty() {
                    return Err("delete has no row key".into());
                }
                let limit = if matches!(self.0, Driver::Mysql) {
                    " LIMIT 1"
                } else {
                    ""
                };
                Ok(format!(
                    "DELETE FROM {table} WHERE {}{limit};",
                    self.key_clause(c)
                ))
            }
            ChangeKind::Insert => {
                if c.values.is_empty() {
                    return Ok(match self.0 {
                        Driver::Postgres => format!("INSERT INTO {table} DEFAULT VALUES;"),
                        Driver::Mysql => format!("INSERT INTO {table} () VALUES ();"),
                    });
                }
                let cols = c
                    .values
                    .iter()
                    .map(|v| self.ident(&v.column))
                    .collect::<Vec<_>>()
                    .join(", ");
                let vals = c
                    .values
                    .iter()
                    .map(|v| self.cell(v))
                    .collect::<Vec<_>>()
                    .join(", ");
                Ok(format!("INSERT INTO {table} ({cols}) VALUES ({vals});"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::types::CellValue;

    fn cv(c: &str, v: Option<&str>) -> CellValue {
        CellValue {
            column: c.into(),
            value: v.map(String::from),
            default: false,
        }
    }

    #[test]
    fn quoting() {
        let pg = Dialect(Driver::Postgres);
        let my = Dialect(Driver::Mysql);
        assert_eq!(pg.ident("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(my.ident("we`ird"), "`we``ird`");
        assert_eq!(pg.literal("it's \\"), "E'it''s \\\\'");
        assert_eq!(my.literal("a'"), "_utf8mb4 X'6127'");
        assert_eq!(my.literal(""), "''");
    }

    #[test]
    fn page_sql() {
        let pg = Dialect(Driver::Postgres);
        let q = TableQuery {
            schema: "public".into(),
            table: "orders".into(),
            limit: 300,
            offset: 300,
            filters: vec![
                Filter {
                    column: "status".into(),
                    op: "=".into(),
                    value: "paid".into(),
                },
                Filter {
                    column: "id".into(),
                    op: "IN".into(),
                    value: "1, 2".into(),
                },
                Filter {
                    column: "note".into(),
                    op: "CONTAINS".into(),
                    value: "50%".into(),
                },
            ],
            raw_where: Some("qty > 1".into()),
            order_by: Some("id".into()),
            order_desc: true,
            sorts: vec![],
        };
        let (sel, count) = pg.select_page(&q, &[]);
        assert_eq!(
            sel,
            "SELECT * FROM \"public\".\"orders\" WHERE \"status\" = E'paid' AND \"id\" IN (E'1', E'2') AND CAST(\"note\" AS TEXT) ILIKE E'%50!%%' ESCAPE E'!' AND (qty > 1) ORDER BY \"id\" DESC LIMIT 300 OFFSET 300"
        );
        assert!(count.starts_with("SELECT COUNT(*) FROM \"public\".\"orders\" WHERE"));
        let plain = TableQuery {
            filters: vec![],
            raw_where: None,
            order_by: None,
            ..q
        };
        let (sel, _) = pg.select_page(&plain, &["a".into(), "b".into()]);
        assert!(
            sel.ends_with("ORDER BY \"a\", \"b\" LIMIT 300 OFFSET 300"),
            "{sel}"
        );
        let multi = TableQuery {
            sorts: vec![
                crate::db::types::SortSpec {
                    column: "x".into(),
                    desc: true,
                },
                crate::db::types::SortSpec {
                    column: "y".into(),
                    desc: false,
                },
            ],
            ..plain
        };
        let (sel, _) = pg.select_page(&multi, &["a".into()]);
        assert!(
            sel.contains("ORDER BY \"x\" DESC, \"y\" ASC LIMIT"),
            "{sel}"
        );
    }

    #[test]
    fn changes() {
        let my = Dialect(Driver::Mysql);
        let up = Change {
            kind: ChangeKind::Update,
            schema: "shop".into(),
            table: "orders".into(),
            key: vec![cv("id", Some("4"))],
            values: vec![cv("status", Some("paid")), cv("note", None)],
        };
        assert_eq!(
            my.change(&up).unwrap(),
            "UPDATE `shop`.`orders` SET `status` = _utf8mb4 X'70616964', `note` = NULL WHERE `id` = _utf8mb4 X'34' LIMIT 1;"
        );
        let pg = Dialect(Driver::Postgres);
        let ins = Change {
            kind: ChangeKind::Insert,
            schema: "public".into(),
            table: "t".into(),
            key: vec![],
            values: vec![],
        };
        assert_eq!(
            pg.change(&ins).unwrap(),
            "INSERT INTO \"public\".\"t\" DEFAULT VALUES;"
        );
        let del = Change {
            kind: ChangeKind::Delete,
            schema: "public".into(),
            table: "t".into(),
            key: vec![cv("a", None), cv("b", Some("x"))],
            values: vec![],
        };
        assert_eq!(
            pg.change(&del).unwrap(),
            "DELETE FROM \"public\".\"t\" WHERE \"a\" IS NULL AND \"b\" = E'x';"
        );
        let mut d = cv("created", None);
        d.default = true;
        let up = Change {
            kind: ChangeKind::Update,
            schema: "public".into(),
            table: "t".into(),
            key: vec![cv("id", Some("1"))],
            values: vec![d],
        };
        assert_eq!(
            pg.change(&up).unwrap(),
            "UPDATE \"public\".\"t\" SET \"created\" = DEFAULT WHERE \"id\" = E'1';"
        );
    }
}
