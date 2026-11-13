"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { LogoMark } from "@/components/Logo";
import { MFA_DEMO_CODE, roleLabel } from "../domain/policy";
import { fmtAge, fmtTs, sessionView } from "../domain/selectors";
import { useAdmin } from "../state/AdminProvider";
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, Badge, CapBadge, Field, FIELD, Modal, type Capability } from "./primitives";

export const BASE = "/admin-preview";
export const NAV: { href: string; label: string; caps: Capability[]; hint: string }[] = [
  { href: "", label: "Dashboard", caps: ["simulated"], hint: "Overview" },
  { href: "/articles", label: "Articles / News", caps: ["simulated"], hint: "ADM-03A contract" },
  { href: "/review", label: "Editorial Review Queue", caps: ["simulated"], hint: "Approvals & delivery" },
  { href: "/staff", label: "Staff & Roles", caps: ["simulated", "implemented"], hint: "ADM-01B-4 lifecycle" },
  { href: "/audit", label: "Audit Log", caps: ["simulated", "implemented"], hint: "ADM-01B audit chain" },
  { href: "/settings", label: "Settings", caps: ["simulated"], hint: "Session, policy, capabilities" },
];

export function EnvBanner() {
  return (
    <div role="region" aria-label="Environment" className="sticky top-0 z-40 border-b border-gold-500/60 bg-[repeating-linear-gradient(135deg,#2b1f08,#2b1f08_14px,#33250a_14px,#33250a_28px)] px-4 py-2 text-center">
      <p className="text-sm font-bold uppercase tracking-[0.12em] text-gold-300">DEMO / ISOLATED PREVIEW — NO PRODUCTION ACCESS</p>
      <p className="text-xs text-parchment/80">Synthetic data · lives only in this browser tab · nothing is read from or written to AzerDex services</p>
    </div>
  );
}

function SessionChip() {
  const { state, run, setControlsOpen } = useAdmin();
  const v = sessionView(state);
  const tone = v.status === "mfa_verified" ? "success" : v.status === "mfa_stale" ? "warning" : v.status === "revoked" || v.status === "access_denied" ? "error" : v.status === "mfa_required" ? "warning" : "neutral";
  const text: Record<string, string> = { signed_out: "Signed out", signed_in: "Signed in", mfa_required: "MFA required", mfa_verified: "MFA verified (AAL2)", mfa_stale: "MFA freshness expired", revoked: "Session revoked", access_denied: "Access denied" };
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="session-chip">
      <label className="flex items-center gap-2 text-xs text-mist">
        <span className="whitespace-nowrap">Act as <span className="text-bronze-400">(preview-only)</span></span>
        <select
          aria-label="Act as synthetic persona (preview-only)"
          className="field min-h-9 !py-1 text-sm"
          value={state.session.personaId ?? ""}
          onChange={(e) => { if (e.target.value) run({ type: "session/switchPersona", personaId: e.target.value }, { quiet: true }); }}
        >
          <option value="" disabled>Choose a persona…</option>
          {state.staff.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.roles.map(roleLabel).join(" + ")}{s.status === "suspended" ? " (suspended)" : ""}</option>)}
        </select>
      </label>
      <Badge tone={tone}>{text[v.status]}</Badge>
      {v.persona && v.status === "mfa_verified" && v.verifiedAgeMs !== null && <span className="hidden text-xs text-mist xl:inline">TOTP {fmtAge(v.verifiedAgeMs)} ago</span>}
      <button type="button" className={`${BTN_GHOST} !min-h-9 !py-1 text-sm`} onClick={() => setControlsOpen(true)}>Preview controls</button>
    </div>
  );
}

function StepUpDialog() {
  const { stepUp, closeStepUp, run, state } = useAdmin();
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const who = sessionView(state).persona;
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const o = run({ type: "session/stepUp", code }, { quiet: true });
    if (!o.ok) { setErr(o.fieldErrors?.code ?? o.message); return; }
    const retry = stepUp.retry;
    setCode(""); setErr(undefined);
    closeStepUp();
    if (retry) run(retry);
  };
  return (
    <Modal open={stepUp.open} onClose={() => { setErr(undefined); setCode(""); closeStepUp(); }} title="Verify again to continue (step-up)">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p>This is a <strong>critical action</strong>. ADR-020 requires TOTP authentication no older than 15 minutes{who ? ` — ${who.name}'s last verification has expired` : ""}.</p>
        <Field label="6-digit TOTP code (synthetic)" hint={<>Preview code: <code>{MFA_DEMO_CODE}</code>. No real authenticator is involved.</>} error={err}>
          {(p) => <input {...p} className={FIELD} inputMode="numeric" autoComplete="off" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />}
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_GHOST} onClick={() => { setErr(undefined); setCode(""); closeStepUp(); }}>Cancel</button>
          <button type="submit" className={BTN_PRIMARY}>Verify and continue</button>
        </div>
      </form>
    </Modal>
  );
}

function ControlsDialog() {
  const { controlsOpen, setControlsOpen, run, reset, state } = useAdmin();
  const [confirmReset, setConfirmReset] = useState(false);
  return (
    <Modal open={controlsOpen} onClose={() => { setControlsOpen(false); setConfirmReset(false); }} title="Preview controls" wide>
      <p className="mb-4 text-mist">These controls exist only in the isolated preview runtime. They simulate the passage of time and server-side events so every state can be inspected. They are not part of the production Admin.</p>
      <div className="space-y-5">
        <section aria-labelledby="pc-clock">
          <h3 id="pc-clock" className="mb-1 font-semibold text-gold-300">Preview clock</h3>
          <p className="mb-2 text-xs text-mist">Now: <strong className="text-parchment">{fmtTs(state.now)}</strong>. Advancing time expires TOTP freshness (15 min) and grants (30/90 days).</p>
          <div className="flex flex-wrap gap-2">
            {[{ l: "+16 min", m: 16 }, { l: "+1 hour", m: 60 }, { l: "+1 day", m: 1440 }, { l: "+7 days", m: 10080 }, { l: "+30 days", m: 43200 }].map((x) => (
              <button key={x.l} type="button" className={`${BTN_GHOST} !min-h-9`} onClick={() => run({ type: "clock/advance", minutes: x.m })}>{x.l}</button>
            ))}
          </div>
        </section>
        <section aria-labelledby="pc-sess">
          <h3 id="pc-sess" className="mb-1 font-semibold text-gold-300">Session</h3>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={`${BTN_GHOST} !min-h-9`} onClick={() => run({ type: "session/revoke" })}>Simulate session revocation</button>
            <button type="button" className={`${BTN_GHOST} !min-h-9`} onClick={() => run({ type: "session/signOut" })}>Sign out</button>
          </div>
        </section>
        <section aria-labelledby="pc-data">
          <h3 id="pc-data" className="mb-1 font-semibold text-gold-300">Synthetic data</h3>
          {!confirmReset
            ? <button type="button" className={`${BTN_DANGER} !min-h-9`} onClick={() => setConfirmReset(true)}>Reset all preview data…</button>
            : <div className="flex flex-wrap items-center gap-2"><span className="text-sm">Discard every change made in this tab?</span>
                <button type="button" className={`${BTN_DANGER} !min-h-9`} onClick={() => { reset(); setConfirmReset(false); setControlsOpen(false); }}>Yes, reset</button>
                <button type="button" className={`${BTN_GHOST} !min-h-9`} onClick={() => setConfirmReset(false)}>Keep my changes</button></div>}
        </section>
      </div>
    </Modal>
  );
}

function Toasts() {
  const { toasts, dismissToast } = useAdmin();
  const cls = { success: "border-conf-high/60 text-conf-high", error: "border-danger/60 text-danger", warning: "border-conf-medium/60 text-conf-medium", info: "border-violet-400/60 text-violet-300" } as const;
  const glyph = { success: "✓", error: "✕", warning: "▲", info: "●" } as const;
  return (
    <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 mx-auto flex w-[min(94vw,30rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} role={t.tone === "error" ? "alert" : "status"} data-testid={`toast-${t.tone}`} className={`pointer-events-auto flex items-start gap-3 rounded-lg border bg-ink-900/95 px-4 py-3 text-sm shadow-xl ${cls[t.tone]}`}>
          <span aria-hidden="true">{glyph[t.tone]}</span>
          <p className="flex-1 text-parchment">{t.text}</p>
          <button type="button" aria-label="Dismiss notification" onClick={() => dismissToast(t.id)} className="text-mist hover:text-white">✕</button>
        </div>
      ))}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? BASE;
  const rel = pathname.slice(BASE.length).replace(/\/$/, "");
  const [menu, setMenu] = useState(false);
  const isActive = (href: string): boolean => (href === "" ? rel === "" : rel === href || rel.startsWith(`${href}/`));
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#preview-main" className="skip-link">Skip to Admin content</a>
      <EnvBanner />
      <div className="flex flex-1 flex-col lg:flex-row">
        <nav id="admin-nav" aria-label="Admin" className={`${menu ? "block" : "hidden"} border-b border-ink-700 bg-ink-900 p-3 lg:block lg:w-64 lg:shrink-0 lg:border-b-0 lg:border-r lg:p-4`}>
          <div className="mb-5 hidden items-center gap-2 px-2 lg:flex">
            <LogoMark className="h-9 w-9" />
            <div><p className="panel-title text-lg leading-tight">AzerDex</p><p className="text-[0.7rem] uppercase tracking-[0.16em] text-bronze-400">Admin · preview</p></div>
          </div>
          <ul className="space-y-1">
            {NAV.map((n) => {
              const active = isActive(n.href);
              return (
                <li key={n.href}>
                  <Link
                    href={`${BASE}${n.href}`} aria-current={active ? "page" : undefined} onClick={() => setMenu(false)}
                    className={`block rounded-lg border-l-2 px-3 py-2 no-underline ${active ? "border-gold-400 bg-violet-500/15 text-gold-300" : "border-transparent text-parchment hover:bg-ink-800 hover:text-white"}`}
                  >
                    <span className="block text-sm font-semibold">{n.label}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1">{n.caps.map((c) => <CapBadge key={c} kind={c} label={c === "implemented" ? "Backend inactive" : undefined} />)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <p className="mt-6 px-2 text-xs leading-relaxed text-mist">Legend: <CapBadge kind="implemented" label="Backend inactive" /> reviewed backend exists, not connected. <CapBadge kind="simulated" /> works here on synthetic data. <CapBadge kind="future" /> not built.</p>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-3 border-b border-ink-700 bg-ink-900/70 px-4 py-2 backdrop-blur">
            <button type="button" className="btn-ghost !min-h-9 lg:hidden" aria-expanded={menu} aria-controls="admin-nav" onClick={() => setMenu((m) => !m)}>
              <span aria-hidden="true">☰</span> Menu
            </button>
            <div className="flex-1" />
            <SessionChip />
          </div>
          <main id="preview-main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none sm:px-6">{children}</main>
          <footer className="border-t border-ink-700 px-4 py-3 text-center text-xs text-mist">
            ADM-UI-PREVIEW-01 · synthetic preview · policy: ADR-020 (owner-approved) and ADM-03A contract (PR #202, unmerged) · the preview clock is simulated, not wall-clock time
          </footer>
        </div>
      </div>
      <StepUpDialog />
      <ControlsDialog />
      <Toasts />
    </div>
  );
}
