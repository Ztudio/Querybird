import { useEffect, useRef, useState } from "react";
import { api, errorText, type AiAnswer, type AiStatus, type ChatGptStatus, type CodexModels, type QueryResult } from "../api";
import { Modal } from "../components/ui";
import { IconArrowUp, IconChevronDown, IconPlus, IconChat } from "../components/icons";
import { CLAUDE_MODELS, MANAGE_USAGE_URL, activeModel, aiReady, autoPickLocalCli, getSettings, updateSettings, useSettings, type Settings } from "../lib/settings";
import { ChatGptWelcome } from "../components/SettingsModal";
import { isReadOnly, writeRisk } from "../lib/sql";
import { DataGrid } from "./DataGrid";
import { useWs } from "./context";

interface Turn {
  id: number;
  question: string;
  status: "asking" | "ready" | "running" | "done" | "error";
  answer?: AiAnswer;
  /** Error from the AI provider (no SQL produced). */
  askError?: string;
  /** Error from the database when running the SQL. */
  runError?: string;
  result?: QueryResult;
  askMs?: number;
  runMs?: number;
  /** Just arrived: reveal it progressively once. */
  fresh?: boolean;
}

interface Source {
  id: string;
  label: string;
  patch: Partial<Settings>;
  available: boolean;
}

let turnSeq = 1;

/** "Ask AI" lives in the right sidebar: a question in plain language → SQL (shown) → run → results, all visible to the engineer. */
export function AskTab({ active, onOpenSettings }: { active: boolean; onOpenSettings: () => void }) {
  const ws = useWs();
  const settings = useSettings();
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [gpt, setGpt] = useState<ChatGptStatus | null>(null);
  const [confirm, setConfirm] = useState<Turn | null>(null);
  const [context, setContext] = useState<Turn | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);

  const provider = settings.aiProvider;
  const model = activeModel(settings);
  const viaChatGpt = provider === "openai" && settings.openaiAuth === "chatgpt";

  const refreshStatus = () => {
    api.aiStatus().then(setStatus).catch(() => setStatus(null));
    api.chatgptStatus().then(setGpt).catch(() => setGpt(null));
  };
  useEffect(() => {
    // First time this tab opens: fall back to a local Claude Code / Codex if nothing else is set up.
    Promise.all([api.aiStatus(), api.chatgptStatus().catch(() => null)])
      .then(([st, g]) => {
        setStatus(st);
        setGpt(g);
        autoPickLocalCli(st, g);
      })
      .catch(() => setStatus(null));
    input.current?.focus();
    const onFocus = () => refreshStatus();
    const focusInput = () => input.current?.focus();
    window.addEventListener("focus", onFocus);
    window.addEventListener("querybird:focus-ai", focusInput);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("querybird:focus-ai", focusInput);
    };
  }, []);

  const ready = aiReady(settings, status, gpt);
  const asking = turns.some((t) => t.status === "asking");
  const [gptModels, setGptModels] = useState<{ id: string; label: string }[]>([]);
  const [codex, setCodex] = useState<CodexModels | null>(null);
  useEffect(() => {
    if (settings.aiProvider === "openai" && settings.openaiAuth === "codex" && !codex) api.codexModels().then(setCodex).catch(() => {});
  }, [settings.aiProvider, settings.openaiAuth]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (viaChatGpt && gpt?.signedIn && gpt.planUsage && !gptModels.length) api.chatgptModels().then(setGptModels).catch(() => {});
  }, [viaChatGpt, gpt]); // eslint-disable-line react-hooks/exhaustive-deps

  const sources: Source[] = [
    { id: "claudeCode", label: "Claude Code (local)", patch: { aiProvider: "claude", claudeAuth: "claudeCode" }, available: !!status?.claudeCodePath },
    { id: "codex", label: "Codex (local)", patch: { aiProvider: "openai", openaiAuth: "codex" }, available: !!status?.codexPath },
    { id: "chatgpt", label: "ChatGPT", patch: { aiProvider: "openai", openaiAuth: "chatgpt" }, available: !!gpt?.signedIn && !!gpt.planUsage },
    { id: "ant", label: "Claude (Anthropic sign-in)", patch: { aiProvider: "claude", claudeAuth: "antCli" }, available: !!status?.antInstalled },
    { id: "claudeKey", label: "Claude API key", patch: { aiProvider: "claude", claudeAuth: "apiKey" }, available: !!status?.claudeKey },
    { id: "openaiKey", label: "OpenAI API key", patch: { aiProvider: "openai", openaiAuth: "apiKey" }, available: !!status?.openaiKey },
  ];
  const source =
    sources.find((x) => Object.entries(x.patch).every(([k, v]) => settings[k as keyof typeof settings] === v)) ?? sources[0];
  const sourceLabel = source.label.replace(/ API key$| \(Anthropic sign-in\)$/, "");
  const models = modelOptions(settings, gptModels, codex);
  const setModel = (id: string) => {
    if (provider === "claude") updateSettings({ claudeModel: id });
    else if (settings.openaiAuth === "codex") updateSettings({ codexModel: id });
    else if (settings.openaiAuth === "chatgpt") updateSettings({ chatgptModel: id });
    else updateSettings({ openaiModel: id });
  };

  // Follow the conversation as it grows (streamed text, results), unless the reader scrolled up.
  const stick = useRef(true);
  useEffect(() => {
    const el = log.current;
    if (!el) return;
    const onScroll = () => (stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48);
    const follow = new MutationObserver(() => stick.current && (el.scrollTop = el.scrollHeight));
    el.addEventListener("scroll", onScroll);
    follow.observe(el, { childList: true, subtree: true, characterData: true });
    return () => (el.removeEventListener("scroll", onScroll), follow.disconnect());
  }, []);

  // The composer grows with its text up to the CSS max-height, then scrolls.
  // Measure only while the tab is on screen: a hidden tab reports a height of 0.
  useEffect(() => {
    const el = input.current;
    if (!el || !active) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [question, active]);
  const update = (id: number, patch: Partial<Turn>) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  /**
   * Read-only SQL runs through the backend's enforced read-only path (single statement, READ ONLY
   * transaction, rolled back). Anything else — or anything the server refuses as a write — needs an
   * explicit confirmation, and `confirmed` is only ever set by the confirmation dialog.
   */
  const run = async (turn: Turn, confirmed = false) => {
    const sql = turn.answer?.sql;
    if (!sql) return;
    const writes = turn.answer!.modifiesData || !isReadOnly(sql);
    if (writes && !confirmed) {
      setConfirm(turn);
      return;
    }
    setConfirm(null);
    update(turn.id, { status: "running", runError: undefined });
    setSelected(turn.id);
    ws.setLoading(1);
    const started = performance.now();
    ws.log(`-- Ask AI (${turn.answer!.model}): ${turn.question.replace(/\s+/g, " ")}\n${sql}`);
    ws.addHistory(sql);
    try {
      const res = writes ? await api.execute(ws.sessionId, sql) : await api.executeReadonly(ws.sessionId, sql);
      const last = [...res].reverse().find((r) => r.columns.length) ?? res[res.length - 1];
      update(turn.id, { status: "done", result: last, runMs: performance.now() - started });
      if (writes) window.dispatchEvent(new Event("querybird:refresh-objects"));
    } catch (e) {
      update(turn.id, { status: "error", runError: errorText(e), runMs: performance.now() - started });
    } finally {
      ws.setLoading(-1);
    }
  };

  const ask = async (q = question, fixing?: Turn) => {
    const text = q.trim();
    if (!text) return;
    if (!ready) {
      onOpenSettings();
      return;
    }
    const turn: Turn = { id: turnSeq++, question: text, status: "asking" };
    setTurns((ts) => [...ts, turn]);
    setSelected(turn.id);
    if (!fixing) setQuestion("");
    stick.current = true;
    const history = turns
      .filter((t) => t.answer)
      .slice(-6)
      .map((t) => ({ question: t.question, sql: t.answer!.sql, explanation: t.answer!.explanation, error: t.runError ?? null }));
    const started = performance.now();
    try {
      const s = getSettings();
      const answer = await api.aiAsk(ws.sessionId, {
        provider: s.aiProvider,
        claudeAuth: s.claudeAuth,
        openaiAuth: s.openaiAuth,
        model: activeModel(s),
        question: text,
        history,
      });
      const next: Turn = { ...turn, status: answer.sql ? "ready" : "done", answer, askMs: performance.now() - started, fresh: true };
      update(turn.id, next);
      const readOnly = answer.sql && !answer.modifiesData && isReadOnly(answer.sql);
      if (answer.sql && readOnly && s.aiAutoRun && !ws.safeMode) run(next);
    } catch (e) {
      update(turn.id, { status: "error", askError: errorText(e), askMs: performance.now() - started });
    }
  };

  const current = turns.find((t) => t.id === selected) ?? null;
  const result = current?.result;

  return (
    <div className="ask-panel">
      <div className="ask-top">
        <div className="ask-log" ref={log}>
          {!turns.length && (
            <div className="ask-empty">
              <IconChat size={22} className="ask-empty-icon" />
              <div className="ask-empty-title">Ask your database in plain language</div>
              <div className="faint">
                Ask for data and the AI writes the SQL, which you see before it runs. Ask about the schema and it answers in plain text. Only the schema
                ({plural(ws.objects.tables.length, "table")}, {plural(ws.objects.views.length, "view")} in <b>{ws.schema}</b>) is sent — never your data.
              </div>
              <div className="ask-examples">
                {["Top 10 customers by total order value", "How many orders per status this month?", "Products that are out of stock but still active"].map((ex) => (
                  <button key={ex} className="ask-example" onClick={() => (setQuestion(ex), input.current?.focus())}>
                    <IconChat size={12} /> {ex}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.length > 0 && (
            <div className="ask-log-head">
              <button className="btn small" onClick={() => (setTurns([]), setSelected(null))}><IconPlus size={11} /> New chat</button>
            </div>
          )}
          {turns.map((t) => (
            <div key={t.id} className="ask-turn" onClick={() => setSelected(t.id)}>
              <div className="ask-bubble-row">
                <div className="ask-bubble">{t.question}</div>
              </div>
              <div className={`ask-reply${t.id === selected ? " selected" : ""}`}>
                {t.status === "asking" && <Thinking label={`Thinking with ${sourceLabel}`} />}
                {t.askError && (
                  <div className="ask-error">
                    {t.askError}
                    {t.askError.includes(MANAGE_USAGE_URL) && (
                      <div style={{ marginTop: 6 }}>
                        <button className="btn small primary" onClick={() => api.openHelpUrl(MANAGE_USAGE_URL)}>Manage usage</button>
                      </div>
                    )}
                  </div>
                )}
                {t.answer && (
                  <Answer
                    turn={t}
                    animate={!!t.fresh}
                    onRevealed={() => update(t.id, { fresh: false })}
                    footer={
                      <>
                        {t.runError && (
                          <div className="ask-error">
                            {t.runError}
                            <div style={{ marginTop: 6 }}>
                              <button
                                className="btn small"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  // The (redacted) error travels in the history; the raw text, which can contain row values, isn't sent.
                                  ask(`The previous SQL failed when it ran. Please fix it. Original question: ${t.question}`, t);
                                }}
                              >
                                Fix with AI
                              </button>
                            </div>
                          </div>
                        )}
                        <div className="ask-meta">
                          <span className="faint">
                            {t.answer.model} · {fmt(t.askMs)}
                            {t.status === "running" ? " · running…" : ""}
                            {t.result ? ` · ${t.result.columns.length ? `${t.result.rows.length.toLocaleString()} rows` : `${t.result.affected ?? 0} rows affected`} in ${fmt(t.runMs)}` : ""}
                          </span>
                          {(t.answer.modifiesData || (t.answer.sql && !isReadOnly(t.answer.sql))) && <span className="ask-badge">changes data</span>}
                          <span className="spacer" />
                          {t.answer.sql && (
                            <>
                              <button className="btn small" onClick={(e) => (e.stopPropagation(), run(t))}>{t.result || t.runError ? "Run again" : "Run"}</button>
                              <button className="btn small" onClick={(e) => (e.stopPropagation(), ws.openQuery(`-- ${t.question.replace(/\n/g, " ")}\n${t.answer!.sql};\n`, "AI query"))}>Open in editor</button>
                              <button className="btn small" onClick={(e) => (e.stopPropagation(), navigator.clipboard.writeText(t.answer!.sql), ws.toast("SQL copied"))}>Copy</button>
                            </>
                          )}
                          <button className="btn small" onClick={(e) => (e.stopPropagation(), setContext(t))}>What was sent</button>
                        </div>
                      </>
                    }
                  />
                )}
                {t.id === selected && t.status === "running" && <div className="faint ask-note">Running…</div>}
                {t.id === selected && result?.columns.length ? (
                  <div className="ask-result">
                    <DataGrid columns={result.columns} rows={result.rows} rowNumbers dataKey={`${t.id}-${t.runMs}`} />
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        <div className="ask-composer-wrap">
          <div className="ask-composer" onClick={() => input.current?.focus()}>
            <textarea
              ref={input}
              rows={1}
              value={question}
              placeholder={ready ? `Ask about ${ws.schema}…` : "Set up an AI source"}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
                  e.preventDefault();
                  ask();
                }
              }}
            />
            <div className="ask-tools" onClick={(e) => e.stopPropagation()}>
              <PillSelect
                title="Where the AI runs"
                icon={<IconChat size={12} />}
                value={source.id}
                label={source.label}
                warn={!ready}
                options={[
                  ...sources.map((x) => ({ value: x.id, label: x.available ? x.label : `${x.label} — not set up` })),
                  { value: "__settings", label: "AI settings…" },
                ]}
                onChange={(v) => {
                  if (v === "__settings") return onOpenSettings();
                  const next = sources.find((x) => x.id === v)!;
                  updateSettings(next.patch);
                  if (!next.available) onOpenSettings();
                }}
              />
              <PillSelect
                title="Model"
                value={model}
                label={modelLabel(models, model)}
                options={models.map((m) => ({ value: m.id, label: m.label }))}
                onChange={setModel}
              />
              {viaChatGpt && gpt?.planUsage && (
                <a className="ask-plan" onClick={() => api.openHelpUrl(MANAGE_USAGE_URL)}>Manage usage</a>
              )}
              <span className="spacer" />
              <label className="ask-toggle" title="Read-only SQL runs right away; anything that changes data always asks first">
                <input type="checkbox" checked={settings.aiAutoRun} onChange={(e) => updateSettings({ aiAutoRun: e.target.checked })} /> Auto-run
              </label>
              <button
                className="btn primary ask-send"
                title={ready ? `Ask (↵) · new line (⇧↵)` : "Set up an AI source"}
                aria-label="Ask"
                disabled={(!question.trim() && ready) || asking}
                onClick={() => (ready ? ask() : onOpenSettings())}
              >
                <IconArrowUp />
              </button>
            </div>
          </div>
        </div>
      </div>

      {gpt?.showWelcome && viaChatGpt && (
        <ChatGptWelcome
          onClose={() => {
            api.chatgptWelcomed();
            setGpt({ ...gpt, showWelcome: false });
          }}
        />
      )}
      {confirm && (
        <ConfirmWrite
          turn={confirm}
          sessionId={ws.sessionId}
          onCancel={() => setConfirm(null)}
          onRun={() => run(confirm, true)}
          onOpenEditor={() => (setConfirm(null), ws.openQuery(`${confirm.answer!.sql};\n`, "AI query"))}
        />
      )}
      {context?.answer && (
        <Modal title="What was sent to the AI" width={720} onClose={() => setContext(null)} footer={<><span className="spacer" /><button className="btn primary" onClick={() => setContext(null)}>Close</button></>}>
          <div className="faint" style={{ marginBottom: 6 }}>
            Model: <b>{context.answer.model}</b> · This is the exact request: system prompt (with the schema), earlier questions and SQL in this tab (errors redacted), and your question. No table rows are sent.
          </div>
          <pre className="mono code-box">{context.answer.schemaContext}</pre>
        </Modal>
      )}
    </div>
  );
}

function fmt(ms?: number) {
  if (ms == null) return "";
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Models offered for the current source; the saved choice is always kept in the list. */
function modelOptions(s: Settings, chatgpt: { id: string; label: string }[], codex: CodexModels | null): { id: string; label: string }[] {
  let list: { id: string; label: string }[];
  if (s.aiProvider === "claude") {
    list = [
      ...(s.claudeAuth === "claudeCode" ? [{ id: "", label: "Claude Code default" }] : []),
      ...CLAUDE_MODELS.map((m) => ({ id: m.id, label: m.label.replace(/^Claude /, "") })),
    ];
  } else if (s.openaiAuth === "codex") {
    // Whatever Codex itself offers right now; "default" follows its config.
    const named = codex?.models.find((m) => m.id === codex.default)?.label ?? codex?.default;
    list = [{ id: "", label: named ? `Codex default (${named})` : "Codex default" }, ...(codex?.models ?? []).map((m) => ({ id: m.id, label: m.label }))];
  } else if (s.openaiAuth === "chatgpt") {
    list = chatgpt.length ? chatgpt : [];
  } else {
    list = ["gpt-5", "gpt-5-mini", "gpt-4.1"].map((id) => ({ id, label: id }));
  }
  const current = activeModel(s);
  if (!list.some((m) => m.id === current)) list = [{ id: current, label: current || "Default model" }, ...list];
  return list;
}

/** Short label for the pill: "Opus 5.5" rather than "Opus 5.5 (default)". */
function modelLabel(models: { id: string; label: string }[], id: string): string {
  const m = models.find((x) => x.id === id);
  return (m?.label ?? (id || "Default model")).replace(/\s*\(.*\)$/, "");
}

/** A compact pill that opens the native menu (a transparent <select> covers it). */
function PillSelect({
  title,
  icon,
  value,
  label,
  options,
  onChange,
  warn,
}: {
  title: string;
  icon?: React.ReactNode;
  value: string;
  label: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  warn?: boolean;
}) {
  return (
    <label className={`ask-pill${warn ? " warn" : ""}`} title={title}>
      {icon}
      <span className="ask-pill-text">{label}</span>
      <IconChevronDown size={9} />
      <select value={value} aria-label={title} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

/** Waiting state: shimmering label (static under reduced motion) plus elapsed seconds as the static cue. */
function Thinking({ label }: { label: string }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = window.setInterval(() => setSecs(Math.floor((Date.now() - started) / 1000)), 250);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="ask-thinking" role="status">
      <span className="ask-shimmer">{label}…</span>
      <span className="faint ask-secs">{secs}s</span>
    </div>
  );
}

const prefersReducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Reveals `text` progressively (about 1s at most), then calls `onDone`. */
function useReveal(text: string, animate: boolean, onDone: () => void): number {
  const [shown, setShown] = useState(animate && !prefersReducedMotion() ? 0 : text.length);
  useEffect(() => {
    if (shown >= text.length) {
      if (animate) onDone();
      return;
    }
    const total = Math.min(1000, Math.max(300, text.length * 6));
    const started = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const n = Math.ceil(text.length * Math.min(1, (now - started) / total));
      setShown(n);
      if (n < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (animate && shown >= text.length) onDone();
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  return shown;
}

/** The AI's reply: explanation, then SQL, revealed as one stream with a caret; actions appear once it's done. */
function Answer({ turn, animate, onRevealed, footer }: { turn: Turn; animate: boolean; onRevealed: () => void; footer: React.ReactNode }) {
  const a = turn.answer!;
  const expl = a.explanation ?? "";
  const sql = a.sql ? `${a.sql};` : "";
  const shown = useReveal(expl + sql, animate, onRevealed);
  const done = shown >= expl.length + sql.length;
  const caret = !done && <span className="ask-caret" aria-hidden />;
  return (
    <>
      {expl && (
        <div className="ask-expl">
          {expl.slice(0, shown)}
          {shown <= expl.length && caret}
        </div>
      )}
      {sql ? (
        shown > expl.length && (
          <pre className="mono ask-sql">
            {sql.slice(0, shown - expl.length)}
            {caret}
          </pre>
        )
      ) : (
        done && !expl && <div className="faint">No answer came back. Try rephrasing.</div>
      )}
      {done && footer}
    </>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The only way AI-written SQL that changes data gets to run. Shows what it will touch first (a
 * read-only COUNT for DELETE/UPDATE — the statement itself never runs early), and statements that
 * can't be undone or hit every row need an explicit acknowledgement. Cancel has focus, so Enter
 * never runs a write.
 */
function ConfirmWrite({ turn, sessionId, onCancel, onRun, onOpenEditor }: { turn: Turn; sessionId: string; onCancel: () => void; onRun: () => void; onOpenEditor: () => void }) {
  const sql = turn.answer!.sql;
  const risk = writeRisk(sql);
  const [count, setCount] = useState<{ n?: string; error?: boolean } | null>(risk.countSql ? null : { error: true });
  const [ack, setAck] = useState(false);
  useEffect(() => {
    if (!risk.countSql) return;
    api
      .executeReadonly(sessionId, risk.countSql)
      .then(([r]) => setCount({ n: r?.rows[0]?.[0] ?? undefined }))
      .catch(() => setCount({ error: true }));
  }, [sql]); // eslint-disable-line react-hooks/exhaustive-deps

  const verb = { delete: "delete", update: "change", insert: "insert", drop: "drop", truncate: "empty", alter: "alter", other: "change" }[risk.kind];
  const rows = count?.n != null ? Number(count.n) : null;
  const impact =
    risk.kind === "drop"
      ? `Permanently removes ${risk.target ?? "the object"} and everything in it.`
      : risk.kind === "truncate"
        ? `Deletes every row in ${risk.target ?? "the table"}.`
        : risk.kind === "delete" || risk.kind === "update"
          ? count === null
            ? "Counting the rows it would " + verb + "…"
            : rows != null
              ? `Would ${verb} ${rows.toLocaleString()} row${rows === 1 ? "" : "s"}${risk.noWhere ? ` — every row in ${risk.target}` : ""}.`
              : risk.noWhere
                ? `Has no WHERE clause, so it ${verb}s every row in ${risk.target ?? "the table"}.`
                : "Couldn't count the affected rows in advance — check the WHERE clause carefully."
          : risk.kind === "alter"
            ? "Changes the table’s structure."
            : "Changes data or structure.";
  const needsAck = risk.destructive || (rows != null && rows > 1000);
  const title = risk.destructive ? "Destructive statement — review before running" : "This statement changes data — run it?";

  return (
    <Modal
      title={title}
      width={640}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onOpenEditor}>Open in SQL Editor instead</button>
          <span className="spacer" />
          <button className="btn" autoFocus onClick={onCancel}>Cancel</button>
          <button className="btn danger" disabled={(needsAck && !ack) || (count === null && !!risk.countSql)} onClick={onRun}>
            {risk.kind === "delete" && rows != null ? `Delete ${rows.toLocaleString()} row${rows === 1 ? "" : "s"}` : "Run"}
          </button>
        </>
      }
    >
      <div className="confirm-write">
        {turn.answer!.explanation && <div>{turn.answer!.explanation}</div>}
        <div className={`confirm-impact${risk.destructive || (rows ?? 0) > 1000 ? " danger" : ""}`} role="status">
          {impact}
        </div>
        <pre className="mono code-box">{sql};</pre>
        {needsAck && (
          <label className="row confirm-ack">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            {risk.kind === "drop" || risk.kind === "truncate" || risk.kind === "alter"
              ? "I understand this can’t be undone."
              : `I understand this ${verb}s ${rows != null ? rows.toLocaleString() : "every"} row${rows === 1 ? "" : "s"} and can’t be undone without a backup.`}
          </label>
        )}
      </div>
    </Modal>
  );
}
