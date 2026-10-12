import { accountApi } from "@/lib/account/handler";
import { jsonResponse } from "@/lib/account/http";
import { authenticate, readFailure, withSession } from "@/lib/account/private";
import { callWebRpc } from "@/lib/account/rpc-client";

export const dynamic = "force-dynamic";

/**
 * The installations OWNED by the signed-in account (database function `fdb_account_installations`, at most 50). Nothing is
 * read from the request: the list is whatever the database says the caller's own verified session owns.
 */
export const GET = accountApi({ route: "installations", mutating: false }, async (c) => {
  const a = await authenticate(c, { read: true });
  if (!a.ok) return a.response;
  const out = await callWebRpc(c.ac.cfg, "fdb_account_installations", {}, a.auth.session.at);
  if (!out.ok) return withSession(c, a.auth, readFailure(out));
  return withSession(
    c,
    a.auth,
    jsonResponse({
      ok: true,
      installations: out.data.map((i) => ({ installationId: i.installation_id, linkedAt: i.linked_at, lastSeenAt: i.last_seen_at, guildCount: i.guild_count })),
    }),
  );
});
