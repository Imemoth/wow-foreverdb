/**
 * ADM-UI-PREVIEW-01 domain types. Everything here is SYNTHETIC preview state. Nothing in this folder talks to a network,
 * a database, Supabase Auth or the production Admin authorization layer.
 */

export type RoleId = "user" | "moderator" | "editor" | "administrator" | "owner";

export const PERMISSION_IDS = [
  "admin.enter",
  "news.draft.write",
  "news.article.preview",
  "news.article.submit",
  "news.article.review",
  "news.article.classify",
  "news.article.approve_highlighted",
  "news.article.publish",
  "news.article.unpublish",
  "news.media.manage",
  "news.media.validate",
  "moderation.case.read",
  "moderation.case.decide",
  "moderation.case.reverse",
  "staff.role.propose",
  "staff.grant.propose",
  "staff.role.approve",
  "staff.grant.approve",
  "staff.access.revoke",
  "audit.editorial.read",
  "audit.staff.read",
  "ops.status.read",
] as const;
export type PermissionId = (typeof PERMISSION_IDS)[number];

export type Classification = "normal" | "highlighted";
export type ReviewState = "draft" | "in_review" | "approved" | "rejected" | "superseded";
export type DeliveryState =
  | "never_published"
  | "publish_pending"
  | "published"
  | "unpublish_pending"
  | "unpublished"
  | "delivery_failed";

/** Everything that affects the public output. Immutable once stored in a Revision. */
export interface ArticleSnapshot {
  title: string;
  summary: string;
  body: string;
  byline: string;
  category: string;
  tags: string[];
  classification: Classification;
  featured: boolean;
  coverMediaId: string | null;
  coverAlt: string;
  seoDescription: string;
}

export interface Revision {
  id: string;
  articleId: string;
  no: number;
  parentId: string | null;
  snapshot: Readonly<ArticleSnapshot>;
  /** Preview digest of the canonical snapshot (SHA-256, computed by the preview engine, never client-supplied). */
  hash: string;
  createdBy: string;
  createdAt: number;
  restoredFromRevisionId: string | null;
  state: ReviewState;
  note: string | null;
}

export interface Contributor {
  actorId: string;
  revisionId: string;
  kind: "author" | "editor";
}

export interface Article {
  id: string;
  slug: string;
  origin: "manual";
  currentRevisionId: string;
  publishedRevisionId: string | null;
  delivery: DeliveryState;
  generation: number;
  classificationFloor: Classification;
  createdBy: string;
  createdAt: number;
  contributors: Contributor[];
}

export interface Approval {
  id: string;
  articleId: string;
  revisionId: string;
  hash: string;
  classification: Classification;
  approverId: string;
  at: number;
  policyVersion: string;
}

export interface PublicationIntent {
  id: string;
  articleId: string;
  generation: number;
  action: "publish" | "unpublish";
  revisionId: string;
  actorId: string;
  approvalId: string | null;
  status: "pending" | "delivered" | "failed" | "cancelled";
  createdAt: number;
}

export type StaffStatus = "active" | "suspended";
export interface StaffMember {
  id: string;
  name: string;
  handle: string;
  roles: RoleId[];
  status: StaffStatus;
  suspendedReason: string | null;
  note: string;
}

export type GrantScope = { kind: "collection"; key: "news" | "staff" | "audit" | "ops" } | { kind: "article"; articleId: string };
export interface Grant {
  id: string;
  subjectId: string;
  permission: PermissionId;
  scope: GrantScope;
  reason: string;
  proposerId: string;
  approverId: string;
  startsAt: number;
  expiresAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
}

export type StaffRequest =
  | { id: string; kind: "role"; targetId: string; role: RoleId; reason: string; proposerId: string; status: "pending" | "approved" | "rejected"; decidedBy: string | null; createdAt: number }
  | { id: string; kind: "grant"; targetId: string; permission: PermissionId; scope: GrantScope; days: number; reason: string; proposerId: string; status: "pending" | "approved" | "rejected"; decidedBy: string | null; createdAt: number };

export type SessionStatus = "signed_out" | "signed_in" | "mfa_required" | "mfa_verified" | "revoked" | "access_denied";
export interface SessionState {
  status: SessionStatus;
  personaId: string | null;
  mfaVerifiedAt: number | null;
  mfaFailures: number;
  deniedReason: string | null;
}

export type AuditCategory = "editorial" | "staff" | "session" | "owner";
export interface AuditEvent {
  id: string;
  at: number;
  actorId: string | null;
  actorName: string;
  category: AuditCategory;
  action: string;
  targetType: string;
  targetLabel: string;
  result: "success" | "denied";
  permission: PermissionId | null;
  correlationId: string;
  reason: string | null;
  /** Always true: these records exist only in this browser tab's preview state. */
  previewOnly: true;
  seeded: boolean;
}

export interface PreviewState {
  version: 1;
  now: number;
  seq: number;
  session: SessionState;
  staff: StaffMember[];
  grants: Grant[];
  requests: StaffRequest[];
  articles: Article[];
  revisions: Revision[];
  approvals: Approval[];
  approvalUses: { approvalId: string; intentId: string }[];
  intents: PublicationIntent[];
  audit: AuditEvent[];
  ownerCeremony: { bootstrapConsumed: boolean; lastRecoveryDrillAt: number | null };
}

export type DenialKind = "denied" | "invalid" | "conflict" | "noop";
export type Outcome =
  | { ok: true; message: string; ref?: string }
  | { ok: false; kind: DenialKind; code: string; message: string; fieldErrors?: Record<string, string>; permission?: PermissionId };
