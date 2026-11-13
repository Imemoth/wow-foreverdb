"use client";
import Link from "next/link";
import { useState } from "react";
import { diffLines, diffSnapshots } from "../domain/diff";
import type { PreviewAction } from "../domain/engine";
import { fmtTs, articleOf, articleStatus, canReadAudit, headOf, nameOf, publishedOf, requiredClass, revisionOf, revisionsOf, sessionActive, sessionView } from "../domain/selectors";
import type { Outcome, Revision } from "../domain/types";
import { useAdmin } from "../state/AdminProvider";
import { BASE } from "./Shell";
import { KV, MarkdownView, MediaTile, ResultBadge, ClassBadge, StatusBadge, StaffLink, toneOfRevisionState } from "./common";
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, Badge, ConfirmDialog, EmptyState, Field, FIELD, Mono, Modal, Notice, PageHeader, Panel, TableWrap, Tabs } from "./primitives";

type TabId = "overview" | "compare" | "revisions" | "approval" | "audit";

function Eligibility({ label, o }: { label: string; o: Outcome }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span aria-hidden="true" className={o.ok ? "text-conf-high" : o.kind === "denied" || o.kind === "conflict" ? "text-danger" : "text-mist"}>{o.ok ? "✓" : o.kind === "denied" || o.kind === "conflict" ? "✕" : "○"}</span>
      <span><strong className="text-parchment">{label}:</strong> <span className="text-mist">{o.ok ? "available to you now." : o.message}</span></span>
    </li>
  );
}

function DiffView({ before, after }: { before: Revision; after: Revision }) {
  const fields = diffSnapshots(before.snapshot, after.snapshot).filter((f) => f.field !== "body");
  const lines = diffLines(before.snapshot.body, after.snapshot.body);
  const changedFields = fields.filter((f) => f.changed);
  return (
    <div className="space-y-4" data-testid="diff-view">
      <TableWrap label="Metadata differences">
        <table className="data-table">
          <caption className="sr-only">Metadata differences between r{before.no} and r{after.no}</caption>
          <thead><tr><th scope="col">Field</th><th scope="col">r{before.no}</th><th scope="col">r{after.no}</th></tr></thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.field}>
                <th scope="row" className="!static !bg-transparent !normal-case !tracking-normal text-parchment">{f.label}</th>
                <td className={f.changed ? "text-danger" : "text-mist"}>{f.changed && <span aria-hidden="true">− </span>}{f.before}</td>
                <td className={f.changed ? "text-conf-high" : "text-mist"}>{f.changed && <span aria-hidden="true">+ </span>}{f.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {changedFields.length === 0 && <p className="text-sm text-mist">No metadata differences.</p>}
      <div>
        <h3 className="mb-1 text-sm font-semibold text-gold-300">Body (Markdown)</h3>
        <pre className="max-h-96 overflow-auto rounded-lg border border-ink-700 bg-ink-950/60 p-3 font-mono text-xs leading-relaxed" aria-label={`Body diff between r${before.no} and r${after.no}`}>
          {lines.map((l, i) => (
            <span key={i} className={`block whitespace-pre-wrap ${l.kind === "add" ? "bg-conf-high/10 text-conf-high" : l.kind === "del" ? "bg-danger/10 text-danger" : "text-mist"}`}>
              <span aria-hidden="true">{l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}</span>
              {l.kind !== "same" && <span className="sr-only">{l.kind === "add" ? "Added: " : "Removed: "}</span>}
              {l.text || " "}
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}

export function ArticleDetail({ articleId }: { articleId: string }) {
  const { state: s, run, dryRun } = useAdmin();
  const art = articleOf(s, articleId);
  const [tab, setTab] = useState<TabId>("overview");
  const [reasonFor, setReasonFor] = useState<"return" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [reasonErr, setReasonErr] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<null | "publish" | "unpublish">(null);
  const [viewRev, setViewRev] = useState<string | null>(null);
  const [cmpA, setCmpA] = useState<string>("");
  const [cmpB, setCmpB] = useState<string>("");
  const v = sessionView(s);

  if (!art) return <EmptyState title="Article not found" action={<Link href={`${BASE}/articles`} className={BTN_GHOST}>Back to articles</Link>}>This article does not exist in the current preview session.</EmptyState>;
  const head = headOf(s, art);
  const live = publishedOf(s, art);
  const revs = revisionsOf(s, art.id);
  const status = articleStatus(s, art);
  const cls = requiredClass(art, head);
  const approvalFor = s.approvals.filter((a) => a.articleId === art.id);
  const intents = s.intents.filter((i) => i.articleId === art.id);
  const pending = art.delivery === "publish_pending" || art.delivery === "unpublish_pending" || art.delivery === "delivery_failed";

  const a = {
    submit: { type: "article/submit", articleId: art.id, revisionId: head.id } as PreviewAction,
    approve: { type: "article/approve", articleId: art.id, revisionId: head.id } as PreviewAction,
    publish: { type: "article/publish", articleId: art.id, revisionId: head.id } as PreviewAction,
    unpublish: { type: "article/unpublish", articleId: art.id } as PreviewAction,
    review: (d: "return" | "reject"): PreviewAction => ({ type: "article/review", articleId: art.id, revisionId: head.id, decision: d, reason: "preview eligibility check" }),
  };
  const canSubmit = head.state === "draft";
  const canReview = head.state === "in_review";
  const canPublish = head.state === "approved" && art.delivery !== "publish_pending" && art.delivery !== "unpublish_pending" && live?.id !== head.id;
  const canUnpublish = art.delivery === "published";

  const submitReason = (): void => {
    if (!reasonFor) return;
    const o = run({ type: "article/review", articleId: art.id, revisionId: head.id, decision: reasonFor, reason }, { quiet: false });
    if (o.ok) { setReasonFor(null); setReason(""); setReasonErr(undefined); }
    else setReasonErr(o.fieldErrors?.reason ?? (o.kind === "denied" ? o.message : undefined));
  };

  const compareDefaults = ((): [string, string] => (live && live.id !== head.id ? [live.id, head.id] : revs.length > 1 ? [revs[revs.length - 2]!.id, head.id] : [head.id, head.id]))();
  const aId = cmpA || compareDefaults[0], bId = cmpB || compareDefaults[1];
  const ra = revisionOf(s, aId)!, rb = revisionOf(s, bId)!;
  const auditEvents = s.audit.filter((e) => e.targetType === "article" && (e.targetLabel === art.slug || e.targetLabel.startsWith(`${art.slug} ·`)) && canReadAudit(s, e)).slice().reverse();

  return (
    <>
      <PageHeader
        title={head.snapshot.title || art.slug} eyebrow={`Articles / News · /news/${art.slug}`} cap="simulated"
        actions={<><Link href={`${BASE}/articles/${art.id}/edit`} className={BTN_GHOST} data-testid="edit-article">Edit (new revision)</Link><Link href={`${BASE}/articles`} className={BTN_GHOST}>All articles</Link></>}
      >
        <span className="flex flex-wrap items-center gap-2"><StatusBadge s={s} a={art} /><ClassBadge c={cls} floor={art.classificationFloor === "highlighted" && !head.snapshot.featured && head.snapshot.classification === "normal"} /><Badge tone={toneOfRevisionState(head.state)}>Head r{head.no}: {head.state.replace("_", " ")}</Badge>{live && <Badge tone="success">Live r{live.no}</Badge>}</span>
        <span className="mt-2 block text-xs">{status.detail}</span>
      </PageHeader>

      <Panel title="Workflow" className="mb-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Workflow actions">
          <button type="button" className={BTN_PRIMARY} disabled={!canSubmit} onClick={() => run(a.submit)} data-testid="act-submit">Submit for review</button>
          <button type="button" className={BTN_PRIMARY} disabled={!canReview} onClick={() => run(a.approve)} data-testid="act-approve">{cls === "highlighted" ? "Approve (independent)" : "Validate & approve"}</button>
          <button type="button" className={BTN_GHOST} disabled={!canReview} onClick={() => { setReasonFor("return"); setReason(""); setReasonErr(undefined); }} data-testid="act-return">Return to draft…</button>
          <button type="button" className={BTN_DANGER} disabled={!canReview} onClick={() => { setReasonFor("reject"); setReason(""); setReasonErr(undefined); }} data-testid="act-reject">Reject…</button>
          <button type="button" className={BTN_PRIMARY} disabled={!canPublish} onClick={() => setConfirm("publish")} data-testid="act-publish">Publish (simulated)…</button>
          <button type="button" className={BTN_DANGER} disabled={!canUnpublish} onClick={() => setConfirm("unpublish")} data-testid="act-unpublish">Unpublish (simulated)…</button>
        </div>
        <p className="mt-2 text-xs text-mist">Buttons reflect the article&apos;s state. Permissions are checked when you act: a denial is shown and recorded as a preview-only audit event. Publication is <strong>simulated</strong> — no live content or public-read database is ever written.</p>
        {sessionActive(v) && (
          <details className="mt-3 rounded-lg border border-ink-700 p-3" open>
            <summary className="cursor-pointer text-sm font-semibold text-gold-300">What can {v.persona?.name} do with this revision?</summary>
            <ul className="mt-2 space-y-1.5" data-testid="eligibility">
              <Eligibility label="Submit" o={dryRun(a.submit)} />
              <Eligibility label="Approve" o={dryRun(a.approve)} />
              <Eligibility label="Publish" o={dryRun(a.publish)} />
              <Eligibility label="Unpublish" o={dryRun(a.unpublish)} />
            </ul>
          </details>
        )}
        {pending && (
          <div className="mt-4 rounded-lg border border-conf-medium/50 bg-conf-medium/5 p-3" data-testid="delivery-sim">
            <p className="text-sm font-semibold text-conf-medium">▲ Simulated delivery worker</p>
            <p className="mb-2 text-xs text-mist">In the approved design a separate worker with no staff privilege commits the public pointer and issues a receipt. Nothing is public (or removed) until then. The worker re-checks that the acting staff member is still authorized before dispatch.</p>
            <div className="flex flex-wrap gap-2">
              {art.delivery !== "delivery_failed" && <button type="button" className={BTN_PRIMARY} onClick={() => run({ type: "delivery/receipt", articleId: art.id })} data-testid="sim-receipt">Simulate delivery receipt</button>}
              {art.delivery !== "delivery_failed" && <button type="button" className={BTN_GHOST} onClick={() => run({ type: "delivery/fail", articleId: art.id })} data-testid="sim-fail">Simulate delivery failure</button>}
              {art.delivery === "delivery_failed" && <button type="button" className={BTN_PRIMARY} onClick={() => run({ type: "delivery/retry", articleId: art.id })} data-testid="sim-retry">Retry delivery (same intent)</button>}
            </div>
          </div>
        )}
      </Panel>

      <Tabs<TabId> label="Article sections" value={tab} onChange={setTab} tabs={[{ id: "overview", label: "Overview" }, { id: "compare", label: "Working vs published" }, { id: "revisions", label: "Revisions", count: revs.length }, { id: "approval", label: "Approval & independence" }, { id: "audit", label: "Audit", count: auditEvents.length }]}>
      <div>
        {tab === "overview" && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <Panel title={`Head revision r${head.no} — private preview`}>
              <h2 className="sr-only">Preview</h2>
              <p className="mb-3 text-parchment/90">{head.snapshot.summary}</p>
              <MarkdownView source={head.snapshot.body} />
            </Panel>
            <div className="space-y-4">
              <Panel title="Metadata"><dl className="space-y-2">
                <KV label="Slug">/news/{art.slug} <span className="text-xs text-mist">(permanent)</span></KV>
                <KV label="Category">{head.snapshot.category}</KV>
                <KV label="Tags">{head.snapshot.tags.length ? head.snapshot.tags.map((t) => <Mono key={t}>{t}</Mono>) : "—"}</KV>
                <KV label="Byline">{head.snapshot.byline}</KV>
                <KV label="Featured">{head.snapshot.featured ? "Yes" : "No"}</KV>
                <KV label="Floor">{art.classificationFloor === "highlighted" ? "High-impact (locked)" : "Normal"}</KV>
                <KV label="Snapshot hash"><Mono>{head.hash.slice(0, 16)}…</Mono></KV>
                <KV label="SEO">{head.snapshot.seoDescription || "—"}</KV>
              </dl></Panel>
              <Panel title="Cover"><MediaTile id={head.snapshot.coverMediaId} alt={head.snapshot.coverAlt} /></Panel>
            </div>
          </div>
        )}

        {tab === "compare" && (
          <Panel title="Compare revisions">
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-mist">From<select className={`${FIELD} mt-1 w-full`} value={aId} onChange={(e) => setCmpA(e.target.value)}>{revs.map((r) => <option key={r.id} value={r.id}>r{r.no}{r.id === art.publishedRevisionId ? " (published)" : ""}{r.id === head.id ? " (working head)" : ""}</option>)}</select></label>
              <label className="text-xs text-mist">To<select className={`${FIELD} mt-1 w-full`} value={bId} onChange={(e) => setCmpB(e.target.value)}>{revs.map((r) => <option key={r.id} value={r.id}>r{r.no}{r.id === art.publishedRevisionId ? " (published)" : ""}{r.id === head.id ? " (working head)" : ""}</option>)}</select></label>
            </div>
            {live && live.id !== head.id && aId === live.id && bId === head.id && <p className="mb-3"><Notice tone="info" title={`Working revision r${head.no} vs published revision r${live.no}`}>The public site shows r{live.no}. r{head.no} is private until it is reviewed, approved where required, and delivered.</Notice></p>}
            {ra.id === rb.id ? <p className="text-sm text-mist">Pick two different revisions to compare.</p> : <DiffView before={ra} after={rb} />}
          </Panel>
        )}

        {tab === "revisions" && (
          <Panel title="Immutable revision history">
            <p className="mb-3 text-xs text-mist">Every public-output-affecting edit makes a new revision. Snapshots never change after creation; only the review state moves. Rollback means copying an old snapshot into a <em>new</em> head revision that needs fresh approval.</p>
            <TableWrap label="Revisions">
              <table className="data-table" data-testid="revisions-table">
                <caption className="sr-only">Revision history</caption>
                <thead><tr><th scope="col">Rev</th><th scope="col">State</th><th scope="col">Created by</th><th scope="col">Created</th><th scope="col">Hash</th><th scope="col">Notes</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {revs.slice().reverse().map((r) => (
                    <tr key={r.id}>
                      <td className="font-mono">r{r.no}</td>
                      <td><span className="flex flex-wrap gap-1"><Badge tone={toneOfRevisionState(r.state)}>{r.state.replace("_", " ")}</Badge>{r.id === head.id && <Badge tone="info">Head</Badge>}{r.id === art.publishedRevisionId && <Badge tone="success">Live</Badge>}</span></td>
                      <td className="text-xs">{nameOf(s, r.createdBy)}</td>
                      <td className="whitespace-nowrap text-xs">{fmtTs(r.createdAt)}</td>
                      <td><Mono>{r.hash.slice(0, 10)}</Mono></td>
                      <td className="max-w-56 text-xs text-mist">{r.note ?? (r.restoredFromRevisionId ? `Restored from r${revisionOf(s, r.restoredFromRevisionId)?.no}` : "—")}</td>
                      <td className="whitespace-nowrap"><span className="flex gap-1">
                        <button type="button" className={`${BTN_GHOST} !min-h-8 !px-2 text-xs`} onClick={() => setViewRev(r.id)}>View</button>
                        {r.id !== head.id && <button type="button" className={`${BTN_GHOST} !min-h-8 !px-2 text-xs`} onClick={() => run({ type: "article/restore", articleId: art.id, fromRevisionId: r.id })} data-testid={`restore-r${r.no}`}>Restore as new draft</button>}
                      </span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Panel>
        )}

        {tab === "approval" && (
          <div className="space-y-4">
            <Panel title="Classification and approval rule">
              {cls === "highlighted"
                ? <Notice tone="warning" title="High-impact: independent, revision-bound approval required">Another currently eligible person (Administrator/Owner, or an Editor with a specific grant) must approve <em>this exact revision</em>. The author and any substantive editor cannot — including when they hold Owner. The approval authorizes one publication and is void if the revision changes.</Notice>
                : <Notice tone="info" title="Normal article">Needs validation and an authorized publisher. No second person is required by ADR-020.</Notice>}
              <p className="mt-3 text-xs text-mist">Classification floor: <strong className="text-parchment">{art.classificationFloor}</strong>. V1 never lowers a floor through an ordinary edit (ADM-03A).</p>
            </Panel>
            <Panel title="Authors and substantive editors (server-recorded)">
              <p className="mb-2 text-xs text-mist">Fail-closed V1: every content or metadata change counts as substantive. None of these people can give independent approval.</p>
              <TableWrap label="Contributors"><table className="data-table"><thead><tr><th scope="col">Person</th><th scope="col">Role in article</th><th scope="col">Revision</th></tr></thead><tbody>
                {art.contributors.map((c, i) => <tr key={i}><td><StaffLink id={c.actorId}>{nameOf(s, c.actorId)}</StaffLink></td><td>{c.kind === "author" ? "Author" : "Editor"}</td><td className="font-mono">r{revisionOf(s, c.revisionId)?.no}</td></tr>)}
              </tbody></table></TableWrap>
            </Panel>
            <Panel title="Approvals">
              {approvalFor.length === 0 ? <p className="text-sm text-mist">No independent approvals recorded.</p> : (
                <TableWrap label="Approvals"><table className="data-table"><thead><tr><th scope="col">Approval</th><th scope="col">Revision</th><th scope="col">Approver</th><th scope="col">Bound hash</th><th scope="col">Consumed</th></tr></thead><tbody>
                  {approvalFor.map((p) => <tr key={p.id}><td className="font-mono text-xs">{p.id}</td><td className="font-mono">r{revisionOf(s, p.revisionId)?.no}{p.revisionId !== head.id && <span className="ml-1 text-xs text-mist">(superseded)</span>}</td><td>{nameOf(s, p.approverId)}</td><td><Mono>{p.hash.slice(0, 10)}</Mono></td><td>{s.approvalUses.some((u) => u.approvalId === p.id) ? <Badge tone="neutral">Used once</Badge> : <Badge tone="success">Unused</Badge>}</td></tr>)}
                </tbody></table></TableWrap>
              )}
            </Panel>
            <Panel title="Publication intents (outbox)">
              {intents.length === 0 ? <p className="text-sm text-mist">No publication intents.</p> : (
                <TableWrap label="Publication intents"><table className="data-table"><thead><tr><th scope="col">Intent</th><th scope="col">Generation</th><th scope="col">Action</th><th scope="col">Revision</th><th scope="col">By</th><th scope="col">Status</th></tr></thead><tbody>
                  {intents.map((i) => <tr key={i.id}><td className="font-mono text-xs">{i.id}</td><td className="font-mono">{i.generation}</td><td>{i.action}</td><td className="font-mono">r{revisionOf(s, i.revisionId)?.no}</td><td>{nameOf(s, i.actorId)}</td><td><Badge tone={i.status === "delivered" ? "success" : i.status === "pending" ? "warning" : "error"}>{i.status}</Badge></td></tr>)}
                </tbody></table></TableWrap>
              )}
            </Panel>
          </div>
        )}

        {tab === "audit" && (
          <Panel title="Audit events for this article">
            {auditEvents.length === 0 ? <p className="text-sm text-mist">No visible events. Reading editorial audit needs <code>audit.editorial.read</code> (Editors only with a grant).</p> : (
              <TableWrap label="Article audit"><table className="data-table"><thead><tr><th scope="col">When</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead><tbody>
                {auditEvents.map((e) => <tr key={e.id}><td className="whitespace-nowrap text-xs">{fmtTs(e.at)}</td><td className="text-xs">{e.actorName}</td><td className="font-mono text-xs text-gold-300">{e.action}</td><td><ResultBadge r={e.result} /></td><td className="max-w-md text-xs text-mist">{e.reason ?? "—"}</td></tr>)}
              </tbody></table></TableWrap>
            )}
          </Panel>
        )}
      </div>
      </Tabs>

      <Modal open={reasonFor !== null} onClose={() => setReasonFor(null)} title={reasonFor === "reject" ? `Reject r${head.no}` : `Return r${head.no} to draft`}
        footer={<><button type="button" className={BTN_GHOST} onClick={() => setReasonFor(null)}>Cancel</button><button type="button" className={reasonFor === "reject" ? BTN_DANGER : BTN_PRIMARY} onClick={submitReason} data-testid="reason-confirm">{reasonFor === "reject" ? "Reject revision" : "Return to draft"}</button></>}>
        <Field label="Reason (recorded in the audit log)" error={reasonErr}>{(p) => <textarea {...p} rows={3} className={FIELD} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />}</Field>
      </Modal>

      <ConfirmDialog open={confirm === "publish"} title={`Publish r${head.no} (simulated)`} confirmLabel="Queue publication" onCancel={() => setConfirm(null)} onConfirm={() => { run(a.publish); setConfirm(null); }}>
        <p>This commits a <strong>publication intent</strong> with its audit record and outbox entry. It is a <strong>simulation</strong>: no live AzerDex content and no public-read database is written.</p>
        {cls === "highlighted" && <p className="mt-2 text-conf-medium">▲ High-impact: the independent approval for r{head.no} will be rechecked and consumed.</p>}
        <p className="mt-2 text-mist">Critical action — requires TOTP verified within 15 minutes.</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirm === "unpublish"} title="Unpublish (simulated)" danger confirmLabel="Queue unpublish" onCancel={() => setConfirm(null)} onConfirm={() => { run(a.unpublish); setConfirm(null); }}>
        <p>This queues removal of the live revision. The article stays public until the simulated delivery receipt. Private revision history is retained.</p>
      </ConfirmDialog>
      <Modal open={viewRev !== null} onClose={() => setViewRev(null)} title={viewRev ? `Revision r${revisionOf(s, viewRev)?.no} (read-only)` : ""} wide>
        {viewRev && (() => { const r = revisionOf(s, viewRev)!; return <><p className="mb-2 text-xs text-mist">{nameOf(s, r.createdBy)} · {fmtTs(r.createdAt)} · <Mono>{r.hash.slice(0, 16)}</Mono></p><h3 className="panel-title mb-2 text-base">{r.snapshot.title}</h3><MarkdownView source={r.snapshot.body} /></>; })()}
      </Modal>
    </>
  );
}
