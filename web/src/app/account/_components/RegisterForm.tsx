"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { postJson } from "@/lib/account/client";
import { AUTH_BODIES } from "@/lib/account/contracts";
import { messageFor } from "@/lib/account/messages";
import { AccountTurnstile } from "./AccountTurnstile";
import { FormAlert, PasswordField, TextField } from "./Fields";

export function RegisterForm({ turnstileSiteKey }: { turnstileSiteKey: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
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
    const parsed = AUTH_BODIES.signup.safeParse({ email, password });
    if (!parsed.success) {
      const next: { email?: string; password?: string } = {};
      for (const i of parsed.error.issues) {
        if (i.path[0] === "email") next.email = "Enter a valid email address.";
        if (i.path[0] === "password") next.password = i.message.includes("short") ? "Use at least 12 characters." : "Use at most 72 bytes (long or non-Latin passwords count more per character).";
      }
      setErrors(next);
      setError("Please fix the highlighted fields.");
      alertRef.current?.focus();
      return;
    }
    setErrors({});
    if (turnstileSiteKey && !token) {
      setError(messageFor("challenge_required"));
      alertRef.current?.focus();
      return;
    }
    setBusy(true);
    const r = await postJson("/account/api/register", { ...parsed.data, turnstileToken: token ?? undefined });
    setBusy(false);
    setResetSignal((n) => n + 1);
    if (r.data.ok) {
      setPassword("");
      setDone(true);
      return;
    }
    if (r.data.error === "weak_password") setErrors({ password: messageFor("weak_password") });
    setError(messageFor(r.data.error));
    alertRef.current?.focus();
  }

  if (done) {
    return (
      <div className="panel space-y-3 p-6" role="status">
        <h2 className="panel-title text-xl">Check your email</h2>
        <p className="text-mist">
          If this address can be registered, we have sent a confirmation link to it. Open the link and press the confirm button to finish.
          The email can take a few minutes; check your spam folder too.
        </p>
        <p className="text-sm text-mist"><Link href="/account/login">Back to sign in</Link></p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate aria-busy={busy} className="panel space-y-4 p-6">
      <FormAlert message={error} alertRef={alertRef} />
      <TextField label="Email address" name="email" type="email" inputMode="email" value={email} onChange={setEmail} autoComplete="email" error={errors.email} />
      <PasswordField label="Password" name="password" value={password} onChange={setPassword} autoComplete="new-password" error={errors.password}
        hint="At least 12 characters. Use something unique to ForeverDB; a passphrase works well." />
      {turnstileSiteKey && <AccountTurnstile siteKey={turnstileSiteKey} onToken={onToken} resetSignal={resetSignal} />}
      <button type="submit" className="btn-gold w-full" disabled={busy}>{busy ? "Creating account…" : "Create account"}</button>
      <p className="text-sm text-mist">Already registered? <Link href="/account/login">Sign in</Link></p>
    </form>
  );
}
