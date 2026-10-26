import { useEffect, useState } from "react";
import type { Cell } from "../api";
import { IconSearch } from "../components/icons";
import type { Details } from "./context";

export function DetailsPanel({ details }: { details: Details | null }) {
  const [tab, setTab] = useState<"details" | "info">("details");
  const [q, setQ] = useState("");
  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());

  return (
    <div className="details">
      <div className="details-head">
        <div className="segmented">
          <button className={tab === "details" ? "active" : ""} onClick={() => setTab("details")}>Details</button>
          <button className={tab === "info" ? "active" : ""} onClick={() => setTab("info")}>Info</button>
        </div>
      </div>
      <div style={{ padding: "6px 10px" }}>
        <div className="search">
          <IconSearch />
          <input className="input" placeholder="Search for field…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="details-body">
        {tab === "details" ? (
          details?.row ? (
            <>
              {(details.selectedCount ?? 1) > 1 && <div className="faint" style={{ padding: "0 2px 8px" }}>{details.selectedCount} rows selected — showing the focused row</div>}
              {details.columns.map((c, i) =>
                match(c.name) ? (
                  <Field key={`${c.name}-${i}`} name={c.name} type={c.typeName} value={details.row![i]} editable={details.editable} onChange={(v) => details.onChange?.(i, v)} />
                ) : null,
              )}
            </>
          ) : details?.info?.length ? (
            details.info.filter(([k]) => match(k)).map(([k, v]) => <Field key={k} name={k} type="" value={v === "NULL" ? null : v} editable={false} onChange={() => {}} />)
          ) : (
            <div className="empty">No row selected</div>
          )
        ) : details?.info?.length ? (
          details.info.filter(([k]) => match(k)).map(([k, v]) => <Field key={k} name={k} type="" value={v === "NULL" ? null : v} editable={false} onChange={() => {}} />)
        ) : (
          <div className="empty">Select a table to see its info</div>
        )}
      </div>
    </div>
  );
}

function Field({ name, type, value, editable, onChange }: { name: string; type: string; value: Cell; editable: boolean; onChange: (v: Cell) => void }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  const multiline = (value?.length ?? 0) > 60 || value?.includes("\n");
  const commit = () => {
    if (draft !== (value ?? "")) onChange(draft);
  };
  return (
    <div className="field">
      <div className="field-label">
        <span>{name}</span>
        <span className="faint">{type}</span>
      </div>
      <div className="field-value">
        {multiline ? (
          <textarea
            className="input mono"
            rows={Math.min(8, Math.max(3, Math.ceil((value?.length ?? 0) / 48)))}
            readOnly={!editable}
            value={draft}
            placeholder={value === null ? "NULL" : ""}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
          />
        ) : (
          <input
            className="input mono"
            readOnly={!editable}
            value={draft}
            placeholder={value === null ? "NULL" : "EMPTY"}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setDraft(value ?? "");
            }}
          />
        )}
        {editable && (
          <button className="field-null" title="Set NULL" onClick={() => onChange(null)} disabled={value === null}>
            ∅
          </button>
        )}
      </div>
    </div>
  );
}
