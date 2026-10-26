import { ACCOUNT_GUILDBOOK_WEB_ENABLED } from "@/lib/account/config";

export const dynamic = "force-dynamic";

// The old cloud endpoint remains a 404 route for installed web clients. Data
// is retained server-side for migration/recovery; this build has no handler
// capable of authenticating or invoking it.
export const POST = async () =>
  new Response(null, { status: ACCOUNT_GUILDBOOK_WEB_ENABLED ? 501 : 404 });
