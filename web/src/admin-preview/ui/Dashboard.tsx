"use client";
import Link from "next/link";
import { GRANT_MAX_DAYS, grantStatus, roleLabel } from "../domain/policy";
import { canReadAudit, countByStatus, fmtAge, fmtTs, headOf, nameOf, sessionView } from "../domain/selectors";
import { useAdmin } from "../state/AdminProvider";
import { BASE } from "./Shell";
import { ArticleLink, ResultBadge, StaffLink } from "./common";
import { Badge, CapBadge, EmptyState, Notice, PageHeader, Panel } from "./primitives";

function Card({ href, label, value, hint, testId }: { href: string; label: string; value: number; hint: string; testId: string }) {
  return (
    <Link href={href} data-testid={testId} className="panel block p-4 no-underline transition hover:border-violet-400 focus-visible:border-violet-400">
      <span className="block text-xs font-semibold uppercase tracking-wide text-mist">{label}</span>
      <span className="mt-1 block font-display text-4xl text-gold-300">{value}</span>
      <span className="mt-1 block text-xs text-mist">{hint}</span>
    </Link>
  );
}

export function Dashboard() {
  const { state: s, dryRun } = useAdmin();
  const c = countByStatus(s);
  const v = sessionView(s);
  // Persona switches are preview mechanics, not administrative activity; they stay visible (and labelled) in the Audit Log.
  const events = s.audit.filter((e) => e.action !== "session.persona_switch" && canReadAudit(s, e)).slice(-7).reverse();
  const myTasks =
    s.articles.filter((a) => { const h = headOf(s, a); return h.state === "in_review" && dryRun({ type: "article/approve", articleId: a.id, revisionId: h.id }).ok; }).length +
    s.articles.filter((a) => { const h = headOf(s, a); return h.state === "approved" && a.publishedRevisionId !== h.id && dryRun({ type: "article/publish", articleId: a.id, revisionId: h.id }).ok; }).length +
    s.requests.filter((r) => r.status === "pending" && dryRun({ type: "staff/decideRequest", requestId: r.id, decision: "approve" }).ok).length;
  const activeStaff = s.staff.filter((x) => x.status === "active" && x.roles.some((r) => r !== "user"));
  const suspended = s.staff.filter((x) => x.status === "suspended");
  const expiring = s.grants.filter((g) => grantStatus(g, s.now) === "expiring");
  const roleCounts = (["owner", "administrator", "editor", "moderator"] as const).map((r) => ({ r, n: s.staff.filter((x) => x.status === "active" && x.roles.includes(r)).length }));

  return (
    <>
      <PageHeader title="Dashboard" eyebrow="AzerDex Admin" cap="simulated">
        An overview of the editorial and staff workflows built so far. Every number and event below is generated from <strong className="text-parchment">synthetic preview data</strong> — it is not production activity.
      </PageHeader>

      <div className="mb-6"><Notice tone="info" title="Preview data, not real activity">Authors, articles, grants and audit events are fictional (<code>@synthetic.invalid</code>). Changes you make exist only in this tab and can be reset from <em>Preview controls</em>.</Notice></div>

      <section aria-label="Summary" className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card testId="card-drafts" href={`${BASE}/articles?status=draft`} label="Draft articles" value={c.drafts} hint="Drafts and rejected heads" />
        <Card testId="card-awaiting" href={`${BASE}/review`} label="Awaiting approval" value={c.awaiting} hint="In review right now" />
        <Card testId="card-published" href={`${BASE}/articles?status=published`} label="Published articles" value={c.published} hint="Live revision present" />
        <Card testId="card-tasks" href={`${BASE}/review`} label="Pending review tasks" value={myTasks} hint={v.persona ? `Actionable by ${v.persona.name}` : "Sign in to see your tasks"} />
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Recent administrative activity" actions={<Link href={`${BASE}/audit`} className="text-sm">Open audit log →</Link>}>
            {events.length === 0 ? (
              <EmptyState title="No visible activity">Your current role cannot read audit events, or nothing has happened yet. Audit visibility is permissioned (<code>audit.editorial.read</code> / <code>audit.staff.read</code>).</EmptyState>
            ) : (
              <ul className="divide-y divide-ink-700">
                {events.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                    <ResultBadge r={e.result} />
                    <span className="font-mono text-xs text-gold-300">{e.action}</span>
                    <span className="min-w-0 flex-1 truncate text-parchment">{e.targetLabel}</span>
                    <span className="text-xs text-mist">{e.actorName} · {fmtTs(e.at)}</span>
                    {e.seeded ? <Badge tone="neutral" title="Synthetic sample event">Sample</Badge> : <Badge tone="info" title="Created by an action in this preview session">Preview-only</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Security & MFA status">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-2"><dt className="text-mist">Session</dt><dd><Badge tone={v.status === "mfa_verified" ? "success" : v.status === "mfa_stale" ? "warning" : "neutral"}>{v.status.replace("_", " ")}</Badge></dd></div>
              <div className="flex justify-between gap-2"><dt className="text-mist">Acting as</dt><dd className="text-parchment">{v.persona?.name ?? "—"}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-mist">Last TOTP</dt><dd className="text-parchment">{v.verifiedAgeMs === null ? "—" : `${fmtAge(v.verifiedAgeMs)} ago`}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-mist">Critical actions</dt><dd className="text-parchment">{v.status === "mfa_verified" ? "available (fresh)" : v.status === "mfa_stale" ? "re-verify required" : "unavailable"}</dd></div>
            </dl>
            <p className="mt-3 text-xs text-mist">Real Admin MFA/session handling is implemented on main (ADM-01B-2/3) but inactive; this panel is a simulation. <CapBadge kind="implemented" label="Backend inactive" /></p>
          </Panel>

          <Panel title="Staff status" actions={<Link href={`${BASE}/staff`} className="text-sm">Staff & Roles →</Link>}>
            <ul className="mb-3 grid grid-cols-2 gap-2 text-sm">
              {roleCounts.map((x) => <li key={x.r} className="rounded border border-ink-700 px-2 py-1"><span className="text-mist">{roleLabel(x.r)}</span> <strong className="float-right text-parchment">{x.n}</strong></li>)}
            </ul>
            <ul className="space-y-1 text-sm">
              <li>Active staff: <strong>{activeStaff.length}</strong></li>
              <li>Suspended: <strong>{suspended.length}</strong>{suspended.map((x) => <span key={x.id}> · <StaffLink id={x.id}>{x.name}</StaffLink></span>)}</li>
              <li>Grants expiring within 7 days: <strong>{expiring.length}</strong>{expiring.map((g) => <span key={g.id}> · <StaffLink id={g.subjectId}>{nameOf(s, g.subjectId)}</StaffLink></span>)}</li>
              <li>Pending staff requests: <strong>{c.pendingRequests}</strong></li>
            </ul>
            <p className="mt-2 text-xs text-mist">Delegated grants last {GRANT_MAX_DAYS} days at most.</p>
          </Panel>
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Panel title="Needs attention">
          <ul className="space-y-1 text-sm">
            <li><Link href={`${BASE}/articles?status=approved`}>{c.approvedReady} approved revision(s) ready to publish</Link></li>
            <li><Link href={`${BASE}/review`}>{c.pendingDelivery} delivery task(s) pending or failed (simulated worker)</Link></li>
            {s.articles.filter((a) => a.delivery === "delivery_failed").map((a) => <li key={a.id}><ArticleLink id={a.id}>{a.slug}</ArticleLink> — delivery failed</li>)}
          </ul>
        </Panel>
        <Panel title="What is real here?">
          <ul className="space-y-1 text-sm text-mist">
            <li><CapBadge kind="implemented" label="Backend inactive" /> Admin auth/MFA handoff, authorization evaluator, staff lifecycle (merged, not activated).</li>
            <li><CapBadge kind="simulated" /> Article workflow, approvals, delivery, staff changes, audit — all in-browser.</li>
            <li><CapBadge kind="future" /> Media uploads, moderation, ops status, scheduling.</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
