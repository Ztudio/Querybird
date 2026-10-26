import { Component, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Welcome } from "./welcome/Welcome";
import { Workspace } from "./workspace/Workspace";
import "./styles.css";
import { applySettings } from "./lib/settings";

applySettings();

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 40, fontFamily: "var(--font-mono)", fontSize: 12, userSelect: "text", overflow: "auto", height: "100%" }}>
        <div style={{ color: "var(--red)", fontSize: 14, marginBottom: 10 }}>Something went wrong</div>
        {/* WebKit stacks don't include the message, so show it first. */}
        <pre style={{ whiteSpace: "pre-wrap" }}>{`${String(this.state.error)}\n\n${this.state.error.stack ?? ""}`}</pre>
        <button className="btn" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

const showFatal = (msg: string) => {
  const el = document.getElementById("root");
  if (el && !el.childElementCount) {
    const pre = document.createElement("pre");
    pre.style.cssText = "color:#ff5a52;padding:40px;white-space:pre-wrap";
    pre.textContent = msg;
    el.replaceChildren(pre);
  }
};
window.addEventListener("error", (e) => showFatal(String(e.error?.stack || e.message)));
window.addEventListener("unhandledrejection", (e) => console.error(e.reason));

// Data must be stored exactly as typed: disable smart quotes, autocorrect and capitalization.
document.addEventListener(
  "focusin",
  (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable) {
      t.setAttribute("autocorrect", "off");
      t.setAttribute("autocapitalize", "off");
      t.setAttribute("autocomplete", "off");
      t.spellcheck = false;
    }
  },
  true,
);

// Native-feeling app: no browser context menu except in text fields.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea, .cm-editor")) e.preventDefault();
});

try {
  const label = getCurrentWindow().label;
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <ErrorBoundary>{label.startsWith("ws-") ? <Workspace sessionId={label.slice(3)} /> : <Welcome />}</ErrorBoundary>,
  );
} catch (e) {
  showFatal(String((e as Error).stack || e));
}
