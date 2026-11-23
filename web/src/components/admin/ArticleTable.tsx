"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import type { ListItem } from "@/lib/admin/cms/schemas";
import { Badge, BTN_GHOST, BTN_PRIMARY, EmptyState, FIELD, TableWrap } from "./primitives";
import { fmtTs, shortId, statusOf, type StatusInfo } from "./status";
import { ADMIN_BASE } from "./Shell";

export const STATUS_FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "All statuses" }, { id: "draft", label: "Draft" }, { id: "in_review", label: "In review" }, { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" }, { id: "published", label: "Published (live)" }, { id: "pending", label: "Delivery pending" }, { id: "failed", label: "Delivery failed" },
  { id: "cancelled", label: "Cancelled / superseded" }, { id: "unpublished", label: "Unpublished" },
];

export function ArticleTable({ items, canCreate }: { items: ListItem[]; canCreate: boolean }) {
  const q0 = useSearchParams();
  const initial = STATUS_FILTERS.some((f) => f.id === q0.get("status")) ? q0.get("status")! : "all";
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(initial);
  const [cls, setCls] = useState("all");
  const needle = q.trim().toLowerCase();
  const rows = items
    .map((a) => ({ a, s: statusOf(a, a.latest_intent) as StatusInfo }))
    .filter(({ a, s }) => (status === "all" || s.key === status)
      && (cls === "all" || a.classification === cls)
      && (!needle || `${a.title} ${a.slug}`.toLowerCase().includes(needle)));
  const reset = (): void => { setQ(""); setStatus("all"); setCls("all"); };
  return (
    <>
      <form role="search" aria-label="Filter articles" onSubmit={(e) => e.preventDefault()} className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_auto]">
        <label className="block text-xs text-mist">Search<input type="search" className={`${FIELD} mt-1`} placeholder="Title or slug" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <label className="block text-xs text-mist">Status<select className={`${FIELD} mt-1`} value={status} onChange={(e) => setStatus(e.target.value)}>{STATUS_FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label>
        <label className="block text-xs text-mist">Classification<select className={`${FIELD} mt-1`} value={cls} onChange={(e) => setCls(e.target.value)}><option value="all">All</option><option value="normal">Normal</option><option value="highlighted">Highlighted</option></select></label>
        <div className="flex items-end"><button type="button" className={BTN_GHOST} onClick={reset}>Clear</button></div>
      </form>
      <p role="status" aria-live="polite" className="mb-2 text-xs text-mist" data-testid="article-count">{rows.length} of {items.length} articles</p>
      {items.length === 0 ? (
        <EmptyState title="No articles yet" action={canCreate ? <Link href={`${ADMIN_BASE}/articles/new`} className={BTN_PRIMARY}>Create the first draft</Link> : undefined}>Articles you are authorized to read appear here. Everything on this page is read from the real CMS database.</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState title="No articles match" action={<button type="button" className={BTN_GHOST} onClick={reset}>Clear filters</button>}>Try a different search or status.</EmptyState>
      ) : (
        <TableWrap label="Articles">
          <table className="data-table" data-testid="article-table">
            <caption className="sr-only">CMS articles</caption>
            <thead><tr><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Classification</th><th scope="col">Head</th><th scope="col">Author</th><th scope="col">Updated</th></tr></thead>
            <tbody>
              {rows.map(({ a, s }) => (
                <tr key={a.article_id} data-testid={`article-row-${a.slug}`}>
                  <td className="min-w-64"><Link href={`${ADMIN_BASE}/articles/${a.article_id}`}>{a.title}</Link><span className="block font-mono text-xs text-mist">/news/{a.slug}</span></td>
                  <td><Badge tone={s.tone} title={s.detail}>{s.label}</Badge></td>
                  <td>{a.classification === "highlighted" || a.classification_floor === 1 ? <Badge tone="warning">Highlighted{a.classification === "normal" ? " (floor)" : ""}</Badge> : <Badge>Normal</Badge>}</td>
                  <td className="font-mono text-xs">r{a.revision_no}</td>
                  <td className="font-mono text-xs">{shortId(a.created_by)}</td>
                  <td className="whitespace-nowrap text-xs">{fmtTs(a.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </>
  );
}
