"use client";
import Link from "next/link";
import { useState } from "react";
import { GRANTABLE, GRANT_DEFAULT_DAYS, GRANT_MAX_DAYS, PERMISSIONS, ROLES, grantStatus, permDef, permissionFamily, permissionSources, roleLabel, scopeLabel } from "../domain/policy";
import { articleOf, fmtAge, fmtTs, nameOf, sessionActive, sessionView, staffOf } from "../domain/selectors";
import type { Grant, GrantScope, PermissionId, RoleId } from "../domain/types";
import { useAdmin } from "../state/AdminProvider";
import { BASE } from "./Shell";
import { ActionDialog } from "./ActionDialog";
import { RoleBadges } from "./common";
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, BTN_SM, Badge, EmptyState, Field, FIELD, Mono, Notice, PageHeader, Panel, TableWrap } from "./primitives";

type Dlg = null | { kind: "assign" } | { kind: "revokeRole"; role: RoleId } | { kind: "grant" } | { kind: "expiry"; grant: Grant } | { kind: "suspend" } | { kind: "revokeGrant"; grant: Grant };
const STATUS_TONE = { active: "success", expiring: "warning", expired: "neutral", revoked: "error" } as const;

export function StaffDetail({ staffId }: { staffId: string }) {
  const { state: s, run } = useAdmin();
  const m = staffOf(s, staffId);
  const v = sessionView(s);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [role, setRole] = useState<RoleId>("moderator");
  const [reason, setReason] = useState("");
  const [perm, setPerm] = useState<PermissionId>("news.article.publish");
  const [scopeKey, setScopeKey] = useState<string>("collection");
  const [days, setDays] = useState<string>(String(GRANT_DEFAULT_DAYS));
  const open = (d: Dlg): void => { setDlg(d); setReason(""); setDays(String(GRANT_DEFAULT_DAYS)); };
  if (!m) return <EmptyState title="Staff member not found" action={<Link href={`${BASE}/staff`} className={BTN_GHOST}>Back to staff</Link>}>This account does not exist in the current preview session.</EmptyState>;

  const grants = s.grants.filter((g) => g.subjectId === m.id).sort((a, b) => b.startsAt - a.startsAt);
  const effective = PERMISSIONS.map((p) => ({ p, src: permissionSources(m, s.grants, s.now, p.id) })).filter((x) => x.src.length > 0);
  const articleScoped = grants.filter((g) => g.scope.kind === "article" && grantStatus(g, s.now) !== "expired" && grantStatus(g, s.now) !== "revoked");
  const daysNum = Number(days);
  const daysErr = !days.trim() ? "Grants must expire: enter a duration." : !Number.isInteger(daysNum) || daysNum < 1 ? "Enter whole days (1 or more)." : daysNum > GRANT_MAX_DAYS ? `Limit: ${GRANT_MAX_DAYS} days maximum (30-day default).` : undefined;
  const scopeFor = (): GrantScope => (scopeKey === "collection" ? { kind: "collection", key: (permissionFamily(perm) ?? "news") as "news" | "staff" | "audit" | "ops" } : { kind: "article", articleId: scopeKey });
  const articles = s.articles;

  return (
    <>
      <PageHeader title={m.name} eyebrow="Staff & Roles" cap="simulated"
        actions={<><Link href={`${BASE}/staff`} className={BTN_GHOST}>All staff</Link>
          {m.status === "active"
            ? <button type="button" className={BTN_DANGER} onClick={() => open({ kind: "suspend" })} data-testid="suspend">Suspend…</button>
            : <button type="button" className={BTN_PRIMARY} onClick={() => run({ type: "staff/reactivate", targetId: m.id })} data-testid="reactivate">Reactivate</button>}</>}>
        <span className="flex flex-wrap items-center gap-2"><RoleBadges roles={m.roles} />{m.status === "active" ? <Badge tone="success">Active</Badge> : <Badge tone="error">Suspended</Badge>}</span>
        <span className="mt-2 block text-xs">{m.note}</span>
      </PageHeader>
      {m.status === "suspended" && <div className="mb-4"><Notice tone="error" title="Suspended">{m.suspendedReason}. Every protected decision for this account is denied, including in an open session. Grants keep their original expiry.</Notice></div>}
      {!sessionActive(v) && <div className="mb-4"><Notice tone="warning" title="Not signed in">Sign in to act on staff.</Notice></div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Roles" actions={<button type="button" className={`${BTN_PRIMARY} ${BTN_SM}`} onClick={() => { setRole(m.roles.includes("moderator") ? "editor" : "moderator"); open({ kind: "assign" }); }} data-testid="assign-role">Assign role…</button>}>
          <ul className="space-y-2">
            {m.roles.map((r) => (
              <li key={r} className="flex items-center justify-between gap-2 rounded border border-ink-700 px-3 py-2 text-sm">
                <span><strong>{roleLabel(r)}</strong><span className="block text-xs text-mist">{ROLES.find((x) => x.id === r)?.summary}</span></span>
                {r !== "user" && <button type="button" className={`${BTN_DANGER} ${BTN_SM}`} onClick={() => open({ kind: "revokeRole", role: r })} data-testid={`revoke-${r}`}>Revoke…</button>}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-mist">Administrator assignments need an independent approver. Owner can never be assigned or revoked here — only by audited ceremony.</p>
        </Panel>

        <Panel title="Effective permissions (now)">
          {effective.length === 0 ? <p className="text-sm text-mist">None. {m.status === "suspended" ? "Suspended accounts hold nothing." : "A User has no staff permissions."}</p> : (
            <ul className="max-h-72 space-y-1 overflow-y-auto pr-1" data-testid="effective-perms">
              {effective.map(({ p, src }) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <code className="text-xs text-gold-300">{p.id}</code>
                  <span className="flex flex-wrap gap-1">{src.map((x, i) => x.kind === "role" ? <Badge key={i} tone="info">{roleLabel(x.role)}</Badge> : <Badge key={i} tone="warning">grant {x.grantId.replace("gr-", "")}</Badge>)}{p.critical && <Badge tone="neutral" title="Needs fresh TOTP">fresh MFA</Badge>}</span>
                </li>
              ))}
            </ul>
          )}
          {articleScoped.length > 0 && <p className="mt-2 text-xs text-mist">Plus article-scoped: {articleScoped.map((g) => `${g.permission} @ ${scopeLabel(g.scope, (id) => articleOf(s, id)?.slug)}`).join("; ")}.</p>}
        </Panel>
      </div>

      <Panel title="Scoped grants" className="mt-4" actions={<button type="button" className={`${BTN_PRIMARY} ${BTN_SM}`} onClick={() => { setPerm("news.article.publish"); setScopeKey("collection"); open({ kind: "grant" }); }} data-testid="create-grant">Create grant…</button>}>
        <p className="mb-3 text-xs text-mist">A grant adds exactly one permission, in one scope, until it expires — {GRANT_DEFAULT_DAYS} days by default, {GRANT_MAX_DAYS} at most. Renewal is a new reviewed grant. Direct grants cannot override suspension, MFA or separation of duties.</p>
        {grants.length === 0 ? <EmptyState title="No grants">Roles give this account everything it can do today.</EmptyState> : (
          <TableWrap label="Grants"><table className="data-table" data-testid="grants-table">
            <thead><tr><th scope="col">Permission</th><th scope="col">Scope</th><th scope="col">Status</th><th scope="col">Starts</th><th scope="col">Expires</th><th scope="col">Duration</th><th scope="col">Proposer → approver</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {grants.map((g) => {
                const st = grantStatus(g, s.now);
                return (
                  <tr key={g.id} data-testid={`grant-${g.id}`}>
                    <td className="min-w-60"><Mono>{g.permission}</Mono><span className="block max-w-xs text-xs text-mist">{g.reason}</span></td>
                    <td className="text-xs">{scopeLabel(g.scope, (id) => articleOf(s, id)?.slug)}</td>
                    <td><Badge tone={STATUS_TONE[st]}>{st}{st === "expiring" ? ` (${fmtAge(g.expiresAt - s.now)})` : ""}</Badge></td>
                    <td className="whitespace-nowrap text-xs">{fmtTs(g.startsAt)}</td>
                    <td className="whitespace-nowrap text-xs">{fmtTs(g.expiresAt)}</td>
                    <td className="font-mono text-xs">{Math.round((g.expiresAt - g.startsAt) / 86_400_000)} d</td>
                    <td className="text-xs">{nameOf(s, g.proposerId)} → {nameOf(s, g.approverId)}</td>
                    <td>{(st === "active" || st === "expiring") && <span className="flex gap-1 whitespace-nowrap"><button type="button" className={`${BTN_GHOST} ${BTN_SM}`} onClick={() => { setDays(String(Math.round((g.expiresAt - g.startsAt) / 86_400_000))); setDlg({ kind: "expiry", grant: g }); }}>Set expiry…</button><button type="button" className={`${BTN_DANGER} ${BTN_SM}`} onClick={() => open({ kind: "revokeGrant", grant: g })}>Revoke…</button></span>}</td>
                  </tr>
                );
              })}
            </tbody></table></TableWrap>
        )}
      </Panel>

      <ActionDialog open={dlg?.kind === "assign"} onClose={() => setDlg(null)} title={`Assign a role to ${m.name}`} submitLabel="Assign / propose" testId="dlg-assign"
        submit={() => run({ type: "staff/proposeRole", targetId: m.id, role, reason })}>
        {(e) => <>
          <Field label="Role" error={e.role}>{(p) => <select {...p} className={FIELD} value={role} onChange={(ev) => setRole(ev.target.value as RoleId)}>{ROLES.filter((r) => r.id !== "user").map((r) => <option key={r.id} value={r.id}>{r.label}{r.id === "owner" ? " (ceremony only — try it)" : r.id === "administrator" ? " (needs independent approval)" : ""}</option>)}</select>}</Field>
          <Field label="Reason or ticket" error={e.reason}>{(p) => <input {...p} className={FIELD} value={reason} onChange={(ev) => setReason(ev.target.value)} autoFocus />}</Field>
          <p className="text-xs text-mist">Roles you cannot assign are refused with an explanation, and the refusal is audited.</p>
        </>}
      </ActionDialog>

      <ActionDialog open={dlg?.kind === "revokeRole"} onClose={() => setDlg(null)} title={`Revoke ${dlg?.kind === "revokeRole" ? roleLabel(dlg.role) : ""} from ${m.name}`} submitLabel="Revoke role" danger testId="dlg-revoke-role"
        submit={() => run({ type: "staff/revokeRole", targetId: m.id, role: dlg?.kind === "revokeRole" ? dlg.role : "editor", reason })}>
        {(e) => <Field label="Reason" error={e.reason}>{(p) => <input {...p} className={FIELD} value={reason} onChange={(ev) => setReason(ev.target.value)} autoFocus />}</Field>}
      </ActionDialog>

      <ActionDialog open={dlg?.kind === "grant"} onClose={() => setDlg(null)} title={`Create a scoped grant for ${m.name}`} submitLabel="Create / propose grant" testId="dlg-grant"
        submit={() => run({ type: "staff/createGrant", targetId: m.id, permission: perm, scope: scopeFor(), days: daysNum, reason })}>
        {(e) => <>
          <Field label="Permission" error={e.permission} hint={permDef(perm).summary}>{(p) => <select {...p} className={FIELD} value={perm} onChange={(ev) => { setPerm(ev.target.value as PermissionId); setScopeKey("collection"); }}>{GRANTABLE.map((g) => <option key={g} value={g}>{g}</option>)}</select>}</Field>
          <Field label="Scope" error={e.scope}>{(p) => <select {...p} className={FIELD} value={scopeKey} onChange={(ev) => setScopeKey(ev.target.value)}><option value="collection">Whole {permissionFamily(perm) ?? "news"} collection</option>{permissionFamily(perm) === "news" && articles.map((a) => <option key={a.id} value={a.id}>Only article: {a.slug}</option>)}</select>}</Field>
          <Field label="Duration (days)" hint={`Default ${GRANT_DEFAULT_DAYS}, maximum ${GRANT_MAX_DAYS}. Grants always expire.`} error={e.days ?? daysErr}>{(p) => <input {...p} className={FIELD} inputMode="numeric" value={days} onChange={(ev) => setDays(ev.target.value)} />}</Field>
          <Field label="Reason or ticket" error={e.reason}>{(p) => <input {...p} className={FIELD} value={reason} onChange={(ev) => setReason(ev.target.value)} />}</Field>
          <p className="text-xs text-mist">You cannot delegate a permission you do not hold. Highlighted-approval and staff-authority grants always need an independent approver.</p>
        </>}
      </ActionDialog>

      <ActionDialog open={dlg?.kind === "expiry"} onClose={() => setDlg(null)} title="Set grant expiration" submitLabel="Update expiry" testId="dlg-expiry"
        submit={() => run({ type: "staff/setGrantExpiry", grantId: dlg?.kind === "expiry" ? dlg.grant.id : "", days: daysNum })}>
        {(e) => <Field label="Total duration from the grant start (days)" hint={`Maximum ${GRANT_MAX_DAYS} days in total. To end a grant now, revoke it instead.`} error={e.days ?? daysErr}>{(p) => <input {...p} className={FIELD} inputMode="numeric" value={days} onChange={(ev) => setDays(ev.target.value)} autoFocus />}</Field>}
      </ActionDialog>

      <ActionDialog open={dlg?.kind === "revokeGrant"} onClose={() => setDlg(null)} title="Revoke grant" submitLabel="Revoke grant" danger testId="dlg-revoke-grant"
        submit={() => run({ type: "staff/revokeGrant", grantId: dlg?.kind === "revokeGrant" ? dlg.grant.id : "" })}>
        {() => <p>{dlg?.kind === "revokeGrant" && <>Revoking <Mono>{dlg.grant.permission}</Mono> takes effect at the next protected decision — including actions in progress, such as a queued publication whose worker re-checks the grant.</>}</p>}
      </ActionDialog>

      <ActionDialog open={dlg?.kind === "suspend"} onClose={() => setDlg(null)} title={`Suspend ${m.name}`} submitLabel="Suspend" danger testId="dlg-suspend"
        submit={() => run({ type: "staff/suspend", targetId: m.id, reason })}>
        {(e) => <>
          <Field label="Reason (audited)" error={e.reason}>{(p) => <input {...p} className={FIELD} value={reason} onChange={(ev) => setReason(ev.target.value)} autoFocus />}</Field>
          <p className="text-xs text-mist">Suspension denies every protected decision at once, including in an open session. Owner accounts and your own account cannot be suspended here.</p>
        </>}
      </ActionDialog>
    </>
  );
}
