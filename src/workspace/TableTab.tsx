import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type Cell, type ColumnMeta, type Filter, type SortSpec, type TablePage, type TableStructure } from "../api";
import { IconLeft, IconMinus, IconPlus, IconRight } from "../components/icons";
import { Modal, mod, type MenuItem } from "../components/ui";
import { DEFAULT_VALUE, buildChanges, displayRows, editCount, emptyEdits, setCell, toggleDelete, type PendingEdits } from "../lib/edits";
import { toCsv, toInsertSql, toJson, toMarkdown, toTsv, toUpdateSql } from "../lib/export";
import { useSettings } from "../lib/settings";
import { DataGrid, type DataGridHandle, type GridSelection } from "./DataGrid";
import { QuickLook } from "./QuickLook";
import { StructureEditor } from "./StructureEditor";
import { useWs, type Details, type TabApi } from "./context";

export const OPERATORS = [
  "=", "<>", "<", ">", "<=", ">=", "IN", "NOT IN", "IS NULL", "IS NOT NULL",
  "BETWEEN", "LIKE", "NOT LIKE", "CONTAINS", "NOT CONTAINS", "BEGINS WITH", "ENDS WITH",
];
const NO_VALUE = new Set(["IS NULL", "IS NOT NULL"]);
const RAW = "__raw__";
// Stable fallbacks while no page is loaded: a fresh `[]` each render would re-run the effects
// that depend on columns/rows and loop through onDetails.
const NO_COLUMNS: ColumnMeta[] = [];
const NO_ROWS: Cell[][] = [];

interface FilterRow extends Filter {
  id: number;
  enabled: boolean;
}

let nextFilterId = 1;
const newFilter = (column: string, op = "=", value = ""): FilterRow => ({ id: nextFilterId++, enabled: true, column, op, value });

/** Pending edits with undo / redo, like TablePlus's ⌘Z on uncommitted changes. */
function useEditHistory() {
  const [h, setH] = useState<{ past: PendingEdits[]; present: PendingEdits; future: PendingEdits[] }>({
    past: [],
    present: emptyEdits(),
    future: [],
  });
  const update = useCallback(
    (fn: (e: PendingEdits) => PendingEdits) =>
      setH((s) => {
        const next = fn(s.present);
        return next === s.present ? s : { past: [...s.past.slice(-200), s.present], present: next, future: [] };
      }),
    [],
  );
  const undo = useCallback(() => setH((s) => (s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] } : s)), []);
  const redo = useCallback(() => setH((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) } : s)), []);
  const reset = useCallback(() => setH({ past: [], present: emptyEdits(), future: [] }), []);
  return { edits: h.present, update, undo, redo, reset, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}

export function TableTab({
  schema,
  table,
  isView,
  active,
  initialFilters,
  initialView,
  onDetails,
  register,
  onPending,
  onExport,
  onImportCsv,
}: {
  schema: string;
  table: string;
  isView: boolean;
  active: boolean;
  initialFilters?: Filter[];
  initialView?: "data" | "structure";
  onDetails: (d: Details | null) => void;
  register: (a: TabApi) => void;
  onPending: (n: number) => void;
  onExport: (tables: string[]) => void;
  onImportCsv: (table: string) => void;
}) {
  const ws = useWs();
  const settings = useSettings();
  const [view, setView] = useState<"data" | "structure">(initialView ?? "data");
  const [page, setPage] = useState<TablePage | null>(null);
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [info, setInfo] = useState<[string, string][] | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(settings.pageSize);
  const [sorts, setSorts] = useState<SortSpec[]>([]);
  const [filters, setFilters] = useState<FilterRow[]>(() =>
    initialFilters?.length ? initialFilters.map((f) => ({ ...f, id: nextFilterId++, enabled: true })) : [],
  );
  const [applied, setApplied] = useState<FilterRow[]>(filters);
  const [filterOpen, setFilterOpen] = useState(!!initialFilters?.length);
  const { edits, update: setEdits, undo, redo, reset: resetEdits } = useEditHistory();
  const [selection, setSelection] = useState<GridSelection>({ rows: [], focus: null });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [quickLook, setQuickLook] = useState<{ r: number; c: number } | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [structurePending, setStructurePending] = useState(0);
  const structureApi = useRef<TabApi>({});
  const grid = useRef<DataGridHandle>(null);

  const editable = !isView && !!page;
  const pending = editCount(edits);
  useEffect(() => onPending(pending + structurePending), [pending, structurePending]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadStructure = useCallback(async () => {
    const st = await api.tableStructure(ws.sessionId, schema, table);
    setStructure(st);
    return st;
  }, [ws.sessionId, schema, table]);

  const load = useCallback(async () => {
    ws.setLoading(1);
    setError(null);
    try {
      const raw = applied.find((f) => f.enabled && f.column === RAW);
      const q = {
        schema,
        table,
        limit,
        offset,
        filters: applied.filter((f) => f.enabled && f.column && f.column !== RAW),
        rawWhere: raw?.value ?? null,
        sorts,
      };
      const [p] = await Promise.all([api.fetchTable(ws.sessionId, q), structure ? Promise.resolve(structure) : loadStructure()]);
      ws.log(p.sql);
      setPage(p);
      resetEdits();
      setLoadKey((k) => k + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      ws.setLoading(-1);
    }
  }, [ws.sessionId, schema, table, limit, offset, applied, sorts]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  // Another tool (CSV import…) changed this table: reload it.
  useEffect(() => {
    const h = (e: Event) => (e as CustomEvent<string>).detail === table && load();
    window.addEventListener("querybird:table-changed", h);
    return () => window.removeEventListener("querybird:table-changed", h);
  }, [table, load]);

  useEffect(() => {
    if (active && !info) api.tableInfo(ws.sessionId, schema, table).then(setInfo).catch(() => setInfo([]));
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const columns = page?.result.columns ?? NO_COLUMNS;
  const baseRows = page?.result.rows ?? NO_ROWS;
  const rows = useMemo(() => displayRows(baseRows, columns, edits), [baseRows, columns, edits]);
  const visibleIdx = useMemo(() => columns.map((_, i) => i).filter((i) => !hidden.has(columns[i].name)), [columns, hidden]);
  const visibleCols = useMemo(() => visibleIdx.map((i) => columns[i]), [visibleIdx, columns]);
  const visibleRows = useMemo(
    () => (hidden.size ? rows.map((r) => visibleIdx.map((i) => r[i])) : rows),
    [rows, visibleIdx, hidden.size],
  );
  const foreign = useMemo(
    () => Object.fromEntries((structure?.columns ?? []).filter((c) => c.foreign).map((c) => [c.name, c.foreign!])),
    [structure],
  );
  const pk = structure?.primaryKey ?? [];

  const changes = () => buildChanges(schema, table, columns, baseRows, pk, edits);

  const commit = async (force = false) => {
    if (view === "structure") return structureApi.current.commit?.();
    if (!pending) return;
    if ((!pk.length || ws.safeMode) && !force) {
      // Without a key we match on every column, which can touch duplicate rows: show it first.
      setPreview(await api.previewChanges(ws.sessionId, changes()));
      return;
    }
    ws.setLoading(1);
    try {
      const done = await api.applyChanges(ws.sessionId, changes());
      done.forEach(ws.log);
      setPreview(null);
      ws.toast(`${done.length} change${done.length === 1 ? "" : "s"} committed`);
      await load();
    } catch (e) {
      ws.toast(errorText(e), true);
    } finally {
      ws.setLoading(-1);
    }
  };

  const insertRow = () => {
    if (!editable) return;
    setView("data");
    setEdits((e) => ({ ...e, inserted: [...e.inserted, {}] }));
    setTimeout(() => grid.current?.scrollToBottom(), 0);
  };

  const duplicateRows = (rowIdx: number[]) => {
    if (!editable || !rowIdx.length) return;
    const skip = new Set(pk);
    const copies = rowIdx.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, rows[r][i]] as const).filter(([n]) => !skip.has(n))));
    setEdits((e) => ({ ...e, inserted: [...e.inserted, ...copies] }));
    setTimeout(() => grid.current?.scrollToBottom(), 0);
  };

  const setValue = (r: number, c: number, value: Cell) =>
    setEdits((e) => setCell(e, r, baseRows.length, columns[c].name, value, r < baseRows.length ? baseRows[r][c] : null));

  const editCell = (r: number, visibleC: number, value: Cell) => setValue(r, visibleIdx[visibleC], value);

  /** Pastes clipboard rows starting at the focused cell; rows past the end become new rows. */
  const paste = (data: string[][], sel: GridSelection) => {
    if (!editable || !data.length) return;
    const start = sel.focus ?? { r: rows.length, c: 0 };
    const norm = (v: string): Cell => (v === "NULL" ? null : v);
    setEdits((e0) => {
      let e = e0;
      data.forEach((line, i) => {
        const r = start.r + i;
        if (r >= baseRows.length + e.inserted.length) {
          const ins: Record<string, Cell> = {};
          line.forEach((v, j) => {
            const col = visibleCols[start.c + j];
            if (col) ins[col.name] = norm(v);
          });
          e = { ...e, inserted: [...e.inserted, ins] };
          return;
        }
        line.forEach((v, j) => {
          const vc = start.c + j;
          if (vc >= visibleIdx.length) return;
          const c = visibleIdx[vc];
          e = setCell(e, r, baseRows.length, columns[c].name, norm(v), r < baseRows.length ? baseRows[r][c] : null);
        });
      });
      return e;
    });
    ws.toast(`Pasted ${data.length} row${data.length === 1 ? "" : "s"} — ${mod}S to commit`);
  };

  const applyFilters = (list = filters) => {
    setOffset(0);
    setApplied(list.map((f) => ({ ...f })));
  };

  const quickFilter = (column: string, op: string, value: Cell) => {
    const f = newFilter(column, value === null && op === "=" ? "IS NULL" : value === null ? "IS NOT NULL" : op, value ?? "");
    setFilters([f]);
    setFilterOpen(true);
    applyFilters([f]);
  };

  const toggleFilters = () => {
    setView("data");
    if (filterOpen) {
      setFilterOpen(false);
      if (applied.some((f) => f.enabled)) applyFilters([]);
    } else {
      if (!filters.length) setFilters([newFilter(columns[0]?.name ?? "")]);
      setFilterOpen(true);
    }
  };

  const exportPage = async () => {
    const path = await api.pickPath("save", { defaultName: `${table.replace(/[\\/:*?"<>|]/g, "_")}.csv`, filterName: "CSV", extensions: ["csv"] });
    if (!path) return;
    await api.writeTextFile(path, toCsv(columns, rows, { delimiter: settings.csvDelimiter, escapeFormulas: true }));
    ws.toast(`Exported ${rows.length} rows`);
  };

  const sortBy = (column: string, add: boolean) => {
    setOffset(0);
    setSorts((s) => {
      const i = s.findIndex((x) => x.column === column);
      if (!add) return i < 0 || s.length > 1 ? [{ column, desc: false }] : s[i].desc ? [] : [{ column, desc: true }];
      if (i < 0) return [...s, { column, desc: false }];
      return s[i].desc ? s.filter((_, j) => j !== i) : s.map((x, j) => (j === i ? { ...x, desc: true } : x));
    });
  };

  useEffect(() => {
    register({
      reload: () => (view === "structure" ? structureApi.current.reload?.() : load()),
      commit: () => commit(),
      discard: () => (view === "structure" ? structureApi.current.discard?.() : resetEdits()),
      preview: async () =>
        view === "structure" ? structureApi.current.preview?.() : pending && setPreview(await api.previewChanges(ws.sessionId, changes())),
      toggleFilters,
      insertRow,
      duplicate: () => duplicateRows(grid.current?.selection().rows ?? []),
      undo,
      redo,
      showData: () => setView("data"),
      showStructure: () => setView("structure"),
    });
  });

  // Details panel follows the focused row.
  const focusRow = selection.focus ? selection.focus.r : null;
  useEffect(() => {
    if (!active) return;
    if (view === "structure" || focusRow === null || !rows[focusRow]) {
      onDetails({ columns, row: null, editable: false, info });
      return;
    }
    onDetails({
      columns,
      row: rows[focusRow],
      editable: editable && !edits.deleted.includes(focusRow),
      selectedCount: selection.rows.length,
      onChange: (c, v) => setValue(focusRow, c, v),
    });
  }, [active, focusRow, rows, columns, view, info, selection.rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const cellMenu = (e: React.MouseEvent, r: number, vc: number, sel: GridSelection) => {
    const c = visibleIdx[vc];
    const col = columns[c];
    const value = rows[r][c] === DEFAULT_VALUE ? null : rows[r][c];
    const selRows = sel.rows.map((i) => rows[i]);
    const copy = (text: string) => navigator.clipboard.writeText(text);
    const quick = (op: string, label: string): MenuItem => ({ label: `${col.name} ${label} ${value === null ? "NULL" : truncate(value)}`, onClick: () => quickFilter(col.name, op, value) });
    ws.setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Quick Look Editor", kbd: `${mod}↵`, onClick: () => setQuickLook({ r, c }) },
        { label: "Refresh", kbd: `${mod}R`, onClick: load },
        { separator: true },
        { label: "Paste", kbd: `${mod}V`, disabled: !editable, onClick: async () => grid.current && paste(parseClip(await navigator.clipboard.readText()), sel) },
        { label: "Add Row", kbd: `${mod}I`, disabled: !editable, onClick: insertRow },
        { label: "Duplicate", kbd: `${mod}D`, disabled: !editable, onClick: () => duplicateRows(sel.rows) },
        {
          label: "Set Value",
          disabled: !editable,
          submenu: [
            { label: "EMPTY", onClick: () => sel.rows.forEach((row) => setValue(row, c, "")) },
            { label: "NULL", onClick: () => sel.rows.forEach((row) => setValue(row, c, null)) },
            { label: "DEFAULT", onClick: () => sel.rows.forEach((row) => setValue(row, c, DEFAULT_VALUE)) },
          ],
        },
        { separator: true },
        { label: "Copy", kbd: `${mod}C`, onClick: () => copy(sel.rows.length > 1 ? toTsv(selRows) : value ?? "NULL") },
        { label: "Copy Cell Value", kbd: `⇧${mod}C`, onClick: () => copy(value ?? "NULL") },
        { label: "Copy All Column Values", onClick: () => copy(rows.map((x) => x[c] ?? "NULL").join("\n")) },
        {
          label: "Copy Rows As",
          submenu: [
            { label: "CSV", onClick: () => copy(toCsv(columns, selRows, { delimiter: settings.csvDelimiter })) },
            { label: "TSV", onClick: () => copy(toTsv(selRows)) },
            { label: "JSON", onClick: () => copy(toJson(columns, selRows)) },
            { label: "Markdown", onClick: () => copy(toMarkdown(columns, selRows)) },
            { label: "SQL INSERT", onClick: () => copy(toInsertSql(ws.driver, table, columns, selRows)) },
            { label: "SQL UPDATE", onClick: () => copy(toUpdateSql(ws.driver, table, columns, selRows, pk)) },
          ],
        },
        { separator: true },
        {
          label: "Quick Filter",
          submenu: [
            quick("=", "="),
            quick("<>", "≠"),
            quick(">", ">"),
            quick("<", "<"),
            ...(value !== null ? [quick("CONTAINS", "contains")] : []),
            { separator: true },
            { label: `${col.name} IS NULL`, onClick: () => quickFilter(col.name, "IS NULL", "") },
            { label: `${col.name} IS NOT NULL`, onClick: () => quickFilter(col.name, "IS NOT NULL", "") },
          ],
        },
        { label: "Import", submenu: [{ label: "From CSV…", disabled: isView, onClick: () => onImportCsv(table) }] },
        { label: "Export current page…", onClick: exportPage },
        { separator: true },
        { label: sel.rows.length > 1 ? `Delete ${sel.rows.length} Rows` : "Delete", kbd: `${mod}⌫`, danger: true, disabled: !editable, onClick: () => setEdits((ed) => toggleDelete(ed, sel.rows, baseRows.length)) },
      ],
    });
  };

  const headerMenu = (e: React.MouseEvent, vc: number) => {
    const col = visibleCols[vc];
    ws.setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Copy name", onClick: () => navigator.clipboard.writeText(col.name) },
        {
          label: "Filter with column",
          onClick: () => {
            const f = newFilter(col.name);
            setFilters((fs) => [...fs, f]);
            setFilterOpen(true);
          },
        },
        { label: "Hide this column", onClick: () => setHidden((h) => new Set([...h, col.name])) },
        { separator: true },
        { label: "Reset column positions and widths", onClick: () => (setHidden(new Set()), grid.current?.resetWidths()) },
        { separator: true },
        { label: "Sort Ascending", onClick: () => (setOffset(0), setSorts([{ column: col.name, desc: false }])) },
        { label: "Sort Descending", onClick: () => (setOffset(0), setSorts([{ column: col.name, desc: true }])) },
        {
          label: "Sort multiple Columns",
          submenu: [
            { label: `Add ${col.name} ascending`, onClick: () => setSorts((s) => [...s.filter((x) => x.column !== col.name), { column: col.name, desc: false }]) },
            { label: `Add ${col.name} descending`, onClick: () => setSorts((s) => [...s.filter((x) => x.column !== col.name), { column: col.name, desc: true }]) },
          ],
        },
        { separator: true },
        { label: "Remove sort", disabled: !sorts.length, onClick: () => setSorts([]) },
      ],
    });
  };

  const total = page?.total ?? 0;
  const totalText = `${page?.estimated ? "~" : ""}${total.toLocaleString()}`;
  const status =
    selection.rows.length > 1
      ? `${selection.rows.length} of ${totalText} rows selected`
      : page
        ? `${total ? (offset + 1).toLocaleString() : 0}-${Math.min(offset + baseRows.length, offset + limit).toLocaleString()} of ${totalText} rows`
        : "";

  return (
    <div className="tab-body">
      {view === "data" && filterOpen && (
        <FilterBar
          columns={columns.map((c) => c.name)}
          filters={filters}
          setFilters={setFilters}
          onApply={applyFilters}
          onClose={() => {
            setFilterOpen(false);
            if (applied.some((f) => f.enabled)) applyFilters([]);
          }}
        />
      )}
      {view === "data" ? (
        error ? (
          <div className="tab-error mono">{error}</div>
        ) : (
          <DataGrid
            ref={grid}
            columns={visibleCols}
            rows={visibleRows}
            dataKey={`${loadKey}`}
            editable={editable}
            rowState={(r) => (r >= baseRows.length ? "inserted" : edits.deleted.includes(r) ? "deleted" : undefined)}
            cellEdited={(r, vc) => {
              const name = visibleCols[vc]?.name;
              return r < baseRows.length && !!edits.updates[r] && name in edits.updates[r];
            }}
            onEdit={editCell}
            sorts={sorts}
            onSort={sortBy}
            onHeaderContextMenu={headerMenu}
            onPaste={paste}
            onQuickLook={(r, vc) => setQuickLook({ r, c: visibleIdx[vc] })}
            foreign={foreign}
            onForeign={(column, value) => {
              const f = foreign[column];
              ws.openTable(f.schema, f.table, { filters: [{ column: f.column, op: "=", value }], newTab: true });
            }}
            onSelectionChange={setSelection}
            onContextMenu={cellMenu}
            onDeleteRows={(r) => setEdits((e) => toggleDelete(e, r, baseRows.length))}
          />
        )
      ) : (
        <StructureEditor
          schema={schema}
          table={table}
          isView={isView}
          structure={structure}
          onReload={async () => {
            await loadStructure();
            setInfo(undefined);
          }}
          register={(a) => (structureApi.current = a)}
          onPending={setStructurePending}
        />
      )}

      <div className="bottom-bar">
        <div className="segmented">
          <button className={view === "data" ? "active" : ""} onClick={() => setView("data")} title={`Data (⌃${mod}[)`}>Data</button>
          <button className={view === "structure" ? "active" : ""} onClick={() => setView("structure")} title={`Structure (⌃${mod}])`}>Structure</button>
        </div>
        {view === "data" ? (
          <>
            <button className="btn" disabled={!editable} onClick={insertRow} title={`Insert row (${mod}I)`}>
              <IconPlus size={11} /> Row
            </button>
            <span className="spacer" />
            <span className="muted status-text">
              {pending ? <span style={{ color: "var(--orange)" }}>{pending} pending · {mod}S to commit · </span> : null}
              {status}
            </span>
            <span className="spacer" />
            <button className={`btn${filterOpen ? " on" : ""}`} onClick={toggleFilters} title={`Filters (${mod}F)`}>
              Filters{applied.filter((f) => f.enabled).length ? ` (${applied.filter((f) => f.enabled).length})` : ""}
            </button>
            <div style={{ position: "relative" }}>
              <button className={`btn${hidden.size ? " on" : ""}`} onClick={() => setColumnsOpen((o) => !o)}>Columns</button>
              {columnsOpen && <ColumnsPopover columns={columns.map((c) => c.name)} hidden={hidden} setHidden={setHidden} onClose={() => setColumnsOpen(false)} />}
            </div>
            <div className="pager">
              <button className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} title="Previous page"><IconLeft /></button>
              <select className="input pager-size" value={limit} onChange={(e) => { setOffset(0); setLimit(+e.target.value); }} title="Rows per page">
                {[100, 300, 500, 1000, 5000].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <button className="btn small" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)} title="Next page"><IconRight /></button>
            </div>
          </>
        ) : (
          <>
            <span className="spacer" />
            <span className="muted status-text">
              {structurePending ? <span style={{ color: "var(--orange)" }}>{structurePending} pending · {mod}S to commit · </span> : null}
              {structure ? `${structure.columns.length} columns · ${structure.indexes.length} indexes` : ""}
            </span>
            <span className="spacer" />
            <button className="btn" onClick={() => onExport([table])}>Export…</button>
          </>
        )}
      </div>

      {preview && (
        <Modal
          title={ws.safeMode ? "Safe mode — review changes before committing" : !pk.length ? "This table has no primary key — rows are matched on every column" : "Pending changes"}
          width={640}
          onClose={() => setPreview(null)}
          footer={
            <>
              <button className="btn" onClick={() => navigator.clipboard.writeText(preview.join("\n"))}>Copy SQL</button>
              <span className="spacer" />
              <button className="btn" onClick={() => { resetEdits(); setPreview(null); }}>Discard</button>
              <button className="btn" onClick={() => setPreview(null)}>Cancel</button>
              <button className="btn primary" autoFocus={!ws.safeMode} onClick={() => commit(true)}>Commit</button>
            </>
          }
        >
          <pre className="mono code-box">{preview.join("\n")}</pre>
        </Modal>
      )}
      {quickLook && rows[quickLook.r] && (
        <QuickLook
          column={columns[quickLook.c]}
          value={rows[quickLook.r][quickLook.c] === DEFAULT_VALUE ? null : rows[quickLook.r][quickLook.c]}
          editable={editable && !edits.deleted.includes(quickLook.r)}
          onSave={(v) => setValue(quickLook.r, quickLook.c, v)}
          onClose={() => setQuickLook(null)}
        />
      )}
    </div>
  );
}

/** Same rules as keyboard paste: tab-separated text is a grid, anything else is one value. */
function parseClip(text: string): string[][] {
  const t = text.replace(/\r?\n$/, "");
  if (!t.includes("\t") && !t.includes("\n")) return [[t]];
  return t.split(/\r?\n/).map((l) => l.split("\t"));
}

const truncate = (s: string) => (s.length > 24 ? s.slice(0, 24) + "…" : s);

function FilterBar({
  columns,
  filters,
  setFilters,
  onApply,
  onClose,
}: {
  columns: string[];
  filters: FilterRow[];
  setFilters: (f: FilterRow[]) => void;
  onApply: (f?: FilterRow[]) => void;
  onClose: () => void;
}) {
  const update = (id: number, patch: Partial<FilterRow>) => setFilters(filters.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const add = (after: number) => {
    const i = filters.findIndex((f) => f.id === after);
    const next = [...filters];
    next.splice(i + 1, 0, newFilter(columns[0] ?? ""));
    setFilters(next);
  };
  const remove = (id: number) => {
    const next = filters.filter((f) => f.id !== id);
    if (!next.length) onClose();
    setFilters(next);
    onApply(next);
  };
  return (
    <div className="filter-bar" onKeyDown={(e) => {
      if (e.key === "Enter") { e.preventDefault(); onApply(); }
      if (e.key === "Escape") onClose();
    }}>
      {filters.map((f) => (
        <div className="filter-row" key={f.id}>
          <input type="checkbox" checked={f.enabled} onChange={(e) => update(f.id, { enabled: e.target.checked })} />
          <select className="input filter-col" value={f.column} onChange={(e) => update(f.id, { column: e.target.value })}>
            <option value={RAW}>Raw SQL</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {f.column !== RAW && (
            <select className="input filter-op" value={f.op} onChange={(e) => update(f.id, { op: e.target.value })}>
              {OPERATORS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          <input
            className="input mono filter-value"
            autoFocus
            disabled={NO_VALUE.has(f.op) && f.column !== RAW}
            placeholder={f.column === RAW ? "e.g. id > 10 AND status = 'paid'" : f.op === "IN" || f.op === "NOT IN" ? "a, b, c" : f.op === "BETWEEN" ? "low, high" : NO_VALUE.has(f.op) ? "" : "EMPTY"}
            value={f.value}
            onChange={(e) => update(f.id, { value: e.target.value })}
          />
          <button className="btn small" onClick={() => onApply()}>Apply</button>
          <button className="btn small icon" onClick={() => remove(f.id)} title="Remove filter"><IconMinus /></button>
          <button className="btn small icon" onClick={() => add(f.id)} title="Add filter"><IconPlus size={10} /></button>
        </div>
      ))}
      <div className="filter-foot">
        <span className="faint">Show/hide: {mod}F · Apply: ↩ · Close: Esc · all filters are combined with AND</span>
        <span className="spacer" />
        <button className="btn small" onClick={() => { const cleared = filters.map((f) => ({ ...f, value: "" })); setFilters(cleared); onApply([]); }}>Clear</button>
        <button className="btn small primary" onClick={() => onApply()}>Apply All</button>
      </div>
    </div>
  );
}

function ColumnsPopover({ columns, hidden, setHidden, onClose }: { columns: string[]; hidden: Set<string>; setHidden: (s: Set<string>) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    setTimeout(() => window.addEventListener("mousedown", h));
    return () => window.removeEventListener("mousedown", h);
  }, [onClose]);
  return (
    <div className="popover" ref={ref}>
      <div className="row" style={{ padding: "2px 4px 6px" }}>
        <button className="btn small" onClick={() => setHidden(new Set())}>Show all</button>
        <button className="btn small" onClick={() => setHidden(new Set(columns.slice(1)))}>Hide all</button>
      </div>
      {columns.map((c) => (
        <label key={c} className="popover-item">
          <input
            type="checkbox"
            checked={!hidden.has(c)}
            onChange={(e) => {
              const n = new Set(hidden);
              if (e.target.checked) n.delete(c);
              else n.add(c);
              setHidden(n);
            }}
          />
          <span className="mono">{c}</span>
        </label>
      ))}
    </div>
  );
}
