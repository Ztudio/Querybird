import { useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { IconChevron, IconFunction, IconPlus, IconQuery, IconSearch, IconTable, IconView } from "../components/icons";
import { Modal, load, mod, save, type MenuItem } from "../components/ui";
import { cloneTableStatements, createFunctionTemplate, createTableTemplate, createViewTemplate } from "../lib/ddl";
import { quoteIdent } from "../lib/export";
import { getSettings } from "../lib/settings";
import { useWs } from "./context";

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
}

export interface HistoryItem {
  sql: string;
  at: number;
}

export function Sidebar({
  schemas,
  activeTable,
  saved,
  history,
  onSchema,
  onDeleteSaved,
  onClearHistory,
  onRefresh,
  onExport,
  onImportCsv,
  onImportSql,
  onOverview,
}: {
  schemas: string[];
  activeTable: string | null;
  saved: SavedQuery[];
  history: HistoryItem[];
  onSchema: (s: string) => void;
  onDeleteSaved: (id: string) => void;
  onClearHistory: () => void;
  onRefresh: () => void;
  onExport: (tables: string[]) => void;
  onImportCsv: (table?: string) => void;
  onImportSql: () => void;
  onOverview: () => void;
}) {
  const ws = useWs();
  const [mode, setMode] = useState<"items" | "queries" | "history">("items");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState({ functions: false, tables: true, views: true });
  const [selected, setSelected] = useState<string | null>(null);
  const [danger, setDanger] = useState<{ title: string; sql: string } | null>(null);
  const [clone, setClone] = useState<{ table: string; name: string; withData: boolean } | null>(null);
  const pinKey = `querybird.pins.${ws.connId}.${ws.schema}`;
  const [pins, setPins] = useState<string[]>(() => load(pinKey, []));
  useEffect(() => setPins(load(pinKey, [])), [pinKey]);
  const togglePin = (name: string) => {
    const next = pins.includes(name) ? pins.filter((p) => p !== name) : [...pins, name];
    setPins(next);
    save(pinKey, next);
  };
  const runDanger = (title: string, sql: string) =>
    getSettings().confirmDelete || ws.safeMode ? setDanger({ title, sql }) : execDanger(sql);
  // The open table drives the highlight; a click-selection only lasts until the active tab changes.
  useEffect(() => setSelected(null), [activeTable]);

  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
  const pinnedFirst = (list: string[]) => [...list.filter((n) => pins.includes(n)), ...list.filter((n) => !pins.includes(n))];
  const groups = useMemo(
    () => [
      { key: "functions" as const, label: "Functions", items: ws.objects.functions.filter(match), icon: <IconFunction /> },
      { key: "tables" as const, label: "Tables", items: pinnedFirst(ws.objects.tables.filter(match)), icon: <IconTable /> },
      { key: "views" as const, label: "Views", items: pinnedFirst(ws.objects.views.filter(match)), icon: <IconView /> },
    ],
    [ws.objects, q, pins], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const execDanger = async (sql: string) => {
    try {
      ws.log(sql);
      await api.execute(ws.sessionId, sql);
      ws.toast("Done");
      onRefresh();
    } catch (e) {
      ws.toast(errorText(e), true);
    }
  };

  const newMenu = (): MenuItem => ({
    label: "New",
    submenu: [
      { label: "Table", onClick: () => ws.openQuery(createTableTemplate(ws.driver, ws.schema), "New table") },
      { label: "View", onClick: () => ws.openQuery(createViewTemplate(ws.driver, ws.schema), "New view") },
      ...(ws.driver !== "sqlite" ? [{ label: "Function / Procedure", onClick: () => ws.openQuery(createFunctionTemplate(ws.driver, ws.schema), "New function") }] : []),
      ...(ws.driver === "postgres" ? [{ label: "Materialized View", onClick: () => ws.openQuery(createViewTemplate(ws.driver, ws.schema, true), "New materialized view") }] : []),
    ],
  });

  const tableMenu = (e: React.MouseEvent, name: string, kind: "tables" | "views" | "functions") => {
    e.preventDefault();
    setSelected(`${kind}:${name}`);
    const full = `${quoteIdent(ws.driver, ws.schema)}.${quoteIdent(ws.driver, name)}`;
    const copy = (t: string) => navigator.clipboard.writeText(t).then(() => ws.toast("Copied"));
    if (kind === "functions") {
      ws.setMenu({ x: e.clientX, y: e.clientY, items: [{ label: "Copy name", onClick: () => copy(name) }, { separator: true }, newMenu()] });
      return;
    }
    const isTable = kind === "tables";
    ws.setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Open in new tab", onClick: () => ws.openTable(ws.schema, name, { newTab: true }) },
        { label: "Open structure", onClick: () => ws.openTable(ws.schema, name, { newTab: true, view: "structure" }) },
        { separator: true },
        { label: "Item overview", onClick: onOverview },
        { separator: true },
        { label: "Copy name", onClick: () => copy(name) },
        { label: pins.includes(name) ? "Unpin" : "Pin to top", onClick: () => togglePin(name) },
        { separator: true },
        { label: "Export", submenu: [{ label: "Export…", onClick: () => onExport([name]) }] },
        {
          label: "Import",
          submenu: [
            { label: "From CSV…", disabled: !isTable, onClick: () => onImportCsv(name) },
            { label: "From SQL Dump…", onClick: onImportSql },
          ],
        },
        { separator: true },
        newMenu(),
        {
          label: "Copy Script As",
          submenu: [
            { label: "Creation", onClick: async () => copy(await api.tableDdl(ws.sessionId, ws.schema, name).catch(errorText)) },
            { label: "Drop", onClick: () => copy(`DROP ${isTable ? "TABLE" : "VIEW"} ${full};`) },
            { label: "Truncate", disabled: !isTable, onClick: () => copy(`TRUNCATE TABLE ${full};`) },
            { separator: true },
            { label: "Select top 100", onClick: () => copy(`SELECT * FROM ${full} LIMIT 100;`) },
          ],
        },
        { label: "Query in new tab", onClick: () => ws.openQuery(`SELECT * FROM ${full} LIMIT 100;`, name, true) },
        { separator: true },
        { label: "Clone…", disabled: !isTable, onClick: () => setClone({ table: name, name: `${name}_copy`, withData: true }) },
        { label: "Truncate…", kbd: `⌥${mod}⌫`, danger: true, disabled: !isTable, onClick: () => runDanger(`Truncate ${name}?`, `TRUNCATE TABLE ${full};`) },
        { label: "Delete…", kbd: `${mod}⌫`, danger: true, onClick: () => runDanger(`Drop ${isTable ? "table" : "view"} ${name}?`, `DROP ${isTable ? "TABLE" : "VIEW"} ${full};`) },
      ],
    });
  };

  return (
    <div className="sidebar">
      <div className="sidebar-modes">
        <div className="segmented" style={{ width: "100%", justifyContent: "space-between" }}>
          {(["items", "queries", "history"] as const).map((m) => (
            <button key={m} className={mode === m ? "active" : ""} style={{ flex: 1 }} onClick={() => setMode(m)}>
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div style={{ padding: "4px 8px 6px" }}>
        <div className="search">
          <IconSearch />
          <input className="input" placeholder={mode === "items" ? "Search for item…" : mode === "queries" ? "Search saved queries…" : "Search history…"} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <div className="sidebar-tree">
        {mode === "items" &&
          groups.map((g) => (
            <div key={g.key}>
              <div className="tree-group" onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}>
                <IconChevron open={open[g.key] || !!q} /> {g.label}
                {g.items.length > 0 && <span className="faint" style={{ marginLeft: 4, fontSize: 11 }}>{g.items.length}</span>}
              </div>
              {(open[g.key] || !!q) &&
                g.items.map((name) => {
                  const id = `${g.key}:${name}`;
                  const isActive = selected ? selected === id : g.key !== "functions" && activeTable === name;
                  return (
                    <div
                      key={id}
                      className={`tree-item${isActive ? " active" : ""}`}
                      onMouseDown={() => setSelected(id)}
                      onClick={(e) => g.key !== "functions" && ws.openTable(ws.schema, name, { newTab: e.metaKey || e.ctrlKey })}
                      onDoubleClick={() => g.key !== "functions" && ws.openTable(ws.schema, name, { newTab: true })}
                      onContextMenu={(e) => tableMenu(e, name, g.key)}
                      title={name}
                    >
                      {g.icon}
                      <span className="tree-label">{name}</span>
                      {pins.includes(name) && <span className="pin" title="Pinned">●</span>}
                    </div>
                  );
                })}
            </div>
          ))}

        {mode === "queries" &&
          (saved.filter((s) => match(s.name) || match(s.sql)).map((s) => (
            <div
              key={s.id}
              className="tree-item"
              onClick={() => ws.openQuery(s.sql, s.name)}
              onContextMenu={(e) => {
                e.preventDefault();
                ws.setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  items: [
                    { label: "Open", onClick: () => ws.openQuery(s.sql, s.name) },
                    { label: "Open and Run", onClick: () => ws.openQuery(s.sql, s.name, true) },
                    { label: "Copy SQL", onClick: () => navigator.clipboard.writeText(s.sql) },
                    { separator: true },
                    { label: "Delete", danger: true, onClick: () => onDeleteSaved(s.id) },
                  ],
                });
              }}
              title={s.sql}
            >
              <IconQuery />
              <span className="tree-label">{s.name}</span>
            </div>
          )).concat(saved.length ? [] : [<div key="e" className="sidebar-hint">Save a query from the editor with {mod}S.</div>]))}

        {mode === "history" && (
          <>
            {history.filter((h) => match(h.sql)).map((h, i) => (
              <div key={i} className="history-item" onClick={() => ws.openQuery(h.sql)} title={h.sql}>
                <div className="mono history-sql">{h.sql}</div>
                <div className="faint" style={{ fontSize: 10.5 }}>{new Date(h.at).toLocaleString()}</div>
              </div>
            ))}
            {history.length ? (
              <div style={{ padding: 8 }}>
                <button className="btn small" onClick={onClearHistory}>Clear history</button>
              </div>
            ) : (
              <div className="sidebar-hint">Queries you run appear here.</div>
            )}
          </>
        )}
      </div>

      <div className="sidebar-foot">
        <button className="btn small" title="New SQL query (⌘T)" onClick={() => ws.openQuery("")}>
          <IconPlus size={11} />
        </button>
        <button className="btn small" title="Refresh items" onClick={onRefresh}>↻</button>
        <select className="input" style={{ flex: 1, height: 22 }} value={ws.schema} onChange={(e) => onSchema(e.target.value)} title={ws.driver === "mysql" ? "Database" : "Schema"}>
          {!schemas.includes(ws.schema) && <option value={ws.schema}>{ws.schema}</option>}
          {schemas.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {danger && (
        <Modal
          title={danger.title}
          width={460}
          onClose={() => setDanger(null)}
          footer={
            <>
              <span className="spacer" />
              <button className="btn" onClick={() => setDanger(null)}>Cancel</button>
              <button
                className="btn danger"
                onClick={() => {
                  const sql = danger.sql;
                  setDanger(null);
                  execDanger(sql);
                }}
              >
                Run
              </button>
            </>
          }
        >
          <div style={{ marginBottom: 8 }}>This cannot be undone. The following statement will run:</div>
          <pre className="mono code-box">{danger.sql}</pre>
        </Modal>
      )}
      {clone && (
        <Modal
          title={`Clone ${clone.table}`}
          width={400}
          onClose={() => setClone(null)}
          footer={
            <>
              <span className="spacer" />
              <button className="btn" onClick={() => setClone(null)}>Cancel</button>
              <button
                className="btn primary"
                disabled={!clone.name.trim()}
                onClick={async () => {
                  const st = cloneTableStatements(ws.driver, ws.schema, clone.table, clone.name.trim(), clone.withData);
                  setClone(null);
                  try {
                    await api.runStatements(ws.sessionId, st, ws.driver !== "mysql");
                    st.forEach(ws.log);
                    ws.toast(`Cloned ${clone.table} → ${clone.name}`);
                    onRefresh();
                  } catch (e) {
                    ws.toast(errorText(e), true);
                  }
                }}
              >
                Clone
              </button>
            </>
          }
        >
          <div className="form-grid">
            <label>New name</label>
            <input className="input mono" autoFocus value={clone.name} onChange={(e) => setClone({ ...clone, name: e.target.value })} />
            <span />
            <label className="row"><input type="checkbox" checked={clone.withData} onChange={(e) => setClone({ ...clone, withData: e.target.checked })} /> Copy data too</label>
          </div>
        </Modal>
      )}
    </div>
  );
}
