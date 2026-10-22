import { forwardConfirm, isSameOriginForm, parseEndpoint, parseForm } from "@/lib/auth-confirm/forward";

export const dynamic = "force-dynamic";

const to = (path: string) => new Response(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

/** The ONLY place a one-time e-mail token is consumed: an explicit POST from the confirmation page. Always answers with a redirect (no token in the response). */
export async function POST(request: Request) {
  if (!isSameOriginForm(request.headers)) return new Response("forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
  const endpoint = parseEndpoint(process.env.AZERDEX_CONFIRM_ENDPOINT);
  if (!endpoint) return to("/auth/confirm/done?error=temporarily_unavailable");
  const fd = await request.formData().catch(() => null);
  const parsed = fd ? parseForm(fd) : null;
  if (!parsed) return to("/auth/confirm/done?error=invalid_request");
  if ("error" in parsed) {
    // A fixable form mistake (mismatching passwords) returns to the form; the token is still unused.
    const tokenHash = typeof fd?.get("token_hash") === "string" ? String(fd?.get("token_hash")) : "";
    const type = fd?.get("type");
    if (parsed.error.error === "password_mismatch" && type === "recovery" && /^[A-Za-z0-9_-]{8,128}$/.test(tokenHash)) {
      return to(`/auth/confirm?type=recovery&token_hash=${tokenHash}&error=password_mismatch`);
    }
    return to(`/auth/confirm/done?error=${parsed.error.error}`);
  }
  const r = await forwardConfirm(endpoint, parsed.req, (u, i) => fetch(u, i));
  if (r.ok) return to(`/auth/confirm/done?kind=${r.kind}`);
  if ((r.error === "weak_password" || r.error === "same_password" || r.error === "invalid_password") && parsed.req.type === "recovery") {
    return to(`/auth/confirm?type=recovery&token_hash=${parsed.req.tokenHash}&error=${r.error}`);
  }
  return to(`/auth/confirm/done?error=${r.error}`);
}
