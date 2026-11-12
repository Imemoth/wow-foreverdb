import { effectiveClassification, normalizeSnapshot, validateSlug, validateSnapshot } from "./content";
import {
  DAY_MS, ELEVATED_GRANT, FRESHNESS_MS, GRANTABLE, MFA_DEMO_CODE, GRANT_DEFAULT_DAYS, GRANT_MAX_DAYS, POLICY_VERSION, permDef, permissionSources, roleCell, roleLabel, roleRank, scopeLabel,
} from "./policy";
import { buildSeed, hashSnapshot } from "./seed";
import { articleOf, headOf, nameOf, requiredClass, revisionOf, revisionsOf, sessionActive, sessionView, staffOf } from "./selectors";
import type { Approval, Article, ArticleSnapshot, AuditCategory, GrantScope, Outcome, PermissionId, PreviewState, RoleId, StaffMember } from "./types";

/**
 * Preview engine. A pure function of (state, action) -> (state, outcome). It is the SIMULATION of the approved ADM-03A / ADR-020 rules.
 * It never touches the network, a database, Supabase Auth or the production authorization layer, and nothing here is imported by production code.
 * Rules mirrored from the approved contracts are annotated "ADR-020" / "ADM-03A"; preview-only shortcuts are annotated "PREVIEW".
 */

export type PreviewAction =
  | { type: "session/signIn"; personaId: string }
  | { type: "session/submitMfa"; code: string }
  | { type: "session/stepUp"; code: string }
  | { type: "session/revoke" }
  | { type: "session/signOut" }
  | { type: "session/switchPersona"; personaId: string }
  | { type: "clock/advance"; minutes: number }
  | { type: "article/create"; slug: string; snapshot: ArticleSnapshot }
  | { type: "article/save"; articleId: string; baseRevisionId: string; snapshot: ArticleSnapshot }
  | { type: "article/submit"; articleId: string; revisionId: string }
  | { type: "article/review"; articleId: string; revisionId: string; decision: "return" | "reject"; reason: string }
  | { type: "article/approve"; articleId: string; revisionId: string }
  | { type: "article/publish"; articleId: string; revisionId: string }
  | { type: "article/unpublish"; articleId: string }
  | { type: "article/restore"; articleId: string; fromRevisionId: string }
  | { type: "delivery/receipt"; articleId: string }
  | { type: "delivery/fail"; articleId: string }
  | { type: "delivery/retry"; articleId: string }
  | { type: "staff/proposeRole"; targetId: string; role: RoleId; reason: string }
  | { type: "staff/revokeRole"; targetId: string; role: RoleId; reason: string }
  | { type: "staff/createGrant"; targetId: string; permission: PermissionId; scope: GrantScope; days: number; reason: string }
  | { type: "staff/setGrantExpiry"; grantId: string; days: number }
  | { type: "staff/revokeGrant"; grantId: string }
  | { type: "staff/suspend"; targetId: string; reason: string }
  | { type: "staff/reactivate"; targetId: string }
  | { type: "staff/decideRequest"; requestId: string; decision: "approve" | "reject" }
  | { type: "owner/bootstrapSim" }
  | { type: "owner/recoveryDrill" };

export const ACTION_TICK_MS = 10_000;
const MAX_MFA_FAILURES = 3;

interface Ctx { s: PreviewState; corr: string }
interface Meta { action: string; category: AuditCategory; targetType: string; targetLabel: string; permission?: PermissionId | null; actor?: StaffMember | null; actorName?: string }

const ok = (message: string, ref?: string): Outcome => ({ ok: true, message, ref });
function bad(kind: "invalid" | "conflict" | "noop", code: string, message: string, fieldErrors?: Record<string, string>): Outcome {
  return { ok: false, kind, code, message, fieldErrors };
}

function nextId(s: PreviewState, prefix: string): string {
  s.seq += 1;
  return `${prefix}-${s.seq}`;
}
function audit(c: Ctx, m: Meta, result: "success" | "denied", reason: string | null = null): void {
  const actor = m.actor === undefined ? staffOf(c.s, c.s.session.personaId) : m.actor;
  c.s.audit.push({
    id: nextId(c.s, "aud"), at: c.s.now, actorId: actor?.id ?? null, actorName: m.actorName ?? actor?.name ?? "(unauthenticated)", category: m.category, action: m.action,
    targetType: m.targetType, targetLabel: m.targetLabel, result, permission: m.permission ?? null, correlationId: c.corr, reason, previewOnly: true, seeded: false,
  });
}
/** ADR-020: denied attempts are audited too. */
function deny(c: Ctx, m: Meta, code: string, message: string, permission?: PermissionId, kind: "denied" | "conflict" = "denied"): Outcome {
  audit(c, { ...m, permission: permission ?? m.permission ?? null }, "denied", message);
  return { ok: false, kind, code, message, permission };
}

type Auth = { ok: true; actor: StaffMember } | { ok: false; out: Outcome };

/**
 * Preview equivalent of the protected-entry check: live session -> live staff status -> scoped permission (role default OR active grant) -> freshness.
 * Revocation / suspension / grant expiry are re-read from CURRENT state on every call ("next protected decision").
 */
function authorize(c: Ctx, perm: PermissionId, m: Meta, opts: { articleId?: string; critical?: boolean } = {}): Auth {
  const v = sessionView(c.s);
  if (m.permission == null) m.permission = perm; // success audit events carry the permission that authorized them
  const meta = { ...m, permission: perm };
  const fail = (code: string, message: string, kind: "denied" | "conflict" = "denied"): Auth => ({ ok: false, out: deny(c, meta, code, message, perm, kind) });
  if (v.status === "signed_out" || v.status === "signed_in") return fail("session_required", "No active Admin session. Sign in and verify TOTP first.");
  if (v.status === "mfa_required") return fail("mfa_required", "TOTP (AAL2) verification is required before any Admin action.");
  if (v.status === "revoked") return fail("session_revoked", "This session was revoked. Every protected action is denied until you sign in again.");
  if (v.status === "access_denied" || !v.persona) return fail("access_denied", "Access denied: this account has no Admin entry.");
  const actor = v.persona;
  if (actor.status !== "active") return fail("account_suspended", `${actor.name} is suspended. Suspension is checked on every protected decision, including in an open session.`);
  if (permissionSources(actor, c.s.grants, c.s.now, "admin.enter").length === 0) return fail("access_denied", "Access denied: this account no longer holds Admin entry.");
  const sources = permissionSources(actor, c.s.grants, c.s.now, perm, opts.articleId);
  if (sources.length === 0) {
    const gOnly = actor.roles.some((r) => roleCell(r, perm) === "grant");
    const expired = c.s.grants.find((g) => g.subjectId === actor.id && g.permission === perm && g.revokedAt === null && c.s.now >= g.expiresAt);
    const msg = gOnly
      ? `${perm} is delegated only through an explicit, scoped, expiring grant, and ${actor.name} has no active grant${opts.articleId ? " covering this article" : ""}${expired ? " (the previous grant has expired)" : ""}. The ${actor.roles.map(roleLabel).join("/")} role alone never confers it.`
      : `${actor.name} (${actor.roles.map(roleLabel).join(", ")}) does not hold ${perm}. ${permDef(perm).summary}`;
    return fail("permission_missing", msg);
  }
  const critical = opts.critical ?? permDef(perm).critical;
  if (critical && v.status === "mfa_stale") {
    return fail("step_up_required", "This is a critical action and your TOTP verification is older than 15 minutes (ADR-020). Verify again to continue.");
  }
  return { ok: true, actor };
}

const label = (a: Article, no?: number): string => (no ? `${a.slug} · r${no}` : a.slug);

export function apply(prev: PreviewState, action: PreviewAction): { state: PreviewState; outcome: Outcome } {
  const s = structuredClone(prev);
  if (action.type !== "clock/advance") s.now += ACTION_TICK_MS;
  s.seq += 1;
  const c: Ctx = { s, corr: `PV-${String(s.seq).padStart(4, "0")}` };
  const outcome = handle(c, action);
  return { state: s, outcome };
}

function handle(c: Ctx, a: PreviewAction): Outcome {
  switch (a.type) {
    case "clock/advance": {
      const minutes = Math.min(Math.max(Math.floor(a.minutes), 1), 100 * 24 * 60);
      c.s.now += minutes * 60_000;
      return ok(`Preview clock advanced by ${minutes} min.`);
    }
    case "session/signIn": return signIn(c, a.personaId);
    case "session/submitMfa": return submitMfa(c, a.code, false);
    case "session/stepUp": return submitMfa(c, a.code, true);
    case "session/signOut": {
      const who = staffOf(c.s, c.s.session.personaId);
      if (who) audit(c, { action: "session.sign_out", category: "session", targetType: "session", targetLabel: who.name, permission: null }, "success");
      c.s.session = { status: "signed_out", personaId: null, mfaVerifiedAt: null, mfaFailures: 0, deniedReason: null };
      return ok("Signed out of the simulated session.");
    }
    case "session/revoke": {
      const who = staffOf(c.s, c.s.session.personaId);
      if (!who) return bad("noop", "no_session", "There is no session to revoke.");
      audit(c, { action: "session.revoke", category: "session", targetType: "session", targetLabel: who.name, permission: null }, "success", "Simulated server-side session revocation.");
      c.s.session.status = "revoked";
      return ok("Session revoked (simulated). The next protected decision is denied.");
    }
    case "session/switchPersona": return switchPersona(c, a.personaId);
    case "article/create": return createArticle(c, a.slug, a.snapshot);
    case "article/save": return saveRevision(c, a.articleId, a.baseRevisionId, a.snapshot);
    case "article/submit": return submit(c, a.articleId, a.revisionId);
    case "article/review": return review(c, a.articleId, a.revisionId, a.decision, a.reason);
    case "article/approve": return approve(c, a.articleId, a.revisionId);
    case "article/publish": return publish(c, a.articleId, a.revisionId);
    case "article/unpublish": return unpublish(c, a.articleId);
    case "article/restore": return restore(c, a.articleId, a.fromRevisionId);
    case "delivery/receipt": return deliveryReceipt(c, a.articleId);
    case "delivery/fail": return deliveryFail(c, a.articleId);
    case "delivery/retry": return deliveryRetry(c, a.articleId);
    case "staff/proposeRole": return proposeRole(c, a.targetId, a.role, a.reason);
    case "staff/revokeRole": return revokeRole(c, a.targetId, a.role, a.reason);
    case "staff/createGrant": return createGrant(c, a);
    case "staff/setGrantExpiry": return setGrantExpiry(c, a.grantId, a.days);
    case "staff/revokeGrant": return revokeGrant(c, a.grantId);
    case "staff/suspend": return suspend(c, a.targetId, a.reason);
    case "staff/reactivate": return reactivate(c, a.targetId);
    case "staff/decideRequest": return decideRequest(c, a.requestId, a.decision);
    case "owner/bootstrapSim": return ownerCeremony(c, "bootstrap");
    case "owner/recoveryDrill": return ownerCeremony(c, "recovery");
  }
}

/* ------------------------------------------------------------------ session (PREVIEW simulation; no real Auth) */

function signIn(c: Ctx, personaId: string): Outcome {
  const who = staffOf(c.s, personaId);
  const m: Meta = { action: "session.sign_in", category: "session", targetType: "session", targetLabel: who?.name ?? personaId, actor: who ?? null, actorName: who?.name ?? "(unknown)", permission: "admin.enter" };
  if (!who) return bad("invalid", "unknown_persona", "Unknown synthetic account.");
  c.s.session = { status: "signed_in", personaId, mfaVerifiedAt: null, mfaFailures: 0, deniedReason: null };
  const denyEntry = (reason: string): Outcome => {
    c.s.session.status = "access_denied";
    c.s.session.deniedReason = reason;
    audit(c, m, "denied", reason);
    return { ok: false, kind: "denied", code: "access_denied", message: reason, permission: "admin.enter" };
  };
  if (who.status === "suspended") return denyEntry(`${who.name} is suspended; Admin access is denied.`);
  if (permissionSources(who, c.s.grants, c.s.now, "admin.enter").length === 0) return denyEntry(`${who.name} has no staff role. A User account cannot enter Admin (ADR-020).`);
  c.s.session.status = "mfa_required";
  audit(c, m, "success", "Password step accepted (simulated). TOTP required.");
  return ok(`${who.name}: signed in. TOTP verification is required.`);
}

function submitMfa(c: Ctx, code: string, stepUp: boolean): Outcome {
  const who = staffOf(c.s, c.s.session.personaId);
  const m: Meta = { action: stepUp ? "session.step_up" : "session.mfa.verify", category: "session", targetType: "session", targetLabel: who?.name ?? "—", permission: null };
  if (!who) return bad("invalid", "no_session", "Sign in first.");
  if (stepUp ? c.s.session.status !== "mfa_verified" : c.s.session.status !== "mfa_required") return bad("invalid", "wrong_state", "TOTP is not being requested in the current session state.");
  if (c.s.session.mfaFailures >= MAX_MFA_FAILURES) return deny(c, m, "mfa_locked", "Too many incorrect codes (simulated lockout). Sign out and start again.", undefined);
  if (!/^\d{6}$/.test(code)) return bad("invalid", "code_format", "Enter the 6-digit code.", { code: "Enter exactly 6 digits." });
  if (code !== MFA_DEMO_CODE) {
    c.s.session.mfaFailures += 1;
    audit(c, { ...m, action: "session.mfa.fail" }, "denied", `Incorrect code (attempt ${c.s.session.mfaFailures} of ${MAX_MFA_FAILURES}).`);
    return { ok: false, kind: "denied", code: "mfa_incorrect", message: `Incorrect code. ${MAX_MFA_FAILURES - c.s.session.mfaFailures} attempt(s) left (simulated).` };
  }
  c.s.session.status = "mfa_verified";
  c.s.session.mfaVerifiedAt = c.s.now;
  c.s.session.mfaFailures = 0;
  audit(c, m, "success", "Synthetic TOTP accepted (AAL2 simulated).");
  return ok(stepUp ? "Fresh TOTP verified. Critical actions are available for 15 minutes." : `${who.name}: TOTP verified (AAL2 simulated).`);
}

/** PREVIEW-ONLY shortcut: lets the Product Owner act as another synthetic persona without re-entering the demo code. Does not exist in production. */
function switchPersona(c: Ctx, personaId: string): Outcome {
  const who = staffOf(c.s, personaId);
  if (!who) return bad("invalid", "unknown_persona", "Unknown synthetic account.");
  const m: Meta = { action: "session.persona_switch", category: "session", targetType: "session", targetLabel: who.name, actor: who, permission: "admin.enter" };
  if (who.status === "suspended" || permissionSources(who, c.s.grants, c.s.now, "admin.enter").length === 0) {
    c.s.session = { status: "access_denied", personaId, mfaVerifiedAt: null, mfaFailures: 0, deniedReason: who.status === "suspended" ? `${who.name} is suspended; Admin access is denied.` : `${who.name} has no staff role; Admin access is denied.` };
    audit(c, m, "denied", c.s.session.deniedReason);
    return { ok: false, kind: "denied", code: "access_denied", message: c.s.session.deniedReason!, permission: "admin.enter" };
  }
  c.s.session = { status: "mfa_verified", personaId, mfaVerifiedAt: c.s.now, mfaFailures: 0, deniedReason: null };
  audit(c, m, "success", "Preview-only persona switch (simulated completed sign-in with fresh TOTP).");
  return ok(`Now acting as ${who.name} (synthetic).`);
}

/* ------------------------------------------------------------------ articles (ADM-03A contract, simulated) */

function addContributor(art: Article, actorId: string, revisionId: string, kind: "author" | "editor"): void {
  art.contributors.push({ actorId, revisionId, kind });
}

function createArticle(c: Ctx, slug: string, raw: ArticleSnapshot): Outcome {
  const m: Meta = { action: "article.create", category: "editorial", targetType: "article", targetLabel: slug || "(new)" };
  const auth = authorize(c, "news.draft.write", m);
  if (!auth.ok) return auth.out;
  const snapshot = normalizeSnapshot(raw);
  const errors: Record<string, string> = {};
  const slugErr = validateSlug(slug, (x) => c.s.articles.some((a) => a.slug === x));
  if (slugErr) errors.slug = slugErr;
  if (snapshot.title.length < 3) errors.title = "A draft needs at least a short title.";
  if (Object.keys(errors).length) return bad("invalid", "validation", "Fix the highlighted fields.", errors);
  if (effectiveClassification(snapshot) === "highlighted") {
    const cls = authorize(c, "news.article.classify", { ...m, action: "article.classify" });
    if (!cls.ok) return cls.out;
  }
  const articleId = nextId(c.s, "art");
  const revId = `${articleId}-r1`;
  c.s.revisions.push({ id: revId, articleId, no: 1, parentId: null, snapshot: Object.freeze({ ...snapshot }), hash: hashSnapshot(snapshot), createdBy: auth.actor.id, createdAt: c.s.now, restoredFromRevisionId: null, state: "draft", note: null });
  const art: Article = {
    id: articleId, slug, origin: "manual", currentRevisionId: revId, publishedRevisionId: null, delivery: "never_published", generation: 0,
    classificationFloor: effectiveClassification(snapshot), createdBy: auth.actor.id, createdAt: c.s.now, contributors: [],
  };
  addContributor(art, auth.actor.id, revId, "author");
  c.s.articles.push(art);
  audit(c, { ...m, targetLabel: label(art, 1) }, "success", `Slug "${slug}" reserved permanently. Immutable r1 created (${c.s.revisions.at(-1)!.hash.slice(0, 12)}…).`);
  return ok(`Draft created: ${slug} (r1).`, articleId);
}

function saveRevision(c: Ctx, articleId: string, baseRevisionId: string, raw: ArticleSnapshot): Outcome {
  const art = articleOf(c.s, articleId);
  if (!art) return bad("invalid", "not_found", "Article not found.");
  const head = headOf(c.s, art);
  const m: Meta = { action: "article.revision.create", category: "editorial", targetType: "article", targetLabel: label(art) };
  const auth = authorize(c, "news.draft.write", m, { articleId });
  if (!auth.ok) return auth.out;
  if (baseRevisionId !== art.currentRevisionId) {
    return deny(c, m, "stale_revision", `This editor was opened on an older revision. r${head.no} is now the head; reload to avoid overwriting it (CAS on expected revision).`, "news.article.review", "conflict");
  }
  const snapshot = normalizeSnapshot(raw);
  const errors: Record<string, string> = {};
  if (snapshot.title.length < 3) errors.title = "A draft needs at least a short title.";
  if (Object.keys(errors).length) return bad("invalid", "validation", "Fix the highlighted fields.", errors);
  const nextClass = effectiveClassification(snapshot);
  // ADM-03A V1: the classification floor never lowers through an ordinary edit.
  if (art.classificationFloor === "highlighted" && nextClass === "normal") {
    return deny(c, { ...m, action: "article.classify" }, "classification_downgrade_prohibited",
      "V1 policy: classification cannot be downgraded. This article was highlighted/high-impact in an earlier revision, so the stricter independent-approval requirement stays in force. A downgrade needs a separately authorized, reasoned decision that is not part of V1.", "news.article.classify");
  }
  const hash = hashSnapshot(snapshot);
  if (hash === head.hash) return bad("noop", "no_changes", "No changes to save — the content matches the head revision.");
  if (nextClass !== effectiveClassification(head.snapshot)) {
    const cls = authorize(c, "news.article.classify", { ...m, action: "article.classify" }, { articleId });
    if (!cls.ok) return cls.out;
  }
  const no = Math.max(...revisionsOf(c.s, articleId).map((r) => r.no)) + 1;
  const revId = `${articleId}-r${no}`;
  // The previous head stays immutable; only its review STATE moves, so an old approval can never follow the new head.
  if (head.id !== art.publishedRevisionId && head.state !== "rejected") head.state = "superseded";
  c.s.revisions.push({ id: revId, articleId, no, parentId: head.id, snapshot: Object.freeze({ ...snapshot }), hash, createdBy: auth.actor.id, createdAt: c.s.now, restoredFromRevisionId: null, state: "draft", note: null });
  art.currentRevisionId = revId;
  if (nextClass === "highlighted") art.classificationFloor = "highlighted";
  // ADM-03A fail-closed V1: every change to content/public metadata counts as substantive for independence.
  addContributor(art, auth.actor.id, revId, "editor");
  audit(c, { ...m, targetLabel: label(art, no) }, "success", `New immutable revision r${no} (${hash.slice(0, 12)}…). Earlier approvals cannot authorize it.${art.publishedRevisionId ? ` Live revision r${revisionOf(c.s, art.publishedRevisionId)!.no} is untouched.` : ""}`);
  return ok(`Saved as new revision r${no}.`, revId);
}

function requireHead(c: Ctx, art: Article, revisionId: string, m: Meta, perm: PermissionId): Outcome | null {
  if (art.currentRevisionId !== revisionId) {
    return deny(c, m, "stale_revision", `Only the current head revision can be acted on. r${headOf(c.s, art).no} is the head; the action targeted an older revision.`, perm, "conflict");
  }
  return null;
}

function submit(c: Ctx, articleId: string, revisionId: string): Outcome {
  const art = articleOf(c.s, articleId);
  if (!art) return bad("invalid", "not_found", "Article not found.");
  const rev = revisionOf(c.s, revisionId);
  if (!rev) return bad("invalid", "not_found", "Revision not found.");
  const m: Meta = { action: "article.submit", category: "editorial", targetType: "article", targetLabel: label(art, rev.no) };
  const auth = authorize(c, "news.article.submit", m, { articleId });
  if (!auth.ok) return auth.out;
  const stale = requireHead(c, art, revisionId, m, "news.article.submit");
  if (stale) return stale;
  if (rev.state !== "draft") return bad("invalid", "wrong_state", `r${rev.no} is ${rev.state.replace("_", " ")}; only a draft revision can be submitted. Edit it to create a new revision first.`);
  const errors = validateSnapshot(rev.snapshot);
  if (Object.keys(errors).length) return bad("invalid", "validation", "Validation failed — the revision cannot be submitted yet.", errors);
  rev.state = "in_review";
  audit(c, m, "success", `Submitted exact hash ${rev.hash.slice(0, 12)}… for review (${requiredClass(art, rev)}).`);
  return ok(`r${rev.no} submitted for review.`);
}

function review(c: Ctx, articleId: string, revisionId: string, decision: "return" | "reject", reason: string): Outcome {
  const art = articleOf(c.s, articleId);
  const rev = revisionOf(c.s, revisionId);
  if (!art || !rev) return bad("invalid", "not_found", "Article or revision not found.");
  const m: Meta = { action: decision === "return" ? "article.review.return" : "article.review.reject", category: "editorial", targetType: "article", targetLabel: label(art, rev.no) };
  const auth = authorize(c, "news.article.review", m, { articleId });
  if (!auth.ok) return auth.out;
  const stale = requireHead(c, art, revisionId, m, "news.article.review");
  if (stale) return stale;
  if (rev.state !== "in_review") return bad("invalid", "wrong_state", "Only a revision in review can be returned or rejected.");
  if (reason.trim().length < 5) return bad("invalid", "validation", "A reason of at least 5 characters is required.", { reason: "Give a short reason." });
  rev.state = decision === "return" ? "draft" : "rejected";
  rev.note = reason.trim();
  audit(c, m, "success", reason.trim());
  return ok(decision === "return" ? `r${rev.no} returned to draft.` : `r${rev.no} rejected.`);
}

/** Independence (ADM-03A §4): the approver must not appear in ANY server-recorded author/editor set of the article, regardless of roles held. */
function independenceViolation(c: Ctx, art: Article, approverId: string): string | null {
  const mine = art.contributors.filter((x) => x.actorId === approverId);
  if (mine.length === 0) return null;
  const revs = [...new Set(mine.map((x) => `r${revisionOf(c.s, x.revisionId)?.no ?? "?"}`))].join(", ");
  const kinds = [...new Set(mine.map((x) => (x.kind === "author" ? "authored" : "edited")))].join(" and ");
  return `${nameOf(c.s, approverId)} ${kinds} ${revs} of this article. Independent approval must come from someone who neither authored nor substantively edited it — holding Owner or Administrator does not change that.`;
}

function approve(c: Ctx, articleId: string, revisionId: string): Outcome {
  const art = articleOf(c.s, articleId);
  const rev = revisionOf(c.s, revisionId);
  if (!art || !rev) return bad("invalid", "not_found", "Article or revision not found.");
  const cls = requiredClass(art, rev);
  const m: Meta = { action: "article.approve", category: "editorial", targetType: "article", targetLabel: label(art, rev.no) };
  if (cls === "highlighted") {
    const auth = authorize(c, "news.article.approve_highlighted", m, { articleId });
    if (!auth.ok) return auth.out;
    const stale = requireHead(c, art, revisionId, m, "news.article.approve_highlighted");
    if (stale) return stale;
    if (rev.state !== "in_review") return bad("invalid", "wrong_state", "Only a revision in review can be approved.");
    const viol = independenceViolation(c, art, auth.actor.id);
    if (viol) return deny(c, m, "self_approval_forbidden", `Self-approval rejected. ${viol}`, "news.article.approve_highlighted");
    const errors = validateSnapshot(rev.snapshot);
    if (Object.keys(errors).length) return bad("invalid", "validation", "Validation failed — the revision cannot be approved.", errors);
    const approval: Approval = { id: nextId(c.s, "apr"), articleId, revisionId, hash: rev.hash, classification: "highlighted", approverId: auth.actor.id, at: c.s.now, policyVersion: POLICY_VERSION };
    c.s.approvals.push(approval);
    rev.state = "approved";
    audit(c, m, "success", `Independent approval ${approval.id} bound to r${rev.no} and hash ${rev.hash.slice(0, 12)}…. It authorizes at most one publication and is void if the revision changes.`);
    return ok(`r${rev.no} approved (independent, revision-bound).`);
  }
  // Normal path: validation is recorded; no second person is required (ADR-020). The actor needs review or publish authority.
  const viaReview = authorize(c, "news.article.review", m, { articleId });
  let actor: StaffMember;
  if (viaReview.ok) actor = viaReview.actor;
  else {
    // A delegated publisher may validate-and-approve a normal revision without holding news.article.review. The session was already
    // verified by the failed review attempt above only if it was permission-related, so re-probe quietly with the real scope.
    const persona = sessionView(c.s).persona;
    if (!persona || !sessionActive(sessionView(c.s)) || !authorizeQuiet(c, persona, "news.article.publish", articleId)) return viaReview.out;
    actor = persona;
  }
  const stale = requireHead(c, art, revisionId, m, "news.article.review");
  if (stale) return stale;
  if (rev.state !== "in_review") return bad("invalid", "wrong_state", "Only a revision in review can be approved.");
  const errors = validateSnapshot(rev.snapshot);
  if (Object.keys(errors).length) return bad("invalid", "validation", "Validation failed — the revision cannot be approved.", errors);
  rev.state = "approved";
  audit(c, { ...m, actor }, "success", "Normal article: validation recorded. No second-person approval is required by ADR-020.");
  return ok(`r${rev.no} validated and approved.`);
}

function publish(c: Ctx, articleId: string, revisionId: string): Outcome {
  const art = articleOf(c.s, articleId);
  const rev = revisionOf(c.s, revisionId);
  if (!art || !rev) return bad("invalid", "not_found", "Article or revision not found.");
  const m: Meta = { action: "article.publish", category: "editorial", targetType: "article", targetLabel: label(art, rev.no) };
  const auth = authorize(c, "news.article.publish", m, { articleId });
  if (!auth.ok) return auth.out;
  const stale = requireHead(c, art, revisionId, m, "news.article.publish");
  if (stale) return stale;
  if (art.delivery === "publish_pending" || art.delivery === "unpublish_pending") return deny(c, m, "delivery_in_progress", "A delivery for this article is already pending; wait for its receipt.", "news.article.publish", "conflict");
  if (rev.state !== "approved") return bad("invalid", "not_approved", `r${rev.no} is ${rev.state.replace("_", " ")}. Only an approved head revision can be published.`);
  if (hashSnapshot(rev.snapshot) !== rev.hash) return deny(c, m, "hash_mismatch", "Snapshot hash mismatch — the revision no longer matches what was approved.", "news.article.publish");
  const errors = validateSnapshot(rev.snapshot);
  if (Object.keys(errors).length) return bad("invalid", "validation", "Pre-publication validation failed (content, media rights).", errors);
  let approvalId: string | null = null;
  if (requiredClass(art, rev) === "highlighted") {
    const ap = c.s.approvals.find((x) => x.revisionId === rev.id && x.hash === rev.hash);
    if (!ap) return deny(c, m, "approval_missing", "Highlighted/high-impact content can be published only after another eligible person approves this exact revision. Publishing as Owner does not waive this.", "news.article.approve_highlighted");
    if (c.s.approvalUses.some((u) => u.approvalId === ap.id)) return deny(c, m, "approval_consumed", "This approval was already consumed by a publication intent. One approval authorizes at most one publication; a new approval is required.", "news.article.approve_highlighted");
    // Re-check approver eligibility at PUBLICATION time, not only at approval time.
    const approver = staffOf(c.s, ap.approverId);
    const eligible = approver && approver.status === "active" && permissionSources(approver, c.s.grants, c.s.now, "news.article.approve_highlighted", articleId).length > 0;
    if (!eligible) return deny(c, m, "approval_no_longer_valid", `The approver (${nameOf(c.s, ap.approverId)}) is no longer eligible (suspended, role changed or grant expired). The approval cannot be used; a new independent approval is required.`, "news.article.approve_highlighted");
    const viol = independenceViolation(c, art, ap.approverId);
    if (viol) return deny(c, m, "approval_not_independent", `The approval is not independent. ${viol}`, "news.article.approve_highlighted");
    approvalId = ap.id;
  }
  art.generation += 1;
  const intentId = nextId(c.s, "int");
  c.s.intents.push({ id: intentId, articleId, generation: art.generation, action: "publish", revisionId, actorId: auth.actor.id, approvalId, status: "pending", createdAt: c.s.now });
  if (approvalId) c.s.approvalUses.push({ approvalId, intentId });
  art.delivery = "publish_pending";
  audit(c, m, "success", `Publication intent ${intentId} (generation ${art.generation}) committed with audit and outbox${approvalId ? `; consumed ${approvalId}` : ""}. Nothing is public until the delivery receipt. SIMULATED: no live content or public-read database is written.`);
  return ok(`Publication of r${rev.no} queued. Simulate the delivery receipt to make it live.`, intentId);
}

function unpublish(c: Ctx, articleId: string): Outcome {
  const art = articleOf(c.s, articleId);
  if (!art) return bad("invalid", "not_found", "Article not found.");
  const m: Meta = { action: "article.unpublish", category: "editorial", targetType: "article", targetLabel: label(art) };
  const auth = authorize(c, "news.article.unpublish", m, { articleId });
  if (!auth.ok) return auth.out;
  if (art.delivery !== "published" || !art.publishedRevisionId) return bad("invalid", "not_live", "Only a live article can be unpublished.");
  art.generation += 1;
  const intentId = nextId(c.s, "int");
  c.s.intents.push({ id: intentId, articleId, generation: art.generation, action: "unpublish", revisionId: art.publishedRevisionId, actorId: auth.actor.id, approvalId: null, status: "pending", createdAt: c.s.now });
  art.delivery = "unpublish_pending";
  audit(c, m, "success", `Unpublish intent ${intentId} (generation ${art.generation}) committed. The article remains public until the delivery receipt (SIMULATED).`);
  return ok("Unpublish queued. Simulate the delivery receipt to remove it.", intentId);
}

function restore(c: Ctx, articleId: string, fromRevisionId: string): Outcome {
  const art = articleOf(c.s, articleId);
  const from = revisionOf(c.s, fromRevisionId);
  if (!art || !from) return bad("invalid", "not_found", "Article or revision not found.");
  const m: Meta = { action: "article.restore", category: "editorial", targetType: "article", targetLabel: label(art, from.no) };
  const auth = authorize(c, "news.draft.write", m, { articleId });
  if (!auth.ok) return auth.out;
  const head = headOf(c.s, art);
  if (head.hash === from.hash) return bad("noop", "no_changes", "The head revision already has identical content.");
  const no = Math.max(...revisionsOf(c.s, articleId).map((r) => r.no)) + 1;
  const revId = `${articleId}-r${no}`;
  if (head.id !== art.publishedRevisionId && head.state !== "rejected") head.state = "superseded";
  c.s.revisions.push({ id: revId, articleId, no, parentId: head.id, snapshot: Object.freeze({ ...from.snapshot }), hash: from.hash, createdBy: auth.actor.id, createdAt: c.s.now, restoredFromRevisionId: from.id, state: "draft", note: `Restored from r${from.no}.` });
  art.currentRevisionId = revId;
  addContributor(art, auth.actor.id, revId, "editor");
  audit(c, { ...m, targetLabel: label(art, no) }, "success", `Rollback = new head revision r${no} copied from r${from.no}. It needs fresh review/approval; an old approval is never reused.`);
  return ok(`r${from.no} restored as new draft revision r${no}.`, revId);
}

/* ------------------------------------------------------------------ simulated delivery worker (no staff privilege) */

const WORKER: Pick<Meta, "actor" | "actorName"> = { actor: null, actorName: "delivery-worker (simulated)" };

function pendingIntent(c: Ctx, art: Article) {
  return [...c.s.intents].reverse().find((i) => i.articleId === art.id && (i.status === "pending" || i.status === "failed"));
}
function deliveryReceipt(c: Ctx, articleId: string): Outcome {
  const art = articleOf(c.s, articleId);
  if (!art) return bad("invalid", "not_found", "Article not found.");
  const intent = pendingIntent(c, art);
  if (!intent || !(art.delivery === "publish_pending" || art.delivery === "unpublish_pending" || art.delivery === "delivery_failed")) return bad("invalid", "nothing_pending", "No delivery is pending.");
  const m: Meta = { ...WORKER, action: "article.delivery.receipt", category: "editorial", targetType: "article", targetLabel: label(art, revisionOf(c.s, intent.revisionId)?.no), permission: null };
  // ADM-03A: before dispatch the worker re-checks that the originating actor and grant are still valid; a revoked actor cancels the intent.
  const actor = staffOf(c.s, intent.actorId);
  const perm: PermissionId = intent.action === "publish" ? "news.article.publish" : "news.article.unpublish";
  const stillValid = actor && actor.status === "active" && permissionSources(actor, c.s.grants, c.s.now, perm, art.id).length > 0;
  if (!stillValid) {
    intent.status = "cancelled";
    art.delivery = art.publishedRevisionId ? "published" : c.s.intents.some((i) => i.articleId === art.id && i.action === "unpublish" && i.status === "delivered") ? "unpublished" : "never_published";
    audit(c, m, "denied", `Intent ${intent.id} cancelled before dispatch: ${nameOf(c.s, intent.actorId)} no longer holds ${perm} (suspended, revoked or grant expired). Previous public state kept.`);
    return { ok: false, kind: "denied", code: "intent_cancelled", message: `Delivery cancelled: ${nameOf(c.s, intent.actorId)} was revoked before the worker dispatched the intent. The previous public state is unchanged.`, permission: perm };
  }
  intent.status = "delivered";
  if (intent.action === "publish") { art.publishedRevisionId = intent.revisionId; art.delivery = "published"; }
  else { art.publishedRevisionId = null; art.delivery = "unpublished"; }
  audit(c, m, "success", `Receipt for ${intent.id} (generation ${intent.generation}). Public pointer ${intent.action === "publish" ? `now r${revisionOf(c.s, intent.revisionId)!.no}` : "cleared"} — SIMULATED, no live content changed.`);
  return ok(intent.action === "publish" ? "Delivered (simulated): the revision is now the live revision." : "Delivered (simulated): the article is no longer public.");
}
function deliveryFail(c: Ctx, articleId: string): Outcome {
  const art = articleOf(c.s, articleId);
  if (!art) return bad("invalid", "not_found", "Article not found.");
  const intent = pendingIntent(c, art);
  if (!intent || intent.status !== "pending") return bad("invalid", "nothing_pending", "No delivery is pending.");
  intent.status = "failed";
  art.delivery = "delivery_failed";
  audit(c, { ...WORKER, action: "article.delivery.fail", category: "editorial", targetType: "article", targetLabel: label(art), permission: null }, "denied", `Simulated projection failure for ${intent.id}. The previous public state stays visible.`);
  return ok("Simulated delivery failure. The previous public state is unchanged.");
}
function deliveryRetry(c: Ctx, articleId: string): Outcome {
  const art = articleOf(c.s, articleId);
  if (!art) return bad("invalid", "not_found", "Article not found.");
  const intent = pendingIntent(c, art);
  if (!intent || intent.status !== "failed") return bad("invalid", "nothing_failed", "No failed delivery to retry.");
  intent.status = "pending";
  art.delivery = intent.action === "publish" ? "publish_pending" : "unpublish_pending";
  audit(c, { ...WORKER, action: "article.delivery.retry", category: "editorial", targetType: "article", targetLabel: label(art), permission: null }, "success", `Retry of ${intent.id}, same generation; no new staff authorization.`);
  return ok("Delivery retry queued (same intent and generation).");
}

/* ------------------------------------------------------------------ staff & roles (ADR-020 / ADM-01B-4 contract, simulated) */

const STAFF_META = (action: string, label_: string): Meta => ({ action, category: "staff", targetType: "staff", targetLabel: label_ });
const ASSIGNABLE: RoleId[] = ["moderator", "editor", "administrator"];

function applyRole(c: Ctx, target: StaffMember, role: RoleId): void {
  target.roles = [...new Set([...target.roles.filter((r) => r !== "user"), role])];
}

function proposeRole(c: Ctx, targetId: string, role: RoleId, reason: string): Outcome {
  const target = staffOf(c.s, targetId);
  if (!target) return bad("invalid", "not_found", "Staff member not found.");
  const m = STAFF_META("staff.role.assign", `${target.name} → ${roleLabel(role)}`);
  const auth = authorize(c, "staff.role.propose", m);
  if (!auth.ok) return auth.out;
  const actor = auth.actor;
  if (reason.trim().length < 5) return bad("invalid", "validation", "A reason (or ticket) of at least 5 characters is required.", { reason: "Give a reason or ticket reference." });
  if (role === "owner") return deny(c, m, "owner_ceremony_only", "Owner cannot be assigned here. The initial Owner is created once by the audited bootstrap ceremony; ordinary staff functions cannot create, revoke or suspend an Owner.", "staff.role.propose");
  if (!ASSIGNABLE.includes(role)) return bad("invalid", "role_not_assignable", `${roleLabel(role)} is not an assignable staff role.`);
  if (target.id === actor.id) return deny(c, m, "self_assignment", "Privilege escalation blocked: you cannot assign roles to yourself. Subject and proposer cannot approve their own elevation.", "staff.role.propose");
  if (target.roles.includes("owner")) return deny(c, m, "owner_protected", "Owner accounts cannot be changed through ordinary staff administration.", "staff.role.propose");
  if (target.roles.includes(role)) return bad("noop", "already_assigned", `${target.name} already holds ${roleLabel(role)}.`);
  if (roleRank(role) > Math.max(...actor.roles.map(roleRank)) || (role === "administrator" && !actor.roles.includes("owner"))) {
    return deny(c, m, "above_ceiling", `Privilege escalation blocked: ${roleLabel(role)} is above your approved ceiling. Only an Owner may propose Administrator assignments; no one can grant authority they do not hold.`, "staff.role.propose");
  }
  const elevated = role === "administrator";
  const canApprove = authorizeQuiet(c, actor, "staff.role.approve");
  if (!elevated && canApprove) {
    applyRole(c, target, role);
    audit(c, { ...m, permission: "staff.role.approve" }, "success", `${roleLabel(role)} assigned. ${reason.trim()}`);
    return ok(`${target.name} is now ${roleLabel(role)}.`);
  }
  const req = { id: nextId(c.s, "req"), kind: "role" as const, targetId, role, reason: reason.trim(), proposerId: actor.id, status: "pending" as const, decidedBy: null, createdAt: c.s.now };
  c.s.requests.push(req);
  audit(c, { ...m, action: "staff.role.propose" }, "success", elevated ? "Administrator assignment needs an independent eligible approver (ADR-020). Request is pending." : "Proposal recorded; you hold staff.role.approve only through an Owner role or grant, so another approver must decide.");
  return ok(`Proposal ${req.id} recorded — pending an independent approver.`, req.id);
}

/** Quiet permission probe (no audit, no state change). */
function authorizeQuiet(c: Ctx, actor: StaffMember, perm: PermissionId, articleId?: string): boolean {
  return permissionSources(actor, c.s.grants, c.s.now, perm, articleId).length > 0;
}

function revokeRole(c: Ctx, targetId: string, role: RoleId, reason: string): Outcome {
  const target = staffOf(c.s, targetId);
  if (!target) return bad("invalid", "not_found", "Staff member not found.");
  const m = STAFF_META("staff.role.revoke", `${target.name} − ${roleLabel(role)}`);
  const auth = authorize(c, "staff.access.revoke", m);
  if (!auth.ok) return auth.out;
  if (reason.trim().length < 5) return bad("invalid", "validation", "A reason of at least 5 characters is required.", { reason: "Give a reason." });
  if (target.roles.includes("owner")) return deny(c, m, "owner_protected", "Owner accounts cannot be changed through ordinary staff administration (last-Owner protection and ceremony-only recovery).", "staff.access.revoke");
  if (target.id === auth.actor.id) return deny(c, m, "self_revocation", "You cannot change your own roles. Another eligible person must do it.", "staff.access.revoke");
  if (!target.roles.includes(role)) return bad("noop", "not_assigned", `${target.name} does not hold ${roleLabel(role)}.`);
  if (roleRank(role) >= Math.max(...auth.actor.roles.map(roleRank)) && !auth.actor.roles.includes("owner")) {
    return deny(c, m, "above_ceiling", "You cannot revoke a role at or above your own rank.", "staff.access.revoke");
  }
  target.roles = target.roles.filter((r) => r !== role);
  if (target.roles.length === 0) target.roles = ["user"];
  audit(c, m, "success", reason.trim());
  return ok(`${roleLabel(role)} revoked from ${target.name}.`);
}

function createGrant(c: Ctx, a: Extract<PreviewAction, { type: "staff/createGrant" }>): Outcome {
  const target = staffOf(c.s, a.targetId);
  if (!target) return bad("invalid", "not_found", "Staff member not found.");
  const m = STAFF_META("staff.grant.create", `${target.name} · ${a.permission}`);
  const auth = authorize(c, "staff.grant.propose", m);
  if (!auth.ok) return auth.out;
  const actor = auth.actor;
  const errors: Record<string, string> = {};
  if (a.reason.trim().length < 5) errors.reason = "Give a reason or ticket reference.";
  if (!Number.isFinite(a.days) || a.days < 1) errors.days = "Duration must be at least 1 day. Grants must expire.";
  if (Object.keys(errors).length) return bad("invalid", "validation", "Fix the highlighted fields.", errors);
  if (!GRANTABLE.includes(a.permission)) return deny(c, m, "not_grantable", `${a.permission} cannot be delegated by grant; it is either a role default or a non-delegable privilege.`, "staff.grant.propose");
  if (a.days > GRANT_MAX_DAYS) return deny(c, m, "grant_too_long", `Grant duration limit: ${GRANT_MAX_DAYS} days maximum (30-day default). ${a.days} days is refused; renewal is a new reviewed grant (ADR-020).`, "staff.grant.propose");
  if (target.status !== "active") return deny(c, m, "target_suspended", "Grants cannot be created for a suspended account.", "staff.grant.propose");
  if (target.roles.includes("owner")) return deny(c, m, "owner_protected", "Owner accounts are not changed through ordinary staff administration.", "staff.grant.propose");
  if (!target.roles.some((r) => r !== "user")) return deny(c, m, "no_staff_role", "A grant adds to a staff role; this account has none. Assign a role first.", "staff.grant.propose");
  if (target.id === actor.id) return deny(c, m, "self_grant", "Privilege escalation blocked: you cannot grant yourself permissions.", "staff.grant.propose");
  if (a.scope.kind === "article" && !articleOf(c.s, a.scope.articleId)) return bad("invalid", "scope", "Unknown article scope.", { scope: "Unknown article." });
  if (!authorizeQuiet(c, actor, a.permission)) {
    return deny(c, m, "above_ceiling", `Privilege escalation blocked: you do not hold ${a.permission} yourself, so you cannot delegate it. Grants cannot exceed the grantor's approved ceiling.`, "staff.grant.propose");
  }
  const elevated = ELEVATED_GRANT.includes(a.permission);
  const canApprove = authorizeQuiet(c, actor, "staff.grant.approve");
  if (!elevated && canApprove) {
    const g = { id: nextId(c.s, "gr"), subjectId: target.id, permission: a.permission, scope: a.scope, reason: a.reason.trim(), proposerId: actor.id, approverId: actor.id, startsAt: c.s.now, expiresAt: c.s.now + a.days * DAY_MS, revokedAt: null, revokedBy: null };
    c.s.grants.push(g);
    audit(c, { ...m, permission: "staff.grant.approve" }, "success", `${a.permission} @ ${scopeLabel(a.scope, (id) => articleOf(c.s, id)?.slug)} for ${a.days} day(s). ${a.reason.trim()}`);
    return ok(`Grant created for ${target.name}: ${a.permission}, ${a.days} day(s).`, g.id);
  }
  const req = { id: nextId(c.s, "req"), kind: "grant" as const, targetId: target.id, permission: a.permission, scope: a.scope, days: a.days, reason: a.reason.trim(), proposerId: actor.id, status: "pending" as const, decidedBy: null, createdAt: c.s.now };
  c.s.requests.push(req);
  audit(c, { ...m, action: "staff.grant.propose" }, "success", elevated ? "Elevated grant: an independent eligible approver must decide (subject and proposer cannot approve)." : "Proposal recorded; an eligible approver must decide.");
  return ok(`Grant proposal ${req.id} recorded — pending an independent approver.`, req.id);
}

function setGrantExpiry(c: Ctx, grantId: string, days: number): Outcome {
  const g = c.s.grants.find((x) => x.id === grantId);
  if (!g) return bad("invalid", "not_found", "Grant not found.");
  const m = STAFF_META("staff.grant.expiry", `${nameOf(c.s, g.subjectId)} · ${g.permission}`);
  const auth = authorize(c, "staff.grant.approve", m);
  if (!auth.ok) return auth.out;
  if (g.revokedAt !== null || c.s.now >= g.expiresAt) return deny(c, m, "grant_inactive", "An expired or revoked grant cannot be edited. Renewal is a new reviewed grant, not an extension.", "staff.grant.approve");
  if (!Number.isFinite(days) || days < 1) return bad("invalid", "validation", "Duration must be at least 1 day.", { days: "Enter at least 1 day." });
  if (days > GRANT_MAX_DAYS) return deny(c, m, "grant_too_long", `Grant duration limit: ${GRANT_MAX_DAYS} days maximum in total from the grant's start. ${days} days is refused; renewal is a new reviewed grant (ADR-020).`, "staff.grant.approve");
  if (g.startsAt + days * DAY_MS <= c.s.now) return bad("invalid", "validation", "That would place the expiry in the past. To end a grant now, revoke it.", { days: "Choose a later expiry, or revoke the grant." });
  if (g.subjectId === auth.actor.id) return deny(c, m, "self_grant", "You cannot change the expiry of your own grant.", "staff.grant.approve");
  const old = g.expiresAt;
  g.expiresAt = g.startsAt + days * DAY_MS;
  audit(c, m, "success", `Expiry ${old > g.expiresAt ? "shortened" : "extended"}: total duration ${days} day(s) from the grant start (maximum ${GRANT_MAX_DAYS}).`);
  return ok(`Grant total duration is now ${days} day(s) from its start.`);
}

function revokeGrant(c: Ctx, grantId: string): Outcome {
  const g = c.s.grants.find((x) => x.id === grantId);
  if (!g) return bad("invalid", "not_found", "Grant not found.");
  const m = STAFF_META("staff.grant.revoke", `${nameOf(c.s, g.subjectId)} · ${g.permission}`);
  const auth = authorize(c, "staff.access.revoke", m);
  if (!auth.ok) return auth.out;
  if (g.revokedAt !== null) return bad("noop", "already_revoked", "This grant is already revoked.");
  g.revokedAt = c.s.now;
  g.revokedBy = auth.actor.id;
  audit(c, m, "success", "Revoked. The next protected decision for the subject is denied (including in an open session).");
  return ok("Grant revoked.");
}

function suspend(c: Ctx, targetId: string, reason: string): Outcome {
  const target = staffOf(c.s, targetId);
  if (!target) return bad("invalid", "not_found", "Staff member not found.");
  const m = STAFF_META("staff.suspend", target.name);
  const auth = authorize(c, "staff.access.revoke", m);
  if (!auth.ok) return auth.out;
  if (reason.trim().length < 5) return bad("invalid", "validation", "A reason of at least 5 characters is required.", { reason: "Give a reason." });
  if (target.roles.includes("owner")) return deny(c, m, "owner_protected", "Owner accounts cannot be suspended through ordinary administration (last-Owner protection). Recovery is a separate audited ceremony.", "staff.access.revoke");
  if (target.id === auth.actor.id) return deny(c, m, "self_suspension", "You cannot suspend yourself.", "staff.access.revoke");
  if (target.status === "suspended") return bad("noop", "already_suspended", `${target.name} is already suspended.`);
  target.status = "suspended";
  target.suspendedReason = reason.trim();
  audit(c, m, "success", reason.trim());
  return ok(`${target.name} suspended. Their next protected action is denied.`);
}

function reactivate(c: Ctx, targetId: string): Outcome {
  const target = staffOf(c.s, targetId);
  if (!target) return bad("invalid", "not_found", "Staff member not found.");
  const m = STAFF_META("staff.reactivate", target.name);
  const auth = authorize(c, "staff.access.revoke", m);
  if (!auth.ok) return auth.out;
  if (target.status !== "suspended") return bad("noop", "not_suspended", `${target.name} is not suspended.`);
  if (target.id === auth.actor.id) return deny(c, m, "self_reactivation", "You cannot reactivate yourself.", "staff.access.revoke");
  target.status = "active";
  target.suspendedReason = null;
  audit(c, m, "success", "Reactivated. Existing grants keep their original expiry.");
  return ok(`${target.name} reactivated.`);
}

function decideRequest(c: Ctx, requestId: string, decision: "approve" | "reject"): Outcome {
  const req = c.s.requests.find((r) => r.id === requestId);
  if (!req) return bad("invalid", "not_found", "Request not found.");
  const target = staffOf(c.s, req.targetId);
  if (!target) return bad("invalid", "not_found", "Staff member not found.");
  const isRole = req.kind === "role";
  const m = STAFF_META(`staff.request.${decision}`, `${target.name} · ${isRole ? roleLabel(req.role) : req.permission}`);
  const auth = authorize(c, isRole ? "staff.role.approve" : "staff.grant.approve", m);
  if (!auth.ok) return auth.out;
  if (req.status !== "pending") return bad("noop", "decided", "This request was already decided.");
  if (auth.actor.id === req.proposerId) return deny(c, m, "own_proposal", "You proposed this change, so you cannot decide it. An independent eligible approver is required.", isRole ? "staff.role.approve" : "staff.grant.approve");
  if (auth.actor.id === req.targetId) return deny(c, m, "own_elevation", "You are the subject of this change; subjects cannot approve their own elevation.", isRole ? "staff.role.approve" : "staff.grant.approve");
  if (decision === "reject") { req.status = "rejected"; req.decidedBy = auth.actor.id; audit(c, m, "success", "Rejected."); return ok("Request rejected."); }
  if (target.status !== "active") return deny(c, m, "target_suspended", "The subject is suspended.", isRole ? "staff.role.approve" : "staff.grant.approve");
  if (isRole) {
    if (req.role === "administrator" && !auth.actor.roles.includes("owner") && !auth.actor.roles.includes("administrator")) return deny(c, m, "above_ceiling", "Approving an Administrator assignment is above your ceiling.", "staff.role.approve");
    applyRole(c, target, req.role);
  } else {
    c.s.grants.push({ id: nextId(c.s, "gr"), subjectId: target.id, permission: req.permission, scope: req.scope, reason: req.reason, proposerId: req.proposerId, approverId: auth.actor.id, startsAt: c.s.now, expiresAt: c.s.now + req.days * DAY_MS, revokedAt: null, revokedBy: null });
  }
  req.status = "approved";
  req.decidedBy = auth.actor.id;
  audit(c, m, "success", `Approved independently of ${nameOf(c.s, req.proposerId)}.`);
  return ok("Request approved and applied.");
}

function ownerCeremony(c: Ctx, kind: "bootstrap" | "recovery"): Outcome {
  const m: Meta = { action: kind === "bootstrap" ? "owner.bootstrap.simulated" : "owner.recovery.drill", category: "owner", targetType: "ceremony", targetLabel: kind === "bootstrap" ? "Initial Owner bootstrap" : "Lost-factor recovery drill" };
  const auth = authorize(c, "staff.role.approve", m, { critical: true });
  if (!auth.ok) return auth.out;
  if (!auth.actor.roles.includes("owner")) return deny(c, m, "owner_only", "Ceremonies are an Owner/operator matter; Administrators cannot run them.", "staff.role.approve");
  if (kind === "bootstrap") {
    return deny(c, m, "bootstrap_closed", "The one-time bootstrap path is already consumed in this simulation and cannot be re-armed from the UI. In production it needs a reviewed operator ceremony, 15-minute arm window and two witnesses.", "staff.role.approve");
  }
  c.s.ownerCeremony.lastRecoveryDrillAt = c.s.now;
  audit(c, m, "success", "Simulation only: no factor, session, Auth user or staff assignment was changed. Production recovery is an offline, two-operator, audited incident procedure.");
  return ok("Recovery drill recorded (simulation only). Nothing was changed.");
}

export const initialState = (): PreviewState => buildSeed();
export { FRESHNESS_MS, GRANT_DEFAULT_DAYS, GRANT_MAX_DAYS, sessionActive, sessionView };
