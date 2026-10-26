//! User / role management: list accounts, create, alter, drop, and grant access with presets.
//! Statements are generated here (not in the webview) so names and passwords are always quoted
//! correctly, and passwords are masked in everything shown or logged.

use serde::{Deserialize, Serialize};

use super::sqlgen::Dialect;
use super::types::Driver;
use super::{Session, NO_SERVER};

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbUser {
    pub name: String,
    /// MySQL account host (`%`, `localhost`, …); empty for Postgres roles.
    pub host: String,
    pub superuser: bool,
    pub can_login: bool,
    pub create_db: bool,
    pub create_role: bool,
    pub locked: bool,
    pub conn_limit: Option<i64>,
    pub valid_until: Option<String>,
    /// Postgres roles this role is a member of.
    pub member_of: Vec<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UserSpec {
    pub name: String,
    #[serde(default)]
    pub host: String,
    /// New password; `None` or empty leaves it unchanged.
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub superuser: bool,
    #[serde(default = "yes")]
    pub can_login: bool,
    #[serde(default)]
    pub create_db: bool,
    #[serde(default)]
    pub create_role: bool,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub conn_limit: Option<i64>,
    /// Postgres `VALID UNTIL` timestamp; empty means no expiry.
    #[serde(default)]
    pub valid_until: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    ReadOnly,
    ReadWrite,
    All,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum UserAction {
    Create {
        user: UserSpec,
    },
    #[serde(rename_all = "camelCase")]
    Alter {
        name: String,
        #[serde(default)]
        host: String,
        user: UserSpec,
    },
    Drop {
        name: String,
        #[serde(default)]
        host: String,
    },
    /// MySQL: `database` is a database name or `*`. Postgres: privileges on `schema` in the
    /// connected database `database`.
    Grant {
        name: String,
        #[serde(default)]
        host: String,
        database: String,
        #[serde(default)]
        schema: String,
        level: Access,
        #[serde(default)]
        revoke: bool,
    },
    /// Postgres role membership (GRANT role TO user).
    Membership {
        name: String,
        role: String,
        #[serde(default)]
        revoke: bool,
    },
    /// A new database for the user: owned by it on Postgres, all privileges on MySQL.
    CreateDatabase {
        name: String,
        #[serde(default)]
        host: String,
        database: String,
    },
}

const MASK: &str = "'********'";

fn check_database_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Database name is required".into());
    }
    if name.contains('\0') || name.contains('/') || name.contains('\\') || name.contains('.') {
        return Err("Database names can't contain / \\ . or NUL".into());
    }
    Ok(())
}

fn check_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("User name is required".into());
    }
    if name.contains('\0') {
        return Err("User name can't contain NUL".into());
    }
    Ok(())
}

/// MySQL string for `IDENTIFIED BY`, which takes a plain quoted string (no hex/introducer forms).
fn my_string(v: &str, no_backslash_escapes: bool) -> String {
    let v = if no_backslash_escapes {
        v.to_string()
    } else {
        v.replace('\\', "\\\\")
    };
    format!("'{}'", v.replace('\'', "''"))
}

struct Gen {
    driver: Driver,
    /// Replace passwords with a mask (for previews and the console log).
    masked: bool,
    no_backslash_escapes: bool,
}

impl Gen {
    fn d(&self) -> Dialect {
        Dialect(self.driver)
    }

    fn account(&self, name: &str, host: &str) -> String {
        let host = if host.is_empty() { "%" } else { host };
        format!("{}@{}", self.d().ident(name), self.d().ident(host))
    }

    fn password(&self, pw: &str) -> String {
        if self.masked {
            MASK.into()
        } else if self.driver == Driver::Mysql {
            my_string(pw, self.no_backslash_escapes)
        } else {
            self.d().literal(pw)
        }
    }

    fn pg_options(&self, u: &UserSpec) -> String {
        let flag = |on: bool, name: &str| {
            if on {
                name.to_string()
            } else {
                format!("NO{name}")
            }
        };
        let mut out = format!(
            "{} {} {} {} CONNECTION LIMIT {}",
            flag(u.can_login, "LOGIN"),
            flag(u.superuser, "SUPERUSER"),
            flag(u.create_db, "CREATEDB"),
            flag(u.create_role, "CREATEROLE"),
            u.conn_limit.unwrap_or(-1).max(-1)
        );
        if let Some(pw) = u.password.as_deref().filter(|p| !p.is_empty()) {
            out.push_str(&format!(" PASSWORD {}", self.password(pw)));
        }
        match u.valid_until.as_deref().map(str::trim) {
            Some(v) if !v.is_empty() => {
                out.push_str(&format!(" VALID UNTIL {}", self.d().literal(v)))
            }
            _ => out.push_str(" VALID UNTIL 'infinity'"),
        }
        out
    }

    fn statements(&self, action: &UserAction) -> Result<Vec<String>, String> {
        let d = self.d();
        let mut out = Vec::new();
        match (self.driver, action) {
            (Driver::Sqlite, _) => return Err(NO_SERVER.into()),

            (Driver::Postgres, UserAction::Create { user }) => {
                check_name(&user.name)?;
                out.push(format!(
                    "CREATE ROLE {} WITH {};",
                    d.ident(&user.name),
                    self.pg_options(user)
                ));
            }
            (Driver::Postgres, UserAction::Alter { name, user, .. }) => {
                check_name(&user.name)?;
                if *name != user.name {
                    out.push(format!(
                        "ALTER ROLE {} RENAME TO {};",
                        d.ident(name),
                        d.ident(&user.name)
                    ));
                }
                out.push(format!(
                    "ALTER ROLE {} WITH {};",
                    d.ident(&user.name),
                    self.pg_options(user)
                ));
            }
            (Driver::Postgres, UserAction::Drop { name, .. }) => {
                check_name(name)?;
                let r = d.ident(name);
                // A role that owns objects or holds privileges can't be dropped; hand its objects
                // to the current user first (this covers the connected database).
                out.push(format!("REASSIGN OWNED BY {r} TO CURRENT_USER;"));
                out.push(format!("DROP OWNED BY {r};"));
                out.push(format!("DROP ROLE {r};"));
            }
            (
                Driver::Postgres,
                UserAction::Grant {
                    name,
                    database,
                    schema,
                    level,
                    revoke,
                    ..
                },
            ) => {
                check_name(name)?;
                if schema.is_empty() {
                    return Err("Choose a schema".into());
                }
                let (r, s) = (d.ident(name), d.ident(schema));
                if *revoke {
                    out.push(format!("REVOKE ALL ON ALL TABLES IN SCHEMA {s} FROM {r};"));
                    out.push(format!(
                        "REVOKE ALL ON ALL SEQUENCES IN SCHEMA {s} FROM {r};"
                    ));
                    out.push(format!(
                        "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA {s} FROM {r};"
                    ));
                    out.push(format!("REVOKE ALL ON SCHEMA {s} FROM {r};"));
                    out.push(format!(
                        "ALTER DEFAULT PRIVILEGES IN SCHEMA {s} REVOKE ALL ON TABLES FROM {r};"
                    ));
                    out.push(format!(
                        "ALTER DEFAULT PRIVILEGES IN SCHEMA {s} REVOKE ALL ON SEQUENCES FROM {r};"
                    ));
                    return Ok(out);
                }
                let (tables, seqs) = match level {
                    Access::ReadOnly => ("SELECT", "SELECT"),
                    Access::ReadWrite => ("SELECT, INSERT, UPDATE, DELETE", "USAGE, SELECT"),
                    Access::All => ("ALL PRIVILEGES", "ALL PRIVILEGES"),
                };
                if !database.is_empty() {
                    let db_privs = if *level == Access::All {
                        "ALL PRIVILEGES"
                    } else {
                        "CONNECT"
                    };
                    out.push(format!(
                        "GRANT {db_privs} ON DATABASE {} TO {r};",
                        d.ident(database)
                    ));
                }
                let schema_privs = if *level == Access::All {
                    "ALL PRIVILEGES"
                } else {
                    "USAGE"
                };
                out.push(format!("GRANT {schema_privs} ON SCHEMA {s} TO {r};"));
                out.push(format!(
                    "GRANT {tables} ON ALL TABLES IN SCHEMA {s} TO {r};"
                ));
                out.push(format!(
                    "GRANT {seqs} ON ALL SEQUENCES IN SCHEMA {s} TO {r};"
                ));
                if *level != Access::ReadOnly {
                    out.push(format!(
                        "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA {s} TO {r};"
                    ));
                }
                // Tables created later (by the current user) get the same access.
                out.push(format!(
                    "ALTER DEFAULT PRIVILEGES IN SCHEMA {s} GRANT {tables} ON TABLES TO {r};"
                ));
                out.push(format!(
                    "ALTER DEFAULT PRIVILEGES IN SCHEMA {s} GRANT {seqs} ON SEQUENCES TO {r};"
                ));
            }
            (Driver::Postgres, UserAction::Membership { name, role, revoke }) => {
                check_name(name)?;
                check_name(role)?;
                out.push(if *revoke {
                    format!("REVOKE {} FROM {};", d.ident(role), d.ident(name))
                } else {
                    format!("GRANT {} TO {};", d.ident(role), d.ident(name))
                });
            }

            (Driver::Mysql, UserAction::Create { user }) => {
                check_name(&user.name)?;
                let acct = self.account(&user.name, &user.host);
                let auth = match user.password.as_deref().filter(|p| !p.is_empty()) {
                    Some(pw) => format!(" IDENTIFIED BY {}", self.password(pw)),
                    None => String::new(),
                };
                let lock = if user.locked { " ACCOUNT LOCK" } else { "" };
                out.push(format!("CREATE USER {acct}{auth}{lock};"));
                if user.superuser {
                    out.push(format!(
                        "GRANT ALL PRIVILEGES ON *.* TO {acct} WITH GRANT OPTION;"
                    ));
                }
            }
            (Driver::Mysql, UserAction::Alter { name, host, user }) => {
                check_name(&user.name)?;
                let old = self.account(name, host);
                let acct = self.account(&user.name, &user.host);
                if old != acct {
                    out.push(format!("RENAME USER {old} TO {acct};"));
                }
                let auth = match user.password.as_deref().filter(|p| !p.is_empty()) {
                    Some(pw) => format!(" IDENTIFIED BY {}", self.password(pw)),
                    None => String::new(),
                };
                let lock = if user.locked {
                    "ACCOUNT LOCK"
                } else {
                    "ACCOUNT UNLOCK"
                };
                out.push(format!("ALTER USER {acct}{auth} {lock};"));
            }
            (Driver::Mysql, UserAction::Drop { name, host }) => {
                check_name(name)?;
                out.push(format!("DROP USER {};", self.account(name, host)));
            }
            (
                Driver::Mysql,
                UserAction::Grant {
                    name,
                    host,
                    database,
                    level,
                    revoke,
                    ..
                },
            ) => {
                check_name(name)?;
                let acct = self.account(name, host);
                let on = match database.as_str() {
                    "" => return Err("Choose a database".into()),
                    "*" => "*.*".to_string(),
                    db => format!("{}.*", d.ident(db)),
                };
                if *revoke {
                    out.push(format!("REVOKE ALL PRIVILEGES ON {on} FROM {acct};"));
                    return Ok(out);
                }
                let privs = match level {
                    Access::ReadOnly => "SELECT, SHOW VIEW",
                    Access::ReadWrite => "SELECT, INSERT, UPDATE, DELETE, SHOW VIEW, CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE",
                    Access::All => "ALL PRIVILEGES",
                };
                out.push(format!("GRANT {privs} ON {on} TO {acct};"));
            }
            (Driver::Mysql, UserAction::Membership { .. }) => {
                return Err("Role membership is managed with GRANT on MySQL".into())
            }
            (Driver::Postgres, UserAction::CreateDatabase { name, database, .. }) => {
                check_name(name)?;
                check_database_name(database)?;
                out.push(format!(
                    "CREATE DATABASE {} OWNER {};",
                    d.ident(database),
                    d.ident(name)
                ));
            }
            (
                Driver::Mysql,
                UserAction::CreateDatabase {
                    name,
                    host,
                    database,
                },
            ) => {
                check_name(name)?;
                check_database_name(database)?;
                let db = d.ident(database);
                out.push(format!("CREATE DATABASE {db};"));
                out.push(format!(
                    "GRANT ALL PRIVILEGES ON {db}.* TO {};",
                    self.account(name, host)
                ));
            }
        }
        Ok(out)
    }
}

fn flag(v: &Option<String>) -> bool {
    matches!(v.as_deref(), Some("t" | "true" | "Y" | "y" | "1"))
}

impl Session {
    async fn no_backslash_escapes(&self) -> bool {
        self.scalar("SELECT @@SESSION.sql_mode")
            .await
            .is_some_and(|m| m.to_uppercase().contains("NO_BACKSLASH_ESCAPES"))
    }

    pub async fn list_users(&self) -> Result<Vec<DbUser>, String> {
        let rows = |sql: &'static str| async move {
            self.execute(sql)
                .await
                .map(|mut r| r.pop().map(|r| r.rows).unwrap_or_default())
        };
        match self.config.driver {
            Driver::Sqlite => Err(NO_SERVER.into()),
            Driver::Postgres => {
                let r = rows(
                    "SELECT r.rolname, r.rolsuper::text, r.rolcanlogin::text, r.rolcreatedb::text, \
                            r.rolcreaterole::text, r.rolconnlimit::text, r.rolvaliduntil::text, \
                            COALESCE((SELECT string_agg(g.rolname, ',' ORDER BY g.rolname) \
                                      FROM pg_catalog.pg_auth_members m \
                                      JOIN pg_catalog.pg_roles g ON g.oid = m.roleid \
                                      WHERE m.member = r.oid), '') \
                     FROM pg_catalog.pg_roles r WHERE r.rolname !~ '^pg_' ORDER BY r.rolname",
                )
                .await?;
                Ok(r.into_iter()
                    .map(|mut r| {
                        r.resize(8, None);
                        DbUser {
                            name: r[0].clone().unwrap_or_default(),
                            host: String::new(),
                            superuser: flag(&r[1]),
                            can_login: flag(&r[2]),
                            create_db: flag(&r[3]),
                            create_role: flag(&r[4]),
                            locked: false,
                            conn_limit: r[5].as_deref().and_then(|v| v.parse().ok()),
                            valid_until: r[6].clone().filter(|v| v != "infinity"),
                            member_of: r[7]
                                .as_deref()
                                .unwrap_or("")
                                .split(',')
                                .filter(|s| !s.is_empty())
                                .map(String::from)
                                .collect(),
                        }
                    })
                    .collect())
            }
            Driver::Mysql => {
                // account_locked appeared in MySQL 5.7 / MariaDB 10.4; fall back without it.
                let r = match rows(
                    "SELECT User, Host, Super_priv, account_locked FROM mysql.user ORDER BY User, Host",
                )
                .await
                {
                    Ok(r) => r,
                    Err(_) => {
                        rows("SELECT User, Host, Super_priv, 'N' FROM mysql.user ORDER BY User, Host")
                            .await?
                    }
                };
                Ok(r.into_iter()
                    .map(|mut r| {
                        r.resize(4, None);
                        DbUser {
                            name: r[0].clone().unwrap_or_default(),
                            host: r[1].clone().unwrap_or_default(),
                            superuser: flag(&r[2]),
                            can_login: true,
                            locked: flag(&r[3]),
                            ..Default::default()
                        }
                    })
                    .collect())
            }
        }
    }

    /// Human-readable list of what the account may do (SHOW GRANTS / Postgres ACLs in this database).
    pub async fn user_grants(&self, name: &str, host: &str) -> Result<Vec<String>, String> {
        let d = self.dialect();
        let sql = match self.config.driver {
            Driver::Sqlite => return Err(NO_SERVER.into()),
            Driver::Mysql => format!(
                "SHOW GRANTS FOR {}",
                Gen {
                    driver: Driver::Mysql,
                    masked: true,
                    no_backslash_escapes: false
                }
                .account(name, host)
            ),
            Driver::Postgres => {
                let r = d.literal(name);
                format!(
                    "WITH me AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = {r}) \
                     SELECT 'DATABASE ' || quote_ident(db.datname) || ': ' || \
                            string_agg(DISTINCT a.privilege_type, ', ') \
                       FROM pg_catalog.pg_database db, aclexplode(db.datacl) a, me \
                      WHERE a.grantee = me.oid GROUP BY db.datname \
                     UNION ALL \
                     SELECT 'SCHEMA ' || quote_ident(n.nspname) || ': ' || \
                            string_agg(DISTINCT a.privilege_type, ', ') \
                       FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) a, me \
                      WHERE a.grantee = me.oid GROUP BY n.nspname \
                     UNION ALL \
                     SELECT CASE c.relkind WHEN 'S' THEN 'SEQUENCE ' WHEN 'v' THEN 'VIEW ' ELSE 'TABLE ' END || \
                            quote_ident(n.nspname) || '.' || quote_ident(c.relname) || ': ' || \
                            string_agg(DISTINCT a.privilege_type, ', ') \
                       FROM pg_catalog.pg_class c \
                       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace, \
                            aclexplode(c.relacl) a, me \
                      WHERE a.grantee = me.oid AND c.relkind IN ('r','p','v','m','S','f') \
                      GROUP BY c.relkind, n.nspname, c.relname \
                     ORDER BY 1 LIMIT 1000"
                )
            }
        };
        let rows = self
            .execute(&sql)
            .await?
            .pop()
            .map(|r| r.rows)
            .unwrap_or_default();
        Ok(rows
            .into_iter()
            .filter_map(|r| r.into_iter().next().flatten())
            .collect())
    }

    async fn generator(&self, masked: bool) -> Gen {
        let no_backslash_escapes =
            self.config.driver == Driver::Mysql && !masked && self.no_backslash_escapes().await;
        Gen {
            driver: self.config.driver,
            masked,
            no_backslash_escapes,
        }
    }

    /// The statements an action will run, with passwords masked.
    pub async fn user_preview(&self, action: &UserAction) -> Result<Vec<String>, String> {
        self.generator(true).await.statements(action)
    }

    /// Runs an action (one transaction on Postgres) and returns the masked statements for the log.
    pub async fn user_apply(&self, action: &UserAction) -> Result<Vec<String>, String> {
        let real = self.generator(false).await.statements(action)?;
        let shown = self.user_preview(action).await?;
        // CREATE DATABASE can't run inside a transaction block on Postgres.
        let transaction = self.config.driver == Driver::Postgres
            && !matches!(action, UserAction::CreateDatabase { .. });
        self.run_statements(&real, transaction)
            .await
            .map_err(|e| {
                // Error messages echo the failing statement; never echo a password.
                match real
                    .iter()
                    .zip(&shown)
                    .find(|(r, _)| e.contains(r.as_str()))
                {
                    Some((r, s)) => e.replace(r.as_str(), s),
                    None => e,
                }
            })
            .map_err(|e| explain_permission(self.config.driver, &self.config.user, e))?;
        Ok(shown)
    }
}

/// Adds what to do when the logged-in account lacks the privilege a user action needs.
fn explain_permission(driver: Driver, login: &str, e: String) -> String {
    let lower = e.to_lowercase();
    let who = if login.is_empty() {
        "This connection's account"
    } else {
        login
    };
    let hint = if lower.contains("permission denied to create role")
        || lower.contains("permission denied to alter role")
        || lower.contains("permission denied to drop role")
    {
        format!(
            "{who} isn't allowed to manage roles. Edit the connection to log in as an admin \
             (postgres, or your RDS master user), or have an admin run: ALTER ROLE \"{who}\" CREATEROLE;"
        )
    } else if lower.contains("permission denied to create database") {
        format!("{who} isn't allowed to create databases. Log in as an admin, or have one run: ALTER ROLE \"{who}\" CREATEDB;")
    } else if driver == Driver::Mysql && lower.contains("create user privilege") {
        format!("{who} isn't allowed to create users. Log in as root, or have an admin run: GRANT CREATE USER ON *.* TO {who};")
    } else {
        return e;
    };
    format!("{e}\n\n{hint}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, pw: Option<&str>) -> UserSpec {
        UserSpec {
            name: name.into(),
            host: String::new(),
            password: pw.map(String::from),
            superuser: false,
            can_login: true,
            create_db: true,
            create_role: false,
            locked: false,
            conn_limit: None,
            valid_until: None,
        }
    }

    fn gen(driver: Driver, masked: bool) -> Gen {
        Gen {
            driver,
            masked,
            no_backslash_escapes: false,
        }
    }

    #[test]
    fn postgres_statements() {
        let g = gen(Driver::Postgres, false);
        let create = UserAction::Create {
            user: spec("app\"user", Some("p'w")),
        };
        assert_eq!(
            g.statements(&create).unwrap(),
            vec!["CREATE ROLE \"app\"\"user\" WITH LOGIN NOSUPERUSER CREATEDB NOCREATEROLE CONNECTION LIMIT -1 PASSWORD E'p''w' VALID UNTIL 'infinity';"]
        );
        let masked = gen(Driver::Postgres, true).statements(&create).unwrap();
        assert!(masked[0].contains("PASSWORD '********'") && !masked[0].contains("p''w"));

        let alter = UserAction::Alter {
            name: "old".into(),
            host: String::new(),
            user: spec("new", None),
        };
        let st = g.statements(&alter).unwrap();
        assert_eq!(st[0], "ALTER ROLE \"old\" RENAME TO \"new\";");
        assert!(!st[1].contains("PASSWORD"));

        let grant = UserAction::Grant {
            name: "ro".into(),
            host: String::new(),
            database: "shop".into(),
            schema: "public".into(),
            level: Access::ReadOnly,
            revoke: false,
        };
        let st = g.statements(&grant).unwrap();
        assert_eq!(st[0], "GRANT CONNECT ON DATABASE \"shop\" TO \"ro\";");
        assert!(
            st.contains(&"GRANT SELECT ON ALL TABLES IN SCHEMA \"public\" TO \"ro\";".to_string())
        );
        assert!(!st.iter().any(|s| s.contains("INSERT")));
    }

    #[test]
    fn mysql_statements() {
        let g = gen(Driver::Mysql, false);
        let mut u = spec("app`x", Some("a'b\\c"));
        u.host = "localhost".into();
        let st = g.statements(&UserAction::Create { user: u }).unwrap();
        assert_eq!(
            st,
            vec!["CREATE USER `app``x`@`localhost` IDENTIFIED BY 'a''b\\\\c';"]
        );
        let nb = Gen {
            no_backslash_escapes: true,
            ..gen(Driver::Mysql, false)
        };
        assert!(nb
            .statements(&UserAction::Create {
                user: spec("u", Some("a\\b"))
            })
            .unwrap()[0]
            .contains("IDENTIFIED BY 'a\\b'"));

        let grant = UserAction::Grant {
            name: "u".into(),
            host: String::new(),
            database: "shop".into(),
            schema: String::new(),
            level: Access::ReadWrite,
            revoke: false,
        };
        assert!(
            g.statements(&grant).unwrap()[0].starts_with("GRANT SELECT, INSERT, UPDATE, DELETE")
        );
        assert!(g.statements(&grant).unwrap()[0].ends_with("ON `shop`.* TO `u`@`%`;"));
        let drop = UserAction::Drop {
            name: "u".into(),
            host: "10.0.0.%".into(),
        };
        assert_eq!(
            g.statements(&drop).unwrap(),
            vec!["DROP USER `u`@`10.0.0.%`;"]
        );
    }

    #[test]
    fn create_database_for_user() {
        let pg = gen(Driver::Postgres, false);
        let a = UserAction::CreateDatabase {
            name: "app".into(),
            host: String::new(),
            database: "app_db".into(),
        };
        assert_eq!(
            pg.statements(&a).unwrap(),
            vec!["CREATE DATABASE \"app_db\" OWNER \"app\";"]
        );
        let my = gen(Driver::Mysql, false).statements(&a).unwrap();
        assert_eq!(
            my,
            vec![
                "CREATE DATABASE `app_db`;",
                "GRANT ALL PRIVILEGES ON `app_db`.* TO `app`@`%`;"
            ]
        );
        let bad = UserAction::CreateDatabase {
            name: "app".into(),
            host: String::new(),
            database: "a/b".into(),
        };
        assert!(pg.statements(&bad).is_err());
    }

    #[test]
    fn permission_errors_say_what_to_do() {
        let e = explain_permission(
            Driver::Postgres,
            "app",
            "ERROR: permission denied to create role".into(),
        );
        assert!(e.contains("ALTER ROLE \"app\" CREATEROLE"), "{e}");
        assert_eq!(
            explain_permission(Driver::Postgres, "app", "ERROR: other".into()),
            "ERROR: other"
        );
    }

    #[test]
    fn sqlite_has_no_users() {
        assert!(gen(Driver::Sqlite, true)
            .statements(&UserAction::Drop {
                name: "x".into(),
                host: String::new()
            })
            .is_err());
    }
}
