import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Cell, ColumnMeta, ForeignRef, SortSpec } from "../api";
import { DEFAULT_VALUE } from "../lib/edits";
import { parseCsv } from "../lib/csv";
import { IconArrow, IconSortDown, IconSortUp } from "../components/icons";
import { toTsv } from "../lib/export";
import "./grid.css";

const ROW_H = 25;
const HEAD_H = 28;
const NUMERIC = /^(int|integer|bigint|smallint|tinyint|mediumint|serial|bigserial|numeric|decimal|newdecimal|float|double|real|money|long|longlong|short|tiny|int24|oid)/i;

export interface GridSelection {
  rows: number[];
  focus: { r: number; c: number } | null;
}

export interface DataGridHandle {
  focus: () => void;
  selectAll: () => void;
  scrollToBottom: () => void;
  resetWidths: () => void;
  selection: () => GridSelection;
}

interface Props {
  columns: ColumnMeta[];
  rows: Cell[][];
  rowNumbers?: boolean;
  rowState?: (r: number) => "inserted" | "deleted" | undefined;
  cellEdited?: (r: number, c: number) => boolean;
  editable?: boolean;
  onEdit?: (r: number, c: number, value: Cell) => void;
  sorts?: SortSpec[];
  /** `add` = shift-click: append to a multi-column sort. */
  onSort?: (column: string, add: boolean) => void;
  onHeaderContextMenu?: (e: React.MouseEvent, c: number) => void;
  /** Clipboard text pasted while the grid has focus, already split into rows/cells. */
  onPaste?: (rows: string[][], sel: GridSelection) => void;
  onQuickLook?: (r: number, c: number) => void;
  foreign?: Record<string, ForeignRef>;
  onForeign?: (column: string, value: string) => void;
  onSelectionChange?: (s: GridSelection) => void;
  onContextMenu?: (e: React.MouseEvent, r: number, c: number, sel: GridSelection) => void;
  onDeleteRows?: (rows: number[]) => void;
  /** Changes when the data set changes, to reset selection and widths. */
  dataKey?: string;
}

function measure(columns: ColumnMeta[], rows: Cell[][]): number[] {
  return columns.map((col, i) => {
    let max = col.name.length * 7.6 + 26;
    const n = Math.min(rows.length, 120);
    for (let r = 0; r < n; r++) {
      const v = rows[r][i];
      const len = v === null ? 4 : Math.min(v.length, 60);
      max = Math.max(max, len * 7.5 + 22);
    }
    return Math.round(Math.min(Math.max(max, 46), 380));
  });
}

export const DataGrid = forwardRef<DataGridHandle, Props>(function DataGrid(props, ref) {
  const {
    columns,
    rows,
    rowNumbers,
    rowState,
    cellEdited,
    editable,
    onEdit,
    sorts,
    onSort,
    onHeaderContextMenu,
    onPaste,
    onQuickLook,
    foreign,
    onForeign,
    onSelectionChange,
    onContextMenu,
    onDeleteRows,
    dataKey,
  } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[]>(() => measure(columns, rows));
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [sel, setSel] = useState<GridSelection>({ rows: [], focus: null });
  const anchor = useRef<number | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);

  const numeric = useMemo(
    () =>
      columns.map((c, i) => {
        if (c.typeName) return NUMERIC.test(c.typeName);
        const sample = rows.slice(0, 50).map((r) => r[i]).filter((v): v is string => v !== null);
        return sample.length > 0 && sample.every((v) => /^-?\d+(\.\d+)?$/.test(v));
      }),
    [columns, rows],
  );

  useEffect(() => {
    setWidths(measure(columns, rows));
    setSel({ rows: [], focus: null });
    setEditing(null);
    anchor.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, columns.length]);

  useEffect(() => onSelectionChange?.(sel), [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => scroller.current?.focus(),
    selectAll: () => setSel({ rows: rows.map((_, i) => i), focus: sel.focus ?? { r: 0, c: 0 } }),
    scrollToBottom: () => {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    },
    resetWidths: () => setWidths(measure(columns, rows)),
    selection: () => sel,
  }));

  const numW = rowNumbers ? Math.max(34, String(rows.length).length * 8 + 16) : 0;
  const totalW = numW + widths.reduce((a, b) => a + b, 0);
  const first = Math.max(0, Math.floor((scrollTop - HEAD_H) / ROW_H) - 8);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + 8);
  const lefts = useMemo(() => {
    const out: number[] = [];
    let x = numW;
    for (const w of widths) {
      out.push(x);
      x += w;
    }
    return out;
  }, [widths, numW]);

  const ensureVisible = (r: number, c: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = HEAD_H + r * ROW_H;
    if (top < el.scrollTop + HEAD_H) el.scrollTop = top - HEAD_H;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight + 12;
    const left = lefts[c] ?? 0;
    const w = widths[c] ?? 0;
    if (left < el.scrollLeft + numW) el.scrollLeft = left - numW;
    else if (left + w > el.scrollLeft + el.clientWidth) el.scrollLeft = left + w - el.clientWidth + 12;
  };

  const select = (r: number, c: number, mode: "set" | "extend" | "toggle") => {
    setSel((prev) => {
      let rowsSel: number[];
      if (mode === "extend" && anchor.current !== null) {
        const [a, b] = [Math.min(anchor.current, r), Math.max(anchor.current, r)];
        rowsSel = Array.from({ length: b - a + 1 }, (_, i) => a + i);
      } else if (mode === "toggle") {
        rowsSel = prev.rows.includes(r) ? prev.rows.filter((x) => x !== r) : [...prev.rows, r].sort((a, b) => a - b);
        anchor.current = r;
      } else {
        rowsSel = [r];
        anchor.current = r;
      }
      return { rows: rowsSel, focus: { r, c } };
    });
  };

  const startEdit = (r: number, c: number, initial?: string) => {
    if (!editable || rowState?.(r) === "deleted") return;
    const v = rows[r]?.[c];
    setEditing({ r, c, value: initial ?? v ?? "" });
  };

  const commitEdit = (value: Cell) => {
    if (!editing) return;
    const { r, c } = editing;
    setEditing(null);
    if (value !== rows[r][c]) onEdit?.(r, c, value);
    scroller.current?.focus();
  };

  const copy = () => {
    if (!sel.rows.length) return;
    let text: string;
    if (sel.rows.length === 1 && sel.focus) {
      text = rows[sel.focus.r]?.[sel.focus.c] ?? "NULL";
    } else {
      text = toTsv(sel.rows.map((r) => rows[r]));
    }
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const f = sel.focus ?? { r: 0, c: 0 };
    const mod = e.metaKey || e.ctrlKey;
    const move = (r: number, c: number) => {
      r = Math.max(0, Math.min(rows.length - 1, r));
      c = Math.max(0, Math.min(columns.length - 1, c));
      select(r, c, e.shiftKey ? "extend" : "set");
      ensureVisible(r, c);
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(mod ? rows.length - 1 : f.r + 1, f.c);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(mod ? 0 : f.r - 1, f.c);
        return;
      case "ArrowLeft":
        e.preventDefault();
        if (!e.shiftKey) move(f.r, mod ? 0 : f.c - 1);
        return;
      case "ArrowRight":
        e.preventDefault();
        if (!e.shiftKey) move(f.r, mod ? columns.length - 1 : f.c + 1);
        return;
      case "Tab":
        e.preventDefault();
        move(f.r, f.c + (e.shiftKey ? -1 : 1));
        return;
      case "PageDown":
        e.preventDefault();
        move(f.r + Math.floor(viewH / ROW_H) - 1, f.c);
        return;
      case "PageUp":
        e.preventDefault();
        move(f.r - Math.floor(viewH / ROW_H) + 1, f.c);
        return;
      case "Enter":
        if (sel.focus && !mod) {
          e.preventDefault();
          startEdit(sel.focus.r, sel.focus.c);
        }
        return;
      case "Backspace":
      case "Delete":
        if (sel.rows.length && editable && (mod || e.key === "Delete")) {
          e.preventDefault();
          onDeleteRows?.(sel.rows);
        }
        return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      if (sel.focus) navigator.clipboard.writeText(rows[sel.focus.r]?.[sel.focus.c] ?? "NULL").catch(() => {});
    } else if (mod && e.key === "Enter" && sel.focus) {
      e.preventDefault();
      onQuickLook?.(sel.focus.r, sel.focus.c);
    } else if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copy();
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSel({ rows: rows.map((_, i) => i), focus: sel.focus ?? { r: 0, c: 0 } });
    } else if (!mod && !e.altKey && e.key.length === 1 && sel.focus && editable) {
      e.preventDefault();
      startEdit(sel.focus.r, sel.focus.c, e.key);
    }
  };

  const startResize = (e: React.MouseEvent, c: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[c];
    const onMove = (ev: MouseEvent) => {
      setWidths((w) => w.map((x, i) => (i === c ? Math.max(36, startW + ev.clientX - startX) : x)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const autoFit = (c: number) => {
    let max = columns[c].name.length * 7.6 + 26;
    for (const r of rows) max = Math.max(max, Math.min((r[c]?.length ?? 4), 200) * 7.5 + 22);
    setWidths((w) => w.map((x, i) => (i === c ? Math.round(Math.min(max, 900)) : x)));
  };

  const selected = useMemo(() => new Set(sel.rows), [sel.rows]);

  const body: JSX.Element[] = [];
  for (let r = first; r < last; r++) {
    const row = rows[r];
    if (!row) continue;
    const state = rowState?.(r);
    const cls = `g-row${r % 2 ? " odd" : ""}${selected.has(r) ? " sel" : ""}${state ? ` ${state}` : ""}`;
    body.push(
      <div key={r} className={cls} style={{ top: HEAD_H + r * ROW_H, width: totalW }}>
        {rowNumbers && (
          <div className="g-cell g-num" style={{ width: numW, left: 0 }}>
            {r + 1}
          </div>
        )}
        {columns.map((col, c) => {
          const v = row[c];
          const isFocus = sel.focus?.r === r && sel.focus?.c === c;
          const edited = cellEdited?.(r, c);
          const fk = foreign?.[col.name];
          if (editing && editing.r === r && editing.c === c) {
            return (
              <div key={c} className="g-cell editing" style={{ width: widths[c], left: lefts[c] }}>
                <CellEditor
                  value={editing.value}
                  onCommit={(val) => commitEdit(val)}
                  onCancel={() => {
                    setEditing(null);
                    scroller.current?.focus();
                  }}
                  onTab={(val, back) => {
                    commitEdit(val);
                    const nc = Math.max(0, Math.min(columns.length - 1, c + (back ? -1 : 1)));
                    select(r, nc, "set");
                  }}
                />
              </div>
            );
          }
          return (
            <div
              key={c}
              className={`g-cell${numeric[c] ? " num" : ""}${isFocus ? " focus" : ""}${edited ? " edited" : ""}`}
              style={{ width: widths[c], left: lefts[c] }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                select(r, c, e.shiftKey ? "extend" : e.metaKey || e.ctrlKey ? "toggle" : "set");
              }}
              onDoubleClick={() => startEdit(r, c)}
              onContextMenu={(e) => {
                e.preventDefault();
                let s = sel;
                if (!selected.has(r)) {
                  s = { rows: [r], focus: { r, c } };
                  anchor.current = r;
                  setSel(s);
                } else if (!isFocus) {
                  s = { ...sel, focus: { r, c } };
                  setSel(s);
                }
                onContextMenu?.(e, r, c, s);
              }}
            >
              {v === DEFAULT_VALUE ? (
                <span className="g-default">DEFAULT</span>
              ) : v === null ? (
                <span className="g-null">NULL</span>
              ) : v === "" ? (
                <span className="g-null">EMPTY</span>
              ) : (
                <span className="g-text">{v.length > 300 ? v.slice(0, 300).replace(/\s+/g, " ") + "…" : v.replace(/[\r\n]+/g, " ")}</span>
              )}
              {fk && v !== null && (
                <button
                  className="g-fk"
                  title={`Open ${fk.table} where ${fk.column} = ${v}`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => onForeign?.(col.name, v)}
                >
                  <IconArrow />
                </button>
              )}
            </div>
          );
        })}
      </div>,
    );
  }

  return (
    <div
      className="grid"
      ref={scroller}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onPaste={(e) => {
        if (editing || !onPaste) return;
        const text = e.clipboardData.getData("text/plain");
        if (!text) return;
        e.preventDefault();
        // Tab-separated (from a spreadsheet or Querybird) is a grid; anything else is a single value,
        // so "Smith, John" stays in one cell.
        const t = text.replace(/\r?\n$/, "");
        onPaste(t.includes("\t") || t.includes("\n") ? parseCsv(t, "\t") : [[t]], sel);
      }}
    >
      <div style={{ height: HEAD_H + rows.length * ROW_H + 4, width: totalW, position: "relative" }}>
        <div className="g-head" style={{ width: Math.max(totalW, 0) }}>
          {rowNumbers && <div className="g-hcell g-num" style={{ width: numW, left: 0 }} />}
          {columns.map((col, c) => (
            <div
              key={c}
              className="g-hcell"
              style={{ width: widths[c], left: lefts[c] }}
              title={col.typeName ? `${col.name} · ${col.typeName}` : col.name}
              onClick={(e) => onSort?.(col.name, e.shiftKey)}
              onContextMenu={(e) => {
                e.preventDefault();
                onHeaderContextMenu?.(e, c);
              }}
            >
              <span className="g-htext">{col.name}</span>
              {(() => {
                const i = sorts?.findIndex((s) => s.column === col.name) ?? -1;
                if (i < 0) return null;
                return (
                  <span className="g-sort">
                    {sorts![i].desc ? <IconSortDown /> : <IconSortUp />}
                    {sorts!.length > 1 ? i + 1 : ""}
                  </span>
                );
              })()}
              <span className="g-resize" onMouseDown={(e) => startResize(e, c)} onDoubleClick={() => autoFit(c)} onClick={(e) => e.stopPropagation()} />
            </div>
          ))}
        </div>
        {body}
        {!rows.length && (
          <div className="g-filler" style={{ top: HEAD_H, width: Math.max(totalW, 200) }}>
            {Array.from({ length: 30 }, (_, i) => (
              <div key={i} className={`g-row${i % 2 ? " odd" : ""}`} style={{ top: i * ROW_H, width: "100%" }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

function CellEditor({
  value,
  onCommit,
  onCancel,
  onTab,
}: {
  value: string;
  onCommit: (v: Cell) => void;
  onCancel: () => void;
  onTab: (v: Cell, back: boolean) => void;
}) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, []);
  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  return (
    <input
      ref={ref}
      className="g-input"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(() => onCommit(v))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(() => onCommit(v));
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(onCancel);
        } else if (e.key === "Tab") {
          e.preventDefault();
          finish(() => onTab(v, e.shiftKey));
        }
      }}
    />
  );
}
