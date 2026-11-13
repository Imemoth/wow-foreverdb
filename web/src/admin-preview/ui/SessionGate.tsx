"use client";
import { useState, type FormEvent } from "react";
import { MFA_DEMO_CODE, roleLabel } from "../domain/policy";
import { sessionView } from "../domain/selectors";
import { useAdmin } from "../state/AdminProvider";
import { BTN_GHOST, BTN_PRIMARY, Badge, Field, FIELD, Notice, Panel } from "./primitives";

/** The preview's stand-in for "/account sign-in → Admin TOTP step". Entirely simulated: no credential, cookie or token exists. */
export function SessionGate() {
  const { state, run } = useAdmin();
  const v = sessionView(state);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const o = run({ type: "session/submitMfa", code }, { quiet: true });
    if (!o.ok) setErr(o.fieldErrors?.code ?? o.message);
    else { setErr(undefined); setCode(""); }
  };
  if (v.status === "mfa_required") {
    return (
      <div className="mx-auto max-w-lg">
        <Panel title={`Verify TOTP — ${v.persona?.name ?? ""}`}>
          <p className="mb-4 text-sm text-mist">Admin requires <strong className="text-parchment">TOTP at AAL2</strong>. Registered Companion and Account sessions stay AAL1 and cannot enter.</p>
          <form onSubmit={submit} className="space-y-4" noValidate>
            <Field label="6-digit code" hint={<>This is a simulation. Use the synthetic code <code className="text-gold-300">{MFA_DEMO_CODE}</code>; any other code counts as a failed attempt (3 attempts, then a simulated lockout).</>} error={err}>
              {(p) => <input {...p} className={FIELD} inputMode="numeric" autoComplete="off" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />}
            </Field>
            <div className="flex gap-2">
              <button type="submit" className={BTN_PRIMARY}>Verify</button>
              <button type="button" className={BTN_GHOST} onClick={() => run({ type: "session/signOut" })}>Cancel</button>
            </div>
          </form>
        </Panel>
      </div>
    );
  }
  if (v.status === "revoked") {
    return (
      <div className="mx-auto max-w-lg"><Panel title="Session revoked">
        <Notice tone="error" role="alert" title="Your Admin session was revoked (simulated).">Revocation is checked at the next protected decision, even in an open tab. Every action is denied until you sign in again.</Notice>
        <div className="mt-4"><button type="button" className={BTN_PRIMARY} onClick={() => run({ type: "session/signOut" })}>Sign in again</button></div>
      </Panel></div>
    );
  }
  if (v.status === "access_denied") {
    return (
      <div className="mx-auto max-w-lg"><Panel title="Access denied">
        <Notice tone="error" role="alert" title={state.session.deniedReason ?? "This account cannot enter Admin."}>
          <code className="text-gold-300">admin.enter</code> is necessary and is held only by staff roles. An ordinary AzerDex account (User) never enters Admin.
        </Notice>
        <div className="mt-4"><button type="button" className={BTN_GHOST} onClick={() => run({ type: "session/signOut" })}>Back to sign-in</button></div>
      </Panel></div>
    );
  }
  return (
    <div className="mx-auto max-w-3xl">
      <Panel title="Sign in to the Admin preview">
        <p className="mb-1 text-sm text-mist">Choose a <strong className="text-parchment">synthetic</strong> account. The password step is simulated and then TOTP is requested. Real AzerDex accounts cannot sign in here.</p>
        <p className="mb-4 text-xs text-bronze-400">Quick tip: after signing in you can switch persona from the “Act as” menu in the top bar.</p>
        <ul className="grid gap-3 sm:grid-cols-2">
          {state.staff.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => run({ type: "session/signIn", personaId: s.id }, { quiet: true })} className="panel block h-full w-full p-3 text-left hover:border-violet-400">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-parchment">{s.name}</span>
                  <span className="flex gap-1">{s.roles.map((r) => <Badge key={r} tone={r === "user" ? "neutral" : "info"}>{roleLabel(r)}</Badge>)}{s.status === "suspended" && <Badge tone="error">Suspended</Badge>}</span>
                </span>
                <span className="mt-1 block text-xs text-mist">{s.note}</span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
