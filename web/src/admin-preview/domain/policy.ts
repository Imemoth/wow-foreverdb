import type { Grant, GrantScope, PermissionId, RoleId, StaffMember } from "./types";

export const POLICY_VERSION = "proposed-v0 (preview)";
/** The only TOTP code the simulated sign-in accepts. It is not a secret and unlocks nothing outside this browser tab. */
export const MFA_DEMO_CODE = "123456";

export interface RoleDef { id: RoleId; label: string; rank: number; summary: string; boundary: string }
export const ROLES: RoleDef[] = [
  { id: "user", label: "User", rank: 0, summary: "Ordinary AzerDex account. No staff entry.", boundary: "Cannot enter Admin." },
  { id: "moderator", label: "Moderator", rank: 1, summary: "Handles in-scope moderation cases (ADM-04).", boundary: "No editorial or staff authority." },
  { id: "editor", label: "Editor", rank: 1, summary: "Drafts, previews, submits and reviews News; manages approved media.", boundary: "No publishing by default; only a scoped, expiring grant delegates it." },
  { id: "administrator", label: "Administrator", rank: 3, summary: "Staff workflow administration and bounded role/grant proposals.", boundary: "Needs a separate publishing grant. Cannot self-elevate or bypass editorial approval." },
  { id: "owner", label: "Owner", rank: 4, summary: "Full staff administration and normal-article publishing.", boundary: "May publish highlighted content only after independent approval. No deploy, SQL or public-read publication." },
];
export const roleLabel = (r: RoleId): string => ROLES.find((x) => x.id === r)?.label ?? r;
export const roleRank = (r: RoleId): number => ROLES.find((x) => x.id === r)?.rank ?? 0;

export type Cell = "yes" | "grant" | "none";
const Y: Cell = "yes", G: Cell = "grant", N: Cell = "none";

export interface PermissionDef {
  id: PermissionId;
  area: "Entry" | "News" | "Media" | "Moderation" | "Staff" | "Audit" | "Operations";
  summary: string;
  /** Critical actions need TOTP authentication no older than 15 minutes (ADR-020, OWNER APPROVED). */
  critical: boolean;
  /** user, moderator, editor, administrator, owner — ADR-020 matrix. */
  cells: [Cell, Cell, Cell, Cell, Cell];
}

export const PERMISSIONS: PermissionDef[] = [
  { id: "admin.enter", area: "Entry", summary: "Enter /admin. Necessary, never sufficient.", critical: false, cells: [N, Y, Y, Y, Y] },
  { id: "news.draft.write", area: "News", summary: "Create and edit News drafts (each edit makes a new immutable revision).", critical: false, cells: [N, N, Y, N, N] },
  { id: "news.article.preview", area: "News", summary: "Preview private drafts.", critical: false, cells: [N, N, Y, N, N] },
  { id: "news.article.submit", area: "News", summary: "Submit an exact revision for review.", critical: false, cells: [N, N, Y, N, N] },
  { id: "news.article.review", area: "News", summary: "Record review feedback. Never substitutes for highlighted approval.", critical: false, cells: [N, N, Y, N, N] },
  { id: "news.article.classify", area: "News", summary: "Change classification / featured flag.", critical: false, cells: [N, N, Y, N, N] },
  { id: "news.article.approve_highlighted", area: "News", summary: "Independently approve one exact highlighted/high-impact revision.", critical: true, cells: [N, N, G, Y, Y] },
  { id: "news.article.publish", area: "News", summary: "Publish a validated revision (editorial only; no deploy or database publication).", critical: true, cells: [N, N, G, G, Y] },
  { id: "news.article.unpublish", area: "News", summary: "Remove a published revision from public output.", critical: true, cells: [N, N, G, Y, Y] },
  { id: "news.media.manage", area: "Media", summary: "Manage approved media references.", critical: false, cells: [N, N, Y, N, N] },
  { id: "news.media.validate", area: "Media", summary: "Validate rights, provenance and alt text.", critical: false, cells: [N, N, Y, N, N] },
  { id: "moderation.case.read", area: "Moderation", summary: "Read moderation cases (future, ADM-04).", critical: false, cells: [N, Y, N, N, N] },
  { id: "moderation.case.decide", area: "Moderation", summary: "Decide moderation cases (future, ADM-04).", critical: false, cells: [N, Y, N, N, N] },
  { id: "moderation.case.reverse", area: "Moderation", summary: "Reverse a moderation decision (future, ADM-04).", critical: false, cells: [N, Y, N, N, N] },
  { id: "staff.role.propose", area: "Staff", summary: "Propose a bounded role assignment.", critical: true, cells: [N, N, N, Y, Y] },
  { id: "staff.grant.propose", area: "Staff", summary: "Propose a scoped, expiring grant.", critical: true, cells: [N, N, N, Y, Y] },
  { id: "staff.role.approve", area: "Staff", summary: "Approve a role assignment.", critical: true, cells: [N, N, N, G, Y] },
  { id: "staff.grant.approve", area: "Staff", summary: "Approve a grant.", critical: true, cells: [N, N, N, G, Y] },
  { id: "staff.access.revoke", area: "Staff", summary: "Revoke a role or grant, suspend or reactivate staff.", critical: true, cells: [N, N, N, G, Y] },
  { id: "audit.editorial.read", area: "Audit", summary: "Read editorial audit events.", critical: false, cells: [N, N, G, Y, Y] },
  { id: "audit.staff.read", area: "Audit", summary: "Read staff, session and ceremony audit events.", critical: false, cells: [N, N, N, Y, Y] },
  { id: "ops.status.read", area: "Operations", summary: "Read-only approved operations status (future, ADM-04).", critical: false, cells: [N, N, N, G, G] },
];
const ROLE_ORDER: RoleId[] = ["user", "moderator", "editor", "administrator", "owner"];
export const permDef = (p: PermissionId): PermissionDef => PERMISSIONS.find((x) => x.id === p)!;
export function roleCell(role: RoleId, perm: PermissionId): Cell {
  return permDef(perm).cells[ROLE_ORDER.indexOf(role)] ?? N;
}
/** Permissions that can be delegated by grant (they carry a `G` cell somewhere). */
export const GRANTABLE: PermissionId[] = PERMISSIONS.filter((p) => p.cells.includes(G)).map((p) => p.id);
/** Grants of these permissions always need an independent approver (ADR-020 "elevated grants"). */
export const ELEVATED_GRANT: PermissionId[] = ["news.article.approve_highlighted", "staff.role.approve", "staff.grant.approve", "staff.access.revoke"];

/** ADR-020 OWNER APPROVED: delegated publishing grants default to 30 days and never exceed 90. Applied to every preview grant. */
export const GRANT_DEFAULT_DAYS = 30;
export const GRANT_MAX_DAYS = 90;
export const FRESHNESS_MS = 15 * 60 * 1000;
export const DAY_MS = 86_400_000;

export function permissionFamily(p: PermissionId): "news" | "staff" | "audit" | "ops" | null {
  if (p.startsWith("news.")) return "news";
  if (p.startsWith("staff.")) return "staff";
  if (p.startsWith("audit.")) return "audit";
  if (p.startsWith("ops.")) return "ops";
  return null;
}

export function scopeMatches(scope: GrantScope, perm: PermissionId, articleId?: string): boolean {
  if (scope.kind === "collection") return permissionFamily(perm) === scope.key;
  return articleId !== undefined && scope.articleId === articleId && permissionFamily(perm) === "news";
}
export function scopeLabel(scope: GrantScope, slugOf?: (id: string) => string | undefined): string {
  return scope.kind === "collection" ? `collection:${scope.key}` : `article:${slugOf?.(scope.articleId) ?? scope.articleId}`;
}

export type PermissionSource = { kind: "role"; role: RoleId } | { kind: "grant"; grantId: string };

export function grantActive(g: Grant, now: number): boolean {
  return g.revokedAt === null && g.startsAt <= now && now < g.expiresAt;
}
export type GrantStatus = "active" | "expiring" | "expired" | "revoked";
export function grantStatus(g: Grant, now: number): GrantStatus {
  if (g.revokedAt !== null) return "revoked";
  if (now >= g.expiresAt) return "expired";
  return g.expiresAt - now <= 7 * DAY_MS ? "expiring" : "active";
}

/** Effective permission sources for one staff member. Unknown/suspended => nothing (default deny). */
export function permissionSources(staff: StaffMember | undefined, grants: Grant[], now: number, perm: PermissionId, articleId?: string): PermissionSource[] {
  if (!staff || staff.status !== "active") return [];
  const out: PermissionSource[] = [];
  for (const role of staff.roles) if (roleCell(role, perm) === "yes") out.push({ kind: "role", role });
  for (const g of grants) {
    if (g.subjectId === staff.id && g.permission === perm && grantActive(g, now) && scopeMatches(g.scope, perm, articleId)) out.push({ kind: "grant", grantId: g.id });
  }
  return out;
}

/** True if the member holds the permission in ANY scope (navigation / visibility only — actions re-check with the real scope). */
export function holdsAnywhere(staff: StaffMember | undefined, grants: Grant[], now: number, perm: PermissionId): boolean {
  if (!staff || staff.status !== "active") return false;
  if (staff.roles.some((r) => roleCell(r, perm) === "yes")) return true;
  return grants.some((g) => g.subjectId === staff.id && g.permission === perm && grantActive(g, now));
}

export function highestRank(staff: StaffMember): number {
  return staff.roles.reduce((m, r) => Math.max(m, roleRank(r)), 0);
}
