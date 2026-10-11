"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { postJson } from "@/lib/account/client";
import { AUTH_BODIES } from "@/lib/account/contracts";
import { messageFor } from "@/lib/account/messages";
import { FormAlert, PasswordField } from "./Fields";

export function ResetForm() {
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const alertRef = useRef<HTMLDivElement | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPasswordError(undefined);
    const parsed = AUTH_BODIES.update_password.safeParse({ password });
    if (!parsed.success) {
      const m = parsed.error.issues[0]?.message ?? "";
      setPasswordError(m.includes("short") ? "Use at least 12 characters." : "Use at most 72 bytes (long or non-Latin passwords count more per character).");
      setError("Please fix the highlighted field.");
      alertRef.current?.focus();
      return;
    }
    setBusy(true);
    const r = await postJson("/account/api/reset-password", { password });
    if (r.data.ok && typeof r.data.redirect === "string") {
      window.location.assign(r.data.redirect);
      return;
    }
    setBusy(false);
    if (r.data.error === "recovery_required") setExpired(true);
    if (r.data.error === "weak_password" || r.data.error === "same_password") setPasswordError(messageFor(r.data.error));
    setError(messageFor(r.data.error));
    alertRef.current?.focus();
  }

  if (expired) {
    return (
      <div className="panel space-y-3 p-6" role="alert">
        <p className="text-danger">{messageFor("recovery_required")}</p>
        <Link className="btn-gold" href="/account/forgot-password">Request a new link</Link>
      </div>
    );
  }
  return (
    <form onSubmit={submit} noValidate aria-busy={busy} className="panel space-y-4 p-6">
      <FormAlert message={error} alertRef={alertRef} />
      <PasswordField label="New password" name="password" value={password} onChange={setPassword} autoComplete="new-password" error={passwordError}
        hint="At least 12 characters." />
      <button type="submit" className="btn-gold w-full" disabled={busy}>{busy ? "Saving…" : "Set new password"}</button>
    </form>
  );
}
