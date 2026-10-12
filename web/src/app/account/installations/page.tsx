import Link from "next/link";
import { callWebRpc } from "@/lib/account/rpc-client";
import { requirePageUser } from "@/lib/account/page-session";
import { Unavailable } from "../_ui/Unavailable";

export const metadata = { title: "Installations" };

const fmt = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
};

export default async function InstallationsPage() {
  const p = await requirePageUser("/account/installations");
  if (!p.ok) return p.reason === "unavailable" ? <Unavailable /> : null;
  // The list comes from the database for THIS verified session: nothing about it is read from the request.
  const out = await callWebRpc(p.ac.cfg, "fdb_account_installations", {}, p.session.at);
  return (
    <div data-account-wide>
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Your installations</h1>
      <p className="mt-2 text-sm text-mist">Signed in as {p.user.email}. Only installations owned by this account are listed (at most 50).</p>
      {!out.ok ? (
        <div className="panel mt-6 space-y-2 p-6" role="alert">
          <p className="text-parchment">
            {out.kind === "forbidden" ? "This account cannot list installations." : out.kind === "unauthenticated" ? <>Your session could not be verified. <Link href="/account/login?next=%2Faccount%2Finstallations">Sign in again</Link>.</> : "The installation list is temporarily unavailable. Reload in a moment."}
          </p>
        </div>
      ) : out.data.length === 0 ? (
        <div className="panel mt-6 space-y-2 p-6">
          <p className="text-parchment">No installation is linked to this account yet.</p>
          <p className="text-sm"><Link href="/account/link">Link an installation</Link></p>
        </div>
      ) : (
        <ul className="mt-6 space-y-3" aria-label="Linked installations">
          {out.data.map((i) => (
            <li key={i.installation_id} className="panel space-y-2 p-5" data-testid="installation-row">
              <p className="break-all font-mono text-sm text-gold-300">{i.installation_id}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-mist">Linked</dt><dd className="text-parchment">{fmt(i.linked_at)}</dd>
                <dt className="text-mist">Last seen</dt><dd className="text-parchment">{fmt(i.last_seen_at)}</dd>
                <dt className="text-mist">Guilds</dt><dd className="text-parchment">{i.guild_count}</dd>
              </dl>
              {/* the id travels in the URL FRAGMENT: it is never sent to the server or written to a request log */}
              <Link href={`/account/guildbook#installation=${encodeURIComponent(i.installation_id)}`}>Open Guildbook</Link>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-6 flex gap-4 text-sm"><Link href="/account/link">Link another installation</Link><Link href="/account">Back to your account</Link></p>
    </div>
  );
}
