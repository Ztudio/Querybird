import { useEffect, useMemo, useState } from "react";
import { api, errorText, type Cell, type TableStructure } from "../api";
import { IconPlus } from "../components/icons";
import { Modal, mod } from "../components/ui";
import { draftFromColumn, draftFromIndex, structureStatements, type ColumnDraft, type IndexDraft } from "../lib/ddl";
import { DataGrid } from "./DataGrid";
import { useWs, type TabApi } from "./context";

const COL_FIELDS = ["#", "column_name", "data_type", "is_nullable", "key", "foreign_key", "column_default", "extra", "comment"] as const;
const IDX_FIELDS = ["index_name", "index_algorithm", "is_unique", "is_primary", "column_name", "condition"] as const;
const EDITABLE_COL = new Set(["column_name", "data_type", "is_nullable", "column_default", "comment"]);
const EDITABLE_IDX = new Set(["index_name", "is_unique", "column_name"]);
const yes = (v: Cell) => /^(y|yes|true|1|t)$/i.test((v ?? "").trim());

/** Editable Structure view: change columns and indexes, then review and commit the ALTERs. */
export function StructureEditor({
  schema,
  table,
  isView,
  structure,
  onReload,
  register,
  onPending,
}: {
  schema: string;
  table: string;
  isView: boolean;
  structure: TableStructure | null;
  onReload: () => Promise<void>;
  register: (a: TabApi) => void;
  onPending: (n: number) => void;
}) {
  const ws = useWs();
  const [cols, setCols] = useState<ColumnDraft[]>([]);
  const [idx, setIdx] = useState<IndexDraft[]>([]);
  const [review, setReview] = useState<string[] | null>(null);
  const [ddl, setDdl] = useState<string | null>(null);

  const reset = () => {
    setCols(structure?.columns.map(draftFromColumn) ?? []);
    setIdx(structure?.indexes.map(draftFromIndex) ?? []);
  };
  useEffect(reset, [structure]); // eslint-disable-line react-hooks/exhaustive-deps

  const statements = useMemo(() => structureStatements(ws.driver, schema, table, cols, idx), [ws.driver, schema, table, cols, idx]);
  useEffect(() => onPending(statements.length), [statements.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = async () => {
    if (!statements.length) return;
    setReview(statements);
  };
  const run = async () => {
    ws.setLoading(1);
    try {
      // Postgres DDL is transactional, so the batch is all-or-nothing there.
      const done = await api.runStatements(ws.sessionId, statements, ws.driver !== "mysql");
      done.forEach(ws.log);
      setReview(null);
      ws.toast(`${done.length} structure change${done.length === 1 ? "" : "s"} applied`);
      await onReload();
      window.dispatchEvent(new Event("querybird:refresh-objects"));
    } catch (e) {
      ws.toast(errorText(e), true);
    } finally {
      ws.setLoading(-1);
    }
  };

  useEffect(() => {
    register({ commit, discard: reset, preview: commit, reload: onReload });
  });

  if (!structure) return <div className="empty">Loading…</div>;

  const colRows: Cell[][] = cols.map((d, i) => [
    String(i + 1),
    d.name,
    d.dataType,
    d.nullable ? "YES" : "NO",
    d.original?.isPrimary ? "PRI" : d.original?.foreign ? "FK" : null,
    d.original?.foreign ? `${d.original.foreign.table}(${d.original.foreign.column})` : null,
    d.default,
    d.original?.extra ?? null,
    d.comment,
  ]);
  const idxRows: Cell[][] = idx.map((d) => [d.name, d.original?.algorithm ?? "BTREE", d.unique ? "TRUE" : "FALSE", d.original?.primary ? "TRUE" : "FALSE", d.columns, d.original?.condition ?? null]);

  const editCol = (r: number, c: number, v: Cell) => {
    const field = COL_FIELDS[c];
    if (!EDITABLE_COL.has(field) || isView) return;
    setCols((all) =>
      all.map((d, i) => {
        if (i !== r) return d;
        switch (field) {
          case "column_name":
            return { ...d, name: v ?? "" };
          case "data_type":
            return { ...d, dataType: v ?? "" };
          case "is_nullable":
            return { ...d, nullable: yes(v) };
          case "column_default":
            return { ...d, default: v === "" ? null : v };
          default:
            return { ...d, comment: v === "" ? null : v };
        }
      }),
    );
  };
  const editIdx = (r: number, c: number, v: Cell) => {
    const field = IDX_FIELDS[c];
    if (!EDITABLE_IDX.has(field) || isView) return;
    setIdx((all) =>
      all.map((d, i) =>
        i !== r ? d : field === "index_name" ? { ...d, name: v ?? "" } : field === "is_unique" ? { ...d, unique: yes(v) } : { ...d, columns: v ?? "" },
      ),
    );
  };
  const addColumn = () =>
    setCols((c) => [...c, { original: null, name: `column_${c.length + 1}`, dataType: ws.driver === "mysql" ? "varchar(255)" : "text", nullable: true, default: null, comment: null, dropped: false }]);
  const addIndex = () => setIdx((i) => [...i, { original: null, name: `${table}_idx_${i.length + 1}`, columns: cols[0]?.name ?? "", unique: false, dropped: false }]);
  const toggleDrop = <T extends { original: unknown; dropped: boolean }>(list: T[], rows: number[]) =>
    list.flatMap((d, i) => (!rows.includes(i) ? [d] : d.original ? [{ ...d, dropped: !d.dropped }] : []));

  const colChanged = (r: number, c: number) => {
    const d = cols[r];
    const o = d?.original;
    if (!o || d.dropped) return false;
    const f = COL_FIELDS[c];
    return (
      (f === "column_name" && d.name !== o.name) ||
      (f === "data_type" && d.dataType !== o.dataType) ||
      (f === "is_nullable" && d.nullable !== o.nullable) ||
      (f === "column_default" && (d.default ?? null) !== (o.default ?? null)) ||
      (f === "comment" && (d.comment ?? null) !== (o.comment ?? null))
    );
  };

  return (
    <div className="structure">
      <div className="structure-head">
        <span>Columns</span>
        <span className="faint" style={{ fontSize: 11.5 }}>double-click a cell to edit · {mod}⌫ drops · {mod}S reviews &amp; applies</span>
        <span className="spacer" />
        <button className="btn small" disabled={isView} onClick={addColumn}><IconPlus size={10} /> Column</button>
      </div>
      <div className="structure-pane" style={{ flex: 3 }}>
        <DataGrid
          columns={COL_FIELDS.map((name) => ({ name, typeName: name === "#" ? "int" : "text" }))}
          rows={colRows}
          dataKey={`c${structure.columns.length}-${structure.columns.map((c) => c.name).join()}`}
          editable={!isView}
          onEdit={editCol}
          rowState={(r) => (!cols[r]?.original ? "inserted" : cols[r].dropped ? "deleted" : undefined)}
          cellEdited={colChanged}
          onDeleteRows={(rows) => setCols((c) => toggleDrop(c, rows))}
          onContextMenu={(e, r) =>
            ws.setMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                { label: "Add column", disabled: isView, onClick: addColumn },
                { label: cols[r]?.nullable ? "Make NOT NULL" : "Allow NULL", disabled: isView, onClick: () => editCol(r, 3, cols[r].nullable ? "NO" : "YES") },
                { label: "Copy name", onClick: () => navigator.clipboard.writeText(cols[r]?.name ?? "") },
                { separator: true },
                { label: cols[r]?.dropped ? "Restore column" : "Drop column", danger: !cols[r]?.dropped, disabled: isView, onClick: () => setCols((c) => toggleDrop(c, [r])) },
              ],
            })
          }
        />
      </div>
      <div className="structure-head">
        <span>Indexes</span>
        <span className="spacer" />
        <button className="btn small" disabled={isView} onClick={addIndex}><IconPlus size={10} /> Index</button>
        <button className="btn small" onClick={async () => setDdl(await api.tableDdl(ws.sessionId, schema, table).catch(errorText))}>DDL</button>
        <button className="btn small" disabled={!statements.length} onClick={reset}>Discard</button>
        <button className="btn small primary" disabled={!statements.length} onClick={commit}>Review &amp; Commit</button>
      </div>
      <div className="structure-pane" style={{ flex: 2 }}>
        <DataGrid
          columns={IDX_FIELDS.map((name) => ({ name, typeName: "text" }))}
          rows={idxRows}
          dataKey={`i${structure.indexes.length}-${structure.indexes.map((i) => i.name).join()}`}
          editable={!isView}
          onEdit={editIdx}
          rowState={(r) => (!idx[r]?.original ? "inserted" : idx[r].dropped ? "deleted" : undefined)}
          onDeleteRows={(rows) => setIdx((i) => toggleDrop(i, rows))}
          onContextMenu={(e, r) =>
            ws.setMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                { label: "Add index", disabled: isView, onClick: addIndex },
                { label: idx[r]?.dropped ? "Restore index" : "Drop index", danger: !idx[r]?.dropped, disabled: isView, onClick: () => setIdx((i) => toggleDrop(i, [r])) },
              ],
            })
          }
        />
      </div>

      {review && (
        <Modal
          title={`Apply ${review.length} structure change${review.length === 1 ? "" : "s"} to ${table}?`}
          width={680}
          onClose={() => setReview(null)}
          footer={
            <>
              <button className="btn" onClick={() => navigator.clipboard.writeText(review.join("\n"))}>Copy SQL</button>
              <span className="faint" style={{ fontSize: 11.5 }}>
                {ws.driver === "postgres"
                  ? "Runs in one transaction."
                  : ws.driver === "sqlite"
                    ? "Runs in one transaction. SQLite can rename, add and drop columns; changing a column's type, NULL or default needs the table rebuilt (edit the CREATE TABLE in a SQL tab)."
                    : "MySQL applies DDL immediately; statements run in order."}
              </span>
              <span className="spacer" />
              <button className="btn" onClick={() => setReview(null)}>Cancel</button>
              <button className="btn primary" onClick={run}>Commit</button>
            </>
          }
        >
          <pre className="mono code-box">{review.join("\n")}</pre>
        </Modal>
      )}
      {ddl !== null && (
        <Modal title={`${table} — DDL`} width={680} onClose={() => setDdl(null)} footer={<><button className="btn" onClick={() => navigator.clipboard.writeText(ddl)}>Copy</button><span className="spacer" /><button className="btn primary" onClick={() => setDdl(null)}>Close</button></>}>
          <pre className="mono code-box">{ddl}</pre>
        </Modal>
      )}
    </div>
  );
}

