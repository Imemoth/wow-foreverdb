import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PublicationConfig } from "../src/core/contract.ts";
import { runPublication, type RunDeps } from "../src/core/run.ts";
import type { ClosableSqlClient } from "../src/core/sql.ts";

const config = PublicationConfig.parse(JSON.parse(readFileSync(resolve(__dirname, "../publication-config.json"), "utf8")));

/** A scripted public-database fake: records statements, answers by pattern. */
function fakePublic(opts: { lease?: boolean; failOn?: RegExp } = {}) {
  const sql: string[] = [];
  const client: ClosableSqlClient = {
    close: async () => undefined,
    query: async (text) => {
      sql.push(text.replace(/\s+/g, " ").trim().slice(0, 80));
      if (opts.failOn?.test(text)) throw Object.assign(new Error("boom postgres://user:secret@host/db"), { code: "XX000" });
      if (/acquire_lease/.test(text)) return { rows: [{ ok: opts.lease ?? true }] };
      if (/record_run/.test(text)) return { rows: [{ id: 7 }] };
      if (/pg_try_advisory_xact_lock/.test(text)) return { rows: [{ ok: true }] };
      if (/pub_admin\.status/.test(text)) return { rows: [{ s: { active: null, publications: [] } }] };
      if (/begin_publication/.test(text)) return { rows: [{ id: 41 }] };
      if (/finalize_publication/.test(text)) return { rows: [{ outcome: "activated" }] };
      return { rows: [] };
    },
  };
  return { client, sql };
}

function deps(over: Partial<RunDeps>, pub = fakePublic()): { d: RunDeps; sql: string[]; logs: string[] } {
  const logs: string[] = [];
  const d: RunDeps = {
    config, workerVersion: "test", runtime: "test", publicRole: "foreverdb_publisher", openPrivate: null,
    openPublic: async () => pub.client,
    log: (e, data) => logs.push(JSON.stringify({ e, data })),
    ...over,
  };
  return { d, sql: pub.sql, logs };
}

describe("runPublication", () => {
  it("refuses to publish a synthetic export, without touching any database", async () => {
    const { d, sql } = deps({});
    const r = await runPublication(d, { mode: "publish", trigger: "manual", source: "synthetic", scale: 1 });
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("synthetic_publish_refused");
    expect(sql).toHaveLength(0);
  });

  it("skips (does not queue) when another run holds the lease, and records the skip", async () => {
    const { d, sql } = deps({}, fakePublic({ lease: false }));
    // (a synthetic source cannot use mode "publish"; a rehearsal also takes the lease)
    const r2 = await runPublication(d, { mode: "rehearse", trigger: "cron", source: "synthetic", scale: 1 });
    expect(r2.outcome).toBe("skipped_busy");
    expect(r2.ok).toBe(true);
    expect(sql.some((s) => /insert|pub\.items/.test(s))).toBe(false);
    expect(sql.some((s) => /record_run/.test(s))).toBe(true);
  });

  it("fails closed when no private export identity is configured", async () => {
    const { d } = deps({});
    const r = await runPublication(d, { mode: "dry_run", trigger: "manual", source: "private" });
    expect(r.outcome).toBe("failed");
    expect(r.errorClass).toBe("private_export_not_configured");
  });

  it("classifies database errors without leaking connection strings", async () => {
    const { d, logs } = deps({}, fakePublic({ failOn: /begin_publication/ }));
    const r = await runPublication(d, { mode: "rehearse", trigger: "manual", source: "synthetic", scale: 1 });
    expect(r.outcome).toBe("failed");
    expect(r.errorClass).toBe("db_error_XX000");
    const text = JSON.stringify(r) + logs.join("\n");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("user:");
  });

  it("a rehearsal writes rows, rolls back and reports it persisted nothing", async () => {
    const pub = fakePublic();
    const { d, sql } = deps({}, pub);
    const r = await runPublication(d, { mode: "rehearse", trigger: "benchmark", source: "synthetic", scale: 1 });
    expect(r.outcome).toBe("rehearsal_ok");
    expect(r.wouldBe).toBe("activated");
    expect(r.publicationId).toBeNull();
    expect(sql.filter((s) => /^rollback/.test(s)).length).toBeGreaterThan(0);
  });

  it("a dry run never writes to the public database", async () => {
    const pub = fakePublic();
    const { d, sql } = deps({}, pub);
    const r = await runPublication(d, { mode: "dry_run", trigger: "manual", source: "synthetic", scale: 1 });
    expect(r.outcome).toBe("dry_run_ok");
    expect(sql.some((s) => /begin_publication|insert into pub\./.test(s))).toBe(false);
  });
});
