export type NewsSourceType = "bluepost" | "official_news" | "azerdex";
export type NewsRegion = "us" | "eu" | "global";
export type NewsCategory = "bluepost" | "official_news" | "patch_notes" | "azerdex";
export type Relevance = "relevant" | "ambiguous" | "irrelevant";
export type PublicationStatus = "published" | "review" | "rejected";

export interface BluepostSource {
  sourceType: "bluepost";
  sourceKey: string;
  region: "us" | "eu";
  baseUrl: string;
}

export interface BluepostParseOptions {
  /** Post IDs observed in the authoritative Blizzard Tracker feed. */
  authoritativePostIds?: ReadonlySet<string>;
}

export interface OfficialNewsSource {
  sourceType: "official_news";
  sourceKey: string;
  region: "us" | "eu";
  baseUrl: string;
}

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
}

const MAX_EXCERPT_LENGTH = 420;
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

export function classifyRelevance(title: string, excerpt: string, sourceType: NewsSourceType): Relevance {
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

export function parseBluepostFeed(body: string, source: BluepostSource, options: BluepostParseOptions = {}): NormalizedNewsEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const root = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const streamPosts = root.post_stream && typeof root.post_stream === "object"
    && Array.isArray((root.post_stream as { posts?: unknown }).posts)
    ? (root.post_stream as { posts: unknown[] }).posts.map((post) => ({
      ...(post && typeof post === "object" ? post : {}),
      topic_id: (post as Record<string, unknown> | null)?.topic_id ?? root.id,
      topic_title: (post as Record<string, unknown> | null)?.topic_title ?? root.title,
      topic_slug: (post as Record<string, unknown> | null)?.topic_slug ?? root.slug,
      url: (post as Record<string, unknown> | null)?.url
        ?? (root.slug && root.id && (post as Record<string, unknown> | null)?.post_number
          ? `/t/${root.slug}/${root.id}/${(post as Record<string, unknown>).post_number}` : undefined),
      excerpt: (post as Record<string, unknown> | null)?.excerpt
        ?? (post as Record<string, unknown> | null)?.raw
        ?? (post as Record<string, unknown> | null)?.cooked,
    }))
    : [];
  const isTopicResponse = Boolean(root.post_stream && typeof root.post_stream === "object");
  const posts = Array.isArray(root.posts) ? root.posts : streamPosts;

  return posts.flatMap((candidate): NormalizedNewsEntry[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const post = candidate as Record<string, unknown>;
    const id = post.id == null ? null : String(post.id);
    const topicId = post.topic_id == null ? null : String(post.topic_id);
    const title = stringValue(post.topic_title) ?? stringValue(post.topic_html_title);
    const publishedAt = isoDate(post.created_at);
    const url = stringValue(post.url);
    if (!id || !topicId || !title || !publishedAt || !url) return [];

    const sourceEntryId = `post:${id}`;
    const sourcePostNumber = typeof post.post_number === "number" && Number.isInteger(post.post_number)
      ? post.post_number
      : null;
    if (sourcePostNumber !== 1) return [];
    if (isTopicResponse && !options.authoritativePostIds?.has(sourceEntryId)) return [];

    const excerpt = excerptOf(post.excerpt);
    const relevance = classifyRelevance(title, excerpt, source.sourceType);
    return [{
      sourceType: source.sourceType,
      sourceKey: source.sourceKey,
      sourceEntryId,
      sourceTopicId: `topic:${topicId}`,
      sourcePostNumber,
      threadKey: `${source.region}:topic:${topicId}`,
      title: decodeHtml(title),
      canonicalUrl: sourceUrl(url, source.baseUrl),
      author: stringValue(post.name) ?? stringValue(post.username),
      region: source.region,
      publishedAt,
      modifiedAt: isoDate(post.updated_at),
      excerpt,
      category: categoryFor(title, source.sourceType),
      relevance,
      status: statusFor(relevance),
      featured: false,
    }];
  });
}

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

function isBluepostPayload(body: string): boolean {
  try {
    const root = JSON.parse(body) as Record<string, unknown>;
    return Array.isArray(root.posts)
      || Boolean(root.post_stream && typeof root.post_stream === "object"
        && Array.isArray((root.post_stream as { posts?: unknown }).posts));
  } catch {
    return false;
  }
}

function isOfficialNewsFragment(body: string): boolean {
  return /<article\s+class="NewsBlog"[\s>]/i.test(body);
}


export type CollectorSource = BluepostSource | OfficialNewsSource;

export interface ApplySyncPayload {
  source: {
    sourceKey: string;
    sourceType: NewsSourceType;
    region: NewsRegion;
    endpointUrl: string;
    enabled: boolean;
  };
  run: {
    startedAt: string;
    finishedAt: string;
    status: "succeeded" | "partial" | "failed";
    fetchedCount: number;
    acceptedCount: number;
    rejectedCount: number;
    diagnostics: { pages: number; mode: "normal" | "revision"; error?: string };
    error?: string;
  };
  entries: Array<NormalizedNewsEntry & { contentHash: string }>;
}

export interface SyncReport {
  sourceKey: string;
  status: "succeeded" | "partial" | "failed";
  fetchedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  inserted: number;
  updated: number;
  error?: string;
}

export interface CollectorOptions {
  sources: CollectorSource[];
  sourceKeys?: string[];
  fetcher?: typeof fetch;
  apply: (payload: ApplySyncPayload) => Promise<{ inserted: number; updated: number }>;
  now?: () => Date;
  mode?: "normal" | "revision";
  maxOfficialPages?: number;
}

const DEFAULT_SOURCES: CollectorSource[] = [
  { sourceType: "bluepost", sourceKey: "blizzard-bluepost-us", region: "us", baseUrl: "https://us.forums.blizzard.com/en/wow" },
  { sourceType: "bluepost", sourceKey: "blizzard-bluepost-eu", region: "eu", baseUrl: "https://eu.forums.blizzard.com/en/wow" },
  { sourceType: "official_news", sourceKey: "blizzard-news-us", region: "us", baseUrl: "https://worldofwarcraft.blizzard.com/en-us" },
];

async function fetchText(fetcher: typeof fetch, url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetcher(url, {
      headers: { Accept: "application/json, text/html", "User-Agent": "AzerDex-News-Collector/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("source_http_" + response.status);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function nextBluepostPage(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { meta?: { next_page?: unknown }; next_page?: unknown };
    const value = parsed.meta?.next_page ?? parsed.next_page;
    return typeof value === "number" && Number.isInteger(value) && value > 1 ? value : null;
  } catch {
    return null;
  }
}

function endpointFor(source: CollectorSource, page = 1): string {
  if (source.sourceType === "bluepost") {
    const endpoint = source.baseUrl.replace(/\/$/, "") + "/groups/blizzard-tracker/posts.json";
    return page > 1 ? endpoint + "?page=" + page : endpoint;
  }
  return source.baseUrl.replace(/\/$/, "") + "/news/river.frag?page=" + page;
}

function entrySignature(entries: NormalizedNewsEntry[]): string {
  return entries.map((entry) => entry.sourceEntryId + ":" + (entry.modifiedAt ?? entry.publishedAt)).join("|");
}

function topicRevisionUrl(canonicalUrl: string): string | null {
  try {
    const url = new URL(canonicalUrl);
    if (!/\/t\/[^/]+\/\d+\/\d+$/i.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/\/(\d+)\/\d+$/i, "/$1.json");
    return url.toString();
  } catch {
    return null;
  }
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function collectSource(source: CollectorSource, options: CollectorOptions): Promise<SyncReport> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const mode = options.mode ?? "normal";
  const all: NormalizedNewsEntry[] = [];
  let pages = 0;
  let error: string | undefined;
  const revisionFailures: string[] = [];

  try {
    if (source.sourceType === "bluepost") {
      let page = 1;
      let previousSignature: string | null = null;
      while (page <= 10) {
        const body = await fetchText(fetcher, endpointFor(source, page));
        if (!isBluepostPayload(body)) throw new Error("source_invalid_bluepost_payload");
        const entries = parseBluepostFeed(body, source);
        const signature = entrySignature(entries);
        if (previousSignature !== null && signature === previousSignature) break;
        previousSignature = signature;
        all.push(...entries);
        pages += 1;
        const next = nextBluepostPage(body);
        if (!next || next <= page) break;
        page = next;
      }
      if (mode === "revision") {
        const topicAllowLists = new Map<string, Set<string>>();
        for (const entry of all) {
          const topicUrl = topicRevisionUrl(entry.canonicalUrl);
          if (!topicUrl) continue;
          const allowList = topicAllowLists.get(topicUrl) ?? new Set<string>();
          allowList.add(entry.sourceEntryId);
          topicAllowLists.set(topicUrl, allowList);
        }
        for (const [topicUrl, authoritativePostIds] of [...topicAllowLists.entries()].slice(0, 25)) {
          try {
            all.push(...parseBluepostFeed(await fetchText(fetcher, topicUrl), source, { authoritativePostIds }));
          } catch (caught) {
            revisionFailures.push(caught instanceof Error ? caught.message : "topic_revision_failed");
          }
        }
        if (revisionFailures.length) error = `revision_topic_failures:${revisionFailures.length}`;
      }
    } else {
      const maxPages = options.maxOfficialPages ?? 3;
      let previousSignature = "";
      for (let page = 1; page <= maxPages; page += 1) {
        const body = await fetchText(fetcher, endpointFor(source, page));
        if (!isOfficialNewsFragment(body)) throw new Error("source_invalid_official_news_payload");
        const entries = parseOfficialNewsFragment(body, source);
        if (entries.length === 0) throw new Error("source_unparseable_official_news_payload");
        const signature = entrySignature(entries);
        if (signature === previousSignature) break;
        previousSignature = signature;
        all.push(...entries);
        pages += 1;
        if (entries.length < 20) break;
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "source_fetch_failed";
  }

  const unique = new Map(all.map((entry) => [entry.sourceEntryId, entry]));
  const entriesToApply = [...unique.values()];
  const accepted = entriesToApply.filter((entry) => entry.status === "published");
  const rejected = entriesToApply.length - accepted.length;
  const finishedAt = now().toISOString();
  if (error) {
    const partialEntries = await Promise.all(entriesToApply.map(async (entry) => ({ ...entry, contentHash: await sha256(entry) })));
    const partialStatus = entriesToApply.length ? "partial" as const : "failed" as const;
    try {
      await options.apply({
        source: { sourceKey: source.sourceKey, sourceType: source.sourceType, region: source.region, endpointUrl: endpointFor(source), enabled: true },
        run: { startedAt, finishedAt, status: partialStatus, fetchedCount: entriesToApply.length, acceptedCount: accepted.length, rejectedCount: rejected, diagnostics: { pages, mode }, error },
        entries: partialEntries,
      });
    } catch {
      // Preserve the source error in the returned report even if the audit write is unavailable.
    }
    return { sourceKey: source.sourceKey, status: partialStatus, fetchedCount: entriesToApply.length, acceptedCount: accepted.length, rejectedCount: rejected, inserted: 0, updated: 0, error };
  }

  const entries = await Promise.all(entriesToApply.map(async (entry) => ({ ...entry, contentHash: await sha256(entry) })));
  try {
    const result = await options.apply({
      source: { sourceKey: source.sourceKey, sourceType: source.sourceType, region: source.region, endpointUrl: endpointFor(source), enabled: true },
      run: { startedAt, finishedAt, status: "succeeded", fetchedCount: entriesToApply.length, acceptedCount: accepted.length, rejectedCount: rejected, diagnostics: { pages, mode } },
      entries,
    });
    return { sourceKey: source.sourceKey, status: "succeeded", fetchedCount: entriesToApply.length, acceptedCount: accepted.length, rejectedCount: rejected, ...result };
  } catch (caught) {
    const applyError = caught instanceof Error ? caught.message : "news_persistence_failed";
    return { sourceKey: source.sourceKey, status: "failed", fetchedCount: entriesToApply.length, acceptedCount: accepted.length, rejectedCount: rejected, inserted: 0, updated: 0, error: applyError };
  }
}

export async function collectNews(options: CollectorOptions): Promise<SyncReport[]> {
  const configured = options.sources.length ? options.sources : DEFAULT_SOURCES;
  const sources = options.sourceKeys?.length
    ? configured.filter((source) => options.sourceKeys?.includes(source.sourceKey))
    : configured;
  const reports: SyncReport[] = [];
  for (const source of sources) reports.push(await collectSource(source, options));
  return reports;
}
