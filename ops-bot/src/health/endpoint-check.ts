import { parseHealthSnapshot } from "./contract";
import { signRequest } from "./http-provider";

/**
 * Read-only verification of a DEPLOYED health reporting endpoint (the Supabase Edge Function), run by the owner after deploying it and before
 * giving the bot production secrets. Four refusals first (they cost the endpoint nothing), then ONE signed read. Never prints the URL or the secret.
 */
export interface EndpointCheck { name: string; pass: boolean; detail: string }
export interface EndpointCheckOptions { url: string; secret: string; fetchFn?: typeof fetch; now?: () => number }

export async function runEndpointChecks(o: EndpointCheckOptions): Promise<EndpointCheck[]> {
  const fetchFn: typeof fetch = o.fetchFn ?? ((input, init) => fetch(input, init));   // never keep the bare global (see discord/client.ts)
  const now = o.now ?? Date.now;
  const url = new URL(o.url);
  const signedGet = async (secret: string, atMs: number, method = "GET") => {
    const ts = Math.floor(atMs / 1000);
    return fetchFn(url.toString(), { method, redirect: "manual", headers: { accept: "application/json", "x-azerdex-ops-timestamp": String(ts), "x-azerdex-ops-signature": await signRequest(secret, method, url.pathname, ts) } });
  };
  const out: EndpointCheck[] = [];
  const expect = (name: string, status: number, want: number) => out.push({ name, pass: status === want, detail: `HTTP ${status} (expected ${want})` });

  expect("an unsigned request is refused", (await fetchFn(url.toString(), { redirect: "manual" })).status, 401);
  expect("a request signed with a wrong secret is refused", (await signedGet("x".repeat(40), now())).status, 401);
  expect("a request signed ten minutes ago (outside the window) is refused", (await signedGet(o.secret, now() - 600_000)).status, 401);
  expect("a non-GET request is refused", (await fetchFn(url.toString(), { method: "POST", redirect: "manual" })).status, 405);

  const res = await signedGet(o.secret, now());
  expect("the signed request is accepted", res.status, 200);
  if (res.status !== 200) return out;
  out.push({ name: "the response is JSON and not cacheable", pass: /application\/json/.test(res.headers.get("content-type") ?? "") && res.headers.get("cache-control") === "no-store", detail: "content-type and cache-control" });
  const parsed = parseHealthSnapshot(await res.json().catch(() => null));
  out.push({ name: "the body satisfies the bot's strict contract v1", pass: parsed.ok, detail: parsed.ok ? "valid" : `invalid at: ${parsed.paths.join(", ")}` });
  if (parsed.ok) {
    const s = parsed.snapshot;
    const ageMin = Math.round((now() - Date.parse(s.generatedAt)) / 60_000);
    out.push({ name: "the report is fresh (under 10 minutes old)", pass: Math.abs(ageMin) < 10, detail: `generated ${ageMin} min ago` });
    const by = (sev: string) => s.sources.filter((x) => x.severity === sev).length;
    out.push({ name: "summary (informational)", pass: true, detail: `${s.sources.length} sources (${by("ok")} ok, ${by("info")} info, ${by("warning")} warning, ${by("critical")} critical); G6 job present=${s.g6.present} active=${s.g6.active} last run=${s.g6.lastRunStatus ?? "none"}` });
  }
  return out;
}
