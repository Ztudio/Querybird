import { useCallback, useEffect, useState } from "react";
import { Modal } from "../components/ui";
import { api, errorText, type QueryResult } from "../api";
import { DataGrid, type GridSelection } from "./DataGrid";
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
  useEffect(() => register({ reload: load }));
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
  useEffect(() => register({ reload: load }));

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
