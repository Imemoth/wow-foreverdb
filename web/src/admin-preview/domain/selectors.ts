import { FRESHNESS_MS, holdsAnywhere, permissionSources } from "./policy";
import { effectiveClassification } from "./content";
import type { Article, AuditEvent, Classification, PermissionId, PreviewState, Revision, SessionStatus, StaffMember } from "./types";

export type EffectiveSession = SessionStatus | "mfa_stale";
export interface SessionView { status: EffectiveSession; persona: StaffMember | undefined; verifiedAgeMs: number | null; freshUntil: number | null }

/** `mfa_stale` is derived, never stored: AAL2 is still valid but critical actions need a fresh (<= 15 min) TOTP proof. */
export function sessionView(s: PreviewState): SessionView {
  const persona = s.staff.find((x) => x.id === s.session.personaId);
  const age = s.session.mfaVerifiedAt === null ? null : s.now - s.session.mfaVerifiedAt;
  const stale = s.session.status === "mfa_verified" && age !== null && age > FRESHNESS_MS;
  return { status: stale ? "mfa_stale" : s.session.status, persona, verifiedAgeMs: age, freshUntil: s.session.mfaVerifiedAt === null ? null : s.session.mfaVerifiedAt + FRESHNESS_MS };
}
export const sessionActive = (v: SessionView): boolean => v.status === "mfa_verified" || v.status === "mfa_stale";

export const articleOf = (s: PreviewState, id: string): Article | undefined => s.articles.find((a) => a.id === id);
export const staffOf = (s: PreviewState, id: string | null): StaffMember | undefined => s.staff.find((x) => x.id === id);
export const nameOf = (s: PreviewState, id: string | null): string => (id ? staffOf(s, id)?.name ?? id : "—");
export const revisionsOf = (s: PreviewState, articleId: string): Revision[] => s.revisions.filter((r) => r.articleId === articleId).sort((a, b) => a.no - b.no);
export const revisionOf = (s: PreviewState, id: string | null): Revision | undefined => (id ? s.revisions.find((r) => r.id === id) : undefined);
export const headOf = (s: PreviewState, a: Article): Revision => revisionOf(s, a.currentRevisionId)!;
export const publishedOf = (s: PreviewState, a: Article): Revision | undefined => revisionOf(s, a.publishedRevisionId);
export const requiredClass = (a: Article, r: Revision): Classification => (a.classificationFloor === "highlighted" ? "highlighted" : effectiveClassification(r.snapshot));

export type Tone = "success" | "warning" | "error" | "info" | "neutral";
export function articleStatus(s: PreviewState, a: Article): { label: string; tone: Tone; detail: string } {
  const head = headOf(s, a);
  const live = a.publishedRevisionId !== null;
  if (a.delivery === "publish_pending") return { label: "Publish pending", tone: "warning", detail: "Committed intent; waiting for the (simulated) delivery receipt. The previous public state stays live." };
  if (a.delivery === "unpublish_pending") return { label: "Unpublish pending", tone: "warning", detail: "Waiting for the (simulated) delivery receipt. The article is still public until then." };
  if (a.delivery === "delivery_failed") return { label: "Delivery failed", tone: "error", detail: "The previous public state is unchanged. Retry delivery; no new authorization is needed." };
  if (live && head.id !== a.publishedRevisionId) return { label: "Published · newer draft", tone: "info", detail: `r${revisionOf(s, a.publishedRevisionId)!.no} is live; r${head.no} is a private working revision.` };
  if (live) return { label: "Published", tone: "success", detail: "The live revision is the head revision." };
  if (a.delivery === "unpublished") return { label: "Unpublished", tone: "neutral", detail: "Removed from public output. Private history is retained." };
  const map: Record<Revision["state"], { label: string; tone: Tone }> = {
    draft: { label: "Draft", tone: "neutral" }, in_review: { label: "In review", tone: "warning" }, approved: { label: "Approved · unpublished", tone: "success" },
    rejected: { label: "Rejected", tone: "error" }, superseded: { label: "Superseded", tone: "neutral" },
  };
  return { ...map[head.state], detail: `Head revision r${head.no}.` };
}

export const can = (s: PreviewState, perm: PermissionId, articleId?: string): boolean => {
  const v = sessionView(s);
  if (!sessionActive(v)) return false;
  return articleId ? permissionSources(v.persona, s.grants, s.now, perm, articleId).length > 0 : holdsAnywhere(v.persona, s.grants, s.now, perm);
};

export const canReadAudit = (s: PreviewState, e: AuditEvent): boolean => (e.category === "editorial" ? can(s, "audit.editorial.read") : can(s, "audit.staff.read"));

export function countByStatus(s: PreviewState) {
  let drafts = 0, awaiting = 0, published = 0, approvedReady = 0, pendingDelivery = 0;
  for (const a of s.articles) {
    const h = headOf(s, a);
    if (h.state === "draft" || h.state === "rejected") drafts++;
    if (h.state === "in_review") awaiting++;
    if (h.state === "approved" && a.publishedRevisionId !== h.id) approvedReady++;
    if (a.publishedRevisionId) published++;
    if (a.delivery === "publish_pending" || a.delivery === "unpublish_pending" || a.delivery === "delivery_failed") pendingDelivery++;
  }
  return { drafts, awaiting, published, approvedReady, pendingDelivery, pendingRequests: s.requests.filter((r) => r.status === "pending").length };
}

export const fmtTs = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
export const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const fmtAge = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d`;
};
