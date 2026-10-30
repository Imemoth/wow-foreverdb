import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsentManager } from "@/components/consent/ConsentManager";
import { SiteFooter } from "@/components/SiteFooter";
import {
  CONSENT_STORAGE_KEY,
  PRIVACY_NOTICE_VERSION,
  createConsentRecord,
  hasAnalyticsConsent,
  isCurrentDecision,
  parseConsentRecord,
} from "@/lib/consent";
import { consentedAnalyticsEvent } from "@/lib/analytics";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const NOW = new Date("2026-10-30T12:34:56.000Z");

describe("consent record: minimal, versioned, strictly parsed", () => {
  it("stores only the choice, the date and the notice version, and nothing else", () => {
    const r = createConsentRecord(true, NOW);
    expect(r).toEqual({ v: 1, analytics: true, at: "2026-10-30", notice: PRIVACY_NOTICE_VERSION });
    expect(Object.keys(r).sort()).toEqual(["analytics", "at", "notice", "v"]);
    expect(JSON.stringify(r).length).toBeLessThan(80);
    expect(CONSENT_STORAGE_KEY).toBe("azerdex-consent");
  });

  it("round-trips a valid record", () => {
    for (const analytics of [true, false]) {
      expect(parseConsentRecord(JSON.stringify(createConsentRecord(analytics, NOW)))).toEqual(createConsentRecord(analytics, NOW));
    }
  });

  it("treats anything unexpected as no decision (never as consent)", () => {
    const ok = createConsentRecord(true, NOW);
    const bad: unknown[] = [
      null, undefined, "", "null", "true", "[]", "{}", "not json", "x".repeat(300),
      JSON.stringify({ ...ok, v: 2 }), JSON.stringify({ ...ok, analytics: "true" }), JSON.stringify({ ...ok, analytics: 1 }),
      JSON.stringify({ ...ok, at: "30/10/2026" }), JSON.stringify({ ...ok, notice: 20261030 }), JSON.stringify({ ...ok, extra: 1 }),
      JSON.stringify({ v: 1, analytics: true, at: "2026-10-30" }),
    ];
    for (const raw of bad) {
      expect(parseConsentRecord(raw as string | null | undefined), String(raw)).toBeNull();
      expect(hasAnalyticsConsent(parseConsentRecord(raw as string | null | undefined))).toBe(false);
    }
  });

  it("only an affirmative choice made under the CURRENT notice version counts", () => {
    expect(hasAnalyticsConsent(createConsentRecord(true, NOW))).toBe(true);
    expect(hasAnalyticsConsent(createConsentRecord(false, NOW))).toBe(false);
    expect(hasAnalyticsConsent(null)).toBe(false);
    const old = createConsentRecord(true, NOW, "2025-01-01");
    expect(isCurrentDecision(old)).toBe(false);
    expect(hasAnalyticsConsent(old)).toBe(false); // a changed notice withdraws earlier consent and asks again
    expect(isCurrentDecision(createConsentRecord(false, NOW))).toBe(true); // a refusal is remembered too
  });
});

type FakeWindow = { localStorage: Storage; addEventListener: (t: string, fn: (e: { key: string | null }) => void) => void };
function installWindow(store: Record<string, string>, opts: { setThrows?: boolean; getThrows?: boolean } = {}) {
  const handlers: Array<(e: { key: string | null }) => void> = [];
  const localStorage = {
    getItem: (k: string) => {
      if (opts.getThrows) throw new Error("denied");
      return k in store ? store[k]! : null;
    },
    setItem: (k: string, v: string) => {
      if (opts.setThrows) throw new Error("denied");
      store[k] = v;
    },
  } as unknown as Storage;
  const w: FakeWindow = { localStorage, addEventListener: (t, fn) => { if (t === "storage") handlers.push(fn); } };
  (globalThis as unknown as { window: FakeWindow }).window = w;
  return { fire: (key: string | null) => handlers.forEach((h) => h({ key })) };
}
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.resetModules();
});
const fresh = () => import("@/lib/consent");

describe("consent storage behaviour", () => {
  it("writes one first-party key, notifies subscribers, and reads it back", async () => {
    const store: Record<string, string> = {};
    installWindow(store);
    const c = await fresh();
    const seen = vi.fn();
    c.subscribeConsent(seen);
    expect(c.currentAnalyticsConsent()).toBe(false);
    c.writeConsent(true, NOW);
    expect(Object.keys(store)).toEqual(["azerdex-consent"]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(c.currentAnalyticsConsent()).toBe(true);
    c.writeConsent(false, NOW); // withdrawal keeps the refusal on record
    expect(c.currentAnalyticsConsent()).toBe(false);
    expect(c.readConsent()).toMatchObject({ analytics: false, at: "2026-10-30" });
  });

  it("a withdrawal in ANOTHER tab (storage event) is seen immediately and by the live send-time check", async () => {
    const store: Record<string, string> = {};
    const w = installWindow(store);
    const c = await fresh();
    c.writeConsent(true, NOW);
    const seen = vi.fn();
    c.subscribeConsent(seen);
    expect(consentedAnalyticsEvent({ url: "https://azerdex.com/database" })).not.toBeNull();
    store["azerdex-consent"] = JSON.stringify(createConsentRecord(false, NOW)); // the other tab wrote it
    w.fire("azerdex-consent");
    expect(seen).toHaveBeenCalled();
    expect(consentedAnalyticsEvent({ url: "https://azerdex.com/database" })).toBeNull();
    store["azerdex-consent"] = "garbage";
    expect(consentedAnalyticsEvent({ url: "https://azerdex.com/database" })).toBeNull();
    delete store["azerdex-consent"];
    w.fire(null); // storage cleared: a stale in-memory copy must never bring the old choice back
    expect(c.currentAnalyticsConsent()).toBe(false);
    expect(c.readConsentRaw()).toBeNull();
  });

  it("when storage is blocked the choice still holds for the page and nothing throws", async () => {
    installWindow({}, { setThrows: true });
    const c = await fresh();
    expect(() => c.writeConsent(true, NOW)).not.toThrow();
    expect(c.currentAnalyticsConsent()).toBe(true);
    c.writeConsent(false, NOW);
    expect(c.currentAnalyticsConsent()).toBe(false);
  });

  it("unreadable storage and a missing window both mean no consent", async () => {
    installWindow({ "azerdex-consent": JSON.stringify(createConsentRecord(true, NOW)) }, { getThrows: true });
    expect((await fresh()).currentAnalyticsConsent()).toBe(false);
    delete (globalThis as { window?: unknown }).window;
    vi.resetModules();
    expect((await fresh()).currentAnalyticsConsent()).toBe(false);
  });
});

describe("the send-time gate", () => {
  const ev = (url: string) => ({ type: "pageview" as const, url });
  it("cancels every event without consent and applies the public-host / redaction rules with it", () => {
    expect(consentedAnalyticsEvent(ev("https://azerdex.com/database"), () => false)).toBeNull();
    expect(consentedAnalyticsEvent(ev("https://azerdex.com/database?q=x#y"), () => true)).toEqual(ev("https://azerdex.com/database"));
    expect(consentedAnalyticsEvent(ev("https://azerdex.com/account/login"), () => true)).toBeNull();
    expect(consentedAnalyticsEvent(ev("https://abc.vercel.app/"), () => true)).toBeNull();
  });
});

describe("nothing optional exists before a choice", () => {
  it("the server render (what every first visit receives) contains no banner, no analytics and no Vercel reference", () => {
    const html = renderToStaticMarkup(createElement(ConsentManager, { analyticsAvailable: true, speedInsightsAvailable: true }));
    expect(html).not.toMatch(/vercel|insights|script|Accept analytics|data-consent/i);
  });

  it("only the two Traffic* wrappers import the Vercel packages, and only ConsentManager renders them (lazily)", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
      });
    const rel = (p: string) => p.slice(root.length + 1).replaceAll("\\", "/");
    const src = walk(join(root, "src"));
    const importers = src.filter((p) => /@vercel\/(analytics|speed-insights)/.test(readFileSync(p, "utf8"))).map(rel).sort();
    expect(importers).toEqual(["src/components/TrafficAnalytics.tsx", "src/components/TrafficSpeedInsights.tsx"]);
    const users = src.filter((p) => /components\/Traffic(Analytics|SpeedInsights)/.test(readFileSync(p, "utf8"))).map(rel).sort();
    expect(users).toEqual(["src/components/consent/ConsentManager.tsx"]);
    const manager = read("src/components/consent/ConsentManager.tsx");
    expect(manager).toMatch(/dynamic\(\(\) => import\("@\/components\/TrafficAnalytics"\)[\s\S]*?ssr: false/);
    expect(manager).not.toMatch(/^import .*Traffic/m);
  });

  it("the banner offers Accept, Reject and Settings with identical weight, preselects nothing and is not a wall", () => {
    const m = read("src/components/consent/ConsentManager.tsx");
    const accept = m.match(/className=\{`([^`]*)`\} onClick=\{\(\) => onChoose\(true\)\}/)?.[1];
    const reject = m.match(/className=\{`([^`]*)`\} onClick=\{\(\) => onChoose\(false\)\}/)?.[1];
    expect(accept).toBeTruthy();
    expect(accept).toBe(reject);
    expect(m).toContain("Accept analytics");
    expect(m).toContain("Reject optional");
    expect(m).toContain(">Settings<");
    expect(m).toContain("useState(record?.analytics === true)"); // unchecked unless the visitor's own stored choice says otherwise
    expect(m).not.toMatch(/defaultChecked|checked=\{true\}|aria-modal="true"|inert|overflow-hidden|backdrop/);
  });

  it("the footer carries the permanent way to change or withdraw the choice, without touching the approved legal wording", () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));
    expect(html).toContain("data-consent-open");
    expect(html).toContain(">Cookie settings<");
    expect(html).toContain('href="/about/privacy"');
  });
});

describe("essential mechanisms never depend on the optional choice", () => {
  it("proxy, session, csrf and challenge code never reads or references consent", () => {
    for (const f of ["src/proxy.ts", "src/lib/account/session.ts", "src/lib/account/csrf.ts", "src/app/api/v1/challenge/route.ts", "src/lib/security/rate-limit.ts", "src/lib/auth-confirm/forward.ts"]) {
      expect(read(f), f).not.toMatch(/azerdex-consent|lib\/consent|hasAnalyticsConsent|currentAnalyticsConsent/);
    }
  });
});
