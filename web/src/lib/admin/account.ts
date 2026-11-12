import "server-only";
import { NextResponse } from "next/server";
import type { RouteContext } from "@/lib/account/handler";
import { failure } from "@/lib/account/http";
import { chargeAccount, type AccountAction } from "@/lib/account/limits";
import { resolveSession, writeSession, type StoredSession } from "@/lib/account/session";
import { adminEnabled } from "./runtime";

/** Admin is compiled off on hosted deployments; local Account auth remains a separate cookie. */
export async function withAdminAccount(
  c: RouteContext,
  action: AccountAction,
  fn: (session: StoredSession) => Promise<NextResponse>,
  persistResolved = true,
): Promise<NextResponse> {
  if (!adminEnabled(c.ac)) return failure(404,"not_found");
  const resolved = await resolveSession(c.ac.cfg,c.jar,c.ac.https,{kind:"user",canWrite:true});
  if (resolved.state === "unavailable") return failure(503,"temporarily_unavailable");
  if (resolved.state !== "authenticated") return failure(401,"unauthenticated");
  let budget;
  try { budget = await chargeAccount(c.ac.env,c.ac.cfg.csrfSecret,action,resolved.user.id); }
  catch { return failure(503,"temporarily_unavailable"); }
  if (budget.budget === "exhausted") return failure(429,"too_many_attempts",{}, {"Retry-After":String(budget.retryAfterSec)});
  const response = await fn(resolved.session);
  if (persistResolved && resolved.rotated) await writeSession(c.ac.cfg.csrfSecret,response.headers,c.jar,c.ac.https,resolved.rotated);
  return response;
}
