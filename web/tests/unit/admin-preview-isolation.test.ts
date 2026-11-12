import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createPreviewAdapter } from "@/admin-preview/adapter";
import { PREVIEW_BUNDLE_MARKER } from "@/admin-preview/domain/marker";
import { MFA_DEMO_CODE } from "@/admin-preview/domain/policy";
import { sessionView } from "@/admin-preview/domain/selectors";

const SRC = join(__dirname, "..", "..", "src");
function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) files(p, out); else if (/\.(tsx?|mjs)$/.test(n)) out.push(p); }
  return out;
}
const rel = (p: string): string => relative(SRC, p).split("\\").join("/");
const all = files(SRC);
const previewFiles = all.filter((p) => rel(p).startsWith("admin-preview/"));
const routeFiles = all.filter((p) => rel(p).startsWith("app/admin-preview/"));
const text = (p: string): string => readFileSync(p, "utf8");

describe("preview source isolation (static boundary checks)", () => {
  it("only the reviewed integration points mention the preview outside its own folders", () => {
    const allowed = new Set(["lib/admin-preview-gate.ts", "proxy.ts", "app/layout.tsx"]);
    const offenders = all.filter((p) => !rel(p).startsWith("admin-preview/") && !rel(p).startsWith("app/admin-preview/") && !allowed.has(rel(p)))
      .filter((p) => /admin-preview|AdminPreview|PREVIEW_BUNDLE_MARKER|@\/admin-preview/.test(text(p))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("the marker literal exists only in the preview sources", () => {
    const hits = all.filter((p) => text(p).includes("AZERDEX-ADMIN-UI-PREVIEW-ISOLATED-SYNTHETIC-MARKER")).map(rel);
    expect(hits).toEqual(["admin-preview/domain/marker.ts"]);
    expect(PREVIEW_BUNDLE_MARKER).toContain("MARKER");
  });

  it("preview route files are only recognised in a preview build (*.preview.tsx) and gate themselves", () => {
    expect(routeFiles.map(rel).sort()).toEqual(["app/admin-preview/[[...path]]/page.preview.tsx", "app/admin-preview/layout.preview.tsx"]);
    for (const p of routeFiles) expect(text(p), rel(p)).toMatch(/evaluatePreviewGate\(\)\.allowed\) notFound\(\)/);
  });

  it("the preview has no network, environment, storage-of-secrets or production-layer access", () => {
    const FORBIDDEN: [RegExp, string][] = [
      [/\bfetch\s*\(/, "fetch"], [/XMLHttpRequest/, "XMLHttpRequest"], [/WebSocket/, "WebSocket"], [/sendBeacon/, "sendBeacon"], [/EventSource/, "EventSource"],
      [/process\.env/, "process.env"], [/\bimport\s*\(/, "dynamic import"], [/dangerouslySetInnerHTML/, "raw HTML"], [/document\.cookie/, "cookies"], [/localStorage/, "localStorage"],
      [/from\s+["']server-only["']/, "server-only"], [/from\s+["'](pg|@supabase[^"']*)["']/, "database client"], [/\beval\s*\(/, "eval"],
    ];
    for (const p of previewFiles) {
      const src = text(p);
      for (const [re, what] of FORBIDDEN) expect(re.test(src), `${rel(p)} must not use ${what}`).toBe(false);
      for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (spec.startsWith("@/")) expect(spec, `${rel(p)} imports a production module`).toBe("@/components/Logo");
        else if (!spec.startsWith(".")) expect(["react", "next/link", "next/navigation", "react-markdown", "remark-gfm"], `${rel(p)} imports ${spec}`).toContain(spec);
      }
    }
  });

  it("the UI talks to data only through the adapter port: no engine, seed or storage value imports in ui/", () => {
    for (const p of previewFiles.filter((f) => rel(f).startsWith("admin-preview/ui/"))) {
      for (const m of text(p).matchAll(/^import\s+(type\s+)?[^;]*from\s+["']([^"']+)["']/gm)) {
        const isType = Boolean(m[1]);
        const spec = m[2]!;
        if (/domain\/(engine|seed)$/.test(spec) || /\/adapter$/.test(spec)) expect(isType, `${rel(p)} imports ${spec} as a value`).toBe(true);
      }
    }
  });

  it("the synthetic adapter is statically distinguishable and never enabled by anything but its own module", () => {
    const a = createPreviewAdapter(null);
    expect(a.kind).toBe("synthetic-preview");
    expect(a.marker).toBe(PREVIEW_BUNDLE_MARKER);
  });
});

describe("synthetic adapter", () => {
  const memory = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };

  it("is not ready until hydrated, starts signed out, and exposes synthetic data only", () => {
    const a = createPreviewAdapter(memory());
    expect(a.isReady()).toBe(false);
    expect(a.hydrate()).toBe(false);
    expect(a.isReady()).toBe(true);
    const s = a.getSnapshot();
    expect(sessionView(s).status).toBe("signed_out");
    expect(s.staff.every((x) => x.handle.endsWith("@synthetic.invalid"))).toBe(true);
  });

  it("persists to and restores from the tab storage, ignores corrupt data, and resets to the seed", () => {
    const store = memory();
    const a = createPreviewAdapter(store);
    a.hydrate();
    a.dispatch({ type: "session/switchPersona", personaId: "st-mira" });
    expect(store.m.size).toBe(1);
    const b = createPreviewAdapter(store);
    expect(b.hydrate()).toBe(true);
    expect(sessionView(b.getSnapshot()).persona?.id).toBe("st-mira");
    expect(Object.isFrozen(b.getSnapshot().revisions[0]!.snapshot)).toBe(true);
    store.setItem("azerdex-admin-preview/v1", "{not json");
    const c = createPreviewAdapter(store);
    expect(c.hydrate()).toBe(false);
    expect(sessionView(c.getSnapshot()).status).toBe("signed_out");
    store.setItem("azerdex-admin-preview/v1", JSON.stringify({ version: 2 }));
    expect(createPreviewAdapter(store).hydrate()).toBe(false);
    a.reset();
    expect(store.m.size).toBe(0);
    expect(sessionView(a.getSnapshot()).status).toBe("signed_out");
  });

  it("works without any storage and notifies subscribers; dryRun changes nothing", () => {
    const a = createPreviewAdapter(null);
    let n = 0;
    const off = a.subscribe(() => n++);
    const before = JSON.stringify(a.getSnapshot());
    const o = a.dryRun({ type: "session/switchPersona", personaId: "st-selene" });
    expect(o.ok).toBe(true);
    expect(JSON.stringify(a.getSnapshot())).toBe(before);
    expect(n).toBe(0);
    a.dispatch({ type: "session/signIn", personaId: "st-selene" });
    expect(n).toBe(1);
    off();
    a.dispatch({ type: "session/submitMfa", code: MFA_DEMO_CODE });
    expect(n).toBe(1);
  });
});
