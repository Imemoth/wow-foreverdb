"use client";
import Link from "next/link";
import { roleLabel } from "../domain/policy";
import type { PreviewAction } from "../domain/engine";
import { headOf, nameOf, requiredClass, sessionActive, sessionView } from "../domain/selectors";
import type { Outcome } from "../domain/types";
import { useAdmin } from "../state/AdminProvider";
import { BASE } from "./Shell";
import { ArticleLink, ClassBadge } from "./common";
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, Badge, EmptyState, Notice, PageHeader, Panel, TableWrap } from "./primitives";

function Hint({ o }: { o: Outcome }) {
  if (o.ok) return <Badge tone="success">You can act</Badge>;
  return <span className="block max-w-xs text-xs text-mist"><Badge tone={o.kind === "denied" || o.kind === "conflict" ? "error" : "neutral"}>{o.kind === "denied" || o.kind === "conflict" ? "Blocked for you" : "Not available"}</Badge> {o.message}</span>;
}

export function ReviewQueue() {
  const { state: s, dryRun, run } = useAdmin();
  const v = sessionView(s);
  const inReview = s.articles.filter((a) => headOf(s, a).state === "in_review");
  const ready = s.articles.filter((a) => { const h = headOf(s, a); return h.state === "approved" && a.publishedRevisionId !== h.id && a.delivery !== "publish_pending"; });
  const delivery = s.articles.filter((a) => a.delivery === "publish_pending" || a.delivery === "unpublish_pending" || a.delivery === "delivery_failed");
  const requests = s.requests.filter((r) => r.status === "pending");
  const approveAction = (articleId: string, revisionId: string): PreviewAction => ({ type: "article/approve", articleId, revisionId });

  return (
    <>
      <PageHeader title="Editorial Review Queue" eyebrow="Editorial" cap="simulated">
        Work that is waiting on someone. The “Blocked for you” hints are computed with a side-effect-free what-if of the same rules the buttons use, so you can see <em>why</em> you cannot act — for example, why an author cannot approve their own article.
      </PageHeader>
      {!sessionActive(v) && <div className="mb-4"><Notice tone="warning" title="Not signed in">Sign in to see which tasks are actionable for you.</Notice></div>}

      <div className="space-y-5">
        <Panel title={`In review (${inReview.length})`}>
          {inReview.length === 0 ? <EmptyState title="Nothing in review">Submitted revisions appear here. Highlighted articles need an independent approver.</EmptyState> : (
            <TableWrap label="In review"><table className="data-table" data-testid="queue-in-review"><thead><tr><th scope="col">Article</th><th scope="col">Class</th><th scope="col">Revision</th><th scope="col">Author</th><th scope="col">Your eligibility to approve</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead><tbody>
              {inReview.map((a) => { const h = headOf(s, a); return (
                <tr key={a.id}>
                  <td><ArticleLink id={a.id}>{h.snapshot.title}</ArticleLink><span className="block font-mono text-xs text-mist">{a.slug}</span></td>
                  <td><ClassBadge c={requiredClass(a, h)} /></td>
                  <td className="font-mono">r{h.no}</td>
                  <td className="text-xs">{nameOf(s, a.createdBy)}</td>
                  <td>{sessionActive(v) ? <Hint o={dryRun(approveAction(a.id, h.id))} /> : <span className="text-xs text-mist">—</span>}</td>
                  <td><Link className={`${BTN_GHOST} !min-h-8 !px-3 text-sm`} href={`${BASE}/articles/${a.id}`}>Open</Link></td>
                </tr>); })}
            </tbody></table></TableWrap>
          )}
        </Panel>

        <Panel title={`Approved — ready to publish (${ready.length})`}>
          {ready.length === 0 ? <EmptyState title="No approved revisions waiting">Approved head revisions that are not live appear here.</EmptyState> : (
            <TableWrap label="Ready to publish"><table className="data-table" data-testid="queue-ready"><thead><tr><th scope="col">Article</th><th scope="col">Class</th><th scope="col">Revision</th><th scope="col">Your eligibility to publish</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead><tbody>
              {ready.map((a) => { const h = headOf(s, a); return (
                <tr key={a.id}>
                  <td><ArticleLink id={a.id}>{h.snapshot.title}</ArticleLink><span className="block font-mono text-xs text-mist">{a.slug}</span></td>
                  <td><ClassBadge c={requiredClass(a, h)} /></td>
                  <td className="font-mono">r{h.no}</td>
                  <td>{sessionActive(v) ? <Hint o={dryRun({ type: "article/publish", articleId: a.id, revisionId: h.id })} /> : <span className="text-xs text-mist">—</span>}</td>
                  <td><Link className={`${BTN_GHOST} !min-h-8 !px-3 text-sm`} href={`${BASE}/articles/${a.id}`}>Open</Link></td>
                </tr>); })}
            </tbody></table></TableWrap>
          )}
        </Panel>

        <Panel title={`Simulated delivery (${delivery.length})`}>
          {delivery.length === 0 ? <EmptyState title="No deliveries pending">Publishing and unpublishing queue an intent first; the simulated worker then confirms it.</EmptyState> : (
            <ul className="divide-y divide-ink-700" data-testid="queue-delivery">
              {delivery.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="min-w-0 flex-1"><ArticleLink id={a.id}>{a.slug}</ArticleLink> <Badge tone={a.delivery === "delivery_failed" ? "error" : "warning"}>{a.delivery.replace("_", " ")}</Badge></span>
                  {a.delivery !== "delivery_failed" && <button type="button" className={`${BTN_PRIMARY} !min-h-8 text-sm`} onClick={() => run({ type: "delivery/receipt", articleId: a.id })}>Simulate receipt</button>}
                  {a.delivery !== "delivery_failed" && <button type="button" className={`${BTN_GHOST} !min-h-8 text-sm`} onClick={() => run({ type: "delivery/fail", articleId: a.id })}>Simulate failure</button>}
                  {a.delivery === "delivery_failed" && <button type="button" className={`${BTN_PRIMARY} !min-h-8 text-sm`} onClick={() => run({ type: "delivery/retry", articleId: a.id })}>Retry</button>}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={`Staff change requests (${requests.length})`} actions={<Link href={`${BASE}/staff`} className="text-sm">Staff & Roles →</Link>}>
          {requests.length === 0 ? <EmptyState title="No pending requests">Role and elevated-grant proposals awaiting an independent approver appear here.</EmptyState> : (
            <ul className="divide-y divide-ink-700">
              {requests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                  <span className="min-w-0 flex-1"><strong>{nameOf(s, r.proposerId)}</strong> proposes {r.kind === "role" ? <>role <Badge tone="info">{roleLabel(r.role)}</Badge></> : <>grant <code>{r.permission}</code> ({r.days} d)</>} for <strong>{nameOf(s, r.targetId)}</strong><span className="block text-xs text-mist">{r.reason}</span></span>
                  {sessionActive(v) && <Hint o={dryRun({ type: "staff/decideRequest", requestId: r.id, decision: "approve" })} />}
                  <button type="button" className={`${BTN_PRIMARY} !min-h-8 text-sm`} onClick={() => run({ type: "staff/decideRequest", requestId: r.id, decision: "approve" })}>Approve</button>
                  <button type="button" className={`${BTN_DANGER} !min-h-8 text-sm`} onClick={() => run({ type: "staff/decideRequest", requestId: r.id, decision: "reject" })}>Reject</button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
