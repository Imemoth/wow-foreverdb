"use client";
import Link from "next/link";
import { useState } from "react";
import { GRANT_DEFAULT_DAYS, GRANT_MAX_DAYS, PERMISSIONS, ROLES, grantStatus, roleLabel } from "../domain/policy";
import { fmtTs, nameOf, sessionActive, sessionView } from "../domain/selectors";
import { useAdmin } from "../state/AdminProvider";
import { BASE } from "./Shell";
import { RoleBadges, StaffLink } from "./common";
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, Badge, CapBadge, EmptyState, Notice, PageHeader, Panel, TableWrap, Tabs } from "./primitives";

type TabId = "staff" | "requests" | "roles" | "owner";

function RolesMatrix() {
  const sym = { yes: "✓", grant: "G", none: "—" } as const;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ROLES.map((r) => <div key={r.id} className="panel p-3"><p className="panel-title">{r.label}</p><p className="mt-1 text-sm text-parchment/90">{r.summary}</p><p className="mt-2 text-xs text-mist">{r.boundary}</p></div>)}
      </div>
      <Notice tone="info" title="How to read the matrix">✓ = granted by the role (ADR-020). <strong>G</strong> = only through an individually approved, scoped, expiring grant — the role alone never confers it. — = no default. Delegated grants default to {GRANT_DEFAULT_DAYS} days and never exceed {GRANT_MAX_DAYS}. Cells for publishing and highlighted approval are OWNER APPROVED; other defaults are PROPOSED.</Notice>
      <TableWrap label="Role permission matrix">
        <table className="data-table" data-testid="roles-matrix">
          <caption className="sr-only">Permissions by role</caption>
          <thead><tr><th scope="col">Permission</th><th scope="col">Area</th>{ROLES.map((r) => <th key={r.id} scope="col" className="text-center">{r.label}</th>)}<th scope="col">Critical</th></tr></thead>
          <tbody>
            {PERMISSIONS.map((p) => (
              <tr key={p.id}>
                <th scope="row" className="!static !bg-transparent !normal-case !tracking-normal"><code className="text-xs text-gold-300">{p.id}</code><span className="block text-xs font-normal text-mist">{p.summary}</span></th>
                <td className="text-xs">{p.area}</td>
                {p.cells.map((c, i) => <td key={i} className={`text-center font-semibold ${c === "yes" ? "text-conf-high" : c === "grant" ? "text-conf-medium" : "text-mist"}`}><span aria-hidden="true">{sym[c]}</span><span className="sr-only">{c === "yes" ? "granted" : c === "grant" ? "grant only" : "none"}</span></td>)}
                <td>{p.critical ? <Badge tone="warning" title="Needs TOTP no older than 15 minutes">Fresh MFA</Badge> : <span className="text-xs text-mist">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}

function OwnerPanel() {
  const { state: s, run } = useAdmin();
  const [out, setOut] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <Notice tone="warning" title="Simulation only">Owner bootstrap and recovery are audited operator ceremonies in the approved design (ADM-01B-4). Nothing here creates, changes or recovers any real account, factor or session, and the preview cannot be used to rehearse a real credential.</Notice>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Initial Owner bootstrap" actions={<CapBadge kind="implemented" label="Backend inactive" />}>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-mist">
            <li>Product Owner selects an existing, confirmed account by exact ID; a security operator and a different delegate sign the record.</li>
            <li>An operator arms a private singleton for at most 15 minutes.</li>
            <li>The target signs in, completes TOTP (AAL2, fresh &lt; 15 min); the bootstrap assigns Owner once, audits it and consumes the singleton atomically.</li>
            <li>Two witnesses compare evidence; the temporary operator credential is revoked.</li>
          </ol>
          <p className="mt-3 text-sm">State in this simulation: <Badge tone={s.ownerCeremony.bootstrapConsumed ? "neutral" : "warning"}>{s.ownerCeremony.bootstrapConsumed ? "Consumed — path closed" : "Armed"}</Badge></p>
          <button type="button" className={`${BTN_GHOST} mt-3`} data-testid="owner-bootstrap" onClick={() => { const o = run({ type: "owner/bootstrapSim" }); setOut(o.message); }}>Try to re-arm bootstrap</button>
        </Panel>
        <Panel title="Lost-factor / last-Owner recovery" actions={<CapBadge kind="future" label="Runbook gated" />}>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-mist">
            <li>Freeze affected access and preserve evidence; confirm whether another active Owner exists.</li>
            <li>Two independent operators and a Product Owner delegate verify identity out of band.</li>
            <li>Revoke compromised sessions/factors; require a new live AAL2 session and TOTP proof within 15 minutes.</li>
            <li>Record the decision atomically; independent review within one business day. If anything cannot be established, recovery is NO-GO.</li>
          </ol>
          <p className="mt-3 text-sm">Last drill: {s.ownerCeremony.lastRecoveryDrillAt ? fmtTs(s.ownerCeremony.lastRecoveryDrillAt) : "never"}</p>
          <button type="button" className={`${BTN_PRIMARY} mt-3`} data-testid="owner-recovery" onClick={() => { const o = run({ type: "owner/recoveryDrill" }); setOut(o.message); }}>Run recovery drill (simulation)</button>
        </Panel>
      </div>
      {out && <p role="status" className="text-sm text-mist">Last result: {out}</p>}
    </div>
  );
}

export function StaffList() {
  const { state: s, run } = useAdmin();
  const v = sessionView(s);
  const [tab, setTab] = useState<TabId>("staff");
  const reqs = s.requests.slice().reverse();
  return (
    <>
      <PageHeader title="Staff & Roles" eyebrow="Governance" cap="simulated">
        Inspect and change synthetic staff. Role and grant rules follow ADR-020: scoped, expiring grants; independent approval of elevations; Owner changes only by ceremony. The reviewed staff-lifecycle backend (ADM-01B-4) exists but is inactive and is <strong>not</strong> used here.
      </PageHeader>
      {!sessionActive(v) && <div className="mb-4"><Notice tone="warning" title="Not signed in">Sign in to act on staff.</Notice></div>}
      <Tabs<TabId> label="Staff sections" value={tab} onChange={setTab} tabs={[{ id: "staff", label: "Staff", count: s.staff.length }, { id: "requests", label: "Requests", count: s.requests.filter((r) => r.status === "pending").length }, { id: "roles", label: "Roles & permissions" }, { id: "owner", label: "Owner ceremonies" }]}>
      {tab === "staff" && (
        <TableWrap label="Staff">
          <table className="data-table" data-testid="staff-table">
            <caption className="sr-only">Synthetic staff accounts</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Roles</th><th scope="col">Status</th><th scope="col">Active grants</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
            <tbody>
              {s.staff.map((m) => {
                const g = s.grants.filter((x) => x.subjectId === m.id && ["active", "expiring"].includes(grantStatus(x, s.now))).length;
                return (
                  <tr key={m.id} data-testid={`staff-row-${m.id}`}>
                    <td><StaffLink id={m.id}>{m.name}</StaffLink><span className="block text-xs text-mist">{m.handle}</span></td>
                    <td><RoleBadges roles={m.roles} /></td>
                    <td>{m.status === "active" ? <Badge tone="success">Active</Badge> : <Badge tone="error" title={m.suspendedReason ?? ""}>Suspended</Badge>}</td>
                    <td className="font-mono">{g}</td>
                    <td><Link href={`${BASE}/staff/${m.id}`} className={`${BTN_GHOST} !min-h-8 !px-3 text-sm`}>View</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
      {tab === "requests" && (reqs.length === 0 ? <EmptyState title="No requests">Role and elevated-grant proposals appear here.</EmptyState> : (
        <TableWrap label="Staff change requests"><table className="data-table" data-testid="requests-table"><thead><tr><th scope="col">Request</th><th scope="col">Proposed by</th><th scope="col">Subject</th><th scope="col">Status</th><th scope="col">Decided by</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>
          {reqs.map((r) => (
            <tr key={r.id}>
              <td>{r.kind === "role" ? <>Role <Badge tone="info">{roleLabel(r.role)}</Badge></> : <>Grant <code className="text-xs">{r.permission}</code> · {r.days} d</>}<span className="block max-w-sm text-xs text-mist">{r.reason}</span></td>
              <td className="text-xs">{nameOf(s, r.proposerId)}</td><td className="text-xs">{nameOf(s, r.targetId)}</td>
              <td><Badge tone={r.status === "pending" ? "warning" : r.status === "approved" ? "success" : "error"}>{r.status}</Badge></td>
              <td className="text-xs">{nameOf(s, r.decidedBy)}</td>
              <td>{r.status === "pending" && <span className="flex gap-1"><button type="button" className={`${BTN_PRIMARY} !min-h-8 !px-3 text-sm`} onClick={() => run({ type: "staff/decideRequest", requestId: r.id, decision: "approve" })}>Approve</button><button type="button" className={`${BTN_DANGER} !min-h-8 !px-3 text-sm`} onClick={() => run({ type: "staff/decideRequest", requestId: r.id, decision: "reject" })}>Reject</button></span>}</td>
            </tr>
          ))}
        </tbody></table></TableWrap>
      ))}
      {tab === "roles" && <RolesMatrix />}
      {tab === "owner" && <OwnerPanel />}
      </Tabs>
    </>
  );
}
