import { Badge, Notice, PageHeader, Panel } from "@/components/admin/primitives";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin · Staff & Roles" };

const ACTIONS = ["Invite staff", "Change a role", "Grant or revoke permissions", "Suspend or reactivate staff", "Revoke sessions"];

/** Informational only. There is no staff-management API in ADM-01B/03B and none is invented here: every control is disabled. */
export default function StaffPage() {
  return (
    <>
      <PageHeader title="Staff & Roles" eyebrow="Access" cap="simulated">Staff lifecycle is managed outside this interface. This page shows what exists and what does not.</PageHeader>
      <div className="mb-4"><Notice tone="info" title="No privileged staff-management API exists yet">The Admin foundation defines roles, grants and a staff lifecycle in the database, but exposes no browser-callable service to change them. These controls are intentionally disabled instead of pretending to work.</Notice></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Actions">
          <ul className="space-y-2" data-testid="staff-actions">{ACTIONS.map((a) => <li key={a} className="flex items-center justify-between gap-3"><button type="button" disabled aria-disabled className="btn-ghost opacity-50">{a}</button><Badge>Not available</Badge></li>)}</ul>
        </Panel>
        <Panel title="How access is enforced today">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>Staff identity, roles, scoped grants and an active policy live in the private Admin schema.</li>
            <li>Every CMS action re-checks the live session, policy, role/grant scope, suspension and a TOTP verification from the last 15 minutes.</li>
            <li>The <strong>Owner</strong> role cannot approve highlighted content it also authored or edited.</li>
            <li>Changes to staff are made by reviewed database operations, not by this website.</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
