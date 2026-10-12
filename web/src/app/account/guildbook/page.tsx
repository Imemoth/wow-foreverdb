import Link from "next/link";
import { redirect } from "next/navigation";
import { callWebRpc } from "@/lib/account/rpc-client";
import { refreshPath, requirePageUser } from "@/lib/account/page-session";
import { Unavailable } from "../_ui/Unavailable";
import { GuildbookBrowser } from "../_components/GuildbookBrowser";

export const metadata = { title: "Guildbook" };

export default async function GuildbookPage() {
  const p = await requirePageUser("/account/guildbook");
  if (!p.ok) return p.reason === "unavailable" ? <Unavailable /> : null;
  const out = await callWebRpc(p.ac.cfg, "fdb_account_installations", {}, p.session.at);
  if (!out.ok && out.kind === "unauthenticated") redirect(refreshPath("/account/guildbook"));
  return (
    <div data-account-wide>
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Your Guildbook</h1>
      <p className="mt-2 text-sm text-mist">Private: guilds captured by the installations linked to {p.user.email}. Nobody else can see this page.</p>
      {!out.ok ? (
        <div className="panel mt-6 p-6" role="alert"><p className="text-parchment">The Guildbook is temporarily unavailable. Reload in a moment.</p></div>
      ) : out.data.length === 0 ? (
        <div className="panel mt-6 space-y-2 p-6">
          <p className="text-parchment">No installation is linked to this account yet.</p>
          <p className="text-sm"><Link href="/account/link">Link an installation</Link></p>
        </div>
      ) : (
        <GuildbookBrowser installations={out.data.map((i) => ({ id: i.installation_id, guildCount: i.guild_count }))} />
      )}
      <p className="mt-6 text-sm"><Link href="/account">Back to your account</Link></p>
    </div>
  );
}
