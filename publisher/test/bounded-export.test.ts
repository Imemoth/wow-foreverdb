import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_EXPORT_ROWS,
  EXPORT_SECTIONS,
  exportRowCounts,
  MAX_VALIDATION_ISSUES,
  maxExportRows,
  parsePrivateExportBounded,
  PrivateExport,
  PublicationConfig,
} from "../src/core/contract.ts";
import { buildProjection, PublicationError } from "../src/core/project.ts";
import { runPublication, type RunDeps } from "../src/core/run.ts";
import { readPrivateExport, type ClosableSqlClient, type SqlClient } from "../src/core/sql.ts";
import { syntheticExport } from "../src/core/synthetic.ts";

const rawConfig = JSON.parse(readFileSync(resolve(__dirname, "../publication-config.json"), "utf8"));
const config = PublicationConfig.parse(rawConfig);
const withLimit = (n: number) => PublicationConfig.parse({ ...rawConfig, limits: { maxExportRows: n } });
const fixture = () => JSON.parse(readFileSync(resolve(__dirname, "../../database/tests/fixtures/synthetic_private_export.json"), "utf8"));

function tiny() {
  return {
    meta: { contract_version: 1, exported_at: "2026-10-09T00:00:00Z", data_updated_at: "2026-10-09T00:00:00Z" },
    sources: [{ source_type: "creature", source_id: 1, source_level: 5, name: "Test Wolf", first_seen_at: null, last_seen_at: null }],
    items: [{ item_id: 10, name: "Wolf Meat", first_seen_at: null, last_seen_at: null }],
    buckets: [{ source_type: "creature", source_id: 1, source_level: 5, loot_kind: "mob", observations: 200, installations: 3, max_installation_share: 0.5, last_updated_at: null }],
    drops: [{ source_type: "creature", source_id: 1, source_level: 5, loot_kind: "mob", item_id: 10, drops: 50, quantity: 60, quest_drops: 0, installations: 3, max_installation_share: 0.5 }],
    locations: [{ source_type: "creature", source_id: 1, source_level: 5, loot_kind: "mob", map_id: 1420, zone_name: "Tirisfal Glades", subzone_name: "Brill", x: 41.5, y: 52.5, observations: 4, installations: 2 }],
  };
}

function violation(ex: unknown, cfg = config): PublicationError {
  try {
    buildProjection(ex, cfg);
  } catch (e) {
    expect(e).toBeInstanceOf(PublicationError);
    return e as PublicationError;
  }
  throw new Error("expected buildProjection to fail closed");
}

/** An array that records every element access (for proving what was NOT looked at). */
function spyArray<T>(n: number, make: (i: number) => T) {
  const touched = new Set<number>();
  const arr = new Proxy(Array.from({ length: n }, (_, i) => make(i)), {
    get(t, k, r) {
      if (typeof k === "string" && /^\d+$/.test(k)) touched.add(Number(k));
      return Reflect.get(t, k, r);
    },
  });
  return { arr, touched };
}

describe("bounded validation is the same strict contract as PrivateExport", () => {
  it.each([1, 3])("valid synthetic export (scale %i): identical parsed data", (scale) => {
    const raw = syntheticExport(scale);
    const r = parsePrivateExportBounded(raw);
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual(PrivateExport.parse(raw));
  });

  it("valid committed fixture: identical parsed data", () => {
    const raw = fixture();
    const r = parsePrivateExportBounded(raw);
    expect(r.success && r.data).toEqual(PrivateExport.parse(raw));
  });

  it("agrees with PrivateExport on accept/reject for 600 seeded mutations (strictness is not weakened)", () => {
    let seed = 20261029;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
    const pool: unknown[] = [null, undefined, "", "x", "7", "1e3", 0, -1, 1.5, 2 ** 53, 1e21, NaN, Infinity, true, [], {}, { a: 1 }, new Date(0), "2026-01-01T00:00:00Z", "not a date"];
    let accepted = 0;
    let rejected = 0;
    for (let n = 0; n < 600; n++) {
      const ex = tiny() as unknown as Record<string, any>;
      const kind = Math.floor(rnd() * 6);
      const section = pick(EXPORT_SECTIONS);
      if (kind === 0) ex[section][0][pick(Object.keys(ex[section][0]))] = pick(pool);
      else if (kind === 1) delete ex[section][0][pick(Object.keys(ex[section][0]))];
      else if (kind === 2) ex[section][0].extra = pick(pool);
      else if (kind === 3) ex[section] = pick(pool);
      else if (kind === 4) ex[pick(["meta", ...EXPORT_SECTIONS, "extra"])] = pick(pool);
      else ex.meta[pick(Object.keys(ex.meta))] = pick(pool);
      let oldOk: boolean;
      try {
        oldOk = PrivateExport.safeParse(ex).success;
      } catch {
        oldOk = false; // a throwing timestamp transform: also a rejection
      }
      const newR = parsePrivateExportBounded(ex);
      expect(newR.success, JSON.stringify(ex).slice(0, 200)).toBe(oldOk);
      if (oldOk) {
        accepted++;
        expect(newR.success && newR.data).toEqual(PrivateExport.parse(ex));
      } else rejected++;
    }
    expect(accepted).toBeGreaterThan(20); // the mutations really exercise both outcomes
    expect(rejected).toBeGreaterThan(100);
  });

  it.each(EXPORT_SECTIONS)("an unknown column on a %s row fails, with path and code only", (section) => {
    const ex = tiny();
    (ex[section][0] as Record<string, unknown>).installation_id = "LEAK-CANARY";
    const r = parsePrivateExportBounded(ex);
    expect(r).toEqual({ success: false, issues: [{ path: `${section}.0`, code: "unrecognized_keys" }], truncated: false });
    expect(JSON.stringify(r)).not.toContain("LEAK-CANARY");
  });

  it("root, meta and section shape violations", () => {
    for (const v of [null, undefined, "x", 1, []]) expect(parsePrivateExportBounded(v)).toMatchObject({ success: false, issues: [{ path: "", code: "invalid_type" }] });
    expect(parsePrivateExportBounded({ ...tiny(), extra: 1 })).toMatchObject({ success: false, issues: [{ path: "", code: "unrecognized_keys" }] });
    expect(parsePrivateExportBounded({ ...tiny(), drops: null })).toMatchObject({ success: false, issues: [{ path: "drops", code: "invalid_type" }] });
    const { items: _i, ...noItems } = tiny();
    expect(parsePrivateExportBounded(noItems)).toMatchObject({ success: false, issues: [{ path: "items", code: "invalid_type" }] });
    expect(parsePrivateExportBounded({ ...tiny(), meta: { contract_version: 1 } }).success).toBe(false);
  });

  it("a throwing transform (unparseable timestamp) is reported as a value-free violation", () => {
    const ex = tiny();
    (ex.items[0] as Record<string, unknown>).first_seen_at = "SECRET-not-a-date";
    const r = parsePrivateExportBounded(ex);
    expect(r).toEqual({ success: false, issues: [{ path: "items.0", code: "exception" }], truncated: false });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });
});

describe("validation stops at the issue cap", () => {
  const bad = (i: number) => ({ item_id: `LEAK-${i}`, name: 5, first_seen_at: {}, last_seen_at: [] });

  it("100,000 invalid rows: exactly 20 issues, truncated, and the rest of the array is never read", () => {
    const { arr, touched } = spyArray(100_000, bad);
    const r = parsePrivateExportBounded({ ...tiny(), items: arr });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(MAX_VALIDATION_ISSUES).toBe(20);
    expect(r.issues).toHaveLength(20);
    expect(r.truncated).toBe(true);
    expect(touched.size).toBeLessThanOrEqual(10); // each bad row yields several issues, so a handful of rows reach the cap
    expect(Math.max(...touched)).toBeLessThan(10);
    expect(JSON.stringify(r)).not.toContain("LEAK");
  });

  it("the cap is shared across collections and meta", () => {
    const ex = { meta: 1, sources: Array.from({ length: 50 }, () => ({})), items: Array.from({ length: 50 }, () => ({})), buckets: [], drops: [], locations: [] };
    const r = parsePrivateExportBounded(ex);
    expect(!r.success && r.issues.length).toBe(20);
  });

  it("below the cap everything is reported and nothing is marked truncated", () => {
    const ex = tiny();
    (ex.items[0] as Record<string, unknown>).item_id = "x";
    const r = parsePrivateExportBounded(ex);
    expect(r).toMatchObject({ success: false, truncated: false });
    expect(!r.success && r.issues.map((i) => i.path)).toEqual(["items.0.item_id"]);
  });

  it("the cap is configurable", () => {
    const r = parsePrivateExportBounded({ ...tiny(), items: Array.from({ length: 10 }, () => ({})) }, 3);
    expect(!r.success && r.issues).toHaveLength(3);
  });

  it("buildProjection fails closed with the bounded, value-free report", () => {
    const { arr } = spyArray(50_000, bad);
    const err = violation({ ...tiny(), items: arr });
    expect(err.message).toBe("export_contract_violation");
    const d = err.detail as { issues: { path: string; code: string }[]; truncated: boolean };
    expect(d.issues).toHaveLength(20);
    expect(d.truncated).toBe(true);
    for (const i of d.issues) expect(Object.keys(i).sort()).toEqual(["code", "path"]);
    expect(JSON.stringify(d)).not.toContain("LEAK");
  });
});

describe("the total-row guard in buildProjection (sum over the five collections)", () => {
  it("counts array lengths only", () => {
    expect(exportRowCounts(tiny())).toEqual({ total: 5, sections: { sources: 1, items: 1, buckets: 1, drops: 1, locations: 1 } });
    expect(exportRowCounts(null).total).toBe(0);
    expect(exportRowCounts({ sources: "x", items: { length: 99 } }).total).toBe(0);
  });

  it("the default threshold is 120,000 and an absent config limit keeps it (config JSON unchanged)", () => {
    expect(DEFAULT_MAX_EXPORT_ROWS).toBe(120_000);
    expect(maxExportRows(config)).toBe(120_000);
    expect("limits" in config).toBe(false);
  });

  it("rejects an oversized export before reading a single element, with counts only", () => {
    const a = spyArray(60, (i) => ({ i }));
    const b = spyArray(41, (i) => ({ i }));
    const err = violation({ ...tiny(), sources: a.arr, items: b.arr }, withLimit(100)); // 60 + 41 + 3 = 104 > 100
    expect(err.message).toBe("export_too_large");
    expect(err.detail).toEqual({ limit: 100, rows: 104, sections: { sources: 60, items: 41, buckets: 1, drops: 1, locations: 1 } });
    expect(a.touched.size + b.touched.size).toBe(0);
  });

  it("is an aggregate limit: every collection below it, the sum above it", () => {
    const ex = { ...tiny(), sources: new Array(60), items: new Array(60) };
    expect(violation(ex, withLimit(100)).message).toBe("export_too_large");
  });

  it("exactly at the limit passes the guard; one more row does not", () => {
    expect(buildProjection(tiny(), withLimit(5)).projection).toBeDefined();
    expect(violation(tiny(), withLimit(4)).message).toBe("export_too_large");
  });

  it("default limit: 120,001 rows are refused before any element is read; 120,000 reach validation and fail there, bounded", () => {
    const empty = { items: [], buckets: [], drops: [], locations: [] };
    const over = violation({ ...tiny(), ...empty, sources: new Array(120_001) });
    expect(over.message).toBe("export_too_large");
    expect(over.detail).toMatchObject({ limit: 120_000, rows: 120_001 });
    const at = violation({ ...tiny(), ...empty, sources: new Array(120_000) }); // holes are not valid rows
    expect(at.message).toBe("export_contract_violation");
    expect((at.detail as { issues: unknown[] }).issues).toHaveLength(20);
  });
});

describe("the config limit", () => {
  it("is optional and validated", () => {
    expect(PublicationConfig.safeParse({ ...rawConfig, limits: { maxExportRows: 1000 } }).success).toBe(true);
    for (const v of [0, -1, 1.5, "5", 10_000_001, null]) expect(PublicationConfig.safeParse({ ...rawConfig, limits: { maxExportRows: v } }).success).toBe(false);
    expect(PublicationConfig.safeParse({ ...rawConfig, limits: { maxExportRows: 10, extra: 1 } }).success).toBe(false);
    expect(PublicationConfig.safeParse({ ...rawConfig, limits: {} }).success).toBe(false);
  });
  it("does not change a valid export's published content", () => {
    const a = buildProjection(syntheticExport(1), config).report.contentSha256;
    const b = buildProjection(syntheticExport(1), withLimit(5000)).report.contentSha256;
    expect(b).toBe(a);
  });
});

/** A private-database fake that honours `limit`, serves lazily generated rows and records everything that happens. */
function fakePrivate(sizes: Partial<Record<(typeof EXPORT_SECTIONS)[number], number>>, rowOf: (section: string, i: number) => Record<string, unknown> = (s, i) => ({ s, i })) {
  const statements: { text: string; params: unknown[] }[] = [];
  let produced = 0;
  const client: SqlClient = {
    query: async (text, params = []) => {
      statements.push({ text: text.replace(/\s+/g, " ").trim(), params });
      if (/export_meta_v1/.test(text)) return { rows: [{ contract_version: 1 }] };
      const m = /export_(sources|items|buckets|drops|locations)_v1/.exec(text);
      if (m) {
        const section = m[1] as (typeof EXPORT_SECTIONS)[number];
        const lim = /limit \$(\d+)::bigint/.exec(text);
        const total = sizes[section] ?? 0;
        const n = lim ? Math.min(total, Number(params[Number(lim[1]) - 1])) : total;
        produced += n;
        return { rows: Array.from({ length: n }, (_, i) => rowOf(section, i)) };
      }
      return { rows: [] };
    },
  };
  return { client, statements, produced: () => produced };
}
const collectionLimits = (st: { text: string; params: unknown[] }[]) =>
  st.filter((s) => /export_(sources|items|buckets|drops|locations)_v1/.test(s.text)).map((s) => Number(s.params[s.params.length - 1]));

describe("the database read boundary", () => {
  it("within the budget: same rows as an unbounded read, one repeatable-read read-only snapshot, committed", async () => {
    const f = fakePrivate({ sources: 3, items: 2, buckets: 4, drops: 1, locations: 5 });
    const out = (await readPrivateExport(f.client, 2, 100)) as Record<string, unknown[]>;
    expect(EXPORT_SECTIONS.map((k) => out[k]!.length)).toEqual([3, 2, 4, 1, 5]);
    expect(out.meta).toEqual({ contract_version: 1 });
    expect(f.statements[0]!.text).toBe("begin isolation level repeatable read read only");
    expect(f.statements.at(-1)!.text).toBe("commit");
    expect(f.statements.some((s) => /rollback/.test(s.text))).toBe(false);
    // every collection read carries the REMAINING budget + 1 (the +1 is the oversize proof)
    expect(collectionLimits(f.statements)).toEqual([101, 98, 96, 92, 91]);
  });

  it("the locations grid stays $1; the limit is the last parameter", async () => {
    const f = fakePrivate({ locations: 1 });
    await readPrivateExport(f.client, 2.5, 10);
    const loc = f.statements.find((s) => /export_locations_v1/.test(s.text))!;
    expect(loc.text).toContain("export_locations_v1($1::numeric) limit $2::bigint");
    expect(loc.params).toEqual([2.5, 11]);
  });

  it("exactly the limit passes, one more fails (aggregate across collections)", async () => {
    const ok = fakePrivate({ sources: 4, items: 3, buckets: 2, drops: 1, locations: 0 });
    await expect(readPrivateExport(ok.client, 1, 10)).resolves.toBeDefined();
    const over = fakePrivate({ sources: 4, items: 3, buckets: 2, drops: 1, locations: 1 });
    await expect(readPrivateExport(over.client, 1, 10)).rejects.toMatchObject({ message: "export_too_large" });
  });

  it("an oversized collection stops the read at once: rollback, no commit, later collections never requested", async () => {
    const f = fakePrivate({ sources: 5, items: 50, buckets: 1, drops: 1, locations: 1 });
    const err = (await readPrivateExport(f.client, 1, 20).catch((e) => e)) as PublicationError;
    expect(err).toBeInstanceOf(PublicationError);
    expect(err.message).toBe("export_too_large");
    expect(err.detail).toEqual({ limit: 20, section: "items", rowsReadBeforeStop: 21, sections: { sources: 5 } });
    const text = f.statements.map((s) => s.text);
    expect(text.some((t) => t === "commit")).toBe(false);
    expect(text.at(-1)).toBe("rollback");
    expect(text.some((t) => /export_(buckets|drops|locations)_v1/.test(t))).toBe(false);
  });

  it("never loads more than limit + 1 rows, however large the collections are", async () => {
    const huge = 50_000_000;
    const f = fakePrivate({ sources: huge, items: huge, buckets: huge, drops: huge, locations: huge });
    await expect(readPrivateExport(f.client, 1, 1000)).rejects.toMatchObject({ message: "export_too_large" });
    expect(f.produced()).toBe(1001);
  });

  it("the budget is spent in order and cannot be bypassed by spreading rows over collections", async () => {
    const f = fakePrivate({ sources: 400, items: 400, buckets: 400, drops: 400, locations: 400 });
    await expect(readPrivateExport(f.client, 1, 1000)).rejects.toMatchObject({ message: "export_too_large" });
    expect(f.produced()).toBeLessThanOrEqual(1001);
  });

  it("an invalid limit is refused before the database is touched", async () => {
    for (const bad of [0, -5, 1.5, Number.NaN, Infinity]) {
      const f = fakePrivate({});
      await expect(readPrivateExport(f.client, 1, bad)).rejects.toMatchObject({ message: "invalid_export_limit" });
      expect(f.statements).toHaveLength(0);
    }
  });

  it("a database error mid-read rolls back and is rethrown unchanged", async () => {
    const f = fakePrivate({ sources: 1 });
    const boom = new Error("connection reset");
    const failing: SqlClient = { query: async (t, p) => (/export_items_v1/.test(t) ? Promise.reject(boom) : f.client.query(t, p)) };
    await expect(readPrivateExport(failing, 1, 100)).rejects.toBe(boom);
    expect(f.statements.some((s) => /rollback/.test(s.text))).toBe(true);
  });
});

/** The public database fake of run.test.ts, reduced to what the oversize tests need. */
function fakePublic() {
  const sql: string[] = [];
  const client: ClosableSqlClient = {
    close: async () => undefined,
    query: async (text) => {
      sql.push(text.replace(/\s+/g, " ").trim().slice(0, 80));
      if (/acquire_lease/.test(text)) return { rows: [{ ok: true }] };
      if (/record_run/.test(text)) return { rows: [{ id: 7 }] };
      if (/pg_try_advisory_xact_lock/.test(text)) return { rows: [{ ok: true }] };
      if (/pub_admin\.status/.test(text)) return { rows: [{ s: { active: 12, publications: [{ id: 12, sha: "ACTIVE-SHA" }] } }] };
      if (/begin_publication/.test(text)) return { rows: [{ id: 41 }] };
      if (/finalize_publication/.test(text)) return { rows: [{ outcome: "activated" }] };
      return { rows: [] };
    },
  };
  return { client, sql };
}
const runDeps = (priv: SqlClient, cfg = config) => {
  const pub = fakePublic();
  const logs: string[] = [];
  const d: RunDeps = {
    config: cfg, workerVersion: "test", runtime: "test", publicRole: "foreverdb_publisher",
    openPrivate: async () => ({ ...priv, close: async () => undefined }),
    openPublic: async () => pub.client, log: (e, data) => logs.push(JSON.stringify({ e, data })),
  };
  return { d, pub, logs };
};

describe("runPublication with a private export over the limit", () => {
  it("fails closed with export_too_large and never touches the active publication", async () => {
    const f = fakePrivate({ sources: 400, items: 400, buckets: 400, drops: 400, locations: 400 });
    const { d, pub, logs } = runDeps(f.client, withLimit(1000));
    const r = await runPublication(d, { mode: "publish", trigger: "manual", source: "private", scale: undefined });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("failed");
    expect(r.errorClass).toBe("export_too_large");
    expect(f.produced()).toBeLessThanOrEqual(1001);
    const wrote = pub.sql.filter((s) => /begin_publication|finalize_publication|insert into pub\./i.test(s));
    expect(wrote).toEqual([]); // no staging, no activation: the previous active publication is untouched
    expect(pub.sql.some((s) => /record_run/.test(s))).toBe(true); // the failure is recorded
    expect(logs.join("\n")).not.toMatch(/"s":"sources"/); // no row content in the logs
  });

  it("a dry run fails closed the same way", async () => {
    const f = fakePrivate({ sources: 2000 });
    const { d, pub } = runDeps(f.client, withLimit(1000));
    const r = await runPublication(d, { mode: "dry_run", trigger: "manual", source: "private" });
    expect(r.errorClass).toBe("export_too_large");
    expect(pub.sql.filter((s) => /begin_publication|finalize_publication/.test(s))).toEqual([]);
  });

  it("an export within the limit is processed exactly as before (same content hash through the database read path)", async () => {
    const ex = syntheticExport(1) as Record<string, Record<string, unknown>[]>;
    const serve = (section: string, i: number) => ex[section]![i]!;
    const f = fakePrivate(
      { sources: ex.sources!.length, items: ex.items!.length, buckets: ex.buckets!.length, drops: ex.drops!.length, locations: ex.locations!.length },
      serve,
    );
    const q = f.client.query;
    f.client.query = async (t, p) => (/export_meta_v1/.test(t) ? { rows: [(ex.meta as unknown) as Record<string, unknown>] } : q(t, p));
    const { d } = runDeps(f.client);
    const r = await runPublication(d, { mode: "dry_run", trigger: "manual", source: "private" });
    expect(r.ok).toBe(true);
    expect(r.sha256).toBe(buildProjection(syntheticExport(1), config).report.contentSha256);
    expect(collectionLimits(f.statements)[0]).toBe(DEFAULT_MAX_EXPORT_ROWS + 1);
  });
});
