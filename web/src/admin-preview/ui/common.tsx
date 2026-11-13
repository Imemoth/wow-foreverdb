"use client";
import Link from "next/link";
import { roleLabel } from "../domain/policy";
import { articleStatus, type Tone } from "../domain/selectors";
import type { Article, AuditEvent, Classification, PreviewState, RoleId } from "../domain/types";
import { BASE } from "./Shell";
import { Badge } from "./primitives";

export const StatusBadge = ({ s, a }: { s: PreviewState; a: Article }) => {
  const st = articleStatus(s, a);
  return <Badge tone={st.tone} title={st.detail}>{st.label}</Badge>;
};
export const ClassBadge = ({ c, floor }: { c: Classification; floor?: boolean }) =>
  c === "highlighted" ? <Badge tone="warning" title={floor ? "Highlighted earlier: V1 never lowers this" : "Needs independent revision-bound approval"}>High-impact{floor ? " (locked)" : ""}</Badge> : <Badge tone="neutral">Normal</Badge>;
export const RoleBadges = ({ roles }: { roles: RoleId[] }) => <span className="flex flex-wrap gap-1">{roles.map((r) => <Badge key={r} tone={r === "user" ? "neutral" : r === "owner" ? "warning" : "info"}>{roleLabel(r)}</Badge>)}</span>;
export const ResultBadge = ({ r }: { r: AuditEvent["result"] }) => (r === "success" ? <Badge tone="success">Success</Badge> : <Badge tone="error">Denied</Badge>);
export const toneOfRevisionState = (st: string): Tone => (st === "approved" ? "success" : st === "in_review" ? "warning" : st === "rejected" ? "error" : "neutral");

export const ArticleLink = ({ id, children }: { id: string; children: React.ReactNode }) => <Link href={`${BASE}/articles/${id}`}>{children}</Link>;
export const StaffLink = ({ id, children }: { id: string; children: React.ReactNode }) => <Link href={`${BASE}/staff/${id}`}>{children}</Link>;

export function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-col gap-0.5"><dt className="text-xs font-semibold uppercase tracking-wide text-mist">{label}</dt><dd className="min-w-0 break-words text-sm text-parchment">{children}</dd></div>;
}

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { mediaById } from "../domain/content";

/** Markdown preview. react-markdown renders to React elements (no raw-HTML injection) and sanitises link protocols. */
export function MarkdownView({ source }: { source: string }) {
  return <div className="prose-fdb"><ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown></div>;
}

const MEDIA_TONE: Record<string, string> = {
  gold: "from-gold-500/50 via-ink-800 to-ink-900", violet: "from-violet-500/50 via-ink-800 to-ink-900", teal: "from-kind-pool/40 via-ink-800 to-ink-900", grey: "from-ink-600 via-ink-800 to-ink-900",
};
/** CSS-only media tile: the preview never loads or stores a real image. */
export function MediaTile({ id, alt }: { id: string | null; alt?: string }) {
  const m = mediaById(id);
  if (!m) return <div className="rounded-lg border border-dashed border-ink-600 px-3 py-6 text-center text-xs text-mist">No cover media</div>;
  return (
    <figure className="overflow-hidden rounded-lg border border-ink-700">
      <div role="img" aria-label={alt || m.label} className={`flex h-28 items-center justify-center bg-gradient-to-br ${MEDIA_TONE[m.tone]}`}><span aria-hidden="true" className="text-3xl text-gold-300/80">◈</span></div>
      <figcaption className="space-y-0.5 px-3 py-2 text-xs">
        <span className="block text-parchment">{m.label}</span>
        <span className="block text-mist">{m.provenance}</span>
        <Badge tone={m.rightsVerified ? "success" : "error"}>{m.rightsVerified ? "Rights verified" : "Rights NOT verified"}</Badge>
      </figcaption>
    </figure>
  );
}
