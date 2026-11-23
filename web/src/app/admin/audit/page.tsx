import { Failure } from "@/components/admin/Failure";
import { Badge, EmptyState, Notice, PageHeader, Panel, TableWrap } from "@/components/admin/primitives";
import { fmtTs, shortId } from "@/components/admin/status";
import { adminCtxForPage, loadAudit } from "@/lib/admin/cms/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin · Audit log" };

export default async function AuditPage() {
  const r = await adminCtxForPage();
  if (!r.ok) return <Notice tone="warning" title="Admin access unavailable">Complete a fresh TOTP verification from your account.</Notice>;
  const a = await loadAudit(r.ctx, 100);
  return (
    <>
      <PageHeader title="Audit Log" eyebrow="Accountability" cap="implemented">Editorial events from the tamper-evident Admin audit chain, readable only with the audit permission. Draft text and secrets are never included.</PageHeader>
      {!a.ok ? (a.kind === "denied" ? <div data-testid="audit-denied"><Notice tone="warning" role="alert" title="Not authorized to read the audit log">Your role does not hold the audit read permission (or your TOTP verification is older than 15 minutes). Nothing is shown.</Notice></div> : <Failure f={a} what="read the audit log" />)
        : a.data.length === 0 ? <EmptyState title="No events yet">Editorial actions appear here once they happen.</EmptyState>
        : <Panel title={`Latest ${a.data.length} editorial events`}><TableWrap label="Audit events"><table className="data-table w-full" data-testid="audit-table"><thead><tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Resource</th><th>Outcome</th></tr></thead><tbody>
            {a.data.map((e) => <tr key={e.event_no} data-testid={`audit-${e.event_no}`}><td>{e.event_no}</td><td className="whitespace-nowrap">{fmtTs(e.occurred_at)}</td><td><code className="text-xs">{e.actor_id === r.ctx.uid ? "you" : e.actor_id ? shortId(e.actor_id) : "system"}</code></td><td>{e.action_key}</td><td className="[overflow-wrap:anywhere]">{e.resource_key}</td><td><Badge tone={e.outcome === "success" ? "success" : "error"}>{e.outcome}</Badge></td></tr>)}
          </tbody></table></TableWrap></Panel>}
    </>
  );
}
