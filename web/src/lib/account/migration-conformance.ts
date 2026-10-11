/**
 * Account System V1 — migration conformance linter (pure text analysis, no I/O, browser/Node neutral).
 *
 * STATUS: a TRIPWIRE, not a proof. It exists so that the ownership/Guildbook migration (PR C, `0012_*.sql`) cannot
 * silently implement an account function with a weaker identity check than the specification demands. The only proof of
 * correct behaviour is the SQL integration suite against real sessions (LS-1..LS-10 in docs/account-v1/pr-obligations.md,
 * including a revoked-but-unexpired anonymous JWT and real GoTrue). Passing this linter never substitutes for those tests.
 *
 * How it avoids "mention is not a check": the SQL is tokenised first. Comments, string literals and dollar-quoted blocks
 * are masked, so text inside a literal, a comment, a DO block or a nested dollar quote can neither satisfy nor fake a
 * requirement. Every account function and guard must be defined exactly once; anything touching them afterwards
 * (ALTER FUNCTION other than timeouts, blanket or guard grants) fails; unknown account-looking functions fail.
 *
 * Accepted style (anything else fails closed, which is annoying but safe): unquoted `schema.name` identifiers, plpgsql,
 * `set search_path = ''` in the header, the guard called as the first statement after the top-level BEGIN, and a guard that
 * raises when `not exists (select ... from auth.sessions ...)` fails.
 *
 * Spec: docs/account-v1/ownership-claim-protocol.md section 4.1 and docs/account-v1/pr-obligations.md.
 */
import { ACCOUNT_GUARD_FUNCTIONS, ACCOUNT_RPC_GUARDS, type AccountGuard, type AccountRpcName } from "./contracts";

export interface Violation {
  rule: string;
  target: string;
  message: string;
}

/** Escapes every regular-expression metacharacter, backslash included. */
export function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

// ---------------------------------------------------------------------------------------------------------------
// Tokeniser: masks comments, string literals and dollar-quoted blocks.
// ---------------------------------------------------------------------------------------------------------------

interface Scanned {
  /** Code with comments removed, string literals replaced by 'S', dollar-quoted blocks replaced by ` $BODY<n>$ `. */
  code: string;
  bodies: string[];
  literals: string[];
}

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

export function scanSql(sql: string): Scanned {
  let code = "";
  const bodies: string[] = [];
  const literals: string[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      code += " ";
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      code += " ";
    } else if (c === "'") {
      const prev = code[code.length - 1];
      const beforePrev = code[code.length - 2];
      const escapeString = (prev === "E" || prev === "e") && (beforePrev === undefined || !IDENT_CHAR.test(beforePrev));
      let text = "";
      i += 1;
      while (i < n) {
        const ch = sql[i] as string;
        if (escapeString && ch === "\\" && i + 1 < n) {
          text += ch + (sql[i + 1] as string);
          i += 2;
        } else if (ch === "'" && sql[i + 1] === "'") {
          text += "'";
          i += 2;
        } else if (ch === "'") {
          i += 1;
          break;
        } else {
          text += ch;
          i += 1;
        }
      }
      literals.push(text);
      // An EMPTY literal stays visible (`search_path = ''` is meaningful); any other literal is masked.
      code += text === "" ? "''" : "'S'";
    } else if (c === '"') {
      let ident = '"';
      i += 1;
      while (i < n) {
        const ch = sql[i] as string;
        ident += ch;
        i += 1;
        if (ch === '"') {
          if (sql[i] === '"') {
            ident += '"';
            i += 1;
          } else break;
        }
      }
      code += ident;
    } else if (c === "$" && !(code.length > 0 && IDENT_CHAR.test(code[code.length - 1] as string)) && DOLLAR_TAG.test(sql.slice(i))) {
      const tag = (DOLLAR_TAG.exec(sql.slice(i)) as RegExpExecArray)[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) {
        code += c;
        i += 1;
      } else {
        bodies.push(sql.slice(i + tag.length, end));
        code += ` $BODY${bodies.length - 1}$ `;
        i = end + tag.length;
      }
    } else {
      code += c;
      i += 1;
    }
  }
  return { code, bodies, literals };
}

// ---------------------------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------------------------

interface Definition {
  name: string;
  header: string;
  body: Scanned;
}

const FUNCTION_START = /create\s+(?:or\s+replace\s+)?function\s+([A-Za-z_]\w*\.[A-Za-z_]\w*)\s*\(([^)]*)\)([\s\S]*?)\bas\s+\$BODY(\d+)\$/gi;

function definitionsOf(top: Scanned): Definition[] {
  const out: Definition[] = [];
  for (const m of top.code.matchAll(FUNCTION_START)) {
    const body = top.bodies[Number(m[4])];
    if (body === undefined) continue;
    out.push({ name: (m[1] as string).toLowerCase(), header: m[3] as string, body: scanSql(body) });
  }
  return out;
}

function executable(code: string): string {
  const begin = /\bbegin\b/i.exec(code);
  return begin ? code.slice(begin.index + begin[0].length) : "";
}

/** Text of the parenthesised subquery that starts at `open` (index of "("), or null. */
function balanced(code: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return null;
}

const KEYWORDS_AFTER_TABLE = new Set(["where", "join", "inner", "left", "right", "full", "cross", "on", "using", "group", "order", "limit", "for", "union"]);

/** The mandatory shape of the live-session query inside a guard. Returns violation messages. */
function checkLiveSession(exec: string): string[] {
  const problems: string[] = [];
  const notExists = /not\s+exists\s*\(\s*select\b/i.exec(exec);
  if (!notExists) {
    return ["guard must refuse when `not exists (select ... from auth.sessions ...)` finds no live session"];
  }
  const open = exec.indexOf("(", notExists.index);
  const sub = balanced(exec, open);
  if (sub === null) return ["guard live-session subquery is unbalanced"];
  if (!/\bfrom\s+auth\.sessions\b/i.test(sub)) problems.push("the not-exists subquery must read auth.sessions");
  const aliasMatch = /\bauth\.sessions\s+(?:as\s+)?([A-Za-z_]\w*)/i.exec(sub);
  const alias = aliasMatch && !KEYWORDS_AFTER_TABLE.has((aliasMatch[1] as string).toLowerCase()) ? (aliasMatch[1] as string) : null;
  const eq = (col: string) => (alias ? new RegExp(`\\b${escapeRegExp(alias)}\\.${col}\\s*=`, "i") : new RegExp(`(?<![.\\w])${col}\\s*=`, "i"));
  if (!eq("id").test(sub)) problems.push("the session row must be matched by its id (sessions.id = the JWT session_id)");
  if (!eq("user_id").test(sub)) problems.push("the session row must belong to the caller (sessions.user_id = auth.uid())");
  if (!/not_after/i.test(sub)) problems.push("the subquery must check not_after (session expiry)");
  if (!/deleted_at/i.test(sub)) problems.push("the subquery must check deleted_at");
  if (!/banned_until/i.test(sub)) problems.push("the subquery must check banned_until");
  const after = exec.slice(open + sub.length + 2);
  if (!/^[^;]*?\bthen\s+raise\b/i.test(after)) problems.push("the check must be attached to a RAISE (`... then raise ...`)");
  const ret = /\breturn\b/i.exec(exec);
  if (ret && ret.index < notExists.index) problems.push("the live-session check must come before the first RETURN");
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------------------------------------------

const GUARDS = Object.keys(ACCOUNT_GUARD_FUNCTIONS) as AccountGuard[];
const RPCS = Object.keys(ACCOUNT_RPC_GUARDS) as AccountRpcName[];

export function lintAccountMigration(sql: string): Violation[] {
  const out: Violation[] = [];
  const add = (rule: string, target: string, message: string) => out.push({ rule, target, message });
  const top = scanSql(sql);
  const defs = definitionsOf(top);

  const guardNames = new Map(GUARDS.map((g) => [ACCOUNT_GUARD_FUNCTIONS[g].toLowerCase(), g]));
  const rpcNames = new Map(RPCS.map((r) => [`public.${r}`.toLowerCase(), r]));
  const known = new Set<string>([...guardNames.keys(), ...rpcNames.keys()]);

  // --- every account-looking function must be known, and defined exactly once ----------------------------------
  const allNames = [...top.code.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([A-Za-z_]\w*\.[A-Za-z_]\w*)\s*\(/gi)].map((m) => (m[1] as string).toLowerCase());
  for (const name of new Set(allNames)) {
    const looksAccount = /^public\.(fdb_account_|fdb_installation_)/.test(name) || /^private\.fdb_(caller|anonymous_caller|registered_caller)\b/.test(name);
    if (looksAccount && !known.has(name)) add("unknown-function", name, "account-looking function that is not in the registry (add it to ACCOUNT_RPC_GUARDS first)");
  }
  for (const name of known) {
    const count = allNames.filter((x) => x === name).length;
    if (count === 0) add(guardNames.has(name) ? "guard-missing" : "function-missing", name, "not defined");
    if (count > 1) add("duplicate-definition", name, `defined ${count} times (later definitions and overloads would override the reviewed one)`);
  }

  // --- ALTER / GRANT whitelist ---------------------------------------------------------------------------------------
  for (const m of top.code.matchAll(/alter\s+function\s+([A-Za-z_]\w*\.[A-Za-z_]\w*)\s*\([^)]*\)\s+([^;]*);/gi)) {
    const name = (m[1] as string).toLowerCase();
    if (known.has(name) && !/^set\s+(?:statement_timeout|lock_timeout)\b/i.test((m[2] as string).trim()) && !/^set\s+search_path\s*(?:=|to)\s*''\s*$/i.test((m[2] as string).trim())) {
      add("alter-function", name, "ALTER FUNCTION may only set statement_timeout, lock_timeout or search_path = '' (no security invoker, reset, rename, owner or schema changes)");
    }
  }
  if (/grant\s+[^;]*\bon\s+all\s+functions\s+in\s+schema\b/i.test(top.code)) {
    add("blanket-grant", "database", "GRANT ... ON ALL FUNCTIONS IN SCHEMA is forbidden in an account migration");
  }
  for (const m of top.code.matchAll(/grant\s+[^;]*?\bon\s+function\s+([A-Za-z_]\w*\.[A-Za-z_]\w*)\s*\([^)]*\)\s+to\s+([^;]+);/gi)) {
    const name = (m[1] as string).toLowerCase();
    const roles = (m[2] as string).toLowerCase();
    if (guardNames.has(name)) add("guard-grant", name, "guards must not be granted to any client role");
    else if (rpcNames.has(name) && /\b(anon|public|service_role)\b/.test(roles)) add("grant", name, "must not grant execute to anon, public or service_role");
  }
  const privateRevoked = /revoke\s+all\s+on\s+all\s+functions\s+in\s+schema\s+private\b/i.test(top.code);
  for (const g of GUARDS) {
    const name = ACCOUNT_GUARD_FUNCTIONS[g];
    if (!privateRevoked && !new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${escapeRegExp(name)}\\s*\\([^)]*\\)\\s+from[^;]*\\banon\\b`, "i").test(top.code)) {
      add("guard-grants", name, "guard must not be callable by clients (revoke from public, anon, authenticated)");
    }
  }

  // --- guards ----------------------------------------------------------------------------------------------------------
  for (const def of defs.filter((d) => guardNames.has(d.name))) {
    const guard = guardNames.get(def.name) as AccountGuard;
    const name = def.name;
    if (!/security\s+definer/i.test(def.header)) add("guard-security-definer", name, "guard must be SECURITY DEFINER (it reads auth.sessions)");
    if (!/language\s+plpgsql/i.test(def.header)) add("guard-language", name, "guard must be plpgsql");
    if (/\b(stable|immutable)\b/i.test(def.header)) add("guard-volatile", name, "guard must be VOLATILE (a STABLE function cannot lock the session row and may be cached)");
    if (!hasSearchPath(top.code, name, def.header)) add("guard-search-path", name, "guard must set search_path = ''");
    const exec = executable(def.body.code);
    if (guard === "any_live_session") {
      if (!/auth\.jwt\s*\(\s*\)/i.test(def.body.code) || !def.body.literals.includes("session_id")) add("guard-live-session", name, "guard must read the session_id claim from auth.jwt()");
      if (!/auth\.uid\s*\(\s*\)/i.test(def.body.code)) add("guard-live-session", name, "guard must use auth.uid()");
      for (const message of checkLiveSession(exec)) add("guard-live-session", name, message);
    } else {
      const callsBase = /^\s*(?:perform\s+private\.fdb_caller\s*\(\s*\)|[A-Za-z_]\w*\s*:=\s*private\.fdb_caller\s*\(\s*\))\s*;/i.test(exec);
      if (!callsBase) add("guard-live-session", name, "guard must call private.fdb_caller() as its first statement");
      const ret = /\breturn\b/i.exec(exec);
      const head = ret ? exec.slice(0, ret.index) : exec;
      if (!/\braise\b/i.test(head)) add("guard-live-session", name, "guard must raise before returning when the identity kind is wrong");
      if (!/is_anonymous/i.test(head)) add("guard-live-session", name, "guard must check is_anonymous");
      if (guard === "registered_live_session" && !/email_confirmed_at/i.test(head)) add("guard-live-session", name, "guard must check email_confirmed_at");
    }
  }

  // --- public account functions --------------------------------------------------------------------------------------
  for (const def of defs.filter((d) => rpcNames.has(d.name))) {
    const rpc = rpcNames.get(def.name) as AccountRpcName;
    const qualified = def.name;
    const required = ACCOUNT_GUARD_FUNCTIONS[ACCOUNT_RPC_GUARDS[rpc]];
    if (!/security\s+definer/i.test(def.header)) add("security-definer", qualified, "must be SECURITY DEFINER");
    if (!/language\s+plpgsql/i.test(def.header)) add("language", qualified, "must be plpgsql so the guard runs before any other statement");
    if (/\b(stable|immutable)\b/i.test(def.header)) add("volatility", qualified, "must be VOLATILE (it writes budgets, locks and audit rows)");
    if (!hasSearchPath(top.code, qualified, def.header)) add("search-path", qualified, "must set search_path = ''");

    const exec = executable(def.body.code);
    const escapedGuard = escapeRegExp(required);
    const first = new RegExp(`^\\s*(?:perform\\s+${escapedGuard}\\s*\\(\\s*\\)|[A-Za-z_]\\w*\\s*:=\\s*${escapedGuard}\\s*\\(\\s*\\))\\s*;`, "i").exec(exec);
    if (!first) add("guard-first", qualified, `first statement after BEGIN must call ${required}() (live-session identity guard)`);
    const guardPos = first ? first[0].length : -1;
    const uidUse = /auth\.uid\s*\(\s*\)|auth\.jwt\s*\(\s*\)|is_anonymous/i.exec(exec);
    if (uidUse && (guardPos < 0 || uidUse.index < guardPos)) {
      add("identity-before-guard", qualified, "identity is read (auth.uid()/auth.jwt()/is_anonymous) before the guard; the guard must come first and be the only source of identity");
    }

    const escapedName = escapeRegExp(qualified);
    if (!new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${escapedName}\\s*\\([^)]*\\)\\s+from[^;]*\\bpublic\\b[^;]*\\banon\\b`, "i").test(top.code)) {
      add("revoke", qualified, "must revoke all from public and anon (and authenticated, service_role) before granting");
    }
    const grants = [...top.code.matchAll(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${escapedName}\\s*\\([^)]*\\)\\s+to\\s+([^;]+);`, "gi"))].map((m) => (m[1] ?? "").toLowerCase());
    if (!grants.some((g) => /\bauthenticated\b/.test(g))) add("grant", qualified, "must grant execute to authenticated");
  }
  return out;
}

function hasSearchPath(code: string, name: string, header: string): boolean {
  if (/set\s+search_path\s*(?:=|to)\s*''/i.test(header)) return true;
  return new RegExp(`alter\\s+function\\s+${escapeRegExp(name)}\\s*\\([^)]*\\)\\s+set\\s+search_path\\s*(?:=|to)\\s*''`, "i").test(code);
}
