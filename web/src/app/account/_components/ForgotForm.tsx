"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { postJson } from "@/lib/account/client";
import { AUTH_BODIES } from "@/lib/account/contracts";
import { messageFor } from "@/lib/account/messages";
import { AccountTurnstile } from "./AccountTurnstile";
import { FormAlert, TextField } from "./Fields";

export function ForgotForm({ turnstileSiteKey }: { turnstileSiteKey: string | null }) {
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const alertRef = useRef<HTMLDivElement | null>(null);
  const onToken = useCallback((t: string | null) => setToken(t), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setEmailError(undefined);
    const parsed = AUTH_BODIES.recover.safeParse({ email });
    if (!parsed.success) {
      setEmailError("Enter a valid email address.");
      setError("Please enter a valid email address.");
      alertRef.current?.focus();
      return;
    }
    if (turnstileSiteKey && !token) {
      setError(messageFor("challenge_required"));
      alertRef.current?.focus();
      return;
    }
    setBusy(true);
    const r = await postJson("/account/api/forgot-password", { email: parsed.data.email, turnstileToken: token ?? undefined });
    setBusy(false);
    setResetSignal((n) => n + 1);
    if (r.data.ok) {
      setDone(true);
      return;
    }
    setError(messageFor(r.data.error));
    alertRef.current?.focus();
  }

  if (done) {
    return (
      <div className="panel space-y-3 p-6" role="status">
        <h2 className="panel-title text-xl">Check your email</h2>
        <p className="text-mist">
          If an account exists for this address, we have sent a password-reset link to it. The link works once and expires soon.
        </p>
        <p className="text-sm text-mist"><Link href="/account/login">Back to sign in</Link></p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate aria-busy={busy} className="panel space-y-4 p-6">
      <FormAlert message={error} alertRef={alertRef} />
      <TextField label="Email address" name="email" type="email" inputMode="email" value={email} onChange={setEmail} autoComplete="email" error={emailError} />
      {turnstileSiteKey && <AccountTurnstile siteKey={turnstileSiteKey} onToken={onToken} resetSignal={resetSignal} />}
      <button type="submit" className="btn-gold w-full" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
      <p className="text-sm text-mist"><Link href="/account/login">Back to sign in</Link></p>
    </form>
  );
}
