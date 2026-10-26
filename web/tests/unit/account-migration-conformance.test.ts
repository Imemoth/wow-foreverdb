import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_GUARD_FUNCTIONS, ACCOUNT_HELPER_FUNCTIONS, ACCOUNT_RPC_GUARDS, ACCOUNT_RPCS } from "@/lib/account/contracts";
import { escapeRegExp, lintAccountMigration, scanSql } from "@/lib/account/migration-conformance";

/**
 * The account migration (PR C, database/migrations/0012_*.sql) must implement every account function behind a LIVE-SESSION
 * identity guard. The linter is a TRIPWIRE (the SQL tests against real sessions are the proof); these tests pin it with a
 * canonical conformant fixture and with every bypass the independent reviews demonstrated.
 */

type Rpc = keyof typeof ACCOUNT_RPC_GUARDS;
const ARGS: Record<Rpc, string> = {
  fdb_account_claim_start: "p_installation_id text",
  fdb_account_claim_redeem: "p_code text",
  fdb_account_guildbook_ingest: "p_installation_id text, p_capture_id text, p_captured_at bigint, p_source_character text, p_guilds jsonb",
  fdb_account_installations: "",
  fdb_account_guildbook_guilds: "p_installation_id text",
  fdb_account_guildbook_guilds_scoped: "p_installation_id text",
  fdb_account_guildbook_members: "p_installation_id text, p_guild_key text, p_limit integer, p_offset integer",
  fdb_account_guildbook_members_scoped: "p_installation_id text, p_guild_key text, p_limit integer, p_offset integer",
  fdb_installation_link_status: "p_installation_id text",
};
const TYPES: Record<Rpc, string> = {
  fdb_account_claim_start: "text",
  fdb_account_claim_redeem: "text",
  fdb_account_guildbook_ingest: "text, text, bigint, text, jsonb",
  fdb_account_installations: "",
  fdb_account_guildbook_guilds: "text",
  fdb_account_guildbook_guilds_scoped: "text",
  fdb_account_guildbook_members: "text, text, integer, integer",
  fdb_account_guildbook_members_scoped: "text, text, integer, integer",
  fdb_installation_link_status: "text",
};
const RPC_NAMES = Object.keys(ARGS) as Rpc[];

const LIVE = `exists (select 1 from auth.sessions s join auth.users u on u.id = s.user_id
  where s.id = v_sid and s.user_id = v_uid and (s.not_after is null or s.not_after > now())
    and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now()))`;

interface GuardOverrides {
  anyAttrs?: string;
  anyDeclare?: string;
  anyBody?: string;
  anonBody?: string;
  regBody?: string;
}

const DEFAULT_ANY_BODY = `
  if auth.role() is distinct from 'authenticated' or v_uid is null or v_claim is null or v_claim !~* '^[0-9a-f-]{36}$'
  then raise sqlstate 'PT401' using message = 'ForeverDB authenticated session required'; end if;
  v_sid := v_claim::uuid;
  if not ${LIVE} then raise sqlstate 'PT401' using message = 'ForeverDB authenticated session required'; end if;
  return v_uid;`;

function guardSql(o: GuardOverrides = {}): string {
  return `
create function private.fdb_caller() returns uuid
as $g1$
declare ${o.anyDeclare ?? `v_uid uuid := auth.uid(); v_claim text := auth.jwt() ->> 'session_id'; v_sid uuid;`}
begin ${o.anyBody ?? DEFAULT_ANY_BODY}
end $g1$ ${o.anyAttrs ?? "language plpgsql security definer set search_path = ''"};
create function private.fdb_anonymous_caller() returns uuid language plpgsql security definer set search_path = '' as $g2$
declare v_uid uuid;
begin ${o.anonBody ?? `v_uid := private.fdb_caller(); if not (select is_anonymous from auth.users where id = v_uid) then raise sqlstate 'PT403'; end if; return v_uid;`}
end $g2$;
create function private.fdb_registered_caller() returns uuid language plpgsql security definer set search_path = '' as $g3$
declare v_uid uuid;
begin ${o.regBody ?? `v_uid := private.fdb_caller(); if not exists (select 1 from auth.users where id = v_uid and not is_anonymous and email_confirmed_at is not null) then raise sqlstate 'PT403'; end if; return v_uid;`}
end $g3$;
`;
}

interface FnOverrides {
  header?: string;
  declare?: string;
  body?: string;
  grants?: string;
}

function fnSql(name: Rpc, o: FnOverrides = {}): string {
  const guard = ACCOUNT_GUARD_FUNCTIONS[ACCOUNT_RPC_GUARDS[name]];
  return `
create or replace function public.${name}(${ARGS[name]}) returns jsonb
${o.header ?? "language plpgsql security definer set search_path = ''"}
as $fn$
declare ${o.declare ?? "v_uid uuid;"}
begin
  ${o.body ?? `v_uid := ${guard}(); return jsonb_build_object('ok', true);`}
end $fn$;
${o.grants ?? `revoke all on function public.${name}(${TYPES[name]}) from public, anon, authenticated, service_role;
grant execute on function public.${name}(${TYPES[name]}) to authenticated;`}
`;
}

interface Opts {
  guards?: GuardOverrides;
  per?: Partial<Record<Rpc, FnOverrides>>;
  skip?: Rpc[];
  tail?: string;
  noSchemaRevoke?: boolean;
}

function migration(opts: Opts = {}): string {
  return (
    guardSql(opts.guards) +
    RPC_NAMES.filter((n) => !(opts.skip ?? []).includes(n))
      .map((n) => fnSql(n, opts.per?.[n]))
      .join("\n") +
    (opts.tail ?? "") +
    (opts.noSchemaRevoke ? "" : "\nrevoke all on all functions in schema private from public, anon, authenticated;\n")
  );
}

const rules = (sql: string) => lintAccountMigration(sql).map((v) => `${v.rule}:${v.target}`);
const messages = (sql: string, target?: string) =>
  lintAccountMigration(sql)
    .filter((v) => !target || v.target === target)
    .map((v) => v.message)
    .join(" | ");

describe("escapeRegExp", () => {
  it("escapes every metacharacter including the backslash, so the escaped text matches itself literally", () => {
    for (const raw of ["public.fdb_x", "a\\b", "a\\.b", "(x)|[y]{2}+*?^$", "private.fdb_caller\\"]) {
      expect(new RegExp(`^${escapeRegExp(raw)}$`).test(raw), raw).toBe(true);
    }
    expect(new RegExp(`^${escapeRegExp("a.b")}$`).test("axb")).toBe(false);
    expect(new RegExp(`^${escapeRegExp("a\\.b")}$`).test("a\\.b")).toBe(true);
    expect(new RegExp(`^${escapeRegExp("a\\.b")}$`).test("a\\xb")).toBe(false);
  });
});

describe("scanSql tokeniser", () => {
  it("masks comments, literals and dollar-quoted blocks, keeps empty literals", () => {
    const s = scanSql(`select 'a''b', E'x\\'y', '' -- c\n /* n /* m */ k */ $t$ in $u$ $t$ $$z$$ foo$bar$ "id";`);
    expect(s.code).toContain("'S'");
    expect(s.code).toContain("''");
    expect(s.code).not.toMatch(/ in |\bk\b|\bz\b/);
    expect(s.bodies).toEqual([" in $u$ ", "z"]);
    expect(s.code).toContain('"id"');
    expect(s.code).toContain("foo$bar$");
  });
});

describe("account migration conformance linter", () => {
  it("accepts the canonical conformant migration", () => {
    expect(lintAccountMigration(migration())).toEqual([]);
  });

  it("covers every account RPC with a guard that is never weaker than a live session", () => {
    expect(Object.keys(ACCOUNT_RPC_GUARDS).sort()).toEqual(Object.keys(ACCOUNT_RPCS).sort());
    expect(RPC_NAMES.sort()).toEqual(Object.keys(ACCOUNT_RPCS).sort());
    expect(Object.values(ACCOUNT_RPC_GUARDS).every((g) => g.endsWith("live_session"))).toBe(true);
    expect(ACCOUNT_RPC_GUARDS.fdb_account_claim_start).toBe("anonymous_owner_live_session");
    expect(ACCOUNT_RPC_GUARDS.fdb_account_claim_redeem).toBe("registered_live_session");
    expect(ACCOUNT_HELPER_FUNCTIONS).toEqual(["private.fdb_public_snapshot", "private.foreverdb_ingest_snapshot_impl_v1"]);
  });

  describe("the reviewed High finding: claim start without a live session", () => {
    it("REJECTS claim initiation guarded only by auth.uid() and is_anonymous", () => {
      const weak = migration({
        per: {
          fdb_account_claim_start: {
            declare: "v_uid uuid := auth.uid();",
            body: `if not (select is_anonymous from auth.users where id = v_uid) then raise sqlstate 'PT403'; end if; return jsonb_build_object('ok', true);`,
          },
        },
      });
      const r = rules(weak);
      expect(r).toContain("guard-first:public.fdb_account_claim_start");
      expect(r).toContain("identity-before-guard:public.fdb_account_claim_start");
      const weak2 = migration({ per: { fdb_account_claim_start: { body: `v_uid := auth.uid(); if not (select is_anonymous from auth.users where id = v_uid) then raise sqlstate 'PT403'; end if; return null;` } } });
      expect(rules(weak2)).toContain("guard-first:public.fdb_account_claim_start");
      expect(rules(weak2)).toContain("uid-outside-guard:public.fdb_account_claim_start");
    });

    it("REJECTS the weaker guard where the registry demands another (claim_start needs the anonymous guard, redeem the registered one)", () => {
      expect(rules(migration({ per: { fdb_account_claim_redeem: { body: `v_uid := private.fdb_caller(); return null;` } } }))).toContain("guard-first:public.fdb_account_claim_redeem");
      expect(rules(migration({ per: { fdb_account_claim_start: { body: `v_uid := private.fdb_caller(); return null;` } } }))).toContain("guard-first:public.fdb_account_claim_start");
    });
  });

  describe("guards must really check a live session", () => {
    const guardMsgs = (g: GuardOverrides) => messages(migration({ guards: g }), "private.fdb_caller");

    it("REJECTS a guard that only checks auth.uid()", () => {
      const m = guardMsgs({ anyDeclare: "v_uid uuid := auth.uid();", anyBody: `if auth.uid() is null then raise sqlstate 'PT401'; end if; return auth.uid();` });
      expect(m).toContain("session_id claim");
      expect(m).toContain("not exists (select ... from auth.sessions");
    });

    it("REJECTS a guard that declares the session id but never uses it", () => {
      expect(guardMsgs({ anyBody: `if auth.role() is distinct from 'authenticated' or v_uid is null then raise sqlstate 'PT401'; end if; return v_uid;` })).toContain("not exists (select ... from auth.sessions");
    });

    it("REJECTS forgetting expiry, deleted or banned users", () => {
      for (const [drop, label] of [["(s.not_after is null or s.not_after > now())", "not_after"], ["u.deleted_at is null", "deleted_at"], ["(u.banned_until is null or u.banned_until <= now())", "banned_until"]] as const) {
        expect(guardMsgs({ anyBody: DEFAULT_ANY_BODY.replace(drop, "1 > 0") }), label).toContain(label);
      }
    });

    it("B1/B2: queries the tables but never raises", () => {
      expect(rules(migration({ guards: { anyBody: `perform 1 from auth.sessions where id = v_sid and user_id = v_uid and not_after is null; perform deleted_at, banned_until from auth.users; return v_uid;` } }))).toContain("guard-live-session:private.fdb_caller");
    });

    it("B3: required words only in comments or string literals", () => {
      const body = `-- not exists (select 1 from auth.sessions s where s.id = v_sid and s.user_id = v_uid and not_after and deleted_at and banned_until) then raise\n raise notice 'not exists (select 1 from auth.sessions s where s.id = v_sid and s.user_id = v_uid) then raise'; return v_uid;`;
      expect(rules(migration({ guards: { anyBody: body } }))).toContain("guard-live-session:private.fdb_caller");
    });

    it("B4: the check is dead code after RETURN", () => {
      expect(guardMsgs({ anyBody: `return v_uid; if not ${LIVE} then raise sqlstate 'PT401'; end if;` })).toMatch(/before the first RETURN/);
    });

    it("the unrelated `u.id = s.user_id` does not satisfy the session id match, and a missing user binding is caught", () => {
      const noId = `if auth.role() is distinct from 'authenticated' or v_uid is null then raise sqlstate 'PT401'; end if; v_sid := v_claim::uuid; if not exists (select 1 from auth.sessions s join auth.users u on u.id = s.user_id where s.user_id = v_uid and (s.not_after is null or s.not_after > now()) and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())) then raise sqlstate 'PT401'; end if; return v_uid;`;
      expect(guardMsgs({ anyBody: noId.replace("v_sid := v_claim::uuid;", "v_claim !~* 'x'; v_sid := v_claim::uuid;") })).toMatch(/matched by its id/);
      const noUser = DEFAULT_ANY_BODY.replace("s.user_id = v_uid and ", "");
      expect(guardMsgs({ anyBody: noUser })).toMatch(/belong to the caller/);
    });

    it("constant tricks: s.id = s.id, and/or constants, `if false and not exists`", () => {
      expect(guardMsgs({ anyBody: DEFAULT_ANY_BODY.replace("s.id = v_sid", "s.id = s.id") })).toMatch(/JWT session_id variable|must come from auth\.jwt/);
      expect(guardMsgs({ anyBody: DEFAULT_ANY_BODY.replace("s.id = v_sid and", "false and s.id = v_sid and") })).toMatch(/constant conditions/);
      expect(guardMsgs({ anyBody: DEFAULT_ANY_BODY.replace("(s.not_after is null or s.not_after > now())", "(s.not_after > now() or true)") })).toMatch(/constant conditions/);
      expect(guardMsgs({ anyBody: DEFAULT_ANY_BODY.replace("if not exists", "if false and not exists").replace("if not ${LIVE}", "x") })).toBeDefined();
      const guarded = DEFAULT_ANY_BODY.replace(/if not (exists \(select 1 from auth\.sessions)/, "if false and not $1");
      expect(guardMsgs({ anyBody: guarded })).toMatch(/constant conditions|neutralised/);
      expect(guardMsgs({ anyBody: DEFAULT_ANY_BODY.replace("then raise sqlstate 'PT401' using message = 'ForeverDB authenticated session required'; end if;\n  return", "then raise notice 'nope'; end if;\n  return") })).toMatch(/raise sqlstate/);
    });

    it("the session id must come from auth.jwt() ->> 'session_id', and its format is validated before the uuid cast", () => {
      expect(guardMsgs({ anyDeclare: "v_uid uuid := auth.uid(); v_claim text := 'a'; v_sid uuid;" })).toMatch(/must come from auth\.jwt/);
      expect(guardMsgs({ anyBody: DEFAULT_ANY_BODY.replace(" or v_claim !~* '^[0-9a-f-]{36}$'", "") })).toMatch(/format must be validated/);
      expect(guardMsgs({ anyDeclare: "v_uid uuid := auth.uid(); v_claim text := auth.jwt() ->> 'session_id'; v_sid uuid := (auth.jwt() ->> 'session_id')::uuid;" })).toMatch(/format must be validated/);
    });

    it("derived guards must raise on the identity kind and may not be neutralised", () => {
      expect(rules(migration({ guards: { anonBody: `v_uid := auth.uid(); if (select is_anonymous from auth.users where id = v_uid) is not true then raise sqlstate 'PT403'; end if; return v_uid;` } }))).toContain("guard-live-session:private.fdb_anonymous_caller");
      expect(rules(migration({ guards: { regBody: `v_uid := auth.uid(); perform 1 from auth.users where id = v_uid and not is_anonymous and email_confirmed_at is not null; return v_uid;` } }))).toContain("guard-live-session:private.fdb_registered_caller");
      expect(rules(migration({ guards: { anonBody: `v_uid := private.fdb_caller(); if false then raise sqlstate 'PT403'; end if; perform is_anonymous; return v_uid;` } }))).toContain("guard-live-session:private.fdb_anonymous_caller");
    });

    it("guards must not swallow exceptions or use dynamic SQL, must be plpgsql and VOLATILE", () => {
      expect(rules(migration({ guards: { anyBody: DEFAULT_ANY_BODY + " exception when others then return v_uid;" } }))).toContain("guard-live-session:private.fdb_caller");
      expect(rules(migration({ guards: { anyAttrs: "language plpgsql stable security definer set search_path = ''" } }))).toContain("guard-volatile:private.fdb_caller");
      expect(rules(migration({ guards: { anyAttrs: "language sql security definer set search_path = ''" } }))).toContain("guard-language:private.fdb_caller");
      expect(rules(migration({ guards: { anyAttrs: "language plpgsql set search_path = ''" } }))).toContain("guard-security-definer:private.fdb_caller");
    });
  });

  describe("account functions", () => {
    it("REJECTS a guard that is not the first statement, or identity read before it (including the DECLARE section)", () => {
      expect(rules(migration({ per: { fdb_account_installations: { body: `perform 1; v_uid := private.fdb_registered_caller(); return null;` } } }))).toContain("guard-first:public.fdb_account_installations");
      expect(rules(migration({ per: { fdb_account_guildbook_guilds: { body: `if auth.uid() is null then return null; end if; v_uid := private.fdb_registered_caller(); return null;` } } }))).toContain("identity-before-guard:public.fdb_account_guildbook_guilds");
      expect(rules(migration({ per: { fdb_account_installations: { declare: "v_uid uuid := auth.uid();" } } }))).toContain("identity-before-guard:public.fdb_account_installations");
      expect(rules(migration({ per: { fdb_account_installations: { declare: "v_leak jsonb := (select jsonb_agg(i) from public.installations i);", body: `v_uid := private.fdb_registered_caller(); return v_leak;` } } }))).toContain("identity-before-guard:public.fdb_account_installations");
    });

    it("REJECTS exception swallowing, dynamic SQL, and a second auth.uid() call after the guard", () => {
      expect(rules(migration({ per: { fdb_account_installations: { body: `v_uid := private.fdb_registered_caller(); return null; exception when others then return (select jsonb_agg(i) from public.installations i);` } } }))).toContain("exception-swallow:public.fdb_account_installations");
      expect(rules(migration({ per: { fdb_account_installations: { body: `v_uid := private.fdb_registered_caller(); execute 'select 1'; return null;` } } }))).toContain("dynamic-sql:public.fdb_account_installations");
      expect(rules(migration({ per: { fdb_account_installations: { body: `v_uid := private.fdb_registered_caller(); if v_uid <> auth.uid() then return null; end if; return null;` } } }))).toContain("uid-outside-guard:public.fdb_account_installations");
    });

    it("REJECTS missing SECURITY DEFINER, plpgsql, or STABLE", () => {
      expect(rules(migration({ per: { fdb_account_installations: { header: "language plpgsql set search_path = ''" } } }))).toContain("security-definer:public.fdb_account_installations");
      expect(rules(migration({ per: { fdb_account_installations: { header: "language sql security definer set search_path = ''" } } }))).toContain("language:public.fdb_account_installations");
      expect(rules(migration({ per: { fdb_account_installations: { header: "language plpgsql stable security definer set search_path = ''" } } }))).toContain("volatility:public.fdb_account_installations");
    });

    it("header `set` clauses: exactly search_path = '' (plus timeouts); chained, qualified or from-current forms fail", () => {
      expect(rules(migration({ per: { fdb_account_installations: { header: "language plpgsql security definer" } } }))).toContain("search-path:public.fdb_account_installations");
      for (const header of [
        "language plpgsql security definer set search_path = '' set search_path = public",
        "language plpgsql security definer set search_path = '', public",
        "language plpgsql security definer set search_path = '', pg_temp",
        "language plpgsql security definer set search_path from current",
        "language plpgsql security definer set search_path = '' set role postgres",
      ]) {
        expect(rules(migration({ per: { fdb_account_installations: { header } } })), header).toEqual(expect.arrayContaining([expect.stringMatching(/^(header-set|search-path):public\.fdb_account_installations/)]));
      }
      expect(rules(migration({ per: { fdb_account_installations: { header: "language plpgsql security definer set search_path = '' set lock_timeout = '5s'" } } }))).toEqual([]);
    });
  });

  describe("definitions, redefinitions and unparsable shapes", () => {
    it("function swallowing: a function without a dollar body is flagged, never merged into the next one", () => {
      const sql = migration({
        per: {
          fdb_account_installations: {
            body: "x",
            header: "language sql security definer set search_path = ''",
          },
        },
      }).replace(/create or replace function public\.fdb_account_installations\(\) returns jsonb[\s\S]*?end \$fn\$;/, `create or replace function public.fdb_account_installations() returns jsonb language sql security definer set search_path = '' as 'select jsonb_agg(to_jsonb(i)) from public.installations i';`);
      const r = rules(sql);
      expect(r).toContain("unsupported-body:public.fdb_account_installations");
      // the next function keeps being checked under its OWN name: nothing was merged
      expect(r.filter((x) => x.includes("public.fdb_account_guildbook_guilds"))).toEqual([]);
    });

    it("BEGIN ATOMIC and RETURN-expression bodies are unsupported", () => {
      const atomic = migration().replace(/create or replace function public\.fdb_account_installations\(\) returns jsonb[\s\S]*?end \$fn\$;/, `create or replace function public.fdb_account_installations() returns jsonb language sql security definer set search_path = '' begin atomic select 1; end;`);
      expect(rules(atomic)).toContain("unsupported-body:public.fdb_account_installations");
      const ret = migration().replace(/create or replace function public\.fdb_account_installations\(\) returns jsonb[\s\S]*?end \$fn\$;/, `create or replace function public.fdb_account_installations() returns jsonb language sql security definer set search_path = '' return (select 1);`);
      expect(rules(ret)).toContain("unsupported-body:public.fdb_account_installations");
    });

    it("D1: a string in the declare section that contains a fake guard call and BEGIN", () => {
      const sql = migration({ per: { fdb_account_claim_start: { declare: "v_uid uuid; v_note text := $z$begin perform private.fdb_anonymous_caller(); $z$;", body: `v_uid := auth.uid(); return null;` } } });
      expect(rules(sql)).toContain("guard-first:public.fdb_account_claim_start");
    });

    it("D3: a fake definition inside a DO block does not count as defined; DO blocks may not use dynamic SQL", () => {
      const sql = migration().replace("create function private.fdb_caller()", "do $do$ begin raise notice 'create function private.fdb_caller() returns uuid language plpgsql as $x$ begin end $x$'; end $do$;\ncreate function private.renamed()");
      expect(rules(sql)).toContain("guard-missing:private.fdb_caller");
      expect(rules(migration({ tail: `do $d$ begin execute 'create or replace function private.fdb_caller() returns uuid language sql as $y$ select auth.uid() $y$'; end $d$;` }))).toContain("dynamic-ddl:do-block");
    });

    it("quoted identifiers are refused everywhere (definitions, alter, grant)", () => {
      expect(rules(migration({ tail: `create or replace function "private"."fdb_caller"() returns uuid language sql as $x$ select auth.uid() $x$;` }))).toEqual(expect.arrayContaining(["quoted-identifier:database", expect.stringMatching(/^unsupported-name:/)]));
      expect(rules(migration({ tail: `alter function "private"."fdb_caller"() security invoker;` }))).toContain("quoted-identifier:database");
      expect(rules(migration({ tail: `grant execute on function "public"."fdb_account_installations"() to anon;` }))).toContain("quoted-identifier:database");
    });

    it("B13/B14/B15: a second definition, an overload, a weaker guard redefinition", () => {
      expect(rules(migration({ tail: fnSql("fdb_account_claim_start", { body: `v_uid := auth.uid(); return null;` }) }))).toContain("duplicate-definition:public.fdb_account_claim_start");
      expect(rules(migration({ tail: `create or replace function public.fdb_account_claim_start(p_installation_id text, p_extra int) returns jsonb language plpgsql security definer set search_path = '' as $$ begin return null; end $$;` }))).toContain("duplicate-definition:public.fdb_account_claim_start");
      expect(rules(migration({ tail: `create or replace function private.fdb_caller() returns uuid language plpgsql security definer set search_path = '' as $$ begin return auth.uid(); end $$;` }))).toContain("duplicate-definition:private.fdb_caller");
    });

    it("unknown or unregistered functions, procedures, views, rules and triggers are refused", () => {
      const f = (n: string) => `create function ${n}() returns jsonb language plpgsql security definer set search_path = '' as $$ begin return null; end $$;`;
      expect(rules(migration({ tail: f("public.fdb_account_secret_backdoor") }))).toContain("unknown-function:public.fdb_account_secret_backdoor");
      expect(rules(migration({ tail: f("private.fdb_caller_x") }))).toContain("unknown-function:private.fdb_caller_x");
      expect(rules(migration({ tail: f("public.get_all_installations") }))).toContain("unregistered-function:public.get_all_installations");
      expect(rules(migration({ tail: f("fdb_account_leak") }))).toEqual(expect.arrayContaining([expect.stringMatching(/^unsupported-name:/)]));
      expect(rules(migration({ tail: `create procedure public.fdb_account_leak() language plpgsql as $$ begin end $$;` }))).toEqual(expect.arrayContaining([expect.stringMatching(/^forbidden-object:/)]));
      expect(rules(migration({ tail: `create view public.v as select * from public.installations;` }))).toEqual(expect.arrayContaining([expect.stringMatching(/^forbidden-object:/)]));
      expect(rules(migration({ tail: `create trigger t before insert on public.installations for each row execute function public.x();` }))).toEqual(expect.arrayContaining([expect.stringMatching(/^forbidden-object:/)]));
    });
  });

  describe("ALTER, GRANT and REVOKE whitelist", () => {
    it("ALTER FUNCTION: only one timeout or search_path = '' clause; chained or weakening forms fail", () => {
      const bad = [
        "alter function public.fdb_account_installations() security invoker;",
        "alter function public.fdb_account_installations() reset search_path;",
        "alter function private.fdb_caller() owner to some_role;",
        "alter function private.fdb_caller() set lock_timeout='1s' security invoker;",
        "alter function private.fdb_caller() set statement_timeout='5s' reset search_path;",
        "alter routine private.fdb_caller() security invoker;",
        "alter function private.fdb_caller() set search_path = public;",
      ];
      for (const tail of bad) expect(rules(migration({ tail })), tail).toEqual(expect.arrayContaining([expect.stringMatching(/^alter-function:/)]));
      expect(rules(migration({ tail: "alter function public.fdb_account_installations() set lock_timeout = '5s';" }))).toEqual([]);
      expect(rules(migration({ tail: "alter function public.fdb_account_installations() set statement_timeout = 15000;" }))).toEqual([]);
    });

    it("B10: an ALTER for another signature or function does not satisfy the search_path requirement", () => {
      const sql = migration({ per: { fdb_account_installations: { header: "language plpgsql security definer" } }, tail: "alter function public.other(text, text) set search_path = '';" });
      expect(rules(sql)).toContain("search-path:public.fdb_account_installations");
    });

    it("grants: blanket, routine, no-parentheses, comma lists, default privileges and role grants all fail", () => {
      const bad: [string, RegExp][] = [
        ["grant execute on all functions in schema public to anon;", /^blanket-grant:/],
        ["grant execute on all routines in schema public to anon;", /^blanket-grant:/],
        ["grant execute on routine public.fdb_account_installations() to anon;", /^blanket-grant:/],
        ["grant execute on function private.fdb_caller() to anon;", /^guard-grant:private\.fdb_caller/],
        ["grant execute on function private.fdb_registered_caller() to authenticated;", /^guard-grant:private\.fdb_registered_caller/],
        ["grant execute on function public.fdb_account_installations to anon;", /^grant:public\.fdb_account_installations/],
        ["grant execute on function public.zzz(), public.fdb_account_installations() to anon;", /^grant:public\.fdb_account_installations/],
        ["alter default privileges in schema public grant execute on functions to anon;", /^default-privileges:/],
        ["grant anon to authenticated;", /^role-grant:/],
      ];
      for (const [tail, expected] of bad) expect(rules(migration({ tail })), tail).toEqual(expect.arrayContaining([expect.stringMatching(expected)]));
    });

    it("revokes must name every client role, and the schema-wide guard revoke only counts after the last function exists", () => {
      const partial = migration({ per: { fdb_account_claim_redeem: { grants: `revoke all on function public.fdb_account_claim_redeem(text) from public, anon;\ngrant execute on function public.fdb_account_claim_redeem(text) to authenticated;` } } });
      expect(rules(partial)).toContain("revoke:public.fdb_account_claim_redeem");
      const early = guardSql() + "\nrevoke all on all functions in schema private from public, anon, authenticated;\n" + RPC_NAMES.map((n) => fnSql(n)).join("\n") + "\ncreate function private.fdb_late() returns int language plpgsql as $$ begin return 1; end $$;";
      expect(rules(early)).toEqual(expect.arrayContaining([expect.stringMatching(/^guard-grants:/)]));
      const anonOnly = migration({ noSchemaRevoke: true, tail: "revoke all on function private.fdb_caller() from anon;\nrevoke all on function private.fdb_anonymous_caller() from anon;\nrevoke all on function private.fdb_registered_caller() from anon;" });
      expect(rules(anonOnly)).toEqual(expect.arrayContaining([expect.stringMatching(/^guard-grants:/)]));
      const full = migration({ noSchemaRevoke: true, tail: GUARD_REVOKES });
      expect(rules(full)).toEqual([]);
      expect(rules(migration({ noSchemaRevoke: true }))).toEqual(expect.arrayContaining([expect.stringMatching(/^guard-grants:/)]));
      expect(rules(migration({ per: { fdb_account_claim_start: { grants: "" } } }))).toEqual(expect.arrayContaining(["revoke:public.fdb_account_claim_start", "grant:public.fdb_account_claim_start"]));
    });

    it("the guard check is not satisfied by a revoke of a different function", () => {
      expect(rules(migration({ noSchemaRevoke: true, tail: "revoke all on function private.fdb_other() from public, anon, authenticated;" }))).toEqual(expect.arrayContaining([expect.stringMatching(/^guard-grants:/)]));
    });
  });

  it("the reference guard printed in the specification passes the linter (document and check cannot drift apart)", () => {
    const doc = readFileSync(resolve(__dirname, "../../../docs/account-v1/ownership-claim-protocol.md"), "utf8");
    const section = doc.slice(doc.indexOf("**Reference shape**"));
    const block = /```sql\n([\s\S]*?)```/.exec(section)?.[1];
    expect(block, "reference SQL block not found in section 4.1").toBeTruthy();
    const withDocGuard = migration().replace(/create function private\.fdb_caller\(\)[\s\S]*?end \$g1\$[^;]*;/, () => (block as string).replace(/--[^\n]*/g, ""));
    expect(withDocGuard).toContain("session_id");
    expect(lintAccountMigration(withDocGuard)).toEqual([]);
  });

  it("an absent function and an absent guard are reported", () => {
    expect(rules(migration({ skip: ["fdb_account_claim_start"] }))).toContain("function-missing:public.fdb_account_claim_start");
    expect(rules(migration().replace("create function private.fdb_registered_caller()", "create function private.renamed()"))).toContain("guard-missing:private.fdb_registered_caller");
  });

  it("ignores guard text that only appears in comments", () => {
    const commented = migration({ per: { fdb_account_claim_start: { body: `-- v_uid := private.fdb_anonymous_caller();\n v_uid := auth.uid(); return null;` } } });
    expect(rules(commented)).toContain("guard-first:public.fdb_account_claim_start");
  });

  it("holds for the account migration, wherever it lives (PR C): every migration that mentions an account function is linted", () => {
    const dir = resolve(__dirname, "../../../database/migrations");
    const mentions = /fdb_account_|fdb_installation_link_status|fdb_caller|fdb_anonymous_caller|fdb_registered_caller/;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      // 0014 (zero-touch enrollment), 0017 (account-independent collectors) and 0018 (local-only catalog-discovered revokes)
      // are deliberately outside this tripwire: they have
      // their own function set and guards (registered AND anonymous device callers) pinned by the SQL integration suite, not by the
      // 0012 account registry.
      .filter((f) => !f.startsWith("0014_") && !f.startsWith("0017_") && !f.startsWith("0018_"))
      .filter((f) => mentions.test(readFileSync(resolve(dir, f), "utf8")));
    if (files.length === 0) {
      expect(existsSync(dir)).toBe(true); // no account migration yet (PR A is specification only)
      return;
    }
    const combined = files.map((f) => readFileSync(resolve(dir, f), "utf8")).join("\n");
    expect(lintAccountMigration(combined), files.join(", ")).toEqual([]);
  });
});

const GUARD_REVOKES = Object.values(ACCOUNT_GUARD_FUNCTIONS)
  .map((n) => `revoke all on function ${n}() from public, anon, authenticated;`)
  .join("\n");
