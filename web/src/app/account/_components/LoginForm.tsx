"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { postJson } from "@/lib/account/client";
import { AUTH_BODIES } from "@/lib/account/contracts";
import { messageFor } from "@/lib/account/messages";
import { FormAlert, PasswordField, TextField } from "./Fields";

export function LoginForm({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alertRef = useRef<HTMLDivElement | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setEmailError(undefined);
    const parsed = AUTH_BODIES.password_grant.safeParse({ email, password });
    if (!parsed.success) {
      const emailIssue = parsed.error.issues.some((i) => i.path[0] === "email");
      if (emailIssue) setEmailError("Enter a valid email address.");
      setError(emailIssue ? "Please enter a valid email address." : "Please enter your password (at most 72 bytes).");
      alertRef.current?.focus();
      return;
    }
    setBusy(true);
    const r = await postJson("/account/api/login", { email: parsed.data.email, password, next });
    if (r.data.ok && typeof r.data.redirect === "string") {
      window.location.assign(r.data.redirect); // full navigation: the new session needs a fresh CSRF binding
      return;
    }
    setBusy(false);
    setPassword("");
    setError(messageFor(r.data.error));
    alertRef.current?.focus();
  }

  return (
    <form onSubmit={submit} noValidate aria-busy={busy} className="panel space-y-4 p-6">
      <FormAlert message={error} alertRef={alertRef} />
      <TextField label="Email address" name="email" type="email" inputMode="email" value={email} onChange={setEmail} autoComplete="username" error={emailError} />
      <PasswordField label="Password" name="password" value={password} onChange={setPassword} autoComplete="current-password" />
      <button type="submit" className="btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      <p className="flex flex-wrap justify-between gap-2 text-sm text-mist">
        <Link href="/account/forgot-password">Forgot your password?</Link>
        <Link href="/account/register">Create account</Link>
      </p>
    </form>
  );
}
