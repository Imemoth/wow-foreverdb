import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/account/page-session";
import { pairingCookieName, readPairingCookie } from "@/lib/account/pairing-cookie";
import { browserPairingWebAvailable } from "@/lib/account/pairing-gate";
import { callAccountPairingRpc } from "@/lib/account/rpc-client";
import { Unavailable } from "../_ui/Unavailable";
import { DevicePairApproval } from "../_components/DevicePairApproval";

export const metadata = { title: "Pair a computer" };

const Notice = ({ children }: { children: React.ReactNode }) => <div className="panel space-y-2 p-6" role="status" tabIndex={-1}>{children}</div>;

export default async function DevicePairPage() {
  const p = await requirePageUser("/account/device-pair");
  if (!p.ok) return p.reason === "unavailable" ? <Unavailable /> : null;
  if (!browserPairingWebAvailable(p.ac)) notFound();

  const store = await cookies();
  const raw = store.get(pairingCookieName(p.ac.https))?.value;
  const locator = raw ? await readPairingCookie(p.ac.cfg.csrfSecret, raw) : null;
  if (!locator) return <><h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Pair a computer</h1><Notice><p className="text-parchment">No valid pairing request is open in this browser.</p><p className="text-sm text-mist">Start a new request in the ForeverDB Companion, then open the link it provides.</p></Notice></>;

  const preview = await callAccountPairingRpc(p.ac.cfg, "fdb_account_device_pair_preview", { p_pairing_id: locator.id }, p.session.at);
  if (!preview.ok) return <><h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Pair a computer</h1><Notice><p className="text-parchment">Pairing is temporarily unavailable.</p><p className="text-sm text-mist">Reload this page in a moment. No approval was made.</p></Notice></>;
  const data = preview.data;
  if ("ok" in data) {
    const conflict = data.error === "cannot_connect_to_this_account";
    return <><h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Pair a computer</h1><Notice><p className="text-parchment">{conflict ? "This computer cannot be connected to the signed-in account." : "This pairing request is no longer available."}</p><p className="text-sm text-mist">Signed in as <strong>{p.user.email}</strong>. Start a new request in the Companion if needed.</p></Notice></>;
  }
  if (data.state !== "pending" && data.state !== "approved") {
    const text = data.state === "expired" ? "This pairing request expired."
      : data.state === "denied" ? "This pairing request was denied."
      : data.state === "connected" ? "This computer is already connected."
      : "This pairing request was revoked.";
    return <><h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Pair a computer</h1><Notice><p className="text-parchment">{text}</p><p className="text-sm text-mist">Signed in as <strong>{p.user.email}</strong>.</p></Notice></>;
  }

  return (
    <>
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Pair a computer</h1>
      <DevicePairApproval accountEmail={p.user.email} pairingId={locator.id}
        computerName={data.computerName} installationSuffix={data.installationSuffix}
        expiresAt={data.expiresAt} canApprove={data.canApprove} initialState={data.state} />
    </>
  );
}
