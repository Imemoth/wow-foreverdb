import Link from "next/link";
import { csrfBinding, mintCsrf, FORM_CSRF_FIELD } from "@/lib/account/csrf";
import { TICKET_VALIDITY_HOURS } from "@/lib/account/contracts-enrollment";
import { DEVICE_MESSAGES } from "@/lib/account/messages";
import { requirePageUser } from "@/lib/account/page-session";
import { callWebRpc } from "@/lib/account/rpc-client";
import { Unavailable } from "../_ui/Unavailable";
import { RevokeButton } from "../_components/RevokeButton";

export const metadata = { title: "Devices" };

const fmt = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
};

const DEVICE_STATUS: Record<string, string> = { active: "Active", revoked: "Revoked", pending_approval: "Waiting for approval" };
const REVOKED_WHY: Record<string, string> = {
  owner_revoked: "You revoked this device.",
  replaced: "Replaced: this installation was activated again with a newer activation file.",
  credential_reuse: "Revoked automatically: its credential was used from two places at once (the Companion data may have been copied).",
};
const TICKET_STATUS: Record<string, string> = { pending: "Pending", consumed: "Used", expired: "Expired", revoked: "Revoked" };
const TICKET_HELP: Record<string, string> = {
  pending: "Not used yet. Valid until the date shown.",
  consumed: "Used by a Companion. It cannot be used again.",
  expired: "No longer valid. Download a new one if you still need it.",
  revoked: "Cancelled by you. It can no longer be used.",
};

/** The installation id is shown shortened; the full value is in the tooltip and in the selectable text for support. */
const shortId = (id: string) => (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id);

export default async function DevicesPage({ searchParams }: { searchParams: Promise<{ notice?: string | string[] }> }) {
  const p = await requirePageUser("/account/devices");
  if (!p.ok) return p.reason === "unavailable" ? <Unavailable /> : null;
  const { notice } = await searchParams;
  // Only a code from the closed list is ever shown: the URL can never inject text.
  const note = typeof notice === "string" && Object.hasOwn(DEVICE_MESSAGES, notice) ? DEVICE_MESSAGES[notice] : null;
  // The lists come from the database for THIS verified session: nothing about them is read from the request.
  const [devices, tickets] = await Promise.all([
    callWebRpc(p.ac.cfg, "fdb_account_devices", {}, p.session.at),
    callWebRpc(p.ac.cfg, "fdb_account_enrollment_tickets", {}, p.session.at),
  ]);
  // Session-bound form token (see csrf.ts verifyFormToken): the download is a native form post, never page JavaScript.
  const token = await mintCsrf(p.ac.cfg.csrfSecret, csrfBinding(p.session));

  return (
    <div data-account-wide className="space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Your computers</h1>
        <p className="mt-2 text-sm text-mist">Signed in as {p.user.email}. Computers where the ForeverDB Companion is connected to this account.</p>
      </div>
      {note && <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{note}</p>}

      <section className="panel space-y-3 p-6" aria-labelledby="add-h">
        <h2 id="add-h" className="panel-title text-lg">Add a computer</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-parchment">
          <li>Download the activation file below.</li>
          <li>Install the Companion on that computer right after downloading, and put the file where the installer asks for it.</li>
          <li>The Companion connects itself to your account. You do not have to sign in again or type a code.</li>
        </ol>
        <ul className="list-disc space-y-1 pl-5 text-sm text-mist">
          <li>The file is a one-time secret, valid for {TICKET_VALIDITY_HOURS} hours (7 days). Anyone who has it can connect a computer to your account, so do not share it or post it anywhere.</li>
          <li>If you lose it or it expires, come back here and download a new one. You do not need to reinstall anything.</li>
          <li>You can have at most 5 unused files at a time. Revoke one below if you no longer need it.</li>
        </ul>
        <form method="post" action="/account/api/enrollment/download" className="pt-1">
          <input type="hidden" name={FORM_CSRF_FIELD} value={token} />
          <button type="submit" className="btn-gold">Download activation file for a new computer</button>
        </form>
      </section>

      <section className="space-y-3" aria-labelledby="dev-h">
        <h2 id="dev-h" className="panel-title text-lg">Connected computers</h2>
        {!devices.ok ? (
          <div className="panel p-6" role="alert"><p className="text-parchment">{devices.kind === "unauthenticated" ? <>Your session could not be verified. <Link href="/account/login?next=%2Faccount%2Fdevices">Sign in again</Link>.</> : devices.kind === "forbidden" ? "This account cannot list computers." : "The list is temporarily unavailable. Reload in a moment."}</p></div>
        ) : devices.data.length === 0 ? (
          <div className="panel p-6"><p className="text-parchment">No computer is connected to this account yet.</p></div>
        ) : (
          <ul className="space-y-3" aria-label="Connected computers">
            {devices.data.map((d) => (
              <li key={d.device_id} className="panel space-y-2 p-5" data-testid="device-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-parchment">
                    <span className="font-semibold">{d.label ?? "Computer"}</span>{" "}
                    <span className={d.status === "active" ? "text-conf-high" : "text-mist"}>{DEVICE_STATUS[d.status] ?? d.status}</span>
                  </p>
                  {d.status !== "revoked" && <RevokeButton kind="device" id={d.device_id} what={`device ${shortId(d.installation_id)}`} />}
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-mist">Installation</dt><dd className="break-all font-mono text-gold-300" title={d.installation_id}>{shortId(d.installation_id)}</dd>
                  <dt className="text-mist">Connected</dt><dd className="text-parchment">{fmt(d.created_at)}</dd>
                  <dt className="text-mist">Last seen</dt><dd className="text-parchment">{fmt(d.last_seen_at)}</dd>
                  {d.status === "revoked" && (<><dt className="text-mist">Revoked</dt><dd className="text-parchment">{fmt(d.revoked_at)}. {(d.revoked_reason && REVOKED_WHY[d.revoked_reason]) ?? ""}</dd></>)}
                </dl>
                {d.status === "active" && <p className="text-xs text-mist">Not you? Revoke this device: it stops synchronising immediately.</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="tick-h">
        <h2 id="tick-h" className="panel-title text-lg">Recent activation files</h2>
        <p className="text-sm text-mist">The files themselves are never kept or shown here, only their state (the latest 20).</p>
        {!tickets.ok ? (
          <div className="panel p-6" role="alert"><p className="text-parchment">The list is temporarily unavailable. Reload in a moment.</p></div>
        ) : tickets.data.length === 0 ? (
          <div className="panel p-6"><p className="text-parchment">You have not downloaded an activation file yet.</p></div>
        ) : (
          <ul className="space-y-3" aria-label="Recent activation files">
            {tickets.data.map((t) => (
              <li key={t.ticket_id} className="panel space-y-2 p-5" data-testid="ticket-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-parchment"><span className="font-semibold">{TICKET_STATUS[t.status] ?? t.status}</span> <span className="text-sm text-mist">{TICKET_HELP[t.status] ?? ""}</span></p>
                  {t.status === "pending" && <RevokeButton kind="ticket" id={t.ticket_id} what={`activation file created ${fmt(t.created_at)}`} />}
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-mist">Created</dt><dd className="text-parchment">{fmt(t.created_at)}</dd>
                  <dt className="text-mist">{t.status === "expired" ? "Expired" : "Valid until"}</dt><dd className="text-parchment">{fmt(t.expires_at)}</dd>
                  {t.status === "consumed" && (<><dt className="text-mist">Used</dt><dd className="text-parchment">{fmt(t.consumed_at)}</dd></>)}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="flex gap-4 text-sm"><Link href="/account/installations">Your installations</Link><Link href="/account">Back to your account</Link></p>
    </div>
  );
}
