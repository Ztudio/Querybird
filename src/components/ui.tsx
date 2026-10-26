import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Driver } from "../api";

export function Modal({
  title,
  children,
  footer,
  width = 480,
  onClose,
}: {
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-label={title}>
        {title && <h2>{title}</h2>}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export interface MenuItem {
  label?: string;
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onClick?: () => void;
  submenu?: MenuItem[];
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 6),
      y: Math.min(menu.y, window.innerHeight - r.height - 6),
    });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, onClose]);
  if (!menu) return null;
  return (
    <div ref={ref} className="ctx" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      <MenuList items={menu.items} onClose={onClose} />
    </div>
  );
}

function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <div
            key={i}
            className={`ctx-item${it.danger ? " danger" : ""}${it.disabled ? " disabled" : ""}${open === i ? " open" : ""}`}
            onMouseEnter={() => setOpen(it.submenu ? i : null)}
            onClick={() => {
              if (it.submenu) return;
              onClose();
              it.onClick?.();
            }}
          >
            <span>{it.label}</span>
            {it.kbd && <span className="kbd">{it.kbd}</span>}
            {it.submenu && <span className="kbd">▸</span>}
            {it.submenu && open === i && (
              <div className="ctx ctx-sub">
                <MenuList items={it.submenu} onClose={onClose} />
              </div>
            )}
          </div>
        ),
      )}
    </>
  );
}

export function useToast() {
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const timer = useRef<number>();
  const show = (text: string, error = false) => {
    setToast({ text, error });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), error ? 6000 : 2200);
  };
  const node = toast ? <div className={`toast${toast.error ? " error" : ""}`}>{toast.text}</div> : null;
  return { show, node };
}

export const DRIVERS: { id: Driver; label: string; short: string; color: string; port: number; user: string }[] = [
  { id: "postgres", label: "PostgreSQL", short: "Pg", color: "#2f76c8", port: 5432, user: "postgres" },
  { id: "mysql", label: "MySQL", short: "Ms", color: "#e8862a", port: 3306, user: "root" },
  { id: "sqlite", label: "SQLite", short: "Sq", color: "#4a9bc4", port: 0, user: "" },
];

export function DriverBadge({ driver, size = 26 }: { driver: Driver; size?: number }) {
  const d = DRIVERS.find((x) => x.id === driver)!;
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: d.color,
        color: "#fff",
        fontSize: size * 0.42,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "none",
        fontWeight: 500,
      }}
    >
      {d.short}
    </span>
  );
}

export const TAGS: { id: string; label: string; color: string }[] = [
  { id: "local", label: "local", color: "#3fbf5a" },
  { id: "development", label: "development", color: "#3b8cff" },
  { id: "testing", label: "testing", color: "#b06ad8" },
  { id: "staging", label: "staging", color: "#f0a030" },
  { id: "production", label: "production", color: "#ff5a52" },
];

export const tagColor = (tag: string) => TAGS.find((t) => t.id === tag)?.color ?? "var(--text-2)";

export const STATUS_COLORS = ["", "#5f6368", "#1d5fa8", "#a07040", "#2e8b46", "#8e1f1f"];

export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
export const mod = isMac ? "⌘" : "Ctrl+";

export function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
