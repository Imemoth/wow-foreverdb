/**
 * Browser-side helper for the account forms (imported only by client components; it holds no secret and no Auth
 * token: the session lives in an HttpOnly cookie the page cannot read). It fetches the CSRF token the server mints for
 * this browser and sends it as a header on every POST; one automatic retry covers a token that expired in an open tab.
 */
let cached: string | null = null;

async function csrfToken(force = false): Promise<string | null> {
  if (cached && !force) return cached;
  try {
    const r = await fetch("/account/api/csrf", { credentials: "same-origin", cache: "no-store" });
    const j = (await r.json()) as { token?: unknown };
    cached = r.ok && typeof j.token === "string" ? j.token : null;
  } catch {
    cached = null;
  }
  return cached;
}

export interface ApiReply {
  status: number;
  data: { ok?: boolean; error?: string; redirect?: string; [k: string]: unknown };
}

export async function postJson(path: string, body: unknown, opts: { retryCsrf?: boolean } = {}): Promise<ApiReply> {
  for (let attempt = 0; attempt < (opts.retryCsrf === false ? 1 : 2); attempt += 1) {
    const token = await csrfToken(attempt > 0);
    if (!token) return { status: 0, data: { ok: false, error: "network" } };
    try {
      const res = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "x-fdb-csrf": token },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as ApiReply["data"];
      if (res.status === 403 && data.error === "csrf" && attempt === 0) continue;
      return { status: res.status, data };
    } catch {
      return { status: 0, data: { ok: false, error: "network" } };
    }
  }
  return { status: 0, data: { ok: false, error: "csrf" } };
}

/** Pairing decisions have an additional rendered-page/session binding and are deliberately never retried. */
export async function postPairingDecision(action: "approve" | "deny", pairingId: string, pageBinding: string): Promise<ApiReply> {
  const token = await csrfToken(false);
  if (!token) return { status: 0, data: { ok: false, error: "network" } };
  const path = action === "approve" ? "/account/api/device-pair/approve" : "/account/api/device-pair/deny";
  try {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "x-fdb-csrf": token, "x-fdb-pairing-page": pageBinding },
      body: JSON.stringify({ pairingId }),
    });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as ApiReply["data"] };
  } catch {
    return { status: 0, data: { ok: false, error: "network" } };
  }
}
