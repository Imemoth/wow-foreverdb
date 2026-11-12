"use client";
import { FRESHNESS_MS, GRANT_DEFAULT_DAYS, GRANT_MAX_DAYS, POLICY_VERSION } from "../domain/policy";
import { fmtAge, fmtTs, sessionView } from "../domain/selectors";
import { useAdmin } from "../state/AdminProvider";
import { BTN_DANGER, BTN_GHOST, Badge, CapBadge, Mono, Notice, PageHeader, Panel, TableWrap, type Capability } from "./primitives";

const CAPS: { name: string; cap: Capability; note: string; ref: string }[] = [
  { name: "Admin sign-in handoff, TOTP/AAL2 step and session handling", cap: "implemented", note: "Reviewed and merged but compiled OFF. The preview simulates the same states without any real Auth, cookie or token.", ref: "ADM-01B-2 / ADM-01B-3 (main)" },
  { name: "Private Admin schema and live authorization evaluator", cap: "implemented", note: "Default-deny, revocation checked per decision. Policy stays inactive; not connected to this preview.", ref: "ADM-01B-1 / ADM-01B-2 (main)" },
  { name: "Staff lifecycle: role/grant requests, suspension, Owner bootstrap & recovery controls", cap: "implemented", note: "Inactive migration with its own tests. The Staff & Roles screens here are a UI simulation of the contract.", ref: "ADM-01B-4 (main)" },
  { name: "Protected editorial action and audit boundary", cap: "future", note: "Open Draft PR #201 — not on main, so nothing from it is used. Provisional: the preview's audit and outbox behaviour follows its documented contract only.", ref: "ADM-01B-5 (PR #201, unmerged)" },
  { name: "Article identity, immutable revisions, revision-bound approvals", cap: "simulated", note: "The contract is owner-approved, but PR #202 is unmerged and no CMS storage exists yet. This preview is the first interactive rendering of it.", ref: "ADM-03A (PR #202, unmerged)" },
  { name: "Public projection, delivery worker, RSS/sitemap/cache coherence", cap: "future", note: "Publication here only moves a simulated pointer after a simulated receipt. The cross-database revocation window is unaccepted.", ref: "ADM-03C" },
  { name: "Media library, uploads and rights validation", cap: "future", note: "Preview uses three fixed synthetic CSS tiles; one has unverified rights to show the validation rule.", ref: "ADM-02" },
  { name: "Moderation cases and read-only operations status", cap: "future", note: "Roles exist in the matrix; no screens are built.", ref: "ADM-04" },
  { name: "Scheduling, group management UI, grant renewal workflow", cap: "future", note: "Deferred beyond V1 or not yet designed.", ref: "Roadmap" },
];

export function Settings() {
  const { state: s, run, reset } = useAdmin();
  const v = sessionView(s);
  const explore = (steps: Parameters<typeof run>[0][]): void => { for (const a of steps) run(a, { quiet: true }); };
  const states: { id: string; label: string; what: string; go: () => void }[] = [
    { id: "signed_out", label: "Signed out", what: "No Admin session.", go: () => explore([{ type: "session/signOut" }]) },
    { id: "mfa_required", label: "Signed in → MFA required", what: "Password step done, TOTP outstanding (AAL1).", go: () => explore([{ type: "session/signIn", personaId: "st-selene" }]) },
    { id: "mfa_verified", label: "MFA verified", what: "TOTP at AAL2; critical actions allowed for 15 minutes.", go: () => explore([{ type: "session/switchPersona", personaId: "st-selene" }]) },
    { id: "mfa_stale", label: "MFA freshness expired", what: "AAL2 session still valid; critical actions need a step-up.", go: () => explore([{ type: "session/switchPersona", personaId: "st-selene" }, { type: "clock/advance", minutes: 16 }]) },
    { id: "revoked", label: "Session revoked", what: "Revoked server-side; every action is denied at once.", go: () => explore([{ type: "session/switchPersona", personaId: "st-selene" }, { type: "session/revoke" }]) },
    { id: "access_denied", label: "Access denied", what: "Signed in, but a plain User has no admin.enter.", go: () => explore([{ type: "session/signIn", personaId: "st-pip" }]) },
  ];
  return (
    <>
      <PageHeader title="Settings" eyebrow="Preview" cap="simulated">Session states, policy constants, what is real versus simulated, and the isolation guarantees of this preview.</PageHeader>
      <div className="space-y-5">
        <Panel title="Authentication & session states">
          <p className="mb-3 text-sm text-mist">The default preview simulates every state without any real authentication. Current state: <Badge tone={v.status === "mfa_verified" ? "success" : v.status === "mfa_stale" || v.status === "mfa_required" ? "warning" : v.status === "revoked" || v.status === "access_denied" ? "error" : "neutral"}>{v.status.replace("_", " ")}</Badge>{v.persona && <> as <strong className="text-parchment">{v.persona.name}</strong></>}. Preview clock: {fmtTs(s.now)}{v.verifiedAgeMs !== null && <> · TOTP {fmtAge(v.verifiedAgeMs)} ago (limit {FRESHNESS_MS / 60000} min)</>}.</p>
          <ul className="grid gap-2 sm:grid-cols-2" data-testid="state-explorer">
            {states.map((x) => (
              <li key={x.id} className="rounded-lg border border-ink-700 p-3">
                <p className="text-sm font-semibold text-parchment">{x.label} {v.status === x.id && <Badge tone="info">current</Badge>}</p>
                <p className="mb-2 text-xs text-mist">{x.what}</p>
                <button type="button" className={`${BTN_GHOST} !min-h-8 text-sm`} onClick={x.go} data-testid={`state-${x.id}`}>Show this state</button>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-mist">These switches exist only inside the isolated preview runtime. No production route accepts a demo role, and no cookie, token or credential is created.</p>
        </Panel>

        <Panel title="Approved policy constants shown in this preview">
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-xs uppercase tracking-wide text-mist">Critical-action freshness</dt><dd>TOTP no older than {FRESHNESS_MS / 60000} minutes (ADR-020)</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-mist">Delegated grants</dt><dd>{GRANT_DEFAULT_DAYS}-day default, {GRANT_MAX_DAYS}-day maximum, auto-expiring</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-mist">Classification</dt><dd>No downgrade in V1 (ADM-03A)</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-mist">Policy version shown on approvals</dt><dd><Mono>{POLICY_VERSION}</Mono></dd></div>
          </dl>
        </Panel>

        <Panel title="What is real, simulated or future">
          <TableWrap label="Capability map">
            <table className="data-table" data-testid="capability-map">
              <caption className="sr-only">Capability status</caption>
              <thead><tr><th scope="col">Capability</th><th scope="col">Status</th><th scope="col">Notes</th><th scope="col">Reference</th></tr></thead>
              <tbody>{CAPS.map((c) => <tr key={c.name}><td className="min-w-56 font-medium text-parchment">{c.name}</td><td><CapBadge kind={c.cap} label={c.cap === "implemented" ? "Backend inactive" : undefined} /></td><td className="min-w-64 text-xs text-mist">{c.note}</td><td className="whitespace-nowrap text-xs">{c.ref}</td></tr>)}</tbody>
            </table>
          </TableWrap>
        </Panel>

        <Panel title="Isolation guarantees">
          <ul className="list-disc space-y-1 pl-5 text-sm text-mist">
            <li>Exists only in a dedicated preview build; a normal build does not contain this code and answers 404 for every <Mono>/admin-preview</Mono> path.</li>
            <li>Refuses to run unless the environment is explicitly local with fixture data and no credentials, database URL or hosted-platform signal.</li>
            <li>No API routes: all state lives in this tab&apos;s memory (and session storage). Nothing is sent anywhere.</li>
            <li>No service-role key, Supabase call, policy activation, staff assignment, migration or publication is possible from here.</li>
          </ul>
          <div className="mt-4"><button type="button" className={BTN_DANGER} onClick={reset} data-testid="reset-data">Reset all preview data</button></div>
        </Panel>
        <Notice tone="info" title="Preview ≠ approval">Seeing a workflow here does not approve it. ADM-03A mechanics, the cross-database revocation window and Admin activation keep their separate review and Owner gates.</Notice>
      </div>
    </>
  );
}
