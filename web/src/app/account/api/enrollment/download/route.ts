import { NextResponse } from "next/server";
import { ACTIVATION_FILE_NAME, buildActivationFile } from "@/lib/account/contracts-enrollment";
import { accountApi } from "@/lib/account/handler";
import { ACCOUNT_RESPONSE_HEADERS, accountLog, failure } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";
import { authenticate, guarded, mutationFailure, withSession } from "@/lib/account/private";
import { callWebRpc } from "@/lib/account/rpc-client";

export const dynamic = "force-dynamic";

/**
 * "Download an activation file for a new computer": issues ONE enrollment ticket for the signed-in account and answers with the
 * activation file (docs/account-v1/zero-touch-rpc-contract.md) as an attachment. POST only, by a native HTML form (the file never
 * passes through page JavaScript): Origin / Fetch Metadata / form content type / a session-bound signed token in the body
 * (handler.ts, `form`). There is deliberately NO GET export: a ticket can never be created or fetched by a link, an image, a prefetch
 * or a crawler.
 *
 * The ticket exists in exactly three places: the database reply, the local `ticket` constant below, and this ONE response body.
 * It is never logged (accountLog takes closed scalar fields), never put in a URL, header, cookie or JSON of any other route, and the
 * response is `private, no-store`. Failures keep their meaning: `ticket_limit` is 409, authentication 401/403, budgets 429 with
 * Retry-After, and a lost reply is an UNKNOWN outcome (502): a ticket may exist whose secret is lost; the user simply downloads another.
 */
export const POST = accountApi({ route: "enrollment_download", mutating: true, form: { body: INPUTS.enrollmentDownload, back: "/account/devices" } }, async (c) => {
  const a = await authenticate(c);
  if (!a.ok) return a.response;
  return guarded(c, a.auth, async () => {
    const out = await callWebRpc(c.ac.cfg, "fdb_account_enrollment_ticket_issue", {}, a.auth.session.at);
    if (!out.ok) {
      accountLog("ticket_issue_failed", { route: "enrollment_download", kind: out.kind });
      return withSession(c, a.auth, mutationFailure(out, "/account/devices"));
    }
    if (!out.data.ok) return withSession(c, a.auth, failure(409, "ticket_limit"));

    const expires = new Date(out.data.expires_at);
    if (Number.isNaN(expires.getTime())) return withSession(c, a.auth, failure(502, "outcome_unknown", { reconcile: "/account/devices" }));
    const file = buildActivationFile(out.data.ticket, expires.toISOString(), new Date().toISOString());
    accountLog("ticket_issued", { route: "enrollment_download", status: 200 });
    return withSession(
      c,
      a.auth,
      new NextResponse(file, {
        status: 200,
        headers: {
          ...ACCOUNT_RESPONSE_HEADERS,
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="${ACTIVATION_FILE_NAME}"`,
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex",
        },
      }),
    );
  });
});
