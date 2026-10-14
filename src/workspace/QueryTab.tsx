import { useEffect, useMemo, useRef, useState } from "react";
import { format } from "sql-formatter";
import { api, errorText, type QueryResult } from "../api";
import { IconChevronDown } from "../components/icons";
import { Modal, mod } from "../components/ui";
import { isReadOnly, splitStatements, statementAt, withLimit } from "../lib/sql";
import { toCsv, toInsertSql, toJson, toTsv } from "../lib/export";
import { DataGrid, type GridSelection } from "./DataGrid";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { useWs, type Details, type TabApi } from "./context";
import { getSettings } from "../lib/settings";

interface Run {
  results: { sql: string; result?: QueryResult; error?: string }[];
  elapsed: number;
}

export function QueryTab({
  initialSql,
  autoRun,
  active,
  onSqlChange,
  onDetails,
  register,
  onSaveQuery,
}: {
  initialSql: string;
  autoRun?: boolean;
  active: boolean;
  onSqlChange: (sql: string) => void;
  onDetails: (d: Details | null) => void;
  register: (a: TabApi) => void;
  onSaveQuery: (sql: string) => void;
}) {
  const ws = useWs();
  const editor = useRef<SqlEditorHandle>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1, pos: 0 });
  const [limit, setLimit] = useState<number | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [resultIdx, setResultIdx] = useState(0);
  const [pane, setPane] = useState<"data" | "message">("data");
  const [running, setRunning] = useState(false);
  const [confirm, setConfirm] = useState<{ statements: string[] } | null>(null);
  const [selection, setSelection] = useState<GridSelection>({ rows: [], focus: null });
  const [editorH, setEditorH] = useState(0.45);
  const [runMenu, setRunMenu] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const tables = useMemo(() => [...ws.objects.tables, ...ws.objects.views], [ws.objects]);

  const execute = async (statements: string[], force = false) => {
    if (!statements.length) return;
    if (ws.safeMode && !force && statements.some((s) => !isReadOnly(s))) {
      setConfirm({ statements });
      return;
    }
    setConfirm(null);
    setRunning(true);
    ws.setLoading(1);
    const started = performance.now();
    const results: Run["results"] = [];
    for (const raw of statements) {
      const sql = withLimit(raw, limit);
      ws.log(sql);
      ws.addHistory(raw);
      try {
        const res = await api.execute(ws.sessionId, sql);
        if (!res.length) results.push({ sql, result: { columns: [], rows: [], affected: 0, elapsedMs: 0 } });
        res.forEach((r) => results.push({ sql, result: r }));
      } catch (e) {
        results.push({ sql, error: errorText(e) });
        break;
      }
    }
    setRunning(false);
    ws.setLoading(-1);
    const withRows = results.map((r, i) => [r, i] as const).filter(([r]) => r.result?.columns.length);
    const failed = results.some((r) => r.error);
    setRun({ results, elapsed: performance.now() - started });
    setResultIdx(withRows.length ? withRows[withRows.length - 1][1] : results.length - 1);
    setPane(failed || !withRows.length ? "message" : "data");
    // Schema changes should show up in the sidebar.
    if (statements.some((s) => /^\s*(create|drop|alter|rename)\b/i.test(s))) window.dispatchEvent(new Event("querybird:refresh-objects"));
  };

  const runCurrent = () => {
    const sel = editor.current!.getSelection();
    if (sel.text.trim()) return execute(splitStatements(sel.text).map((s) => s.text));
    const text = editor.current!.getValue();
    const st = statementAt(text, sel.head);
    if (st) execute([st.text]);
  };
  const runAll = () => execute(splitStatements(editor.current!.getValue()).map((s) => s.text));

  const beautify = () => {
    const ed = editor.current!;
    const sel = ed.getSelection();
    const language = ws.driver === "mysql" ? "mysql" : "postgresql";
    try {
      const keywordCase = getSettings().uppercaseKeywords ? "upper" : "preserve";
      if (sel.text.trim()) ed.replaceRange(sel.from, sel.to, format(sel.text, { language, keywordCase }));
      else ed.setValue(format(ed.getValue(), { language, keywordCase }));
    } catch (e) {
      ws.toast(`Could not format: ${errorText(e)}`, true);
    }
  };

  useEffect(() => {
    register({
      reload: runCurrent,
      save: () => onSaveQuery(editor.current!.getValue()),
      runCurrent,
      runAll,
      beautify,
      find: () => editor.current?.find(),
    });
  });

  useEffect(() => {
    if (autoRun) setTimeout(runAll, 0);
    setTimeout(() => editor.current?.focus(), 0);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const current = run?.results[resultIdx];
  const result = current?.result;
  const resultSets = run?.results.map((r, i) => [r, i] as const).filter(([r]) => r.result?.columns.length) ?? [];

  useEffect(() => {
    if (!active) return;
    const r = selection.focus?.r;
    onDetails(result && r != null && result.rows[r] ? { columns: result.columns, row: result.rows[r], editable: false } : { columns: [], row: null, editable: false });
  }, [active, selection, result]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportResult = async (kind: "csv" | "json" | "sql") => {
    if (!result) return;
    const path = await api.pickPath("save", { defaultName: `result.${kind}`, filterName: kind.toUpperCase(), extensions: [kind] });
    if (!path) return;
    const text = kind === "csv" ? toCsv(result.columns, result.rows, { escapeFormulas: true }) : kind === "json" ? toJson(result.columns, result.rows) : toInsertSql(ws.driver, "result", result.columns, result.rows);
    try {
      await api.writeTextFile(path, text);
      ws.toast(`Exported ${result.rows.length.toLocaleString()} rows`);
    } catch (e) {
      ws.toast(errorText(e), true);
    }
  };

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = bodyRef.current!.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => setEditorH(Math.min(0.85, Math.max(0.12, (ev.clientY - box.top) / box.height)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="tab-body" ref={bodyRef}>
      <div style={{ height: `${editorH * 100}%`, minHeight: 60, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <SqlEditor
            ref={editor}
            value={initialSql}
            driver={ws.driver}
            tables={tables}
            onChange={onSqlChange}
            onCursor={(line, col, pos) => setCursor({ line, col, pos })}
            onRunCurrent={runCurrent}
            onRunAll={runAll}
            onBeautify={beautify}
            onSave={() => onSaveQuery(editor.current!.getValue())}
          />
        </div>
        <div className="editor-bar" onMouseDown={(e) => e.target === e.currentTarget && startDrag(e)}>
          <span className="faint mono" style={{ fontSize: 11 }}>
            line {cursor.line}, column {cursor.col}, location {cursor.pos}
          </span>
          <span className="spacer" onMouseDown={startDrag} style={{ alignSelf: "stretch", cursor: "row-resize" }} />
          <select className="input" style={{ width: 104, height: 22 }} value={limit ?? ""} onChange={(e) => setLimit(e.target.value ? +e.target.value : null)} title="Append LIMIT to SELECTs">
            <option value="">No limit</option>
            {[100, 300, 1000, 5000].map((n) => <option key={n} value={n}>Limit {n}</option>)}
          </select>
          <button className="btn" onClick={beautify}>Beautify {mod}I</button>
          <div className="split-btn" style={{ position: "relative" }}>
            <button className="btn" disabled={running} onClick={runCurrent}>{running ? "Running…" : `Run Current ${mod}↵`}</button>
            <button className="btn" onClick={() => setRunMenu((o) => !o)} aria-label="More run options"><IconChevronDown /></button>
            {runMenu && (
              <div className="popover" style={{ right: 0, bottom: 28, top: "auto", minWidth: 180 }} onMouseLeave={() => setRunMenu(false)}>
                <div className="ctx-item" onClick={() => { setRunMenu(false); runCurrent(); }}>Run Current <span className="kbd">{mod}↵</span></div>
                <div className="ctx-item" onClick={() => { setRunMenu(false); runAll(); }}>Run All <span className="kbd">{mod}⇧↵</span></div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", borderTop: "1px solid var(--border)" }}>
        {resultSets.length > 1 && (
          <div className="result-tabs">
            {resultSets.map(([, i], n) => (
              <button key={i} className={i === resultIdx ? "active" : ""} onClick={() => { setResultIdx(i); setPane("data"); }}>
                Result {n + 1}
              </button>
            ))}
          </div>
        )}
        {!run ? (
          <div className="empty faint">Run a query to see results</div>
        ) : pane === "message" || !result?.columns.length ? (
          <div className="messages mono">
            {run.results.map((r, i) => (
              <div key={i} className="message">
                <div className="faint">{r.sql}</div>
                {r.error ? (
                  <div style={{ color: "var(--red)", whiteSpace: "pre-wrap" }}>{r.error}</div>
                ) : r.result?.columns.length ? (
                  <div style={{ color: "var(--green)" }}>OK · {plural(r.result.rows.length, "row")} · {r.result.elapsedMs.toFixed(1)} ms</div>
                ) : (
                  <div style={{ color: "var(--green)" }}>OK · {plural(r.result?.affected ?? 0, "row")} affected · {r.result?.elapsedMs.toFixed(1)} ms</div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <DataGrid
            columns={result.columns}
            rows={result.rows}
            rowNumbers
            dataKey={`${resultIdx}-${run.elapsed}`}
            onSelectionChange={setSelection}
            onContextMenu={(e, _r, c, sel) => {
              const rows = sel.rows.map((i) => result.rows[i]);
              const copy = (t: string) => navigator.clipboard.writeText(t);
              ws.setMenu({
                x: e.clientX,
                y: e.clientY,
                items: [
                  { label: "Copy", kbd: `${mod}C`, onClick: () => copy(rows.length > 1 ? toTsv(rows) : rows[0]?.[c] ?? "NULL") },
                  { label: "Copy Row as TSV", onClick: () => copy(toTsv(rows)) },
                  { label: "Copy Row as JSON", onClick: () => copy(toJson(result.columns, rows)) },
                  { label: "Copy Row as SQL INSERT", onClick: () => copy(toInsertSql(ws.driver, "result", result.columns, rows)) },
                  { label: "Copy Column Name", onClick: () => copy(result.columns[c].name) },
                ],
              });
            }}
          />
        )}
        <div className="bottom-bar">
          <div className="segmented">
            <button className={pane === "data" ? "active" : ""} onClick={() => setPane("data")}>Data</button>
            <button className={pane === "message" ? "active" : ""} onClick={() => setPane("message")}>Message</button>
          </div>
          <span className="muted" style={{ marginLeft: 8 }}>{run ? `${run.elapsed < 1000 ? run.elapsed.toFixed(0) + " ms" : (run.elapsed / 1000).toFixed(2) + " s"}` : ""}</span>
          <span className="spacer" />
          <span className="muted status-text">
            {result?.columns.length ? (selection.rows.length > 1 ? `${selection.rows.length} of ${result.rows.length.toLocaleString()} rows selected` : plural(result.rows.length, "row")) : current?.error ? <span style={{ color: "var(--red)" }}>Query failed</span> : ""}
          </span>
          <span className="spacer" />
          <ExportButton disabled={!result?.columns.length} onExport={exportResult} />
        </div>
      </div>

      {confirm && (
        <Modal
          title="Safe mode is on — run these statements?"
          width={600}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <span className="spacer" />
              <button className="btn" autoFocus onClick={() => setConfirm(null)}>Cancel</button>
              <button className="btn danger" onClick={() => execute(confirm.statements, true)}>Run</button>
            </>
          }
        >
          <pre className="mono code-box">{confirm.statements.join(";\n\n")};</pre>
        </Modal>
      )}
    </div>
  );
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

function ExportButton({ disabled, onExport }: { disabled: boolean; onExport: (k: "csv" | "json" | "sql") => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button className="btn" disabled={disabled} onClick={() => setOpen((o) => !o)}>Export...</button>
      {open && (
        <div className="popover" style={{ right: 0, bottom: 28, top: "auto", minWidth: 150 }} onMouseLeave={() => setOpen(false)}>
          {(["csv", "json", "sql"] as const).map((k) => (
            <div key={k} className="ctx-item" onClick={() => { setOpen(false); onExport(k); }}>
              {k === "sql" ? "SQL INSERT" : k.toUpperCase()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
