import type { NextRequest } from "next/server";
import { safeNext } from "@/lib/account/contracts";
import { failure, redirectResponse } from "@/lib/account/http";
import { accountRuntime } from "@/lib/account/runtime";
import { clearSession, jarFrom, resolveSession, writeSession } from "@/lib/account/session";

export const dynamic = "force-dynamic";

/**
 * Server components cannot set cookies, so a page whose access token has expired sends the browser through here: this
 * handler refreshes (persisting the ROTATED refresh token), or ends a dead session (clearing it), and returns to an
 * allowlisted page. It changes nothing a hostile site could exploit: a cross-site navigation is refused up front, a live
 * session is only rotated, and the redirect target comes from the closed allowlist, never from a free URL.
 */
export async function GET(req: NextRequest) {
  const rt = accountRuntime();
  if (rt.state === "disabled") return failure(404, "not_found");
  if (rt.state === "unavailable") return failure(503, "account_unavailable", {}, { "Retry-After": "300" });
  const ac = rt.ctx;
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const to = (path: string, params: Record<string, string> = {}) => {
    const u = new URL(path, ac.siteOrigin);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u;
  };
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return redirectResponse(to("/account")); // cross-site and same-site (sibling) navigations are not processed

  const jar = jarFrom(() => req.cookies.getAll());
  const r = await resolveSession(ac.cfg, jar, ac.https, { kind: "user", canWrite: true });
  if (r.state === "authenticated") {
    const res = redirectResponse(to(next));
    if (r.rotated) await writeSession(ac.cfg.csrfSecret, res.headers, jar, ac.https, r.rotated);
    return res;
  }
  if (r.state === "unavailable") return redirectResponse(to("/account/login", { reason: "unavailable" }));
  const res = redirectResponse(to("/account/login", r.state === "ended" ? { reason: "expired", next } : { next }));
  if (r.state === "ended") clearSession(res.headers, ac.https);
  return res;
}
