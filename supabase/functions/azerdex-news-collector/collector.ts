export type NewsSourceType = "bluepost" | "official_news" | "azerdex";
export type NewsRegion = "us" | "eu" | "global";
export type NewsCategory = "bluepost" | "official_news" | "patch_notes" | "azerdex";
export type Relevance = "relevant" | "ambiguous" | "irrelevant";
export type PublicationStatus = "published" | "review" | "rejected";
export type ThreadOrigin = "official" | "community";
export type CollectorMode = "normal" | "revision" | "backfill";

/**
 * Blizzard forum groups whose members are treated as official staff. This list is mirrored in
 * pub.news_official_groups and re-checked at the persistence boundary. A group that is not listed fails closed.
 * Staff authority is NEVER inferred from a display name or username.
 */
export const OFFICIAL_GROUPS: readonly string[] = ["community-manager", "api_users", "wow-developer"];

export interface BluepostSource {
  sourceType: "bluepost";
  sourceKey: string;
  region: "us" | "eu";
  baseUrl: string;
}

export interface OfficialNewsSource {
  sourceType: "official_news";
  sourceKey: string;
  region: "us" | "eu";
  baseUrl: string;
}

export type CollectorSource = BluepostSource | OfficialNewsSource;

export interface NormalizedNewsEntry {
  sourceType: NewsSourceType;
  sourceKey: string;
  sourceEntryId: string;
  sourceTopicId: string | null;
  sourcePostNumber: number | null;
  threadKey: string | null;
  title: string;
  canonicalUrl: string;
  author: string | null;
  region: NewsRegion;
  publishedAt: string;
  modifiedAt: string | null;
  excerpt: string;
  category: NewsCategory;
  relevance: Relevance;
  status: PublicationStatus;
  featured: boolean;
  // Provenance (Blueposts only; undefined for Official News so its content hash is unchanged).
  authorUserId?: number;
  authorGroup?: string;
  threadOrigin?: ThreadOrigin;
  observedVia?: "feed" | "topic";
  sourceVersion?: number;
  officialUpdatedAt?: string;
}

const MAX_EXCERPT_LENGTH = 420;
/** A reply shorter than this is conversational ("thanks, looking into it"), not an official update. */
export const MIN_OFFICIAL_REPLY_CHARS = 40;
/** An edit made within this window of posting is a typo fix inside the forum's grace period, not an update. */
const EDIT_GRACE_MS = 5 * 60_000;
const FOREVER_RE = /(?:world\s+of\s+warcraft|wow)\s*:?[\s-]+forever\b/i;
const PATCH_RE = /\b(?:patch\s+notes?|hotfix(?:es)?)\b/i;

function decodeHtml(value: string): string {
  return value
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39|#x27);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function excerptOf(value: unknown): string {
  const text = decodeHtml(String(value ?? ""))
    .replace(/<br\s*\/?>(?=\s*)/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= MAX_EXCERPT_LENGTH) return text;
  return `${text.slice(0, MAX_EXCERPT_LENGTH - 1).trimEnd()}…`;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function sourceUrl(path: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(path)) return new URL(path).toString();
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  const relativePath = path.replace(/^\/+/, "");
  if (path.startsWith("/") && !relativePath.startsWith(basePath.replace(/^\/+/, "") + "/")) {
    return new URL(`${basePath}/${relativePath}`, base.origin).toString();
  }
  return new URL(path, `${baseUrl.replace(/\/$/, "")}/`).toString();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function classifyRelevance(title: string, excerpt: string, _sourceType: NewsSourceType): Relevance {
  const combined = `${title} ${excerpt}`;
  if (FOREVER_RE.test(combined)) return "relevant";
  if (/\bforever\b/i.test(combined)) return "ambiguous";
  return "irrelevant";
}

function categoryFor(title: string, sourceType: NewsSourceType): NewsCategory {
  if (PATCH_RE.test(title)) return "patch_notes";
  if (sourceType === "bluepost") return "bluepost";
  if (sourceType === "official_news") return "official_news";
  return "azerdex";
}

function statusFor(relevance: Relevance): PublicationStatus {
  if (relevance === "relevant") return "published";
  if (relevance === "ambiguous") return "review";
  return "rejected";
}

// ---------------------------------------------------------------------------------------------------------------------
// Blizzard forum posts: normalisation, identity, admission.
// ---------------------------------------------------------------------------------------------------------------------

/** One forum post, normalised from either the Tracker feed or a topic JSON document. */
export interface RawPost {
  via: "feed" | "topic";
  id: string;
  topicId: string;
  postNumber: number | null;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
  userId: number | null;
  username: string | null;
  name: string | null;
  group: string | null;
  staffFlag: boolean | null;
  postType: number | null;
  hidden: boolean;
  version: number | null;
  excerpt: string;
  topicCreatedAt: string | null;
}

export function parseTrackerPosts(body: string): RawPost[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const root = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const stream = root.post_stream && typeof root.post_stream === "object"
    ? (root.post_stream as { posts?: unknown }).posts
    : undefined;
  const isTopic = Array.isArray(stream);
  const posts = isTopic ? stream as unknown[] : Array.isArray(root.posts) ? root.posts : [];
  return posts.flatMap((candidate): RawPost[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const post = candidate as Record<string, unknown>;
    const id = post.id == null ? null : String(post.id);
    const topicRaw = post.topic_id ?? (isTopic ? root.id : undefined);
    const topicId = topicRaw == null ? null : String(topicRaw);
    if (!id || !topicId || !/^\d{1,12}$/.test(topicId) || !/^\d{1,15}$/.test(id)) return [];
    const postNumber = positiveInt(post.post_number);
    const slug = stringValue(post.topic_slug) ?? (isTopic ? stringValue(root.slug) : null);
    const url = stringValue(post.url) ?? (slug && postNumber ? `/t/${slug}/${topicId}/${postNumber}` : null);
    const user = post.user && typeof post.user === "object" ? post.user as Record<string, unknown> : {};
    return [{
      via: isTopic ? "topic" : "feed",
      id,
      topicId,
      postNumber,
      title: stringValue(post.topic_title) ?? stringValue(post.topic_html_title) ?? (isTopic ? stringValue(root.title) : null),
      createdAt: isoDate(post.created_at),
      updatedAt: isoDate(post.updated_at),
      url,
      userId: positiveInt(post.user_id) ?? positiveInt(user.id),
      username: stringValue(post.username) ?? stringValue(user.username),
      name: stringValue(post.name) ?? stringValue(user.name),
      group: stringValue(post.primary_group_name) ?? stringValue(user.primary_group_name),
      staffFlag: typeof post.staff === "boolean" ? post.staff : null,
      postType: typeof post.post_type === "number" ? post.post_type : null,
      hidden: post.hidden === true || post.user_deleted === true || (post.deleted_at != null && post.deleted_at !== ""),
      version: positiveInt(post.version),
      excerpt: excerptOf(post.excerpt ?? post.cooked ?? post.raw),
      topicCreatedAt: isTopic ? isoDate(root.created_at) : null,
    }];
  });
}

export type RejectReason =
  | "invalid_metadata" | "not_regular_post" | "hidden_post" | "unverified_identity" | "group_not_allowlisted"
  | "staff_flag_false" | "origin_unverified" | "irrelevant" | "ambiguous" | "reply_too_short" | "reply_outside_coverage";

export interface AdmissionContext {
  /** Region-scoped verified staff: forum user id -> allow-listed group. Built from the Tracker feed and persisted identities. */
  staff: ReadonlyMap<number, string>;
  /** Resolved thread origins (opener authored by verified staff => "official"). */
  origins: ReadonlyMap<string, ThreadOrigin>;
  /** Replies created before this instant are not admitted unless their id is in knownPostIds (revision coverage). */
  replyNotBefore?: (topicId: string) => number | null;
  knownPostIds?: ReadonlySet<string>;
}

export type Decision = { entry: NormalizedNewsEntry } | { reject: RejectReason };

function groupAllowed(group: string | null): group is string {
  return group !== null && OFFICIAL_GROUPS.includes(group);
}

/**
 * Identity check shared by openers and replies. The numeric forum user id must have been observed (this run or earlier,
 * persisted) in THIS region's authoritative Blizzard Tracker feed with an allow-listed group, and the post itself must carry
 * that allow-listed group. Display names / usernames are never consulted.
 */
export function verifyStaffIdentity(post: RawPost, staff: ReadonlyMap<number, string>): RejectReason | null {
  if (post.userId === null) return "unverified_identity";
  if (!groupAllowed(post.group)) return "group_not_allowlisted";
  if (post.staffFlag === false) return "staff_flag_false";
  if (!staff.has(post.userId)) return "unverified_identity";
  return null;
}

export function evaluatePost(post: RawPost, source: BluepostSource, ctx: AdmissionContext): Decision {
  if (!post.title || !post.createdAt || !post.url || post.postNumber === null) return { reject: "invalid_metadata" };
  if (post.postType !== null && post.postType !== 1) return { reject: "not_regular_post" };
  if (post.hidden) return { reject: "hidden_post" };
  const identity = verifyStaffIdentity(post, ctx.staff);
  if (identity) return { reject: identity };
  const userId = post.userId as number;
  const group = post.group as string;

  const isReply = post.postNumber > 1;
  let origin: ThreadOrigin | undefined;
  let relevance: Relevance;
  if (!isReply) {
    origin = "official";
    relevance = classifyRelevance(post.title, post.excerpt, source.sourceType);
  } else {
    // Cheap, origin-independent screens first so the reject reason is the real one (a Midnight hotfix reply is "irrelevant",
    // not "origin_unverified"). Title+excerpt irrelevance implies excerpt-only irrelevance, so this never admits extra posts.
    if (post.excerpt.length < MIN_OFFICIAL_REPLY_CHARS) return { reject: "reply_too_short" };
    if (classifyRelevance(post.title, post.excerpt, source.sourceType) === "irrelevant") return { reject: "irrelevant" };
    const resolved = ctx.origins.get(post.topicId);
    if (!resolved) return { reject: "origin_unverified" };
    origin = resolved;
    // In a player-created thread the title is player-controlled text: relevance must come from the staff post itself.
    relevance = classifyRelevance(origin === "official" ? post.title : "", post.excerpt, source.sourceType);
    if (relevance === "irrelevant") return { reject: "irrelevant" };
    if (relevance === "ambiguous") return { reject: "ambiguous" };
    if (post.via === "topic" && !ctx.knownPostIds?.has(`post:${post.id}`)) {
      const notBefore = ctx.replyNotBefore?.(post.topicId);
      if (notBefore != null && Date.parse(post.createdAt) < notBefore) return { reject: "reply_outside_coverage" };
    }
  }

  const meaningfulEdit = post.via === "topic" && (post.version ?? 1) > 1 && post.updatedAt !== null
    && Date.parse(post.updatedAt) - Date.parse(post.createdAt) > EDIT_GRACE_MS;
  const title = decodeHtml(post.title);
  const entry: NormalizedNewsEntry = {
    sourceType: source.sourceType,
    sourceKey: source.sourceKey,
    sourceEntryId: `post:${post.id}`,
    sourceTopicId: `topic:${post.topicId}`,
    sourcePostNumber: post.postNumber,
    threadKey: `${source.region}:topic:${post.topicId}`,
    title,
    canonicalUrl: sourceUrl(post.url, source.baseUrl),
    author: post.name ?? post.username,
    region: source.region,
    publishedAt: post.createdAt,
    modifiedAt: post.updatedAt,
    excerpt: post.excerpt,
    category: categoryFor(title, source.sourceType),
    relevance,
    status: statusFor(relevance),
    featured: false,
    authorUserId: userId,
    authorGroup: group,
    threadOrigin: origin,
    observedVia: post.via,
  };
  if (post.version !== null && post.via === "topic") entry.sourceVersion = post.version;
  if (meaningfulEdit && post.updatedAt) entry.officialUpdatedAt = post.updatedAt;
  return { entry };
}

/** Identities attested by the region's Tracker feed (membership of the Blizzard-managed group, numeric id + allow-listed group). */
export function staffFromFeed(posts: RawPost[]): Map<number, { group: string; username: string | null }> {
  const staff = new Map<number, { group: string; username: string | null }>();
  for (const post of posts) {
    if (post.via !== "feed" || post.userId === null || !groupAllowed(post.group) || post.staffFlag === false) continue;
    staff.set(post.userId, { group: post.group, username: post.username });
  }
  return staff;
}

export interface BluepostParseOptions {
  /** Persisted, region-scoped identities in addition to those observed in the feed body itself. */
  verifiedStaff?: ReadonlyMap<number, string>;
  origins?: ReadonlyMap<string, ThreadOrigin>;
  knownPostIds?: ReadonlySet<string>;
  replyNotBefore?: (topicId: string) => number | null;
}

/**
 * Convenience parser: evaluates every post in a Tracker feed or topic document against the admission rules. For a Tracker
 * feed the identities are attested by the feed itself; for a topic document identities must come from `verifiedStaff`.
 */
export function parseBluepostFeed(body: string, source: BluepostSource, options: BluepostParseOptions = {}): NormalizedNewsEntry[] {
  const posts = parseTrackerPosts(body);
  const staff = new Map<number, string>(options.verifiedStaff ?? []);
  for (const [id, info] of staffFromFeed(posts)) staff.set(id, info.group);
  const origins = new Map<string, ThreadOrigin>(options.origins ?? []);
  for (const post of posts) {
    if (post.postNumber === 1 && !origins.has(post.topicId)) {
      origins.set(post.topicId, verifyStaffIdentity(post, staff) === null ? "official" : "community");
    }
  }
  const ctx: AdmissionContext = { staff, origins, knownPostIds: options.knownPostIds, replyNotBefore: options.replyNotBefore };
  return posts.flatMap((post) => {
    const decision = evaluatePost(post, source, ctx);
    return "entry" in decision ? [decision.entry] : [];
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Official News (unchanged behaviour).
// ---------------------------------------------------------------------------------------------------------------------

function capture(fragment: string, pattern: RegExp): string | null {
  const match = pattern.exec(fragment);
  return match?.[1] ? decodeHtml(match[1]) : null;
}

export function parseOfficialNewsFragment(body: string, source: OfficialNewsSource): NormalizedNewsEntry[] {
  const entries: NormalizedNewsEntry[] = [];
  const articlePattern = /<article\s+class="NewsBlog">([\s\S]*?)<\/article>/gi;
  for (const match of body.matchAll(articlePattern)) {
    const article = match[1] ?? "";
    const title = capture(article, /<div\s+class="NewsBlog-title">([\s\S]*?)<\/div>/i);
    const excerpt = excerptOf(capture(article, /<p\s+class="[^"]*NewsBlog-desc[^"]*">([\s\S]*?)<\/p>/i));
    const href = capture(article, /<a\s+class="[^"]*NewsBlog-link[^"]*"\s+href="([^"]+)"/i);
    const timestamp = capture(article, /data-props="\{&quot;iso8601&quot;:&quot;([^&]+)&quot;/i);
    const publishedAt = isoDate(timestamp);
    if (!title || !href || !publishedAt) continue;

    const id = /\/news\/(\d+)/i.exec(href)?.[1];
    if (!id) continue;
    const relevance = classifyRelevance(title, excerpt, source.sourceType);
    entries.push({
      sourceType: source.sourceType,
      sourceKey: source.sourceKey,
      sourceEntryId: `article:${id}`,
      sourceTopicId: null,
      sourcePostNumber: null,
      threadKey: null,
      title,
      canonicalUrl: sourceUrl(href, source.baseUrl),
      author: null,
      region: source.region,
      publishedAt,
      modifiedAt: null,
      excerpt,
      category: categoryFor(title, source.sourceType),
      relevance,
      status: statusFor(relevance),
      featured: false,
    });
  }
  return entries;
}

function isOfficialNewsFragment(body: string): boolean {
  return /<article\s+class="NewsBlog"[\s>]/i.test(body);
}

// ---------------------------------------------------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------------------------------------------------

export interface TopicCheck {
  topicId: string;
  ok: boolean;
  httpStatus?: number;
  error?: string;
  threadOrigin?: ThreadOrigin;
  openerUserId?: number;
  topicCreatedAt?: string;
}

export interface ApplySyncPayload {
  source: { sourceKey: string; sourceType: NewsSourceType; region: NewsRegion; endpointUrl: string; enabled: boolean };
  run: {
    startedAt: string;
    finishedAt: string;
    status: "succeeded" | "partial" | "failed";
    fetchedCount: number;
    acceptedCount: number;
    rejectedCount: number;
    mode: CollectorMode;
    fetchOk: boolean;
    dryRun?: boolean;
    errorCategory?: string;
    httpStatus?: number;
    diagnostics: Record<string, unknown>;
    error?: string;
    verifiedStaff?: Array<{ userId: number; username: string | null; group: string }>;
    topicChecks?: TopicCheck[];
  };
  entries: Array<NormalizedNewsEntry & { contentHash: string }>;
}

export interface ApplyResult {
  inserted: number;
  updated: number;
  skipped?: number;
  skippedUnverified?: number;
  report?: unknown;
}

export interface RevisionContext {
  verifiedStaff: Array<{ userId: number; group: string }>;
  dueTopics: Array<{
    topicId: string;
    threadOrigin: ThreadOrigin | null;
    consecutiveFailures: number;
    lastOfficialAt: string | null;
    firstSeenAt: string | null;
    officialPostIds: string[];
  }>;
  knownOrigins: Array<{ topicId: string; threadOrigin: ThreadOrigin }>;
}

export interface SyncReport {
  sourceKey: string;
  mode: CollectorMode;
  status: "succeeded" | "partial" | "failed";
  fetchedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  inserted: number;
  updated: number;
  skipped?: number;
  error?: string;
  errorCategory?: string;
  httpStatus?: number;
  dryRun?: boolean;
  rejectReasons?: Record<string, number>;
  topicChecks?: number;
  report?: unknown;
}

export interface CollectorLimits {
  /** Normal mode re-reads the Tracker feed back to this age, so an outage shorter than this self-heals. */
  feedLookbackMs: number;
  feedMaxPages: number;
  /** Due topics re-checked per revision run (also bounded server-side to 50). */
  topicBatch: number;
  /** Extra topic fetches per run to resolve the thread origin of a staff reply. */
  originLookups: number;
  topicConcurrency: number;
  topicPauseMs: number;
  /** Wall-clock budget for topic fetches; remaining topics simply stay due. */
  budgetMs: number;
  backfillMaxPages: number;
  backfillMaxTopics: number;
  fetchAttempts: number;
}

export const DEFAULT_LIMITS: CollectorLimits = {
  feedLookbackMs: 6 * 3_600_000,
  feedMaxPages: 5,
  topicBatch: 40,
  originLookups: 8,
  topicConcurrency: 3,
  topicPauseMs: 150,
  budgetMs: 90_000,
  backfillMaxPages: 80,
  backfillMaxTopics: 60,
  fetchAttempts: 3,
};

export interface CollectorOptions {
  sources: CollectorSource[];
  sourceKeys?: string[];
  fetcher?: typeof fetch;
  apply: (payload: ApplySyncPayload) => Promise<ApplyResult>;
  /** Reads due topics + persisted identities (pub_admin.news_revision_batch). Optional: absent => no persisted context. */
  loadContext?: (sourceKey: string) => Promise<RevisionContext>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  mode?: CollectorMode;
  backfill?: { since: string; until: string; dryRun: boolean };
  maxOfficialPages?: number;
  limits?: Partial<CollectorLimits>;
}

const DEFAULT_SOURCES: CollectorSource[] = [
  { sourceType: "bluepost", sourceKey: "blizzard-bluepost-us", region: "us", baseUrl: "https://us.forums.blizzard.com/en/wow" },
  { sourceType: "bluepost", sourceKey: "blizzard-bluepost-eu", region: "eu", baseUrl: "https://eu.forums.blizzard.com/en/wow" },
  { sourceType: "official_news", sourceKey: "blizzard-news-us", region: "us", baseUrl: "https://worldofwarcraft.blizzard.com/en-us" },
];

/** A source failure with a stable, low-cardinality category for monitoring. */
export class SourceError extends Error {
  constructor(message: string, readonly category: string, readonly httpStatus?: number) {
    super(message);
  }
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchText(fetcher: typeof fetch, url: string, o: { attempts: number; sleep: (ms: number) => Promise<void> }): Promise<string> {
  let lastError: SourceError = new SourceError("source_fetch_failed", "network");
  for (let attempt = 1; attempt <= o.attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetcher(url, {
        headers: { Accept: "application/json, text/html", "User-Agent": "AzerDex-News-Collector/2.0" },
        signal: controller.signal,
      });
      if (response.ok) return await response.text();
      lastError = new SourceError("source_http_" + response.status, "http_" + response.status, response.status);
      // 4xx other than 408/429 will not heal by retrying.
      if (response.status < 500 && response.status !== 429 && response.status !== 408) throw lastError;
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      if (attempt < o.attempts) await o.sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1), 10_000));
    } catch (caught) {
      if (caught instanceof SourceError) {
        if (caught.httpStatus !== undefined && caught.httpStatus < 500 && caught.httpStatus !== 429 && caught.httpStatus !== 408) throw caught;
        lastError = caught;
      } else {
        const aborted = caught instanceof Error && (caught.name === "AbortError" || /abort|timeout/i.test(caught.message));
        lastError = new SourceError(caught instanceof Error ? caught.message : "source_fetch_failed", aborted ? "timeout" : "network");
        if (attempt < o.attempts) await o.sleep(500 * 2 ** (attempt - 1));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function trackerEndpoint(source: BluepostSource, before?: string): string {
  const endpoint = source.baseUrl.replace(/\/$/, "") + "/groups/blizzard-tracker/posts.json";
  return before ? `${endpoint}?before=${encodeURIComponent(before)}` : endpoint;
}

function topicEndpoint(source: BluepostSource, topicId: string): string {
  return `${source.baseUrl.replace(/\/$/, "")}/t/${topicId}.json`;
}

function endpointFor(source: CollectorSource, page = 1): string {
  if (source.sourceType === "bluepost") return trackerEndpoint(source);
  return source.baseUrl.replace(/\/$/, "") + "/news/river.frag?page=" + page;
}

function entrySignature(entries: NormalizedNewsEntry[]): string {
  return entries.map((entry) => entry.sourceEntryId + ":" + (entry.modifiedAt ?? entry.publishedAt)).join("|");
}

/** Content hash over content that matters. Forum `updated_at` is deliberately excluded: it also moves on re-bakes. */
async function sha256(entry: NormalizedNewsEntry): Promise<string> {
  const { modifiedAt: _modifiedAt, ...content } = entry;
  const bytes = new TextEncoder().encode(JSON.stringify(content));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface FeedWindow {
  posts: RawPost[];
  pages: number;
  truncated: boolean;
  stalled: boolean;
}

/**
 * Walks the Tracker feed backwards with the `before=<created_at>` cursor (verified against the live US/EU feeds; `?page=` and
 * `?offset=` are ignored by Blizzard and return the same 20 posts forever). Stops once a page reaches `since`.
 */
async function fetchFeedWindow(
  source: BluepostSource, fetcher: typeof fetch, since: Date, until: Date | null, maxPages: number,
  net: { attempts: number; sleep: (ms: number) => Promise<void> }, pauseMs: number,
): Promise<FeedWindow> {
  const posts: RawPost[] = [];
  const seen = new Set<string>();
  let before: string | undefined = until ? new Date(until.getTime() + 1).toISOString() : undefined;
  let pages = 0;
  let truncated = false;
  let stalled = false;
  for (;;) {
    const body = await fetchText(fetcher, trackerEndpoint(source, before), net);
    let parsedRoot: unknown;
    try { parsedRoot = JSON.parse(body); } catch { throw new SourceError("source_invalid_bluepost_payload", "invalid_payload"); }
    if (!parsedRoot || typeof parsedRoot !== "object" || !Array.isArray((parsedRoot as { posts?: unknown }).posts)) {
      throw new SourceError("source_invalid_bluepost_payload", "invalid_payload");
    }
    const page = parseTrackerPosts(body);
    pages += 1;
    const fresh = page.filter((post) => !seen.has(post.id));
    if (page.length === 0) break;
    if (fresh.length === 0) { stalled = true; break; }
    for (const post of fresh) { seen.add(post.id); posts.push(post); }
    const oldest = page.reduce((min, post) => (post.createdAt && post.createdAt < min ? post.createdAt : min), page[0]?.createdAt ?? "9999");
    if (!oldest || oldest === "9999" || new Date(oldest) <= since) break;
    if (pages >= maxPages) { truncated = true; break; }
    before = oldest;
    if (pauseMs > 0) await net.sleep(pauseMs);
  }
  return { posts, pages, truncated, stalled };
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>, stop: () => boolean): Promise<void> {
  let index = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (index < items.length && !stop()) {
      const item = items[index];
      index += 1;
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(lanes);
}

interface TopicOutcome {
  check: TopicCheck;
  posts: RawPost[];
}

async function fetchTopic(source: BluepostSource, topicId: string, fetcher: typeof fetch, net: { attempts: number; sleep: (ms: number) => Promise<void> }): Promise<TopicOutcome> {
  try {
    const body = await fetchText(fetcher, topicEndpoint(source, topicId), net);
    const posts = parseTrackerPosts(body);
    if (!Array.isArray((JSON.parse(body) as { post_stream?: { posts?: unknown } }).post_stream?.posts)) {
      return { check: { topicId: `topic:${topicId}`, ok: false, error: "invalid_topic_payload" }, posts: [] };
    }
    const opener = posts.find((post) => post.postNumber === 1);
    return {
      check: { topicId: `topic:${topicId}`, ok: true, httpStatus: 200, topicCreatedAt: posts[0]?.topicCreatedAt ?? undefined, openerUserId: opener?.userId ?? undefined },
      posts,
    };
  } catch (caught) {
    const error = caught instanceof SourceError ? caught : new SourceError(caught instanceof Error ? caught.message : "topic_failed", "network");
    return { check: { topicId: `topic:${topicId}`, ok: false, httpStatus: error.httpStatus, error: error.message.slice(0, 120) }, posts: [] };
  }
}

async function collectBluepost(source: BluepostSource, options: CollectorOptions, mode: CollectorMode): Promise<SyncReport> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? realSleep;
  const limits: CollectorLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const net = { attempts: limits.fetchAttempts, sleep };
  const startedAtDate = now();
  const startedAt = startedAtDate.toISOString();
  const dryRun = mode === "backfill" ? options.backfill?.dryRun !== false : false;
  const rejectReasons: Record<string, number> = {};
  const reject = (reason: string) => { rejectReasons[reason] = (rejectReasons[reason] ?? 0) + 1; };

  const entries = new Map<string, NormalizedNewsEntry>();
  const topicChecks: TopicCheck[] = [];
  let pages = 0;
  const examinedIds = new Set<string>();
  let error: string | undefined;
  let errorCategory: string | undefined;
  let httpStatus: number | undefined;
  let fetchOk = false;
  let feed: FeedWindow = { posts: [], pages: 0, truncated: false, stalled: false };
  const staff = new Map<number, string>();
  const staffObserved = new Map<number, { group: string; username: string | null }>();
  const origins = new Map<string, ThreadOrigin>();
  let context: RevisionContext = { verifiedStaff: [], dueTopics: [], knownOrigins: [] };
  let topicFetches = 0;
  let deferredTopics = 0;
  const deadline = startedAtDate.getTime() + limits.budgetMs;

  try {
    if (options.loadContext && mode !== "backfill") {
      try {
        context = await options.loadContext(source.sourceKey);
      } catch {
        // Persisted context is an optimisation for revisions; the feed itself still attests identities.
        rejectReasons["context_unavailable"] = 1;
      }
    }
    for (const member of context.verifiedStaff) staff.set(member.userId, member.group);
    for (const known of context.knownOrigins) origins.set(known.topicId.replace(/^topic:/, ""), known.threadOrigin);

    // 1. Tracker feed window (the ONLY authoritative provenance for a new post).
    let since: Date;
    let until: Date | null = null;
    if (mode === "backfill") {
      since = new Date(options.backfill?.since ?? "");
      until = new Date(options.backfill?.until ?? "");
      if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) throw new SourceError("invalid_backfill_window", "config");
    } else {
      since = new Date(startedAtDate.getTime() - (mode === "revision" ? Math.max(limits.feedLookbackMs, 24 * 3_600_000) : limits.feedLookbackMs));
    }
    feed = await fetchFeedWindow(source, fetcher, since, until, mode === "backfill" ? limits.backfillMaxPages : limits.feedMaxPages, net, limits.topicPauseMs);
    pages = feed.pages;
    fetchOk = true;
    for (const [id, info] of staffFromFeed(feed.posts)) { staff.set(id, info.group); staffObserved.set(id, info); }

    const inWindow = feed.posts.filter((post) => {
      if (!post.createdAt) return true; // evaluatePost rejects it as invalid_metadata
      const created = Date.parse(post.createdAt);
      return created >= since.getTime() && (until === null || created <= until.getTime());
    });
    for (const post of inWindow) if (post.postNumber === 1 && post.userId !== null && !origins.has(post.topicId)) {
      origins.set(post.topicId, verifyStaffIdentity(post, staff) === null ? "official" : "community");
    }

    const admission: AdmissionContext = { staff, origins };
    const admit = (post: RawPost) => {
      examinedIds.add(post.id);
      const decision = evaluatePost(post, source, admission);
      if ("entry" in decision) {
        // Replies are persisted only when they would be published; openers keep V1 audit behaviour (rejected/review rows).
        if ((decision.entry.sourcePostNumber ?? 0) > 1 && decision.entry.status !== "published") { reject(decision.entry.relevance); return; }
        const previous = entries.get(decision.entry.sourceEntryId);
        if (!previous || (previous.observedVia === "feed" && decision.entry.observedVia === "topic")) entries.set(decision.entry.sourceEntryId, decision.entry);
        if (decision.entry.status !== "published") reject(decision.entry.relevance);
      } else {
        reject(decision.reject);
      }
    };
    const inRange = (post: RawPost) => post.createdAt !== null && Date.parse(post.createdAt) >= since.getTime()
      && (until === null || Date.parse(post.createdAt) <= until.getTime());
    /**
     * Evaluates a fetched topic document. The opener is always (re)evaluated (original topic metadata + edits). A reply is
     * admitted when it is already known (edit refresh), or newer than the topic's recorded official coverage, or - for a
     * window-bounded operation - inside the window. Nothing older is ever resurrected by a revision.
     */
    const admitTopicDoc = (topicId: string, posts: RawPost[], o: { origin: ThreadOrigin; ctx: RevisionContext["dueTopics"][number] | null; windowed: boolean }) => {
      const topicOrigins = new Map(origins);
      topicOrigins.set(topicId, o.origin);
      const anchor = o.ctx?.lastOfficialAt ?? o.ctx?.firstSeenAt ?? null;
      const topicCtx: AdmissionContext = {
        staff,
        origins: topicOrigins,
        knownPostIds: new Set((o.ctx?.officialPostIds ?? []).map((id) => `post:${id}`)),
        replyNotBefore: o.windowed ? () => since.getTime() : () => (anchor ? Date.parse(anchor) - 3_600_000 : null),
      };
      for (const post of posts) {
        if (o.windowed && post.postNumber !== 1 && !inRange(post)) continue;
        examinedIds.add(post.id);
        const decision = evaluatePost(post, source, topicCtx);
        if ("reject" in decision) { reject(`topic_${decision.reject}`); continue; }
        const isReply = (decision.entry.sourcePostNumber ?? 0) > 1;
        if (isReply && decision.entry.status !== "published") continue;
        if (!isReply && decision.entry.status !== "published" && !entries.has(decision.entry.sourceEntryId)) continue;
        entries.set(decision.entry.sourceEntryId, decision.entry);
      }
    };
    const openerIsOfficial = (posts: RawPost[]) => {
      const opener = posts.find((post) => post.postNumber === 1);
      return opener !== undefined && verifyStaffIdentity(opener, staff) === null;
    };
    const overBudget = () => mode !== "backfill" && now().getTime() > deadline;
    let rateLimited = false;
    const noteFailure = (check: TopicCheck) => { if (check.httpStatus === 429) rateLimited = true; topicChecks.push(check); };

    // 2. Resolve the origin of staff replies whose opener was not seen (bounded lookups) and complete the thread opener.
    const lookupTopics = [...new Set(inWindow
      .filter((post) => (post.postNumber ?? 0) > 1 && verifyStaffIdentity(post, staff) === null && !origins.has(post.topicId)
        && post.excerpt.length >= MIN_OFFICIAL_REPLY_CHARS && classifyRelevance(post.title ?? "", post.excerpt, "bluepost") === "relevant")
      .map((post) => post.topicId))];
    const lookupBudget = mode === "backfill" ? limits.backfillMaxTopics : limits.originLookups;
    deferredTopics += Math.max(0, lookupTopics.length - lookupBudget);
    const looked = new Set<string>();
    const lookedDocs = new Map<string, { posts: RawPost[]; origin: ThreadOrigin }>();
    await runPool(lookupTopics.slice(0, lookupBudget), limits.topicConcurrency, async (topicId) => {
      if (rateLimited) return;
      if (limits.topicPauseMs > 0) await sleep(limits.topicPauseMs);
      topicFetches += 1;
      const outcome = await fetchTopic(source, topicId, fetcher, net);
      if (!outcome.check.ok) { noteFailure(outcome.check); return; }
      const origin: ThreadOrigin = openerIsOfficial(outcome.posts) ? "official" : "community";
      origins.set(topicId, origin);
      outcome.check.threadOrigin = origin;
      topicChecks.push(outcome.check);
      looked.add(topicId);
      lookedDocs.set(topicId, { posts: outcome.posts, origin });
    }, () => rateLimited || overBudget());
    // Admission runs only now, so every reply is judged with its resolved thread origin (no phantom origin_unverified counts).
    for (const post of inWindow) admit(post);
    for (const [topicId, doc] of lookedDocs) admitTopicDoc(topicId, doc.posts, { origin: doc.origin, ctx: null, windowed: true });

    // 3. Revision: re-check due topics (persistent schedule). Backfill refreshes topics with in-window staff activity.
    const revisionTopics: Array<{ topicId: string; ctx: RevisionContext["dueTopics"][number] | null }> = [];
    if (mode === "revision") {
      for (const due of context.dueTopics.slice(0, limits.topicBatch)) revisionTopics.push({ topicId: due.topicId.replace(/^topic:/, ""), ctx: due });
    } else if (mode === "backfill") {
      // Only threads with a Forever-relevant verified staff post are worth a topic fetch (not every hotfix/PTR thread).
      const active = [...new Set(inWindow
        .filter((post) => verifyStaffIdentity(post, staff) === null && classifyRelevance(post.title ?? "", post.excerpt, "bluepost") === "relevant")
        .map((post) => post.topicId))].filter((topicId) => !looked.has(topicId));
      deferredTopics += Math.max(0, active.length - limits.backfillMaxTopics);
      for (const topicId of active.slice(0, limits.backfillMaxTopics)) revisionTopics.push({ topicId, ctx: null });
    }
    let revisionsDone = 0;
    await runPool(revisionTopics, limits.topicConcurrency, async ({ topicId, ctx }) => {
      if (rateLimited) return;
      if (limits.topicPauseMs > 0) await sleep(limits.topicPauseMs);
      topicFetches += 1;
      const outcome = await fetchTopic(source, topicId, fetcher, net);
      revisionsDone += 1;
      if (!outcome.check.ok) { noteFailure(outcome.check); return; }
      const origin: ThreadOrigin = outcome.posts.some((post) => post.postNumber === 1)
        ? (openerIsOfficial(outcome.posts) ? "official" : "community")
        : (ctx?.threadOrigin ?? "community");
      outcome.check.threadOrigin = origin;
      topicChecks.push(outcome.check);
      admitTopicDoc(topicId, outcome.posts, { origin, ctx, windowed: mode === "backfill" });
    }, () => rateLimited || overBudget());
    // Topics that were not reached (rate limit / budget) are not failures: they simply stay due for the next run.
    deferredTopics += revisionTopics.length - revisionsDone;

    const failedChecks = topicChecks.filter((check) => !check.ok);
    if (feed.stalled) { error = "feed_pagination_stalled"; errorCategory = "pagination_stalled"; }
    else if (feed.truncated) { error = "feed_window_truncated"; errorCategory = "window_truncated"; }
    else if (failedChecks.length) {
      error = `revision_topic_failures:${failedChecks.length}`;
      errorCategory = failedChecks.some((check) => check.httpStatus === 429) ? "http_429" : "revision_topic_failures";
      httpStatus = failedChecks.find((check) => check.httpStatus)?.httpStatus;
    }
  } catch (caught) {
    if (caught instanceof SourceError) {
      error = caught.message; errorCategory = caught.category; httpStatus = caught.httpStatus;
    } else {
      error = caught instanceof Error ? caught.message : "source_fetch_failed"; errorCategory = "network";
    }
    if (!feed.posts.length) fetchOk = false;
  }

  const examined = examinedIds.size;
  for (const [id, info] of staffObserved) staff.set(id, info.group);
  const finishedAt = now().toISOString();
  const toApply = [...entries.values()];
  const accepted = toApply.filter((entry) => entry.status === "published").length;
  const rejected = Math.max(0, examined - accepted);
  const hashed = await Promise.all(toApply.map(async (entry) => ({ ...entry, contentHash: await sha256(entry) })));
  const status: ApplySyncPayload["run"]["status"] = error ? (toApply.length || fetchOk ? "partial" : "failed") : "succeeded";
  const diagnostics: Record<string, unknown> = {
    pages, mode, topicFetches, deferredTopics, rejectReasons, feedPosts: feed.posts.length,
    ...(mode === "backfill" ? { since: options.backfill?.since, until: options.backfill?.until, dryRun } : {}),
    ...(error ? { error } : {}),
  };
  const payload: ApplySyncPayload = {
    source: { sourceKey: source.sourceKey, sourceType: source.sourceType, region: source.region, endpointUrl: endpointFor(source), enabled: true },
    run: {
      startedAt, finishedAt, status, fetchedCount: examined, acceptedCount: accepted, rejectedCount: rejected, mode, fetchOk, dryRun,
      ...(errorCategory ? { errorCategory } : {}), ...(httpStatus ? { httpStatus } : {}), diagnostics,
      ...(error ? { error } : {}),
      verifiedStaff: [...staffObserved].map(([userId, info]) => ({ userId, username: info.username, group: info.group })),
      topicChecks,
    },
    entries: hashed,
  };
  const report = (result: Partial<ApplyResult>, failure?: { error: string; category: string }): SyncReport => ({
    sourceKey: source.sourceKey, mode, status: failure ? "failed" : status, fetchedCount: examined, acceptedCount: accepted,
    rejectedCount: rejected, inserted: result.inserted ?? 0, updated: result.updated ?? 0, skipped: result.skipped,
    error: failure?.error ?? error, errorCategory: failure?.category ?? errorCategory, httpStatus, dryRun: mode === "backfill" ? dryRun : undefined,
    rejectReasons, topicChecks: topicChecks.length, report: result.report,
  });

  // A failed fetch with nothing to persist is still audited (so monitoring can see the failure), best effort.
  try {
    const result = await options.apply(mode === "backfill" && !dryRun ? payload : mode === "backfill" ? { ...payload, run: { ...payload.run, dryRun: true } } : payload);
    return report(result);
  } catch (caught) {
    if (!fetchOk && error) return report({}); // the source error is the root cause; the audit write is best effort
    const applyError = caught instanceof Error ? caught.message.slice(0, 160) : "news_persistence_failed";
    return report({}, { error: applyError, category: "persistence_failed" });
  }
}

async function collectOfficial(source: OfficialNewsSource, options: CollectorOptions, mode: CollectorMode): Promise<SyncReport> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? realSleep;
  const net = { attempts: { ...DEFAULT_LIMITS, ...options.limits }.fetchAttempts, sleep };
  const startedAt = now().toISOString();
  const all: NormalizedNewsEntry[] = [];
  let pages = 0;
  let error: string | undefined;
  let errorCategory: string | undefined;
  let httpStatus: number | undefined;
  try {
    const maxPages = options.maxOfficialPages ?? 3;
    let previousSignature = "";
    for (let page = 1; page <= maxPages; page += 1) {
      const body = await fetchText(fetcher, endpointFor(source, page), net);
      if (!isOfficialNewsFragment(body)) throw new SourceError("source_invalid_official_news_payload", "invalid_payload");
      const entries = parseOfficialNewsFragment(body, source);
      if (entries.length === 0) throw new SourceError("source_unparseable_official_news_payload", "invalid_payload");
      const signature = entrySignature(entries);
      if (signature === previousSignature) break;
      previousSignature = signature;
      all.push(...entries);
      pages += 1;
      if (entries.length < 20) break;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "source_fetch_failed";
    errorCategory = caught instanceof SourceError ? caught.category : "network";
    httpStatus = caught instanceof SourceError ? caught.httpStatus : undefined;
  }
  const unique = [...new Map(all.map((entry) => [entry.sourceEntryId, entry])).values()];
  const accepted = unique.filter((entry) => entry.status === "published").length;
  const rejected = unique.length - accepted;
  const hashed = await Promise.all(unique.map(async (entry) => ({ ...entry, contentHash: await sha256(entry) })));
  const status: ApplySyncPayload["run"]["status"] = error ? (unique.length ? "partial" : "failed") : "succeeded";
  const base = { sourceKey: source.sourceKey, mode, fetchedCount: unique.length, acceptedCount: accepted, rejectedCount: rejected };
  try {
    const result = await options.apply({
      source: { sourceKey: source.sourceKey, sourceType: source.sourceType, region: source.region, endpointUrl: endpointFor(source), enabled: true },
      run: {
        startedAt, finishedAt: now().toISOString(), status, fetchedCount: unique.length, acceptedCount: accepted, rejectedCount: rejected,
        mode, fetchOk: !error || unique.length > 0, diagnostics: { pages, mode, ...(error ? { error } : {}) },
        ...(errorCategory ? { errorCategory } : {}), ...(httpStatus ? { httpStatus } : {}), ...(error ? { error } : {}),
      },
      entries: hashed,
    });
    return { ...base, status, inserted: result.inserted, updated: result.updated, ...(error ? { error, errorCategory, httpStatus } : {}) };
  } catch (caught) {
    if (error) return { ...base, status, inserted: 0, updated: 0, error, errorCategory, httpStatus };
    return { ...base, status: "failed", inserted: 0, updated: 0, error: caught instanceof Error ? caught.message.slice(0, 160) : "news_persistence_failed", errorCategory: "persistence_failed" };
  }
}

export async function collectNews(options: CollectorOptions): Promise<SyncReport[]> {
  const configured = options.sources.length ? options.sources : DEFAULT_SOURCES;
  const sources = options.sourceKeys?.length
    ? configured.filter((source) => options.sourceKeys?.includes(source.sourceKey))
    : configured;
  const mode = options.mode ?? "normal";
  const reports: SyncReport[] = [];
  for (const source of sources) {
    // Backfill is a forum-Tracker operation; Official News has no per-post provenance problem and is not backfilled.
    if (mode === "backfill" && source.sourceType !== "bluepost") continue;
    reports.push(source.sourceType === "bluepost" ? await collectBluepost(source, options, mode) : await collectOfficial(source, options, mode));
  }
  return reports;
}
