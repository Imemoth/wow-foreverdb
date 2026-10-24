/**
 * Account System V1 — migration conformance linter (pure text analysis, no I/O, browser/Node neutral).
 *
 * STATUS: a TRIPWIRE, not a proof. Text analysis cannot prove that SQL behaves correctly. It exists so that the
 * ownership/Guildbook migration (PR C, `0012_*.sql`) cannot silently implement an account function with a weaker identity
 * check than the specification demands, and so a careless or hostile author has to work visibly outside a canonical style.
 * The only proof of behaviour is the SQL integration suite against real sessions (LS-1..LS-9 and LS-11 in
 * docs/account-v1/pr-obligations.md, including a revoked-but-unexpired anonymous JWT against real GoTrue).
 *
 * Design: it is a WHITELIST with one canonical style; anything it cannot parse is a violation (fail closed).
 *  - The SQL is tokenised first: comments, string literals and dollar-quoted blocks are masked, so text inside them can neither
 *    satisfy nor fake a requirement. DO-block bodies and account function bodies may not use dynamic SQL (`execute`).
 *  - Canonical style: unquoted `schema.name` identifiers; every function is `create [or replace] function`, plpgsql, with a
 *    dollar-quoted body (no single-quoted, `begin atomic` or `return expr` bodies; no procedures, views, rules or triggers);
 *    exactly the `set` clauses `search_path = ''`, `statement_timeout`, `lock_timeout`; each account function and guard is
 *    defined once; every other function must be registered in ACCOUNT_HELPER_FUNCTIONS.
 *  - Guards must verify the live session in the reference shape: the session id is read from `auth.jwt() ->> 'session_id'`,
 *    the format is checked before any `::uuid` cast, and `if ... not exists (select ... from auth.sessions s where s.id = <that
 *    id> and s.user_id = <auth.uid()> and not_after / deleted_at / banned_until ...) then raise sqlstate|exception ...`
 *    with no constant conditions, before any `return`.
 *  - Account functions call their guard as their first statement, read no identity before it, never call `auth.uid()` themselves
 *    (the UID is the guard's return value) and never swallow errors (`exception when ...`).
 *  - GRANT/REVOKE/ALTER are whitelisted (no routines/procedures/default privileges/role grants/blanket grants/quoted names).
 *
 * Spec: docs/account-v1/ownership-claim-protocol.md section 4.1 and docs/account-v1/pr-obligations.md.
 */
import {
  ACCOUNT_GUARD_FUNCTIONS,
  ACCOUNT_HELPER_FUNCTIONS,
  ACCOUNT_RPC_GUARDS,
  type AccountGuard,
  type AccountRpcName,
} from "./contracts";

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
  /** Code with comments removed, non-empty string literals replaced by 'S', dollar-quoted blocks by ` $BODY<n>$ `. */
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

/** Text of the parenthesised group that starts at `open` (index of "("), or null. */
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

function bodyParts(code: string): { declare: string; exec: string } {
  const begin = /\bbegin\b/i.exec(code);
  return begin ? { declare: code.slice(0, begin.index), exec: code.slice(begin.index + begin[0].length) } : { declare: code, exec: "" };
}

// ---------------------------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------------------------

interface Definition {
  name: string;
  /** Everything outside the body: attributes before AND after the dollar-quoted body. */
  attrs: string;
  body: Scanned;
}

const NAME = /[A-Za-z_]\w*\.[A-Za-z_]\w*/;

/** Allowed `set` clauses inside a function definition or ALTER FUNCTION; anything else left over is a violation. */
const ALLOWED_SET = /\bset\s+(?:search_path\s*(?:=|to)\s*''(?!\s*,)|(?:statement_timeout|lock_timeout)\s*(?:=|to)\s*(?:'S'|\d+))/gi;

function leftoverSet(text: string): boolean {
  return /\bset\b/i.test(text.replace(ALLOWED_SET, " "));
}

/** The assignments `name [type] := expr` in a body (declare and executable parts). */
function assignments(code: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const m of code.matchAll(/\b([A-Za-z_]\w*)\s+(?:uuid|text|jsonb|integer|bigint|boolean|timestamptz)?\s*:=\s*([^;]*)/gi)) {
    const key = (m[1] as string).toLowerCase();
    map.set(key, [...(map.get(key) ?? []), m[2] as string]);
  }
  return map;
}

/** True when identifier `name` is (transitively, three steps) assigned from an expression matching `source`. */
function derivesFrom(name: string, map: Map<string, string[]>, source: RegExp, depth = 0): boolean {
  if (depth > 3) return false;
  for (const expr of map.get(name.toLowerCase()) ?? []) {
    if (source.test(expr)) return true;
    for (const id of expr.match(/[A-Za-z_]\w*/g) ?? []) {
      if (id.toLowerCase() !== name.toLowerCase() && map.has(id.toLowerCase()) && derivesFrom(id, map, source, depth + 1)) return true;
    }
  }
  return false;
}

const KEYWORDS_AFTER_TABLE = new Set(["where", "join", "inner", "left", "right", "full", "cross", "on", "using", "group", "order", "limit", "for", "union"]);
const CONSTANT_CONDITION = /\b(?:true|false)\b|\b1\s*=\s*1\b|\bnull\s+is\s+null\b/i;

/** The mandatory shape of the live-session check inside a guard. Returns violation messages. */
function checkLiveSession(def: Definition, parts: { declare: string; exec: string }): string[] {
  const problems: string[] = [];
  const { exec } = parts;
  const whole = `${parts.declare} ${exec}`;
  const notExists = /not\s+exists\s*\(\s*select\b/i.exec(exec);
  if (!notExists) return ["guard must refuse when `not exists (select ... from auth.sessions ...)` finds no live session"];
  const open = exec.indexOf("(", notExists.index);
  const sub = balanced(exec, open);
  if (sub === null) return ["guard live-session subquery is unbalanced"];

  if (!/\bfrom\s+auth\.sessions\b/i.test(sub)) problems.push("the not-exists subquery must read auth.sessions");
  const aliasMatch = /\bauth\.sessions\s+(?:as\s+)?([A-Za-z_]\w*)/i.exec(sub);
  const alias = aliasMatch && !KEYWORDS_AFTER_TABLE.has((aliasMatch[1] as string).toLowerCase()) ? (aliasMatch[1] as string) : null;
  const rhs = (col: string): string | null => {
    const re = alias
      ? new RegExp(`\\b${escapeRegExp(alias)}\\.${col}\\s*=\\s*\\(?\\s*([A-Za-z_]\\w*)\\b`, "i")
      : new RegExp(`(?<![.\\w])${col}\\s*=\\s*\\(?\\s*([A-Za-z_]\\w*)\\b`, "i");
    const m = re.exec(sub);
    return m ? (m[1] as string) : null;
  };
  const map = assignments(whole);
  const sid = rhs("id");
  if (!sid) problems.push("the session row must be matched by its id (sessions.id = the JWT session_id variable)");
  else if (!derivesFrom(sid, map, /auth\.jwt\s*\(\s*\)\s*->>\s*'S'/i) || !def.body.literals.includes("session_id")) {
    problems.push("the session id compared to sessions.id must come from auth.jwt() ->> 'session_id'");
  }
  const uid = rhs("user_id");
  if (!uid) problems.push("the session row must belong to the caller (sessions.user_id = auth.uid())");
  else if (!derivesFrom(uid, map, /auth\.uid\s*\(\s*\)/i)) problems.push("the user compared to sessions.user_id must come from auth.uid()");
  if (!/not_after/i.test(sub)) problems.push("the subquery must check not_after (session expiry)");
  if (!/deleted_at/i.test(sub)) problems.push("the subquery must check deleted_at");
  if (!/banned_until/i.test(sub)) problems.push("the subquery must check banned_until");
  if (CONSTANT_CONDITION.test(sub)) problems.push("the live-session subquery must not contain constant conditions (true/false/1=1)");

  // The enclosing IF condition and its THEN branch.
  const beforeCheck = exec.slice(0, notExists.index);
  // The last real IF before the check (an `END IF` is not an IF).
  const ifMatches = [...beforeCheck.matchAll(/(?<!\bend\s+)\bif\b/gi)];
  const ifIdx = ifMatches.length > 0 ? (ifMatches[ifMatches.length - 1] as RegExpMatchArray).index ?? -1 : -1;
  const afterCheck = exec.slice(open + sub.length + 2);
  const thenIdx = afterCheck.search(/\bthen\b/i);
  const semi = afterCheck.indexOf(";");
  if (ifIdx < 0 || thenIdx < 0 || (semi >= 0 && thenIdx > semi)) {
    problems.push("the check must be the condition of an IF whose THEN branch raises");
  } else {
    const condition = `${beforeCheck.slice(ifIdx)} ${afterCheck.slice(0, thenIdx)}`;
    if (CONSTANT_CONDITION.test(condition)) problems.push("the guard condition must not contain constant conditions (true/false/1=1)");
    if (!/^\s*then\s+raise\s+(?:sqlstate\b|exception\b)/i.test(afterCheck.slice(thenIdx))) {
      problems.push("the THEN branch must `raise sqlstate ...` or `raise exception ...` (raise notice/warning does not abort)");
    }
    if (/\band\s+false\b|\bor\s+true\b/i.test(condition)) problems.push("the guard condition must not be neutralised with and false / or true");
  }
  const ret = /\breturn\b/i.exec(exec);
  if (ret && ret.index < notExists.index) problems.push("the live-session check must come before the first RETURN");

  // Format check before any ::uuid cast so a malformed claim fails with the guard's error, not 22P02.
  const castIdx = exec.search(/::\s*uuid\b/i);
  const fmtIdx = exec.search(/!?~\*?/);
  const declCast = /::\s*uuid\b/i.test(parts.declare);
  if (declCast || (castIdx >= 0 && (fmtIdx < 0 || fmtIdx > castIdx))) {
    problems.push("the session_id format must be validated (regex match that raises) before it is cast to uuid, and the cast must not be in the declare section");
  }
  if (/\bexception\s+when\b/i.test(whole)) problems.push("guards must not catch exceptions (`exception when ...`)");
  if (/\bexecute\b/i.test(whole)) problems.push("guards must not use dynamic SQL");
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------------------------------------------

const GUARDS = Object.keys(ACCOUNT_GUARD_FUNCTIONS) as AccountGuard[];
const RPCS = Object.keys(ACCOUNT_RPC_GUARDS) as AccountRpcName[];

export function lintAccountMigration(sql: string, options: { skipRpcNames?: readonly AccountRpcName[] } = {}): Violation[] {
  const out: Violation[] = [];
  const add = (rule: string, target: string, message: string) => out.push({ rule, target, message });
  const top = scanSql(sql);
  const statements = top.code.split(";").map((s) => s.trim()).filter(Boolean);

  const guardNames = new Map(GUARDS.map((g) => [ACCOUNT_GUARD_FUNCTIONS[g].toLowerCase(), g]));
  const rpcNames = new Map(RPCS.map((r) => [`public.${r}`.toLowerCase(), r]));
  const skipped = new Set(options.skipRpcNames ?? []);
  const helpers = new Set(ACCOUNT_HELPER_FUNCTIONS.map((h) => h.toLowerCase()));
  const known = new Set<string>([...guardNames.keys(), ...RPCS.filter((r) => !skipped.has(r)).map((r) => `public.${r}`.toLowerCase())]);
  const allowedNames = new Set<string>([...known, ...helpers]);

  // --- global bans ---------------------------------------------------------------------------------------------
  if (/"/.test(top.code)) add("quoted-identifier", "database", "quoted identifiers are not allowed in an account migration (they hide names from the linter)");
  if (/\balter\s+default\s+privileges\b/i.test(top.code)) add("default-privileges", "database", "ALTER DEFAULT PRIVILEGES is forbidden in an account migration");
  for (const s of statements) {
    if (/^create\s+(?:or\s+replace\s+)?(?:procedure|view|materialized\s+view|rule|trigger|aggregate|operator|cast)\b/i.test(s)) {
      add("forbidden-object", s.slice(0, 60), "procedures, views, rules and triggers are not allowed in an account migration");
    }
    if (/^do\b/i.test(s)) {
      const m = /\$BODY(\d+)\$/.exec(s);
      const body = m ? top.bodies[Number(m[1])] : undefined;
      if (body !== undefined && /\bexecute\b|\bformat\s*\(/i.test(scanSql(body).code) && !hasOnlyGuildbookCompatibilityDynamicSql(body)) {
        add("dynamic-ddl", "do-block", "DO blocks must not use dynamic SQL (execute/format): it would be invisible to this check");
      }
    }
  }

  // --- function definitions ------------------------------------------------------------------------------------
  const defs: Definition[] = [];
  const created: string[] = [];
  for (const s of statements) {
    if (!/^create\s+(?:or\s+replace\s+)?function\b/i.test(s)) continue;
    const head = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?function\\s+(${NAME.source})\\s*\\(`, "i").exec(s);
    if (!head) {
      add("unsupported-name", s.slice(0, 60), "function names must be unquoted schema.name identifiers");
      continue;
    }
    const name = (head[1] as string).toLowerCase();
    created.push(name);
    const open = s.indexOf("(", head.index);
    const args = balanced(s, open);
    const afterArgs = args === null ? "" : s.slice(open + args.length + 2);
    const bodyRef = /\bas\s+\$BODY(\d+)\$/i.exec(afterArgs);
    const body = bodyRef ? top.bodies[Number(bodyRef[1])] : undefined;
    if (args === null || !bodyRef || body === undefined) {
      add("unsupported-body", name, "the body must be a dollar-quoted plpgsql block (no single-quoted, `begin atomic` or `return expr` bodies)");
      continue;
    }
    defs.push({ name, attrs: afterArgs.replace(/\bas\s+\$BODY\d+\$/i, " "), body: scanSql(body) });
  }
  for (const name of new Set(created)) {
    if (!allowedNames.has(name)) {
      add(/^public\.(fdb_account_|fdb_installation_)|^private\.fdb_(caller|anonymous_caller|registered_caller)/.test(name) ? "unknown-function" : "unregistered-function", name, "not in the registry (add it to ACCOUNT_RPC_GUARDS or ACCOUNT_HELPER_FUNCTIONS in a reviewed change first)");
    }
  }
  for (const name of known) {
    const count = created.filter((x) => x === name).length;
    if (count === 0) add(guardNames.has(name) ? "guard-missing" : "function-missing", name, "not defined");
    if (count > 1) add("duplicate-definition", name, `defined ${count} times (later definitions and overloads would override the reviewed one)`);
  }

  // --- ALTER / GRANT / REVOKE whitelist ------------------------------------------------------------------------
  const alterSearchPath = new Set<string>();
  for (const s of statements) {
    const alter = /^alter\s+(function|routine|procedure)\s+([\s\S]*)$/i.exec(s);
    if (alter) {
      const text = alter[2] as string;
      const named = /(?:^|[^\w.])(?:private|public)\.(?:fdb_\w+)/i.test(text);
      const ok = new RegExp(`^(${NAME.source})\\s*\\([^)]*\\)\\s+(set\\s+(?:search_path\\s*(?:=|to)\\s*''|(?:statement_timeout|lock_timeout)\\s*(?:=|to)\\s*(?:'S'|\\d+)))\\s*$`, "i").exec(text);
      if (/^(routine|procedure)$/i.test(alter[1] as string) && named) add("alter-function", text.slice(0, 60), "ALTER ROUTINE/PROCEDURE on an account function is forbidden");
      else if (named && !ok) add("alter-function", text.slice(0, 60), "ALTER FUNCTION may only set search_path = '', statement_timeout or lock_timeout, one clause per statement (no security invoker, reset, rename, owner, schema or chained changes)");
      if (ok && /search_path/i.test(ok[2] as string)) alterSearchPath.add((ok[1] as string).toLowerCase());
    }
    if (/^(grant|revoke)\b/i.test(s)) {
      if (/\b(routine|routines|procedure|procedures)\b/i.test(s) || /\ball\s+functions\b[\s\S]*\bschema\s+public\b/i.test(s)) {
        add("blanket-grant", s.slice(0, 60), "GRANT/REVOKE on routines, procedures or all functions in schema public is forbidden");
      }
      if (/^grant\b/i.test(s) && !/\bon\b/i.test(s)) add("role-grant", s.slice(0, 60), "role membership grants are forbidden in an account migration");
      if (/^grant\b[\s\S]*\ball\s+functions\b/i.test(s)) add("blanket-grant", s.slice(0, 60), "GRANT ... ON ALL FUNCTIONS is forbidden");
    }
  }
  const functionPrivs = (kind: "grant" | "revoke") => {
    const found: { names: string[]; roles: string }[] = [];
    for (const s of statements) {
      const m = new RegExp(`^${kind}\\b[\\s\\S]*?\\bon\\s+function\\s+([\\s\\S]*?)\\s+${kind === "grant" ? "to" : "from"}\\s+([\\s\\S]+)$`, "i").exec(s);
      if (!m) continue;
      const names = [...(m[1] as string).matchAll(new RegExp(`(${NAME.source})\\s*(?:\\([^)]*\\))?`, "g"))].map((x) => (x[1] as string).toLowerCase());
      found.push({ names, roles: (m[2] as string).toLowerCase() });
    }
    return found;
  };
  const grants = functionPrivs("grant");
  const revokes = functionPrivs("revoke");
  for (const g of grants) {
    for (const name of g.names) {
      if (guardNames.has(name)) add("guard-grant", name, "guards must not be granted to any client role");
      else if (rpcNames.has(name) && /\b(anon|public|service_role)\b/.test(g.roles)) add("grant", name, "must not grant execute to anon, public or service_role");
    }
  }
  const lastCreate = Math.max(-1, ...[...top.code.matchAll(/create\s+(?:or\s+replace\s+)?function\b/gi)].map((m) => m.index ?? 0));
  const schemaRevoke = /revoke\s+all\s+on\s+all\s+functions\s+in\s+schema\s+private\s+from\s+([^;]+)/i.exec(top.code);
  const schemaRevokeAfterCreates = !!schemaRevoke && (schemaRevoke.index ?? 0) > lastCreate && /\bpublic\b/i.test(schemaRevoke[1] as string) && /\banon\b/i.test(schemaRevoke[1] as string) && /\bauthenticated\b/i.test(schemaRevoke[1] as string);
  const fullRoles = (roles: string) => ["public", "anon", "authenticated", "service_role"].every((r) => new RegExp(`\\b${r}\\b`).test(roles));
  for (const g of GUARDS) {
    const name = ACCOUNT_GUARD_FUNCTIONS[g].toLowerCase();
    const ok = revokes.some((r) => r.names.includes(name) && /\bpublic\b/.test(r.roles) && /\banon\b/.test(r.roles) && /\bauthenticated\b/.test(r.roles));
    if (!ok && !schemaRevokeAfterCreates) add("guard-grants", name, "guard must not be callable by clients: revoke from public, anon and authenticated (a schema-wide revoke only counts after the last function is created)");
  }

  // --- guards --------------------------------------------------------------------------------------------------------
  for (const def of defs.filter((d) => guardNames.has(d.name))) {
    const guard = guardNames.get(def.name) as AccountGuard;
    const name = def.name;
    const parts = bodyParts(def.body.code);
    if (!/security\s+definer/i.test(def.attrs)) add("guard-security-definer", name, "guard must be SECURITY DEFINER (it reads auth.sessions)");
    if (!/language\s+plpgsql\b/i.test(def.attrs)) add("guard-language", name, "guard must be plpgsql");
    if (/\b(stable|immutable)\b/i.test(def.attrs)) add("guard-volatile", name, "guard must be VOLATILE (a STABLE function cannot lock the session row and may be cached)");
    if (!/set\s+search_path\s*(?:=|to)\s*''(?!\s*,)/i.test(def.attrs) && !alterSearchPath.has(name)) add("guard-search-path", name, "guard must set search_path = ''");
    if (leftoverSet(def.attrs)) add("header-set", name, "only `set search_path = ''`, `set statement_timeout` and `set lock_timeout` clauses are allowed");
    if (guard === "any_live_session") {
      if (!/auth\.jwt\s*\(\s*\)/i.test(def.body.code) || !def.body.literals.includes("session_id")) add("guard-live-session", name, "guard must read the session_id claim from auth.jwt()");
      for (const message of checkLiveSession(def, parts)) add("guard-live-session", name, message);
    } else {
      const callsBase = /^\s*(?:perform\s+private\.fdb_caller\s*\(\s*\)|[A-Za-z_]\w*\s*:=\s*private\.fdb_caller\s*\(\s*\))\s*;/i.test(parts.exec);
      if (!callsBase) add("guard-live-session", name, "guard must call private.fdb_caller() as its first statement");
      const ret = /\breturn\b/i.exec(parts.exec);
      const head = ret ? parts.exec.slice(0, ret.index) : parts.exec;
      if (!/\braise\s+(?:sqlstate\b|exception\b)/i.test(head)) add("guard-live-session", name, "guard must raise (sqlstate/exception) before returning when the identity kind is wrong");
      if (!/is_anonymous/i.test(head)) add("guard-live-session", name, "guard must check is_anonymous");
      if (guard === "registered_live_session" && !/email_confirmed_at/i.test(head)) add("guard-live-session", name, "guard must check email_confirmed_at");
      if (CONSTANT_CONDITION.test(head)) add("guard-live-session", name, "guard conditions must not contain constants (true/false/1=1)");
      if (/\bexception\s+when\b/i.test(def.body.code) || /\bexecute\b/i.test(def.body.code)) add("guard-live-session", name, "guards must not catch exceptions or use dynamic SQL");
    }
  }

  // --- public account functions ----------------------------------------------------------------------------------
  for (const def of defs.filter((d) => rpcNames.has(d.name))) {
    const rpc = rpcNames.get(def.name) as AccountRpcName;
    const qualified = def.name;
    const required = ACCOUNT_GUARD_FUNCTIONS[ACCOUNT_RPC_GUARDS[rpc]];
    const parts = bodyParts(def.body.code);
    if (!/security\s+definer/i.test(def.attrs)) add("security-definer", qualified, "must be SECURITY DEFINER");
    if (!/language\s+plpgsql\b/i.test(def.attrs)) add("language", qualified, "must be plpgsql so the guard runs before any other statement");
    if (/\b(stable|immutable)\b/i.test(def.attrs)) add("volatility", qualified, "must be VOLATILE (it writes budgets, locks and audit rows)");
    if (!/set\s+search_path\s*(?:=|to)\s*''(?!\s*,)/i.test(def.attrs) && !alterSearchPath.has(qualified)) add("search-path", qualified, "must set search_path = ''");
    if (leftoverSet(def.attrs)) add("header-set", qualified, "only `set search_path = ''`, `set statement_timeout` and `set lock_timeout` clauses are allowed");

    const escapedGuard = escapeRegExp(required);
    const first = new RegExp(`^\\s*(?:perform\\s+${escapedGuard}\\s*\\(\\s*\\)|[A-Za-z_]\\w*\\s*:=\\s*${escapedGuard}\\s*\\(\\s*\\))\\s*;`, "i").exec(parts.exec);
    if (!first) add("guard-first", qualified, `first statement after BEGIN must call ${required}() (live-session identity guard)`);
    // Nothing may read identity or data before the guard: the DECLARE section too.
    if (/auth\.|\bselect\b|\bfrom\b|\bfdb_|private\./i.test(parts.declare)) add("identity-before-guard", qualified, "the DECLARE section must not read identity or data (no auth.*, select, or function calls before the guard)");
    const afterGuard = first ? parts.exec.slice(first[0].length) : parts.exec;
    const beforeGuard = first ? "" : parts.exec;
    if (/auth\.uid\s*\(\s*\)|auth\.jwt\s*\(\s*\)|is_anonymous/i.test(beforeGuard)) add("identity-before-guard", qualified, "identity is read before the guard");
    if (/auth\.uid\s*\(\s*\)/i.test(afterGuard)) add("uid-outside-guard", qualified, "the UID is the guard's return value; calling auth.uid() again in the function body is forbidden");
    if (/\bexception\s+when\b/i.test(def.body.code)) add("exception-swallow", qualified, "account functions must not catch exceptions (`exception when ...`): a swallowed guard failure would leak data");
    if (/\bexecute\b/i.test(def.body.code)) add("dynamic-sql", qualified, "account functions must not use dynamic SQL");

    const escapedName = escapeRegExp(qualified);
    void escapedName;
    const revoked = revokes.some((r) => r.names.includes(qualified) && fullRoles(r.roles));
    if (!revoked) add("revoke", qualified, "must revoke all from public, anon, authenticated and service_role before granting");
    const granted = grants.filter((g) => g.names.includes(qualified));
    if (!granted.some((g) => /\bauthenticated\b/.test(g.roles))) add("grant", qualified, "must grant execute to authenticated");
  }
  return out;
}

/**
 * 0016 must be able to follow 0018 in either migration order. PostgreSQL has
 * no static conditional ALTER/REVOKE form, so that compatibility transition
 * uses catalog-checked dynamic statements. Keep this exception exact: no
 * caller data is interpolated, and every role/function target is fixed or
 * catalog-derived solely from the Guildbook RPC family.
 */
function hasOnlyGuildbookCompatibilityDynamicSql(body: string): boolean {
  let residual = body;
  for (const statement of [
    "execute 'select exists (select 1 from private.guildbook_cloud_sync_guard where guard_name = ''disabled'')'",
    "execute 'alter function private.foreverdb_ingest_snapshot_impl_v1(jsonb) rename to foreverdb_ingest_snapshot_impl_v1_legacy'",
    "execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig)",
  ]) {
    residual = residual.split(statement).join("");
  }

  // The exception only applies to the intended compatibility migration. A
  // generic DO block with EXECUTE/FORMAT must still trip the linter.
  if (!/guildbook_cloud_sync_guard|foreverdb_ingest_snapshot_impl_v1_legacy/.test(body)) return false;
  return !/\bexecute\b|\bformat\s*\(/i.test(scanSql(residual).code);
}
