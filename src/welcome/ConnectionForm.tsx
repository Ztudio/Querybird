import { useState } from "react";
import { api, errorText, type ConnectionConfig, type Driver, type SshConfig } from "../api";
import { DRIVERS, Modal, STATUS_COLORS, TAGS } from "../components/ui";

export const SQLITE_EXTENSIONS = ["sqlite", "sqlite3", "db", "db3", "s3db"];

/** File name without folders or extension, used to name SQLite connections. */
export const fileStem = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, "");

export function newConfig(driver: Driver, group = ""): ConnectionConfig {
  const d = DRIVERS.find((x) => x.id === driver)!;
  const file = driver === "sqlite";
  return {
    id: "",
    name: "",
    driver,
    host: file ? "" : "127.0.0.1",
    port: d.port,
    user: "",
    database: "",
    sslMode: file ? "disable" : "prefer",
    passwordMode: "keychain",
    color: "",
    tag: "local",
    group,
    bootstrap: "",
    ssh: null,
  };
}

const emptySsh = (): SshConfig => ({ enabled: true, host: "", port: 22, user: "", keyPath: null, hostKey: null });

/** Parses postgres://user:pass@host:port/db, mysql://… and sqlite:///path URLs (or a bare SQLite file path). */
export function parseUrl(url: string): { config: ConnectionConfig; password: string } | null {
  const raw = url.trim();
  const sqlitePath = /^sqlite3?:\/\//i.test(raw)
    ? decodeURIComponent(raw.replace(/^sqlite3?:\/\//i, ""))
    : /^(\/|~|[a-z]:\\)/i.test(raw) && new RegExp(`\\.(${SQLITE_EXTENSIONS.join("|")})$`, "i").test(raw)
      ? raw
      : null;
  if (sqlitePath) {
    const c = newConfig("sqlite");
    c.database = sqlitePath;
    c.name = fileStem(sqlitePath);
    return { config: c, password: "" };
  }
  try {
    const u = new URL(raw);
    const scheme = u.protocol.replace(":", "");
    const driver: Driver | null = /^postgres(ql)?$/.test(scheme) ? "postgres" : /^(mysql|mariadb)$/.test(scheme) ? "mysql" : null;
    if (!driver) return null;
    const c = newConfig(driver);
    c.host = u.hostname || "127.0.0.1";
    if (u.port) c.port = Number(u.port);
    c.user = decodeURIComponent(u.username);
    c.database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    c.name = c.database || c.host;
    const ssl = u.searchParams.get("sslmode") ?? u.searchParams.get("ssl-mode");
    if (ssl) c.sslMode = /disable/i.test(ssl) ? "disable" : /require|verify/i.test(ssl) ? "require" : "prefer";
    return { config: c, password: decodeURIComponent(u.password) };
  } catch {
    return null;
  }
}

/** Inverse of parseUrl, for "Copy as URL". */
export function toUrl(c: ConnectionConfig, password?: string | null): string {
  if (c.driver === "sqlite") return `sqlite://${c.database}`;
  const scheme = c.driver === "postgres" ? "postgresql" : "mysql";
  const auth = c.user ? `${encodeURIComponent(c.user)}${password ? `:${encodeURIComponent(password)}` : ""}@` : "";
  const ssl = c.sslMode === "prefer" ? "" : c.driver === "postgres" ? `?sslmode=${c.sslMode}` : `?ssl-mode=${c.sslMode === "require" ? "REQUIRED" : "DISABLED"}`;
  return `${scheme}://${auth}${c.host}${c.port ? `:${c.port}` : ""}/${encodeURIComponent(c.database)}${ssl}`;
}

export function ConnectionForm({
  initial,
  initialPassword,
  groups,
  onClose,
  onSaved,
  onConnect,
}: {
  initial: ConnectionConfig;
  initialPassword?: string;
  groups: string[];
  onClose: () => void;
  onSaved: (c: ConnectionConfig) => void;
  onConnect: (c: ConnectionConfig, password: string | null) => void;
}) {
  const [c, setC] = useState(initial);
  const [password, setPassword] = useState(initialPassword ?? "");
  const [pwTouched, setPwTouched] = useState(!!initialPassword);
  const [sshPassword, setSshPassword] = useState("");
  const [sshPwTouched, setSshPwTouched] = useState(false);
  const [useKey, setUseKey] = useState(!!initial.ssh?.keyPath);
  const [bootstrapOpen, setBootstrapOpen] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const driver = DRIVERS.find((d) => d.id === c.driver)!;
  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => setC((p) => ({ ...p, [k]: v }));
  const ssh = c.ssh?.enabled ? c.ssh : null;
  const setSsh = (patch: Partial<SshConfig>) => setC((p) => ({ ...p, ssh: { ...(p.ssh ?? emptySsh()), ...patch } }));
  const pw = pwTouched ? password : null;
  const isFile = c.driver === "sqlite";

  const browseFile = async () => {
    const p = await api.pickPath("open", { filterName: "SQLite database", extensions: SQLITE_EXTENSIONS });
    if (p) setC((x) => ({ ...x, database: p, name: x.name || fileStem(p) }));
  };
  const newFile = async () => {
    const p = await api.pickPath("save", { defaultName: `${c.name.trim() || "database"}.sqlite`, filterName: "SQLite database", extensions: SQLITE_EXTENSIONS });
    if (!p) return;
    try {
      await api.createSqliteFile(p);
      setC((x) => ({ ...x, database: p, name: x.name || fileStem(p) }));
      setStatus({ ok: true, text: `Created ${p}` });
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    }
  };

  const finalConfig = (): ConnectionConfig => {
    const out = { ...c, name: c.name.trim() || (isFile && c.database ? fileStem(c.database) : c.database || c.host || driver.label) };
    if (out.ssh) {
      out.ssh = { ...out.ssh, keyPath: useKey ? out.ssh.keyPath : null };
      if (sshPwTouched) out.ssh.password = sshPassword;
    }
    return out;
  };

  const save = async () => {
    try {
      const saved = await api.saveConnection(finalConfig(), c.passwordMode === "keychain" ? pw : null);
      onSaved(saved);
      return saved;
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
      return null;
    }
  };

  const test = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const v = await api.testConnection(finalConfig(), pw);
      setStatus({ ok: true, text: `Connection is OK — ${driver.label} ${v}${ssh && !isFile ? " (over SSH)" : ""}` });
    } catch (e) {
      setStatus({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    const saved = await save();
    if (saved) onConnect(saved, pw);
  };

  const field = (label: string, node: React.ReactNode) => (
    <>
      <label style={{ textAlign: "right", color: "var(--text-2)" }}>{label}</label>
      {node}
    </>
  );

  return (
    <Modal title={`${driver.label} Connection`} width={540} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          connect();
        }}
        style={{ display: "grid", gridTemplateColumns: "88px 1fr", gap: "10px 10px", alignItems: "center" }}
      >
        {field(
          "Name",
          <input className="input" autoFocus value={c.name} placeholder={c.database || "My database"} onChange={(e) => set("name", e.target.value)} />,
        )}
        {field(
          "Status color",
          <div className="row" style={{ gap: 8 }}>
            {STATUS_COLORS.map((col) => (
              <button
                type="button"
                key={col || "none"}
                title={col || "None"}
                onClick={() => set("color", col)}
                style={{
                  width: 24,
                  height: 22,
                  borderRadius: 6,
                  border: c.color === col ? "2px solid var(--accent)" : "1px solid var(--control-border)",
                  background: col || "var(--control)",
                }}
              />
            ))}
            <span className="spacer" />
            <span className="muted">Tag</span>
            <select className="input" style={{ width: 120 }} value={c.tag} onChange={(e) => set("tag", e.target.value)}>
              {TAGS.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>,
        )}
        {isFile && (
          <>
            {field(
              "Database file",
              <div className="row">
                <input className="input mono" style={{ flex: 1 }} value={c.database} placeholder="~/data/app.sqlite" onChange={(e) => set("database", e.target.value)} />
                <button type="button" className="btn" onClick={browseFile}>Open…</button>
                <button type="button" className="btn" onClick={newFile} title="Create a new, empty database file">New…</button>
              </div>,
            )}
            {field(
              "Group",
              <div className="row">
                <input className="input" style={{ flex: 1 }} list="rb-groups" value={c.group} placeholder="none" onChange={(e) => set("group", e.target.value)} />
                <datalist id="rb-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
                <button type="button" className={`btn${c.bootstrap.trim() ? " on" : ""}`} onClick={() => setBootstrapOpen(true)}>
                  Bootstrap commands…
                </button>
              </div>,
            )}
          </>
        )}
        {!isFile && field(
          "Host",
          <div className="row">
            <input className="input" style={{ flex: 1 }} value={c.host} placeholder="127.0.0.1" onChange={(e) => set("host", e.target.value)} />
            <span className="muted" style={{ marginLeft: 6 }}>Port</span>
            <input
              className="input"
              style={{ width: 80 }}
              value={c.port || ""}
              placeholder={String(driver.port)}
              onChange={(e) => set("port", Number(e.target.value.replace(/\D/g, "")) || 0)}
            />
          </div>,
        )}
        {!isFile && field(
          "User",
          <div className="row">
            <input className="input" style={{ flex: 1 }} value={c.user} placeholder={driver.user} onChange={(e) => set("user", e.target.value)} />
            <span className="muted" style={{ marginLeft: 6 }}>Group</span>
            <input className="input" style={{ width: 150 }} list="rb-groups" value={c.group} placeholder="none" onChange={(e) => set("group", e.target.value)} />
            <datalist id="rb-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
          </div>,
        )}
        {!isFile && field(
          "Password",
          <div className="row">
            <input
              className="input"
              style={{ flex: 1 }}
              type="password"
              value={password}
              disabled={c.passwordMode === "ask"}
              placeholder={c.passwordMode === "ask" ? "asked on connect" : c.id && !pwTouched ? "saved in keychain" : "password"}
              onChange={(e) => {
                setPassword(e.target.value);
                setPwTouched(true);
              }}
            />
            <select className="input" style={{ width: 150 }} value={c.passwordMode} onChange={(e) => set("passwordMode", e.target.value as ConnectionConfig["passwordMode"])}>
              <option value="keychain">Store in keychain</option>
              <option value="ask">Ask every time</option>
            </select>
          </div>,
        )}
        {!isFile && field(
          "Database",
          <div className="row">
            <input className="input" style={{ flex: 1 }} value={c.database} placeholder="database name" onChange={(e) => set("database", e.target.value)} />
            <button type="button" className={`btn${c.bootstrap.trim() ? " on" : ""}`} onClick={() => setBootstrapOpen(true)}>
              Bootstrap commands…
            </button>
          </div>,
        )}
        {!isFile && field(
          "SSL mode",
          <select className="input" value={c.sslMode} onChange={(e) => set("sslMode", e.target.value as ConnectionConfig["sslMode"])}>
            <option value="disable">DISABLE</option>
            <option value="prefer">PREFERRED</option>
            <option value="require">REQUIRED (encrypt, don’t verify certificate)</option>
            <option value="verify-full">VERIFY-FULL (encrypt and verify certificate + hostname)</option>
          </select>,
        )}

        {ssh && !isFile && (
          <>
            <div className="form-section">SSH tunnel</div>
            {field(
              "Server",
              <div className="row">
                <input className="input" style={{ flex: 1 }} value={ssh.host} placeholder="bastion.example.com" onChange={(e) => setSsh({ host: e.target.value })} />
                <span className="muted" style={{ marginLeft: 6 }}>Port</span>
                <input className="input" style={{ width: 80 }} value={ssh.port || ""} placeholder="22" onChange={(e) => setSsh({ port: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
              </div>,
            )}
            {field("User", <input className="input" value={ssh.user} placeholder="ssh user" onChange={(e) => setSsh({ user: e.target.value })} />)}
            {field(
              useKey ? "Passphrase" : "Password",
              <div className="row">
                <input
                  className="input"
                  style={{ flex: 1 }}
                  type="password"
                  value={sshPassword}
                  placeholder={c.id && !sshPwTouched ? "saved in keychain (if any)" : useKey ? "key passphrase (optional)" : "ssh password"}
                  onChange={(e) => {
                    setSshPassword(e.target.value);
                    setSshPwTouched(true);
                  }}
                />
                <label className="row" style={{ whiteSpace: "nowrap" }}>
                  <input type="checkbox" checked={useKey} onChange={(e) => setUseKey(e.target.checked)} /> Use SSH key
                </label>
              </div>,
            )}
            {useKey &&
              field(
                "Private key",
                <div className="row">
                  <input className="input mono" style={{ flex: 1 }} value={ssh.keyPath ?? ""} placeholder="~/.ssh/id_ed25519" onChange={(e) => setSsh({ keyPath: e.target.value })} />
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      const p = await api.pickPath("open");
                      if (p) setSsh({ keyPath: p });
                    }}
                  >
                    Browse…
                  </button>
                </div>,
              )}
            {ssh.hostKey &&
              field(
                "Host key",
                <div className="row">
                  <span className="mono faint" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{ssh.hostKey}</span>
                  <button type="button" className="btn small" onClick={() => setSsh({ hostKey: null })}>Forget</button>
                </div>,
              )}
          </>
        )}

        <div style={{ gridColumn: "1 / 3", minHeight: 18, fontSize: 12, color: status ? (status.ok ? "var(--green)" : "var(--red)") : undefined, whiteSpace: "pre-wrap" }}>
          {busy ? <span className="muted">Testing…</span> : status?.text}
        </div>
        <div style={{ gridColumn: "1 / 3", display: "flex", gap: 8 }}>
          {!isFile && <button
            type="button"
            className={`btn${ssh ? " on" : ""}`}
            style={{ width: 90 }}
            onClick={() => setC((p) => ({ ...p, ssh: p.ssh?.enabled ? { ...p.ssh, enabled: false } : { ...(p.ssh ?? emptySsh()), enabled: true } }))}
          >
            Over SSH
          </button>}
          <button type="button" className="btn" style={{ width: 80 }} onClick={onClose}>Cancel</button>
          <span className="spacer" />
          <button type="button" className="btn" style={{ width: 80 }} onClick={async () => (await save()) && onClose()}>Save</button>
          <button type="button" className="btn" style={{ width: 80 }} disabled={busy} onClick={test}>Test</button>
          <button type="submit" className="btn primary" style={{ width: 80 }}>Connect</button>
        </div>
      </form>

      {bootstrapOpen && (
        <Modal
          title="Bootstrap commands"
          width={520}
          onClose={() => setBootstrapOpen(false)}
          footer={
            <>
              <span className="faint" style={{ fontSize: 12 }}>Run after every connect, e.g. SET statement_timeout = '30s';</span>
              <span className="spacer" />
              <button className="btn primary" onClick={() => setBootstrapOpen(false)}>Done</button>
            </>
          }
        >
          <textarea
            className="input mono"
            autoFocus
            spellCheck={false}
            value={c.bootstrap}
            onChange={(e) => set("bootstrap", e.target.value)}
            placeholder={
              c.driver === "postgres"
                ? "SET search_path TO app, public;\nSET statement_timeout = '30s';"
                : c.driver === "sqlite"
                  ? "PRAGMA journal_mode = WAL;\nATTACH DATABASE '/path/other.db' AS other;"
                  : "SET SESSION sql_mode = 'STRICT_ALL_TABLES';"
            }
            style={{ width: "100%", height: 180, padding: 8 }}
          />
        </Modal>
      )}
    </Modal>
  );
}
