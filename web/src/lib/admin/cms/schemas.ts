import { z } from "@/lib/zod";

/**
 * ADM-04 shared (isomorphic, no I/O) vocabulary of the Admin CMS adapter: the strict input schemas for the seven protected
 * actions and the strict output schemas of the ADM-03B/ADM-04 database RPCs. Anything outside these shapes never reaches the
 * browser and nothing the browser sends reaches the database unvalidated. The limits here are the DATABASE limits (0025
 * canonical_snapshot) or stricter; the database remains the authority and re-validates every call.
 */
export const BODY_MAX_CHARS = 50_000; // the database allows 100 000; the stricter cap keeps a JSON request under the proxy's buffer
export const NOTE_MAX = 2000;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const ts = z.string().min(10).max(40);
const text = (min: number, max: number) => z.string().min(min).max(max);

/** Safe link: https only, no whitespace, bounded (database: ^https://[^[:space:]]+$ and <= 308 characters). */
export const SAFE_LINK = /^https:\/\/[^\s<>"'`\\]+$/;

export const snapshotInput = z
  .object({
    title: text(3, 120),
    summary: text(20, 200),
    body_markdown: text(1, BODY_MAX_CHARS),
    classification: z.enum(["normal", "highlighted"]),
    featured: z.boolean().optional(),
    sample: z.boolean().optional(),
    byline: text(2, 60).optional(),
    category: text(2, 40).optional(),
    seo_description: text(20, 200).optional(),
    tags: z.array(z.string().regex(/^[a-z0-9-]{2,30}$/)).max(10).optional(),
    related_links: z.array(z.string().max(308).regex(SAFE_LINK)).max(6).optional(),
    images: z.array(z.object({ asset_id: uuid, alt: text(3, 200) }).strict()).max(10).optional(),
  })
  .strict()
  .refine((s) => !/<[a-z/!][^>]*>/i.test(s.body_markdown), { message: "raw_html", path: ["body_markdown"] })
  .refine((s) => !/(javascript:|data:)/i.test(s.body_markdown), { message: "unsafe_scheme", path: ["body_markdown"] })
  .refine((s) => !(s.featured && s.classification !== "highlighted"), { message: "featured_must_be_highlighted", path: ["classification"] });
export type SnapshotInput = z.infer<typeof snapshotInput>;

/** `requestId` is the idempotency key of ONE user intent: the browser keeps it until the outcome is known and reuses it on retry. */
const requestId = uuid;
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const ACTION_INPUT = {
  create: z.object({ requestId, slug: z.string().min(3).max(80).regex(SLUG), snapshot: snapshotInput }).strict(),
  edit: z.object({ requestId, articleId: uuid, revisionId: uuid, snapshot: snapshotInput }).strict(),
  submit: z.object({ requestId, articleId: uuid, revisionId: uuid }).strict(),
  review: z.object({ requestId, articleId: uuid, revisionId: uuid, decision: z.enum(["return", "reject"]), note: text(5, NOTE_MAX).refine((n) => n.trim().length >= 5, { message: "note_too_short" }) }).strict(),
  approve: z.object({ requestId, articleId: uuid, revisionId: uuid }).strict(),
  publish: z.object({ requestId, articleId: uuid, revisionId: uuid }).strict(),
  unpublish: z.object({ requestId, articleId: uuid }).strict(),
} as const;
export type ActionName = keyof typeof ACTION_INPUT;
export type ActionInput<A extends ActionName> = z.infer<(typeof ACTION_INPUT)[A]>;
export const ACTION_NAMES = Object.keys(ACTION_INPUT) as ActionName[];

/** Read-only calls the browser may request through the same CSRF-protected endpoint family. */
export const READ_INPUT = {
  revision: z.object({ articleId: uuid, revisionId: uuid }).strict(),
} as const;

// ---------------------------------------------------------------------------------------------------------
// RPC outputs (strict: an unexpected column fails closed instead of reaching the browser)
// ---------------------------------------------------------------------------------------------------------
// The first six are the ADM-03B states. The last three exist only once the ADM-03C delivery ledger is installed (its migration widens the check
// constraint); they are accepted so the UI keeps working when that dependency lands, and an unknown value still fails closed.
export const REVIEW_STATE = z.enum(["draft", "in_review", "approved", "rejected", "publish_pending", "unpublish_pending", "published", "unpublished", "delivery_failed"]);
export type ReviewState = z.infer<typeof REVIEW_STATE>;
export const DELIVERY_STATE = z.enum(["blocked", "eligible", "claimed", "delivered", "retryable", "cancelled", "superseded"]);
export type DeliveryState = z.infer<typeof DELIVERY_STATE>;

const delivery = z
  .object({
    state: DELIVERY_STATE,
    attempt: z.number().int().nonnegative(),
    compensation: z.boolean(),
    error_code: z.string().nullable(),
    applied_at: ts.nullable(),
    updated_at: ts.nullable(),
  })
  .strict();

export const snapshotOutput = z
  .object({
    title: z.string(),
    summary: z.string(),
    body_markdown: z.string(),
    byline: z.string(),
    category: z.string(),
    tags: z.array(z.string()),
    classification: z.enum(["normal", "highlighted"]),
    featured: z.boolean(),
    sample: z.boolean(),
    seo_description: z.string(),
    images: z.array(z.object({}).passthrough()),
    related_links: z.array(z.string()),
  })
  .strict();
export type SnapshotOutput = z.infer<typeof snapshotOutput>;

export const contextOutput = z
  .object({ user_id: uuid, can_create: z.boolean(), can_read: z.boolean(), can_read_audit: z.boolean() })
  .strict();
export type CmsContext = z.infer<typeof contextOutput>;

const latestIntent = z.object({ intent_id: uuid, kind: z.enum(["publish", "unpublish"]), generation: z.number().int(), created_at: ts, delivery }).strict();
export const listItem = z
  .object({
    article_id: uuid,
    slug: z.string(),
    review_state: REVIEW_STATE,
    classification_floor: z.union([z.literal(0), z.literal(1)]),
    generation: z.number().int(),
    current_revision_id: uuid,
    published_revision_id: uuid.nullable(),
    revision_no: z.number().int(),
    title: z.string(),
    summary: z.string(),
    category: z.string(),
    classification: z.enum(["normal", "highlighted"]),
    featured: z.boolean(),
    updated_at: ts,
    created_by: uuid,
    created_at: ts,
    latest_intent: latestIntent.nullable(),
  })
  .strict();
export type ListItem = z.infer<typeof listItem>;
export const listOutput = z.array(listItem).max(100);

export const detailOutput = z
  .object({
    article: z
      .object({
        article_id: uuid,
        slug: z.string(),
        origin: z.enum(["manual", "legacy_git"]),
        review_state: REVIEW_STATE,
        classification_floor: z.union([z.literal(0), z.literal(1)]),
        generation: z.number().int(),
        current_revision_id: uuid,
        published_revision_id: uuid.nullable(),
        revision_no: z.number().int(),
        snapshot_hash: hex64,
        snapshot: snapshotOutput,
        created_by: uuid,
        created_at: ts,
      })
      .strict(),
    permitted: z.object({ edit: z.boolean(), submit: z.boolean(), review: z.boolean(), approve: z.boolean(), publish: z.boolean(), unpublish: z.boolean() }).strict(),
    revisions: z
      .array(
        z
          .object({
            revision_id: uuid,
            revision_no: z.number().int(),
            parent_revision_id: uuid.nullable(),
            snapshot_hash: hex64,
            effective_classification: z.union([z.literal(0), z.literal(1)]),
            created_by: uuid,
            created_at: ts,
            title: z.string(),
            contributors: z.array(z.object({ actor_id: uuid, contribution: z.enum(["author", "substantive_editor"]) }).strict()),
          })
          .strict(),
      )
      .max(500),
    reviews: z
      .array(z.object({ event_id: uuid, revision_id: uuid, decision: z.enum(["submit", "return", "reject", "approve_highlighted"]), actor_id: uuid, note: z.string(), occurred_at: ts, revision_hash: hex64 }).strict())
      .max(2000),
    approvals: z
      .array(z.object({ approval_id: uuid, revision_id: uuid, approver_id: uuid, approved_at: ts, grant_bound: z.boolean(), consumed: z.boolean() }).strict())
      .max(500),
    intents: z
      .array(z.object({ intent_id: uuid, kind: z.enum(["publish", "unpublish"]), generation: z.number().int(), revision_id: uuid.nullable(), requested_by: uuid, created_at: ts, delivery }).strict())
      .max(500),
  })
  .strict();
export type ArticleDetail = z.infer<typeof detailOutput>;

export const revisionOutput = z
  .object({
    revision_id: uuid,
    article_id: uuid,
    revision_no: z.number().int(),
    parent_revision_id: uuid.nullable(),
    snapshot_hash: hex64,
    snapshot: snapshotOutput,
    effective_classification: z.union([z.literal(0), z.literal(1)]),
    created_by: uuid,
    created_at: ts,
  })
  .strict();
export type RevisionRead = z.infer<typeof revisionOutput>;

export const auditEvent = z
  .object({
    event_no: z.number().int(),
    occurred_at: ts,
    actor_id: uuid.nullable(),
    action_key: z.string(),
    resource_key: z.string(),
    outcome: z.enum(["success", "denied"]),
    decision: z.enum(["allow", "deny"]),
    request_id: uuid,
    reason: z.string(),
    detail: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AuditEvent = z.infer<typeof auditEvent>;
export const auditOutput = z.array(auditEvent).max(100);
export const uuidOutput = uuid;
