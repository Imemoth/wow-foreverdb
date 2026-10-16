// Supabase Edge Function entry point (Deno). Invoked only by the database scheduler (pg_cron + pg_net) with a dedicated shared secret.
// Deployment: verify_jwt = false is REQUIRED because the caller is not a Supabase user; authentication is the constant-time secret
// check below (supabase/config.toml documents this; never use it for anything but this function).
import { loadConfig } from "./config.ts";
import { createDb } from "./db.ts";
import { LOGO_PNG_BASE64 } from "./logo-data.ts";
import { runOnce } from "./worker.ts";

const enc = new TextEncoder();

/** Constant-time comparison of two secrets (hash first so lengths never leak). */
export async function secretMatches(given: string, expected: string): Promise<boolean> {
  if (!expected || expected.length < 32 || !given) return false;
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handle(req: Request, env: { get(n: string): string | undefined }, io: Parameters<typeof runOnce>[0]["fetch"], loadLogoBytes: () => Promise<Uint8Array | null>): Promise<Response> {
  const cfg = loadConfig(env);
  // Authenticate BEFORE anything else (including the kill-switch answer), so an unauthenticated caller learns nothing.
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!(await secretMatches(req.headers.get("x-azerdex-worker-secret") ?? "", cfg.workerSecret))) return json(401, { error: "unauthorized" });
  // The request body is ignored on purpose: it can never carry a recipient, template, sender or limit.
  const summary = await runOnce({
    cfg,
    db: createDb(cfg, io),
    fetch: io,
    loadLogoBytes,
    log: (event, fields) => console.log(JSON.stringify({ fn: "azerdex-welcome-worker", event, ...fields })),
  });
  return json(200, summary);
}

declare const Deno: { env: { get(n: string): string | undefined }; serve(h: (r: Request) => Promise<Response> | Response): void };

/** The emblem is part of the import graph (logo-data.ts), so every deploy path bundles it; validateLogo still checks it before every run. */
export function embeddedLogoBytes(): Uint8Array {
  const bin = atob(LOGO_PNG_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve((req) =>
    handle(req, Deno.env, (u, i) => fetch(u, i), async () => embeddedLogoBytes()).catch((e) => {
      console.log(JSON.stringify({ fn: "azerdex-welcome-worker", event: "handler_failed", code: String((e as Error)?.name ?? "error").slice(0, 40) }));
      return json(500, { error: "internal" });
    }),
  );
}
