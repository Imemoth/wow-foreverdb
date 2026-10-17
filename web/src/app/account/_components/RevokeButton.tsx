"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/account/client";
import { deviceMessageFor } from "@/lib/account/messages";

/**
 * Two-step revoke for a device or an unused activation file. It only ever sends an ID (a public identifier) to the CSRF-protected
 * JSON route; the activation file itself is never handled by page code. After any definite answer the server-rendered list is
 * reloaded, so the page always shows the database's state, not a guess.
 */
export function RevokeButton({ kind, id, what }: { kind: "device" | "ticket"; id: string; what: string }) {
  const router = useRouter();
  const [step, setStep] = useState<"idle" | "confirm" | "busy">("idle");
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    setStep("busy");
    setError(null);
    const r = await postJson(kind === "device" ? "/account/api/devices/revoke" : "/account/api/enrollment/revoke", kind === "device" ? { deviceId: id } : { ticketId: id });
    if (r.data.ok) {
      setStep("idle");
      router.refresh();
      return;
    }
    const err = typeof r.data.error === "string" ? r.data.error : r.status === 0 ? "network" : "";
    if (err === "unauthenticated") {
      window.location.assign(new URL("/account/login?reason=expired&next=%2Faccount%2Fdevices", window.location.origin).toString());
      return;
    }
    setStep("idle");
    setError(deviceMessageFor(err));
    if (err === "not_available" || err === "outcome_unknown") router.refresh(); // show the real state
  }

  return (
    <div className="space-y-1">
      {step === "idle" ? (
        <button type="button" className="btn-ghost" onClick={() => setStep("confirm")} aria-label={`Revoke ${what}`}>Revoke</button>
      ) : (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Confirm revoking ${what}`}>
          <span className="text-sm text-parchment">Revoke this {kind === "device" ? "device" : "activation file"}?</span>
          <button type="button" className="btn-primary" onClick={revoke} disabled={step === "busy"} aria-busy={step === "busy"}>{step === "busy" ? "Revoking…" : "Yes, revoke"}</button>
          <button type="button" className="btn-ghost" onClick={() => setStep("idle")} disabled={step === "busy"}>Cancel</button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
