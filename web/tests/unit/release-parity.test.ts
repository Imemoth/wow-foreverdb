import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { ALLOWED_ASSET_HOSTS as APP_ALLOWED_HOSTS } from "@/lib/maps/asset-url";
import { talentIconBase } from "@/lib/talents/icons";
import { talentTextPublished } from "@/lib/talents/text";

/**
 * Release parity regression. A green build is not proof that approved features are active: the talent icons and the rank
 * descriptions are switched on by Vercel variables that a build never validates. These tests pin (1) the policy against the
 * code that actually reads the variables, (2) the evaluator's verdicts for the exact production states seen in the audit,
 * and (3) that no secret value can ever appear in the report.
 */
const run = promisify(execFile);
const SCRIPT = join(process.cwd(), "scripts", "release-parity.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let P: any;
beforeAll(async () => {
  P = await import(pathToFileURL(join(process.cwd(), "scripts", "lib", "release-parity.mjs")).href);
});

const CDN = "https://azerdex-assets.pages.dev";
const plain = (key: string, value: string, target: string[], extra: Record<string, unknown> = {}) => ({ key, value, type: "plain", target, gitBranch: null, ...extra });
const secret = (key: string, target: string[], extra: Record<string, unknown> = {}) => ({ key, type: "encrypted", value: "ENCRYPTED-BLOB-CANARY-9f3a", target, gitBranch: null, ...extra });
const BETA = "web/azerdex-beta";

/** A healthy configuration: beta carries everything on a branch-bound preview variable, production the approved switches. */
function healthy() {
  const approved = (t: string[], b: string | null = null) => [
    plain("AZERDEX_TALENT_ICONS", "cdn", t, { gitBranch: b }),
    plain("AZERDEX_TALENT_TEXT", "1", t, { gitBranch: b }),
    plain("AZERDEX_ZONE_MAPS", "1", t, { gitBranch: b }),
    plain("AZERDEX_ZONE_HERO_SOURCE", "cdn", t, { gitBranch: b }),
    plain("NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL", CDN, t, { gitBranch: b }),
  ];
  return [
    ...approved(["production"]),
    ...approved(["preview"], BETA),
    plain("FOREVERDB_DEPLOYMENT", "production", ["production"]),
    plain("FOREVERDB_DEPLOYMENT", "preview", ["preview"]),
    plain("BETA_SEO_AUTHORIZED_BRANCH", BETA, ["preview"], { gitBranch: BETA }),
    secret("AZERDEX_READ_DB_URL", ["production"]),
    secret("ACCOUNT_AUTH_PUBLISHABLE_KEY", ["production"]),
    secret("UPSTASH_REDIS_REST_TOKEN", ["production"]),
    plain("RATE_LIMIT_BACKEND", "upstash", ["production"]),
    plain("SITE_URL", "https://azerdex.com", ["production"]),
  ];
}
const without = (entries: ReturnType<typeof healthy>, key: string, target: string) => entries.filter((e) => !(e.key === key && (e.target as string[]).includes(target)));
type Row = { key: string; status: string; reason: string; class: string; evaluation: string };
const row = (res: { rows: Row[] }, key: string): Row => res.rows.find((r) => r.key === key) as Row;

describe("policy is pinned to the code that reads the variables", () => {
  it("every approved switch value really enables the feature in the application code", () => {
    const env = { AZERDEX_TALENT_ICONS: "cdn", AZERDEX_TALENT_TEXT: "1", FOREVERDB_DEPLOYMENT: "production", NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: CDN };
    expect(talentIconBase(env)).toBe(CDN);
    expect(talentTextPublished(env)).toBe(true);
    const spec = Object.fromEntries(P.REQUIRED_FEATURES.map((f: { key: string; value: string }) => [f.key, f.value]));
    expect(spec).toEqual({ AZERDEX_TALENT_ICONS: "cdn", AZERDEX_TALENT_TEXT: "1", AZERDEX_ZONE_MAPS: "1", AZERDEX_ZONE_HERO_SOURCE: "cdn" });
  });
  it("the near-miss values the audit worried about do NOT enable the feature (so the exact value matters)", () => {
    expect(talentIconBase({ AZERDEX_TALENT_ICONS: "1", NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: CDN })).toBeNull(); // icons need `cdn`, not `1`
    expect(talentIconBase({ NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: CDN })).toBeNull();
    expect(talentTextPublished({ FOREVERDB_DEPLOYMENT: "production" })).toBe(false); // the audited production state: text withheld
    expect(talentTextPublished({ FOREVERDB_DEPLOYMENT: "production", AZERDEX_TALENT_TEXT: "true" })).toBe(false);
  });
  it("the asset host allow-list is identical to the application's", () => {
    expect([...P.ALLOWED_ASSET_HOSTS].sort()).toEqual([...APP_ALLOWED_HOSTS].sort());
  });
  it("the forbidden-name rule mirrors the application's", () => {
    for (const bad of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_KEY", "SERVICE_ROLE_KEY", "DATABASE_URL", "POSTGRES_URL"]) expect(P.FORBIDDEN_NAME.test(bad)).toBe(true);
    for (const ok of ["AZERDEX_READ_DB_URL", "ACCOUNT_AUTH_URL", "SITE_URL"]) expect(P.FORBIDDEN_NAME.test(ok)).toBe(false);
  });
});

describe("evaluateParity", () => {
  it("passes a healthy configuration", () => {
    const res = P.evaluateParity(healthy());
    expect(res.failures).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("FAILS on the audited production state: icons and text switches missing", () => {
    const audited = without(without(healthy(), "AZERDEX_TALENT_ICONS", "production"), "AZERDEX_TALENT_TEXT", "production");
    const res = P.evaluateParity(audited);
    expect(res.ok).toBe(false);
    expect(row(res, "AZERDEX_TALENT_ICONS")).toMatchObject({ status: "fail", class: "required-match" });
    expect(row(res, "AZERDEX_TALENT_ICONS").reason).toMatch(/MISSING in production/);
    expect(row(res, "AZERDEX_TALENT_TEXT").status).toBe("fail");
    expect(row(res, "AZERDEX_ZONE_MAPS").status).toBe("pass"); // only the missing ones fail
  });

  it.each([
    ["AZERDEX_TALENT_ICONS", "1"], // the documented trap: icons need `cdn`
    ["AZERDEX_TALENT_ICONS", "CDN"],
    ["AZERDEX_TALENT_TEXT", "true"],
    ["AZERDEX_TALENT_TEXT", "0"],
    ["AZERDEX_ZONE_MAPS", "true"],
    ["AZERDEX_ZONE_HERO_SOURCE", "same-origin"],
  ])("FAILS when production has %s=%s (exact value required)", (key, value) => {
    const e = healthy().map((x) => (x.key === key && (x.target as string[]).includes("production") ? { ...x, value } : x));
    expect(row(P.evaluateParity(e), key).status).toBe("fail");
  });

  it.each(["AZERDEX_TALENT_ICONS", "AZERDEX_TALENT_TEXT", "AZERDEX_ZONE_MAPS", "AZERDEX_ZONE_HERO_SOURCE", "NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL"])(
    "a missing production %s fails the gate",
    (key) => {
      const res = P.evaluateParity(without(healthy(), key, "production"));
      expect(res.ok).toBe(false);
      expect(row(res, key).status).toBe("fail");
    },
  );

  it("treats an opaque (sensitive/encrypted) approved switch as unverifiable, never as a pass", () => {
    const e = healthy().map((x) => (x.key === "AZERDEX_TALENT_TEXT" && (x.target as string[]).includes("production") ? { ...x, type: "sensitive", value: undefined } : x));
    const r = row(P.evaluateParity(e), "AZERDEX_TALENT_TEXT");
    expect(r.status).toBe("fail");
    expect(r.reason).toMatch(/not readable/);
  });

  it("fails when beta has drifted from the approved value or lacks the switch", () => {
    const drift = healthy().map((x) => (x.key === "AZERDEX_ZONE_MAPS" && (x.target as string[]).includes("preview") ? { ...x, value: "0" } : x));
    expect(row(P.evaluateParity(drift), "AZERDEX_ZONE_MAPS").status).toBe("fail");
    const noBeta = P.evaluateParity(without(healthy(), "AZERDEX_TALENT_ICONS", "preview"));
    expect(row(noBeta, "AZERDEX_TALENT_ICONS").reason).toMatch(/missing in beta/);
  });

  describe("shared / preview-wide / branch precedence", () => {
    it("branch-bound preview variable overrides a preview-wide one; a different branch's variable is ignored", () => {
      const e = [
        ...healthy().filter((x) => !(x.key === "AZERDEX_TALENT_ICONS" && (x.target as string[]).includes("preview"))),
        plain("AZERDEX_TALENT_ICONS", "1", ["preview"]), // preview-wide: wrong
        plain("AZERDEX_TALENT_ICONS", "cdn", ["preview"], { gitBranch: BETA }), // beta-specific: right, wins
        plain("AZERDEX_TALENT_ICONS", "off", ["preview"], { gitBranch: "some/other-branch" }), // other branch: irrelevant
      ];
      expect(P.effectiveEnv(e, "beta").get("AZERDEX_TALENT_ICONS").value).toBe("cdn");
      expect(row(P.evaluateParity(e), "AZERDEX_TALENT_ICONS").status).toBe("pass");
    });
    it("a shared Preview variable satisfies beta, and a project variable outranks a shared one", () => {
      const e = [
        ...without(healthy(), "AZERDEX_ZONE_HERO_SOURCE", "preview"),
        { key: "AZERDEX_ZONE_HERO_SOURCE", value: "cdn", type: "shared", target: ["preview"], gitBranch: null },
      ];
      expect(P.effectiveEnv(e, "beta").get("AZERDEX_ZONE_HERO_SOURCE").layer).toBe("shared");
      expect(row(P.evaluateParity(e), "AZERDEX_ZONE_HERO_SOURCE").status).toBe("pass");
      const over = [...e, plain("AZERDEX_ZONE_HERO_SOURCE", "same-origin", ["preview"])];
      expect(P.effectiveEnv(over, "beta").get("AZERDEX_ZONE_HERO_SOURCE").value).toBe("same-origin");
    });
    it("a Preview-only variable never counts as a production value", () => {
      const e = [...without(healthy(), "AZERDEX_TALENT_TEXT", "production"), plain("AZERDEX_TALENT_TEXT", "1", ["preview"])];
      expect(row(P.evaluateParity(e), "AZERDEX_TALENT_TEXT").status).toBe("fail");
    });
    it("a variable bound to a branch is not a production value even if it also lists production", () => {
      const e = [...without(healthy(), "AZERDEX_TALENT_TEXT", "production"), plain("AZERDEX_TALENT_TEXT", "1", ["production", "preview"], { gitBranch: "release" })];
      expect(row(P.evaluateParity(e), "AZERDEX_TALENT_TEXT").status).toBe("fail");
    });
  });

  describe("shared asset CDN host", () => {
    it("rejects non-allow-listed, non-https and differing hosts", () => {
      for (const bad of ["https://evil.example", "http://azerdex-assets.pages.dev", "https://azerdex-assets.pages.dev:8443", "https://user@azerdex-assets.pages.dev"]) {
        const e = healthy().map((x) => (x.key === "NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL" && (x.target as string[]).includes("production") ? { ...x, value: bad } : x));
        expect(row(P.evaluateParity(e), "NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL").status).toBe("fail");
      }
      const split = healthy().map((x) => (x.key === "NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL" && (x.target as string[]).includes("production") ? { ...x, value: "https://assets.azerdex.com" } : x));
      expect(row(P.evaluateParity(split), "NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL").reason).toMatch(/different asset hosts/);
    });
    it("is classified as build-time (NEXT_PUBLIC_*), the runtime switches as runtime", () => {
      const res = P.evaluateParity(healthy());
      expect(row(res, "NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL")).toMatchObject({ evaluation: "build" });
      expect(row(res, "AZERDEX_TALENT_TEXT")).toMatchObject({ evaluation: "runtime" });
    });
  });

  describe("intentional differences are preserved, unexpected ones fail", () => {
    it("allows secrets, databases, rate limiting, account auth and feedback to differ", () => {
      const e = [...healthy(), plain("FEEDBACK_ENDPOINT", "x", ["preview"], { gitBranch: BETA }), secret("TURNSTILE_SECRET_KEY", ["production"]), secret("ACCOUNT_CSRF_SECRET", ["preview"], { gitBranch: BETA })];
      const res = P.evaluateParity(e);
      expect(res.ok).toBe(true);
      for (const k of ["AZERDEX_READ_DB_URL", "ACCOUNT_AUTH_PUBLISHABLE_KEY", "UPSTASH_REDIS_REST_TOKEN", "FEEDBACK_ENDPOINT", "TURNSTILE_SECRET_KEY"]) expect(row(res, k)).toMatchObject({ class: "intentional", status: "pass" });
    });
    it("production SEO vs beta noindex: BETA_SEO_AUTHORIZED_BRANCH must not exist in production and must equal the beta branch in beta", () => {
      expect(row(P.evaluateParity([...healthy(), plain("BETA_SEO_AUTHORIZED_BRANCH", BETA, ["production"])]), "BETA_SEO_AUTHORIZED_BRANCH").status).toBe("fail");
      const wrongBranch = healthy().map((x) => (x.key === "BETA_SEO_AUTHORIZED_BRANCH" ? { ...x, value: "release" } : x));
      expect(row(P.evaluateParity(wrongBranch), "BETA_SEO_AUTHORIZED_BRANCH").status).toBe("fail");
    });
    it("FOREVERDB_DEPLOYMENT must be production in production and preview in beta", () => {
      const prodPreview = healthy().map((x) => (x.key === "FOREVERDB_DEPLOYMENT" && (x.target as string[]).includes("production") ? { ...x, value: "preview" } : x));
      expect(row(P.evaluateParity(prodPreview), "FOREVERDB_DEPLOYMENT").status).toBe("fail");
      expect(row(P.evaluateParity(without(healthy(), "FOREVERDB_DEPLOYMENT", "production")), "FOREVERDB_DEPLOYMENT").status).toBe("fail");
    });
    it("an unclassified variable that differs is an unexpected difference and fails", () => {
      const res = P.evaluateParity([...healthy(), plain("MYSTERY_FLAG", "1", ["preview"], { gitBranch: BETA })]);
      expect(res.ok).toBe(false);
      expect(row(res, "MYSTERY_FLAG")).toMatchObject({ class: "unexpected", status: "fail" });
    });
    it("an unclassified variable identical in both passes; platform VERCEL_* variables are ignored", () => {
      const res = P.evaluateParity([...healthy(), plain("SOME_SHARED_TOGGLE", "a", ["production"]), plain("SOME_SHARED_TOGGLE", "a", ["preview"]), plain("VERCEL_URL", "x", ["production"])]);
      expect(res.ok).toBe(true);
      expect(res.rows.some((r: { key: string }) => r.key === "VERCEL_URL")).toBe(false);
    });
    it("forbidden private-backend names fail wherever they appear", () => {
      expect(P.evaluateParity([...healthy(), secret("SUPABASE_SERVICE_ROLE_KEY", ["production"])]).ok).toBe(false);
      expect(P.evaluateParity([...healthy(), secret("DATABASE_URL", ["preview"], { gitBranch: BETA })]).ok).toBe(false);
    });
    it("an unapproved third-party feature (AZERDEX_POC_MAPS) must stay off in production", () => {
      expect(row(P.evaluateParity([...healthy(), plain("AZERDEX_POC_MAPS", "1", ["production"])]), "AZERDEX_POC_MAPS").status).toBe("fail");
      expect(row(P.evaluateParity(healthy()), "AZERDEX_POC_MAPS")).toMatchObject({ class: "requires-approval", status: "pass" });
    });
  });

  describe("a successful build is not proof (deployment freshness)", () => {
    it("fails when the deployment was created before the latest change of an approved variable", () => {
      const e = healthy().map((x) => ((x.target as string[]).includes("production") && x.key === "AZERDEX_TALENT_TEXT" ? { ...x, updatedAt: 2_000 } : x));
      const stale = P.evaluateParity(e, { deployment: { createdAt: 1_000, target: "production" } });
      expect(stale.ok).toBe(false);
      expect(row(stale, "(deployment freshness)").reason).toMatch(/AZERDEX_TALENT_TEXT/);
      expect(P.evaluateParity(e, { deployment: { createdAt: 3_000, target: "production" } }).ok).toBe(true);
    });
    it("fails when the deployment under test is not a production deployment", () => {
      expect(P.evaluateParity(healthy(), { deployment: { createdAt: 9e12, target: null } }).ok).toBe(false);
    });
  });

  it("never leaks a secret value: only public switch values appear in the report", () => {
    const e = [...healthy(), plain("RATE_LIMIT_SALT", "SALT-CANARY-0123456789abcdef", ["production"]), plain("ACCOUNT_AUTH_URL", "https://canary-project.example", ["production"]), plain("MYSTERY", "UNCLASSIFIED-CANARY", ["production"])];
    const out = JSON.stringify(P.evaluateParity(e));
    for (const canary of ["SALT-CANARY", "ENCRYPTED-BLOB-CANARY", "canary-project", "UNCLASSIFIED-CANARY"]) expect(out).not.toContain(canary);
    expect(out).toContain('"value":"cdn"'); // the approved switches are public by construction
  });
});

describe("assessClassPage (live-site probe)", () => {
  const csp = `default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'; style-src 'self' 'nonce-abc'; img-src 'self' data: ${CDN}; connect-src 'self'`;
  const html = `<html><body><img src="${CDN}/talent-icons/1.60.1.70634/136012.webp"><p>Increases damage by ?%</p></body></html>`;
  it("passes with icons from the CDN and a nonce-only CSP", () => {
    expect(P.assessClassPage({ html, csp }, { assetOrigin: CDN })).toEqual({ icons: 1, problems: [] });
  });
  it("fails without icons, without the CSP origin, with unsafe-inline, or with raw template tokens", () => {
    expect(P.assessClassPage({ html: "<p>x</p>", csp }, { assetOrigin: CDN }).problems.join()).toMatch(/no talent icon/);
    expect(P.assessClassPage({ html, csp: csp.replace(CDN, "") }, { assetOrigin: CDN }).problems.join()).toMatch(/img-src/);
    expect(P.assessClassPage({ html, csp: csp.replace("'strict-dynamic'", "'unsafe-inline'") }, { assetOrigin: CDN }).problems.join()).toMatch(/unsafe-inline/);
    expect(P.assessClassPage({ html: html + "<p>Deals $s1 damage over $d</p>", csp }, { assetOrigin: CDN }).problems.join()).toMatch(/raw template token/);
  });
  it("does not mistake ordinary text, the explicit ? gap marker or scripts for raw tokens", () => {
    expect(P.hasRawTemplateToken("Increases damage by ?% for ? sec. Costs $5 or 5$")).toBe(false);
    expect(P.visibleText('<script>var a="$s1"</script><p>ok</p>')).not.toMatch(/\$s1/);
    expect(P.hasRawTemplateToken("Deals $s1 damage")).toBe(true);
  });
  it("visibleText drops script/style content for every legal end-tag spelling (CodeQL js/bad-tag-filter)", () => {
    for (const end of ["</script>", "</script >", "</SCRIPT\n>", "</script foo='bar'>", "</ScRiPt\t>"]) {
      expect(P.visibleText(`<p>ok</p><script>var a="$s1";${end}<p>after</p>`)).not.toMatch(/\$s1/);
      expect(P.visibleText(`<p>ok</p><script>var a="$s1";${end}<p>after</p>`)).toMatch(/after/);
    }
    expect(P.visibleText("<style>.a{content:'$s1'}</style >x")).not.toMatch(/\$s1/);
    expect(P.visibleText("<p>a</p><script>never closed $s1")).not.toMatch(/\$s1/); // unterminated: all of it is script
    expect(P.visibleText("1 < 2 and <b>bold</b> text")).toMatch(/bold/);
    expect(P.visibleText("<scripts>kept</scripts>")).toMatch(/kept/); // not a script tag
  });
  it("visibleText strips tags without regex HTML filtering", () => {
    expect(P.visibleText('<a href="x>y">link</a>')).toMatch(/link/);
    expect(P.hasRawTemplateToken("{{spell:1}}")).toBe(true);
  });
});

describe("release-parity CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "azerdex-parity-"));
  const exec = async (entries: unknown, extra: string[] = []) => {
    const f = join(dir, `env-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify({ envs: entries }));
    try {
      const r = await run(process.execPath, [SCRIPT, "--snapshot", f, ...extra]);
      return { code: 0, out: r.stdout };
    } catch (e) {
      const x = e as { code: number; stdout: string; stderr: string };
      return { code: x.code, out: x.stdout + x.stderr };
    }
  };
  it("exits 0 for a healthy snapshot and 1 when a required production switch is missing", async () => {
    expect((await exec(healthy())).code).toBe(0);
    const bad = await exec(without(healthy(), "AZERDEX_TALENT_ICONS", "production"));
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/FAIL\s+\[required-match\] AZERDEX_TALENT_ICONS/);
    expect(bad.out).toMatch(/PARITY FAILED/);
  });
  it("never prints a secret value", async () => {
    const r = await exec([...healthy(), plain("ACCOUNT_AUTH_URL", "https://canary-project.example", ["production"])]);
    expect(r.out).not.toMatch(/canary-project|ENCRYPTED-BLOB-CANARY/);
  });
  it("exits 2 (NO-GO) on usage errors and refuses live mode without a token", async () => {
    await expect(run(process.execPath, [SCRIPT])).rejects.toMatchObject({ code: 2 });
    await expect(run(process.execPath, [SCRIPT, "--live"], { env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv })).rejects.toMatchObject({ code: 2 });
  });
});

describe("trusted release gate workflow", () => {
  const wf = readFileSync(join(process.cwd(), "..", ".github", "workflows", "release-parity.yml"), "utf8");
  it("never runs on pull requests (secrets must not reach untrusted code) and runs on the production branch", () => {
    expect(wf).not.toMatch(/^\s*pull_request(_target)?\s*:/m);
    expect(wf).toMatch(/workflow_dispatch/);
    expect(wf).toMatch(/branches:\s*\[release\]/);
  });
  it("uses a protected environment, read-only permissions and no checkout of a PR head", () => {
    expect(wf).toMatch(/environment:\s*release-parity/);
    expect(wf).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(wf).not.toMatch(/github\.event\.pull_request|head\.ref|head\.sha/);
  });
  it("only reads the Vercel token inside the live step", () => {
    const occurrences = wf.match(/secrets\.VERCEL_/g) ?? [];
    expect(occurrences.length).toBeGreaterThan(0);
    expect(wf.split("\n").filter((l) => /secrets\.VERCEL_/.test(l)).every((l) => /^\s+VERCEL_[A-Z_]+:\s*\$\{\{ secrets\.VERCEL_[A-Z_]+ \}\}\s*$/.test(l))).toBe(true);
  });
});

describe("gate assumptions checked against the real configuration (no false positives, still fail closed)", () => {
  const betaNoText = () => without(healthy(), "AZERDEX_TALENT_TEXT", "preview");

  describe("AZERDEX_TALENT_TEXT is implicit in the beta (any non-production designation publishes it)", () => {
    it("matches the application: preview publishes the text without the variable, production withholds it", () => {
      expect(talentTextPublished({ FOREVERDB_DEPLOYMENT: "preview" })).toBe(true);
      expect(talentTextPublished({ FOREVERDB_DEPLOYMENT: "production" })).toBe(false);
    });
    it("a beta without the variable passes while its designation is a readable `preview` (beta is NOT changed to satisfy the gate)", () => {
      const res = P.evaluateParity(betaNoText());
      expect(res.ok).toBe(true);
      expect(row(res, "AZERDEX_TALENT_TEXT")).toMatchObject({ status: "pass" });
      expect(row(res, "AZERDEX_TALENT_TEXT").reason).toMatch(/implicitly/);
    });
    it("production still needs the exact value: missing, wrong or opaque in production fails even though beta is implicit", () => {
      expect(row(P.evaluateParity(without(betaNoText(), "AZERDEX_TALENT_TEXT", "production")), "AZERDEX_TALENT_TEXT").status).toBe("fail");
      const wrong = betaNoText().map((x) => (x.key === "AZERDEX_TALENT_TEXT" ? { ...x, value: "true" } : x));
      expect(row(P.evaluateParity(wrong), "AZERDEX_TALENT_TEXT").status).toBe("fail");
    });
    it("the implicit path needs a readable `preview` designation: missing, production or opaque designation in beta fails", () => {
      for (const designation of [undefined, "production", "local"]) {
        const e = betaNoText().filter((x) => !(x.key === "FOREVERDB_DEPLOYMENT" && (x.target as string[]).includes("preview")));
        if (designation) e.push(plain("FOREVERDB_DEPLOYMENT", designation, ["preview"]));
        const r = P.evaluateParity(e);
        expect(row(r, "AZERDEX_TALENT_TEXT").status, String(designation)).toBe("fail");
      }
      const opaque = betaNoText().map((x) => (x.key === "FOREVERDB_DEPLOYMENT" && (x.target as string[]).includes("preview") ? { ...x, type: "sensitive", value: undefined } : x));
      expect(row(P.evaluateParity(opaque), "AZERDEX_TALENT_TEXT").status).toBe("fail");
    });
    it("an explicit wrong beta value is still drift, and the other switches are NOT implicit (icons, zone maps, hero stay required in beta)", () => {
      const drift = healthy().map((x) => (x.key === "AZERDEX_TALENT_TEXT" && (x.target as string[]).includes("preview") ? { ...x, value: "0" } : x));
      expect(row(P.evaluateParity(drift), "AZERDEX_TALENT_TEXT").status).toBe("fail");
      for (const key of ["AZERDEX_TALENT_ICONS", "AZERDEX_ZONE_MAPS", "AZERDEX_ZONE_HERO_SOURCE"]) {
        expect(row(P.evaluateParity(without(healthy(), key, "preview")), key).reason).toMatch(/missing in beta/);
      }
    });
  });

  describe("encrypted variables (the Vercel default type) are verifiable for the public switches only", () => {
    const encrypted = (key: string, target: string[], id: string, extra: Record<string, unknown> = {}) => ({ key, type: "encrypted", value: "CIPHERTEXT-CANARY-77aa", id, target, gitBranch: null, ...extra });
    const asEncryptedProd = () => healthy().map((x, i) => ((x.target as string[]).includes("production") && ["AZERDEX_TALENT_ICONS", "AZERDEX_TALENT_TEXT"].includes(x.key) ? encrypted(x.key, ["production"], `envid${i}`) : x));

    it("without decryption an encrypted switch is unreadable and fails (fail closed)", () => {
      const r = P.evaluateParity(asEncryptedProd());
      expect(r.ok).toBe(false);
      expect(row(r, "AZERDEX_TALENT_ICONS").reason).toMatch(/not readable/);
    });
    it("with the per-variable read it verifies the exact value and passes", async () => {
      const truth: Record<string, string> = { AZERDEX_TALENT_ICONS: "cdn", AZERDEX_TALENT_TEXT: "1" };
      const resolved = await P.resolvePublicValues(asEncryptedProd(), async (e: { key: string }) => truth[e.key]);
      const r = P.evaluateParity(resolved);
      expect(r.ok).toBe(true);
      expect(row(r, "AZERDEX_TALENT_ICONS")).toMatchObject({ status: "pass" });
    });
    it("a decrypted wrong value still fails (icons=1 is not cdn, text=true is not 1)", async () => {
      const resolved = await P.resolvePublicValues(asEncryptedProd(), async (e: { key: string }) => (e.key === "AZERDEX_TALENT_ICONS" ? "1" : "true"));
      const r = P.evaluateParity(resolved);
      expect(row(r, "AZERDEX_TALENT_ICONS").status).toBe("fail");
      expect(row(r, "AZERDEX_TALENT_TEXT").status).toBe("fail");
    });
    it("a failed or empty read leaves the variable opaque, so the gate fails closed", async () => {
      for (const reader of [async () => { throw new Error("403"); }, async () => undefined, async () => 42]) {
        const r = P.evaluateParity(await P.resolvePublicValues(asEncryptedProd(), reader));
        expect(r.ok).toBe(false);
        expect(row(r, "AZERDEX_TALENT_ICONS").reason).toMatch(/not readable/);
      }
    });
    it("only policy-public encrypted keys are ever read: secrets, other encrypted values and sensitive variables never are", async () => {
      const seen: string[] = [];
      const entries = [
        ...asEncryptedProd(),
        encrypted("AZERDEX_READ_DB_URL", ["production"], "envdb"),
        encrypted("RATE_LIMIT_SALT", ["production"], "envsalt"),
        encrypted("ACCOUNT_AUTH_PUBLISHABLE_KEY", ["production"], "envacct"),
        encrypted("MYSTERY_ENCRYPTED", ["production"], "envmystery"),
        encrypted("AZERDEX_TALENT_TEXT", ["production"], "envsens", { type: "sensitive" }),
      ];
      await P.resolvePublicValues(entries, async (e: { key: string }) => { seen.push(e.key); return "x"; });
      expect(seen.sort()).toEqual(["AZERDEX_TALENT_ICONS", "AZERDEX_TALENT_TEXT"]);
      expect(P.isPublicKey("AZERDEX_READ_DB_URL")).toBe(false);
      expect(P.isPublicKey("AZERDEX_TALENT_ICONS")).toBe(true);
    });
    it("rejects an unsafe variable id instead of putting it in a URL", async () => {
      const seen: unknown[] = [];
      await P.resolvePublicValues([encrypted("AZERDEX_TALENT_ICONS", ["production"], "../../team/secrets")], async (e: unknown) => { seen.push(e); return "cdn"; });
      expect(seen).toEqual([]);
    });
    it("never leaks the ciphertext or any non-public value into the report", async () => {
      const resolved = await P.resolvePublicValues([...asEncryptedProd(), encrypted("RATE_LIMIT_SALT", ["production"], "envsalt")], async () => "cdn");
      const out = JSON.stringify(P.evaluateParity(resolved));
      expect(out).not.toContain("CIPHERTEXT-CANARY");
    });
  });

  describe("probe authentication with a temporary Vercel shareable link", () => {
    const probe = async (args: string[], env: Record<string, string> = {}) => {
      try { const r = await run(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv }); return { code: 0, out: r.stdout + r.stderr }; }
      catch (e) { const x = e as { code: number; stdout: string; stderr: string }; return { code: x.code, out: x.stdout + x.stderr }; }
    };
    it("refuses a non-*.vercel.app host, an unset variable, and mixing both secrets: exit 2 (NO-GO), secret never echoed", async () => {
      const a = await probe(["--probe", "https://azerdex.com", "--share-env", "S"], { S: "super-secret-canary" });
      expect(a.code).toBe(2);
      expect(a.out).toMatch(/not https:\/\/\*\.vercel\.app/);
      expect(a.out).not.toContain("super-secret-canary");
      expect((await probe(["--probe", "https://x.vercel.app", "--share-env", "NOT_SET"])).code).toBe(2);
      const both = await probe(["--probe", "https://x.vercel.app", "--share-env", "S", "--bypass-env", "S"], { S: "v" });
      expect(both.code).toBe(2);
      expect(both.out).toMatch(/not both/);
    });
  });
});
