import { invoke } from "@tauri-apps/api/core";

export type Driver = "postgres" | "mysql";
export type SslMode = "disable" | "prefer" | "require" | "verify-full";
export type PasswordMode = "keychain" | "ask";

export interface ConnectionConfig {
  id: string;
  name: string;
  driver: Driver;
  host: string;
  port: number;
  user: string;
  database: string;
  sslMode: SslMode;
  passwordMode: PasswordMode;
  color: string;
  tag: string;
  group: string;
  bootstrap: string;
  ssh: SshConfig | null;
}

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  keyPath: string | null;
  /** Only sent when changed; stored in the keychain, never returned. */
  password?: string | null;
  hostKey: string | null;
}

export interface ColumnMeta {
  name: string;
  typeName: string;
}

export type Cell = string | null;

export interface QueryResult {
  columns: ColumnMeta[];
  rows: Cell[][];
  affected: number | null;
  elapsedMs: number;
}

export interface ObjectList {
  tables: string[];
  views: string[];
  functions: string[];
}

export interface ForeignRef {
  schema: string;
  table: string;
  column: string;
}

export interface ColumnInfo {
  position: number;
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  comment: string | null;
  extra: string | null;
  isPrimary: boolean;
  foreign: ForeignRef | null;
}

export interface IndexInfo {
  name: string;
  algorithm: string;
  unique: boolean;
  primary: boolean;
  columns: string;
  condition: string | null;
}

export interface TableStructure {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  primaryKey: string[];
}

export interface Filter {
  column: string;
  op: string;
  value: string;
}

export interface TableQuery {
  schema: string;
  table: string;
  limit: number;
  offset: number;
  filters: Filter[];
  rawWhere?: string | null;
  orderBy?: string | null;
  orderDesc?: boolean;
  sorts?: SortSpec[];
}

export interface TablePage {
  result: QueryResult;
  total: number;
  estimated: boolean;
  sql: string;
}

export interface CellValue {
  column: string;
  value: Cell;
  default?: boolean;
}

export interface SortSpec {
  column: string;
  desc: boolean;
}

export interface SearchHit {
  table: string;
  count: number;
  whereSql: string;
}

export interface Change {
  kind: "update" | "insert" | "delete";
  schema: string;
  table: string;
  key: CellValue[];
  values: CellValue[];
}

export interface SessionInfo {
  id: string;
  connection: ConnectionConfig;
  serverVersion: string;
  schema: string;
}

export type AiProvider = "claude" | "openai";
export type ClaudeAuth = "apiKey" | "antCli";
export type OpenaiAuth = "apiKey" | "chatgpt";

export interface ChatGptStatus {
  signedIn: boolean;
  email: string | null;
  planUsage: boolean;
  showWelcome: boolean;
}

export interface AiTurn {
  question: string;
  sql: string;
  error?: string | null;
}

export interface AiAnswer {
  sql: string;
  explanation: string;
  modifiesData: boolean;
  model: string;
  schemaContext: string;
}

export interface AiStatus {
  claudeKey: boolean;
  openaiKey: boolean;
  antInstalled: boolean;
  antPath: string | null;
}

export const api = {
  listConnections: () => invoke<ConnectionConfig[]>("list_connections"),
  saveConnection: (config: ConnectionConfig, password?: string | null) =>
    invoke<ConnectionConfig>("save_connection", { config, password: password ?? null }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  hasSavedPassword: (id: string) => invoke<boolean>("has_saved_password", { id }),
  testConnection: (config: ConnectionConfig, password?: string | null) =>
    invoke<string>("test_connection", { config, password: password ?? null }),
  connect: (config: ConnectionConfig, password?: string | null) =>
    invoke<SessionInfo>("connect", { config, password: password ?? null }),
  openWorkspace: (sessionId: string, title: string) => invoke<void>("open_workspace", { sessionId, title }),
  showWelcome: () => invoke<void>("show_welcome"),
  sessionInfo: (sessionId: string) => invoke<SessionInfo>("session_info", { sessionId }),
  disconnect: (sessionId: string) => invoke<void>("disconnect", { sessionId }),
  reconnect: (sessionId: string) => invoke<SessionInfo>("reconnect", { sessionId }),
  listSchemas: (sessionId: string) => invoke<string[]>("list_schemas", { sessionId }),
  setSchema: (sessionId: string, schema: string) => invoke<void>("set_schema", { sessionId, schema }),
  listObjects: (sessionId: string, schema: string) => invoke<ObjectList>("list_objects", { sessionId, schema }),
  fetchTable: (sessionId: string, query: TableQuery) => invoke<TablePage>("fetch_table", { sessionId, query }),
  tableStructure: (sessionId: string, schema: string, table: string) =>
    invoke<TableStructure>("table_structure", { sessionId, schema, table }),
  tableInfo: (sessionId: string, schema: string, table: string) =>
    invoke<[string, string][]>("table_info", { sessionId, schema, table }),
  tableDdl: (sessionId: string, schema: string, table: string) =>
    invoke<string>("table_ddl", { sessionId, schema, table }),
  processListSql: (sessionId: string) => invoke<string>("process_list_sql", { sessionId }),
  execute: (sessionId: string, sql: string) => invoke<QueryResult[]>("execute", { sessionId, sql }),
  previewChanges: (sessionId: string, changes: Change[]) => invoke<string[]>("preview_changes", { sessionId, changes }),
  applyChanges: (sessionId: string, changes: Change[]) => invoke<string[]>("apply_changes", { sessionId, changes }),
  writeTextFile: (path: string, contents: string) => invoke<void>("write_text_file", { path, contents }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  aiStatus: () => invoke<AiStatus>("ai_status"),
  aiSetKey: (provider: AiProvider, key: string) => invoke<void>("ai_set_key", { provider, key }),
  aiClearKey: (provider: AiProvider) => invoke<void>("ai_clear_key", { provider }),
  aiAntLogin: () => invoke<string>("ai_ant_login"),
  chatgptStatus: () => invoke<ChatGptStatus>("chatgpt_status"),
  chatgptSignIn: () => invoke<ChatGptStatus>("chatgpt_sign_in"),
  chatgptSignOut: () => invoke<string>("chatgpt_sign_out"),
  chatgptModels: () => invoke<{ id: string; label: string }[]>("chatgpt_models"),
  chatgptWelcomed: () => invoke<void>("chatgpt_welcomed"),
  openHelpUrl: (url: string) => invoke<void>("open_help_url", { url }),
  aiAsk: (sessionId: string, request: { provider: AiProvider; claudeAuth: ClaudeAuth; openaiAuth: OpenaiAuth; model: string; question: string; history: AiTurn[] }) =>
    invoke<AiAnswer>("ai_ask", { sessionId, request }),
  renameGroup: (from: string, to: string) => invoke<void>("rename_group", { from, to }),
  /** Copies a connection URL to the clipboard on the backend (the password never reaches the UI). */
  copyConnectionUrl: (id: string, withPassword: boolean) => invoke<void>("copy_connection_url", { id, withPassword }),
  /** Native file dialog run by the backend; only paths picked here can be read or written. */
  pickPath: (mode: "save" | "open" | "folder", opts: { defaultName?: string; filterName?: string; extensions?: string[] } = {}) =>
    invoke<string | null>("pick_path", { mode, defaultName: opts.defaultName ?? null, filterName: opts.filterName ?? null, extensions: opts.extensions ?? [] }),
  executeReadonly: (sessionId: string, sql: string) => invoke<QueryResult[]>("execute_readonly", { sessionId, sql }),
  runStatements: (sessionId: string, statements: string[], transaction: boolean) =>
    invoke<string[]>("run_statements", { sessionId, statements, transaction }),
  itemOverview: (sessionId: string, schema: string) => invoke<QueryResult>("item_overview", { sessionId, schema }),
  searchDatabase: (sessionId: string, schema: string, term: string) =>
    invoke<SearchHit[]>("search_database", { sessionId, schema, term }),
  killProcess: (sessionId: string, pid: string) => invoke<void>("kill_process", { sessionId, pid }),
  backupDatabase: (config: ConnectionConfig, password: string | null, database: string, path: string, customFormat: boolean, toolsDir: string | null) =>
    invoke<string>("backup_database", { config, password, database, path, customFormat, toolsDir }),
  restoreDatabase: (config: ConnectionConfig, password: string | null, database: string, path: string, toolsDir: string | null) =>
    invoke<string>("restore_database", { config, password, database, path, toolsDir }),
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
