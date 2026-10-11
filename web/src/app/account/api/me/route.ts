import type { NextRequest } from "next/server";
import { failure, jsonResponse } from "@/lib/account/http";
import { accountRuntime } from "@/lib/account/runtime";
import { clearSession, jarFrom, resolveSession, writeSession } from "@/lib/account/session";

export const dynamic = "force-dynamic";

/** Minimal profile for the signed-in user. Identity is the server-confirmed user (Auth validates the session), never the cookie. */
export async function GET(req: NextRequest) {
  const rt = accountRuntime();
  if (rt.state === "disabled") return failure(404, "not_found");
  if (rt.state === "unavailable") return failure(503, "account_unavailable", {}, { "Retry-After": "300" });
  const ac = rt.ctx;
  const jar = jarFrom(() => req.cookies.getAll());
  const r = await resolveSession(ac.cfg, jar, ac.https, { kind: "user", canWrite: true });
  if (r.state === "unavailable") return failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" });
  if (r.state !== "authenticated") {
    const res = failure(401, "unauthenticated");
    if (r.state === "ended") clearSession(res.headers, ac.https);
    return res;
  }
  const res = jsonResponse({ ok: true, user: { email: r.user.email, createdAt: r.user.createdAt, emailVerified: true } });
  if (r.rotated) await writeSession(ac.cfg.csrfSecret, res.headers, jar, ac.https, r.rotated);
  return res;
}
