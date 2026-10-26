import { useEffect, useRef, useState } from "react";
import { api, errorText, type AccessLevel, type ConnectionConfig, type UserAction, type UserSpec } from "../api";
import { DriverBadge, Modal } from "../components/ui";
import { generatePassword } from "../lib/password";

const LEVELS: { id: AccessLevel; label: string }[] = [
  { id: "readOnly", label: "Read only" },
  { id: "readWrite", label: "Read & write" },
  { id: "all", label: "Full access" },
];

/** What the account Querybird logged in as is allowed to do (null = couldn't tell). */
interface Perms {
  user: string;
  createUser: boolean | null;
  createDb: boolean | null;
}

/** Reads the logged-in account's own privileges, so missing ones are explained before submitting. */
async function readPerms(sessionId: string, mysql: boolean): Promise<Perms | null> {
  try {
    if (!mysql) {
      const [r] = await api.execute(
        sessionId,
        "SELECT current_user::text, (rolsuper OR rolcreaterole)::text, (rolsuper OR rolcreatedb)::text FROM pg_catalog.pg_roles WHERE rolname = current_user",
      );
      const row = r?.rows[0];
      if (!row) return null;
      return { user: row[0] ?? "", createUser: row[1] === "true", createDb: row[2] === "true" };
    }
    const [who] = await api.execute(sessionId, "SELECT CURRENT_USER()");
    const [g] = await api.execute(sessionId, "SHOW GRANTS");
    const grants = (g?.rows ?? []).map((r) => (r[0] ?? "").toUpperCase());
    const global = grants.filter((x) => x.includes(" ON *.* "));
    const all = global.some((x) => x.includes("ALL PRIVILEGES"));
    return {
      user: who?.rows[0]?.[0] ?? "",
      createUser: all || global.some((x) => /\bCREATE USER\b/.test(x)),
      createDb: all || global.some((x) => /GRANT .*\bCREATE\b(?! USER| ROLE| VIEW| ROUTINE| TEMPORARY| TABLESPACE)/.test(x)),
    };
  } catch {
    return null;
  }
}

/** What the new user gets besides a login. */
type AccessMode = "newDb" | "existing" | "none";

/**
 * Creates a database user from the welcome window, without opening a workspace: connects in the
 * background, creates the account, optionally grants access, then disconnects.
 */
export function NewUserDialog({
  connections,
  initial,
  onClose,
  onDone,
  onManage,
}: {
  connections: ConnectionConfig[];
  initial?: ConnectionConfig;
  onClose: () => void;
  onDone: (msg: string) => void;
  /** Opens the full user manager for a connection. */
  onManage: (c: ConnectionConfig) => void;
}) {
  const servers = connections.filter((c) => c.driver !== "sqlite");
  const [connId, setConnId] = useState(initial && initial.driver !== "sqlite" ? initial.id : servers[0]?.id ?? "");
  const conn = servers.find((c) => c.id === connId);
  const isMy = conn?.driver === "mysql";
  const [adminPw, setAdminPw] = useState("");
  const [session, setSession] = useState<{ id: string; schemas: string[]; db: string; schema: string } | null>(null);
  const [perms, setPerms] = useState<Perms | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [name, setName] = useState("");
  const [host, setHost] = useState("%");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [mode, setMode] = useState<AccessMode>("newDb");
  const [newDb, setNewDb] = useState("");
  const [newDbTouched, setNewDbTouched] = useState(false);
  const [level, setLevel] = useState<AccessLevel>("readWrite");
  const [target, setTarget] = useState("");
  const [preview, setPreview] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);

  const disconnect = () => {
    if (sessionRef.current) api.disconnect(sessionRef.current).catch(() => {});
    sessionRef.current = null;
    setSession(null);
    setPerms(null);
  };
  useEffect(() => disconnect, []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async () => {
    if (!conn) return;
    disconnect();
    setError(null);
    setConnecting(true);
    try {
      const s = await api.connect(conn, conn.passwordMode === "ask" ? adminPw : null);
      sessionRef.current = s.id;
      const schemas = await api.listSchemas(s.id);
      const [r] = isMy ? [null] : await api.execute(s.id, "SELECT current_database()");
      const db = r?.rows[0]?.[0] ?? "";
      setSession({ id: s.id, schemas, db, schema: s.schema });
      setPerms(await readPerms(s.id, conn.driver === "mysql"));
      setTarget(isMy ? conn.database || s.schema || schemas[0] || "*" : s.schema || "public");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setConnecting(false);
    }
  };

  // Connect as soon as a connection is chosen (unless its password has to be typed first).
  useEffect(() => {
    setHost(conn?.driver === "mysql" ? "%" : "");
    if (conn && conn.passwordMode !== "ask") open();
    else disconnect();
  }, [connId]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions = (): UserAction[] => {
    const user: UserSpec = {
      name: name.trim(), host, password, superuser: false, canLogin: true, createDb: false, createRole: false,
      locked: false, connLimit: null, validUntil: null,
    };
    const out: UserAction[] = [{ action: "create", user }];
    if (mode === "newDb") {
      out.push({ action: "createDatabase", name: user.name, host, database: dbName });
    } else if (mode === "existing" && session) {
      out.push({
        action: "grant", name: user.name, host, level, revoke: false,
        database: isMy ? target : session.db,
        schema: isMy ? "" : target,
      });
    }
    return out;
  };

  const review = async () => {
    if (!session) return;
    setError(null);
    try {
      const all = await Promise.all(actions().map((a) => api.userPreview(session.id, a)));
      setPreview(all.flat());
    } catch (e) {
      setError(errorText(e));
    }
  };

  const run = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    const [create, ...grants] = actions();
    try {
      await api.userApply(session.id, create);
    } catch (e) {
      setBusy(false);
      setPreview(null);
      setError(errorText(e));
      return;
    }
    try {
      for (const g of grants) await api.userApply(session.id, g);
      const who = isMy ? `${name.trim()}@${host || "%"}` : name.trim();
      onDone(mode === "newDb" ? `Created ${who} and database ${dbName} on ${conn?.name}` : `Created ${who} on ${conn?.name}`);
      onClose();
    } catch (e) {
      setPreview(null);
      setError(`The user was created, but ${mode === "newDb" ? "creating the database" : "granting access"} failed:\n${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!servers.length) {
    return (
      <Modal title="New database user" width={420} onClose={onClose} footer={<><span className="spacer" /><button className="btn primary" onClick={onClose}>OK</button></>}>
        <div>Add a PostgreSQL or MySQL connection first — SQLite databases have no users.</div>
      </Modal>
    );
  }

  // The new database is named after the user unless the user typed another name.
  const dbName = (newDbTouched ? newDb : name).trim();
  const allowed = perms?.createUser !== false && !(mode === "newDb" && perms?.createDb === false);
  const canCreate = !!session && allowed && !!name.trim() && !!password && !busy && (mode !== "newDb" || !!dbName);

  return (
    <Modal
      title={preview ? "Create this user?" : "New database user"}
      width={540}
      onClose={() => !busy && onClose()}
      footer={
        preview ? (
          <>
            <span className="faint" style={{ fontSize: 11.5 }}>Password masked</span>
            <span className="spacer" />
            <button className="btn" disabled={busy} onClick={() => setPreview(null)}>Back</button>
            <button className="btn primary" autoFocus disabled={busy} onClick={run}>{busy ? "Creating…" : "Create user"}</button>
          </>
        ) : (
          <>
            <button className="btn" disabled={!conn} onClick={() => conn && onManage(conn)} title="Open the full user list for this connection">
              Manage all users…
            </button>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!canCreate} onClick={review}>Create…</button>
          </>
        )
      }
    >
      {preview ? (
        <pre className="mono code-box" style={{ maxHeight: 300, overflow: "auto" }}>{preview.join("\n")}</pre>
      ) : (
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            if (canCreate) review();
          }}
        >
          <label>Server</label>
          <div className="row" title={conn ? `${conn.host}${conn.port ? `:${conn.port}` : ""}` : undefined}>
            {conn && <DriverBadge driver={conn.driver} size={20} />}
            {servers.length === 1 && conn ? (
              // Only one server: nothing to choose, just say where the user will be created.
              <span className="new-user-server">
                <b>{conn.name}</b> <span className="faint">{conn.host}</span>
              </span>
            ) : (
              <select className="input" style={{ flex: 1 }} value={connId} onChange={(e) => setConnId(e.target.value)}>
                {servers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} — {c.host}</option>
                ))}
              </select>
            )}
          </div>
          {conn?.passwordMode === "ask" && !session && (
            <>
              <label>Admin password</label>
              <div className="row">
                <input className="input" style={{ flex: 1 }} type="password" value={adminPw} placeholder={`password for ${conn.user || "admin"}`} onChange={(e) => setAdminPw(e.target.value)} />
                <button type="button" className="btn" disabled={connecting} onClick={open}>Connect</button>
              </div>
            </>
          )}
          <span />
          <div style={{ fontSize: 11.5, minHeight: 16 }}>
            {connecting ? (
              <span className="faint">Connecting…</span>
            ) : !session ? null : perms?.createUser === false ? (
              <div className="new-user-warn">
                <b>{perms.user}</b> isn’t allowed to create users. Edit this connection to log in as an admin account
                {isMy ? " (e.g. root)" : " (e.g. postgres, or your RDS master user)"}, or have an admin run:
                <code className="mono code-box">{isMy ? `GRANT CREATE USER ON *.* TO ${perms.user};` : `ALTER ROLE "${perms.user}" CREATEROLE;`}</code>
              </div>
            ) : (
              <span className="faint">
                Connected as {perms?.user || conn?.user || (isMy ? "root" : "postgres")}
                {perms?.createUser ? " · can create users" : ""}
              </span>
            )}
          </div>

          <label>User name</label>
          <input className="input" autoFocus value={name} placeholder="app_user" onChange={(e) => setName(e.target.value)} />
          {isMy && (
            <>
              <label>Can connect from</label>
              <div className="row">
                <select className="input" style={{ flex: 1 }} value={["%", "localhost", "127.0.0.1"].includes(host) ? host : "custom"} onChange={(e) => setHost(e.target.value === "custom" ? "" : e.target.value)}>
                  <option value="%">Anywhere (%)</option>
                  <option value="localhost">This machine only (localhost)</option>
                  <option value="127.0.0.1">This machine over TCP (127.0.0.1)</option>
                  <option value="custom">Specific host or subnet…</option>
                </select>
                {!["%", "localhost", "127.0.0.1"].includes(host) && (
                  <input className="input mono" style={{ width: 150 }} value={host} placeholder="10.0.0.%" onChange={(e) => setHost(e.target.value)} />
                )}
              </div>
            </>
          )}
          <label>Password</label>
          <div className="row">
            <input className="input mono" style={{ flex: 1 }} type={show ? "text" : "password"} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="btn" onClick={() => setShow((s) => !s)}>{show ? "Hide" : "Show"}</button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPassword(generatePassword());
                setShow(true);
              }}
            >
              Generate
            </button>
            {password && <button type="button" className="btn" onClick={() => navigator.clipboard.writeText(password)}>Copy</button>}
          </div>

          <label style={{ alignSelf: "start", paddingTop: 2 }}>Database</label>
          <div style={{ display: "grid", gap: 8 }}>
            <label className="row">
              <input type="radio" checked={mode === "newDb"} onChange={() => setMode("newDb")} /> Create a new database for this user
            </label>
            {mode === "newDb" && (
              <div className="row" style={{ paddingLeft: 22 }}>
                <input
                  className="input mono"
                  style={{ flex: 1 }}
                  value={newDbTouched ? newDb : name}
                  placeholder="database name"
                  onChange={(e) => {
                    setNewDb(e.target.value);
                    setNewDbTouched(true);
                  }}
                />
                <span className="faint" style={{ fontSize: 11.5 }}>{isMy ? "full access" : "owned by the user"}</span>
              </div>
            )}
            {mode === "newDb" && perms?.createDb === false && perms.createUser !== false && (
              <div className="new-user-warn" style={{ marginLeft: 22 }}>
                <b>{perms.user}</b> can’t create databases — pick another option, or log in as an admin.
              </div>
            )}
            <label className="row">
              <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} /> Access to an existing {isMy ? "database" : "schema"}
            </label>
            {mode === "existing" && (
              <div style={{ display: "grid", gap: 4, paddingLeft: 22 }}>
                <div className="row">
                  <select className="input" value={level} onChange={(e) => setLevel(e.target.value as AccessLevel)}>
                    {LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </select>
                  <span className="muted">on</span>
                  <select className="input" style={{ flex: 1 }} value={target} disabled={!session} onChange={(e) => setTarget(e.target.value)}>
                    {isMy && <option value="*">* (all databases)</option>}
                    {(session?.schemas ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                {!isMy && session && (
                  <div className="faint" style={{ fontSize: 11.5 }}>Schemas in {session.db}. To grant on another database, add a connection to it.</div>
                )}
              </div>
            )}
            <label className="row">
              <input type="radio" checked={mode === "none"} onChange={() => setMode("none")} /> No database access — just the login
            </label>
          </div>
          <button type="submit" hidden />
        </form>
      )}
      {error && <pre className="mono code-box" style={{ color: "var(--red)", marginTop: 10, whiteSpace: "pre-wrap" }}>{error}</pre>}
    </Modal>
  );
}
