"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { CATEGORIES } from "../domain/content";
import { fmtDate, headOf, nameOf, requiredClass, sessionActive, sessionView, can } from "../domain/selectors";
import type { Article, PreviewState } from "../domain/types";
import { useAdmin } from "../state/AdminProvider";
import { BASE } from "./Shell";
import { ArticleLink, ClassBadge, StatusBadge } from "./common";
import { BTN_GHOST, BTN_PRIMARY, EmptyState, FIELD, Notice, PageHeader, TableWrap } from "./primitives";

export const FILTERS = [
  { id: "all", label: "All statuses" }, { id: "draft", label: "Draft / rejected" }, { id: "in_review", label: "In review" },
  { id: "approved", label: "Approved, not live" }, { id: "published", label: "Published (live)" }, { id: "unpublished", label: "Unpublished" }, { id: "pending_delivery", label: "Delivery pending / failed" },
] as const;

function matches(s: PreviewState, a: Article, f: string): boolean {
  const h = headOf(s, a);
  switch (f) {
    case "draft": return h.state === "draft" || h.state === "rejected";
    case "in_review": return h.state === "in_review";
    case "approved": return h.state === "approved" && a.publishedRevisionId !== h.id;
    case "published": return a.publishedRevisionId !== null;
    case "unpublished": return a.delivery === "unpublished";
    case "pending_delivery": return a.delivery === "publish_pending" || a.delivery === "unpublish_pending" || a.delivery === "delivery_failed";
    default: return true;
  }
}

export function ArticleList() {
  const { state: s } = useAdmin();
  const q0 = useSearchParams();
  const initial = FILTERS.some((f) => f.id === q0.get("status")) ? q0.get("status")! : "all";
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>(initial);
  const [cat, setCat] = useState("all");
  const [cls, setCls] = useState("all");
  const v = sessionView(s);
  const needle = q.trim().toLowerCase();
  const rows = s.articles
      .filter((a) => {
        const h = headOf(s, a);
        if (!matches(s, a, status)) return false;
        if (cat !== "all" && h.snapshot.category !== cat) return false;
        if (cls !== "all" && requiredClass(a, h) !== cls) return false;
        if (needle && !`${h.snapshot.title} ${a.slug} ${h.snapshot.tags.join(" ")}`.toLowerCase().includes(needle)) return false;
        return true;
      })
      .sort((x, y) => headOf(s, y).createdAt - headOf(s, x).createdAt);
  const canCreate = can(s, "news.draft.write");
  const canSee = can(s, "news.article.preview") || can(s, "news.article.review") || can(s, "news.article.publish") || can(s, "news.article.approve_highlighted") || can(s, "news.article.unpublish");
  const reset = (): void => { setQ(""); setStatus("all"); setCat("all"); setCls("all"); };

  return (
    <>
      <PageHeader
        title="Articles / News" eyebrow="Editorial" cap="simulated"
        actions={canCreate
          ? <Link href={`${BASE}/articles/new`} className={BTN_PRIMARY} data-testid="new-draft">New draft</Link>
          : <button type="button" className={BTN_PRIMARY} disabled aria-describedby="new-draft-why" data-testid="new-draft">New draft</button>}
      >
        Manual News under the approved ADM-03A contract: stable article IDs, immutable revisions, independent revision-bound approvals. Git-managed and Collector articles are untouched and are not listed here.
      </PageHeader>
      {!canCreate && <p id="new-draft-why" className="mb-4 text-xs text-mist">{sessionActive(v) ? `New draft needs news.draft.write — ${v.persona?.name ?? "this account"} does not hold it.` : "Sign in to create a draft."}</p>}
      {sessionActive(v) && !canSee && <div className="mb-4"><Notice tone="warning" title="Limited view" role="status">{v.persona?.name} holds no editorial permission, so News is read-only context here. Moderators have no News authority (ADR-020).</Notice></div>}

      <form role="search" aria-label="Filter articles" className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]" onSubmit={(e) => e.preventDefault()}>
        <label className="block text-xs text-mist">Search<input type="search" className={`${FIELD} mt-1`} placeholder="Title, slug or tag" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <label className="block text-xs text-mist">Status<select className={`${FIELD} mt-1`} value={status} onChange={(e) => setStatus(e.target.value)}>{FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label>
        <label className="block text-xs text-mist">Category<select className={`${FIELD} mt-1`} value={cat} onChange={(e) => setCat(e.target.value)}><option value="all">All categories</option>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="block text-xs text-mist">Classification<select className={`${FIELD} mt-1`} value={cls} onChange={(e) => setCls(e.target.value)}><option value="all">All</option><option value="normal">Normal</option><option value="highlighted">Highlighted / high-impact</option></select></label>
        <div className="flex items-end"><button type="button" className={BTN_GHOST} onClick={reset}>Clear</button></div>
      </form>
      <p role="status" aria-live="polite" className="mb-2 text-xs text-mist" data-testid="article-count">{rows.length} of {s.articles.length} articles</p>

      {rows.length === 0 ? (
        <EmptyState title="No articles match" action={<button type="button" className={BTN_GHOST} onClick={reset}>Clear filters</button>}>Try a different search or status. Archived and unpublished articles keep their private history.</EmptyState>
      ) : (
        <TableWrap label="Articles">
          <table className="data-table">
            <caption className="sr-only">Manual News articles (synthetic)</caption>
            <thead><tr><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Classification</th><th scope="col">Head</th><th scope="col">Category</th><th scope="col">Author</th><th scope="col">Updated</th></tr></thead>
            <tbody>
              {rows.map((a) => {
                const h = headOf(s, a);
                return (
                  <tr key={a.id} data-testid={`article-row-${a.slug}`}>
                    <td className="min-w-64"><ArticleLink id={a.id}>{h.snapshot.title || "(untitled)"}</ArticleLink><span className="block font-mono text-xs text-mist">/news/{a.slug}</span></td>
                    <td><StatusBadge s={s} a={a} /></td>
                    <td><ClassBadge c={requiredClass(a, h)} floor={a.classificationFloor === "highlighted" && !h.snapshot.featured && h.snapshot.classification === "normal"} /></td>
                    <td className="font-mono text-xs">r{h.no}</td>
                    <td className="text-xs">{h.snapshot.category}</td>
                    <td className="text-xs">{nameOf(s, a.createdBy)}</td>
                    <td className="whitespace-nowrap text-xs">{fmtDate(h.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
    </>
  );
}
