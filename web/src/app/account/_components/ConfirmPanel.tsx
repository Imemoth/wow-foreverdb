"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { postJson } from "@/lib/account/client";
import { messageFor } from "@/lib/account/messages";
import { FormAlert } from "./Fields";

/**
 * The e-mail link only OPENS this page; nothing is consumed until the person presses the button (a mail scanner that
 * prefetches the link therefore cannot burn the one-time token). The token is removed from the address bar at once so
 * it does not linger in history, screenshots or a shared link.
 */
export function ConfirmPanel({ type, tokenHash }: { type: "signup" | "email" | "recovery"; tokenHash: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spent, setSpent] = useState(false);
  const alertRef = useRef<HTMLDivElement | null>(null);
  const recovery = type === "recovery";

  useEffect(() => {
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function go() {
    setBusy(true);
    setError(null);
    const r = await postJson("/account/api/confirm", { type, token_hash: tokenHash });
    if (r.data.ok && typeof r.data.redirect === "string") {
      window.location.replace(r.data.redirect);
      return;
    }
    setBusy(false);
    if (r.data.error === "invalid_or_expired") setSpent(true);
    setError(messageFor(r.data.error));
    alertRef.current?.focus();
  }

  return (
    <div className="panel space-y-4 p-6">
      <FormAlert message={error} alertRef={alertRef} />
      <p className="text-mist">
        {recovery ? "Press the button to continue and choose a new password." : "Press the button to confirm your email address and sign in."}
        {" "}Nothing happens until you do, so automatic link scanners cannot use up your link.
      </p>
      {spent ? (
        <p className="text-sm text-mist">
          <Link href={recovery ? "/account/forgot-password" : "/account/login"}>{recovery ? "Request a new reset link" : "Back to sign in"}</Link>
        </p>
      ) : (
        <button type="button" className="btn-primary w-full" onClick={go} disabled={busy} aria-busy={busy}>
          {busy ? "Working…" : recovery ? "Continue to reset password" : "Confirm email address"}
        </button>
      )}
    </div>
  );
}
