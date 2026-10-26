import { useEffect, useState } from "react";
import { api, errorText, type AiStatus, type ChatGptStatus, type CodexModels } from "../api";
import { CLAUDE_MODELS, DEFAULT_SETTINGS, MANAGE_USAGE_URL, getSettings, updateSettings, useSettings } from "../lib/settings";
import { Modal } from "./ui";

type SettingsTab = "general" | "editor" | "data" | "tools" | "ai";

export function SettingsModal({ onClose, initialTab = "general" }: { onClose: () => void; initialTab?: SettingsTab }) {
  const s = useSettings();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const check = (label: string, key: "uppercaseKeywords" | "closeBrackets" | "alternatingRows" | "restoreTabs" | "confirmDelete") => (
    <label className="row" style={{ gap: 7 }}>
      <input type="checkbox" checked={s[key]} onChange={(e) => updateSettings({ [key]: e.target.checked })} /> {label}
    </label>
  );
  return (
    <Modal
      title="Settings"
      width={540}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => updateSettings(DEFAULT_SETTINGS)}>Restore Defaults</button>
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>Done</button>
        </>
      }
    >
      <div className="segmented" style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
        {(
          [
            ["general", "General"],
            ["editor", "SQL Editor"],
            ["data", "Table Data"],
            ["tools", "Backup tools"],
            ["ai", "AI"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <div className="form-grid">
        {tab === "general" && (
          <>
            <label>Theme</label>
            <select className="input" value={s.theme} onChange={(e) => updateSettings({ theme: e.target.value as typeof s.theme })}>
              <option value="system">Auto (system)</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
            <label>{navigator.userAgent.includes("Mac") ? "⌘T" : "Ctrl+T"} opens</label>
            <select className="input" value={s.cmdTOpens} onChange={(e) => updateSettings({ cmdTOpens: e.target.value as typeof s.cmdTOpens })}>
              <option value="query">SQL Query Editor tab</option>
              <option value="database">Open database / schema</option>
            </select>
            <label>Workspace</label>
            <div>{check("Reopen tabs when connecting again", "restoreTabs")}</div>
            <label>Safety</label>
            <div>{check("Confirm before dropping or truncating", "confirmDelete")}</div>
          </>
        )}
        {tab === "editor" && (
          <>
            <label>Font size</label>
            <input className="input" type="number" min={9} max={24} step={0.5} value={s.editorFontSize} onChange={(e) => updateSettings({ editorFontSize: +e.target.value || 12.5 })} />
            <label>Editing</label>
            <div style={{ display: "grid", gap: 6 }}>
              {check("Automatically UPPERCASE keywords (autocomplete & Beautify)", "uppercaseKeywords")}
              {check("Automatically insert closing braces and quotes", "closeBrackets")}
            </div>
          </>
        )}
        {tab === "data" && (
          <>
            <label>Font size</label>
            <input className="input" type="number" min={9} max={20} step={0.5} value={s.gridFontSize} onChange={(e) => updateSettings({ gridFontSize: +e.target.value || 12 })} />
            <label>Rows per page</label>
            <select className="input" value={s.pageSize} onChange={(e) => updateSettings({ pageSize: +e.target.value })}>
              {[100, 300, 500, 1000, 5000].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <label>Display</label>
            <div>{check("Alternating row background colors", "alternatingRows")}</div>
            <label>CSV delimiter</label>
            <select className="input" value={s.csvDelimiter} onChange={(e) => updateSettings({ csvDelimiter: e.target.value })}>
              <option value=",">Comma ,</option>
              <option value=";">Semicolon ;</option>
              <option value={"\t"}>Tab</option>
              <option value="|">Pipe |</option>
            </select>
          </>
        )}
        {tab === "ai" && <AiSettings />}
        {tab === "tools" && (
          <>
            <label>Tools folder</label>
            <div className="row">
              <input className="input mono" style={{ flex: 1 }} placeholder="auto-detect (PATH, Homebrew, Postgres.app…)" value={s.toolsDir} onChange={(e) => updateSettings({ toolsDir: e.target.value })} />
              <button
                className="btn"
                onClick={async () => {
                  const d = await api.pickPath("folder");
                  if (d) updateSettings({ toolsDir: d });
                }}
              >
                Browse…
              </button>
            </div>
            <span />
            <div className="faint" style={{ fontSize: 12 }}>
              Backup &amp; Restore use pg_dump / pg_restore / psql and mysqldump / mysql. Point this at the folder containing them if they aren’t found automatically.
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

const ANT_INSTALL = 'brew install anthropics/tap/ant && xattr -d com.apple.quarantine "$(brew --prefix)/bin/ant"';
const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys";

/** OpenAI's suggested first-sign-in notice for ChatGPT plan usage. */
export function ChatGptWelcome({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="You're using your ChatGPT plan"
      width={420}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => api.openHelpUrl(MANAGE_USAGE_URL)}>Manage usage</button>
          <span className="spacer" />
          <button className="btn primary" autoFocus onClick={onClose}>Got it</button>
        </>
      }
    >
      <div style={{ lineHeight: 1.5 }}>
        Ask AI requests made with OpenAI now use your ChatGPT plan. Querybird itself is free and doesn’t charge anything —
        you can see and manage this usage in your ChatGPT settings.
      </div>
    </Modal>
  );
}

function AiSettings() {
  const s = useSettings();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [gpt, setGpt] = useState<ChatGptStatus | null>(null);
  const [gptModels, setGptModels] = useState<{ id: string; label: string }[]>([]);
  const [welcome, setWelcome] = useState(false);
  const [claudeKey, setClaudeKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [codex, setCodex] = useState<CodexModels | null>(null);
  const refresh = async () => {
    api.aiStatus().then(setStatus).catch(() => {});
    api.codexModels().then(setCodex).catch(() => {});
    const g = await api.chatgptStatus().catch(() => null);
    setGpt(g);
    if (g?.signedIn && g.planUsage) {
      const models = await api.chatgptModels().catch((e) => (setMsg({ ok: false, text: errorText(e) }), []));
      setGptModels(models);
      if (models.length && !models.some((m) => m.id === getSettings().chatgptModel)) updateSettings({ chatgptModel: models[0].id });
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const saveKey = async (provider: "claude" | "openai", key: string) => {
    try {
      await api.aiSetKey(provider, key);
      provider === "claude" ? setClaudeKey("") : setOpenaiKey("");
      setMsg({ ok: true, text: "Key saved to your keychain." });
      refresh();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };

  const signInChatGpt = async () => {
    setBusy("chatgpt");
    setMsg({ ok: true, text: "Finish signing in in your browser…" });
    try {
      const st = await api.chatgptSignIn();
      setMsg(st.planUsage ? { ok: true, text: `Signed in${st.email ? ` as ${st.email}` : ""}.` } : { ok: false, text: "Signed in, but ChatGPT plan usage wasn’t granted. Sign in again and allow it, or use an API key." });
      if (st.showWelcome) setWelcome(true);
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <label>Provider</label>
      <select className="input" value={s.aiProvider} onChange={(e) => updateSettings({ aiProvider: e.target.value as "claude" | "openai" })}>
        <option value="claude">Claude (Anthropic)</option>
        <option value="openai">OpenAI</option>
      </select>

      {s.aiProvider === "claude" ? (
        <>
          <label>Connect with</label>
          <div style={{ display: "grid", gap: 6 }}>
            <label className="row"><input type="radio" checked={s.claudeAuth === "claudeCode"} onChange={() => updateSettings({ claudeAuth: "claudeCode" })} /> Claude Code on this computer (uses its sign-in)</label>
            <label className="row"><input type="radio" checked={s.claudeAuth === "antCli"} onChange={() => updateSettings({ claudeAuth: "antCli" })} /> Sign in with Anthropic (browser)</label>
            <label className="row"><input type="radio" checked={s.claudeAuth === "apiKey"} onChange={() => updateSettings({ claudeAuth: "apiKey" })} /> Anthropic API key</label>
          </div>
          {s.claudeAuth === "claudeCode" ? (
            <LocalCli
              name="Claude Code"
              path={status?.claudeCodePath ?? null}
              signIn="claude"
              install="curl -fsSL https://claude.ai/install.sh | bash"
              onRecheck={refresh}
            />
          ) : s.claudeAuth === "apiKey" ? (
            <>
              <label>API key</label>
              <div className="row">
                <input className="input mono" style={{ flex: 1 }} type="password" placeholder={status?.claudeKey ? "saved in keychain — paste to replace" : "sk-ant-…"} value={claudeKey} onChange={(e) => setClaudeKey(e.target.value)} />
                <button className="btn" disabled={!claudeKey.trim()} onClick={() => saveKey("claude", claudeKey)}>Save</button>
                {status?.claudeKey && <button className="btn" onClick={async () => (await api.aiClearKey("claude"), refresh())}>Remove</button>}
              </div>
            </>
          ) : (
            <>
              <label>Account</label>
              {status?.antInstalled ? (
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={busy === "ant"}
                    onClick={async () => {
                      setBusy("ant");
                      setMsg({ ok: true, text: "Finish signing in in your browser…" });
                      try {
                        await api.aiAntLogin();
                        setMsg({ ok: true, text: "Signed in with Anthropic." });
                      } catch (e) {
                        setMsg({ ok: false, text: errorText(e) });
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === "ant" ? "Waiting for browser…" : "Sign in with Anthropic…"}
                  </button>
                  <span className="faint" style={{ fontSize: 11 }}>uses the official <code>ant</code> CLI</span>
                </div>
              ) : (
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontSize: 12, color: "var(--orange)" }}>Browser sign-in uses Anthropic’s official <code>ant</code> CLI, which isn’t installed. Install it in Terminal:</div>
                  <div className="row">
                    <code className="mono code-box" style={{ flex: 1, padding: "5px 8px", fontSize: 11.5 }}>{ANT_INSTALL}</code>
                    <button className="btn small" onClick={() => navigator.clipboard.writeText(ANT_INSTALL)}>Copy</button>
                  </div>
                  <div><button className="btn small" onClick={refresh}>Check again</button></div>
                </div>
              )}
            </>
          )}
          <label>Model</label>
          <select className="input" value={CLAUDE_MODELS.some((m) => m.id === s.claudeModel) ? s.claudeModel : "__custom"} onChange={(e) => e.target.value !== "__custom" && updateSettings({ claudeModel: e.target.value })}>
            {CLAUDE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            {!CLAUDE_MODELS.some((m) => m.id === s.claudeModel) && <option value="__custom">{s.claudeModel}</option>}
          </select>
        </>
      ) : (
        <>
          <label>Connect with</label>
          <div style={{ display: "grid", gap: 6 }}>
            <label className="row"><input type="radio" checked={s.openaiAuth === "codex"} onChange={() => updateSettings({ openaiAuth: "codex" })} /> Codex CLI on this computer (uses its sign-in)</label>
            <label className="row"><input type="radio" checked={s.openaiAuth === "chatgpt"} onChange={() => updateSettings({ openaiAuth: "chatgpt" })} /> Sign in with ChatGPT (uses your ChatGPT plan)</label>
            <label className="row"><input type="radio" checked={s.openaiAuth === "apiKey"} onChange={() => updateSettings({ openaiAuth: "apiKey" })} /> OpenAI API key</label>
          </div>
          {s.openaiAuth === "codex" ? (
            <>
              <LocalCli name="Codex" path={status?.codexPath ?? null} signIn="codex login" install="npm install -g @openai/codex" onRecheck={refresh} />
              <label>Model</label>
              <select className="input" value={s.codexModel} onChange={(e) => updateSettings({ codexModel: e.target.value })}>
                <option value="">Codex default{codex?.default ? ` (${codex.models.find((m) => m.id === codex.default)?.label ?? codex.default})` : ""}</option>
                {codex?.models.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}{m.description ? ` — ${m.description}` : ""}</option>
                ))}
                {s.codexModel && !codex?.models.some((m) => m.id === s.codexModel) && <option value={s.codexModel}>{s.codexModel}</option>}
              </select>
            </>
          ) : s.openaiAuth === "chatgpt" ? (
            <>
              <label>Account</label>
              {gpt?.signedIn ? (
                <div style={{ display: "grid", gap: 6 }}>
                  <div className="row" style={{ flexWrap: "wrap" }}>
                    <span style={{ color: gpt.planUsage ? "var(--green)" : "var(--orange)" }}>
                      ● {gpt.email ?? "Signed in"} · {gpt.planUsage ? "Using ChatGPT plan" : "plan usage not granted"}
                    </span>
                    <button className="btn small" onClick={() => api.openHelpUrl(MANAGE_USAGE_URL)}>Manage usage</button>
                    <button
                      className="btn small"
                      onClick={async () => {
                        setMsg({ ok: true, text: await api.chatgptSignOut().catch(errorText) });
                        setGptModels([]);
                        refresh();
                      }}
                    >
                      Sign out
                    </button>
                  </div>
                  {!gpt.planUsage && <button className="btn" onClick={signInChatGpt}>Continue with ChatGPT</button>}
                </div>
              ) : (
                <div className="row">
                  <button className="btn chatgpt-btn" disabled={busy === "chatgpt"} onClick={signInChatGpt}>
                    {busy === "chatgpt" ? "Waiting for browser…" : "Continue with ChatGPT"}
                  </button>
                  <span className="faint" style={{ fontSize: 11.5 }}>Eligible requests use your ChatGPT plan — no API key needed.</span>
                </div>
              )}
              <label>Model</label>
              {gptModels.length ? (
                <select className="input" value={s.chatgptModel} onChange={(e) => updateSettings({ chatgptModel: e.target.value })}>
                  {gptModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              ) : (
                <span className="faint" style={{ fontSize: 12 }}>Sign in to choose from the models your ChatGPT account can use.</span>
              )}
            </>
          ) : (
            <>
              <label>API key</label>
              <div className="row">
                <input className="input mono" style={{ flex: 1 }} type="password" placeholder={status?.openaiKey ? "saved in keychain — paste to replace" : "sk-…"} value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} />
                <button className="btn" disabled={!openaiKey.trim()} onClick={() => saveKey("openai", openaiKey)}>Save</button>
                {status?.openaiKey && <button className="btn" onClick={async () => (await api.aiClearKey("openai"), refresh())}>Remove</button>}
              </div>
              <span />
              <div className="row faint" style={{ fontSize: 12 }}>
                Create a key at <code className="mono">{OPENAI_KEYS_URL}</code>
                <button className="btn small" onClick={() => api.openHelpUrl(OPENAI_KEYS_URL)}>Open</button>
              </div>
              <label>Model</label>
              <input className="input mono" list="rb-openai-models" value={s.openaiModel} onChange={(e) => updateSettings({ openaiModel: e.target.value })} />
              <datalist id="rb-openai-models">
                {["gpt-5", "gpt-5-mini", "gpt-4.1"].map((m) => <option key={m} value={m} />)}
              </datalist>
            </>
          )}
        </>
      )}

      <div className="form-section">Behaviour</div>
      <label>Run</label>
      <label className="row"><input type="checkbox" checked={s.aiAutoRun} onChange={(e) => updateSettings({ aiAutoRun: e.target.checked })} /> Run generated read-only SQL automatically (writes always ask)</label>
      <label>Privacy</label>
      <div className="faint" style={{ fontSize: 12 }}>Only your question and the schema (table/column names, types, keys) are sent. Row data never leaves your machine. Credentials are stored in the OS keychain.</div>
      {msg && (
        <>
          <span />
          <div style={{ color: msg.ok ? "var(--green)" : "var(--red)", fontSize: 12, whiteSpace: "pre-wrap" }}>{msg.text}</div>
        </>
      )}
      {welcome && (
        <ChatGptWelcome
          onClose={() => {
            api.chatgptWelcomed();
            setWelcome(false);
          }}
        />
      )}
    </>
  );
}

/** Status of a locally installed AI CLI (Claude Code / Codex) used for Ask AI. */
function LocalCli({ name, path, signIn, install, onRecheck }: { name: string; path: string | null; signIn: string; install: string; onRecheck: () => void }) {
  return (
    <>
      <label>{name}</label>
      {path ? (
        <div style={{ display: "grid", gap: 4 }}>
          <span style={{ color: "var(--green)" }}>● Found at <code className="mono">{path}</code></span>
          <span className="faint" style={{ fontSize: 11.5 }}>
            Uses the account you’re signed in with there (run <code className="mono">{signIn}</code> in Terminal if you aren’t). It runs with
            every tool turned off — it only sees your question and the schema, and can’t run commands or read files.
          </span>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 12, color: "var(--orange)" }}>{name} isn’t installed. Install it in Terminal, then sign in with <code>{signIn}</code>:</div>
          <div className="row">
            <code className="mono code-box" style={{ flex: 1, padding: "5px 8px", fontSize: 11.5 }}>{install}</code>
            <button className="btn small" onClick={() => navigator.clipboard.writeText(install)}>Copy</button>
          </div>
          <div><button className="btn small" onClick={onRecheck}>Check again</button></div>
        </div>
      )}
    </>
  );
}
