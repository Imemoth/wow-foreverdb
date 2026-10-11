import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_GUARD_FUNCTIONS, ACCOUNT_RPC_GUARDS, ACCOUNT_RPCS } from "@/lib/account/contracts";
import { escapeRegExp, lintAccountMigration } from "@/lib/account/migration-conformance";

/**
 * The account migration (PR C, database/migrations/0012_*.sql) must implement every account function behind a LIVE-SESSION
 * identity guard. These tests pin the linter itself with a conformant fixture and with the exact weak implementations the
 * independent review warned about; the same linter runs against the real migration as soon as it exists.
 */

const ARGS: Record<string, string> = {
  fdb_account_claim_start: "p_installation_id text",
  fdb_account_claim_redeem: "p_code text",
  fdb_account_installations: "",
  fdb_account_guildbook_guilds: "p_installation_id text",
  fdb_account_guildbook_members: "p_installation_id text, p_guild_key text, p_limit integer, p_offset integer",
  fdb_installation_link_status: "p_installation_id text",
};
const TYPES: Record<string, string> = {
  fdb_account_claim_start: "text",
  fdb_account_claim_redeem: "text",
  fdb_account_installations: "",
  fdb_account_guildbook_guilds: "text",
  fdb_account_guildbook_members: "text, text, integer, integer",
  fdb_installation_link_status: "text",
};

const LIVE = `exists (select 1 from auth.sessions s join auth.users u on u.id = s.user_id
  where s.id = v_sid and s.user_id = v_uid and (s.not_after is null or s.not_after > now())
    and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now()))`;

function guardSql(overrides: { anyDeclare?: string; anyBody?: string; anonBody?: string; regBody?: string } = {}): string {
  return `
create function private.fdb_caller() returns uuid language plpgsql security definer set search_path = '' as $$
declare ${overrides.anyDeclare ?? `v_uid uuid := auth.uid(); v_sid uuid := nullif(auth.jwt() ->> 'session_id','')::uuid;`}
begin
  ${overrides.anyBody ?? `if auth.role() is distinct from 'authenticated' or v_uid is null or not ${LIVE} then raise sqlstate 'PT401'; end if; return v_uid;`}
end $$;
create function private.fdb_anonymous_caller() returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  ${overrides.anonBody ?? `v_uid := private.fdb_caller(); if not (select is_anonymous from auth.users where id = v_uid) then raise sqlstate 'PT403'; end if; return v_uid;`}
end $$;
create function private.fdb_registered_caller() returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  ${overrides.regBody ?? `v_uid := private.fdb_caller(); if not exists (select 1 from auth.users where id = v_uid and not is_anonymous and email_confirmed_at is not null) then raise sqlstate 'PT403'; end if; return v_uid;`}
end $$;
revoke all on all functions in schema private from public, anon, authenticated;
`;
}

function fnSql(name: keyof typeof ARGS, o: { body?: string; header?: string; grants?: string } = {}): string {
  const guard = ACCOUNT_GUARD_FUNCTIONS[ACCOUNT_RPC_GUARDS[name as keyof typeof ACCOUNT_RPC_GUARDS]];
  return `
create or replace function public.${name}(${ARGS[name]}) returns jsonb
${o.header ?? "language plpgsql security definer set search_path = ''"}
as $fn$
declare v_uid uuid;
begin
  ${o.body ?? `v_uid := ${guard}(); return jsonb_build_object('ok', true);`}
end $fn$;
${o.grants ?? `revoke all on function public.${name}(${TYPES[name]}) from public, anon, authenticated, service_role;
grant execute on function public.${name}(${TYPES[name]}) to authenticated;`}
`;
}

function migration(opts: { guards?: Parameters<typeof guardSql>[0]; per?: Partial<Record<string, Parameters<typeof fnSql>[1]>>; skip?: string[] } = {}): string {
  return (
    guardSql(opts.guards) +
    Object.keys(ARGS)
      .filter((n) => !(opts.skip ?? []).includes(n))
      .map((n) => fnSql(n, opts.per?.[n]))
      .join("\n")
  );
}

const rules = (sql: string) => lintAccountMigration(sql).map((v) => `${v.rule}:${v.target}`);

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

describe("account migration conformance linter", () => {
  it("accepts a conformant migration", () => {
    expect(lintAccountMigration(migration())).toEqual([]);
  });

  it("covers every account RPC with a guard that is never weaker than a live session", () => {
    expect(Object.keys(ACCOUNT_RPC_GUARDS).sort()).toEqual(Object.keys(ACCOUNT_RPCS).sort());
    expect(Object.keys(ARGS).sort()).toEqual(Object.keys(ACCOUNT_RPCS).sort());
    expect(Object.values(ACCOUNT_RPC_GUARDS).every((g) => g.endsWith("live_session"))).toBe(true);
    expect(ACCOUNT_RPC_GUARDS.fdb_account_claim_start).toBe("anonymous_owner_live_session");
    expect(ACCOUNT_RPC_GUARDS.fdb_account_claim_redeem).toBe("registered_live_session");
  });

  it("REJECTS claim initiation guarded only by auth.uid() and is_anonymous (the reviewed High finding)", () => {
    const weak = migration({
      per: {
        fdb_account_claim_start: {
          body: `v_uid := auth.uid(); if not (select is_anonymous from auth.users where id = v_uid) then raise sqlstate 'PT403'; end if; return jsonb_build_object('ok', true);`,
        },
      },
    });
    const r = rules(weak);
    expect(r).toContain("guard-first:public.fdb_account_claim_start");
    expect(r).toContain("identity-before-guard:public.fdb_account_claim_start");
  });

  it("REJECTS a guard that only checks auth.uid() (no live-session query at all)", () => {
    const weakGuards = migration({
      guards: {
        anyDeclare: "v_uid uuid := auth.uid();",
        anyBody: `if auth.uid() is null then raise sqlstate 'PT401'; end if; return auth.uid();`,
      },
    });
    expect(rules(weakGuards)).toContain("guard-live-session:private.fdb_caller");
    const messages = lintAccountMigration(weakGuards).filter((v) => v.target === "private.fdb_caller").map((v) => v.message).join(" | ");
    expect(messages).toContain("session_id claim");
    expect(messages).toContain("not exists (select ... from auth.sessions");
  });

  it("REJECTS a guard that declares the session id but never uses it (mention is not a check)", () => {
    const decorative = migration({
      guards: { anyBody: `if auth.role() is distinct from 'authenticated' or v_uid is null then raise sqlstate 'PT401'; end if; return v_uid;` },
    });
    const messages = lintAccountMigration(decorative).filter((v) => v.target === "private.fdb_caller").map((v) => v.message).join(" | ");
    expect(messages).toContain("not exists (select ... from auth.sessions");
  });

  it("REJECTS a live-session guard that forgets expiry, deleted or banned users", () => {
    for (const [drop, label] of [["(s.not_after is null or s.not_after > now())", "not_after"], ["u.deleted_at is null", "deleted_at"], ["(u.banned_until is null or u.banned_until <= now())", "banned_until"]] as const) {
      const body = `if auth.role() is distinct from 'authenticated' or v_uid is null or not ${LIVE.replace(drop, "true")} then raise sqlstate 'PT401'; end if; return v_uid;`;
      const messages = lintAccountMigration(migration({ guards: { anyBody: body } })).filter((v) => v.target === "private.fdb_caller").map((v) => v.message).join(" | ");
      expect(messages, label).toContain(label);
    }
  });

  it("REJECTS a derived guard that skips the live-session guard", () => {
    const r = rules(migration({ guards: { anonBody: `v_uid := auth.uid(); if (select is_anonymous from auth.users where id = v_uid) is not true then raise sqlstate 'PT403'; end if; return v_uid;` } }));
    expect(r).toContain("guard-live-session:private.fdb_anonymous_caller");
    const r2 = rules(migration({ guards: { regBody: `v_uid := auth.uid(); perform 1 from auth.users where id = v_uid and not is_anonymous and email_confirmed_at is not null; return v_uid;` } }));
    expect(r2).toContain("guard-live-session:private.fdb_registered_caller");
  });

  it("REJECTS using a weaker guard than the registry demands (redeem must use the registered guard)", () => {
    const r = rules(migration({ per: { fdb_account_claim_redeem: { body: `v_uid := private.fdb_caller(); return jsonb_build_object('ok', true);` } } }));
    expect(r).toContain("guard-first:public.fdb_account_claim_redeem");
    const r2 = rules(migration({ per: { fdb_account_claim_start: { body: `v_uid := private.fdb_caller(); return jsonb_build_object('ok', true);` } } }));
    expect(r2).toContain("guard-first:public.fdb_account_claim_start");
  });

  it("REJECTS a guard that is not the first statement or that reads identity first", () => {
    const r = rules(migration({ per: { fdb_account_installations: { body: `perform 1; v_uid := private.fdb_registered_caller(); return null;` } } }));
    expect(r).toContain("guard-first:public.fdb_account_installations");
    const r2 = rules(migration({ per: { fdb_account_guildbook_guilds: { body: `if auth.uid() is null then return null; end if; v_uid := private.fdb_registered_caller(); return null;` } } }));
    expect(r2).toContain("identity-before-guard:public.fdb_account_guildbook_guilds");
  });

  it("REJECTS missing SECURITY DEFINER, search_path, or plpgsql", () => {
    expect(rules(migration({ per: { fdb_account_installations: { header: "language plpgsql set search_path = ''" } } }))).toContain("security-definer:public.fdb_account_installations");
    expect(rules(migration({ per: { fdb_account_installations: { header: "language plpgsql security definer" } } }))).toContain("search-path:public.fdb_account_installations");
    expect(rules(migration({ per: { fdb_account_installations: { header: "language sql security definer set search_path = ''" } } }))).toContain("language:public.fdb_account_installations");
    expect(rules(migration({ guards: undefined }).replace("create function private.fdb_caller() returns uuid language plpgsql security definer set search_path = ''", "create function private.fdb_caller() returns uuid language plpgsql"))).toContain("guard-security-definer:private.fdb_caller");
  });

  it("REJECTS missing revokes and grants to anon/public/service_role", () => {
    const noGrants = migration({ per: { fdb_account_claim_start: { grants: "" } } });
    expect(rules(noGrants)).toEqual(expect.arrayContaining(["revoke:public.fdb_account_claim_start", "grant:public.fdb_account_claim_start"]));
    const anon = migration({ per: { fdb_account_claim_redeem: { grants: `revoke all on function public.fdb_account_claim_redeem(text) from public, anon, authenticated, service_role;\ngrant execute on function public.fdb_account_claim_redeem(text) to authenticated, anon;` } } });
    expect(lintAccountMigration(anon).map((v) => v.message).join(" ")).toMatch(/must not grant execute to anon/);
  });

  it("REJECTS an absent function and an absent guard", () => {
    expect(rules(migration({ skip: ["fdb_account_claim_start"] }))).toContain("function-missing:public.fdb_account_claim_start");
    expect(rules(migration().replace("create function private.fdb_registered_caller()", "create function private.renamed()"))).toContain("guard-missing:private.fdb_registered_caller");
  });

  it("ignores guard text that only appears in comments", () => {
    const commented = migration({ per: { fdb_account_claim_start: { body: `-- v_uid := private.fdb_anonymous_caller();\n v_uid := auth.uid(); return null;` } } });
    expect(rules(commented)).toContain("guard-first:public.fdb_account_claim_start");
  });

  describe("bypasses demonstrated by the independent review (all must be rejected)", () => {
    const guardWith = (anyBody: string, anyDeclare?: string) => migration({ guards: { anyBody, anyDeclare } });
    const withExtra = (extra: string) => migration() + "\n" + extra;

    it("D1: a string in the declare section that contains a fake guard call and BEGIN", () => {
      const sql = migration({
        per: {
          fdb_account_claim_start: {
            body: `v_uid := auth.uid(); update public.installations set owner_user_id = v_uid; return null;`,
          },
        },
      }).replace("declare v_uid uuid;\nbegin\n  v_uid := auth.uid();", "declare v_uid uuid; v_note text := $z$begin perform private.fdb_anonymous_caller(); $z$;\nbegin\n  v_uid := auth.uid();");
      expect(sql).toContain("$z$begin perform");
      const r = rules(sql);
      expect(r).toContain("guard-first:public.fdb_account_claim_start");
    });

    it("B1/B2/D2: a guard that queries the tables but never raises", () => {
      const sql = guardWith(`perform 1 from auth.sessions where id = v_sid and user_id = v_uid and not_after is null; perform deleted_at, banned_until from auth.users; return v_uid;`);
      expect(rules(sql)).toContain("guard-live-session:private.fdb_caller");
    });

    it("a complete-looking live-session query that is NOT attached to a RAISE (checked, then ignored)", () => {
      const sql = guardWith(`perform 1 where not ${LIVE}; return v_uid;`);
      expect(lintAccountMigration(sql).map((v) => v.message).join(" ")).toMatch(/attached to a RAISE/);
    });

    it("B3: the required words only inside string literals or comments", () => {
      const sql = guardWith(`-- not exists (select 1 from auth.sessions s where s.id = v_sid and s.user_id = v_uid and s.not_after is null and u.deleted_at is null and u.banned_until is null) then raise\n raise notice 'not exists (select 1 from auth.sessions s where s.id = v_sid and s.user_id = v_uid) then raise'; return v_uid;`);
      expect(rules(sql)).toContain("guard-live-session:private.fdb_caller");
    });

    it("B4: the live-session check is dead code after RETURN", () => {
      const sql = guardWith(`return v_uid; if auth.role() is distinct from 'authenticated' or not ${LIVE} then raise sqlstate 'PT401'; end if;`);
      expect(lintAccountMigration(sql).map((v) => v.message).join(" ")).toMatch(/before the first RETURN/);
    });

    it("the unrelated `u.id = s.user_id` does not satisfy the session id match", () => {
      const sql = guardWith(`if auth.role() is distinct from 'authenticated' or v_uid is null or not exists (select 1 from auth.sessions s join auth.users u on u.id = s.user_id where s.user_id = v_uid and (s.not_after is null or s.not_after > now()) and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())) then raise sqlstate 'PT401'; end if; return v_uid;`);
      expect(lintAccountMigration(sql).map((v) => v.message).join(" ")).toMatch(/matched by its id/);
    });

    it("a guard that checks the session but forgets the user binding (any live session of anyone)", () => {
      const sql = guardWith(`if auth.role() is distinct from 'authenticated' or v_uid is null or not exists (select 1 from auth.sessions s join auth.users u on u.id = s.user_id where s.id = v_sid and (s.not_after is null or s.not_after > now()) and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())) then raise sqlstate 'PT401'; end if; return v_uid;`);
      expect(lintAccountMigration(sql).map((v) => v.message).join(" ")).toMatch(/belong to the caller/);
    });

    it("D3: a fake definition inside a DO block does not count as defined", () => {
      const sql = migration().replace("create function private.fdb_caller()", "do $do$ begin raise notice 'create function private.fdb_caller() returns uuid language plpgsql as $x$ begin end $x$'; end $do$;\ncreate function private.renamed()");
      expect(rules(sql)).toContain("guard-missing:private.fdb_caller");
    });

    it("B13: a second definition of a function (last definition wins)", () => {
      const sql = withExtra(fnSql("fdb_account_claim_start", { body: `v_uid := auth.uid(); return null;` }));
      expect(rules(sql)).toContain("duplicate-definition:public.fdb_account_claim_start");
    });

    it("B14: a weaker overload with a different signature", () => {
      const sql = withExtra(`create or replace function public.fdb_account_claim_start(p_installation_id text, p_extra int) returns jsonb language plpgsql security definer set search_path = '' as $$ begin return null; end $$;`);
      expect(rules(sql)).toContain("duplicate-definition:public.fdb_account_claim_start");
    });

    it("B15: a weaker redefinition of a guard", () => {
      const sql = withExtra(`create or replace function private.fdb_caller() returns uuid language sql as $$ select auth.uid() $$;`);
      expect(rules(sql)).toContain("duplicate-definition:private.fdb_caller");
    });

    it("B18/B19: ALTER FUNCTION that weakens SECURITY or search_path afterwards", () => {
      expect(rules(withExtra("alter function public.fdb_account_installations() security invoker;"))).toContain("alter-function:public.fdb_account_installations");
      expect(rules(withExtra("alter function public.fdb_account_installations() reset search_path;"))).toContain("alter-function:public.fdb_account_installations");
      expect(rules(withExtra("alter function private.fdb_caller() owner to some_role;"))).toContain("alter-function:private.fdb_caller");
      expect(rules(withExtra("alter function public.fdb_account_installations() set lock_timeout = '5s';"))).toEqual([]);
    });

    it("B10: an ALTER for another signature does not satisfy the search_path requirement", () => {
      const sql = migration({ per: { fdb_account_installations: { header: "language plpgsql security definer" } } }) + "\nalter function public.other(text, text) set search_path = '';";
      expect(rules(sql)).toContain("search-path:public.fdb_account_installations");
    });

    it("B12/B16: blanket grants, or granting a guard to a client role, after the revoke", () => {
      expect(rules(withExtra("grant execute on all functions in schema public to anon;"))).toContain("blanket-grant:database");
      expect(rules(withExtra("grant execute on function private.fdb_caller() to anon;"))).toContain("guard-grant:private.fdb_caller");
      expect(rules(withExtra("grant execute on function private.fdb_registered_caller() to authenticated;"))).toContain("guard-grant:private.fdb_registered_caller");
    });

    it("an unregistered account-looking function is refused (whitelist, not blacklist)", () => {
      const sql = withExtra(`create function public.fdb_account_secret_backdoor() returns jsonb language plpgsql security definer set search_path = '' as $$ begin return null; end $$;`);
      expect(rules(sql)).toContain("unknown-function:public.fdb_account_secret_backdoor");
    });

    it("STABLE guards and functions are refused (no row lock, may be cached)", () => {
      const sql = migration().replace("create function private.fdb_caller() returns uuid language plpgsql", "create function private.fdb_caller() returns uuid language plpgsql stable");
      expect(rules(sql)).toContain("guard-volatile:private.fdb_caller");
    });
  });

  it("holds for the account migration, wherever it lives (PR C): every migration that mentions an account function is linted", () => {
    const dir = resolve(__dirname, "../../../database/migrations");
    const mentions = /fdb_account_|fdb_installation_link_status|fdb_caller|fdb_anonymous_caller|fdb_registered_caller/;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) => mentions.test(readFileSync(resolve(dir, f), "utf8")));
    if (files.length === 0) {
      expect(existsSync(dir)).toBe(true); // no account migration yet (PR A is specification only)
      return;
    }
    const combined = files.map((f) => readFileSync(resolve(dir, f), "utf8")).join("\n");
    expect(lintAccountMigration(combined), files.join(", ")).toEqual([]);
  });
});
