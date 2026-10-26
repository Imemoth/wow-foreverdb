import { accountApi } from "@/lib/account/handler";
import { jsonResponse } from "@/lib/account/http";
import { GUILDBOOK_PAGE_SIZE, INPUTS } from "@/lib/account/inputs";
import { authenticate, guarded, readFailure, withSession } from "@/lib/account/private";
import { callWebRpc } from "@/lib/account/rpc-client";

export const dynamic = "force-dynamic";

/**
 * One page of members of one guild of one installation. Installation id and guild key are FILTERS: ownership is decided by the
 * database function from the verified session. The page size is fixed here (the strict body schema refuses `limit`/`offset`), so
 * a caller can neither enlarge a page nor skip the pagination. Member GUIDs and internal columns are not part of the contract.
 */
export const POST = accountApi({ route: "guildbook/members", mutating: true, body: INPUTS.guildbookMembers }, async (c, body) => {
  const a = await authenticate(c, { read: true });
  if (!a.ok) return a.response;
  // Fail closed for all hosted targets: Guildbook belongs exclusively to local Companion.
  if (c.ac.env.FOREVERDB_DEPLOYMENT !== "local") return withSession(c, a.auth, readFailure({ ok: false, kind: "not_found" }));
  return guarded(c, a.auth, async () => {
  const out = await callWebRpc(
    c.ac.cfg,
    "fdb_account_guildbook_members",
    { p_installation_id: body.installationId, p_guild_key: body.guildKey, p_limit: GUILDBOOK_PAGE_SIZE, p_offset: body.page * GUILDBOOK_PAGE_SIZE },
    a.auth.session.at,
  );
  if (!out.ok) return withSession(c, a.auth, readFailure(out));
  return withSession(
    c,
    a.auth,
    jsonResponse({
      ok: true,
      page: body.page,
      pageSize: GUILDBOOK_PAGE_SIZE,
      members: out.data.map((m) => ({
        name: m.member_name, className: m.class_name, classFile: m.class_file, level: m.level, rank: m.rank_name, rankIndex: m.rank_index,
        online: m.online, zone: m.zone_name, lastOnlineHours: m.last_online_hours,
      })),
    }),
  );
  });
});
