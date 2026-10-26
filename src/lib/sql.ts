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

/** Keywords outside quotes, comments and parentheses, with where each starts. */
function topLevelWords(sql: string): { word: string; at: number; end: number }[] {
  const out: { word: string; at: number; end: number }[] = [];
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if ((c === "-" && n === "-") || c === "#") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && c === "'") i += 2;
        else if (sql[i] === c && sql[i + 1] === c) i += 2;
        else if (sql[i] === c) break;
        else i++;
      }
      i++;
    } else if (c === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/)![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? sql.length : end + tag.length;
    } else if (c === "(") {
      depth++;
      i++;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (/[A-Za-z_]/.test(c) && (i === 0 || !/[\w$]/.test(sql[i - 1]))) {
      let j = i;
      while (j < sql.length && /[\w$]/.test(sql[j])) j++;
      if (depth === 0) out.push({ word: sql.slice(i, j).toLowerCase(), at: i, end: j });
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

export interface WriteRisk {
  kind: "delete" | "update" | "insert" | "drop" | "truncate" | "alter" | "other";
  /** Can't be undone, or hits every row: needs an explicit acknowledgement before running. */
  destructive: boolean;
  /** DELETE/UPDATE with no WHERE clause. */
  noWhere: boolean;
  /** Read-only SELECT COUNT(*) of the rows a DELETE/UPDATE would touch; null when it can't be derived safely. */
  countSql: string | null;
  /** Table a DELETE/UPDATE/DROP/TRUNCATE targets, as written. */
  target: string | null;
}

/**
 * How risky a statement that changes data is, for the confirmation shown before running it.
 * Never runs anything: the row count is a separate SELECT that the caller runs read-only.
 */
export function writeRisk(sql: string): WriteRisk {
  const text = sql.trim().replace(/;\s*$/, "");
  const base: WriteRisk = { kind: "other", destructive: false, noWhere: false, countSql: null, target: null };
  if (splitStatements(text).length !== 1) return { ...base, destructive: true };
  const words = topLevelWords(text);
  const first = words[0]?.word ?? "";
  const has = (w: string) => words.some((x) => x.word === w);
  const find = (w: string) => words.find((x) => x.word === w);
  const where = find("where");
  const whereText = where ? text.slice(where.end).trim() : "";

  if (first === "drop" || first === "truncate") {
    const t = words.find((x, i) => i > 0 && !["table", "if", "exists", "only", "database", "schema", "view", "index", "cascade"].includes(x.word));
    return { ...base, kind: first, destructive: true, target: t ? text.slice(t.at).split(/[\s,;]/)[0] : null };
  }
  if (first === "alter") return { ...base, kind: "alter", destructive: has("drop") || has("rename") || has("type") };
  if (first === "insert" || first === "replace" || first === "merge" || first === "copy") return { ...base, kind: "insert" };

  if (first === "delete") {
    const from = find("from");
    const unsafe = ["using", "returning", "limit", "order", "join"].some(has);
    const target = from ? text.slice(from.end, where ? where.at : undefined).trim() : null;
    const countable = !!target && !unsafe && !target.includes(",") && /^[\w."`$]+(\s+(as\s+)?\w+)?$/i.test(target);
    return {
      ...base,
      kind: "delete",
      noWhere: !where,
      destructive: !where,
      target,
      countSql: countable ? `SELECT COUNT(*) FROM ${target}${where ? ` WHERE ${whereText}` : ""}` : null,
    };
  }
  if (first === "update") {
    const set = find("set");
    const target = set ? text.slice(words[0].end, set.at).trim() : null;
    const unsafe = ["from", "returning", "limit", "order", "join"].some((w) => words.some((x) => x.word === w && (!set || x.at > set.at || w === "join")));
    const countable = !!target && !unsafe && !target.includes(",") && /^[\w."`$]+(\s+(as\s+)?\w+)?$/i.test(target);
    return {
      ...base,
      kind: "update",
      noWhere: !where,
      destructive: !where,
      target,
      countSql: countable ? `SELECT COUNT(*) FROM ${target}${where ? ` WHERE ${whereText}` : ""}` : null,
    };
  }
  return base;
}
