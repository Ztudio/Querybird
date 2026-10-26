import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { api, errorText, type ConnectionConfig, type Driver } from "../api";
import { IconChevron, IconDatabase, IconPencil, IconPlug, IconPlus, IconSearch, IconTrash, IconUsers } from "../components/icons";
import { ContextMenu, DRIVERS, DriverBadge, Modal, isMac, load, save, tagColor, useToast, type MenuItem, type MenuState } from "../components/ui";
import { BackupDialog } from "../components/BackupDialog";
import { SettingsModal } from "../components/SettingsModal";
import { NewUserDialog } from "./NewUserDialog";
import { ConnectionForm, SQLITE_EXTENSIONS, fileStem, newConfig, parseUrl } from "./ConnectionForm";
import "./welcome.css";

type Dialog =
  | { kind: "driver"; group?: string }
  | { kind: "form"; config: ConnectionConfig; password?: string }
  | { kind: "url" }
  | { kind: "password"; config: ConnectionConfig; open?: "users" }
  | { kind: "delete"; config: ConnectionConfig }
  | { kind: "error"; text: string }
  | { kind: "group"; rename?: string }
  | { kind: "settings" }
  | { kind: "backup" | "restore" }
  | { kind: "newUser"; config?: ConnectionConfig };

export function Welcome() {
  const [list, setList] = useState<ConnectionConfig[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [extraGroups, setExtraGroups] = useState<string[]>(() => load("querybird.groups", []));
  const [collapsed, setCollapsed] = useState<string[]>(() => load("querybird.groups.collapsed", []));
  const toast = useToast();
  const groups = useMemo(
    () => Array.from(new Set([...extraGroups, ...list.map((c) => c.group).filter(Boolean)])).sort((a, b) => a.localeCompare(b)),
    [list, extraGroups],
  );
  useEffect(() => save("querybird.groups", extraGroups), [extraGroups]);
  useEffect(() => save("querybird.groups.collapsed", collapsed), [collapsed]);

  const reload = () => api.listConnections().then(setList).catch(() => setList([]));
  useEffect(() => {
    reload();
    const w = getCurrentWindow();
    const un = w.onFocusChanged(({ payload }) => payload && reload());
    return () => {
      un.then((f) => f());
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return list
      .filter((c) => !q || `${c.name} ${c.host} ${c.database} ${c.tag}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [list, query]);

  /** `open` names a tab the new workspace opens first (e.g. "users"). */
  const connect = async (c: ConnectionConfig, password?: string | null, open?: "users") => {
    if (c.passwordMode === "ask" && password == null) {
      setDialog({ kind: "password", config: c, open });
      return;
    }
    setDialog(null);
    setConnecting(c.id);
    try {
      const s = await api.connect(c, password ?? null);
      if (open) save(`querybird.open.${s.id}`, open);
      await api.openWorkspace(s.id, c.name);
    } catch (e) {
      setDialog({ kind: "error", text: errorText(e) });
    } finally {
      setConnecting(null);
    }
  };

  const moveToGroup = async (c: ConnectionConfig, group: string) => {
    await api.saveConnection({ ...c, group }, null);
    reload();
  };

  const copyUrl = async (c: ConnectionConfig, withPassword: boolean) => {
    await api.copyConnectionUrl(c.id, withPassword);
    toast.show(withPassword ? "Connection URL (with password) copied" : "Connection URL copied");
  };

  // Ungrouped connections first, then each group, like the TablePlus list.
  const sections = useMemo(() => {
    const out: { group: string; items: ConnectionConfig[] }[] = [{ group: "", items: filtered.filter((c) => !c.group) }];
    for (const g of groups) out.push({ group: g, items: filtered.filter((c) => c.group === g) });
    return out.filter((s) => s.group === "" || s.items.length || !query);
  }, [filtered, groups, query]);
  const visible = useMemo(() => sections.flatMap((s) => (s.group && collapsed.includes(s.group) ? [] : s.items)), [sections, collapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setDialog({ kind: "settings" });
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setDialog({ kind: "driver" });
      }
    };
    window.addEventListener("keydown", onKey);
    const un = listen<string>("menu", (e) => {
      if (e.payload === "settings") setDialog({ kind: "settings" });
      else if (e.payload === "new_connection") setDialog({ kind: "driver" });
      else if (e.payload === "backup" || e.payload === "restore") setDialog({ kind: e.payload });
      else if (e.payload === "new_user") setDialog({ kind: "newUser" });
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      un.then((f) => f());
    };
  }, []);

  /** Open a SQLite file straight from the welcome window: reuse its saved connection, or create one. */
  const openSqliteFile = async () => {
    const path = await api.pickPath("open", { filterName: "SQLite database", extensions: SQLITE_EXTENSIONS });
    if (!path) return;
    const existing = list.find((c) => c.driver === "sqlite" && c.database === path);
    if (existing) return connect(existing);
    const saved = await api.saveConnection({ ...newConfig("sqlite"), name: fileStem(path), database: path }, null);
    await reload();
    setSelected(saved.id);
    connect(saved, null);
  };

  const duplicate = async (c: ConnectionConfig) => {
    const copy = await api.saveConnection({ ...c, id: "", name: `${c.name} copy` }, null);
    await reload();
    setSelected(copy.id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (dialog) return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const idx = visible.findIndex((c) => c.id === selected);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(visible[Math.min(visible.length - 1, idx + 1)]?.id ?? null);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(visible[Math.max(0, idx - 1)]?.id ?? null);
    } else if (e.key === "Enter" && idx >= 0) {
      connect(visible[idx]);
    } else if ((e.key === "Backspace" || e.key === "Delete") && idx >= 0) {
      setDialog({ kind: "delete", config: visible[idx] });
    }
  };

  return (
    <div className="welcome" onKeyDown={onKeyDown}>
      <div className="welcome-left" data-tauri-drag-region>
        <img src="/icon.svg" className="welcome-logo" alt="" draggable={false} data-tauri-drag-region />
        <div className="welcome-name" data-tauri-drag-region>Querybird</div>
        <div className="welcome-version" data-tauri-drag-region>Version 0.1.0</div>
        <div className="spacer" data-tauri-drag-region />
        <div className="welcome-free" data-tauri-drag-region>Free &amp; open source · no license key</div>
        {/* Server tools, then ways to open a database: grouped by space rather than lines. */}
        <div className="welcome-actions">
          <button className="welcome-action" disabled={!list.length} onClick={() => setDialog({ kind: "backup" })}>
            <IconBox down={false} /> Backup database…
          </button>
          <button className="welcome-action" disabled={!list.length} onClick={() => setDialog({ kind: "restore" })}>
            <IconBox down /> Restore database…
          </button>
          <button className="welcome-action" disabled={!list.some((c) => c.driver !== "sqlite")} onClick={() => setDialog({ kind: "newUser", config: list.find((c) => c.id === selected) })}>
            <IconUsers /> New database user…
          </button>
        </div>
        <div className="welcome-actions">
          <button className="welcome-action" onClick={openSqliteFile}>
            <IconDatabase /> Open SQLite file…
          </button>
          <button className="welcome-action" onClick={() => setDialog({ kind: "driver" })}>
            <IconPlug /> Create connection…
          </button>
        </div>
      </div>
      <div className="welcome-right">
        <div className="welcome-head" data-tauri-drag-region>
          <button className="icon-btn" title="New connection" onClick={() => setDialog({ kind: "driver" })}>
            <IconPlus />
          </button>
          <div className="search" style={{ flex: 1 }}>
            <IconSearch />
            <input className="input" placeholder="Search for connection…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ height: 30 }} />
          </div>
          <button className="icon-btn" title="Settings (⌘,)" onClick={() => setDialog({ kind: "settings" })}>
            <IconGear />
          </button>
        </div>
        <div className="welcome-list" ref={listRef} tabIndex={0}>
          {sections.map((sec) => (
            <div key={sec.group || "_"}>
              {sec.group && (
                <div
                  className="conn-group"
                  onClick={() => setCollapsed((c) => (c.includes(sec.group) ? c.filter((x) => x !== sec.group) : [...c, sec.group]))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        { label: "New connection in group…", onClick: () => setDialog({ kind: "driver", group: sec.group }) },
                        { label: "Rename group…", onClick: () => setDialog({ kind: "group", rename: sec.group }) },
                        { separator: true },
                        {
                          label: "Delete group (keeps connections)",
                          danger: true,
                          onClick: async () => {
                            await api.renameGroup(sec.group, "");
                            setExtraGroups((g) => g.filter((x) => x !== sec.group));
                            reload();
                          },
                        },
                      ],
                    });
                  }}
                >
                  <IconChevron open={!collapsed.includes(sec.group)} /> {sec.group}
                  <span className="faint" style={{ marginLeft: 4 }}>{sec.items.length}</span>
                </div>
              )}
              {!(sec.group && collapsed.includes(sec.group)) &&
                sec.items.map((c) => (
            <div
              key={c.id}
              className={`conn-item${selected === c.id ? " selected" : ""}${sec.group ? " grouped" : ""}`}
              onMouseDown={() => setSelected(c.id)}
              onDoubleClick={() => connect(c)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSelected(c.id);
                const groupItems: MenuItem[] = [
                  { label: "No group", disabled: !c.group, onClick: () => moveToGroup(c, "") },
                  ...groups.map((g) => ({ label: g, disabled: g === c.group, onClick: () => moveToGroup(c, g) })),
                  { separator: true },
                  { label: "New group…", onClick: () => setDialog({ kind: "group" }) },
                ];
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  items: [
                    { label: "Connect", onClick: () => connect(c) },
                    ...(c.driver !== "sqlite"
                      ? [
                          { label: "New user on this server…", onClick: () => setDialog({ kind: "newUser", config: c }) },
                          { label: "Manage users…", onClick: () => connect(c, undefined, "users") },
                        ]
                      : []),
                    { separator: true },
                    { label: "Edit…", onClick: () => setDialog({ kind: "form", config: c }) },
                    { label: "Duplicate", onClick: () => duplicate(c) },
                    { label: "Move to group", submenu: groupItems },
                    {
                      label: "Copy as URL",
                      submenu: [
                        { label: "Without password", onClick: () => copyUrl(c, false) },
                        { label: "With password", disabled: c.passwordMode === "ask", onClick: () => copyUrl(c, true) },
                      ],
                    },
                    { separator: true },
                    { label: "Delete", kbd: "⌫", danger: true, onClick: () => setDialog({ kind: "delete", config: c }) },
                  ],
                });
              }}
            >
              {/^#[0-9a-f]{3,8}$/i.test(c.color) && <span className="conn-color" style={{ background: c.color }} />}
              <DriverBadge driver={c.driver} />
              <div style={{ minWidth: 0 }}>
                <div className="conn-name">
                  {c.name} <span style={{ color: selected === c.id ? "inherit" : tagColor(c.tag) }}>({c.tag})</span>
                  {c.ssh?.enabled && <span className="conn-ssh">SSH</span>}
                </div>
                <div className="conn-sub" title={c.driver === "sqlite" ? c.database : undefined}>
                  {connecting === c.id
                    ? "Connecting…"
                    : c.driver === "sqlite"
                      ? c.database || "—"
                      : `${c.host}${c.port ? `:${c.port}` : ""} : ${c.database || "—"}`}
                </div>
              </div>
              <div className="conn-actions" onDoubleClick={(e) => e.stopPropagation()}>
                {c.driver !== "sqlite" && (
                  <button title="Manage users" onClick={() => connect(c, undefined, "users")}><IconUsers size={15} /></button>
                )}
                <button title="Edit connection" onClick={() => setDialog({ kind: "form", config: c })}><IconPencil /></button>
                <button title="Delete connection (⌫)" className="danger" onClick={() => setDialog({ kind: "delete", config: c })}><IconTrash /></button>
              </div>
            </div>
                ))}
            </div>
          ))}
          {!list.length && (
            <div className="empty" style={{ flexDirection: "column", gap: 10 }}>
              <div>No connections yet</div>
              <button className="btn primary" onClick={() => setDialog({ kind: "driver" })}>Create connection</button>
            </div>
          )}
        </div>
      </div>

      <ContextMenu menu={menu} onClose={() => setMenu(null)} />

      {dialog?.kind === "driver" && (
        <DriverPicker
          onClose={() => setDialog(null)}
          onPick={(d) => setDialog({ kind: "form", config: newConfig(d, dialog.group ?? "") })}
          onUrl={() => setDialog({ kind: "url" })}
          onGroup={() => setDialog({ kind: "group" })}
        />
      )}
      {dialog?.kind === "group" && (
        <GroupPrompt
          initial={dialog.rename ?? ""}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            if (dialog.rename) {
              await api.renameGroup(dialog.rename, name);
              setExtraGroups((g) => g.map((x) => (x === dialog.rename ? name : x)));
            } else {
              setExtraGroups((g) => Array.from(new Set([...g, name])));
            }
            setDialog(null);
            reload();
          }}
        />
      )}
      {dialog?.kind === "settings" && <SettingsModal onClose={() => setDialog(null)} />}
      {(dialog?.kind === "backup" || dialog?.kind === "restore") && (
        <BackupDialog
          mode={dialog.kind}
          connections={list}
          initial={list.find((c) => c.id === selected)}
          onClose={() => setDialog(null)}
          onDone={(m) => toast.show(m)}
        />
      )}
      {dialog?.kind === "newUser" && (
        <NewUserDialog
          connections={list}
          initial={dialog.config}
          onClose={() => setDialog(null)}
          onDone={(m) => toast.show(m)}
          onManage={(c) => connect(c, undefined, "users")}
        />
      )}
      {toast.node}
      {dialog?.kind === "form" && (
        <ConnectionForm
          initial={dialog.config}
          initialPassword={dialog.password}
          groups={groups}
          onClose={() => setDialog(null)}
          onSaved={(c) => {
            reload();
            setSelected(c.id);
          }}
          onConnect={(c, pw) => connect(c, pw ?? (c.passwordMode === "ask" ? undefined : null))}
        />
      )}
      {dialog?.kind === "url" && <UrlImport onClose={() => setDialog(null)} onParsed={(config, password) => setDialog({ kind: "form", config, password })} />}
      {dialog?.kind === "password" && <PasswordPrompt config={dialog.config} onClose={() => setDialog(null)} onSubmit={(pw) => connect(dialog.config, pw, dialog.open)} />}
      {dialog?.kind === "delete" && (
        <Modal
          title="Delete connection?"
          width={380}
          onClose={() => setDialog(null)}
          footer={
            <>
              <span className="spacer" />
              <button className="btn" onClick={() => setDialog(null)}>Cancel</button>
              <button
                className="btn danger"
                autoFocus
                onClick={async () => {
                  await api.deleteConnection(dialog.config.id);
                  setDialog(null);
                  reload();
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <div style={{ textAlign: "center" }}>
            “{dialog.config.name}” and its saved password will be removed. Your database is not touched.
          </div>
        </Modal>
      )}
      {dialog?.kind === "error" && (
        <Modal title="Could not connect" width={440} onClose={() => setDialog(null)} footer={<><span className="spacer" /><button className="btn primary" autoFocus onClick={() => setDialog(null)}>OK</button></>}>
          <pre className="mono" style={{ color: "var(--red)" }}>{dialog.text}</pre>
        </Modal>
      )}
    </div>
  );
}

function GroupPrompt({ initial, onClose, onSubmit }: { initial: string; onClose: () => void; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(initial);
  return (
    <Modal
      title={initial ? "Rename group" : "New group"}
      width={340}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => onSubmit(name.trim())}>{initial ? "Rename" : "Create"}</button>
        </>
      }
    >
      <input className="input" style={{ width: "100%" }} autoFocus value={name} placeholder="Group name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && onSubmit(name.trim())} />
    </Modal>
  );
}

function IconGear() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconBox({ down }: { down: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 9.5v3.5h11V9.5" />
      {down ? <path d="M8 2.5v7M5 6.5l3 3 3-3" /> : <path d="M8 9.5v-7M5 5.5l3-3 3 3" />}
    </svg>
  );
}

function DriverPicker({ onClose, onPick, onUrl, onGroup }: { onClose: () => void; onPick: (d: Driver) => void; onUrl: () => void; onGroup: () => void }) {
  const [sel, setSel] = useState<Driver>("postgres");
  const [q, setQ] = useState("");
  const shown = DRIVERS.filter((d) => d.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal
      width={600}
      onClose={onClose}
      footer={
        <>
          <button className="btn" style={{ width: 88 }} onClick={onClose}>Cancel</button>
          <span className="spacer" />
          <button className="btn" onClick={onUrl}>Import from URL</button>
          <button className="btn" onClick={onGroup}>New Group</button>
          <button className="btn primary" style={{ width: 88 }} onClick={() => onPick(sel)}>Create</button>
        </>
      }
    >
      <div className="search" style={{ marginTop: 6 }}>
        <IconSearch />
        <input
          className="input"
          autoFocus
          placeholder="Search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && shown[0] && onPick(shown[0].id)}
        />
      </div>
      <div className="driver-grid">
        {shown.map((d) => (
          <button key={d.id} className={`driver-cell${sel === d.id ? " selected" : ""}`} onClick={() => setSel(d.id)} onDoubleClick={() => onPick(d.id)}>
            <DriverBadge driver={d.id} size={40} />
            <span>{d.label}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function UrlImport({ onClose, onParsed }: { onClose: () => void; onParsed: (c: ConnectionConfig, password: string) => void }) {
  const [url, setUrl] = useState("");
  const parsed = parseUrl(url);
  return (
    <Modal
      title="Import connection from URL"
      width={500}
      onClose={onClose}
      footer={
        <>
          <span className="faint" style={{ fontSize: 11.5 }}>Supports postgresql://, mysql:// and sqlite:///path (or a .sqlite file path)</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!parsed} onClick={() => parsed && onParsed(parsed.config, parsed.password)}>Import</button>
        </>
      }
    >
      <input
        className="input mono"
        style={{ width: "100%" }}
        autoFocus
        placeholder="postgresql://user:password@localhost:5432/database"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && parsed) {
            e.preventDefault();
            onParsed(parsed.config, parsed.password);
          }
        }}
      />
    </Modal>
  );
}

function PasswordPrompt({ config, onClose, onSubmit }: { config: ConnectionConfig; onClose: () => void; onSubmit: (pw: string) => void }) {
  const [pw, setPw] = useState("");
  return (
    <Modal
      title={`Password for ${config.user || "user"}@${config.name}`}
      width={380}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onSubmit(pw)}>Connect</button>
        </>
      }
    >
      <input className="input" type="password" style={{ width: "100%" }} autoFocus value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onSubmit(pw)} />
    </Modal>
  );
}

export const welcomeTopPad = isMac ? 28 : 0;
