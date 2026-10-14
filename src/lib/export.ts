import type { Cell, ColumnMeta, Driver } from "../api";

export interface CsvOptions {
  delimiter?: string;
  header?: boolean;
  nullAsEmpty?: boolean;
  lineBreakToSpace?: boolean;
  /** Prefix `'` to cells a spreadsheet would run as a formula (=, +, -, @, tab, CR); numbers are kept. */
  escapeFormulas?: boolean;
}

const NUMBER = /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/;

function csvField(v: Cell, o: CsvOptions): string {
  if (v === null) return o.nullAsEmpty === false ? "NULL" : "";
  if (o.lineBreakToSpace) v = v.replace(/\r?\n/g, " ");
  if (o.escapeFormulas && /^[=+\-@\t\r]/.test(v) && !NUMBER.test(v)) v = `'${v}`;
  const d = o.delimiter ?? ",";
  return v.includes(d) || /["\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(columns: ColumnMeta[], rows: Cell[][], o: CsvOptions = {}): string {
  const d = o.delimiter ?? ",";
  const lines = rows.map((r) => r.map((v) => csvField(v, o)).join(d));
  if (o.header !== false) lines.unshift(columns.map((c) => csvField(c.name, o)).join(d));
  return lines.join("\n") + "\n";
}

export function toMarkdown(columns: ColumnMeta[], rows: Cell[][]): string {
  const esc = (v: Cell) => (v === null ? "NULL" : v.replace(/\|/g, "\\|").replace(/\r?\n/g, " "));
  return [
    `| ${columns.map((c) => esc(c.name)).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ].join("\n");
}

export function toUpdateSql(driver: Driver, table: string, columns: ColumnMeta[], rows: Cell[][], key: string[]): string {
  const keyCols = key.length ? key : [columns[0]?.name].filter(Boolean);
  return rows
    .map((r) => {
      const sets = columns
        .map((c, i) => (keyCols.includes(c.name) ? null : `${quoteIdent(driver, c.name)} = ${quoteLiteral(driver, r[i])}`))
        .filter(Boolean)
        .join(", ");
      const where = keyCols
        .map((k) => {
          const v = r[columns.findIndex((c) => c.name === k)];
          return v === null ? `${quoteIdent(driver, k)} IS NULL` : `${quoteIdent(driver, k)} = ${quoteLiteral(driver, v)}`;
        })
        .join(" AND ");
      return `UPDATE ${quoteIdent(driver, table)} SET ${sets} WHERE ${where};`;
    })
    .join("\n");
}

export function toTsv(rows: Cell[][]): string {
  return rows.map((r) => r.map((v) => (v === null ? "NULL" : v.replace(/\t/g, " ").replace(/\n/g, " "))).join("\t")).join("\n");
}

export function toJson(columns: ColumnMeta[], rows: Cell[][]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i]]))),
    null,
    2,
  );
}

export function quoteIdent(driver: Driver, name: string): string {
  return driver === "mysql" ? "`" + name.replace(/`/g, "``") + "`" : '"' + name.replace(/"/g, '""') + '"';
}

export function quoteLiteral(driver: Driver, v: Cell): string {
  if (v === null) return "NULL";
  const s = driver === "mysql" ? v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") : v.replace(/'/g, "''");
  return `'${s}'`;
}

export function toInsertSql(driver: Driver, table: string, columns: ColumnMeta[], rows: Cell[][]): string {
  const cols = columns.map((c) => quoteIdent(driver, c.name)).join(", ");
  return rows
    .map((r) => `INSERT INTO ${quoteIdent(driver, table)} (${cols}) VALUES (${r.map((v) => quoteLiteral(driver, v)).join(", ")});`)
    .join("\n");
}
