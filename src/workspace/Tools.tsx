import { useEffect, useMemo, useState } from "react";
import { api, errorText, type Change, type TableStructure } from "../api";
import { IconSearch, IconTable } from "../components/icons";
import { Modal } from "../components/ui";
import { parseCsv, sniffDelimiter } from "../lib/csv";
import { quoteIdent, toCsv, toInsertSql, toJson } from "../lib/export";
import { useSettings } from "../lib/settings";
import { splitStatements } from "../lib/sql";
import { useWs } from "./context";

const DELIMS: [string, string][] = [[",", "Comma ,"], [";", "Semicolon ;"], ["\t", "Tab"], ["|", "Pipe |"]];
/** Table names can contain path separators; never let them escape the chosen folder. */
const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "_") || "table";
/** Keep names on one line inside SQL comments of an export. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ");
const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, "")}${dir.includes("\\") && !dir.includes("/") ? "\\" : "/"}${name}`;

// ---------------------------------------------------------------- export

export function ExportDialog({ preselect, onClose }: { preselect: string[]; onClose: () => void }) {
  const ws = useWs();
  const settings = useSettings();
  const all = useMemo(() => [...ws.objects.tables, ...ws.objects.views], [ws.objects]);
  const [selected, setSelected] = useState<Set<string>>(new Set(preselect.length ? preselect : ws.objects.tables));
  const [format, setFormat] = useState<"csv" | "json" | "sql">("csv");
  const [nullAsEmpty, setNullAsEmpty] = useState(true);
  const [lineBreakToSpace, setLineBreakToSpace] = useState(false);
  const [escapeFormulas, setEscapeFormulas] = useState(true);
  const [header, setHeader] = useState(true);
  const [delimiter, setDelimiter] = useState(settings.csvDelimiter);
  const [withStructure, setWithStructure] = useState(true);
  const [withData, setWithData] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const tables = all.filter((t) => selected.has(t));
  const q = (t: string) => `${quoteIdent(ws.driver, ws.schema)}.${quoteIdent(ws.driver, t)}`;

  const fetchAll = async (t: string) => {
    setBusy(`Reading ${t}…`);
    const sql = `SELECT * FROM ${q(t)}`;
    ws.log(sql);
    const [r] = await api.execute(ws.sessionId, sql);
    return r;
  };

  const run = async () => {
    if (!tables.length) return;
    try {
      if (format === "csv") {
        const opts = { delimiter, header, nullAsEmpty, lineBreakToSpace, escapeFormulas };
        if (tables.length === 1) {
          const path = await api.pickPath("save", { defaultName: `${safeFileName(tables[0])}.csv`, filterName: "CSV", extensions: ["csv"] });
          if (!path) return;
          const r = await fetchAll(tables[0]);
          await api.writeTextFile(path, toCsv(r.columns, r.rows, opts));
        } else {
          const dir = await api.pickPath("folder");
          if (!dir) return;
          for (const t of tables) {
            const r = await fetchAll(t);
            await api.writeTextFile(join(dir, `${safeFileName(t)}.csv`), toCsv(r.columns, r.rows, opts));
          }
        }
      } else {
        const ext = format;
        const path = await api.pickPath("save", { defaultName: `${safeFileName(tables.length === 1 ? tables[0] : ws.schema)}.${ext}`, filterName: ext.toUpperCase(), extensions: [ext] });
        if (!path) return;
        if (format === "json") {
          const out: Record<string, unknown> = {};
          for (const t of tables) {
            const r = await fetchAll(t);
            out[t] = JSON.parse(toJson(r.columns, r.rows));
          }
          await api.writeTextFile(path, JSON.stringify(tables.length === 1 ? out[tables[0]] : out, null, 2));
        } else {
          const parts: string[] = [`-- Querybird SQL export of ${ws.schema} — ${new Date().toISOString()}`];
          for (const t of tables) {
            if (withStructure && ws.objects.tables.includes(t)) {
              setBusy(`Reading structure of ${t}…`);
              parts.push(`\n-- Structure: ${oneLine(t)}\n${await api.tableDdl(ws.sessionId, ws.schema, t)}`);
            }
            if (withData) {
              const r = await fetchAll(t);
              if (r.rows.length) parts.push(`\n-- Data: ${oneLine(t)}\n${toInsertSql(ws.driver, t, r.columns, r.rows)}`);
            }
          }
          await api.writeTextFile(path, parts.join("\n") + "\n");
        }
      }
      ws.toast(`Exported ${tables.length} item${tables.length === 1 ? "" : "s"}`);
      onClose();
    } catch (e) {
      ws.toast(errorText(e), true);
    } finally {
      setBusy(null);
    }
  };

  const check = (label: string, value: boolean, set: (v: boolean) => void) => (
    <label className="row" style={{ gap: 7 }}>
      <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} /> {label}
    </label>
  );

  return (
    <Modal
      title="Export"
      width={640}
      onClose={onClose}
      footer={
        <>
          <span className="faint" style={{ fontSize: 12 }}>{busy ?? `${tables.length} selected`}</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!tables.length || !!busy} onClick={run}>Export…</button>
        </>
      }
    >
      <div style={{ display: "flex", gap: 14, minHeight: 300 }}>
        <div className="export-items">
          <label className="row export-all">
            <input
              type="checkbox"
              checked={tables.length === all.length}
              onChange={(e) => setSelected(new Set(e.target.checked ? all : []))}
            />
            <b>{ws.schema}</b>
          </label>
          {all.map((t) => (
            <label key={t} className="row" style={{ gap: 6, padding: "2px 0 2px 16px" }}>
              <input
                type="checkbox"
                checked={selected.has(t)}
                onChange={(e) => {
                  const n = new Set(selected);
                  if (e.target.checked) n.add(t);
                  else n.delete(t);
                  setSelected(n);
                }}
              />
              <IconTable size={13} /> <span className="mono">{t}</span>
            </label>
          ))}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="segmented" style={{ alignSelf: "center" }}>
            {(["csv", "json", "sql"] as const).map((f) => (
              <button key={f} className={format === f ? "active" : ""} onClick={() => setFormat(f)}>{f.toUpperCase()}</button>
            ))}
          </div>
          <div className="export-options">
            {format === "csv" && (
              <>
                {check("Convert NULL to EMPTY", nullAsEmpty, setNullAsEmpty)}
                {check("Convert line break to space", lineBreakToSpace, setLineBreakToSpace)}
                {check("Put field names in the first row", header, setHeader)}
                {check("Escape spreadsheet formulas (=, +, -, @)", escapeFormulas, setEscapeFormulas)}
                <label className="row">
                  <span style={{ width: 70 }}>Delimiter</span>
                  <select className="input" value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
                    {DELIMS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
                  </select>
                </label>
                <div className="faint" style={{ fontSize: 12 }}>{tables.length > 1 ? "One file per table, in a folder you choose." : ""}</div>
              </>
            )}
            {format === "json" && <div className="muted">Export data as JSON{tables.length > 1 ? " (an object keyed by table name)" : ""}.</div>}
            {format === "sql" && (
              <>
                {check("Include structure (CREATE TABLE)", withStructure, setWithStructure)}
                {check("Include data (INSERT)", withData, setWithData)}
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- import CSV

export function ImportCsvDialog({ table: initialTable, onClose }: { table?: string; onClose: () => void }) {
  const ws = useWs();
  const [table, setTable] = useState(initialTable ?? ws.objects.tables[0] ?? "");
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [delimiter, setDelimiter] = useState(",");
  const [hasHeader, setHasHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (table) api.tableStructure(ws.sessionId, ws.schema, table).then(setStructure).catch(() => setStructure(null));
  }, [table]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => (text ? parseCsv(text, delimiter) : []), [text, delimiter]);
  const fileCols = hasHeader ? rows[0] ?? [] : (rows[0] ?? []).map((_, i) => `column ${i + 1}`);
  const data = hasHeader ? rows.slice(1) : rows;

  // Map table columns to file columns by name, falling back to position.
  useEffect(() => {
    if (!structure) return;
    const m: Record<string, number> = {};
    structure.columns.forEach((c, i) => {
      const byName = fileCols.findIndex((f) => f.trim().toLowerCase() === c.name.toLowerCase());
      if (byName >= 0) m[c.name] = byName;
      else if (!hasHeader && i < fileCols.length) m[c.name] = i;
    });
    setMapping(m);
  }, [structure, text, hasHeader, delimiter]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async () => {
    const p = await api.pickPath("open", { filterName: "CSV", extensions: ["csv", "tsv", "txt"] });
    if (!p) return;
    const t = await api.readTextFile(p);
    setPath(p);
    setText(t);
    setDelimiter(sniffDelimiter(t));
  };

  const run = async () => {
    const mapped = Object.entries(mapping).filter(([, i]) => i >= 0);
    if (!mapped.length || !data.length) return;
    setBusy(true);
    try {
      const changes: Change[] = data.map((r) => ({
        kind: "insert",
        schema: ws.schema,
        table,
        key: [],
        values: mapped.map(([column, i]) => {
          const v = r[i] ?? "";
          return { column, value: emptyAsNull && v === "" ? null : v };
        }),
      }));
      const done = await api.applyChanges(ws.sessionId, changes);
      ws.log(`-- imported ${done.length} rows into ${table} from ${path}`);
      ws.toast(`Imported ${done.length.toLocaleString()} rows into ${table}`);
      window.dispatchEvent(new CustomEvent("querybird:table-changed", { detail: table }));
      onClose();
    } catch (e) {
      ws.toast(`Nothing was imported (the import runs in one transaction):\n${errorText(e)}`, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Import from CSV"
      width={700}
      onClose={onClose}
      footer={
        <>
          <span className="faint" style={{ fontSize: 12 }}>{data.length ? `${data.length.toLocaleString()} rows in file` : ""}</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !data.length || !Object.values(mapping).some((i) => i >= 0)} onClick={run}>
            {busy ? "Importing…" : "Import"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>File</label>
        <div className="row">
          <button className="btn" onClick={pick}>Choose file…</button>
          <span className="mono faint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{path ?? "no file selected"}</span>
        </div>
        <label>Into table</label>
        <select className="input" value={table} onChange={(e) => setTable(e.target.value)}>
          {ws.objects.tables.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label>Options</label>
        <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
          <select className="input" style={{ width: 130 }} value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
            {DELIMS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
          </select>
          <label className="row"><input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> First row is header</label>
          <label className="row"><input type="checkbox" checked={emptyAsNull} onChange={(e) => setEmptyAsNull(e.target.checked)} /> Empty as NULL</label>
        </div>
      </div>
      {structure && rows.length > 0 && (
        <div className="import-map">
          <div className="import-map-head"><span>Table column</span><span>From file column</span><span>Sample</span></div>
          {structure.columns.map((c) => (
            <div key={c.name} className="import-map-row">
              <span className="mono">{c.name} <span className="faint">{c.dataType}</span></span>
              <select className="input" value={mapping[c.name] ?? -1} onChange={(e) => setMapping({ ...mapping, [c.name]: +e.target.value })}>
                <option value={-1}>— skip (use default) —</option>
                {fileCols.map((f, i) => <option key={i} value={i}>{f}</option>)}
              </select>
              <span className="mono faint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {mapping[c.name] >= 0 ? data[0]?.[mapping[c.name]] ?? "" : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- import SQL

export function ImportSqlDialog({ onClose }: { onClose: () => void }) {
  const ws = useWs();
  const [path, setPath] = useState<string | null>(null);
  const [statements, setStatements] = useState<string[]>([]);
  const [transaction, setTransaction] = useState(ws.driver !== "mysql");
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    const p = await api.pickPath("open", { filterName: "SQL", extensions: ["sql", "txt"] });
    if (!p) return;
    setPath(p);
    setStatements(splitStatements(await api.readTextFile(p)).map((s) => s.text));
  };

  const run = async () => {
    setBusy(true);
    try {
      const done = await api.runStatements(ws.sessionId, statements, transaction);
      ws.log(`-- ran ${done.length} statements from ${path}`);
      ws.toast(`Ran ${done.length.toLocaleString()} statements`);
      window.dispatchEvent(new Event("querybird:refresh-objects"));
      onClose();
    } catch (e) {
      ws.toast(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Import SQL dump"
      width={640}
      onClose={onClose}
      footer={
        <>
          <label className="row"><input type="checkbox" checked={transaction} onChange={(e) => setTransaction(e.target.checked)} /> Run in a transaction (stop &amp; roll back on error)</label>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!statements.length || busy} onClick={run}>{busy ? "Running…" : `Run ${statements.length || ""} statements`}</button>
        </>
      }
    >
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn" onClick={pick}>Choose file…</button>
        <span className="mono faint">{path ?? "no file selected"}</span>
      </div>
      {statements.length > 0 && (
        <pre className="mono code-box">{statements.slice(0, 20).join(";\n\n")};{statements.length > 20 ? `\n\n-- … and ${statements.length - 20} more` : ""}</pre>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- search in database

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const ws = useWs();
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<{ table: string; count: number; whereSql: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const search = async () => {
    if (!term.trim()) return;
    setBusy(true);
    try {
      setHits(await api.searchDatabase(ws.sessionId, ws.schema, term.trim()));
    } catch (e) {
      ws.toast(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Search in ${ws.schema}`} width={520} onClose={onClose}>
      <div className="row">
        <div className="search" style={{ flex: 1 }}>
          <IconSearch />
          <input className="input" autoFocus placeholder="Text to find in any column of any table" value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
        </div>
        <button className="btn primary" disabled={busy} onClick={search}>{busy ? "Searching…" : "Search"}</button>
      </div>
      <div className="anything-list">
        {hits?.map((h) => (
          <div
            key={h.table}
            className="tree-item"
            onClick={() => {
              onClose();
              ws.openTable(ws.schema, h.table, { newTab: true, filters: [{ column: "__raw__", op: "=", value: h.whereSql }] });
            }}
          >
            <IconTable />
            <span className="tree-label">{h.table}</span>
            <span className="faint" style={{ marginLeft: "auto" }}>{h.count.toLocaleString()} matching row{h.count === 1 ? "" : "s"}</span>
          </div>
        ))}
        {hits && !hits.length && <div className="empty">No matches for “{term}”</div>}
      </div>
    </Modal>
  );
}
