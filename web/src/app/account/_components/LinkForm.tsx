"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { postJson } from "@/lib/account/client";
import { formatClaimCode, normalizeClaimCode } from "@/lib/account/contracts";
import { linkMessageFor } from "@/lib/account/messages";
import { FormAlert, PasswordField } from "./Fields";

type Phase =
  | { kind: "form" }
  | { kind: "done"; installationId: string; cleanup: string | undefined }
  | { kind: "unknown" };

/**
 * The linking form. The code and the password live ONLY in this component's memory: they are never put into a URL, cookie,
 * Web Storage, analytics or a log, are cleared after every submission and when the page is hidden or restored from the
 * back/forward cache, and the form does not allow the browser to autofill or remember the code.
 */
export function LinkForm({ email, accountId }: { email: string; accountId: string }) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [codeError, setCodeError] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const alertRef = useRef<HTMLDivElement | null>(null);
  const codeId = "link-code";

  useEffect(() => {
    const wipe = () => { setCode(""); setPassword(""); setUnderstood(false); };
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) wipe(); };
    window.addEventListener("pagehide", wipe);
    window.addEventListener("pageshow", onShow);
    return () => { window.removeEventListener("pagehide", wipe); window.removeEventListener("pageshow", onShow); };
  }, []);

  function onCode(v: string) {
    setCode(v);
    setCodeError(undefined);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setCodeError(undefined);
    const canonical = normalizeClaimCode(code);
    if (!canonical) {
      setCodeError("Enter the 32-character code from the Companion.");
      setError(linkMessageFor("invalid_code_format"));
      alertRef.current?.focus();
      return;
    }
    if (!password) { setError("Enter your account password to confirm it is you."); alertRef.current?.focus(); return; }
    if (!understood) { setError("Tick the confirmation box to continue."); alertRef.current?.focus(); return; }

    setBusy(true);
    const r = await postJson("/account/api/link", { code: canonical, password, confirm: true, accountId }, { retryCsrf: false }); // a changed session must never be silently adopted
    setPassword("");
    setBusy(false);
    if (r.data.ok && typeof r.data.installationId === "string") {
      setCode("");
      setUnderstood(false);
      setPhase({ kind: "done", installationId: r.data.installationId, cleanup: typeof r.data.reauthCleanup === "string" ? r.data.reauthCleanup : undefined });
      return;
    }
    const err = typeof r.data.error === "string" ? r.data.error : r.status === 0 ? "network" : "";
    // A lost reply (ours or the browser's) means the one-time call may have been processed: never "failed", never retried here.
    if (err === "outcome_unknown" || err === "network") {
      setCode("");
      setUnderstood(false);
      setPhase({ kind: "unknown" });
      return;
    }
    if (err === "account_changed" || err === "csrf") { setError("Your session changed while this page was open. Reload the page and check which account is shown."); alertRef.current?.focus(); return; }
    if (err === "unauthenticated") {
      window.location.assign(new URL("/account/login?reason=expired&next=%2Faccount%2Flink", window.location.origin).toString());
      return;
    }
    if (err === "invalid_claim" || err === "account_limit") setCode(""); // the code is spent or useless: never keep it around
    setError(linkMessageFor(err));
    alertRef.current?.focus();
  }

  if (phase.kind === "done") {
    return (
      <div className="panel space-y-3 p-6" role="status">
        <h2 className="panel-title text-lg">Installation linked</h2>
        <p className="text-sm text-parchment">
          Installation <code className="break-all text-gold-300">{phase.installationId}</code> now belongs to <strong>{email}</strong>.
          The Companion will notice the transfer and ask you to sign in with this account.
        </p>
        {phase.cleanup === "unconfirmed" && (
          <p className="text-xs text-mist">
            A temporary verification session could not be confirmed as closed on our side. Its credentials were discarded and cannot be used.
          </p>
        )}
        <p className="flex flex-wrap gap-4 text-sm">
          <Link href="/account/installations">Your installations</Link>
        </p>
      </div>
    );
  }
  if (phase.kind === "unknown") {
    return (
      <div className="panel space-y-3 p-6" role="alert">
        <h2 className="panel-title text-lg">Result not confirmed</h2>
        <p className="text-sm text-parchment">{linkMessageFor("outcome_unknown")}</p>
        <p className="text-sm"><Link href="/account/installations">Check your installations</Link></p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate autoComplete="off" aria-busy={busy} className="panel space-y-4 p-6">
      <FormAlert message={error} alertRef={alertRef} />
      <div className="space-y-1.5">
        <label htmlFor={codeId} className="block text-sm font-medium text-parchment">Installation linking code</label>
        <input
          id={codeId} name="linking-code" type="text" value={code} onChange={(e) => onCode(e.target.value)} required
          autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={80}
          aria-invalid={codeError ? true : undefined} aria-describedby={`${codeId}-hint${codeError ? ` ${codeId}-err` : ""}`}
          className="field w-full font-mono"
          onBlur={() => { const c = normalizeClaimCode(code); if (c) setCode(formatClaimCode(c)); }}
          placeholder="FDB-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
        />
        <p id={`${codeId}-hint`} className="text-xs text-mist">Valid for 10 minutes, usable once.</p>
        {codeError && <p id={`${codeId}-err`} className="text-sm text-danger">{codeError}</p>}
      </div>
      <PasswordField label={`Password for ${email}`} name="password" value={password} onChange={setPassword} autoComplete="current-password"
        hint="Enter your password again. A confirmation link alone is never enough to move an installation." />
      <label className="flex items-start gap-2 text-sm text-parchment">
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-1" />
        <span>
          I understand that the installation behind this code will be <strong>transferred to {email}</strong> and that the anonymous
          Companion identity that created the code will lose upload access to it.
        </span>
      </label>
      <button type="submit" className="btn-gold w-full" disabled={busy}>{busy ? "Linking…" : "Link this installation to my account"}</button>
    </form>
  );
}
