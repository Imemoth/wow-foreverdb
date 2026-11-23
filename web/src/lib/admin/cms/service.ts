import "server-only";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { jarFrom, type CookieJar } from "@/lib/account/session";
import type { AccountContext } from "@/lib/account/runtime";
import { adminRuntime } from "../runtime";
import { resolveAdminSessionToken } from "../session";
import { cmsRpc, type CmsFailure, type CmsResult } from "./rpc";
import type { ArticleDetail, AuditEvent, CmsContext, ListItem } from "./schemas";

/** The verified staff session of one server request (page render or action). `at` never leaves the server. */
export interface AdminCtx { ac: AccountContext; uid: string; sid: string; at: string }
export type CtxResult = { ok: true; ctx: AdminCtx } | { ok: false; reason: "disabled" | "unavailable" | "denied" };

async function fromJar(jar: CookieJar): Promise<CtxResult> {
  const rt = adminRuntime();
  if (rt.state !== "ready") return { ok: false, reason: rt.state };
  const r = await resolveAdminSessionToken(rt.ac, jar);
  return r.ok ? { ok: true, ctx: { ac: rt.ac, uid: r.uid, sid: r.sid, at: r.at } } : { ok: false, reason: "denied" };
}
/** For server components: the Admin cookie is read from the request that is being rendered. */
export async function adminCtxForPage(): Promise<CtxResult> {
  const store = await cookies();
  return fromJar(jarFrom(() => store.getAll()));
}
export async function adminCtxForRequest(req: NextRequest): Promise<CtxResult> {
  return fromJar(jarFrom(() => req.cookies.getAll()));
}

export const loadContext = (c: AdminCtx): Promise<CmsResult<CmsContext>> => cmsRpc.context(c.ac.cfg, c.at);
export const loadArticles = (c: AdminCtx): Promise<CmsResult<ListItem[]>> => cmsRpc.articles(c.ac.cfg, c.at, 100);
export const loadArticle = (c: AdminCtx, id: string): Promise<CmsResult<ArticleDetail>> => cmsRpc.detail(c.ac.cfg, c.at, id);
export const loadAudit = (c: AdminCtx, limit = 100, before: number | null = null): Promise<CmsResult<AuditEvent[]>> => cmsRpc.audit(c.ac.cfg, c.at, limit, before);

export type { CmsFailure };
