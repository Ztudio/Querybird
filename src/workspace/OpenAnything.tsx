import { useMemo, useState } from "react";
import { IconFunction, IconQuery, IconSearch, IconTable, IconView } from "../components/icons";
import { Modal } from "../components/ui";
import { useWs } from "./context";
import type { SavedQuery } from "./Sidebar";

/** Subsequence fuzzy match; lower score is better. */
export function fuzzy(needle: string, hay: string): number | null {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  const idx = h.indexOf(n);
  if (idx >= 0) return idx;
  let j = 0;
  let gaps = 0;
  for (let i = 0; i < h.length && j < n.length; i++) {
    if (h[i] === n[j]) j++;
    else if (j > 0) gaps++;
  }
  return j === n.length ? 100 + gaps : null;
}

export function OpenAnything({ saved, onClose }: { saved: SavedQuery[]; onClose: () => void }) {
  const ws = useWs();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const items = useMemo(() => {
    const all = [
      ...ws.objects.tables.map((n) => ({ kind: "table" as const, name: n })),
      ...ws.objects.views.map((n) => ({ kind: "view" as const, name: n })),
      ...ws.objects.functions.map((n) => ({ kind: "function" as const, name: n })),
      ...saved.map((s) => ({ kind: "query" as const, name: s.name, sql: s.sql })),
    ];
    return all
      .map((it) => ({ it, score: fuzzy(q, it.name) }))
      .filter((x) => x.score !== null)
      .sort((a, b) => a.score! - b.score! || a.it.name.length - b.it.name.length)
      .slice(0, 60)
      .map((x) => x.it);
  }, [q, ws.objects, saved]);

  const open = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    if (it.kind === "query") ws.openQuery(it.sql, it.name);
    else if (it.kind !== "function") ws.openTable(ws.schema, it.name, { newTab: true });
  };

  return (
    <Modal width={520} onClose={onClose}>
      <div className="search">
        <IconSearch />
        <input
          className="input"
          autoFocus
          style={{ height: 32, fontSize: 15 }}
          placeholder="Open table, view or saved query…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(items.length - 1, s + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === "Enter") open(sel);
          }}
        />
      </div>
      <div className="anything-list">
        {items.map((it, i) => (
          <div key={`${it.kind}:${it.name}`} className={`tree-item${i === sel ? " active" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
            {it.kind === "table" ? <IconTable /> : it.kind === "view" ? <IconView /> : it.kind === "function" ? <IconFunction /> : <IconQuery />}
            <span className="tree-label">{it.name}</span>
            <span className="faint" style={{ marginLeft: "auto", fontSize: 11 }}>{it.kind}</span>
          </div>
        ))}
        {!items.length && <div className="empty">Nothing matches “{q}”</div>}
      </div>
    </Modal>
  );
}
