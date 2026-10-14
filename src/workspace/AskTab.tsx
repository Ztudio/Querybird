import { useEffect, useRef, useState } from "react";
import { api, errorText, type AiAnswer, type AiStatus, type ChatGptStatus, type QueryResult } from "../api";
import { Modal, mod } from "../components/ui";
import { MANAGE_USAGE_URL, activeModel, getSettings, updateSettings, useSettings } from "../lib/settings";
import { ChatGptWelcome } from "../components/SettingsModal";
import { isReadOnly } from "../lib/sql";
import { DataGrid, type GridSelection } from "./DataGrid";
import { useWs, type Details, type TabApi } from "./context";

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
}

let turnSeq = 1;

/** "Ask AI": a question in plain language → SQL (shown) → run → results, all visible to the engineer. */
export function AskTab({
  active,
  onDetails,
  register,
  onOpenSettings,
}: {
  active: boolean;
  onDetails: (d: Details | null) => void;
  register: (a: TabApi) => void;
  onOpenSettings: () => void;
}) {
  const ws = useWs();
  const settings = useSettings();
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [gpt, setGpt] = useState<ChatGptStatus | null>(null);
  const [confirm, setConfirm] = useState<Turn | null>(null);
  const [context, setContext] = useState<Turn | null>(null);
  const [sel, setSel] = useState<GridSelection>({ rows: [], focus: null });
  const [split, setSplit] = useState(0.5);
  const input = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);

  const provider = settings.aiProvider;
  const model = activeModel(settings);
  const viaChatGpt = provider === "openai" && settings.openaiAuth === "chatgpt";

  const refreshStatus = () => {
    api.aiStatus().then(setStatus).catch(() => setStatus(null));
    api.chatgptStatus().then(setGpt).catch(() => setGpt(null));
  };
  useEffect(() => {
    refreshStatus();
    input.current?.focus();
    const onFocus = () => refreshStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const ready =
    !!status &&
    (viaChatGpt
      ? !!gpt?.signedIn && gpt.planUsage && !!model
      : provider === "openai"
        ? status.openaiKey
        : settings.claudeAuth === "antCli"
          ? status.antInstalled
          : status.claudeKey);
  const authLabel =
    viaChatGpt
      ? gpt?.signedIn
        ? gpt.planUsage
          ? `ChatGPT${gpt.email ? ` · ${gpt.email}` : ""}`
          : "ChatGPT plan usage not granted"
        : "not signed in with ChatGPT"
      : provider === "openai"
      ? status?.openaiKey
        ? "OpenAI API key"
        : "not set up"
      : settings.claudeAuth === "antCli"
        ? status?.antInstalled
          ? "Signed in with Anthropic (ant CLI)"
          : "ant CLI not installed"
        : status?.claudeKey
          ? "Anthropic API key"
          : "not set up";

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
    setTimeout(() => log.current && (log.current.scrollTop = log.current.scrollHeight), 0);
    const history = turns
      .filter((t) => t.answer?.sql)
      .slice(-6)
      .map((t) => ({ question: t.question, sql: t.answer!.sql, error: t.runError ?? null }));
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
      const next: Turn = { ...turn, status: answer.sql ? "ready" : "done", answer, askMs: performance.now() - started };
      update(turn.id, next);
      const readOnly = answer.sql && !answer.modifiesData && isReadOnly(answer.sql);
      if (answer.sql && readOnly && s.aiAutoRun && !ws.safeMode) run(next);
    } catch (e) {
      update(turn.id, { status: "error", askError: errorText(e), askMs: performance.now() - started });
    }
  };

  useEffect(() => {
    register({
      // Reload re-runs only read-only answers; writes always go back through the confirmation.
      reload: () => {
        const t = turns.find((x) => x.id === selected);
        if (t?.answer?.sql && !t.answer.modifiesData && isReadOnly(t.answer.sql)) run(t);
      },
      runCurrent: () => ask(),
    });
  });

  const current = turns.find((t) => t.id === selected) ?? null;
  const result = current?.result;

  useEffect(() => {
    if (!active) return;
    const r = sel.focus?.r;
    onDetails(result && r != null && result.rows[r] ? { columns: result.columns, row: result.rows[r], editable: false } : { columns: [], row: null, editable: false });
  }, [active, sel, result]); // eslint-disable-line react-hooks/exhaustive-deps

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = body.current!.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => setSplit(Math.min(0.85, Math.max(0.2, (ev.clientY - box.top) / box.height)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="tab-body" ref={body}>
      <div className="ask-top" style={{ height: `${split * 100}%` }}>
        <div className="ask-head">
          <div className="segmented">
            <button className={provider === "claude" ? "active" : ""} onClick={() => updateSettings({ aiProvider: "claude" })}>Claude</button>
            <button className={provider === "openai" ? "active" : ""} onClick={() => updateSettings({ aiProvider: "openai" })}>OpenAI</button>
          </div>
          <span className="mono faint" style={{ fontSize: 11.5 }}>{model}</span>
          <span className={`ask-auth${ready ? " ok" : ""}`} onClick={onOpenSettings} title="AI settings">
            ● {authLabel}
          </span>
          {viaChatGpt && gpt?.planUsage && (
            <span className="ask-plan">
              Using ChatGPT plan · <a onClick={() => api.openHelpUrl(MANAGE_USAGE_URL)}>Manage usage</a>
            </span>
          )}
          <span className="spacer" />
          <label className="row faint" style={{ fontSize: 12 }} title="Read-only SQL runs right away; anything that changes data always asks first">
            <input type="checkbox" checked={settings.aiAutoRun} onChange={(e) => updateSettings({ aiAutoRun: e.target.checked })} /> Auto-run read-only SQL
          </label>
          <button className="btn small" disabled={!turns.length} onClick={() => (setTurns([]), setSelected(null))}>Clear</button>
        </div>

        <div className="ask-log" ref={log}>
          {!turns.length && (
            <div className="ask-empty">
              <div className="ask-empty-title">Ask your database in plain language</div>
              <div className="faint">
                The AI writes the SQL, Querybird shows it to you, runs it, and displays the result. Only the schema
                ({ws.objects.tables.length} tables, {ws.objects.views.length} views in <b>{ws.schema}</b>) is sent — never your data.
              </div>
              <div className="ask-examples">
                {["Top 10 customers by total order value", "How many orders per status this month?", "Products that are out of stock but still active"].map((ex) => (
                  <button key={ex} className="btn small" onClick={() => setQuestion(ex)}>{ex}</button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t) => (
            <div key={t.id} className={`ask-turn${t.id === selected ? " selected" : ""}`} onClick={() => setSelected(t.id)}>
              <div className="ask-q">{t.question}</div>
              {t.status === "asking" && <div className="faint">Writing SQL with {provider === "claude" ? "Claude" : viaChatGpt ? "ChatGPT" : "OpenAI"}…</div>}
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
                <>
                  {t.answer.explanation && <div className="ask-expl">{t.answer.explanation}</div>}
                  {t.answer.sql ? (
                    <pre className="mono ask-sql">{t.answer.sql};</pre>
                  ) : (
                    <div className="faint">No SQL was generated for this question.</div>
                  )}
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
                        <button className="btn small" onClick={(e) => (e.stopPropagation(), ws.openQuery(`-- ${t.question.replace(/\n/g, " ")}\n${t.answer!.sql};\n`, "AI query"))}>Open in SQL Editor</button>
                        <button className="btn small" onClick={(e) => (e.stopPropagation(), navigator.clipboard.writeText(t.answer!.sql))}>Copy SQL</button>
                      </>
                    )}
                    <button className="btn small" onClick={(e) => (e.stopPropagation(), setContext(t))}>What was sent</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="ask-input">
          <textarea
            ref={input}
            className="input"
            rows={2}
            value={question}
            placeholder={ready ? `Ask about ${ws.schema}… e.g. “revenue per country, highest first”  (${mod}↵ to ask)` : "Set up Claude or OpenAI to start (click the status above)"}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
                e.preventDefault();
                ask();
              }
            }}
          />
          <button className="btn primary" disabled={!question.trim() || turns.some((t) => t.status === "asking")} onClick={() => ask()}>
            {ready ? "Ask" : "Set up AI…"}
          </button>
        </div>
      </div>

      <div className="splitter-h" onMouseDown={startDrag} />

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {result?.columns.length ? (
          <DataGrid columns={result.columns} rows={result.rows} rowNumbers dataKey={`${current!.id}-${current!.runMs}`} onSelectionChange={setSel} />
        ) : (
          <div className="empty faint">
            {current?.status === "running" ? "Running…" : current?.result ? `${current.result.affected ?? 0} rows affected` : current?.runError ? "The query failed — see the message above." : "Results appear here"}
          </div>
        )}
        <div className="bottom-bar">
          <span className="muted">Ask AI</span>
          <span className="spacer" />
          <span className="muted status-text">{current?.question ? `“${current.question.slice(0, 80)}${current.question.length > 80 ? "…" : ""}”` : ""}</span>
          <span className="spacer" />
          <span className="muted">{result?.columns.length ? `${result.rows.length.toLocaleString()} rows` : ""}</span>
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
        <Modal
          title="This statement changes data or structure — run it?"
          width={620}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn" onClick={() => ws.openQuery(`${confirm.answer!.sql};\n`, "AI query")}>Open in SQL Editor instead</button>
              <span className="spacer" />
              <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="btn danger" onClick={() => run(confirm, true)}>Run</button>
            </>
          }
        >
          <div style={{ marginBottom: 8 }}>{confirm.answer?.explanation}</div>
          <pre className="mono code-box">{confirm.answer?.sql};</pre>
        </Modal>
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
