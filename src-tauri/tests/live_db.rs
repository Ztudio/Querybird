//! Runs against real databases (see scripts/test-dbs.sh), then:
//!   QUERYBIRD_LIVE_TESTS=1 cargo test --test live_db -- --test-threads=1

use querybird_lib::db::types::*;
use querybird_lib::db::Session;

fn enabled() -> bool {
    std::env::var("QUERYBIRD_LIVE_TESTS").is_ok()
}

fn cfg(driver: Driver) -> ConnectionConfig {
    let (port, user) = match driver {
        Driver::Postgres => (55432, "postgres"),
        Driver::Mysql => (53306, "root"),
    };
    ConnectionConfig {
        id: String::new(),
        name: "test".into(),
        driver,
        host: "127.0.0.1".into(),
        port,
        user: user.into(),
        database: "shop".into(),
        ssl_mode: SslMode::Disable,
        password_mode: PasswordMode::Ask,
        color: String::new(),
        tag: "local".into(),
        group: String::new(),
        bootstrap: String::new(),
        ssh: None,
    }
}

fn cv(c: &str, v: Option<&str>) -> CellValue {
    CellValue {
        column: c.into(),
        value: v.map(String::from),
        default: false,
    }
}

async fn exercise(driver: Driver) {
    let s = Session::open("t".into(), cfg(driver), None)
        .await
        .expect("connect");
    assert!(!s.server_version.is_empty());
    eprintln!("connected to {:?} {}", driver, s.server_version);
    let schema = match driver {
        Driver::Postgres => "public",
        Driver::Mysql => "shop",
    };

    let schemas = s.list_schemas().await.unwrap();
    assert!(schemas.iter().any(|x| x == schema), "{schemas:?}");

    let objs = s.list_objects(schema).await.unwrap();
    for t in ["customers", "orders", "products"] {
        assert!(objs.tables.iter().any(|x| x == t), "missing {t}: {objs:?}");
    }
    assert!(objs.views.iter().any(|x| x == "paid_orders"));
    assert!(!objs.tables.iter().any(|x| x == "paid_orders"));

    let st = s.structure(schema, "orders").await.unwrap();
    // Literal defaults come back as SQL literals (quoted), safe to re-emit in ALTER statements.
    let status_default = st
        .columns
        .iter()
        .find(|c| c.name == "status")
        .unwrap()
        .default
        .clone()
        .unwrap();
    assert!(status_default.starts_with("'pending'"), "{status_default}");
    assert_eq!(st.primary_key, vec!["id".to_string()]);
    let cust = st.columns.iter().find(|c| c.name == "customer_id").unwrap();
    assert_eq!(cust.foreign.as_ref().unwrap().table, "customers");
    assert!(st.indexes.iter().any(|i| i.primary));

    // Paging, filtering, ordering.
    let q = TableQuery {
        schema: schema.into(),
        table: "orders".into(),
        limit: 50,
        offset: 0,
        filters: vec![Filter {
            column: "status".into(),
            op: "=".into(),
            value: "paid".into(),
        }],
        raw_where: None,
        order_by: Some("id".into()),
        order_desc: true,
        sorts: vec![],
    };
    let page = s.fetch_table(&q).await.unwrap();
    let expected: u64 = s
        .execute("SELECT COUNT(*) FROM orders WHERE status = 'paid'")
        .await
        .unwrap()[0]
        .rows[0][0]
        .as_ref()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(page.total, expected);
    assert!(expected > 50);
    assert_eq!(page.result.rows.len(), 50);
    let status_idx = page
        .result
        .columns
        .iter()
        .position(|c| c.name == "status")
        .unwrap();
    assert!(page
        .result
        .rows
        .iter()
        .all(|r| r[status_idx].as_deref() == Some("paid")));
    let id_col = page.result.columns.iter().find(|c| c.name == "id").unwrap();
    assert!(!id_col.type_name.is_empty());
    let first: i64 = page.result.rows[0][0].as_ref().unwrap().parse().unwrap();
    let second: i64 = page.result.rows[1][0].as_ref().unwrap().parse().unwrap();
    assert!(first > second);

    // Ad-hoc SQL with types; NULLs come back as None.
    let res = s
        .execute("SELECT 1 AS one, NULL AS nothing, 'it''s' AS quote")
        .await
        .unwrap();
    let r = &res[0];
    assert_eq!(r.columns[0].name, "one");
    assert_eq!(r.rows[0][0].as_deref(), Some("1"));
    assert_eq!(r.rows[0][1], None);
    assert_eq!(r.rows[0][2].as_deref(), Some("it's"));

    // Edits in a transaction: insert, update, delete, with awkward characters.
    let tricky = "O'Brien \\ \"quoted\" ünïcode";
    let ins = Change {
        kind: ChangeKind::Insert,
        schema: schema.into(),
        table: "customers".into(),
        key: vec![],
        values: vec![
            cv("id", Some("9001")),
            cv("name", Some(tricky)),
            cv("email", None),
        ],
    };
    s.apply_changes(&[ins]).await.unwrap();
    let back = s
        .execute("SELECT name, email FROM customers WHERE id = 9001")
        .await
        .unwrap();
    assert_eq!(back[0].rows[0][0].as_deref(), Some(tricky));
    assert_eq!(back[0].rows[0][1], None);

    let up = Change {
        kind: ChangeKind::Update,
        schema: schema.into(),
        table: "customers".into(),
        key: vec![cv("id", Some("9001"))],
        values: vec![cv("country", Some("NZ"))],
    };
    s.apply_changes(&[up]).await.unwrap();
    let back = s
        .execute("SELECT country FROM customers WHERE id = 9001")
        .await
        .unwrap();
    assert_eq!(back[0].rows[0][0].as_deref(), Some("NZ"));

    // A failing batch rolls back everything before it.
    let good = Change {
        kind: ChangeKind::Update,
        schema: schema.into(),
        table: "customers".into(),
        key: vec![cv("id", Some("9001"))],
        values: vec![cv("country", Some("AU"))],
    };
    let bad = Change {
        kind: ChangeKind::Update,
        schema: schema.into(),
        table: "customers".into(),
        key: vec![cv("id", Some("9001"))],
        values: vec![cv("name", None)], // NOT NULL violation
    };
    assert!(s.apply_changes(&[good, bad]).await.is_err());
    let back = s
        .execute("SELECT country FROM customers WHERE id = 9001")
        .await
        .unwrap();
    assert_eq!(back[0].rows[0][0].as_deref(), Some("NZ"), "rollback failed");

    let del = Change {
        kind: ChangeKind::Delete,
        schema: schema.into(),
        table: "customers".into(),
        key: vec![cv("id", Some("9001"))],
        values: vec![],
    };
    s.apply_changes(&[del]).await.unwrap();
    let back = s
        .execute("SELECT COUNT(*) FROM customers WHERE id = 9001")
        .await
        .unwrap();
    assert_eq!(back[0].rows[0][0].as_deref(), Some("0"));

    // Errors are readable.
    let e = s.execute("SELECT * FROM no_such_table").await.unwrap_err();
    assert!(e.to_lowercase().contains("no_such_table"), "{e}");

    // Non-select reports affected rows.
    let res = s
        .execute("UPDATE products SET stock = stock WHERE id <= 3")
        .await
        .unwrap();
    assert!(res[0].columns.is_empty());
    assert!(res[0].affected.is_some());

    assert!(!s.table_info(schema, "orders").await.unwrap().is_empty());
    assert!(s
        .ddl(schema, "orders")
        .await
        .unwrap()
        .contains("CREATE TABLE"));

    // DEFAULT, multi-column sort, overview, search, transactional DDL batches.
    let mut d = cv("stock", None);
    d.default = true;
    s.apply_changes(&[Change {
        kind: ChangeKind::Update,
        schema: schema.into(),
        table: "products".into(),
        key: vec![cv("id", Some("1"))],
        values: vec![d],
    }])
    .await
    .unwrap();
    let back = s
        .execute("SELECT stock FROM products WHERE id = 1")
        .await
        .unwrap();
    assert_eq!(back[0].rows[0][0].as_deref(), Some("0"));

    let q = TableQuery {
        schema: schema.into(),
        table: "orders".into(),
        limit: 5,
        offset: 0,
        filters: vec![],
        raw_where: None,
        order_by: None,
        order_desc: false,
        sorts: vec![
            SortSpec {
                column: "qty".into(),
                desc: true,
            },
            SortSpec {
                column: "id".into(),
                desc: false,
            },
        ],
    };
    let page = s.fetch_table(&q).await.unwrap();
    assert!(!page.estimated);
    assert!(page.sql.contains("ORDER BY"));
    let qty = page
        .result
        .columns
        .iter()
        .position(|c| c.name == "qty")
        .unwrap();
    let max_qty = s.execute("SELECT MAX(qty) FROM orders").await.unwrap()[0].rows[0][0].clone();
    assert_eq!(page.result.rows[0][qty], max_qty);
    let ids: Vec<i64> = page
        .result
        .rows
        .iter()
        .map(|r| r[0].as_ref().unwrap().parse().unwrap())
        .collect();
    assert!(
        ids.windows(2).all(|w| w[0] < w[1]),
        "ties broken by id asc: {ids:?}"
    );

    let ov = s.overview(schema).await.unwrap();
    assert!(ov.rows.iter().any(|r| r[0].as_deref() == Some("orders")));

    let hits = s.search(schema, "c42@example").await.unwrap();
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(hits[0].table, "customers");
    let n = s
        .execute(&format!(
            "SELECT COUNT(*) FROM customers WHERE {}",
            hits[0].where_sql
        ))
        .await
        .unwrap();
    assert_eq!(n[0].rows[0][0].as_deref(), Some("1"));

    let bad = vec![
        "CREATE TABLE rb_tmp (id INT)".to_string(),
        "INSERT INTO nope VALUES (1)".to_string(),
    ];
    assert!(s.run_statements(&bad, true).await.is_err());
    if driver == Driver::Postgres {
        // Postgres DDL is transactional, so the CREATE must have been rolled back.
        let objs = s.list_objects(schema).await.unwrap();
        assert!(!objs.tables.iter().any(|t| t == "rb_tmp"));
    } else {
        s.execute("DROP TABLE IF EXISTS rb_tmp").await.unwrap();
    }

    // Read-only execution for AI SQL is enforced by the server, not just by text checks.
    let ok = s
        .execute_readonly("SELECT COUNT(*) FROM orders")
        .await
        .unwrap();
    assert!(ok[0].rows[0][0].is_some());
    assert!(s
        .execute_readonly("SELECT 1; DELETE FROM orders")
        .await
        .is_err());
    assert!(s.execute_readonly("DELETE FROM orders").await.is_err());
    if driver == Driver::Postgres {
        s.execute("CREATE OR REPLACE FUNCTION rb_sneaky() RETURNS int LANGUAGE sql AS 'UPDATE products SET stock = stock + 1 WHERE id = 2 RETURNING 1'").await.unwrap();
        let before = s
            .execute("SELECT stock FROM products WHERE id = 2")
            .await
            .unwrap()[0]
            .rows[0][0]
            .clone();
        let e = s.execute_readonly("SELECT rb_sneaky()").await.unwrap_err();
        assert!(e.contains("read-only"), "{e}");
        let after = s
            .execute("SELECT stock FROM products WHERE id = 2")
            .await
            .unwrap()[0]
            .rows[0][0]
            .clone();
        assert_eq!(before, after);
        s.execute("DROP FUNCTION rb_sneaky()").await.unwrap();
    }
    // The session is usable normally afterwards (transaction was rolled back, timeouts reset).
    s.execute("UPDATE products SET stock = stock WHERE id = 1")
        .await
        .unwrap();

    // The AI prompt context lists tables, columns, keys and FKs — never row data.
    let ctx = querybird_lib::ai::schema_context(&s).await.unwrap();
    assert!(ctx.contains("table \"orders\" ("), "{ctx}");
    assert!(
        ctx.contains("\"customer_id\"") && ctx.contains("-> \"customers\".\"id\""),
        "{ctx}"
    );
    assert!(ctx.contains("view \"paid_orders\" ("), "{ctx}");
    assert!(
        !ctx.contains("example.com"),
        "row data leaked into the prompt"
    );

    let mut b = cfg(driver);
    b.bootstrap = match driver {
        Driver::Postgres => "SET application_name = 'rb-bootstrap'".into(),
        Driver::Mysql => "SET @rb_boot = 'rb-bootstrap'".into(),
    };
    let s2 = Session::open("b".into(), b, None).await.unwrap();
    let probe = match driver {
        Driver::Postgres => "SHOW application_name",
        Driver::Mysql => "SELECT @rb_boot",
    };
    assert_eq!(
        s2.execute(probe).await.unwrap()[0].rows[0][0].as_deref(),
        Some("rb-bootstrap")
    );
}

fn ssh_enabled() -> Option<(String, String)> {
    // QUERYBIRD_SSH_TESTS=1 plus the DB host names as seen from inside the SSH container.
    std::env::var("QUERYBIRD_SSH_TESTS").ok()?;
    Some((
        std::env::var("QUERYBIRD_SSH_PG_HOST").unwrap_or_else(|_| "querybird-test-pg".into()),
        std::env::var("QUERYBIRD_SSH_MY_HOST").unwrap_or_else(|_| "querybird-test-my".into()),
    ))
}

fn via_ssh(
    driver: Driver,
    db_host: &str,
    key: Option<String>,
    password: Option<&str>,
) -> ConnectionConfig {
    let mut c = cfg(driver);
    c.host = db_host.into();
    c.port = if driver == Driver::Postgres {
        5432
    } else {
        3306
    };
    c.ssh = Some(SshConfig {
        enabled: true,
        host: "127.0.0.1".into(),
        port: 52222,
        user: "tunnel".into(),
        key_path: key,
        password: password.map(String::from),
        host_key: None,
    });
    c
}

#[tokio::test]
async fn ssh_tunnels() {
    let Some((pg_host, my_host)) = ssh_enabled() else {
        return;
    };
    // Password auth to Postgres.
    let s = Session::open(
        "s1".into(),
        via_ssh(Driver::Postgres, &pg_host, None, Some("tunnelpw")),
        None,
    )
    .await
    .expect("ssh password tunnel");
    let fp = s.tunnel.as_ref().unwrap().fingerprint.clone();
    assert!(fp.starts_with("SHA256:"), "{fp}");
    let r = s.execute("SELECT COUNT(*) FROM customers").await.unwrap();
    assert!(r[0].rows[0][0].as_deref().unwrap().parse::<u64>().unwrap() >= 250);

    // Key auth to MySQL.
    let key = std::env::var("QUERYBIRD_SSH_KEY").expect("QUERYBIRD_SSH_KEY");
    let s = Session::open(
        "s2".into(),
        via_ssh(Driver::Mysql, &my_host, Some(key), None),
        None,
    )
    .await
    .expect("ssh key tunnel");
    assert_eq!(
        s.execute("SELECT 1").await.unwrap()[0].rows[0][0].as_deref(),
        Some("1")
    );

    // Wrong password is rejected.
    let e = Session::open(
        "s3".into(),
        via_ssh(Driver::Postgres, &pg_host, None, Some("nope")),
        None,
    )
    .await;
    assert!(e.err().unwrap().contains("authentication"));

    // A changed host key is refused.
    let mut c = via_ssh(Driver::Postgres, &pg_host, None, Some("tunnelpw"));
    c.ssh.as_mut().unwrap().host_key = Some("SHA256:not-the-real-key".into());
    let e = Session::open("s4".into(), c, None).await.err().unwrap();
    assert!(e.contains("host key"), "{e}");

    // The pinned (correct) key is accepted.
    let mut c = via_ssh(Driver::Postgres, &pg_host, None, Some("tunnelpw"));
    c.ssh.as_mut().unwrap().host_key = Some(fp);
    Session::open("s5".into(), c, None)
        .await
        .expect("pinned host key");
}

#[tokio::test]
async fn postgres_end_to_end() {
    if enabled() {
        exercise(Driver::Postgres).await;
    }
}

#[tokio::test]
async fn mysql_end_to_end() {
    if enabled() {
        exercise(Driver::Mysql).await;
    }
}

#[tokio::test]
async fn backup_and_restore() {
    // Needs the DB client tools; QUERYBIRD_TOOLS_DIR points at their folder, QUERYBIRD_DUMP_DIR at a writable dir.
    let (Ok(tools), Ok(dir)) = (
        std::env::var("QUERYBIRD_TOOLS_DIR"),
        std::env::var("QUERYBIRD_DUMP_DIR"),
    ) else {
        return;
    };
    for driver in [Driver::Postgres, Driver::Mysql] {
        let c = cfg(driver);
        let admin = Session::open("a".into(), c.clone(), None).await.unwrap();
        admin
            .execute("DROP DATABASE IF EXISTS shop_copy")
            .await
            .unwrap();
        admin.execute("CREATE DATABASE shop_copy").await.unwrap();

        let path = format!("{dir}/shop-{driver:?}.sql");
        let _ = std::fs::remove_file(&path);
        querybird_lib::tools::backup(&c, None, "shop", &path, false, Some(&tools))
            .await
            .expect("backup");
        assert!(std::fs::metadata(&path).unwrap().len() > 1000);
        querybird_lib::tools::restore(&c, None, "shop_copy", &path, Some(&tools))
            .await
            .expect("restore");

        let mut copy = cfg(driver);
        copy.database = "shop_copy".into();
        let s = Session::open("c".into(), copy, None).await.unwrap();
        let n = s.execute("SELECT COUNT(*) FROM orders").await.unwrap();
        assert_eq!(n[0].rows[0][0].as_deref(), Some("1200"), "{driver:?}");
        drop(s);
        admin.execute("DROP DATABASE shop_copy").await.unwrap();
    }
    // A missing tool gives an actionable message.
    let e = querybird_lib::tools::backup(
        &cfg(Driver::Postgres),
        None,
        "shop",
        "/tmp/x.sql",
        false,
        Some("/nonexistent"),
    )
    .await;
    if let Err(e) = e {
        assert!(e.contains("pg_dump") || e.contains("exited"), "{e}");
    }
}
