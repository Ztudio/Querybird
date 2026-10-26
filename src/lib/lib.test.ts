import { describe, expect, it } from "vitest";
import { splitStatements, statementAt, withLimit, isReadOnly, writeRisk } from "./sql";
import { buildChanges, displayRows, editCount, emptyEdits, setCell, toggleDelete } from "./edits";
import { toCsv, toInsertSql, toJson } from "./export";

describe("sql", () => {
  it("splits respecting quotes, comments and dollar bodies", () => {
    const sql = "select ';' as a; -- c;\nselect \"x;y\" from t;\ncreate function f() returns int as $$ select 1; $$ language sql;  /* ; */";
    const parts = splitStatements(sql).map((s) => s.text);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("select ';' as a");
    expect(parts[1]).toBe('-- c;\nselect "x;y" from t');
    expect(parts[2]).toContain("$$ select 1; $$");
  });

  it("finds the statement under the cursor", () => {
    const sql = "select 1;\n\nselect 2;";
    expect(statementAt(sql, 3)?.text).toBe("select 1");
    expect(statementAt(sql, sql.length)?.text).toBe("select 2");
    expect(statementAt(sql, 10)?.text).toBe("select 1");
  });

  it("adds limits only where it makes sense", () => {
    expect(withLimit("select * from t;", 100)).toBe("select * from t LIMIT 100");
    expect(withLimit("select * from t limit 5", 100)).toBe("select * from t limit 5");
    expect(withLimit("update t set a=1", 100)).toBe("update t set a=1");
    expect(withLimit("select 1", null)).toBe("select 1");
  });

  it("classifies read-only statements", () => {
    expect(isReadOnly("SELECT * FROM t")).toBe(true);
    expect(isReadOnly("delete from t")).toBe(false);
    expect(isReadOnly("with x as (delete from t returning *) select * from x")).toBe(false);
    for (const bad of [
      "SELECT * INTO newtab FROM users",
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity",
      "SELECT 'a\\''; DROP TABLE x; -- '",
      "SELECT E'\\'' AS x; DROP TABLE users; SELECT 'y'",
      "SELECT 1; DO $$BEGIN EXECUTE 'DROP TABLE t'; END$$",
      "SELECT * FROM t INTO OUTFILE '/tmp/x'",
      "SELECT * FROM t /*! ; DROP TABLE t */",
      "EXPLAIN ANALYZE DELETE FROM t",
    ]) expect(isReadOnly(bad), bad).toBe(false);
    expect(isReadOnly("SELECT replace(name, 'a', 'b') FROM t WHERE note = 'drop table'")).toBe(true);
    expect(isReadOnly('SELECT "update" FROM t')).toBe(true);
  });
});

describe("edits", () => {
  const columns = [
    { name: "id", typeName: "int4" },
    { name: "name", typeName: "text" },
  ];
  const rows = [
    ["1", "a"],
    ["2", "b"],
  ];

  it("tracks updates, deletes and inserts and builds changes", () => {
    let e = emptyEdits();
    e = setCell(e, 0, 2, "name", "z", "a");
    e = toggleDelete(e, [1], 2);
    e = { ...e, inserted: [{ name: "new" }] };
    expect(editCount(e)).toBe(3);
    expect(displayRows(rows, columns, e)).toEqual([
      ["1", "z"],
      ["2", "b"],
      [null, "new"],
    ]);
    const ch = buildChanges("public", "t", columns, rows, ["id"], e);
    expect(ch.map((c) => c.kind)).toEqual(["update", "delete", "insert"]);
    expect(ch[0].key).toEqual([{ column: "id", value: "1" }]);
    expect(ch[0].values).toEqual([{ column: "name", value: "z" }]);
  });

  it("reverting a cell to its original value clears the edit", () => {
    let e = setCell(emptyEdits(), 0, 2, "name", "z", "a");
    e = setCell(e, 0, 2, "name", "a", "a");
    expect(editCount(e)).toBe(0);
  });

  it("uses all columns as key without a primary key", () => {
    const e = toggleDelete(emptyEdits(), [0], 2);
    const ch = buildChanges("public", "t", columns, rows, [], e);
    expect(ch[0].key.map((k) => k.column)).toEqual(["id", "name"]);
  });
});

describe("export", () => {
  const columns = [{ name: "a", typeName: "" }, { name: "b", typeName: "" }];
  it("csv can escape spreadsheet formulas but keeps numbers", () => {
    expect(toCsv(columns, [["=HYPERLINK(1)", "-12.5"]], { escapeFormulas: true })).toBe("a,b\n'=HYPERLINK(1),-12.5\n");
  });
  it("csv quotes when needed", () => {
    expect(toCsv(columns, [["x,y", null], ['say "hi"', "ok"]])).toBe('a,b\n"x,y",\n"say ""hi""",ok\n');
  });
  it("json and sql", () => {
    expect(JSON.parse(toJson(columns, [["1", null]]))).toEqual([{ a: "1", b: null }]);
    expect(toInsertSql("mysql", "t", columns, [["it's", null]])).toBe("INSERT INTO `t` (`a`, `b`) VALUES ('it\\'s', NULL);");
  });
});

import { parseCsv, sniffDelimiter } from "./csv";
import { structureStatements, draftFromColumn, draftFromIndex, cloneTableStatements } from "./ddl";
import { toMarkdown, toUpdateSql } from "./export";
import { DEFAULT_VALUE } from "./edits";
import type { ColumnInfo } from "../api";

describe("csv", () => {
  it("parses quotes, escaped quotes, CRLF and BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n1,\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["1", ""],
    ]);
    expect(parseCsv('a;"multi\nline"', ";")).toEqual([["a", "multi\nline"]]);
  });
  it("sniffs delimiters", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(sniffDelimiter("a\tb\n")).toBe("\t");
    expect(sniffDelimiter("single")).toBe(",");
  });
});

describe("structure ddl", () => {
  const col = (name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
    position: 1, name, dataType, nullable: true, default: null, comment: null, extra: null, isPrimary: false, foreign: null, ...extra,
  });
  it("postgres: rename, retype, nullability, default, comment, add, drop", () => {
    const a = draftFromColumn(col("status", "text"));
    a.name = "state";
    a.nullable = false;
    a.default = "'new'";
    a.comment = "it's state";
    const b = draftFromColumn(col("qty", "integer"));
    b.dataType = "bigint";
    const c = draftFromColumn(col("old", "text"));
    c.dropped = true;
    const added = { original: null, name: "note", dataType: "text", nullable: true, default: null, comment: null, dropped: false };
    const st = structureStatements("postgres", "public", "orders", [a, b, c, added], []);
    expect(st).toEqual([
      'ALTER TABLE "public"."orders" RENAME COLUMN "status" TO "state";',
      'ALTER TABLE "public"."orders" ALTER COLUMN "state" SET NOT NULL;',
      `ALTER TABLE "public"."orders" ALTER COLUMN "state" SET DEFAULT 'new';`,
      `COMMENT ON COLUMN "public"."orders"."state" IS 'it''s state';`,
      'ALTER TABLE "public"."orders" ALTER COLUMN "qty" TYPE bigint USING "qty"::bigint;',
      'ALTER TABLE "public"."orders" DROP COLUMN "old";',
      'ALTER TABLE "public"."orders" ADD COLUMN "note" text NULL;',
    ]);
  });
  it("mysql: CHANGE COLUMN keeps auto_increment; index rebuild", () => {
    const a = draftFromColumn(col("id", "int", { nullable: false, extra: "auto_increment" }));
    a.dataType = "bigint";
    const idx = draftFromIndex({ name: "idx_status", algorithm: "BTREE", unique: false, primary: false, columns: "status", condition: null });
    idx.unique = true;
    const st = structureStatements("mysql", "shop", "orders", [a], [idx]);
    expect(st).toEqual([
      "ALTER TABLE `shop`.`orders` CHANGE COLUMN `id` `id` bigint NOT NULL AUTO_INCREMENT;",
      "DROP INDEX `idx_status` ON `shop`.`orders`;",
      "CREATE UNIQUE INDEX `idx_status` ON `shop`.`orders` (`status`);",
    ]);
  });
  it("sqlite: rename and add/drop only; index names are schema-qualified", () => {
    const a = draftFromColumn(col("status", "text"));
    a.name = "state";
    a.dataType = "integer";
    const added = { original: null, name: "note", dataType: "text", nullable: true, default: null, comment: "ignored", dropped: false };
    const idx = { original: null, name: "ix_state", columns: "state", unique: true, dropped: false };
    const old = draftFromIndex({ name: "ix_old", algorithm: "BTREE", unique: false, primary: false, columns: "x", condition: null });
    old.dropped = true;
    expect(structureStatements("sqlite", "main", "t", [a, added], [idx, old])).toEqual([
      'ALTER TABLE "main"."t" RENAME COLUMN "status" TO "state";',
      'ALTER TABLE "main"."t" ADD COLUMN "note" text NULL;',
      'CREATE UNIQUE INDEX "main"."ix_state" ON "t" ("state");',
      'DROP INDEX "main"."ix_old";',
    ]);
    expect(cloneTableStatements("sqlite", "main", "t", "t2", false)).toEqual(['CREATE TABLE "main"."t2" AS SELECT * FROM "main"."t" WHERE 0;']);
  });
  it("unchanged drafts produce nothing", () => {
    expect(structureStatements("postgres", "s", "t", [draftFromColumn(col("a", "int"))], [])).toEqual([]);
  });
  it("clone", () => {
    expect(cloneTableStatements("postgres", "public", "t", "t_copy", true)).toEqual([
      'CREATE TABLE "public"."t_copy" (LIKE "public"."t" INCLUDING ALL);',
      'INSERT INTO "public"."t_copy" SELECT * FROM "public"."t";',
    ]);
  });
});

describe("more export + DEFAULT", () => {
  const cols = [{ name: "id", typeName: "" }, { name: "name", typeName: "" }];
  it("markdown and update sql", () => {
    expect(toMarkdown(cols, [["1", "a|b"]])).toBe("| id | name |\n| --- | --- |\n| 1 | a\\|b |");
    expect(toUpdateSql("postgres", "t", cols, [["1", null]], ["id"])).toBe(`UPDATE "t" SET "name" = NULL WHERE "id" = '1';`);
  });
  it("DEFAULT marker becomes a DEFAULT cell, and is omitted from inserts", () => {
    const e = { updates: { 0: { name: DEFAULT_VALUE } }, deleted: [], inserted: [{ id: DEFAULT_VALUE, name: "x" }] };
    const ch = buildChanges("public", "t", cols, [["1", "a"]], ["id"], e);
    expect(ch[0].values).toEqual([{ column: "name", value: null, default: true }]);
    expect(ch[1].values).toEqual([{ column: "name", value: "x" }]);
  });
});

describe("writeRisk", () => {
  it("counts the rows a DELETE/UPDATE would touch, without running it", () => {
    const d = writeRisk("DELETE FROM orders WHERE status = 'cancelled' AND note <> 'where (x)';");
    expect(d).toMatchObject({ kind: "delete", destructive: false, noWhere: false, target: "orders" });
    expect(d.countSql).toBe("SELECT COUNT(*) FROM orders WHERE status = 'cancelled' AND note <> 'where (x)'");
    const u = writeRisk('UPDATE "public"."customers" c SET name = upper(name) WHERE c.id IN (SELECT id FROM x WHERE y)');
    expect(u.countSql).toBe('SELECT COUNT(*) FROM "public"."customers" c WHERE c.id IN (SELECT id FROM x WHERE y)');
  });
  it("flags statements that hit every row or can't be undone", () => {
    expect(writeRisk("DELETE FROM orders")).toMatchObject({ destructive: true, noWhere: true, countSql: "SELECT COUNT(*) FROM orders" });
    expect(writeRisk("UPDATE t SET a = 1")).toMatchObject({ destructive: true, noWhere: true });
    expect(writeRisk("DROP TABLE IF EXISTS orders")).toMatchObject({ kind: "drop", destructive: true, target: "orders" });
    expect(writeRisk("TRUNCATE TABLE orders")).toMatchObject({ kind: "truncate", destructive: true });
    expect(writeRisk("ALTER TABLE t DROP COLUMN a").destructive).toBe(true);
    expect(writeRisk("INSERT INTO t (a) VALUES (1); DELETE FROM t").destructive).toBe(true);
  });
  it("doesn't guess a count for forms it can't rewrite safely", () => {
    expect(writeRisk("DELETE FROM a USING b WHERE a.id = b.id").countSql).toBeNull();
    expect(writeRisk("UPDATE a SET x = b.x FROM b WHERE a.id = b.id").countSql).toBeNull();
    expect(writeRisk("DELETE FROM t WHERE a = 1 LIMIT 5").countSql).toBeNull();
    expect(writeRisk("INSERT INTO t VALUES (1)")).toMatchObject({ kind: "insert", destructive: false, countSql: null });
  });
});
