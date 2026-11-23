"use client";
/**
 * Browser side of the Admin CMS adapter. It talks ONLY to this website's /admin/api/cms/* (same origin, CSRF-protected). The browser never
 * holds a database URL, a token or a key: the Admin session cookie is HttpOnly and the CSRF token is the only thing readable here.
 */
export type ApiError = { kind: "unauthenticated" | "denied" | "invalid" | "stale" | "conflict" | "rate_limited" | "unavailable" | "unknown_outcome" | "csrf" | "network"; reason?: string; unknownOutcome?: boolean; issues?: { path: string; code: string }[] };
export type ApiResult<T> = ({ ok: true } & T) | { ok: false; error: ApiError; status: number };

let csrf: string | null = null;
async function csrfToken(force = false): Promise<string | null> {
  if (csrf && !force) return csrf;
  try {
    const r = await fetch("/admin/api/csrf", { credentials: "same-origin", cache: "no-store" });
    const b = (await r.json()) as { token?: string };
    csrf = r.ok && b.token ? b.token : null;
  } catch { csrf = null; }
  return csrf;
}

export async function cmsPost<T = Record<string, unknown>>(action: string, body: Record<string, unknown>): Promise<ApiResult<T>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await csrfToken(attempt > 0);
    if (!token) return { ok: false, status: 401, error: { kind: "unauthenticated" } };
    let res: Response;
    try {
      res = await fetch(`/admin/api/cms/${action}`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", "x-fdb-csrf": token }, body: JSON.stringify(body),
      });
    } catch { return { ok: false, status: 0, error: { kind: "network" } }; }
    let json: { ok?: boolean; error?: unknown } & Record<string, unknown> = {};
    try { json = (await res.json()) as typeof json; } catch { /* non-JSON error page */ }
    if (res.ok && json.ok) return json as ApiResult<T>;
    if (res.status === 403 && json.error === "csrf" && attempt === 0) continue; // a stale CSRF token: fetch a fresh one once
    if (res.status === 401) { csrf = null; return { ok: false, status: 401, error: { kind: "unauthenticated" } }; }
    if (json.error === "csrf") return { ok: false, status: 403, error: { kind: "csrf" } };
    const e = json.error && typeof json.error === "object" ? (json.error as ApiError) : null;
    return { ok: false, status: res.status, error: e ?? { kind: res.status >= 500 ? "unavailable" : "denied" } };
  }
  return { ok: false, status: 0, error: { kind: "network" } };
}

/** Plain-language, closed messages. Database text never reaches this layer. */
export function describeError(e: ApiError): { tone: "error" | "warning"; title: string; text: string } {
  switch (e.kind) {
    case "unauthenticated": return { tone: "warning", title: "Admin session ended", text: "Your Admin session is no longer valid. Verify TOTP again from your account to continue." };
    case "csrf": return { tone: "error", title: "Request refused", text: "The security token for this request was rejected. Reload the page and try again." };
    case "stale": return { tone: "warning", title: "Out of date", text: "This article changed since you opened it. Reload to see the current revision; nothing was overwritten." };
    case "rate_limited": return { tone: "warning", title: "Too many requests", text: "Slow down for a moment and try again." };
    case "unavailable": case "network": return { tone: "warning", title: "Backend unavailable", text: "The CMS backend could not be reached. Nothing was changed; you can try again." };
    case "unknown_outcome": return { tone: "warning", title: "Outcome unknown", text: "The request may or may not have been applied. Retrying is safe: it reuses the same request id and cannot apply twice." };
    case "conflict": return e.reason === "slug_taken"
      ? { tone: "error", title: "Slug already used", text: "That slug is reserved by another article. Slugs are permanent; choose a different one." }
      : { tone: "error", title: "Request already used", text: "That request id was already committed for a different action." };
    case "invalid": return { tone: "warning", title: "Check the form", text: ({
      snapshot: "The article content was refused by the backend validation (length, tags, links or raw HTML).",
      image_rights: "An image reference is not rights-verified, so it cannot be used.",
      slug: "The slug is not valid.", request: "The request was malformed.", decision: "The review decision is not valid.", input: "Some fields are not valid.",
    } as Record<string, string>)[e.reason ?? "input"] ?? "Some fields are not valid." };
    case "denied": return { tone: "error", title: "Denied", text: ({
      independent_approval_required: "Independent approval required: an author or editor of this article cannot approve it, and highlighted content cannot be published without another eligible person's approval of this exact revision.",
      approver_ineligible: "The approver is no longer eligible (role, grant, suspension or expiry changed). A new independent approval is needed.",
      classification_downgrade: "Classification cannot be lowered: this article was highlighted before and V1 never allows a downgrade.",
      not_publishable: "This revision cannot be published in its current state (it must be the approved head revision).",
      nothing_to_unpublish: "Nothing is published for this article.",
      forbidden: "You are not permitted to do this, or your TOTP verification is older than 15 minutes. Verify again from your account if needed.",
    } as Record<string, string>)[e.reason ?? "forbidden"] ?? "You are not permitted to do this." };
  }
}
