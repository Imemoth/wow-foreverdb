import { ACCOUNT_GUILDBOOK_WEB_ENABLED } from "@/lib/account/config";

export const dynamic = "force-dynamic";

// Guildbook is local-only in the Companion. Keep this route as a deliberate
// deny-by-default compatibility boundary without a cloud RPC implementation.
export const POST = async () =>
  new Response(null, { status: ACCOUNT_GUILDBOOK_WEB_ENABLED ? 501 : 404 });
