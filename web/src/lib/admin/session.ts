import "server-only";
import { z } from "@/lib/zod";
import { auth } from "@/lib/account/auth-client";
import { seal, unseal, unverifiedJwtPayload } from "@/lib/account/crypto";
import { callAdminRpc } from "@/lib/account/rpc-client";
import { acceptableUser, setCookie, type CookieJar, type CookieSink, type StoredSession } from "@/lib/account/session";
import type { AccountContext } from "@/lib/account/runtime";

export const ADMIN_MAX_AGE_SEC = 30 * 60;
export const adminCookie = "__Secure-fdb_admin";
export const adminCsrfCookie = "__Secure-fdb_admin_csrf";
const aad = `fdb-admin-session-v1|${adminCookie}`;
const valueSchema = z.object({ v: z.literal(1), uid: z.string().uuid(), sid: z.string().uuid(), at: z.string().min(20).max(8192), issued: z.number().int(), exp: z.number().int() }).strict();
type AdminValue = z.infer<typeof valueSchema>;

export async function writeAdminSession(ac: AccountContext, sink: CookieSink, session: StoredSession, now = Math.floor(Date.now()/1000)): Promise<boolean> {
  const claims = unverifiedJwtPayload(session.at);
  if (claims?.aal !== "aal2" || claims.sub !== session.uid || claims.session_id !== session.sid
      || typeof claims.exp !== "number" || claims.exp <= now) return false;
  const exp = Math.min(claims.exp, now + ADMIN_MAX_AGE_SEC);
  const value = await seal(ac.cfg.csrfSecret, JSON.stringify({ v: 1, uid: session.uid, sid: session.sid, at: session.at, issued: now, exp }), aad);
  setCookie(sink, adminCookie, value, { httpOnly: true, secure: true, sameSite: "Lax", path: "/admin", maxAge: exp - now });
  return true;
}

export function clearAdminSession(sink: CookieSink) {
  for (const path of ["/admin","/"]) {
    setCookie(sink, adminCookie, "", { httpOnly: true, secure: true, sameSite: "Lax", path, maxAge: 0 });
    setCookie(sink, adminCsrfCookie, "", { httpOnly: true, secure: true, sameSite: "Strict", path, maxAge: 0 });
  }
}

export async function readAdminSession(ac: AccountContext, jar: CookieJar, now = Math.floor(Date.now()/1000)): Promise<AdminValue | null> {
  const raw = jar.get(adminCookie);
  if (!raw || raw.length > 12000) return null;
  const plain = await unseal(ac.cfg.csrfSecret, raw, aad);
  if (!plain) return null;
  try {
    const parsed = valueSchema.safeParse(JSON.parse(plain));
    return parsed.success && parsed.data.issued <= now && parsed.data.exp > now && parsed.data.exp <= parsed.data.issued + ADMIN_MAX_AGE_SEC
      ? parsed.data : null;
  } catch { return null; }
}

/** Every Admin read gets live GoTrue identity and the private entry/freshness decision. */
export async function resolveAdminSession(ac: AccountContext, jar: CookieJar): Promise<{ ok: true; uid: string; sid: string } | { ok: false }> {
  const s = await readAdminSession(ac,jar);
  if (!s) return { ok: false };
  const claims = unverifiedJwtPayload(s.at);
  if (claims?.sub !== s.uid || claims.session_id !== s.sid || claims.aal !== "aal2"
      || typeof claims.exp !== "number" || claims.exp < s.exp) return { ok: false };
  const user = await auth.getUser(ac.cfg,s.at);
  if (!user.ok || !acceptableUser(user.data, { uid:s.uid } as StoredSession)) return { ok: false };
  const status = await callAdminRpc(ac.cfg,"fdb_admin_entry_ready",s.at);
  return status.ok && status.data ? { ok: true, uid:s.uid, sid:s.sid } : { ok: false };
}
