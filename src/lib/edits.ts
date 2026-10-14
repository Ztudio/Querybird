import type { Cell, CellValue, Change, ColumnMeta } from "../api";

/** Marker stored in pending edits meaning "use the column's DEFAULT". */
export const DEFAULT_VALUE = "\u0000DEFAULT\u0000";

const toCell = (column: string, value: Cell): CellValue =>
  value === DEFAULT_VALUE ? { column, value: null, default: true } : { column, value };

/** Pending, uncommitted edits to a table page (TablePlus-style: review then ⌘S). */
export interface PendingEdits {
  /** row index in the loaded page → column → new value */
  updates: Record<number, Record<string, Cell>>;
  deleted: number[];
  inserted: Record<string, Cell>[];
}

export const emptyEdits = (): PendingEdits => ({ updates: {}, deleted: [], inserted: [] });

export function editCount(e: PendingEdits): number {
  const ups = Object.entries(e.updates).filter(([r, cols]) => !e.deleted.includes(+r) && Object.keys(cols).length).length;
  return ups + e.deleted.length + e.inserted.length;
}

export function setCell(e: PendingEdits, row: number, pageRows: number, column: string, value: Cell, original: Cell): PendingEdits {
  if (row >= pageRows) {
    const inserted = e.inserted.map((r, i) => (i === row - pageRows ? { ...r, [column]: value } : r));
    return { ...e, inserted };
  }
  const cols = { ...(e.updates[row] ?? {}) };
  if (value === original) delete cols[column];
  else cols[column] = value;
  return { ...e, updates: { ...e.updates, [row]: cols } };
}

export function toggleDelete(e: PendingEdits, rows: number[], pageRows: number): PendingEdits {
  const insertedToDrop = new Set(rows.filter((r) => r >= pageRows).map((r) => r - pageRows));
  const existing = rows.filter((r) => r < pageRows);
  const allDeleted = existing.every((r) => e.deleted.includes(r));
  const deleted = allDeleted
    ? e.deleted.filter((r) => !existing.includes(r))
    : Array.from(new Set([...e.deleted, ...existing]));
  return { ...e, deleted, inserted: e.inserted.filter((_, i) => !insertedToDrop.has(i)) };
}

/** Rows as displayed: originals with updates applied, followed by inserted rows. */
export function displayRows(rows: Cell[][], columns: ColumnMeta[], e: PendingEdits): Cell[][] {
  const merged = rows.map((r, i) => {
    const up = e.updates[i];
    if (!up) return r;
    return r.map((v, c) => (columns[c].name in up ? up[columns[c].name] : v));
  });
  const added = e.inserted.map((ins) => columns.map((c) => (c.name in ins ? ins[c.name] : null)));
  return [...merged, ...added];
}

export function buildChanges(
  schema: string,
  table: string,
  columns: ColumnMeta[],
  rows: Cell[][],
  primaryKey: string[],
  e: PendingEdits,
): Change[] {
  const keyCols = primaryKey.length ? primaryKey : columns.map((c) => c.name);
  const keyOf = (row: Cell[]) =>
    keyCols.map((k) => ({ column: k, value: row[columns.findIndex((c) => c.name === k)] ?? null }));
  const changes: Change[] = [];
  for (const [r, cols] of Object.entries(e.updates)) {
    const idx = +r;
    if (e.deleted.includes(idx) || !Object.keys(cols).length) continue;
    changes.push({
      kind: "update",
      schema,
      table,
      key: keyOf(rows[idx]),
      values: Object.entries(cols).map(([column, value]) => toCell(column, value)),
    });
  }
  for (const idx of [...e.deleted].sort((a, b) => a - b)) {
    changes.push({ kind: "delete", schema, table, key: keyOf(rows[idx]), values: [] });
  }
  for (const ins of e.inserted) {
    changes.push({
      kind: "insert",
      schema,
      table,
      key: [],
      values: Object.entries(ins)
        .filter(([, value]) => value !== DEFAULT_VALUE)
        .map(([column, value]) => toCell(column, value)),
    });
  }
  return changes;
}
