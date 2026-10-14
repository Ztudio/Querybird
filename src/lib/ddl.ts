import type { ColumnInfo, Driver, IndexInfo } from "../api";
import { quoteIdent, quoteLiteral } from "./export";

/** An editable column in the Structure view. `original` is null for newly added columns. */
export interface ColumnDraft {
  original: ColumnInfo | null;
  name: string;
  dataType: string;
  nullable: boolean;
  /** Raw SQL expression (e.g. `0`, `'pending'`, `now()`), or null for no default. */
  default: string | null;
  comment: string | null;
  dropped: boolean;
}

export interface IndexDraft {
  original: IndexInfo | null;
  name: string;
  columns: string;
  unique: boolean;
  dropped: boolean;
}

export const draftFromColumn = (c: ColumnInfo): ColumnDraft => ({
  original: c,
  name: c.name,
  dataType: c.dataType,
  nullable: c.nullable,
  default: c.default,
  comment: c.comment,
  dropped: false,
});

export const draftFromIndex = (i: IndexInfo): IndexDraft => ({
  original: i,
  name: i.name,
  columns: i.columns,
  unique: i.unique,
  dropped: false,
});

export function columnChanged(d: ColumnDraft): boolean {
  const o = d.original;
  if (!o) return true;
  return d.dropped || d.name !== o.name || d.dataType !== o.dataType || d.nullable !== o.nullable || (d.default ?? null) !== (o.default ?? null) || (d.comment ?? null) !== (o.comment ?? null);
}

/** ALTER statements that turn the original structure into the drafts. */
export function structureStatements(
  driver: Driver,
  schema: string,
  table: string,
  columns: ColumnDraft[],
  indexes: IndexDraft[],
): string[] {
  const q = (s: string) => quoteIdent(driver, s);
  const t = `${q(schema)}.${q(table)}`;
  const out: string[] = [];
  const colDef = (d: ColumnDraft) =>
    `${q(d.name)} ${d.dataType}${d.nullable ? " NULL" : " NOT NULL"}${d.default != null && d.default !== "" ? ` DEFAULT ${d.default}` : ""}`;

  for (const d of columns) {
    const o = d.original;
    if (!o) {
      if (d.dropped || !d.name.trim()) continue;
      if (driver === "mysql") {
        out.push(`ALTER TABLE ${t} ADD COLUMN ${colDef(d)}${d.comment ? ` COMMENT ${quoteLiteral(driver, d.comment)}` : ""};`);
      } else {
        out.push(`ALTER TABLE ${t} ADD COLUMN ${colDef(d)};`);
        if (d.comment) out.push(`COMMENT ON COLUMN ${t}.${q(d.name)} IS ${quoteLiteral(driver, d.comment)};`);
      }
      continue;
    }
    if (d.dropped) {
      out.push(`ALTER TABLE ${t} DROP COLUMN ${q(o.name)};`);
      continue;
    }
    if (!columnChanged(d)) continue;

    if (driver === "mysql") {
      // MySQL redefines the whole column in one statement.
      const comment = d.comment ? ` COMMENT ${quoteLiteral(driver, d.comment)}` : "";
      const onUpdate = o.extra?.match(/on update (current_timestamp(\(\d*\))?)/i);
      const extra = (o.extra && /auto_increment/i.test(o.extra) ? " AUTO_INCREMENT" : "") + (onUpdate ? ` ON UPDATE ${onUpdate[1].toUpperCase()}` : "");
      out.push(`ALTER TABLE ${t} CHANGE COLUMN ${q(o.name)} ${colDef(d)}${extra}${comment};`);
      continue;
    }
    let name = o.name;
    if (d.name !== o.name) {
      out.push(`ALTER TABLE ${t} RENAME COLUMN ${q(o.name)} TO ${q(d.name)};`);
      name = d.name;
    }
    if (d.dataType !== o.dataType) {
      out.push(`ALTER TABLE ${t} ALTER COLUMN ${q(name)} TYPE ${d.dataType} USING ${q(name)}::${d.dataType};`);
    }
    if (d.nullable !== o.nullable) {
      out.push(`ALTER TABLE ${t} ALTER COLUMN ${q(name)} ${d.nullable ? "DROP NOT NULL" : "SET NOT NULL"};`);
    }
    if ((d.default ?? null) !== (o.default ?? null)) {
      out.push(
        d.default == null || d.default === ""
          ? `ALTER TABLE ${t} ALTER COLUMN ${q(name)} DROP DEFAULT;`
          : `ALTER TABLE ${t} ALTER COLUMN ${q(name)} SET DEFAULT ${d.default};`,
      );
    }
    if ((d.comment ?? null) !== (o.comment ?? null)) {
      out.push(`COMMENT ON COLUMN ${t}.${q(name)} IS ${d.comment ? quoteLiteral(driver, d.comment) : "NULL"};`);
    }
  }

  for (const i of indexes) {
    const o = i.original;
    const cols = i.columns
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
      // Plain names are always quoted; only expressions (with parentheses) pass through as SQL.
      .map((c) => (c.includes("(") ? c : q(c.replace(/^[`"]|[`"]$/g, ""))))
      .join(", ");
    const drop = (name: string) =>
      driver === "mysql"
        ? name === "PRIMARY"
          ? `ALTER TABLE ${t} DROP PRIMARY KEY;`
          : `DROP INDEX ${q(name)} ON ${t};`
        : o?.primary
          ? `ALTER TABLE ${t} DROP CONSTRAINT ${q(name)};`
          : `DROP INDEX ${q(schema)}.${q(name)};`;
    const create = () => `CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${q(i.name)} ON ${t} (${cols});`;
    if (!o) {
      if (!i.dropped && i.name.trim() && cols) out.push(create());
    } else if (i.dropped) {
      out.push(drop(o.name));
    } else if (i.name !== o.name || i.columns !== o.columns || i.unique !== o.unique) {
      out.push(drop(o.name));
      out.push(create());
    }
  }
  return out;
}

export function createTableTemplate(driver: Driver, schema: string, name = "new_table"): string {
  const q = (s: string) => quoteIdent(driver, s);
  return driver === "mysql"
    ? `CREATE TABLE ${q(schema)}.${q(name)} (\n  id INT AUTO_INCREMENT PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n`
    : `CREATE TABLE ${q(schema)}.${q(name)} (\n  id BIGSERIAL PRIMARY KEY,\n  name TEXT NOT NULL,\n  created_at TIMESTAMPTZ DEFAULT now()\n);\n`;
}

export function createViewTemplate(driver: Driver, schema: string, materialized = false): string {
  const q = (s: string) => quoteIdent(driver, s);
  return `CREATE ${materialized ? "MATERIALIZED " : ""}VIEW ${q(schema)}.${q(materialized ? "new_materialized_view" : "new_view")} AS\nSELECT\n  *\nFROM\n  table_name;\n`;
}

export function createFunctionTemplate(driver: Driver, schema: string): string {
  const q = (s: string) => quoteIdent(driver, s);
  return driver === "mysql"
    ? `CREATE FUNCTION ${q(schema)}.${q("new_function")}(x INT) RETURNS INT\nDETERMINISTIC\nRETURN x * 2;\n`
    : `CREATE OR REPLACE FUNCTION ${q(schema)}.${q("new_function")}(x integer)\nRETURNS integer\nLANGUAGE sql\nAS $$\n  SELECT x * 2;\n$$;\n`;
}

export function cloneTableStatements(driver: Driver, schema: string, table: string, target: string, withData: boolean): string[] {
  const q = (s: string) => quoteIdent(driver, s);
  const src = `${q(schema)}.${q(table)}`;
  const dst = `${q(schema)}.${q(target)}`;
  const create =
    driver === "mysql" ? `CREATE TABLE ${dst} LIKE ${src};` : `CREATE TABLE ${dst} (LIKE ${src} INCLUDING ALL);`;
  return withData ? [create, `INSERT INTO ${dst} SELECT * FROM ${src};`] : [create];
}
