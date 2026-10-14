import { useState } from "react";
import { api, errorText, type ConnectionConfig } from "../api";
import { getSettings } from "../lib/settings";
import { DriverBadge, Modal } from "./ui";

/** Backup (pg_dump / mysqldump) or restore a database, from the welcome window or a workspace. */
export function BackupDialog({
  mode,
  connections,
  initial,
  onClose,
  onDone,
}: {
  mode: "backup" | "restore";
  connections: ConnectionConfig[];
  initial?: ConnectionConfig;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [connId, setConnId] = useState(initial?.id ?? connections[0]?.id ?? "");
  const conn = connections.find((c) => c.id === connId) ?? initial;
  const [database, setDatabase] = useState(initial?.database ?? connections[0]?.database ?? "");
  const [custom, setCustom] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsPassword = conn?.passwordMode === "ask";

  const run = async () => {
    if (!conn) return;
    setError(null);
    let path: string | null;
    if (mode === "backup") {
      const ext = custom ? "dump" : "sql";
      path = await api.pickPath("save", { defaultName: `${database || conn.name}-${new Date().toISOString().slice(0, 10)}.${ext}`, filterName: ext.toUpperCase(), extensions: [ext] });
    } else {
      path = await api.pickPath("open", { filterName: "Dump", extensions: ["sql", "dump", "backup"] });
    }
    if (!path) return;
    setBusy(true);
    try {
      const pw = needsPassword ? password : null;
      const toolsDir = getSettings().toolsDir || null;
      if (mode === "backup") await api.backupDatabase(conn, pw, database, path, custom, toolsDir);
      else await api.restoreDatabase(conn, pw, database, path, toolsDir);
      onDone(mode === "backup" ? `Backed up ${database} to ${path}` : `Restored ${path} into ${database}`);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={mode === "backup" ? "Backup database" : "Restore database"}
      width={500}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className={`btn ${mode === "restore" ? "danger" : "primary"}`} disabled={!conn || !database || busy} onClick={run}>
            {busy ? (mode === "backup" ? "Backing up…" : "Restoring…") : mode === "backup" ? "Start backup..." : "Choose file & restore..."}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>Connection</label>
        <div className="row">
          {conn && <DriverBadge driver={conn.driver} size={20} />}
          <select
            className="input"
            style={{ flex: 1 }}
            value={connId}
            disabled={!!initial && connections.length <= 1}
            onChange={(e) => {
              setConnId(e.target.value);
              setDatabase(connections.find((c) => c.id === e.target.value)?.database ?? "");
            }}
          >
            {connections.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.host})</option>)}
          </select>
        </div>
        <label>Database</label>
        <input className="input mono" value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="database name" />
        {needsPassword && (
          <>
            <label>Password</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </>
        )}
        {mode === "backup" && conn?.driver === "postgres" && (
          <>
            <label>Format</label>
            <select className="input" value={custom ? "custom" : "plain"} onChange={(e) => setCustom(e.target.value === "custom")}>
              <option value="plain">Plain SQL (.sql)</option>
              <option value="custom">Custom archive (.dump, for pg_restore)</option>
            </select>
          </>
        )}
        {mode === "restore" && (
          <>
            <span />
            <div className="faint" style={{ fontSize: 12 }}>
              Statements in the file run against <b>{database || "the database"}</b>. Make sure it’s the right target —
              and only restore dumps you trust: dump files can contain client commands.
            </div>
          </>
        )}
      </div>
      {error && <pre className="mono code-box" style={{ color: "var(--red)", marginTop: 10 }}>{error}</pre>}
    </Modal>
  );
}
