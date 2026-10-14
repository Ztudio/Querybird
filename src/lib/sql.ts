export interface Statement {
  text: string;
  from: number;
  to: number;
}

/** Splits SQL on semicolons, ignoring those inside quotes, comments and $$ bodies. */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  const push = (end: number) => {
    const raw = sql.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) out.push({ text, from: start + lead, to: start + lead + text.length });
  };
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
    } else if (c === "#") {
      while (i < n && sql[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < n) {
        if (sql[i] === "\\" && c !== '"') {
          i += 2;
          continue;
        }
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
    } else if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? n : end + tag.length;
      } else i++;
    } else if (c === ";") {
      push(i);
      start = i + 1;
      i++;
    } else i++;
  }
  push(n);
  return out.filter((s) => !isOnlyComments(s.text));
}

function isOnlyComments(text: string): boolean {
  return text.replace(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g, "").trim() === "";
}

/** The statement containing the cursor, or the closest one before it. */
export function statementAt(sql: string, cursor: number): Statement | null {
  const all = splitStatements(sql);
  if (!all.length) return null;
  let best = all[0];
  for (const s of all) {
    if (s.from <= cursor) best = s;
    if (cursor >= s.from && cursor <= s.to + 1) return s;
  }
  return best;
}

/** Appends LIMIT to a plain SELECT that doesn't have one. */
export function withLimit(sql: string, limit: number | null): string {
  if (!limit) return sql;
  const stripped = sql.replace(/;\s*$/, "");
  if (!/^\s*(\(\s*)*(select|with|table)\b/i.test(stripped)) return sql;
  if (/\blimit\s+\d+(\s*(,|offset)\s*\d+)?\s*$/i.test(stripped)) return sql;
  if (/\bfor\s+update\b|\binto\b/i.test(stripped)) return sql;
  return `${stripped} LIMIT ${limit}`;
}

const WRITE_WORDS =
  /\b(insert|update|delete|merge|drop|alter|truncate|create|grant|revoke|copy|call|do|lock|vacuum|reindex|refresh|replace|rename|load|handler|comment|cluster|discard|reset|set|into|outfile|dumpfile)\b/i;
const SIDE_EFFECT_FUNCS =
  /\b(pg_terminate_backend|pg_cancel_backend|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_sleep|pg_advisory\w*|set_config|lo_import|lo_export|dblink\w*|nextval|setval|load_file|sleep|benchmark|get_lock)\s*\(/i;

/** Removes string literals, quoted identifiers, dollar bodies and comments (keeps MySQL /*! … *\/). */
function stripLiterals(sql: string): string {
  return sql
    .replace(/\/\*!([\s\S]*?)\*\//g, " $1 ")
    .replace(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g, " ")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " '' ")
    .replace(/[Ee]?'(?:[^'\\]|\\.|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`/g, " '' ");
}

/**
 * Best-effort check that SQL is a single read-only statement. Used for UI hints and safe-mode
 * prompts; AI-generated SQL is additionally enforced by the server (read-only transaction).
 */
export function isReadOnly(sql: string): boolean {
  if (splitStatements(sql).length !== 1) return false;
  const s = stripLiterals(sql);
  if (!/^\s*(\(\s*)*(select|show|explain|describe|desc|with|table|values)\b/i.test(s)) return false;
  if (/^\s*explain\b[^;]*\banalyze\b/i.test(s)) return false;
  // "replace(" as a function is fine; REPLACE INTO is not.
  const words = s.replace(/\breplace\s*\(/gi, " fn(");
  return !WRITE_WORDS.test(words) && !SIDE_EFFECT_FUNCS.test(s);
}
