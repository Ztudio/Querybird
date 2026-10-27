import { useEffect, useRef, useState } from "react";

interface Tip {
  text: string;
  keys: string | null;
  x: number;
  y: number;
  below: boolean;
  instant: boolean;
}

const DELAY = 450;
/** After a tooltip closes, hovering a neighbour within this window opens its tooltip with no delay and no animation. */
const WARM = 400;
// "New SQL query (⌘T)" → label + key chip
const KEYS = /^(.*?)\s*\(((?:[⌘⌃⌥⇧]|Ctrl|Alt|Shift)[^()]*)\)$/;

/**
 * Replaces the slow, unstyled native `title` tooltip everywhere. Any element with a `title` gets a
 * proper tooltip (and an aria-label when it has no text of its own, so icon buttons stay named).
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<number>(0);
  const lastClosed = useRef(0);
  const current = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      current.current = null;
      setTip((t) => {
        if (t) lastClosed.current = Date.now();
        return null;
      });
    };

    const adopt = (el: HTMLElement) => {
      const title = el.getAttribute("title");
      if (title !== null) {
        el.removeAttribute("title");
        if (title) {
          el.dataset.tip = title;
          if (!el.hasAttribute("aria-label") && !el.textContent?.trim()) el.setAttribute("aria-label", title.replace(/\s*\([^()]*\)$/, ""));
        } else delete el.dataset.tip;
      }
      return el.dataset.tip ?? "";
    };

    const show = (el: HTMLElement, text: string) => {
      const r = el.getBoundingClientRect();
      const m = text.match(KEYS);
      const below = r.bottom + 40 < window.innerHeight;
      setTip({
        text: m ? m[1] : text,
        keys: m ? m[2] : null,
        x: r.left + r.width / 2,
        y: below ? r.bottom + 6 : r.top - 6,
        below,
        instant: Date.now() - lastClosed.current < WARM,
      });
    };

    const enter = (e: Event) => {
      const target = e.target as HTMLElement | null;
      const el = target?.closest?.("[title],[data-tip]") as HTMLElement | null;
      if (!el || el === current.current) return;
      const text = adopt(el);
      hide();
      if (!text) return;
      current.current = el;
      const warm = Date.now() - lastClosed.current < WARM;
      if (warm) show(el, text);
      else timer.current = window.setTimeout(() => show(el, text), DELAY);
    };
    const leave = (e: Event) => {
      const rel = (e as MouseEvent).relatedTarget as Node | null;
      if (current.current && rel && current.current.contains(rel)) return;
      hide();
    };
    const focus = (e: FocusEvent) => {
      const t = e.target as HTMLElement;
      if (!t.matches?.(":focus-visible")) return;
      const el = t.closest("[title],[data-tip]") as HTMLElement | null;
      if (!el) return;
      const text = adopt(el);
      if (text) {
        current.current = el;
        show(el, text);
      }
    };

    document.addEventListener("mouseover", enter, true);
    document.addEventListener("mouseout", leave, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", hide, true);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      hide();
      document.removeEventListener("mouseover", enter, true);
      document.removeEventListener("mouseout", leave, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", hide, true);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  useEffect(() => {
    if (!tip || !ref.current) return setShift(0);
    const w = ref.current.offsetWidth;
    const left = tip.x - w / 2;
    setShift(Math.max(8 - left, Math.min(0, window.innerWidth - 8 - (left + w))));
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={ref}
      role="tooltip"
      className={`tooltip${tip.instant ? " instant" : ""}`}
      style={{
        left: tip.x,
        top: tip.y,
        transform: `translate(calc(-50% + ${shift}px), ${tip.below ? "0" : "-100%"})`,
        transformOrigin: `${50 - (shift / (ref.current?.offsetWidth || 1)) * 100}% ${tip.below ? "0" : "100%"}`,
      }}
    >
      {tip.text}
      {tip.keys && <kbd>{tip.keys}</kbd>}
    </div>
  );
}
