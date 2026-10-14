import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo, listen } from "@tauri-apps/api/event";
import { api, errorText, type Filter, type ObjectList, type SessionInfo } from "../api";
import {
  IconClose, IconDatabase, IconEye, IconList, IconLock, IconPlug, IconRefresh, IconSearch,
  IconMore, IconSparkle, IconSidebarBottom, IconSidebarLeft, IconSidebarRight, IconTrash, IconUnlock, IconX,
} from "../components/icons";
import { ContextMenu, DRIVERS, Modal, isMac, load, mod, save, tagColor, useToast, type MenuState } from "../components/ui";
import { BackupDialog } from "../components/BackupDialog";
import { SettingsModal } from "../components/SettingsModal";
import { getSettings, updateSettings } from "../lib/settings";
import { OverviewTab, ProcessTab, usersSql } from "./AdminTabs";
import { AskTab } from "./AskTab";
import { ExportDialog, ImportCsvDialog, ImportSqlDialog, SearchDialog } from "./Tools";
import { DetailsPanel } from "./DetailsPanel";
import { OpenAnything } from "./OpenAnything";
import { QueryTab } from "./QueryTab";
import { Sidebar, type HistoryItem, type SavedQuery } from "./Sidebar";
import { TableTab } from "./TableTab";
import { WorkspaceContext, type Ctx, type Details, type TabApi } from "./context";
import "./workspace.css";

type Tab =
  | { id: string; kind: "table"; schema: string; table: string; isView: boolean; preview: boolean; filters?: Filter[]; view?: "data" | "structure" }
  | { id: string; kind: "query"; title: string; sql: string; run?: boolean }
  | { id: string; kind: "ai"; title: string }
  | { id: string; kind: "overview"; title: string }
  | { id: string; kind: "processes"; title: string };

type Dialog =
  | { kind: "settings"; tab?: "general" | "editor" | "data" | "tools" | "ai" }
  | { kind: "search" }
  | { kind: "export"; tables: string[] }
  | { kind: "importCsv"; table?: string }
  | { kind: "importSql" }
  | { kind: "backup" }
  | { kind: "restore" };

/** What we persist to reopen a workspace like it was left. */
type SavedTab =
  | { kind: "table"; schema: string; table: string; view?: "data" | "structure" }
  | { kind: "query"; title: string; sql: string }
  | { kind: "overview" | "processes" | "ai" };

interface LogEntry {
  at: Date;
  sql: string;
}

let tabSeq = 1;
const newId = () => `t${tabSeq++}`;

export function Workspace({ sessionId }: { sessionId: string }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchemaState] = useState("");
  const [objects, setObjects] = useState<ObjectList>({ tables: [], views: [], functions: [] });
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [panels, setPanels] = useState(() => load("querybird.panels", { left: true, bottom: true, right: true, leftW: 232, rightW: 300, bottomH: 120 }));
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoadingCount] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [details, setDetails] = useState<Record<string, Details | null>>({});
  const [pending, setPending] = useState<Record<string, number>>({});
  const [safeMode, setSafeMode] = useState(false);
  const [anything, setAnything] = useState(false);
  const [schemaPicker, setSchemaPicker] = useState(false);
  const [saveDialog, setSaveDialog] = useState<{ sql: string; name: string } | null>(null);
  const [closeConfirm, setCloseConfirm] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const restored = useRef(false);
  const tabApis = useRef<Record<string, TabApi>>({});
  const navHistory = useRef<{ back: string[]; fwd: string[] }>({ back: [], fwd: [] });
  const consoleRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  const connId = info?.connection.id ?? "";
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  useEffect(() => save("querybird.panels", panels), [panels]);

  // ---------- bootstrap ----------
  useEffect(() => {
    (async () => {
      try {
        const s = await api.sessionInfo(sessionId);
        setInfo(s);
        setSafeMode(s.connection.tag === "production");
        setSaved(load(`querybird.saved.${s.connection.id}`, []));
        setHistory(load(`querybird.history.${s.connection.id}`, []));
        const [list] = await Promise.all([api.listSchemas(sessionId)]);
        setSchemas(list);
        const initial = s.schema || list[0] || "";
        if (initial && initial !== s.schema) await api.setSchema(sessionId, initial).catch(() => {});
        setSchemaState(initial);
        getCurrentWindow().setTitle(`${s.connection.name} — Querybird`).catch(() => {});
      } catch (e) {
        setFatal(errorText(e));
      }
    })();
  }, [sessionId]);

  const refreshObjects = useCallback(async () => {
    if (!schema) return;
    try {
      setObjects(await api.listObjects(sessionId, schema));
    } catch (e) {
      toast.show(errorText(e), true);
    }
  }, [sessionId, schema]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshObjects();
  }, [refreshObjects]);

  useEffect(() => {
    const h = () => refreshObjects();
    window.addEventListener("querybird:refresh-objects", h);
    return () => window.removeEventListener("querybird:refresh-objects", h);
  }, [refreshObjects]);

  // Reopen the tabs this connection had last time (TablePlus "reopen closed workspaces").
  useEffect(() => {
    if (restored.current || !info || !schema || !objects.tables.length && !objects.views.length) return;
    restored.current = true;
    if (!getSettings().restoreTabs) return;
    const saved = load<SavedTab[]>(`querybird.tabs.${info.connection.id}`, []);
    const next: Tab[] = saved.flatMap((t): Tab[] => {
      if (t.kind === "table") {
        if (t.schema !== schema || ![...objects.tables, ...objects.views].includes(t.table)) return [];
        return [{ id: newId(), kind: "table", schema: t.schema, table: t.table, isView: objects.views.includes(t.table), preview: false, view: t.view }];
      }
      if (t.kind === "query") return [{ id: newId(), kind: "query", title: t.title, sql: t.sql }];
      if (t.kind === "ai") return [{ id: newId(), kind: "ai", title: "Ask AI" }];
      return [t.kind === "overview" ? { id: newId(), kind: "overview", title: "Item overview" } : { id: newId(), kind: "processes", title: "Processes" }];
    });
    if (next.length) {
      setTabs(next);
      setActiveId(next[0].id);
    }
  }, [info, schema, objects]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!restored.current || !info) return;
    const out: SavedTab[] = tabs.map((t) =>
      t.kind === "table" ? { kind: "table", schema: t.schema, table: t.table } : t.kind === "query" ? { kind: "query", title: t.title, sql: t.sql } : { kind: t.kind },
    );
    save(`querybird.tabs.${info.connection.id}`, out);
  });

  const changeSchema = async (s: string) => {
    if (s === schema) return;
    if (Object.values(pending).some((n) => n > 0)) {
      toast.show("Commit or discard pending changes first", true);
      return;
    }
    try {
      await api.setSchema(sessionId, s);
      log(`${info?.connection.driver === "mysql" ? "USE" : "SET search_path TO"} ${s};`);
      setSchemaState(s);
      setTabs((t) => t.filter((x) => x.kind === "query"));
    } catch (e) {
      toast.show(errorText(e), true);
    }
  };

  // ---------- tabs ----------
  const activate = (id: string | null) => {
    if (activeId && activeId !== id) {
      navHistory.current.back.push(activeId);
      navHistory.current.fwd = [];
    }
    setActiveId(id);
  };

  const openTable: Ctx["openTable"] = (sch, table, opts = {}) => {
    const isView = objects.views.includes(table);
    const existing = !opts.filters && !opts.view && tabs.find((t) => t.kind === "table" && t.schema === sch && t.table === table);
    if (existing) {
      activate(existing.id);
      return;
    }
    const tab: Tab = { id: newId(), kind: "table", schema: sch, table, isView, preview: !opts.newTab, filters: opts.filters, view: opts.view };
    // A single click replaces the current preview tab (shown in italics), like TablePlus.
    const previewIdx = opts.newTab ? -1 : tabs.findIndex((t) => t.kind === "table" && t.preview && !(pending[t.id] > 0));
    if (previewIdx >= 0) {
      const next = [...tabs];
      delete tabApis.current[tabs[previewIdx].id];
      next[previewIdx] = tab;
      setTabs(next);
    } else {
      setTabs([...tabs, tab]);
    }
    activate(tab.id);
  };

  const openQuery: Ctx["openQuery"] = (sql, title, run) => {
    const n = tabs.filter((t) => t.kind === "query").length;
    const tab: Tab = { id: newId(), kind: "query", title: title ?? (n ? `SQL Query ${n + 1}` : "SQL Query"), sql, run };
    setTabs((prev) => [...prev, tab]);
    activate(tab.id);
  };

  const closeTab = (id: string, force = false) => {
    if (!force && pending[id] > 0) {
      setCloseConfirm(id);
      return;
    }
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (id === activeId) setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? null);
      return next;
    });
    delete tabApis.current[id];
    setPending((p) => ({ ...p, [id]: 0 }));
    setCloseConfirm(null);
  };

  const pin = (id: string) => setTabs((prev) => prev.map((t) => (t.id === id && t.kind === "table" ? { ...t, preview: false } : t)));

  const active = tabs.find((t) => t.id === activeId) ?? null;
  const activeApi = () => (activeId ? tabApis.current[activeId] : undefined);
  const totalPending = Object.values(pending).reduce((a, b) => a + b, 0);

  // ---------- logging & history ----------
  const log = useCallback((sql: string) => {
    setLogs((l) => [...l.slice(-400), { at: new Date(), sql }]);
    setTimeout(() => consoleRef.current && (consoleRef.current.scrollTop = consoleRef.current.scrollHeight), 0);
  }, []);
  const addHistory = useCallback(
    (sql: string) =>
      // Statements that carry credentials are never kept in (plain-text) history.
      /\b(password|identified\s+(by|with))\b/i.test(sql) ? undefined :
      setHistory((h) => {
        const next = [{ sql, at: Date.now() }, ...h.filter((x) => x.sql !== sql)].slice(0, 300);
        save(`querybird.history.${connId}`, next);
        return next;
      }),
    [connId],
  );
  const setLoading = useCallback((d: number) => setLoadingCount((n) => Math.max(0, n + d)), []);

  const saveQuery = (sql: string) => {
    if (!sql.trim()) return;
    const t = active?.kind === "query" ? active.title : "";
    setSaveDialog({ sql, name: t.startsWith("SQL Query") ? "" : t });
  };

  // ---------- commands: shared by keyboard shortcuts and the native menu bar ----------
  const lastRun = useRef<Record<string, number>>({});
  const textFocused = () => {
    const el = document.activeElement as HTMLElement | null;
    return !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || !!el.closest?.(".cm-editor"));
  };
  const editorFocused = () => !!(document.activeElement as HTMLElement | null)?.closest?.(".cm-editor");
  const cycleTab = (d: number) => {
    const i = tabs.findIndex((t) => t.id === activeId);
    if (tabs.length) activate(tabs[(i + d + tabs.length) % tabs.length].id);
  };
  const commands: Record<string, () => void> = {
    settings: () => setDialog({ kind: "settings" }),
    new_connection: () => {
      api.showWelcome();
      emitTo("main", "menu", "new_connection");
    },
    open_sql: () => openSqlFile(),
    new_query: () => (getSettings().cmdTOpens === "database" ? setSchemaPicker(true) : openQuery("")),
    import_csv: () => setDialog({ kind: "importCsv", table: active?.kind === "table" ? active.table : undefined }),
    import_sql: () => setDialog({ kind: "importSql" }),
    export: () => setDialog({ kind: "export", tables: active?.kind === "table" ? [active.table] : [] }),
    backup: () => setDialog({ kind: "backup" }),
    restore: () => setDialog({ kind: "restore" }),
    close_tab: () => activeId && closeTab(activeId),
    undo: () => (textFocused() ? document.execCommand("undo") : activeApi()?.undo?.()),
    redo: () => (textFocused() ? document.execCommand("redo") : activeApi()?.redo?.()),
    commit: () => (editorFocused() ? activeApi()?.save?.() : activeApi()?.commit?.() ?? activeApi()?.save?.()),
    discard: () => activeApi()?.discard?.(),
    preview: () => activeApi()?.preview?.(),
    add_row: () => (editorFocused() ? activeApi()?.beautify?.() : activeApi()?.insertRow?.()),
    duplicate_rows: () => !textFocused() && activeApi()?.duplicate?.(),
    find: () => (active?.kind === "query" ? activeApi()?.find?.() : activeApi()?.toggleFilters?.()),
    toggle_sidebar: () => setPanels((p) => ({ ...p, left: !p.left })),
    toggle_console: () => setPanels((p) => ({ ...p, bottom: !p.bottom })),
    toggle_details: () => setPanels((p) => ({ ...p, right: !p.right })),
    font_bigger: () => bumpFont(1),
    font_smaller: () => bumpFont(-1),
    open_anything: () => setAnything(true),
    open_database: () => setSchemaPicker(true),
    show_data: () => activeApi()?.showData?.(),
    show_structure: () => activeApi()?.showStructure?.(),
    next_tab: () => cycleTab(1),
    prev_tab: () => cycleTab(-1),
    run_current: () => activeApi()?.runCurrent?.(),
    run_all: () => activeApi()?.runAll?.(),
    reload: () => activeApi()?.reload?.() ?? refreshObjects(),
    reload_workspace: () => refreshObjects(),
    reconnect: () => reconnect(),
    disconnect: () => getCurrentWindow().close(),
    overview: () => openSpecial("overview"),
    users: () => openQuery(usersSql(info!.connection.driver), "Users", true),
    processes: () => openSpecial("processes"),
    search_db: () => setDialog({ kind: "search" }),
    ask_ai: () => openSpecial("ai"),
  };
  // A shortcut can arrive both as a keydown and as a menu event; run it once.
  const run = (id: string, source: "key" | "menu") => {
    const now = Date.now();
    const other = lastRun.current[`${id}:${source === "key" ? "menu" : "key"}`] ?? 0;
    lastRun.current[`${id}:${source}`] = now;
    if (now - other < 400) return;
    commands[id]?.();
  };
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const un = listen<string>("menu", (e) => runRef.current(e.payload, "menu"));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // ---------- shortcuts (TablePlus keymap) ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = e.metaKey || e.ctrlKey;
      if (!m) return;
      const k = e.key.toLowerCase();
      const inEditor = editorFocused();
      const inText = textFocused() || e.target instanceof HTMLSelectElement;
      const bracket = e.code === "BracketLeft" ? -1 : e.code === "BracketRight" ? 1 : 0;
      // ⌃⌘[ / ⌃⌘] (Ctrl+Alt+[ ] elsewhere): table data / structure.
      const dataStructure = isMac ? e.metaKey && e.ctrlKey : e.ctrlKey && e.altKey;
      let id: string | null = null;
      if (bracket && dataStructure) id = bracket < 0 ? "show_data" : "show_structure";
      else if (bracket && !e.altKey) id = bracket < 0 ? "prev_tab" : "next_tab";
      else if (k === "s" && !inEditor && !e.shiftKey) id = "commit";
      else if (k === "r") id = e.shiftKey ? "reload_workspace" : "reload";
      else if (k === "t") id = "new_query";
      else if (k === "w") id = "close_tab";
      else if (k === "p") id = "open_anything";
      else if (k === "k" && !inEditor) id = "open_database";
      else if (k === ",") id = "settings";
      else if (k === "o" && !e.shiftKey) id = "open_sql";
      else if (k === "j") id = "ask_ai";
      else if (k === "f" && !inEditor && active?.kind === "table") id = "find";
      else if (k === "i" && !inEditor && active?.kind === "table") id = "add_row";
      else if (k === "d" && !inText && active?.kind === "table") id = "duplicate_rows";
      else if (k === "z" && !inText && active?.kind === "table") id = e.shiftKey ? "redo" : "undo";
      else if (k === "=" || k === "+") id = "font_bigger";
      else if (k === "-") id = "font_smaller";
      else if (k === "e" && e.shiftKey) id = "toggle_console";
      else if (k === "0") id = "toggle_sidebar";
      else if (k === "." && e.shiftKey) id = "toggle_details";
      else if (/^[1-9]$/.test(k) && !e.shiftKey) {
        e.preventDefault();
        const t = k === "9" ? tabs[tabs.length - 1] : tabs[+k - 1];
        if (t) activate(t.id);
        return;
      }
      if (id) {
        e.preventDefault();
        run(id, "key");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const bumpFont = (d: number) => {
    const st = getSettings();
    const inQuery = active?.kind === "query";
    if (inQuery) updateSettings({ editorFontSize: Math.min(24, Math.max(9, st.editorFontSize + d)) });
    else updateSettings({ gridFontSize: Math.min(20, Math.max(9, st.gridFontSize + d)) });
  };

  const openSqlFile = async () => {
    const p = await api.pickPath("open", { filterName: "SQL", extensions: ["sql", "txt"] });
    if (!p) return;
    try {
      const text = await api.readTextFile(p);
      openQuery(text, p.split(/[\\/]/).pop());
    } catch (e) {
      toast.show(errorText(e), true);
    }
  };

  const reconnect = async () => {
    try {
      const s = await api.reconnect(sessionId);
      setInfo(s);
      toast.show("Reconnected");
      refreshObjects();
      activeApi()?.reload?.();
    } catch (e) {
      toast.show(errorText(e), true);
    }
  };

  const openSpecial = (kind: "overview" | "processes" | "ai") => {
    const existing = tabs.find((t) => t.kind === kind);
    if (existing) return activate(existing.id);
    const tab: Tab =
      kind === "overview" ? { id: newId(), kind, title: "Item overview" } : kind === "ai" ? { id: newId(), kind, title: "Ask AI" } : { id: newId(), kind, title: "Processes" };
    setTabs([...tabs, tab]);
    activate(tab.id);
  };

  const moreMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.right - 220,
      y: r.bottom + 4,
      items: [
        { label: "Reconnect", onClick: reconnect },
        { label: "Reload workspace", kbd: `⇧${mod}R`, onClick: refreshObjects },
        { separator: true },
        { label: "Item overview", onClick: () => openSpecial("overview") },
        { label: "Search in Database...", onClick: () => setDialog({ kind: "search" }) },
        { label: "Process List", onClick: () => openSpecial("processes") },
        { label: "Ask AI (natural language → SQL)", kbd: `${mod}J`, onClick: () => openSpecial("ai") },
        { label: "User Management", onClick: () => openQuery(usersSql(info!.connection.driver), "Users", true) },
        { separator: true },
        { label: "Open SQL file...", kbd: `${mod}O`, onClick: openSqlFile },
        {
          label: "Import",
          submenu: [
            { label: "From CSV...", onClick: () => setDialog({ kind: "importCsv", table: active?.kind === "table" ? active.table : undefined }) },
            { label: "From SQL Dump...", onClick: () => setDialog({ kind: "importSql" }) },
          ],
        },
        { label: "Export...", onClick: () => setDialog({ kind: "export", tables: active?.kind === "table" ? [active.table] : [] }) },
        { label: "Backup database...", onClick: () => setDialog({ kind: "backup" }) },
        { label: "Restore database...", onClick: () => setDialog({ kind: "restore" }) },
        { separator: true },
        { label: "Settings...", kbd: `${mod},`, onClick: () => setDialog({ kind: "settings" }) },
      ],
    });
  };

  const ctx: Ctx | null = useMemo(
    () =>
      info
        ? {
            sessionId,
            connId,
            driver: info.connection.driver,
            schema,
            objects,
            safeMode,
            log,
            addHistory,
            toast: toast.show,
            setMenu,
            openTable,
            openQuery,
            setLoading,
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [info, schema, objects, safeMode, tabs, pending, connId, activeId],
  );

  const drag = (which: "leftW" | "rightW" | "bottomH") => (e: React.MouseEvent) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, v: panels[which] };
    const onMove = (ev: MouseEvent) => {
      const d = which === "leftW" ? ev.clientX - start.x : which === "rightW" ? start.x - ev.clientX : start.y - ev.clientY;
      const min = which === "bottomH" ? 40 : 160;
      const max = which === "bottomH" ? 500 : 560;
      setPanels((p) => ({ ...p, [which]: Math.min(max, Math.max(min, start.v + d)) }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = which === "bottomH" ? "row-resize" : "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (fatal) {
    return (
      <div className="empty" style={{ flexDirection: "column", gap: 12 }}>
        <div style={{ color: "var(--red)" }}>{fatal}</div>
        <button className="btn" onClick={() => getCurrentWindow().close()}>Close</button>
      </div>
    );
  }
  if (!info || !ctx) return <div className="empty">Connecting…</div>;

  const c = info.connection;
  const driverLabel = DRIVERS.find((d) => d.id === c.driver)!.label;
  const shortVersion = info.serverVersion.split("-")[0];
  const crumb = active?.kind === "table" ? `${active.schema}.${active.table}` : active?.kind === "query" ? active.title : schema;
  const safeColor = /^#[0-9a-f]{3,8}$/i.test(c.color) ? c.color : "";
  const toolbarStyle = safeColor ? { background: `color-mix(in srgb, ${safeColor} 45%, var(--toolbar))` } : undefined;

  return (
    <WorkspaceContext.Provider value={ctx}>
      <div className="ws">
        <div className="toolbar" data-tauri-drag-region style={toolbarStyle}>
          <div className="toolbar-group" style={{ paddingLeft: isMac ? 76 : 8 }} data-tauri-drag-region>
            <button className="icon-btn" title="Open connection list" onClick={() => api.showWelcome()}><IconPlug /></button>
            <button className="icon-btn" title="Close connection" onClick={() => getCurrentWindow().close()}><IconClose /></button>
            <button className="icon-btn" title="Preview pending changes" disabled={!(active && pending[active.id] > 0)} onClick={() => activeApi()?.preview?.()}><IconEye /></button>
            <button
              className="icon-btn"
              title="Process list"
              onClick={async () => openQuery(await api.processListSql(sessionId), "Processes", true)}
            >
              <IconList />
            </button>
            <button className={`icon-btn${safeMode ? " on" : ""}`} title={safeMode ? "Safe mode ON — writes need confirmation" : "Safe mode OFF"} onClick={() => setSafeMode((s) => !s)}>
              {safeMode ? <IconLock /> : <IconUnlock />}
            </button>
            <button className="icon-btn" title={`Switch ${c.driver === "mysql" ? "database" : "schema"}`} onClick={() => setSchemaPicker(true)}><IconDatabase /></button>
            <button className="icon-btn sql-btn" title={`New SQL query (${mod}T)`} onClick={() => openQuery("")}>SQL</button>
            <button className="icon-btn ai-btn" title={`Ask AI — natural language to SQL (${mod}J)`} onClick={() => openSpecial("ai")}>
              <IconSparkle /> AI
            </button>
          </div>
          <div className="crumb" data-tauri-drag-region>
            <span className="crumb-tag" style={{ color: tagColor(c.tag) }} data-tauri-drag-region>{c.tag.toUpperCase()}</span>
            <span className="crumb-sep" data-tauri-drag-region>|</span>
            <span className="crumb-text" data-tauri-drag-region>
              {driverLabel} {shortVersion} : {c.name} : {c.database || schema} : {crumb}
            </span>
            {loading > 0 && <span className="crumb-progress" />}
          </div>
          <div className="toolbar-group" data-tauri-drag-region>
            {totalPending > 0 && (
              <div className="pending-pill">
                <span>{totalPending} change{totalPending === 1 ? "" : "s"}</span>
                <button className="btn small" onClick={() => activeApi()?.discard?.()}>Discard</button>
                <button className="btn small primary" onClick={() => activeApi()?.commit?.()}>Commit {mod}S</button>
              </div>
            )}
            <button className="icon-btn" title={`Reload (${mod}R)`} onClick={() => activeApi()?.reload?.() ?? refreshObjects()}><IconRefresh /></button>
            <button className="icon-btn" title={`Open anything (${mod}P)`} onClick={() => setAnything(true)}><IconSearch size={15} /></button>
            <button className="icon-btn" title="More: overview, search, import / export, backup, settings" onClick={moreMenu}><IconMore /></button>
            <span style={{ width: 8 }} />
            <button className={`icon-btn${panels.left ? " on" : ""}`} title={`Toggle sidebar (${mod}0)`} onClick={() => setPanels((p) => ({ ...p, left: !p.left }))}><IconSidebarLeft /></button>
            <button className={`icon-btn${panels.bottom ? " on" : ""}`} title={`Toggle console (${mod}⇧E)`} onClick={() => setPanels((p) => ({ ...p, bottom: !p.bottom }))}><IconSidebarBottom /></button>
            <button className={`icon-btn${panels.right ? " on" : ""}`} title={`Toggle details (${mod}⇧.)`} onClick={() => setPanels((p) => ({ ...p, right: !p.right }))}><IconSidebarRight /></button>
          </div>
        </div>

        <div className="ws-main">
          {panels.left && (
            <>
              <div style={{ width: panels.leftW, flex: "none", display: "flex" }}>
                <Sidebar
                  schemas={schemas}
                  activeTable={active?.kind === "table" ? active.table : null}
                  saved={saved}
                  history={history}
                  onSchema={changeSchema}
                  onDeleteSaved={(id) => {
                    const next = saved.filter((s) => s.id !== id);
                    setSaved(next);
                    save(`querybird.saved.${connId}`, next);
                  }}
                  onClearHistory={() => {
                    setHistory([]);
                    save(`querybird.history.${connId}`, []);
                  }}
                  onRefresh={refreshObjects}
                  onExport={(tables) => setDialog({ kind: "export", tables })}
                  onImportCsv={(table) => setDialog({ kind: "importCsv", table })}
                  onImportSql={() => setDialog({ kind: "importSql" })}
                  onOverview={() => openSpecial("overview")}
                />
              </div>
              <div className="splitter-v" onMouseDown={drag("leftW")} />
            </>
          )}

          <div className="center">
            <div className="tabbar">
              <button className="icon-btn" disabled={!navHistory.current.back.length} title="Go back" onClick={() => {
                const h = navHistory.current;
                let id = h.back.pop();
                while (id && !tabs.some((t) => t.id === id)) id = h.back.pop();
                if (id) { if (activeId) h.fwd.push(activeId); setActiveId(id); }
              }}>‹</button>
              <button className="icon-btn" disabled={!navHistory.current.fwd.length} title="Go forward" onClick={() => {
                const h = navHistory.current;
                let id = h.fwd.pop();
                while (id && !tabs.some((t) => t.id === id)) id = h.fwd.pop();
                if (id) { if (activeId) h.back.push(activeId); setActiveId(id); }
              }}>›</button>
              <div className="tabs">
                {tabs.map((t) => (
                  <div
                    key={t.id}
                    className={`tab${t.id === activeId ? " active" : ""}${t.kind === "table" && t.preview ? " preview" : ""}`}
                    onMouseDown={(e) => e.button === 0 && activate(t.id)}
                    onDoubleClick={() => pin(t.id)}
                    onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({
                        x: e.clientX,
                        y: e.clientY,
                        items: [
                          { label: "Close Tab", kbd: `${mod}W`, onClick: () => closeTab(t.id) },
                          { label: "Close Other Tabs", onClick: () => tabs.filter((x) => x.id !== t.id && !(pending[x.id] > 0)).forEach((x) => closeTab(x.id)) },
                          { label: "Keep Open", disabled: !(t.kind === "table" && t.preview), onClick: () => pin(t.id) },
                        ],
                      });
                    }}
                    title={t.kind === "table" ? `${t.schema}.${t.table}` : t.title}
                  >
                    <button className="tab-close" onMouseDown={(e) => e.stopPropagation()} onClick={() => closeTab(t.id)}><IconX /></button>
                    <span className="tab-title">{pending[t.id] > 0 ? "● " : ""}{t.kind === "table" ? t.table : t.title}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="tab-area">
              {tabs.map((t) => (
                <div key={t.id} className="tab-pane" style={{ display: t.id === activeId ? "flex" : "none" }}>
                  {t.kind === "ai" ? (
                    <AskTab
                      active={t.id === activeId}
                      onDetails={(d) => setDetails((x) => ({ ...x, [t.id]: d }))}
                      register={(a) => (tabApis.current[t.id] = a)}
                      onOpenSettings={() => setDialog({ kind: "settings", tab: "ai" })}
                    />
                  ) : t.kind === "overview" ? (
                    <OverviewTab register={(a) => (tabApis.current[t.id] = a)} />
                  ) : t.kind === "processes" ? (
                    <ProcessTab register={(a) => (tabApis.current[t.id] = a)} />
                  ) : t.kind === "table" ? (
                    <TableTab
                      schema={t.schema}
                      table={t.table}
                      isView={t.isView}
                      active={t.id === activeId}
                      initialFilters={t.filters}
                      initialView={t.view}
                      onDetails={(d) => setDetails((x) => ({ ...x, [t.id]: d }))}
                      register={(a) => (tabApis.current[t.id] = a)}
                      onPending={(n) => {
                        setPending((p) => (p[t.id] === n ? p : { ...p, [t.id]: n }));
                        if (n > 0) pin(t.id);
                      }}
                      onExport={(tables) => setDialog({ kind: "export", tables })}
                      onImportCsv={(table) => setDialog({ kind: "importCsv", table })}
                    />
                  ) : (
                    <QueryTab
                      initialSql={t.sql}
                      autoRun={t.run}
                      active={t.id === activeId}
                      onSqlChange={(sql) => (t.sql = sql)}
                      onDetails={(d) => setDetails((x) => ({ ...x, [t.id]: d }))}
                      register={(a) => (tabApis.current[t.id] = a)}
                      onSaveQuery={saveQuery}
                    />
                  )}
                </div>
              ))}
              {!tabs.length && (
                <div className="welcome-empty">
                  <img src="/icon.svg" alt="" width={96} height={96} style={{ opacity: 0.35 }} draggable={false} />
                  <div className="shortcut-list">
                    <span>Open anything</span><kbd>{mod}P</kbd>
                    <span>New SQL query</span><kbd>{mod}T</kbd>
                    <span>Reload</span><kbd>{mod}R</kbd>
                    <span>Commit changes</span><kbd>{mod}S</kbd>
                    <span>Toggle filters</span><kbd>{mod}F</kbd>
                  </div>
                </div>
              )}
            </div>

            {panels.bottom && (
              <>
                <div className="splitter-h" onMouseDown={drag("bottomH")} />
                <div className="console" style={{ height: panels.bottomH }}>
                  <div className="console-log mono" ref={consoleRef}>
                    {logs.length ? (
                      logs.map((l, i) => (
                        <div key={i}>
                          <div className="console-time">-- {fmtTime(l.at)}</div>
                          <div className="console-sql">{l.sql.trim().endsWith(";") ? l.sql : `${l.sql};`}</div>
                        </div>
                      ))
                    ) : (
                      <div className="empty" style={{ fontFamily: "var(--font-ui)" }}>Console log — queries Querybird runs appear here</div>
                    )}
                  </div>
                  <div className="console-foot">
                    <button className="icon-btn" title="Clear console" onClick={() => setLogs([])}><IconTrash /></button>
                    <span className="faint" style={{ fontSize: 11.5 }}>{logs.length} statement{logs.length === 1 ? "" : "s"}</span>
                  </div>
                </div>
              </>
            )}
          </div>

          {panels.right && (
            <>
              <div className="splitter-v" onMouseDown={drag("rightW")} />
              <div style={{ width: panels.rightW, flex: "none", display: "flex" }}>
                <DetailsPanel details={activeId ? details[activeId] ?? null : null} />
              </div>
            </>
          )}
        </div>

        <ContextMenu menu={menu} onClose={() => setMenu(null)} />
        {toast.node}
        {anything && <OpenAnything saved={saved} onClose={() => setAnything(false)} />}
        {dialog?.kind === "settings" && <SettingsModal initialTab={dialog.tab} onClose={() => setDialog(null)} />}
        {dialog?.kind === "search" && <SearchDialog onClose={() => setDialog(null)} />}
        {dialog?.kind === "export" && <ExportDialog preselect={dialog.tables} onClose={() => setDialog(null)} />}
        {dialog?.kind === "importCsv" && <ImportCsvDialog table={dialog.table} onClose={() => setDialog(null)} />}
        {dialog?.kind === "importSql" && <ImportSqlDialog onClose={() => setDialog(null)} />}
        {(dialog?.kind === "backup" || dialog?.kind === "restore") && (
          <BackupDialog
            mode={dialog.kind}
            connections={[{ ...c, database: c.database || schema }]}
            initial={{ ...c, database: c.driver === "mysql" ? schema : c.database }}
            onClose={() => setDialog(null)}
            onDone={(msg) => {
              toast.show(msg);
              if (dialog.kind === "restore") refreshObjects();
            }}
          />
        )}
        {schemaPicker && (
          <SchemaPicker
            title={c.driver === "mysql" ? "Open database" : "Open schema"}
            schemas={schemas}
            current={schema}
            onClose={() => setSchemaPicker(false)}
            onPick={(s) => {
              setSchemaPicker(false);
              changeSchema(s);
            }}
          />
        )}
        {saveDialog && (
          <Modal
            title="Save query"
            width={380}
            onClose={() => setSaveDialog(null)}
            footer={
              <>
                <span className="spacer" />
                <button className="btn" onClick={() => setSaveDialog(null)}>Cancel</button>
                <button
                  className="btn primary"
                  disabled={!saveDialog.name.trim()}
                  onClick={() => {
                    const name = saveDialog.name.trim();
                    const next = [...saved.filter((s) => s.name !== name), { id: crypto.randomUUID(), name, sql: saveDialog.sql }].sort((a, b) => a.name.localeCompare(b.name));
                    setSaved(next);
                    save(`querybird.saved.${connId}`, next);
                    setTabs((prev) => prev.map((t) => (t.id === activeId && t.kind === "query" ? { ...t, title: name } : t)));
                    setSaveDialog(null);
                    toast.show(`Saved “${name}” — find it under Queries`);
                  }}
                >
                  Save
                </button>
              </>
            }
          >
            <input
              className="input"
              style={{ width: "100%" }}
              autoFocus
              placeholder="Query name"
              value={saveDialog.name}
              onChange={(e) => setSaveDialog({ ...saveDialog, name: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.closest(".modal")?.querySelector(".btn.primary") as HTMLButtonElement)?.click()}
            />
          </Modal>
        )}
        {closeConfirm && (
          <Modal
            title="Discard uncommitted changes?"
            width={400}
            onClose={() => setCloseConfirm(null)}
            footer={
              <>
                <span className="spacer" />
                <button className="btn" onClick={() => setCloseConfirm(null)}>Cancel</button>
                <button className="btn danger" onClick={() => closeTab(closeConfirm, true)}>Discard &amp; Close</button>
              </>
            }
          >
            <div style={{ textAlign: "center" }}>This tab has changes that haven’t been committed.</div>
          </Modal>
        )}
      </div>
    </WorkspaceContext.Provider>
  );
}

function fmtTime(d: Date) {
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function SchemaPicker({ title, schemas, current, onClose, onPick }: { title: string; schemas: string[]; current: string; onClose: () => void; onPick: (s: string) => void }) {
  const [q, setQ] = useState("");
  const list = schemas.filter((s) => s.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title={title} width={360} onClose={onClose}>
      <div className="search">
        <IconSearch />
        <input className="input" autoFocus placeholder="Search..." value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && list[0] && onPick(list[0])} />
      </div>
      <div className="anything-list">
        {list.map((s) => (
          <div key={s} className={`tree-item${s === current ? " active" : ""}`} onClick={() => onPick(s)}>
            <IconDatabase size={14} />
            <span className="tree-label">{s}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
