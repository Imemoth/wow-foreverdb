import { DAY_MS } from "./policy";
import { canonicalJson, sha256Hex } from "./sha256";
import { effectiveClassification } from "./content";
import type { Approval, Article, ArticleSnapshot, AuditEvent, Contributor, Grant, PreviewState, PublicationIntent, ReviewState, Revision, StaffMember, StaffRequest } from "./types";

/** The preview clock starts here and only moves when the user acts or advances it. It is NOT wall-clock time. */
export const PREVIEW_EPOCH = Date.UTC(2026, 10, 12, 9, 0, 0);

export const hashSnapshot = (s: ArticleSnapshot): string => sha256Hex(canonicalJson(s));

const staff = (id: string, name: string, roles: StaffMember["roles"], note: string, status: StaffMember["status"] = "active", suspendedReason: string | null = null): StaffMember =>
  ({ id, name, handle: `${id.replace("st-", "")}@synthetic.invalid`, roles, status, suspendedReason, note });

export const SEED_STAFF: StaffMember[] = [
  staff("st-selene", "Selene Ashvale", ["owner", "editor"], "Synthetic Owner (also an Editor, so she can author — and demonstrate that Owner cannot self-approve)."),
  staff("st-aldric", "Aldric Voss", ["administrator"], "Synthetic Administrator with a delegated staff.role.approve grant."),
  staff("st-brenna", "Brenna Holt", ["administrator"], "Synthetic Administrator, no delegated grants."),
  staff("st-mira", "Mira Fennick", ["editor"], "Synthetic Editor, no publishing grant."),
  staff("st-tomas", "Tomas Quill", ["editor"], "Synthetic Editor with a scoped, expiring publishing grant."),
  staff("st-isolde", "Isolde Marrow", ["editor"], "Synthetic Editor with a highlighted-approval grant."),
  staff("st-garrick", "Garrick Dunn", ["moderator"], "Synthetic Moderator."),
  staff("st-corin", "Corin Vale", ["editor"], "Synthetic Editor — suspended.", "suspended", "Access review lapsed (synthetic)."),
  staff("st-pip", "Pip Larkwood", ["user"], "Synthetic ordinary account. Not staff: Admin access is denied."),
];

const snap = (p: Partial<ArticleSnapshot> & Pick<ArticleSnapshot, "title" | "summary" | "body">): ArticleSnapshot => ({
  byline: "AzerDex Editorial", category: "Announcements", tags: [], classification: "normal", featured: false, coverMediaId: null, coverAlt: "", seoDescription: "", ...p,
});

interface RevSpec { s: ArticleSnapshot; by: string; day: number; state: ReviewState; note?: string }
interface ArtSpec {
  n: number; slug: string; createdBy: string; revs: RevSpec[];
  published?: number; delivery: Article["delivery"]; approval?: { rev: number; by: string }; unusedApproval?: boolean;
}

const BODY_CENSUS = `## What we observed

AzerDex Companion contributors reported **412 realm-population samples** this week. Populations are *observed*, never official.

- Sampling window: 7 days
- Contributors: 38 synthetic accounts
- Confidence: medium

> Synthetic preview content — not a real AzerDex article.`;
const BODY_CENSUS_V2 = `## What we observed

AzerDex Companion contributors reported **455 realm-population samples** this week. Populations are *observed*, never official.

- Sampling window: 7 days
- Contributors: 41 synthetic accounts
- Confidence: medium-high

### Method notes

Samples below five contributors per realm are dropped.

> Synthetic preview content — not a real AzerDex article.`;

const ARTS: ArtSpec[] = [
  { n: 1, slug: "realm-population-census", createdBy: "st-mira", delivery: "published", published: 1, revs: [
    { s: snap({ title: "Realm population census: week 46", summary: "Observed realm populations from Companion contributors, with honest sample sizes.", body: BODY_CENSUS, category: "Data & Methodology", tags: ["census", "realms"], byline: "Mira Fennick" }), by: "st-mira", day: -9, state: "approved" },
    { s: snap({ title: "Realm population census: week 46", summary: "Observed realm populations from Companion contributors, with honest sample sizes and method notes.", body: BODY_CENSUS_V2, category: "Data & Methodology", tags: ["census", "realms", "method"], byline: "Mira Fennick" }), by: "st-tomas", day: -1, state: "draft" },
  ] },
  { n: 2, slug: "winter-veil-event-schedule", createdBy: "st-isolde", delivery: "never_published", revs: [
    { s: snap({ title: "Winter Veil event schedule and rewards", summary: "Everything we know about this year's Winter Veil: dates, vendors, and observed reward tables.", body: "## Schedule\n\nWinter Veil starts on the **15th** and runs for two weeks.\n\n## Rewards\n\nObserved reward tables are listed below with sample sizes.\n\n- Greatfather Winter's gift\n- Smokywood Pastures vendor", category: "Announcements", tags: ["winter-veil", "events"], byline: "Isolde Marrow", classification: "highlighted", featured: true, coverMediaId: "media-compass", coverAlt: "An eight-point arcane compass rose" }), by: "st-isolde", day: -2, state: "in_review" },
  ] },
  { n: 3, slug: "collector-methodology-notes", createdBy: "st-tomas", delivery: "never_published", revs: [
    { s: snap({ title: "How the Collector counts observations", summary: "A short explainer on sample sizes, confidence labels and what AzerDex does not claim.", body: "## Counting\n\nEvery observation is attributed to a client session, deduplicated, and shown with its sample size.\n\n## What we do not claim\n\nObserved rates are not official drop rates.", category: "Data & Methodology", tags: ["methodology"], byline: "Tomas Quill" }), by: "st-tomas", day: -3, state: "draft" },
  ] },
  { n: 4, slug: "bluepost-digest-week-46", createdBy: "st-mira", delivery: "never_published", revs: [
    { s: snap({ title: "Blue post digest: week 46", summary: "A plain-language digest of this week's official Blizzard posts, linking to the originals.", body: "## This week\n\nThree official posts touched Classic realms. We link to every original and add no speculation.\n\n1. Realm maintenance windows\n2. Event scheduling notes\n3. Support policy reminder", category: "Community", tags: ["digest", "blue-posts"], byline: "Mira Fennick", coverMediaId: "media-ember-vale", coverAlt: "Ember Vale panorama render" }), by: "st-mira", day: -4, state: "approved" },
  ] },
  { n: 5, slug: "emergency-maintenance-notice", createdBy: "st-mira", delivery: "published", published: 1, approval: { rev: 1, by: "st-brenna" }, revs: [
    { s: snap({ title: "Emergency maintenance: Ember Vale data refresh", summary: "AzerDex database pages may show stale observations for roughly two hours during a refresh.", body: "## What is happening\n\nWe are refreshing the Ember Vale observation set. Pages stay online but may show older samples until the refresh completes.\n\nNo account data is affected.", category: "Maintenance", tags: ["maintenance"], byline: "Mira Fennick", classification: "highlighted", featured: true }), by: "st-mira", day: -14, state: "approved" },
  ] },
  { n: 6, slug: "retired-beta-signup-notice", createdBy: "st-tomas", delivery: "unpublished", revs: [
    { s: snap({ title: "Beta sign-up notice (retired)", summary: "The closed beta sign-up notice, retained privately after unpublishing.", body: "## Beta\n\nSign-ups are closed. This notice was unpublished and its history is retained privately for audit.", category: "Announcements", tags: ["beta"], byline: "Tomas Quill" }), by: "st-tomas", day: -20, state: "approved" },
  ] },
  { n: 7, slug: "class-tuning-speculation", createdBy: "st-mira", delivery: "never_published", revs: [
    { s: snap({ title: "Speculation on upcoming class tuning", summary: "A speculative piece on class tuning that the review rejected for lacking sources.", body: "## Rumours\n\nWe heard some things from somewhere. None of it is sourced, which is exactly why this revision was rejected.", category: "Community", tags: ["rumours"], byline: "Mira Fennick" }), by: "st-mira", day: -6, state: "rejected", note: "No sources. AzerDex does not publish unsourced rumours." },
  ] },
];

export function buildSeed(): PreviewState {
  const revisions: Revision[] = [];
  const articles: Article[] = [];
  const approvals: Approval[] = [];
  const intents: PublicationIntent[] = [];
  const approvalUses: PreviewState["approvalUses"] = [];
  const audit: AuditEvent[] = [];
  let aseq = 0;
  const log = (at: number, actorId: string, action: string, category: AuditEvent["category"], targetLabel: string, permission: AuditEvent["permission"], result: AuditEvent["result"] = "success", reason: string | null = null): void => {
    aseq++;
    audit.push({ id: `aud-seed-${String(aseq).padStart(3, "0")}`, at, actorId, actorName: SEED_STAFF.find((x) => x.id === actorId)?.name ?? actorId, category, action, targetType: category === "editorial" ? "article" : "staff", targetLabel, result, permission, correlationId: `PV-S${String(aseq).padStart(4, "0")}`, reason, previewOnly: true, seeded: true });
  };
  for (const a of ARTS) {
    const aid = `art-${a.n}`;
    const contributors: Contributor[] = [];
    let floor: Article["classificationFloor"] = "normal";
    a.revs.forEach((r, i) => {
      const no = i + 1;
      const rid = `${aid}-r${no}`;
      const at = PREVIEW_EPOCH + r.day * DAY_MS;
      revisions.push({ id: rid, articleId: aid, no, parentId: no > 1 ? `${aid}-r${no - 1}` : null, snapshot: Object.freeze({ ...r.s }), hash: hashSnapshot(r.s), createdBy: r.by, createdAt: at, restoredFromRevisionId: null, state: r.state, note: r.note ?? null });
      contributors.push({ actorId: r.by, revisionId: rid, kind: no === 1 ? "author" : "editor" });
      if (effectiveClassification(r.s) === "highlighted") floor = "highlighted";
      log(at, r.by, no === 1 ? "article.create" : "article.revision.create", "editorial", `${a.slug} · r${no}`, "news.draft.write");
    });
    const head = `${aid}-r${a.revs.length}`;
    articles.push({
      id: aid, slug: a.slug, origin: "manual", currentRevisionId: head, publishedRevisionId: a.published ? `${aid}-r${a.published}` : null,
      delivery: a.delivery, generation: a.delivery === "never_published" ? 0 : a.delivery === "unpublished" ? 2 : 1, classificationFloor: floor, createdBy: a.createdBy,
      createdAt: PREVIEW_EPOCH + a.revs[0]!.day * DAY_MS, contributors,
    });
    if (a.approval) {
      const rev = revisions.find((x) => x.id === `${aid}-r${a.approval!.rev}`)!;
      const ap: Approval = { id: `apr-seed-${a.n}`, articleId: aid, revisionId: rev.id, hash: rev.hash, classification: "highlighted", approverId: a.approval.by, at: rev.createdAt + DAY_MS / 4, policyVersion: "proposed-v0 (preview)" };
      approvals.push(ap);
      log(ap.at, ap.approverId, "article.approve", "editorial", `${a.slug} · r${rev.no}`, "news.article.approve_highlighted");
      intents.push({ id: `int-seed-${a.n}`, articleId: aid, generation: 1, action: "publish", revisionId: rev.id, actorId: "st-selene", approvalId: ap.id, status: "delivered", createdAt: ap.at + 3_600_000 });
      approvalUses.push({ approvalId: ap.id, intentId: `int-seed-${a.n}` });
      log(ap.at + 3_600_000, "st-selene", "article.publish", "editorial", `${a.slug} · r${rev.no}`, "news.article.publish");
    } else if (a.delivery === "published") {
      const rev = revisions.find((x) => x.id === `${aid}-r${a.published}`)!;
      intents.push({ id: `int-seed-${a.n}`, articleId: aid, generation: 1, action: "publish", revisionId: rev.id, actorId: "st-selene", approvalId: null, status: "delivered", createdAt: rev.createdAt + DAY_MS });
      log(rev.createdAt + DAY_MS, "st-selene", "article.publish", "editorial", `${a.slug} · r${rev.no}`, "news.article.publish");
    } else if (a.delivery === "unpublished") {
      log(PREVIEW_EPOCH - 12 * DAY_MS, "st-selene", "article.unpublish", "editorial", `${a.slug} · r1`, "news.article.unpublish");
    }
  }
  log(PREVIEW_EPOCH - 2 * DAY_MS, "st-pip", "session.sign_in", "session", "Pip Larkwood", "admin.enter", "denied", "No staff role: access denied.");
  log(PREVIEW_EPOCH - 5 * DAY_MS, "st-selene", "staff.suspend", "staff", "Corin Vale", "staff.access.revoke", "success", "Access review lapsed (synthetic).");
  audit.sort((x, y) => x.at - y.at);

  const grants: Grant[] = [
    { id: "gr-tomas-publish", subjectId: "st-tomas", permission: "news.article.publish", scope: { kind: "collection", key: "news" }, reason: "Delegated self-publishing of normal articles (synthetic ticket ED-101).", proposerId: "st-selene", approverId: "st-selene", startsAt: PREVIEW_EPOCH - 10 * DAY_MS, expiresAt: PREVIEW_EPOCH + 20 * DAY_MS, revokedAt: null, revokedBy: null },
    { id: "gr-isolde-approve", subjectId: "st-isolde", permission: "news.article.approve_highlighted", scope: { kind: "collection", key: "news" }, reason: "Independent highlighted approver (synthetic ticket ED-102).", proposerId: "st-aldric", approverId: "st-selene", startsAt: PREVIEW_EPOCH - 45 * DAY_MS, expiresAt: PREVIEW_EPOCH + 45 * DAY_MS, revokedAt: null, revokedBy: null },
    { id: "gr-aldric-roleapprove", subjectId: "st-aldric", permission: "staff.role.approve", scope: { kind: "collection", key: "staff" }, reason: "Second eligible approver for staff changes (synthetic ticket SEC-7).", proposerId: "st-selene", approverId: "st-selene", startsAt: PREVIEW_EPOCH - 30 * DAY_MS, expiresAt: PREVIEW_EPOCH + 60 * DAY_MS, revokedAt: null, revokedBy: null },
    { id: "gr-tomas-audit", subjectId: "st-tomas", permission: "audit.editorial.read", scope: { kind: "collection", key: "audit" }, reason: "Short-lived audit visibility (synthetic).", proposerId: "st-aldric", approverId: "st-selene", startsAt: PREVIEW_EPOCH - 25 * DAY_MS, expiresAt: PREVIEW_EPOCH + 5 * DAY_MS, revokedAt: null, revokedBy: null },
    { id: "gr-mira-publish-expired", subjectId: "st-mira", permission: "news.article.publish", scope: { kind: "article", articleId: "art-4" }, reason: "One-off publish of the digest (expired, synthetic).", proposerId: "st-selene", approverId: "st-selene", startsAt: PREVIEW_EPOCH - 40 * DAY_MS, expiresAt: PREVIEW_EPOCH - 10 * DAY_MS, revokedAt: null, revokedBy: null },
  ];
  const requests: StaffRequest[] = [
    { id: "req-seed-1", kind: "role", targetId: "st-garrick", role: "editor", reason: "Garrick is moving from moderation to editorial (synthetic ticket HR-3).", proposerId: "st-brenna", status: "pending", decidedBy: null, createdAt: PREVIEW_EPOCH - DAY_MS },
  ];
  return {
    version: 1, now: PREVIEW_EPOCH, seq: 100,
    session: { status: "signed_out", personaId: null, mfaVerifiedAt: null, mfaFailures: 0, deniedReason: null },
    staff: SEED_STAFF.map((s) => ({ ...s, roles: [...s.roles] })), grants, requests, articles, revisions, approvals, approvalUses, intents, audit,
    ownerCeremony: { bootstrapConsumed: true, lastRecoveryDrillAt: null },
  };
}
