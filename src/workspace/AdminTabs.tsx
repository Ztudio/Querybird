import { useCallback, useEffect, useState } from "react";
import { IconX } from "../components/icons";
import { Modal } from "../components/ui";
import { api, errorText, type AccessLevel, type DbUser, type QueryResult, type UserAction, type UserSpec } from "../api";
import { DataGrid, type GridSelection } from "./DataGrid";
import { generatePassword } from "../lib/password";
import { useWs, type TabApi } from "./context";

/** All tables in the schema with sizes and row estimates (TablePlus "Item overview"). */
export function OverviewTab({ register }: { register: (a: TabApi) => void }) {
  const ws = useWs();
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setResult(await api.itemOverview(ws.sessionId, ws.schema));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [ws.sessionId, ws.schema]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    register({ reload: load });
  });
  const open = (r: number, structure = false) => {
    const name = result?.rows[r]?.[0];
    if (name) ws.openTable(ws.schema, name, { newTab: true, view: structure ? "structure" : "data" });
  };
  return (
    <div className="tab-body">
      {error ? (
        <div className="tab-error mono">{error}</div>
      ) : result ? (
        <DataGrid
          columns={result.columns}
          rows={result.rows}
          rowNumbers
          dataKey={`${result.rows.length}`}
          onQuickLook={(r) => open(r)}
          onContextMenu={(e, r) =>
            ws.setMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                { label: "Open", onClick: () => open(r) },
                { label: "Open structure", onClick: () => open(r, true) },
                { label: "Copy name", onClick: () => navigator.clipboard.writeText(result.rows[r][0] ?? "") },
              ],
            })
          }
        />
      ) : (
        <div className="empty">Loading…</div>
      )}
      <div className="bottom-bar">
        <span className="muted">Item overview · {ws.schema}</span>
        <span className="spacer" />
        <span className="muted status-text">{result ? `${result.rows.length} items · ⌘↵ or right-click to open` : ""}</span>
        <span className="spacer" />
        <button className="btn" onClick={load}>Refresh</button>
      </div>
    </div>
  );
}

/** Live process list with Kill (TablePlus Tools → Process List). */
export function ProcessTab({ register }: { register: (a: TabApi) => void }) {
  const ws = useWs();
  const [result, setResult] = useState<QueryResult | null>(null);
  const [sel, setSel] = useState<GridSelection>({ rows: [], focus: null });
  const [auto, setAuto] = useState(false);
  const [confirmKill, setConfirmKill] = useState<number[] | null>(null);
  const load = useCallback(async () => {
    try {
      const sql = await api.processListSql(ws.sessionId);
      const [r] = await api.execute(ws.sessionId, sql);
      setResult(r);
    } catch (e) {
      ws.toast(errorText(e), true);
    }
  }, [ws.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!auto) return;
    const t = window.setInterval(load, 2000);
    return () => window.clearInterval(t);
  }, [auto, load]);
  useEffect(() => {
    register({ reload: load });
  });

  const kill = async (rows: number[]) => {
    for (const r of rows) {
      const pid = result?.rows[r]?.[0];
      if (!pid) continue;
      try {
        await api.killProcess(ws.sessionId, pid);
        ws.log(ws.driver === "mysql" ? `KILL ${pid};` : `SELECT pg_terminate_backend(${pid});`);
      } catch (e) {
        ws.toast(errorText(e), true);
      }
    }
    load();
  };

  return (
    <div className="tab-body">
      {result ? (
        <DataGrid
          columns={result.columns}
          rows={result.rows}
          rowNumbers
          dataKey={`${result.rows.length}-${result.rows.map((r) => r[0]).join()}`}
          onSelectionChange={setSel}
          onContextMenu={(e, _r, _c, s) =>
            ws.setMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                { label: "Refresh", onClick: load },
                { label: s.rows.length > 1 ? `Kill ${s.rows.length} processes…` : "Kill process…", danger: true, onClick: () => setConfirmKill(s.rows) },
              ],
            })
          }
        />
      ) : (
        <div className="empty">Loading…</div>
      )}
      <div className="bottom-bar">
        <span className="muted">Process list</span>
        <label className="row" style={{ marginLeft: 8 }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto refresh
        </label>
        <span className="spacer" />
        <span className="muted status-text">{result ? `${result.rows.length} processes` : ""}</span>
        <span className="spacer" />
        <button className="btn danger" disabled={!sel.rows.length} onClick={() => setConfirmKill(sel.rows)}>Kill…</button>
        <button className="btn" onClick={load}>Refresh</button>
      </div>
      {confirmKill && (
        <Modal
          title={`Terminate ${confirmKill.length} process${confirmKill.length === 1 ? "" : "es"}?`}
          width={420}
          onClose={() => setConfirmKill(null)}
          footer={
            <>
              <span className="spacer" />
              <button className="btn" autoFocus onClick={() => setConfirmKill(null)}>Cancel</button>
              <button className="btn danger" onClick={() => (kill(confirmKill), setConfirmKill(null))}>Terminate</button>
            </>
          }
        >
          <div>Process id{confirmKill.length === 1 ? "" : "s"}: {confirmKill.map((r) => result?.rows[r]?.[0]).join(", ")}. Their open transactions will be rolled back.</div>
        </Modal>
      )}
    </div>
  );
}

export function usersSql(driver: string) {
  return driver === "mysql"
    ? "SELECT User, Host, account_locked, password_expired, password_last_changed FROM mysql.user ORDER BY User, Host;"
    : "SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolconnlimit, rolvaliduntil FROM pg_catalog.pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname;";
}

const BLANK_USER: UserSpec = {
  name: "",
  host: "%",
  password: null,
  superuser: false,
  canLogin: true,
  createDb: false,
  createRole: false,
  locked: false,
  connLimit: null,
  validUntil: null,
};

const LEVELS: { id: AccessLevel; label: string; hint: string }[] = [
  { id: "readOnly", label: "Read only", hint: "SELECT" },
  { id: "readWrite", label: "Read & write", hint: "SELECT, INSERT, UPDATE, DELETE" },
  { id: "all", label: "Full access", hint: "ALL PRIVILEGES" },
];

const specFrom = (u: DbUser): UserSpec => ({
  name: u.name,
  host: u.host,
  password: null,
  superuser: u.superuser,
  canLogin: u.canLogin,
  createDb: u.createDb,
  createRole: u.createRole,
  locked: u.locked,
  connLimit: u.connLimit != null && u.connLimit >= 0 ? u.connLimit : null,
  validUntil: u.validUntil,
});


/** User management: accounts on the left, an editor with access presets on the right. */
export function UsersTab({ register }: { register: (a: TabApi) => void }) {
  const ws = useWs();
  const isMy = ws.driver === "mysql";
  const [users, setUsers] = useState<DbUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // null: nothing selected; "new": creating; otherwise "name@host" of the selected account.
  const [selKey, setSelKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<UserSpec>(BLANK_USER);
  const [showPw, setShowPw] = useState(false);
  const [grants, setGrants] = useState<string[] | null>(null);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [currentDb, setCurrentDb] = useState("");
  const [target, setTarget] = useState(isMy ? ws.schema : ws.schema);
  const [level, setLevel] = useState<AccessLevel>("readOnly");
  const [roleToAdd, setRoleToAdd] = useState("");
  const [confirm, setConfirm] = useState<{ title: string; action: UserAction; statements: string[]; danger?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pwFor, setPwFor] = useState<DbUser | null>(null);
  const [dbFor, setDbFor] = useState<{ user: DbUser; name: string } | null>(null);

  const key = (u: { name: string; host: string }) => `${u.name}@${u.host}`;
  const selected = users?.find((u) => key(u) === selKey) ?? null;
  const creating = selKey === "new";

  const load = useCallback(async () => {
    if (ws.driver === "sqlite") return;
    try {
      setUsers(await api.listUsers(ws.sessionId));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [ws.sessionId, ws.driver]);

  useEffect(() => {
    load();
    if (ws.driver === "sqlite") return;
    api.listSchemas(ws.sessionId).then(setSchemas).catch(() => setSchemas([]));
    if (!isMy) {
      api
        .execute(ws.sessionId, "SELECT current_database()")
        .then(([r]) => setCurrentDb(r?.rows[0]?.[0] ?? ""))
        .catch(() => {});
    }
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    register({ reload: load });
  });

  const loadGrants = useCallback(async (u: DbUser | null) => {
    setGrants(null);
    if (!u) return;
    try {
      setGrants(await api.userGrants(ws.sessionId, u.name, u.host));
    } catch (e) {
      setGrants([`Could not read privileges: ${errorText(e)}`]);
    }
  }, [ws.sessionId]);

  const select = (u: DbUser | "new") => {
    setShowPw(false);
    if (u === "new") {
      setSelKey("new");
      setDraft({ ...BLANK_USER, host: isMy ? "%" : "" });
      setGrants(null);
    } else {
      setSelKey(key(u));
      setDraft(specFrom(u));
      loadGrants(u);
    }
  };

  const ask = async (title: string, action: UserAction, danger = false) => {
    try {
      const statements = await api.userPreview(ws.sessionId, action);
      setConfirm({ title, action, statements, danger });
    } catch (e) {
      ws.toast(errorText(e), true);
    }
  };

  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const done = await api.userApply(ws.sessionId, confirm.action);
      done.forEach(ws.log);
      const a = confirm.action;
      setConfirm(null);
      const fresh = await api.listUsers(ws.sessionId);
      setUsers(fresh);
      if (a.action === "drop") {
        setSelKey(null);
        ws.toast(`Deleted ${a.name}`);
      } else {
        const name = a.action === "create" || a.action === "alter" ? a.user.name : a.name;
        const host = a.action === "create" || a.action === "alter" ? a.user.host : a.action === "grant" || a.action === "createDatabase" ? a.host : "";
        const u = fresh.find((x) => x.name === name && (!isMy || x.host === (host || "%")));
        if (u) {
          setSelKey(key(u));
          setDraft(specFrom(u));
          loadGrants(u);
        }
        ws.toast(
          a.action === "create"
            ? `Created ${name}`
            : a.action === "alter"
              ? `Saved ${name}`
              : a.action === "createDatabase"
                ? `Created database ${a.database}`
                : "Privileges updated",
        );
      }
    } catch (e) {
      ws.toast(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };

  if (ws.driver === "sqlite") {
    return (
      <div className="tab-body">
        <div className="empty">SQLite databases have no user accounts — access is controlled by the file’s permissions on disk.</div>
      </div>
    );
  }

  const set = <K extends keyof UserSpec>(k: K, v: UserSpec[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const shown = (users ?? []).filter((u) => !filter || key(u).toLowerCase().includes(filter.toLowerCase()));
  const label = (u: { name: string; host: string }) => (isMy ? `${u.name}@${u.host || "%"}` : u.name);
  const save = () =>
    creating
      ? ask(`Create ${isMy ? "user" : "role"} ${label(draft)}`, { action: "create", user: draft })
      : selected && ask(`Save ${label(selected)}`, { action: "alter", name: selected.name, host: selected.host, user: draft });
  const grantTarget = isMy ? target : target || ws.schema;
  const otherRoles = (users ?? []).map((u) => u.name).filter((n) => n !== selected?.name && !selected?.memberOf.includes(n));

  return (
    <div className="tab-body">
      {/* The wrapper is the size container, so the layout inside can switch direction. */}
      <div className="users-wrap">
      <div className="users-layout">
        <div className="users-list">
          <div className="row" style={{ padding: 8, gap: 6 }}>
            <input className="input" style={{ flex: 1 }} placeholder="Filter users" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button className="btn primary" onClick={() => select("new")}>New</button>
          </div>
          <div className="users-items">
            {error && <div className="tab-error mono" style={{ padding: 10 }}>{error}</div>}
            {!users && !error && <div className="empty">Loading…</div>}
            {shown.map((u) => (
              <div
                key={key(u)}
                className={`users-item${selKey === key(u) ? " selected" : ""}`}
                onClick={() => select(u)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  select(u);
                  ws.setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { label: "Change password…", onClick: () => setPwFor(u) },
                      { label: "Copy name", onClick: () => navigator.clipboard.writeText(u.name) },
                      { separator: true },
                      { label: "Delete…", danger: true, onClick: () => ask(`Delete ${label(u)}?`, { action: "drop", name: u.name, host: u.host }, true) },
                    ],
                  });
                }}
              >
                <div className="users-name" title={isMy ? `${u.name}@${u.host}` : u.name}>{u.name}{isMy && <span className="faint">@{u.host}</span>}</div>
                <div className="users-tags">
                  {u.superuser && <span className="users-tag admin">superuser</span>}
                  {!u.canLogin && <span className="users-tag">role</span>}
                  {u.locked && <span className="users-tag warn">locked</span>}
                  {u.memberOf.length > 0 && <span className="users-tag">in {u.memberOf.join(", ")}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="users-detail">
          {!selected && !creating ? (
            <div className="empty">Select a user to edit it, or click New to create one.</div>
          ) : (
            <>
              <div className="row users-head">
                <h3 title={creating ? undefined : label(selected!)}>{creating ? `New ${isMy ? "user" : "role"}` : label(selected!)}</h3>
                {!creating && selected && <button className="btn" onClick={() => setPwFor(selected)}>Change password…</button>}
              </div>
              <div className="form-grid">
                <label>Name</label>
                <input className="input" autoFocus={creating} value={draft.name} placeholder="app_user" onChange={(e) => set("name", e.target.value)} />
                {isMy && (
                  <>
                    <label>Host</label>
                    <div className="row">
                      <input className="input mono" style={{ flex: 1 }} list="qb-hosts" value={draft.host} placeholder="%" onChange={(e) => set("host", e.target.value)} />
                      <datalist id="qb-hosts">
                        <option value="%">any host</option>
                        <option value="localhost">this machine (socket)</option>
                        <option value="127.0.0.1">this machine (TCP)</option>
                      </datalist>
                      <span className="faint" style={{ fontSize: 11.5 }}>% = from anywhere</span>
                    </div>
                  </>
                )}
                <label>Password</label>
                <div className="row">
                  <input
                    className="input mono"
                    style={{ flex: 1 }}
                    type={showPw ? "text" : "password"}
                    value={draft.password ?? ""}
                    placeholder={creating ? "password" : "unchanged"}
                    autoComplete="new-password"
                    onChange={(e) => set("password", e.target.value || null)}
                  />
                  <button type="button" className="btn" onClick={() => setShowPw((s) => !s)}>{showPw ? "Hide" : "Show"}</button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      set("password", generatePassword());
                      setShowPw(true);
                    }}
                  >
                    Generate
                  </button>
                  {draft.password && (
                    <button type="button" className="btn" onClick={() => navigator.clipboard.writeText(draft.password ?? "").then(() => ws.toast("Password copied"))}>Copy</button>
                  )}
                </div>
                {!isMy && (
                  <>
                    <label>Options</label>
                    <div className="users-checks">
                      <label className="row"><input type="checkbox" checked={draft.canLogin} onChange={(e) => set("canLogin", e.target.checked)} /> Can log in</label>
                      <label className="row"><input type="checkbox" checked={draft.createDb} onChange={(e) => set("createDb", e.target.checked)} /> Create databases</label>
                      <label className="row"><input type="checkbox" checked={draft.createRole} onChange={(e) => set("createRole", e.target.checked)} /> Create roles</label>
                      <label className="row"><input type="checkbox" checked={draft.superuser} onChange={(e) => set("superuser", e.target.checked)} /> Superuser</label>
                    </div>
                    <label>Limits</label>
                    <div className="row">
                      <input
                        className="input"
                        style={{ width: 90 }}
                        value={draft.connLimit ?? ""}
                        placeholder="no limit"
                        onChange={(e) => set("connLimit", e.target.value.trim() === "" ? null : Number(e.target.value.replace(/\D/g, "")))}
                      />
                      <span className="muted">connections · valid until</span>
                      <input className="input mono" style={{ flex: 1 }} value={draft.validUntil ?? ""} placeholder="never (e.g. 2027-01-01)" onChange={(e) => set("validUntil", e.target.value || null)} />
                    </div>
                  </>
                )}
                {isMy && (
                  <>
                    <label>Options</label>
                    <div className="users-checks">
                      <label className="row"><input type="checkbox" checked={draft.locked} onChange={(e) => set("locked", e.target.checked)} /> Account locked</label>
                      {creating && (
                        <label className="row"><input type="checkbox" checked={draft.superuser} onChange={(e) => set("superuser", e.target.checked)} /> Administrator (all privileges, can grant)</label>
                      )}
                    </div>
                  </>
                )}
              </div>
              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                {!creating && selected && (
                  <button className="btn danger" onClick={() => ask(`Delete ${label(selected)}?`, { action: "drop", name: selected.name, host: selected.host }, true)}>Delete…</button>
                )}
                <span className="spacer" />
                <button className="btn" onClick={() => (creating ? setSelKey(null) : selected && select(selected))}>{creating ? "Cancel" : "Revert"}</button>
                <button className="btn primary" disabled={!draft.name.trim() || (creating && !draft.password && draft.canLogin)} onClick={save}>
                  {creating ? "Create…" : "Save…"}
                </button>
              </div>

              {!creating && selected && (
                <>
                  <div className="users-section">Access</div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <span className="muted">Give</span>
                    <select className="input" value={level} onChange={(e) => setLevel(e.target.value as AccessLevel)}>
                      {LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                    </select>
                    <span className="muted">on {isMy ? "database" : `schema (in ${currentDb || "this database"})`}</span>
                    <select className="input" value={grantTarget} onChange={(e) => setTarget(e.target.value)}>
                      {isMy && <option value="*">* (all databases)</option>}
                      {schemas.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <button
                      className="btn"
                      onClick={() =>
                        ask(`Grant ${LEVELS.find((l) => l.id === level)!.label.toLowerCase()} to ${label(selected)}`, {
                          action: "grant", name: selected.name, host: selected.host, database: isMy ? grantTarget : currentDb, schema: isMy ? "" : grantTarget, level, revoke: false,
                        })
                      }
                    >
                      Grant…
                    </button>
                    <button
                      className="btn"
                      onClick={() =>
                        ask(`Revoke ${label(selected)}’s access to ${grantTarget}`, {
                          action: "grant", name: selected.name, host: selected.host, database: isMy ? grantTarget : currentDb, schema: isMy ? "" : grantTarget, level, revoke: true,
                        }, true)
                      }
                    >
                      Revoke all…
                    </button>
                  </div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="btn" onClick={() => setDbFor({ user: selected, name: selected.name })}>New database for this user…</button>
                  </div>
                  <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>
                    {LEVELS.find((l) => l.id === level)!.hint}
                    {!isMy && " on every table and sequence in the schema, and on tables you create there later."}
                  </div>

                  {!isMy && (
                    <>
                      <div className="users-section">Member of</div>
                      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                        {selected.memberOf.length === 0 && <span className="faint">No role memberships</span>}
                        {selected.memberOf.map((r) => (
                          <span key={r} className="users-tag big">
                            {r}
                            <button title={`Remove from ${r}`} onClick={() => ask(`Remove ${selected.name} from ${r}`, { action: "membership", name: selected.name, role: r, revoke: true }, true)}><IconX size={11} /></button>
                          </span>
                        ))}
                        <span className="spacer" />
                        <select className="input" value={roleToAdd} onChange={(e) => setRoleToAdd(e.target.value)}>
                          <option value="">Add to role…</option>
                          {otherRoles.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <button className="btn" disabled={!roleToAdd} onClick={() => ask(`Add ${selected.name} to ${roleToAdd}`, { action: "membership", name: selected.name, role: roleToAdd, revoke: false })}>Add</button>
                      </div>
                    </>
                  )}

                  <div className="users-section">
                    Current privileges
                    <button className="btn small" style={{ marginLeft: 8 }} onClick={() => loadGrants(selected)}>Refresh</button>
                  </div>
                  {selected.superuser && !isMy && <div className="faint" style={{ marginBottom: 6 }}>Superuser — bypasses all permission checks.</div>}
                  <pre className="mono code-box users-grants">
                    {grants === null ? "Loading…" : grants.length ? grants.join("\n") : "No explicit privileges."}
                  </pre>
                </>
              )}
            </>
          )}
        </div>
      </div>
      </div>
      <div className="bottom-bar">
        <span className="muted">{isMy ? "Users" : "Roles"}</span>
        <span className="spacer" />
        <span className="muted status-text">{users ? `${users.length} ${isMy ? "accounts" : "roles"}` : ""}</span>
        <span className="spacer" />
        <button className="btn" onClick={() => ws.openQuery(usersSql(ws.driver), "Users (SQL)", true)}>Open as SQL</button>
        <button className="btn" onClick={load}>Refresh</button>
      </div>
      {dbFor && (
        <Modal
          title={`New database for ${label(dbFor.user)}`}
          width={420}
          onClose={() => setDbFor(null)}
          footer={
            <>
              <span className="spacer" />
              <button className="btn" onClick={() => setDbFor(null)}>Cancel</button>
              <button
                className="btn primary"
                disabled={!dbFor.name.trim()}
                onClick={() => {
                  const { user, name } = dbFor;
                  setDbFor(null);
                  ask(`Create database ${name.trim()}`, { action: "createDatabase", name: user.name, host: user.host, database: name.trim() });
                }}
              >
                Continue…
              </button>
            </>
          }
        >
          <div className="form-grid">
            <label>Name</label>
            <input className="input mono" autoFocus value={dbFor.name} onChange={(e) => setDbFor({ ...dbFor, name: e.target.value })} />
            <span />
            <span className="faint" style={{ fontSize: 11.5 }}>{isMy ? "The user gets all privileges on it." : "The user will own it."}</span>
          </div>
        </Modal>
      )}
      {pwFor && (
        <PasswordDialog
          who={label(pwFor)}
          onClose={() => setPwFor(null)}
          onSubmit={(password) => {
            setPwFor(null);
            ask(`Change password for ${label(pwFor)}`, { action: "alter", name: pwFor.name, host: pwFor.host, user: { ...specFrom(pwFor), password } });
          }}
        />
      )}
      {confirm && (
        <Modal
          title={confirm.title}
          width={560}
          onClose={() => !busy && setConfirm(null)}
          footer={
            <>
              <span className="faint" style={{ fontSize: 11.5 }}>Passwords are masked here and in the console log.</span>
              <span className="spacer" />
              <button className="btn" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
              <button className={`btn ${confirm.danger ? "danger" : "primary"}`} autoFocus disabled={busy} onClick={run}>
                {busy ? "Running…" : "Run"}
              </button>
            </>
          }
        >
          <pre className="mono code-box" style={{ maxHeight: 300, overflow: "auto" }}>{confirm.statements.join("\n")}</pre>
          {confirm.action.action === "drop" && !isMy && (
            <div className="faint" style={{ marginTop: 8, fontSize: 12 }}>
              Objects owned by this role in the current database are handed over to you before it is dropped.
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function PasswordDialog({ who, onClose, onSubmit }: { who: string; onClose: () => void; onSubmit: (password: string) => void }) {
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [show, setShow] = useState(false);
  const mismatch = !show && again !== "" && pw !== again;
  const ok = pw !== "" && (show || pw === again);
  return (
    <Modal
      title={`New password for ${who}`}
      width={440}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ok} onClick={() => onSubmit(pw)}>Continue…</button>
        </>
      }
    >
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onSubmit(pw);
        }}
      >
        <label>Password</label>
        <div className="row">
          <input className="input mono" style={{ flex: 1 }} autoFocus type={show ? "text" : "password"} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <button
            type="button"
            className="btn"
            onClick={() => {
              setPw(generatePassword());
              setShow(true);
            }}
          >
            Generate
          </button>
        </div>
        {show ? (
          <>
            <span />
            <div className="row">
              <button type="button" className="btn small" disabled={!pw} onClick={() => navigator.clipboard.writeText(pw)}>Copy</button>
              <button type="button" className="btn small" onClick={() => setShow(false)}>Hide</button>
              <span className="faint" style={{ fontSize: 11.5 }}>Copy it now — it isn’t stored anywhere.</span>
            </div>
          </>
        ) : (
          <>
            <label>Confirm</label>
            <input className="input mono" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          </>
        )}
        {mismatch && (
          <>
            <span />
            <span style={{ color: "var(--red)", fontSize: 12 }}>Passwords don’t match</span>
          </>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
