export const dynamic = "force-dynamic";

// The Guildbook is Companion-local only: the website has no Guildbook API. This route is kept solely as a deny-by-default 404 for
// stale web clients; it does not authenticate, read a body or call any database function.
export const POST = async () => new Response(null, { status: 404 });
