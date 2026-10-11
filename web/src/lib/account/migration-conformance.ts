/**
 * Account System V1 — migration conformance linter (pure text analysis, no I/O, browser/Node neutral).
 *
 * Purpose: make it impossible for the ownership/Guildbook migration (PR C, `0012_*.sql`) to implement an account
 * function with a weaker identity check than the specification demands. In particular, claim initiation guarded only by
 * `auth.uid()` and `is_anonymous` fails: every account function must call its registry guard as the FIRST statement, and
 * every guard must verify a LIVE session (`auth.sessions` row for the JWT's `session_id`, same user, not expired) and that
 * the user is neither deleted nor banned. It also checks SECURITY DEFINER, `search_path = ''`, and explicit grants.
 *
 * It is a lint, not a proof: the SQL integration suite (revoked-but-unexpired JWT tests) remains mandatory.
 * Spec: docs/account-v1/ownership-claim-protocol.md section 4 and docs/account-v1/pr-obligations.md.
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

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

interface FunctionText {
  header: string;
  body: string;
}

/** Finds `create [or replace] function <qualified name>(...) ... as $tag$ body $tag$`. */
function findFunction(sql: string, qualifiedName: string): FunctionText | null {
  const escaped = escapeRegExp(qualifiedName);
  const start = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+${escaped}\\s*\\(`, "i").exec(sql);
  if (!start) return null;
  const rest = sql.slice(start.index);
  const open = /\bas\s+(\$[a-z_0-9]*\$)/i.exec(rest);
  if (!open || open[1] === undefined) return null;
  const tag = open[1];
  const bodyStart = open.index + open[0].length;
  const end = rest.indexOf(tag, bodyStart);
  if (end < 0) return null;
  return { header: rest.slice(0, open.index), body: rest.slice(bodyStart, end) };
}

function hasSearchPath(sql: string, qualifiedName: string, fn: FunctionText): boolean {
  if (/set\s+search_path\s*(?:=|to)\s*(?:''|""|'\s*')/i.test(fn.header)) return true;
  const escaped = escapeRegExp(qualifiedName);
  return new RegExp(`alter\\s+function\\s+${escaped}\\s*\\([^)]*\\)\\s+set\\s+search_path\\s*(?:=|to)\\s*''`, "i").test(sql);
}

interface Requirement {
  label: string;
  /** Tested against the executable part of the body (after BEGIN) unless `anywhere` is set. */
  re: RegExp;
  anywhere?: boolean;
}

/**
 * What a guard must actually DO, tested on the executable part so that merely declaring a variable
 * (`v_sid uuid := ... 'session_id'`) and never using it cannot pass.
 */
const GUARD_REQUIREMENTS: Record<AccountGuard, readonly Requirement[]> = {
  any_live_session: [
    { label: "auth.jwt() (session_id claim)", re: /auth\.jwt\s*\(\s*\)/i, anywhere: true },
    { label: "session_id", re: /session_id/i, anywhere: true },
    { label: "auth.uid()", re: /auth\.uid\s*\(\s*\)/i, anywhere: true },
    { label: "a query on auth.sessions", re: /\bfrom\s+auth\.sessions\b/i },
    { label: "the session id matched (id =)", re: /\bid\s*=/i },
    { label: "the session user matched (user_id =)", re: /\buser_id\s*=/i },
    { label: "not_after (session expiry)", re: /not_after/i },
    { label: "deleted_at", re: /deleted_at/i },
    { label: "banned_until", re: /banned_until/i },
  ],
  anonymous_owner_live_session: [
    { label: "private.fdb_caller()", re: /private\.fdb_caller\s*\(\s*\)/i },
    { label: "is_anonymous", re: /is_anonymous/i },
  ],
  registered_live_session: [
    { label: "private.fdb_caller()", re: /private\.fdb_caller\s*\(\s*\)/i },
    { label: "is_anonymous", re: /is_anonymous/i },
    { label: "email_confirmed_at", re: /email_confirmed_at/i },
  ],
};

function executablePart(body: string): string {
  const begin = /\bbegin\b/i.exec(body);
  return begin ? body.slice(begin.index + begin[0].length) : "";
}

export function lintAccountMigration(rawSql: string): Violation[] {
  const sql = stripComments(rawSql);
  const out: Violation[] = [];
  const add = (rule: string, target: string, message: string) => out.push({ rule, target, message });

  // --- guard implementations ---------------------------------------------------------------------------
  for (const guard of Object.keys(ACCOUNT_GUARD_FUNCTIONS) as AccountGuard[]) {
    const name = ACCOUNT_GUARD_FUNCTIONS[guard];
    const fn = findFunction(sql, name);
    if (!fn) {
      add("guard-missing", name, "guard function is not defined");
      continue;
    }
    if (!/security\s+definer/i.test(fn.header)) add("guard-security-definer", name, "guard must be SECURITY DEFINER (it reads auth.sessions)");
    if (!hasSearchPath(sql, name, fn)) add("guard-search-path", name, "guard must set search_path = ''");
    const exec = executablePart(fn.body);
    for (const req of GUARD_REQUIREMENTS[guard]) {
      if (!req.re.test(req.anywhere ? fn.body : exec)) add("guard-live-session", name, `guard must verify ${req.label}`);
    }
  }
  if (!/revoke\s+all\s+on\s+all\s+functions\s+in\s+schema\s+private\b/i.test(sql)) {
    for (const guard of Object.keys(ACCOUNT_GUARD_FUNCTIONS) as AccountGuard[]) {
      const name = escapeRegExp(ACCOUNT_GUARD_FUNCTIONS[guard]);
      if (!new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${name}\\s*\\([^)]*\\)\\s+from[^;]*\\banon\\b`, "i").test(sql)) {
        add("guard-grants", ACCOUNT_GUARD_FUNCTIONS[guard], "guard must not be callable by clients (revoke from public, anon, authenticated)");
      }
    }
  }

  // --- public account functions --------------------------------------------------------------------------
  for (const rpc of Object.keys(ACCOUNT_RPC_GUARDS) as AccountRpcName[]) {
    const qualified = `public.${rpc}`;
    const required = ACCOUNT_GUARD_FUNCTIONS[ACCOUNT_RPC_GUARDS[rpc]];
    const fn = findFunction(sql, qualified);
    if (!fn) {
      add("function-missing", qualified, "account function is not defined");
      continue;
    }
    if (!/security\s+definer/i.test(fn.header)) add("security-definer", qualified, "must be SECURITY DEFINER");
    if (!/language\s+plpgsql/i.test(fn.header)) add("language", qualified, "must be plpgsql so the guard runs before any other statement");
    if (!hasSearchPath(sql, qualified, fn)) add("search-path", qualified, "must set search_path = ''");

    // First statement after the first BEGIN must be the required guard.
    const begin = /\bbegin\b/i.exec(fn.body);
    const afterBegin = begin ? fn.body.slice(begin.index + begin[0].length) : "";
    const escapedGuard = escapeRegExp(required);
    const first = new RegExp(`^\\s*(?:perform\\s+${escapedGuard}\\s*\\(\\s*\\)|[a-z_][a-z0-9_]*\\s*:=\\s*${escapedGuard}\\s*\\(\\s*\\))\\s*;`, "i").exec(afterBegin);
    if (!first) {
      add("guard-first", qualified, `first statement must call ${required}() (live-session identity guard)`);
    }
    const guardPos = first ? first[0].length : -1;
    const uidUse = /auth\.uid\s*\(\s*\)|auth\.jwt\s*\(\s*\)|is_anonymous/i.exec(afterBegin);
    if (uidUse && (guardPos < 0 || uidUse.index < guardPos)) {
      add("identity-before-guard", qualified, "identity is read (auth.uid()/auth.jwt()/is_anonymous) before the guard; the guard must come first and be the only source of identity");
    }

    // Grants: revoke from public/anon/authenticated/service_role, grant to authenticated only.
    const escapedName = escapeRegExp(qualified);
    if (!new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${escapedName}\\s*\\([^)]*\\)\\s+from[^;]*\\bpublic\\b[^;]*\\banon\\b`, "i").test(sql)) {
      add("revoke", qualified, "must revoke all from public and anon (and authenticated, service_role) before granting");
    }
    const grants = [...sql.matchAll(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${escapedName}\\s*\\([^)]*\\)\\s+to\\s+([^;]+);`, "gi"))].map((m) => (m[1] ?? "").toLowerCase());
    if (!grants.some((g) => /\bauthenticated\b/.test(g))) add("grant", qualified, "must grant execute to authenticated");
    if (grants.some((g) => /\b(anon|public|service_role)\b/.test(g))) add("grant", qualified, "must not grant execute to anon, public or service_role");
  }
  return out;
}
