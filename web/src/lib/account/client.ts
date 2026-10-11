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

export async function postJson(path: string, body: unknown): Promise<ApiReply> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
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
