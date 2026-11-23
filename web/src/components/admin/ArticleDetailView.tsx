"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ArticleDetail, RevisionRead, SnapshotOutput } from "@/lib/admin/cms/schemas";
import { diffLines, diffSnapshots } from "@/lib/admin/cms/diff";
import { cmsPost, describeError, type ApiError } from "./cms-client";
import { Markdown } from "./Markdown";
import { ADMIN_BASE } from "./Shell";
import { fmtTs, deliveryLabel, deliveryTone, shortId, statusOf } from "./status";
import { Badge, BTN_DANGER, BTN_GHOST, BTN_PRIMARY, ConfirmDialog, EmptyState, Field, FIELD, Modal, Mono, Notice, PageHeader, Panel, TableWrap, Tabs } from "./primitives";

type Tab = "overview" | "revisions" | "evidence" | "delivery";
type Flash = ReturnType<typeof describeError> | { tone: "success"; title: string; text: string };

/**
 * One idempotency key per intent. The key survives only while the outcome of the previous attempt is unknown (network / unavailable /
 * unknown_outcome) so a retry cannot apply twice; any definite answer retires it.
 */
function useIntentKeys(): { key: (scope: string) => string; drop: (scope: string) => void } {
  const m = useRef(new Map<string, string>());
  return {
    key: (scope) => { let k = m.current.get(scope); if (!k) { k = crypto.randomUUID(); m.current.set(scope, k); } return k; },
    drop: (scope) => { m.current.delete(scope); },
  };
}
const retire = (e: ApiError): boolean => !(e.kind === "unknown_outcome" || e.kind === "network" || e.kind === "unavailable");

export function ArticleDetailView({ detail, uid }: { detail: ArticleDetail; uid: string }) {
  const router = useRouter();
  const { key, drop } = useIntentKeys();
  const { article: a, permitted: p } = detail;
  const latest = [...detail.intents].sort((x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : 0))[0] ?? null;
  const st = statusOf(a, latest ? { intent_id: latest.intent_id, kind: latest.kind, generation: latest.generation, created_at: latest.created_at, delivery: latest.delivery } : null);
  const [tab, setTab] = useState<Tab>("overview");
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "return" | "reject" | "publish" | "unpublish" | "approve" | "submit">(null);
  const [note, setNote] = useState("");
  const [noteErr, setNoteErr] = useState<string | undefined>();

  const highlighted = a.snapshot.classification === "highlighted";
  const state = a.review_state;
  const published = a.published_revision_id !== null || state === "publish_pending" || state === "published";
  const can = {
    edit: p.edit && ["draft", "in_review", "approved", "rejected"].includes(state),
    submit: p.submit && (state === "draft" || state === "rejected"),
    review: p.review && state === "in_review",
    approve: p.approve && highlighted && state === "in_review",
    publish: p.publish && ((!highlighted && state === "in_review") || (highlighted && state === "approved")),
    unpublish: p.unpublish && published && (state as string) !== "unpublish_pending" && (state as string) !== "unpublished",
  };
  const whyNot = (what: keyof typeof can): string | null => {
    if (can[what]) return null;
    if (!p[what]) return "Your role or grants do not allow this for this article.";
    if (what === "approve") return !highlighted ? "Only highlighted content needs independent approval." : "Only a revision that is in review can be approved.";
    if (what === "publish") return highlighted ? "Highlighted content must be approved by another person first." : "Normal content is published directly from review.";
    if (what === "submit") return "Only a draft or rejected revision can be submitted.";
    if (what === "review") return "Only a revision in review can be returned or rejected.";
    if (what === "unpublish") return "Nothing is published for this article.";
    return "Not available in the current state.";
  };

  const run = async (action: string, body: Record<string, unknown>, scope: string, okText: string): Promise<boolean> => {
    setFlash(null); setBusy(action);
    const r = await cmsPost(action, { requestId: key(scope), ...body });
    setBusy(null);
    if (r.ok) { drop(scope); setFlash({ tone: "success", title: "Done", text: okText }); router.refresh(); return true; }
    if (retire(r.error)) drop(scope);
    setFlash(describeError(r.error));
    if (r.error.kind === "stale") router.refresh();
    return false;
  };
  // A fresh idempotency scope per (action,revision,generation-of-attempt): never shared between two different user intents.
  const scopeOf = (act: string): string => `${act}:${a.current_revision_id}:${a.generation}:${a.review_state}`;
  const base = { articleId: a.article_id, revisionId: a.current_revision_id };

  const closeDialog = (): void => { setDialog(null); setNote(""); setNoteErr(undefined); };
  const doReview = async (decision: "return" | "reject"): Promise<void> => {
    if (note.trim().length < 5) { setNoteErr("A note of at least 5 characters is required."); return; }
    const ok = await run("review", { ...base, decision, note: note.trim() }, scopeOf(`review-${decision}-${note.trim()}`), decision === "return" ? "Returned to the author for changes." : "Revision rejected.");
    if (ok) closeDialog();
  };

  const btn = (what: keyof typeof can, label: string, onClick: () => void, tid: string, kind: "primary" | "ghost" | "danger" = "ghost") => (
    <span key={tid} className="inline-flex flex-col">
      <button type="button" data-testid={tid} className={kind === "primary" ? BTN_PRIMARY : kind === "danger" ? BTN_DANGER : BTN_GHOST} disabled={!can[what] || busy !== null} aria-disabled={!can[what]} title={whyNot(what) ?? undefined} onClick={onClick}>{label}</button>
    </span>
  );

  return (
    <>
      <PageHeader title={a.snapshot.title} eyebrow="Articles / News" cap="implemented" actions={<>
        {can.edit ? <Link href={`${ADMIN_BASE}/articles/${a.article_id}/edit`} className={BTN_GHOST} data-testid="edit-link">Edit</Link> : <span className={`${BTN_GHOST} opacity-50`} aria-disabled title={p.edit ? "This revision is not editable in its current state." : "You do not hold news.draft.write for this article."}>Edit</span>}
        <Link href={`${ADMIN_BASE}/articles`} className={BTN_GHOST}>All articles</Link>
      </>}>
        <span className="flex flex-wrap items-center gap-2"><Badge tone={st.tone}><span data-testid="article-status">{st.label}</span></Badge><Badge tone={highlighted ? "warning" : "neutral"}>{highlighted ? "Highlighted" : "Normal"}</Badge><Mono>{a.slug}</Mono><span className="text-xs text-mist">r{a.revision_no} · generation {a.generation}</span></span>
      </PageHeader>

      {flash && <div className="mb-4" data-testid="action-flash"><Notice tone={flash.tone === "success" ? "success" : flash.tone} role={flash.tone === "success" ? "status" : "alert"} title={flash.title}>{flash.text}</Notice></div>}
      <div className="mb-4"><Notice tone={st.tone === "error" ? "error" : "info"} title="Status">{st.detail}</Notice></div>

      <Panel title="Workflow" className="mb-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Workflow actions">
          {btn("submit", "Submit for review", () => setDialog("submit"), "act-submit", "primary")}
          {btn("review", "Return for changes", () => { setNote(""); setDialog("return"); }, "act-return")}
          {btn("review", "Reject", () => { setNote(""); setDialog("reject"); }, "act-reject", "danger")}
          {btn("approve", "Approve highlighted content", () => setDialog("approve"), "act-approve", "primary")}
          {btn("publish", "Publish", () => setDialog("publish"), "act-publish", "primary")}
          {btn("unpublish", "Unpublish", () => setDialog("unpublish"), "act-unpublish", "danger")}
        </div>
        <ul className="mt-3 space-y-1 text-xs text-mist">
          <li>Buttons are enabled only when the database says you may act and the article is in the right state. The database re-checks everything.</li>
          {highlighted && <li>Highlighted content needs approval from someone other than its author or editors, bound to this exact revision.</li>}
          <li>Publishing records an intent; the article is public only after the delivery receipt shows <em>delivered</em>.</li>
        </ul>
      </Panel>

      <Tabs<Tab> label="Article sections" value={tab} onChange={setTab} tabs={[
        { id: "overview", label: "Overview" }, { id: "revisions", label: "Revisions", count: detail.revisions.length },
        { id: "evidence", label: "Review evidence", count: detail.reviews.length + detail.approvals.length }, { id: "delivery", label: "Delivery", count: detail.intents.length },
      ]}>
        {tab === "overview" && <Overview a={a} />}
        {tab === "revisions" && <Revisions detail={detail} uid={uid} />}
        {tab === "evidence" && <Evidence detail={detail} uid={uid} />}
        {tab === "delivery" && <Delivery detail={detail} />}
      </Tabs>

      <ConfirmDialog open={dialog === "submit"} title="Submit for review" onCancel={closeDialog} confirmLabel={busy === "submit" ? "Submitting…" : "Submit"} busy={busy !== null}
        onConfirm={async () => { if (await run("submit", base, scopeOf("submit"), "Submitted for review.")) closeDialog(); }}>
        Submit revision r{a.revision_no} for review. It becomes read-only until it is returned or rejected.
      </ConfirmDialog>
      <ConfirmDialog open={dialog === "approve"} title="Approve highlighted content" onCancel={closeDialog} confirmLabel={busy === "approve" ? "Approving…" : "Approve"} busy={busy !== null}
        onConfirm={async () => { if (await run("approve", base, scopeOf("approve"), "Approved. The approval is bound to this exact revision.")) closeDialog(); }}>
        Approve revision r{a.revision_no} of a highlighted article. The database refuses this if you wrote or edited it; approval is bound to this revision and its hash and is consumed by a publish.
      </ConfirmDialog>
      <ConfirmDialog open={dialog === "publish"} title="Publish" onCancel={closeDialog} confirmLabel={busy === "publish" ? "Publishing…" : "Request publish"} busy={busy !== null}
        onConfirm={async () => { if (await run("publish", base, scopeOf("publish"), "Publish intent recorded. The article becomes public when delivery completes.")) closeDialog(); }}>
        Record a publish intent for r{a.revision_no}. This does not make the article public by itself: the delivery worker applies it and returns a receipt.
      </ConfirmDialog>
      <ConfirmDialog open={dialog === "unpublish"} title="Unpublish" danger onCancel={closeDialog} confirmLabel={busy === "unpublish" ? "Unpublishing…" : "Request unpublish"} busy={busy !== null}
        onConfirm={async () => { if (await run("unpublish", { articleId: a.article_id }, scopeOf("unpublish"), "Unpublish intent recorded. The article is withdrawn when delivery completes.")) closeDialog(); }}>
        Record an unpublish intent. The article stays public until the delivery receipt arrives, then a tombstone replaces it.
      </ConfirmDialog>
      <Modal open={dialog === "return" || dialog === "reject"} onClose={closeDialog} title={dialog === "reject" ? "Reject revision" : "Return for changes"} footer={<>
        <button type="button" className={BTN_GHOST} onClick={closeDialog}>Cancel</button>
        <button type="button" data-testid="review-confirm" className={dialog === "reject" ? BTN_DANGER : BTN_PRIMARY} disabled={busy !== null} onClick={() => void doReview(dialog === "reject" ? "reject" : "return")}>{dialog === "reject" ? "Reject" : "Return"}</button>
      </>}>
        <Field label="Note to the author" hint="Required, 5–2000 characters. Stored with the review event." error={noteErr}>
          {(fp) => <textarea {...fp} data-testid="review-note" rows={4} className={FIELD} value={note} maxLength={2000} onChange={(e) => { setNote(e.target.value); setNoteErr(undefined); }} />}
        </Field>
      </Modal>
    </>
  );
}

function Overview({ a }: { a: ArticleDetail["article"] }) {
  const s = a.snapshot;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <Panel title="Content (private preview)">
        <p className="mb-3 text-parchment">{s.summary}</p>
        <div className="rounded-lg border border-ink-700 bg-ink-950/50 p-4" data-testid="article-body"><Markdown source={s.body_markdown} /></div>
      </Panel>
      <Panel title="Metadata">
        <dl className="space-y-2 text-sm">
          {([["Slug", a.slug], ["Byline", s.byline || "—"], ["Category", s.category || "—"], ["Tags", s.tags.length ? s.tags.join(", ") : "—"], ["Origin", a.origin], ["Created", fmtTs(a.created_at)], ["Revision hash", `${a.snapshot_hash.slice(0, 12)}…`]] as const).map(([k, v]) => <div key={k}><dt className="text-xs uppercase tracking-wide text-mist">{k}</dt><dd className="[overflow-wrap:anywhere]">{v}</dd></div>)}
          <div><dt className="text-xs uppercase tracking-wide text-mist">Related links</dt><dd>{s.related_links.length ? <ul className="list-disc pl-4">{s.related_links.map((l) => <li key={l}><a className="text-gold-300 underline" href={l} rel="noopener noreferrer nofollow" target="_blank">{l}</a></li>)}</ul> : "—"}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-mist">Images</dt><dd>{s.images.length ? `${s.images.length} registered asset(s)` : "—"}</dd></div>
        </dl>
      </Panel>
    </div>
  );
}

function Revisions({ detail, uid }: { detail: ArticleDetail; uid: string }) {
  const revs = [...detail.revisions].sort((x, y) => y.revision_no - x.revision_no);
  const [from, setFrom] = useState<string>(revs[1]?.revision_id ?? revs[0]?.revision_id ?? "");
  const [to, setTo] = useState<string>(revs[0]?.revision_id ?? "");
  const [snaps, setSnaps] = useState<Record<string, SnapshotOutput>>({ [detail.article.current_revision_id]: detail.article.snapshot });
  const [err, setErr] = useState<ApiError | null>(null);
  useEffect(() => {
    let alive = true;
    for (const id of [from, to]) {
      if (!id || snaps[id]) continue;
      void cmsPost<{ revision: RevisionRead }>("revision", { articleId: detail.article.article_id, revisionId: id }).then((r) => {
        if (!alive) return;
        if (r.ok) setSnaps((s) => ({ ...s, [id]: r.revision.snapshot })); else setErr(r.error);
      });
    }
    return () => { alive = false; };
  }, [from, to, snaps, detail.article.article_id]);
  const A = snaps[from], B = snaps[to];
  return (
    <div className="space-y-4">
      <Panel title="Immutable revision history">
        <TableWrap label="Revisions">
          <table className="data-table w-full" data-testid="revision-table">
            <thead><tr><th>Rev</th><th>Title</th><th>Created</th><th>By</th><th>Hash</th><th>Class</th></tr></thead>
            <tbody>{revs.map((r) => (
              <tr key={r.revision_id} data-testid={`rev-${r.revision_no}`}>
                <td>r{r.revision_no}{r.revision_id === detail.article.current_revision_id && <> <Badge tone="info">current</Badge></>}{r.revision_id === detail.article.published_revision_id && <> <Badge tone="success">published</Badge></>}</td>
                <td>{r.title}</td><td className="whitespace-nowrap">{fmtTs(r.created_at)}</td>
                <td><Mono>{r.created_by === uid ? "you" : shortId(r.created_by)}</Mono></td>
                <td><Mono>{r.snapshot_hash.slice(0, 10)}</Mono></td><td>{r.effective_classification === 1 ? "highlighted" : "normal"}</td>
              </tr>))}</tbody>
          </table>
        </TableWrap>
        <p className="mt-2 text-xs text-mist">Revisions are append-only: a saved revision can never be modified or deleted.</p>
      </Panel>
      {revs.length > 1 && (
        <Panel title="Compare revisions">
          <div className="mb-3 flex flex-wrap gap-3">
            <Field label="From">{(fp) => <select {...fp} className={FIELD} value={from} onChange={(e) => setFrom(e.target.value)}>{revs.map((r) => <option key={r.revision_id} value={r.revision_id}>r{r.revision_no}</option>)}</select>}</Field>
            <Field label="To">{(fp) => <select {...fp} className={FIELD} value={to} onChange={(e) => setTo(e.target.value)}>{revs.map((r) => <option key={r.revision_id} value={r.revision_id}>r{r.revision_no}</option>)}</select>}</Field>
          </div>
          {err && <Notice tone="warning" role="alert" title="Could not load a revision">{describeError(err).text}</Notice>}
          {A && B ? <Diff a={A} b={B} /> : !err && <p className="text-sm text-mist">Loading revisions…</p>}
        </Panel>
      )}
    </div>
  );
}

function Diff({ a, b }: { a: SnapshotOutput; b: SnapshotOutput }) {
  const fields = diffSnapshots(a, b).filter((f) => f.changed);
  const body = diffLines(a.body_markdown, b.body_markdown);
  const bodyChanged = body.some((l) => l.kind !== "same");
  if (!fields.length && !bodyChanged) return <p className="text-sm text-mist" data-testid="diff-none">No differences.</p>;
  return (
    <div className="space-y-3 text-sm" data-testid="diff">
      {fields.map((f) => <div key={f.field}><span className="text-xs uppercase tracking-wide text-mist">{f.label}</span><div className="grid gap-1 sm:grid-cols-2"><div className="rounded bg-danger/10 px-2 py-1 line-through [overflow-wrap:anywhere]">{f.before}</div><div className="rounded bg-success/10 px-2 py-1 [overflow-wrap:anywhere]">{f.after}</div></div></div>)}
      {bodyChanged && <div><span className="text-xs uppercase tracking-wide text-mist">Body</span>
        <pre className="max-h-80 overflow-auto rounded-lg border border-ink-700 bg-ink-950/60 p-3 font-mono text-xs">{body.map((l, i) => <div key={i} className={l.kind === "add" ? "bg-success/15" : l.kind === "del" ? "bg-danger/15 line-through" : "text-mist"}>{l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}{l.text}</div>)}</pre></div>}
    </div>
  );
}

function Evidence({ detail, uid }: { detail: ArticleDetail; uid: string }) {
  const rno = new Map(detail.revisions.map((r) => [r.revision_id, r.revision_no]));
  const who = (id: string): string => (id === uid ? "you" : shortId(id));
  const reviews = [...detail.reviews].sort((x, y) => (x.occurred_at < y.occurred_at ? 1 : -1));
  return (
    <div className="space-y-4">
      <Panel title="Review events">
        {reviews.length ? <TableWrap label="Review events"><table className="data-table w-full" data-testid="review-table"><thead><tr><th>When</th><th>Revision</th><th>Decision</th><th>By</th><th>Note</th></tr></thead><tbody>
          {reviews.map((e) => <tr key={e.event_id}><td className="whitespace-nowrap">{fmtTs(e.occurred_at)}</td><td>r{rno.get(e.revision_id) ?? "?"}</td><td><Badge tone={e.decision === "reject" ? "error" : e.decision === "return" ? "warning" : "info"}>{e.decision.replace("_", " ")}</Badge></td><td><Mono>{who(e.actor_id)}</Mono></td><td className="[overflow-wrap:anywhere]">{e.note || "—"}</td></tr>)}
        </tbody></table></TableWrap> : <EmptyState title="No review events yet">Submit, return, reject and approve events appear here with the revision hash they were bound to.</EmptyState>}
      </Panel>
      <Panel title="Independent approvals">
        {detail.approvals.length ? <TableWrap label="Approvals"><table className="data-table w-full" data-testid="approval-table"><thead><tr><th>When</th><th>Revision</th><th>Approver</th><th>Grant-bound</th><th>Consumed</th></tr></thead><tbody>
          {detail.approvals.map((x) => <tr key={x.approval_id}><td className="whitespace-nowrap">{fmtTs(x.approved_at)}</td><td>r{rno.get(x.revision_id) ?? "?"}</td><td><Mono>{who(x.approver_id)}</Mono></td><td>{x.grant_bound ? "yes" : "no"}</td><td>{x.consumed ? "yes (used by a publish)" : "no"}</td></tr>)}
        </tbody></table></TableWrap> : <EmptyState title="No approvals">Highlighted content needs another person’s approval of an exact revision.</EmptyState>}
      </Panel>
    </div>
  );
}

function Delivery({ detail }: { detail: ArticleDetail }) {
  const rno = new Map(detail.revisions.map((r) => [r.revision_id, r.revision_no]));
  const intents = [...detail.intents].sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
  return (
    <Panel title="Publication intents and delivery receipts">
      {intents.length ? <TableWrap label="Publication intents"><table className="data-table w-full" data-testid="intent-table"><thead><tr><th>Requested</th><th>Intent</th><th>Revision</th><th>Delivery</th><th>Attempts</th><th>Detail</th></tr></thead><tbody>
        {intents.map((i) => <tr key={i.intent_id} data-testid={`intent-${i.kind}`}><td className="whitespace-nowrap">{fmtTs(i.created_at)}</td><td>{i.kind}</td><td>{i.revision_id ? `r${rno.get(i.revision_id) ?? "?"}` : "—"}</td>
          <td><Badge tone={deliveryTone(i.delivery.state)}><span data-testid="delivery-state">{i.delivery.state}</span></Badge> <span className="text-xs text-mist">{deliveryLabel(i.delivery.state)}</span></td>
          <td>{i.delivery.attempt}</td><td className="text-xs text-mist">{i.delivery.applied_at ? `applied ${fmtTs(i.delivery.applied_at)}` : i.delivery.error_code ?? "—"}{i.delivery.compensation && " · compensation"}</td></tr>)}
      </tbody></table></TableWrap> : <EmptyState title="No publication intents">Publishing or unpublishing records an intent here. The status below each intent is the delivery worker’s real receipt state, never an assumption.</EmptyState>}
      <p className="mt-2 text-xs text-mist">When the delivery ledger is not installed (ADM-03C not present) the state shows <em>blocked</em>: nothing can become public.</p>
    </Panel>
  );
}
