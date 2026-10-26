import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { forwardConfirm, isSameOriginForm, parseEndpoint, parseForm } from "@/lib/auth-confirm/forward";

const EP = "https://abcdefghijklmnopqrst.supabase.co/functions/v1/azerdex-auth-confirm";
const HASH = "7c3b8b833f6cd885a5be77172c083575dd95da9ecabc08c07c56c270";
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const res = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("public auth confirmation (independent of the Account flags)", () => {
  it("accepts only an exact https Supabase confirm-function URL", () => {
    expect(parseEndpoint(EP)).toBe(EP);
    for (const bad of [undefined, "", "http://abcdefghijklmnopqrst.supabase.co/functions/v1/azerdex-auth-confirm", "https://evil.example/functions/v1/azerdex-auth-confirm",
      "https://abcdefghijklmnopqrst.supabase.co/functions/v1/other", `${EP}?x=1`, "https://user:pw@abcdefghijklmnopqrst.supabase.co/functions/v1/azerdex-auth-confirm",
      "https://abcdefghijklmnopqrst.supabase.co:8443/functions/v1/azerdex-auth-confirm", "https://abc.supabase.co.evil.example/functions/v1/azerdex-auth-confirm"]) {
      expect(parseEndpoint(bad), String(bad)).toBeNull();
    }
  });

  it("parses the three supported types; recovery needs two identical passwords; other types and junk are refused", () => {
    expect(parseForm(form({ type: "signup", token_hash: HASH }))).toEqual({ req: { type: "signup", tokenHash: HASH } });
    expect(parseForm(form({ type: "email_change", token_hash: HASH }))).toEqual({ req: { type: "email_change", tokenHash: HASH } });
    expect(parseForm(form({ type: "recovery", token_hash: HASH, password: "correct horse", password_confirm: "correct horse" }))).toEqual({ req: { type: "recovery", tokenHash: HASH, password: "correct horse" } });
    expect(parseForm(form({ type: "recovery", token_hash: HASH, password: "correct horse", password_confirm: "other" }))).toEqual({ error: { ok: false, error: "password_mismatch" } });
    for (const bad of [{ type: "magiclink", token_hash: HASH }, { type: "signup", token_hash: "short" }, { type: "signup", token_hash: `${HASH}!` }, { type: "signup" }, { token_hash: HASH }, { type: "recovery", token_hash: HASH }]) {
      expect("error" in parseForm(form(bad as Record<string, string>)), JSON.stringify(bad)).toBe(true);
    }
  });

  it("forwards exactly {type, token_hash[, password]} and maps the function's answer without trusting its shape", async () => {
    let sent: { url: string; body: unknown } | null = null;
    const ok = await forwardConfirm(EP, { type: "signup", tokenHash: HASH }, (url, init) => { sent = { url, body: JSON.parse(String(init.body)) }; return res(200, { ok: true, kind: "confirmed" }); });
    expect(ok).toEqual({ ok: true, kind: "confirmed" });
    expect(sent).toEqual({ url: EP, body: { type: "signup", token_hash: HASH } });
    expect(await forwardConfirm(EP, { type: "recovery", tokenHash: HASH, password: "pw-long-enough" }, (_u, init) => { expect(JSON.parse(String(init.body))).toEqual({ type: "recovery", token_hash: HASH, password: "pw-long-enough" }); return res(200, { ok: true, kind: "password_reset" }); })).toEqual({ ok: true, kind: "password_reset" });
    expect(await forwardConfirm(EP, { type: "signup", tokenHash: HASH }, () => res(400, { ok: false, error: "invalid_or_expired" }))).toEqual({ ok: false, error: "invalid_or_expired" });
    expect(await forwardConfirm(EP, { type: "signup", tokenHash: HASH }, () => res(400, { ok: false, error: "<script>" }))).toEqual({ ok: false, error: "temporarily_unavailable" });
    expect(await forwardConfirm(EP, { type: "signup", tokenHash: HASH }, () => res(200, { ok: true, kind: "evil" }))).toEqual({ ok: false, error: "temporarily_unavailable" });
    expect(await forwardConfirm(EP, { type: "signup", tokenHash: HASH }, () => Promise.reject(new Error("net")))).toEqual({ ok: false, error: "temporarily_unavailable" });
  });

  it("same-origin check: Origin must match Host; without Origin only same-origin/none fetch metadata passes", () => {
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
    expect(isSameOriginForm(h({ origin: "https://beta.azerdex.com", host: "beta.azerdex.com" }))).toBe(true);
    expect(isSameOriginForm(h({ origin: "https://evil.example", host: "beta.azerdex.com" }))).toBe(false);
    // no-referrer pages send Origin: null on their own same-origin POST: Fetch-Metadata decides
    expect(isSameOriginForm(h({ origin: "null", "sec-fetch-site": "same-origin", host: "beta.azerdex.com" }))).toBe(true);
    expect(isSameOriginForm(h({ origin: "null", "sec-fetch-site": "cross-site", host: "beta.azerdex.com" }))).toBe(false);
    expect(isSameOriginForm(h({ origin: "null", host: "beta.azerdex.com" }))).toBe(false);
    expect(isSameOriginForm(h({ "sec-fetch-site": "same-origin", host: "x" }))).toBe(true);
    expect(isSameOriginForm(h({ "sec-fetch-site": "cross-site", host: "x" }))).toBe(false);
    expect(isSameOriginForm(h({ host: "x" }))).toBe(false);
  });

  it("lives outside the Account zone, imports no account code and names no Auth project, key or Auth path", () => {
    const root = resolve(__dirname, "../../src");
    const files = [join(root, "lib/auth-confirm/forward.ts"), join(root, "app/auth/confirm/page.tsx"), join(root, "app/auth/confirm/submit/route.ts"), join(root, "app/auth/confirm/done/page.tsx")];
    for (const f of files) {
      expect(existsSync(f), f).toBe(true);
      const t = readFileSync(f, "utf8");
      expect(t, f).not.toMatch(/lib\/account|app\/account|accountRuntime|ACCOUNT_AUTH|klxhikdlfwgxurdyexdi|sb_publishable_|\/auth\/v1|SUPABASE_/);
    }
    expect(readdirSync(join(root, "app/auth")).every((n) => statSync(join(root, "app/auth", n)).isDirectory())).toBe(true);
  });
});
