"use client";

import { useState } from "react";
import { postJson } from "@/lib/account/client";
import { messageFor } from "@/lib/account/messages";
import { LogOutIcon } from "./icons";

export function LogoutButton({ compact = false }: { compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function logout() {
    setBusy(true);
    setError(null);
    const r = await postJson("/account/api/logout", {});
    if (r.data.ok && r.data.revoked === false) {
      setBusy(false);
      setError("This browser is signed out, but we could not confirm the sign-out on the server. Please sign out again later, or change your password if this is a shared computer.");
      return;
    }
    if (r.data.ok) {
      const to = "/account/login?reason=signed_out";
      window.location.assign(new URL(to, window.location.origin).toString());
      return;
    }
    setBusy(false);
    setError(messageFor(r.data.error));
  }
  if (compact) {
    return (
      <div>
        <button type="button" className="account-menu-item" onClick={logout} disabled={busy} aria-busy={busy}>
          <LogOutIcon className="h-4 w-4 text-violet-300" />{busy ? "Signing out…" : "Sign out"}
        </button>
        {error && <p role="alert" className="px-3 pb-2 text-xs text-danger">{error}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <button type="button" className="btn-ghost" onClick={logout} disabled={busy} aria-busy={busy}>{busy ? "Signing out…" : "Sign out"}</button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <p className="text-xs text-mist">Signing out ends this browser session only. Other devices and the Companion stay signed in.</p>
    </div>
  );
}
