import type { NextRequest } from "next/server";
import { CSRF_TTL_SEC, csrfBinding, currentOrNewCsrf } from "@/lib/account/csrf";
import { failure, jsonResponse } from "@/lib/account/http";
import { accountRuntime } from "@/lib/account/runtime";
import { jarFrom, readSession, setCookie } from "@/lib/account/session";

export const dynamic = "force-dynamic";

/** Hands the same-origin page a CSRF token and sets its HttpOnly SameSite=Strict twin cookie (see lib/account/csrf.ts). */
export async function GET(req: NextRequest) {
  const rt = accountRuntime();
  if (rt.state === "disabled") return failure(404, "not_found");
  if (rt.state === "unavailable") return failure(503, "account_unavailable", {}, { "Retry-After": "300" });
  const { ac } = { ac: rt.ctx };
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return failure(403, "forbidden");
  const jar = jarFrom(() => req.cookies.getAll());
  const { session } = await readSession(ac.cfg.csrfSecret, jar, ac.https);
  const token = await currentOrNewCsrf(ac.cfg.csrfSecret, jar.get(ac.cookies.csrf), csrfBinding(session));
  const res = jsonResponse({ ok: true, token });
  setCookie(res.headers, ac.cookies.csrf, token, { httpOnly: true, secure: ac.https, sameSite: "Strict", path: "/account", maxAge: CSRF_TTL_SEC });
  return res;
}
