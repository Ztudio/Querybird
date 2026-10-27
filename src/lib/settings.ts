import { useSyncExternalStore } from "react";
import type { AiStatus, ChatGptStatus } from "../api";
import { SYSTEM_THEME, findTheme, themeVars } from "./themes";

export interface Settings {
  /** A theme id from lib/themes.ts, or "system". */
  theme: string;
  editorFontSize: number;
  gridFontSize: number;
  uppercaseKeywords: boolean;
  closeBrackets: boolean;
  alternatingRows: boolean;
  csvDelimiter: string;
  cmdTOpens: "query" | "database";
  restoreTabs: boolean;
  confirmDelete: boolean;
  toolsDir: string;
  pageSize: number;
  aiProvider: "claude" | "openai";
  /** claudeCode / codex: the locally installed CLI and the account it's signed in with. */
  claudeAuth: "apiKey" | "antCli" | "claudeCode";
  claudeModel: string;
  openaiModel: string;
  openaiAuth: "apiKey" | "chatgpt" | "codex";
  /** Model for the local Codex CLI; empty uses Codex's own default. */
  codexModel: string;
  /** Model used with "Sign in with ChatGPT" (from the account's model list). */
  chatgptModel: string;
  /** Run generated read-only SQL immediately; writes always ask first. */
  aiAutoRun: boolean;
  /** Send up to 50 rows of each read-only result to the AI for a written conclusion. Off by default. */
  aiReadRows: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  editorFontSize: 12.5,
  gridFontSize: 12,
  uppercaseKeywords: true,
  closeBrackets: true,
  alternatingRows: true,
  csvDelimiter: ",",
  cmdTOpens: "query",
  restoreTabs: true,
  confirmDelete: true,
  toolsDir: "",
  pageSize: 300,
  aiProvider: "claude",
  claudeAuth: "apiKey",
  claudeModel: "claude-opus-5-5",
  openaiModel: "gpt-5",
  openaiAuth: "apiKey",
  chatgptModel: "",
  codexModel: "",
  aiAutoRun: true,
  aiReadRows: false,
};

const KEY = "querybird.settings";
let current: Settings = read();
const listeners = new Set<() => void>();

function read(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable */
  }
  applySettings();
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** Applies settings that live in CSS. Also re-reads storage so every window stays in sync. */
export function applySettings() {
  const root = document.documentElement;
  const theme = findTheme(current.theme, matchMedia("(prefers-color-scheme: dark)").matches);
  if (root.dataset.theme !== theme.id) {
    // Switching themes would otherwise fire every color transition at once and smear.
    root.classList.add("theme-switching");
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  }
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.type;
  for (const [k, v] of Object.entries(themeVars(theme))) root.style.setProperty(k, v);
  root.style.setProperty("--grid-font-size", `${current.gridFontSize}px`);
  root.style.setProperty("--editor-font-size", `${current.editorFontSize}px`);
  root.classList.toggle("no-stripes", !current.alternatingRows);
}

// "System" theme follows the OS appearance live.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => current.theme === SYSTEM_THEME && applySettings());

// Other windows changing settings → pick them up here too.
window.addEventListener("storage", (e) => {
  if (e.key === KEY) {
    current = read();
    applySettings();
    listeners.forEach((l) => l());
  }
});

export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (default)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster, cheaper)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest)" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 (most capable)" },
];

/** The model the Ask AI tab will use for the current provider + sign-in method. */
export function activeModel(s: Settings): string {
  if (s.aiProvider === "claude") return s.claudeModel;
  if (s.openaiAuth === "codex") return s.codexModel;
  return s.openaiAuth === "chatgpt" ? s.chatgptModel : s.openaiModel;
}

/** Whether the chosen provider + sign-in method can be used right now. */
export function aiReady(s: Settings, status: AiStatus | null, gpt: ChatGptStatus | null): boolean {
  if (!status) return false;
  if (s.aiProvider === "claude") {
    if (s.claudeAuth === "claudeCode") return !!status.claudeCodePath;
    return s.claudeAuth === "antCli" ? status.antInstalled : status.claudeKey;
  }
  if (s.openaiAuth === "codex") return !!status.codexPath;
  if (s.openaiAuth === "chatgpt") return !!gpt?.signedIn && gpt.planUsage && !!s.chatgptModel;
  return status.openaiKey;
}

/**
 * When the chosen AI method isn't usable but Claude Code or Codex is installed locally, switch to
 * it (same provider first). Never overrides a method that already works.
 */
export function autoPickLocalCli(status: AiStatus | null, gpt: ChatGptStatus | null): string | null {
  const s = getSettings();
  if (!status || aiReady(s, status, gpt)) return null;
  const claude = status.claudeCodePath ? () => updateSettings({ aiProvider: "claude", claudeAuth: "claudeCode" }) : null;
  const codex = status.codexPath ? () => updateSettings({ aiProvider: "openai", openaiAuth: "codex" }) : null;
  const order = s.aiProvider === "openai" ? [[codex, "Codex (local)"], [claude, "Claude Code (local)"]] : [[claude, "Claude Code (local)"], [codex, "Codex (local)"]];
  for (const [pick, name] of order as [(() => void) | null, string][]) {
    if (pick) {
      pick();
      return name;
    }
  }
  return null;
}

export const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";
