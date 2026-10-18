"use client";

import { useRef, useState } from "react";
import { postJson } from "@/lib/account/client";
import { pairingMessageFor } from "@/lib/account/messages";

export interface DevicePairApprovalProps {
  accountEmail: string;
  pairingId: string;
  computerName: string | null;
  installationSuffix: string;
  expiresAt: string;
  canApprove: boolean;
  initialState: "pending" | "approved";
}

export function DevicePairApproval(props: DevicePairApprovalProps) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [state, setState] = useState<"pending" | "approved" | "denied">(props.initialState);
  const [error, setError] = useState<string | null>(null);
  const alertRef = useRef<HTMLDivElement | null>(null);
  const expiry = new Date(props.expiresAt);
  const expiryText = Number.isNaN(expiry.getTime()) ? "soon" : `${expiry.toISOString().replace("T", " ").slice(0, 19)} UTC`;

  async function decide(action: "approve" | "deny") {
    if (busy || state === "denied" || (action === "approve" && (state !== "pending" || !props.canApprove))) return;
    setBusy(action);
    setError(null);
    const reply = await postJson(`/account/api/device-pair/${action}`, {
      pairingId: props.pairingId,
      accountEmail: props.accountEmail,
    }, { retryCsrf: false });
    setBusy(null);
    if (reply.data.ok && (reply.data.state === "approved" || reply.data.state === "denied")) {
      setState(reply.data.state);
      return;
    }
    const code = typeof reply.data.error === "string" ? reply.data.error : reply.status === 0 ? "network" : "unknown";
    setError(pairingMessageFor(code));
    alertRef.current?.focus();
  }

  return (
    <section className="panel space-y-4 p-6" aria-labelledby="pair-request-heading" aria-busy={busy !== null}>
      <h2 id="pair-request-heading" className="panel-title text-xl">Pair this computer</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-mist">Account</dt><dd className="break-all font-medium text-parchment">{props.accountEmail}</dd>
        <dt className="text-mist">Computer</dt><dd className="text-parchment">{props.computerName || "Unnamed computer"}</dd>
        <dt className="text-mist">Installation</dt><dd className="font-mono text-parchment">{props.installationSuffix}</dd>
        <dt className="text-mist">Expires</dt><dd className="text-parchment">{expiryText}</dd>
      </dl>
      <p className="text-sm text-mist">Approve only if you started this request in the ForeverDB Companion on the computer shown above.</p>
      {error && <div ref={alertRef} role="alert" tabIndex={-1} className="rounded-lg border border-danger/50 p-3 text-sm text-danger">{error}</div>}
      {state === "approved" && <p role="status" tabIndex={-1} className="text-sm text-conf-high">Approved. Return to the Companion to finish connecting.</p>}
      {state === "denied" && <p role="status" tabIndex={-1} className="text-sm text-mist">Denied. The Companion cannot use this request.</p>}
      {state === "pending" && props.canApprove && (
        <div className="flex flex-col gap-3 sm:flex-row">
          <button type="button" className="btn-gold flex-1" disabled={busy !== null} onClick={() => decide("approve")}>{busy === "approve" ? "Approving…" : "Approve this computer"}</button>
          <button type="button" className="btn-secondary flex-1" disabled={busy !== null} onClick={() => decide("deny")}>{busy === "deny" ? "Denying…" : "Deny request"}</button>
        </div>
      )}
      {state === "pending" && !props.canApprove && <p role="status" tabIndex={-1} className="text-sm text-mist">This request cannot be approved by the account shown above.</p>}
      {state === "approved" && (
        <button type="button" className="btn-secondary w-full" disabled={busy !== null} onClick={() => decide("deny")}>{busy === "deny" ? "Denying…" : "Deny this approved request"}</button>
      )}
    </section>
  );
}
