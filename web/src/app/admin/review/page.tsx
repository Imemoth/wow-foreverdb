import Link from "next/link";
import { Failure } from "@/components/admin/Failure";
import { ADMIN_BASE } from "@/components/admin/Shell";
import { Badge, EmptyState, Notice, PageHeader, Panel, TableWrap } from "@/components/admin/primitives";
import { deliveryLabel, deliveryTone, fmtTs, statusOf } from "@/components/admin/status";
import { adminCtxForPage, loadArticles } from "@/lib/admin/cms/service";
import type { ListItem } from "@/lib/admin/cms/schemas";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin · Review queue" };

function Table({ rows, label, testid }: { rows: ListItem[]; label: string; testid: string }) {
  return (
    <TableWrap label={label}><table className="data-table w-full" data-testid={testid}><thead><tr><th>Article</th><th>Status</th><th>Class</th><th>Delivery</th><th>Updated</th></tr></thead><tbody>
      {rows.map((a) => { const s = statusOf(a, a.latest_intent); return (
        <tr key={a.article_id} data-testid={`queue-${a.slug}`}>
          <td><Link className="text-gold-300 underline" href={`${ADMIN_BASE}/articles/${a.article_id}`}>{a.title}</Link><div className="text-xs text-mist">{a.slug} · r{a.revision_no}</div></td>
          <td><Badge tone={s.tone}>{s.label}</Badge></td><td>{a.classification === "highlighted" ? <Badge tone="warning">highlighted</Badge> : "normal"}</td>
          <td>{a.latest_intent ? <Badge tone={deliveryTone(a.latest_intent.delivery.state)}>{a.latest_intent.kind}: {deliveryLabel(a.latest_intent.delivery.state)}</Badge> : "—"}</td>
          <td className="whitespace-nowrap">{fmtTs(a.updated_at)}</td>
        </tr>); })}
    </tbody></table></TableWrap>
  );
}

export default async function ReviewQueuePage() {
  const r = await adminCtxForPage();
  if (!r.ok) return <Notice tone="warning" title="Admin access unavailable">Complete a fresh TOTP verification from your account.</Notice>;
  const list = await loadArticles(r.ctx);
  if (!list.ok) return <Failure f={list} what="read the review queue" />;
  const mapped = list.data.map((a) => ({ a, s: statusOf(a, a.latest_intent) }));
  const review = mapped.filter(({ s }) => s.key === "in_review").map((x) => x.a);
  const approval = review.filter((a) => a.classification === "highlighted");
  const ready = mapped.filter(({ a, s }) => s.key === "approved" || (s.key === "in_review" && a.classification === "normal")).map((x) => x.a);
  const delivery = mapped.filter(({ s }) => ["pending", "failed", "cancelled"].includes(s.key)).map((x) => x.a);
  return (
    <>
      <PageHeader title="Editorial Review Queue" eyebrow="Workflow" cap="implemented">Articles awaiting a decision, independent approval, publication or delivery attention. Open an article to act; the database decides what you may do.</PageHeader>
      <div className="space-y-4">
        <Panel title={`Awaiting review (${review.length})`}>{review.length ? <Table rows={review} label="Awaiting review" testid="queue-review" /> : <EmptyState title="Nothing awaiting review" />}</Panel>
        <Panel title={`Highlighted — needs independent approval (${approval.length})`}>{approval.length ? <Table rows={approval} label="Awaiting approval" testid="queue-approval" /> : <EmptyState title="No highlighted articles awaiting approval" />}</Panel>
        <Panel title={`Ready to publish (${ready.length})`}>{ready.length ? <Table rows={ready} label="Ready to publish" testid="queue-ready" /> : <EmptyState title="Nothing ready to publish" />}</Panel>
        <Panel title={`Delivery pending, failed or cancelled (${delivery.length})`}>{delivery.length ? <Table rows={delivery} label="Delivery attention" testid="queue-delivery" /> : <EmptyState title="No deliveries need attention" />}</Panel>
      </div>
    </>
  );
}
