import { accountApi } from "@/lib/account/handler";
import { jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";
import { authenticate, guarded, readFailure, withSession } from "@/lib/account/private";
import { callWebRpc } from "@/lib/account/rpc-client";

export const dynamic = "force-dynamic";

/**
 * Guilds captured by ONE installation, for the signed-in account. The installation id in the body is only a filter: the database
 * function `fdb_account_guildbook_guilds` re-derives the caller from the verified session and returns nothing (an empty list,
 * indistinguishable from "no guilds") for an installation the caller does not own. Sent as a JSON POST (CSRF-protected) so ids
 * never appear in URLs or request logs; it changes nothing.
 */
export const POST = accountApi({ route: "guildbook/guilds", mutating: true, body: INPUTS.guildbookGuilds }, async (c, body) => {
  const a = await authenticate(c, { read: true });
  if (!a.ok) return a.response;
  return guarded(c, a.auth, async () => {
  const out = await callWebRpc(c.ac.cfg, "fdb_account_guildbook_guilds", { p_installation_id: body.installationId }, a.auth.session.at);
  if (!out.ok) return withSession(c, a.auth, readFailure(out));
  return withSession(
    c,
    a.auth,
    jsonResponse({
      ok: true,
      guilds: out.data.map((g) => ({ guildKey: g.guild_key, guildName: g.guild_name, realmName: g.realm_name, capturedAt: g.captured_at, memberCount: g.member_count })),
    }),
  );
  });
});
