import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cmsRpc, classifyDbError } from "@/lib/admin/cms/rpc";
import { articleIdForRequest } from "@/lib/admin/cms/ids";
import { ACTION_INPUT, snapshotInput, detailOutput } from "@/lib/admin/cms/schemas";
import { diffLines, diffSnapshots } from "@/lib/admin/cms/diff";
import { Markdown, safeUrl } from "@/components/admin/Markdown";
import { statusOf } from "@/components/admin/status";
import { toSnapshot, validate } from "@/components/admin/ArticleEditor";
import { describeError } from "@/components/admin/cms-client";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cfg = { authOrigin: "http://127.0.0.1:54321", publishableKey: "sb_publishable_test", mode: "local" } as never;
const TOKEN = "a".repeat(40);
const good = { title: "A valid title", summary: "A summary that is long enough.", body_markdown: "Hello **world**", classification: "normal" as const };

afterEach(() => vi.unstubAllGlobals());
const stub = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const f = vi.fn(async (..._a: [string, RequestInit?]) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }));
  vi.stubGlobal("fetch", f);
  return f;
};

describe("ADM-04 adapter: PostgREST error classification (closed, fail-closed)", () => {
  it.each([
    [403, { code: "42501", message: "independent highlighted approval required" }, { kind: "denied", reason: "independent_approval_required" }],
    [403, { code: "42501", message: "whatever internal text" }, { kind: "denied", reason: "forbidden" }],
    [400, { code: "42501", message: "classification downgrade forbidden" }, { kind: "denied", reason: "classification_downgrade" }],
    [409, { code: "40001", message: "stale" }, { kind: "stale" }],
    [400, { code: "40001", message: "stale" }, { kind: "stale" }],
    [409, { code: "23505", message: "editorial request id reused" }, { kind: "conflict", reason: "request_reused" }],
    [409, { code: "23505", message: "duplicate key value violates unique constraint" }, { kind: "conflict", reason: "slug_taken" }],
    [400, { code: "22023", message: "invalid article snapshot" }, { kind: "invalid", reason: "snapshot" }],
    [400, { code: "22023", message: "image rights not verified" }, { kind: "invalid", reason: "image_rights" }],
    [401, {}, { kind: "unauthenticated" }],
  ])("%s %j → %j", (status, body, want) => {
    expect(classifyDbError(status, body)).toMatchObject(want);
  });
  it("never leaks database message text into the verdict", () => {
    expect(JSON.stringify(classifyDbError(403, { code: "42501", message: "secret detail: table editorial_private.articles" }))).not.toMatch(/secret|editorial_private/);
  });
  it("an unrecognised failure is not classified (the caller then treats a mutation as unknown outcome)", () => {
    expect(classifyDbError(500, { message: "boom" })).toBeNull();
  });
});

describe("ADM-04 adapter: closed RPC client", () => {
  it("sends only the staff token + publishable key to /rest/v1/rpc/<allowlisted fn>, no cookies/credentials, no redirects", async () => {
    const f = stub(200, { user_id: U(1), can_create: true, can_read: true, can_read_audit: false });
    const r = await cmsRpc.context(cfg, TOKEN);
    expect(r).toEqual({ ok: true, data: { user_id: U(1), can_create: true, can_read: true, can_read_audit: false } });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:54321/rest/v1/rpc/fdb_cms_context");
    expect(init).toMatchObject({ method: "POST", redirect: "manual", cache: "no-store", credentials: "omit" });
    expect(init!.headers).toMatchObject({ apikey: "sb_publishable_test", Authorization: `Bearer ${TOKEN}` });
  });
  it("an output with an unexpected column fails closed instead of reaching the browser", async () => {
    stub(200, { user_id: U(1), can_create: true, can_read: true, can_read_audit: false, service_secret: "x" });
    expect(await cmsRpc.context(cfg, TOKEN)).toMatchObject({ ok: false, kind: "unavailable" });
  });
  it("a write whose response is lost is an UNKNOWN outcome (retry only with the same request id); a read is merely unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    expect(await cmsRpc.submit(cfg, TOKEN, { article: U(1), revision: U(2), request: U(3) })).toMatchObject({ ok: false, kind: "unknown_outcome" });
    expect(await cmsRpc.context(cfg, TOKEN)).toMatchObject({ ok: false, kind: "unavailable" });
  });
  it("a recognised database verdict is definite (rolled back), a pre-execution refusal is not 'unknown'", async () => {
    stub(403, { code: "42501", message: "x" });
    expect(await cmsRpc.publish(cfg, TOKEN, { article: U(1), revision: U(2), request: U(3) })).toMatchObject({ ok: false, kind: "denied" });
    stub(404, { message: "no function" });
    expect(await cmsRpc.publish(cfg, TOKEN, { article: U(1), revision: U(2), request: U(3) })).toMatchObject({ ok: false, kind: "unavailable" });
  });
  it("rejects a response above the size bound and a malformed token before any request", async () => {
    stub(200, "x".repeat(2 * 1024 * 1024 + 10));
    expect(await cmsRpc.context(cfg, TOKEN)).toMatchObject({ ok: false });
    const f = stub(200, {});
    await expect(cmsRpc.context(cfg, "short")).rejects.toThrow();
    await expect(cmsRpc.context(cfg, `${TOKEN}\nX-Evil: 1`)).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
  it("the list limit is clamped to 1..100", async () => {
    const f = stub(200, []);
    await cmsRpc.articles(cfg, TOKEN, 9999);
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ p_limit: 100 });
  });
});

describe("ADM-04 adapter: schemas", () => {
  it("accepts a minimal valid snapshot and mirrors the database limits", () => {
    expect(snapshotInput.safeParse(good).success).toBe(true);
    expect(snapshotInput.safeParse({ ...good, title: "ab" }).success).toBe(false);
    expect(snapshotInput.safeParse({ ...good, summary: "short" }).success).toBe(false);
    expect(snapshotInput.safeParse({ ...good, body_markdown: "x".repeat(50_001) }).success).toBe(false);
    expect(snapshotInput.safeParse({ ...good, tags: Array.from({ length: 11 }, (_, i) => `tag${i}x`) }).success).toBe(false);
  });
  it("refuses raw HTML, javascript:/data: URLs, non-https links, unknown keys and featured-but-normal", () => {
    for (const body of ["<script>alert(1)</script>", "<b>x</b>", "[x](javascript:alert(1))", "[x](data:text/html;base64,AA)", "<!-- c -->"]) expect(snapshotInput.safeParse({ ...good, body_markdown: body }).success, body).toBe(false);
    expect(snapshotInput.safeParse({ ...good, related_links: ["http://insecure.example/x"] }).success).toBe(false);
    expect(snapshotInput.safeParse({ ...good, related_links: ["https://ok.example/x"] }).success).toBe(true);
    expect(snapshotInput.safeParse({ ...good, role: "Owner" }).success).toBe(false);
    expect(snapshotInput.safeParse({ ...good, featured: true }).success).toBe(false);
    expect(snapshotInput.safeParse({ ...good, featured: true, classification: "highlighted" }).success).toBe(true);
  });
  it("action inputs are strict: no identity/permission/environment/role fields can be supplied", () => {
    const base = { requestId: U(1), articleId: U(2), revisionId: U(3) };
    expect(ACTION_INPUT.submit.safeParse(base).success).toBe(true);
    for (const extra of [{ actor: U(9) }, { permission: "news.article.publish" }, { env: "production" }, { role: "Owner" }, { sub: U(9) }]) expect(ACTION_INPUT.submit.safeParse({ ...base, ...extra }).success).toBe(false);
    expect(ACTION_INPUT.unpublish.safeParse({ requestId: U(1), articleId: U(2), revisionId: U(3) }).success).toBe(false);
    expect(ACTION_INPUT.review.safeParse({ ...base, decision: "approve", note: "long enough note" }).success).toBe(false);
    expect(ACTION_INPUT.review.safeParse({ ...base, decision: "reject", note: "    x " }).success).toBe(false);
    expect(ACTION_INPUT.review.safeParse({ ...base, decision: "return", note: "Needs a source." }).success).toBe(true);
    expect(ACTION_INPUT.create.safeParse({ requestId: U(1), slug: "Bad Slug", snapshot: good }).success).toBe(false);
  });
  it("detail output is strict", () => {
    expect(detailOutput.safeParse({}).success).toBe(false);
  });
});

describe("ADM-04 adapter: deterministic article id from the request id", () => {
  it("is stable, v4-shaped and request-specific (a retried create targets the same article)", () => {
    expect(articleIdForRequest(U(1))).toBe(articleIdForRequest(U(1)));
    expect(articleIdForRequest(U(1))).not.toBe(articleIdForRequest(U(2)));
    expect(articleIdForRequest(U(1))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("ADM-04 UI: status derived from the real delivery state, never assumed", () => {
  const art = (rs: "draft" | "in_review" | "approved" | "rejected" | "publish_pending" | "unpublish_pending", pub: string | null = null) => ({ review_state: rs, published_revision_id: pub, current_revision_id: U(1) });
  const intent = (kind: "publish" | "unpublish", state: string, extra: Record<string, unknown> = {}) => ({ intent_id: U(5), kind, generation: 1, created_at: "2026-01-01T00:00:00Z", delivery: { state, attempt: 1, compensation: false, error_code: null, applied_at: null, updated_at: null, ...extra } }) as never;
  it("shows Published only after a delivered receipt", () => {
    expect(statusOf(art("publish_pending"), intent("publish", "eligible")).key).toBe("pending");
    expect(statusOf(art("publish_pending"), intent("publish", "claimed")).key).toBe("pending");
    expect(statusOf(art("publish_pending"), intent("publish", "blocked")).key).toBe("pending");
    expect(statusOf(art("publish_pending", U(1)), intent("publish", "delivered")).key).toBe("published");
    expect(statusOf(art("publish_pending"), intent("publish", "retryable", { error_code: "x" })).key).toBe("failed");
    expect(statusOf(art("publish_pending"), intent("publish", "cancelled")).key).toBe("cancelled");
    expect(statusOf(art("publish_pending", U(1)), intent("unpublish", "delivered")).key).toBe("unpublished");
  });
  it("falls back to the review state without an intent", () => {
    for (const s of ["draft", "in_review", "approved", "rejected"] as const) expect(statusOf(art(s), null).key).toBe(s);
  });
  it("a failure message never claims the article is public", () => {
    expect(statusOf(art("publish_pending"), intent("publish", "retryable")).detail).toMatch(/previous public state is unchanged/);
  });
});

describe("ADM-04 UI: safe Markdown + strict URL validation", () => {
  const html = (src: string) => renderToStaticMarkup(createElement(Markdown, { source: src }));
  it("allows only absolute https URLs", () => {
    for (const u of ["javascript:alert(1)", "data:text/html,x", "http://x.example", "//x.example", "/relative", "ftp://x", "https://a b", "https://x\\y"]) expect(safeUrl(u), u).toBe("");
    expect(safeUrl("https://ok.example/path?q=1")).toBe("https://ok.example/path?q=1");
  });
  it("renders no script/iframe/img/form, no raw HTML, and hardens links", () => {
    const out = html('# T\n\n<script>alert(1)</script>\n\n<iframe src="https://x"></iframe>\n\n![x](https://x.example/a.png)\n\n[ok](https://ok.example) [bad](javascript:alert(1)) <img src=x onerror=alert(1)>');
    // Raw HTML is shown as inert escaped TEXT (&lt;…), never parsed into elements; no element or attribute can carry script.
    expect(out).not.toMatch(/<(script|iframe|img|form|input|object|embed|style)\b/i);
    expect(out).not.toMatch(/<[^>]*\s(on[a-z]+|src|srcdoc)=|href="(javascript|data):/i);
    expect(out).toContain('href="https://ok.example"');
    expect(out).toContain('rel="noopener noreferrer nofollow ugc"');
  });
});

describe("ADM-04 UI: editor validation mirrors the database and builds an exact wire snapshot", () => {
  const form = { slug: "my-slug", title: "A valid title", summary: "A summary that is long enough.", body: "text", byline: "", category: "", tags: "", links: "", seo: "", classification: "normal" as const, featured: false };
  it("accepts a valid form and omits empty optionals so database defaults apply", () => {
    expect(validate(form, true)).toEqual({});
    const s = toSnapshot(form, []);
    expect(s).toEqual({ title: "A valid title", summary: "A summary that is long enough.", body_markdown: "text", classification: "normal", featured: false });
    expect(snapshotInput.safeParse(s).success).toBe(true);
  });
  it("featured forces highlighted; tags are normalised; links one per line", () => {
    const s = toSnapshot({ ...form, featured: true, tags: " Alpha, beta-2 ,alpha", links: "https://a.example\n\nhttps://b.example" }, []);
    expect(s).toMatchObject({ classification: "highlighted", featured: true, tags: ["alpha", "beta-2"], related_links: ["https://a.example", "https://b.example"] });
    expect(snapshotInput.safeParse(s).success).toBe(true);
  });
  it("flags bad slug, raw HTML, javascript:, http links, short summary", () => {
    const e = validate({ ...form, slug: "Bad Slug", body: "<b>x</b>", summary: "short", links: "http://x.example" }, true);
    expect(Object.keys(e).sort()).toEqual(["body", "links", "slug", "summary"]);
    expect(validate({ ...form, body: "[x](javascript:1)" }, false).body).toBeTruthy();
  });
});

describe("ADM-04 UI: error wording is closed and never echoes server text", () => {
  it("covers every kind", () => {
    for (const kind of ["unauthenticated", "denied", "invalid", "stale", "conflict", "rate_limited", "unavailable", "unknown_outcome", "csrf", "network"] as const) {
      const d = describeError({ kind, reason: "DROP TABLE" });
      expect(d.title.length).toBeGreaterThan(3);
      expect(d.text).not.toMatch(/DROP TABLE/);
    }
  });
});

describe("ADM-04: the pinned GoTrue's real TOTP enrolment reply (a ~280 KB SVG QR code) is accepted and never forwarded", () => {
  it("parses a large reply; the route drops the image", async () => {
    const { auth } = await import("@/lib/account/auth-client");
    const body = { id: U(7), type: "totp", friendly_name: "AzerDex Admin", totp: { qr_code: `<svg>${"<rect/>".repeat(40_000)}</svg>`, secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" } };
    stub(200, body);
    const r = await auth.enrollTotp(cfg, TOKEN);
    expect(r.ok).toBe(true);
    stub(200, { ...body, totp: { ...body.totp, qr_code: "x".repeat(600 * 1024) } });
    expect((await auth.enrollTotp(cfg, TOKEN)).ok).toBe(false); // still bounded
    expect(readFileSync(join(__dirname, "../../src/app/account/api/admin/mfa/enroll/route.ts"), "utf8")).not.toMatch(/qr_?code/i);
  });
});

describe("ADM-04 diff", () => {
  it("line diff and field diff", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc").filter((l) => l.kind !== "same")).toEqual([{ kind: "del", text: "b" }, { kind: "add", text: "x" }]);
    const snap = { title: "t", summary: "s", body_markdown: "b", byline: "", category: "", tags: [], classification: "normal", featured: false, sample: false, seo_description: "", images: [], related_links: [] } as never;
    expect(diffSnapshots(snap, { ...(snap as object), title: "u" } as never).filter((f) => f.changed).map((f) => f.field)).toEqual(["title"]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------
// Static boundary: what may exist where.
// ------------------------------------------------------------------------------------------------------------------------------
const SRC = join(__dirname, "../../src");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
const files = walk(SRC);
const rel = (f: string) => relative(SRC, f);
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CLIENT = files.filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));

describe("ADM-04 static boundary", () => {
  it("client components never import server-only modules, the RPC client, the session or any secret-bearing module", () => {
    const bad = CLIENT.filter((f) => /from "@\/lib\/(admin\/(cms\/(rpc|service|route|ids)|session|runtime)|account\/(session|crypto|runtime|config|rpc-client|auth-client)|env)"|from "server-only"|next\/headers/.test(code(f)));
    expect(bad.map(rel)).toEqual([]);
  });
  it("the Admin UI and adapter never touch a service-role/secret key, the CMS tables, MAC keys or worker credentials", () => {
    const own = files.filter((f) => /^(app\/admin|components\/admin|lib\/admin\/cms)\//.test(rel(f)));
    expect(own.length).toBeGreaterThan(15);
    for (const f of own) {
      const t = code(f);
      expect(t, rel(f)).not.toMatch(/service[_-]?role|sb_secret_|SERVICE_ROLE|FDB_CMS_MAC|MAC_KEY|worker[_-]?(secret|key|password)|process\.env/i);
      expect(t, rel(f)).not.toMatch(/editorial_private\.|admin_private\.|\/rest\/v1\/(articles|revisions|delivery|publication)/);
      expect(t, rel(f)).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });
  it("only rpc.ts calls fetch with a PostgREST URL; the browser client calls only same-origin /admin/api", () => {
    expect(files.filter((f) => /rest\/v1/.test(code(f)) && /^(app\/admin|components\/admin|lib\/admin)/.test(rel(f))).map(rel)).toEqual(["lib/admin/cms/rpc.ts"]);
    const client = code(join(SRC, "components/admin/cms-client.ts"));
    for (const m of client.matchAll(/fetch\(\s*([`"'][^`"']*)/g)) expect(m[1], m[0]).toMatch(/^[`"']\/admin\/api\//);
  });
  it("the RPC allowlist the adapter can name is exactly the reviewed ADM-03B writes + the 0027 reads", () => {
    const names = [...code(join(SRC, "lib/admin/cms/rpc.ts")).matchAll(/name: "(fdb_[a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual(["fdb_cms_article_detail", "fdb_cms_articles", "fdb_cms_audit", "fdb_cms_context", "fdb_cms_revision"]);
  });
  it("production code never imports the synthetic preview, and the preview never imports the real adapter", () => {
    const real = files.filter((f) => !/^admin-preview\//.test(rel(f)) && !/^(app\/admin-preview|lib\/admin-preview)/.test(rel(f)));
    expect(real.filter((f) => /@\/admin-preview|admin-preview\//.test(code(f)) && !/admin-preview-gate/.test(rel(f)) && rel(f) !== "app/layout.tsx").map(rel)).toEqual([]);
    expect(files.filter((f) => /^admin-preview\//.test(rel(f)) && /@\/(lib\/admin\/cms|components\/admin\/)/.test(code(f))).map(rel)).toEqual([]);
  });
  it("there is no runtime feature flag that can switch Admin on: enablement stays the local-only predicate", () => {
    const rt = code(join(SRC, "lib/admin/runtime.ts"));
    expect(rt).toMatch(/ac\.cfg\.mode === "local" && !ac\.env\.hosted && ac\.env\.FOREVERDB_DEPLOYMENT === "local"/);
    expect(rt).toMatch(/HOSTED_ADMIN_AUTH_APPROVED = false as boolean/);
    for (const f of own()) expect(code(f), rel(f)).not.toMatch(/ADMIN_ENABLED|ENABLE_ADMIN|FEATURE_FLAG|FDB_ADMIN/);
  });
  it("the action route is POST-only and every action goes through handleCmsPost", () => {
    const t = code(join(SRC, "app/admin/api/cms/[action]/route.ts"));
    expect([...t.matchAll(/export (?:async function|const) (\w+)/g)].map((m) => m[1]).sort()).toEqual(["POST", "dynamic"]);
    expect(t).toMatch(/handleCmsPost/);
  });
});
function own(): string[] { return files.filter((f) => /^(app\/admin|components\/admin|lib\/admin\/cms)\//.test(rel(f))); }
