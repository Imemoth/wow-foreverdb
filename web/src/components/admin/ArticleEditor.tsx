"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import type { ArticleDetail } from "@/lib/admin/cms/schemas";
import { BODY_MAX_CHARS } from "@/lib/admin/cms/schemas";
import { cmsPost, describeError, type ApiError } from "./cms-client";
import { Markdown } from "./Markdown";
import { ADMIN_BASE } from "./Shell";
import { BTN_GHOST, BTN_PRIMARY, Field, FIELD, Notice, PageHeader, Panel, Segmented } from "./primitives";

interface Form { slug: string; title: string; summary: string; body: string; byline: string; category: string; tags: string; links: string; seo: string; classification: "normal" | "highlighted"; featured: boolean }
type Article = ArticleDetail["article"];

const blank: Form = { slug: "", title: "", summary: "", body: "", byline: "", category: "", tags: "", links: "", seo: "", classification: "normal", featured: false };
const fromArticle = (a: Article): Form => ({
  slug: a.slug, title: a.snapshot.title, summary: a.snapshot.summary, body: a.snapshot.body_markdown, byline: a.snapshot.byline, category: a.snapshot.category,
  tags: a.snapshot.tags.join(", "), links: a.snapshot.related_links.join("\n"), seo: a.snapshot.seo_description, classification: a.snapshot.classification, featured: a.snapshot.featured,
});
const lines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter(Boolean);
const tagList = (s: string): string[] => [...new Set(s.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))];

/** The wire snapshot. Optional fields are omitted when empty so the database applies its documented defaults. */
export function toSnapshot(f: Form, images: { asset_id: string; alt: string }[]): Record<string, unknown> {
  const s: Record<string, unknown> = { title: f.title.trim(), summary: f.summary.trim(), body_markdown: f.body, classification: f.featured ? "highlighted" : f.classification, featured: f.featured };
  if (f.byline.trim()) s.byline = f.byline.trim();
  if (f.category.trim()) s.category = f.category.trim();
  if (f.seo.trim()) s.seo_description = f.seo.trim();
  const tags = tagList(f.tags); if (tags.length) s.tags = tags;
  const links = lines(f.links); if (links.length) s.related_links = links;
  if (images.length) s.images = images;
  return s;
}

/** Mirror of the database rules, for immediate feedback only. The database re-validates everything. */
export function validate(f: Form, creating: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (creating && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.slug)) e.slug = "Lowercase letters, digits and single hyphens only.";
  else if (creating && (f.slug.length < 3 || f.slug.length > 80)) e.slug = "3–80 characters.";
  const t = f.title.trim(); if (t.length < 3 || t.length > 120) e.title = "Title must be 3–120 characters.";
  const s = f.summary.trim(); if (s.length < 20 || s.length > 200) e.summary = "Summary must be 20–200 characters.";
  if (f.body.length < 1) e.body = "Body is required.";
  else if (f.body.length > BODY_MAX_CHARS) e.body = `Body is limited to ${BODY_MAX_CHARS.toLocaleString("en-US")} characters.`;
  else if (/<[a-z/!][^>]*>/i.test(f.body)) e.body = "Raw HTML is not allowed in Markdown.";
  else if (/(javascript:|data:)/i.test(f.body)) e.body = "javascript: and data: URLs are not allowed.";
  if (f.byline.trim() && (f.byline.trim().length < 2 || f.byline.trim().length > 60)) e.byline = "Byline must be 2–60 characters.";
  if (f.category.trim() && (f.category.trim().length < 2 || f.category.trim().length > 40)) e.category = "Category must be 2–40 characters.";
  if (f.seo.trim() && (f.seo.trim().length < 20 || f.seo.trim().length > 200)) e.seo = "SEO description must be 20–200 characters.";
  const tags = tagList(f.tags);
  if (tags.length > 10 || tags.some((x) => !/^[a-z0-9-]{2,30}$/.test(x))) e.tags = "Up to 10 tags of 2–30 lowercase letters, digits or hyphens.";
  const links = lines(f.links);
  if (links.length > 6 || links.some((l) => l.length > 308 || !/^https:\/\/[^\s<>"'`\\]+$/.test(l))) e.links = "Up to 6 absolute https links, one per line.";
  return e;
}

export function ArticleEditor({ mode, article, canWrite, denyNote }: { mode: "create" | "edit"; article?: Article; canWrite: boolean; denyNote?: string }) {
  const router = useRouter();
  const creating = mode === "create";
  const [form, setForm] = useState<Form>(article ? fromArticle(article) : blank);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<ReturnType<typeof describeError> | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const images = (article?.snapshot.images ?? []).map((i) => ({ asset_id: String((i as { asset_id?: unknown }).asset_id ?? ""), alt: String((i as { alt?: unknown }).alt ?? "") })).filter((i) => i.asset_id);
  const pending = useRef<{ id: string; payload: string } | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]): void => { setForm((f) => ({ ...f, [k]: v })); setServerErrors((e) => ({ ...e, [k]: "" })); };
  const errors = validate(form, creating);
  const err = (k: string): string | undefined => serverErrors[k] || (touched[k] || touched.__all ? errors[k] : undefined) || undefined;
  const touch = (k: string): void => setTouched((t) => ({ ...t, [k]: true }));

  const save = async (ev: FormEvent): Promise<void> => {
    ev.preventDefault();
    setTouched({ __all: true });
    setNotice(null); setStale(false);
    if (Object.keys(errors).length) { setNotice({ tone: "warning", title: "Check the form", text: "Fix the highlighted fields before saving." }); return; }
    const snapshot = toSnapshot(form, images);
    const base = creating ? { slug: form.slug, snapshot } : { articleId: article!.article_id, revisionId: article!.current_revision_id, snapshot };
    // One idempotency key per intent: kept only while the payload is unchanged AND the last outcome was unknown.
    const payload = JSON.stringify(base);
    if (!pending.current || pending.current.payload !== payload) pending.current = { id: crypto.randomUUID(), payload };
    setBusy(true);
    const r = await cmsPost<{ articleId: string }>(creating ? "create" : "edit", { requestId: pending.current.id, ...base });
    setBusy(false);
    if (r.ok) { pending.current = null; router.push(`${ADMIN_BASE}/articles/${r.articleId}`); router.refresh(); return; }
    const e: ApiError = r.error;
    if (e.kind !== "unknown_outcome" && e.kind !== "network" && e.kind !== "unavailable") pending.current = null;
    if (e.kind === "stale") setStale(true);
    if (e.kind === "conflict" && e.reason === "slug_taken") setServerErrors({ slug: "This slug is already reserved by another article." });
    if (e.kind === "invalid" && e.issues) setServerErrors(Object.fromEntries(e.issues.map((i) => [({ body_markdown: "body", seo_description: "seo", related_links: "links" } as Record<string, string>)[i.path.split(".")[0]!] ?? i.path.split(".")[0]!, "Rejected by the backend validation."])));
    setNotice(describeError(e));
  };

  return (
    <>
      <PageHeader title={creating ? "New draft" : `Edit “${article!.snapshot.title}”`} eyebrow="Articles / News" cap="implemented" actions={<Link href={creating ? `${ADMIN_BASE}/articles` : `${ADMIN_BASE}/articles/${article!.article_id}`} className={BTN_GHOST}>Cancel</Link>}>
        {creating ? <>Creating a draft reserves its slug permanently and writes immutable revision r1 to the real CMS database. Nothing becomes public.</>
          : <>Saving writes a <strong className="text-parchment">new immutable revision (r{article!.revision_no + 1})</strong> from r{article!.revision_no}. A concurrent change is detected and refused; nothing is overwritten.</>}
      </PageHeader>
      {!canWrite && <div className="mb-4"><Notice tone="warning" role="status" title="Read-only">{denyNote ?? "You do not hold news.draft.write for this article."} Saving would be refused by the database.</Notice></div>}
      {notice && <div className="mb-4" data-testid="editor-notice"><Notice tone={notice.tone} role="alert" title={notice.title}>{notice.text}{stale && <> <button type="button" className={`${BTN_GHOST} !min-h-8 ml-2 text-sm`} onClick={() => router.refresh()}>Reload</button></>}</Notice></div>}
      <form onSubmit={save} noValidate aria-label="Article editor" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          <Panel title="Content">
            <div className="grid gap-4">
              <Field label="Slug (permanent)" hint={creating ? <>Public URL: <code>/news/{form.slug || "your-slug"}</code>. Permanent once created.</> : "Slugs are reserved and immutable from creation."} error={err("slug")}>
                {(p) => <input {...p} className={FIELD} value={form.slug} readOnly={!creating} disabled={!creating} onChange={(e) => set("slug", e.target.value)} onBlur={() => touch("slug")} />}
              </Field>
              <Field label="Title" error={err("title")}>{(p) => <input {...p} className={FIELD} value={form.title} onChange={(e) => set("title", e.target.value)} onBlur={() => touch("title")} />}</Field>
              <Field label="Summary" hint={`${form.summary.trim().length}/200 (min 20)`} error={err("summary")}>{(p) => <textarea {...p} rows={2} className={FIELD} value={form.summary} onChange={(e) => set("summary", e.target.value)} onBlur={() => touch("summary")} />}</Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Byline" hint="Optional (default AzerDex)" error={err("byline")}>{(p) => <input {...p} className={FIELD} value={form.byline} onChange={(e) => set("byline", e.target.value)} onBlur={() => touch("byline")} />}</Field>
                <Field label="Category" hint="Optional (default news)" error={err("category")}>{(p) => <input {...p} className={FIELD} value={form.category} onChange={(e) => set("category", e.target.value)} onBlur={() => touch("category")} />}</Field>
              </div>
              <Field label="Tags" hint="Comma-separated; lowercase letters, digits, hyphens (2–30 each, max 10)." error={err("tags")}>{(p) => <input {...p} className={FIELD} value={form.tags} onChange={(e) => set("tags", e.target.value)} onBlur={() => touch("tags")} />}</Field>
              <Field label="Related links" hint="One absolute https URL per line (max 6)." error={err("links")}>{(p) => <textarea {...p} rows={2} className={`${FIELD} font-mono text-sm`} value={form.links} onChange={(e) => set("links", e.target.value)} onBlur={() => touch("links")} />}</Field>
            </div>
          </Panel>
          <Panel title="Body (Markdown)" actions={<div className="lg:hidden"><Segmented label="Editor view" value={tab} onChange={setTab} options={[{ id: "write", label: "Write" }, { id: "preview", label: "Preview" }]} /></div>}>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className={tab === "preview" ? "hidden lg:block" : ""}>
                <Field label="Markdown" hint={`${form.body.length.toLocaleString("en-US")}/${BODY_MAX_CHARS.toLocaleString("en-US")} characters. Raw HTML, images and non-https links are not allowed.`} error={err("body")}>
                  {(p) => <textarea {...p} rows={16} className={`${FIELD} font-mono text-sm`} value={form.body} onChange={(e) => set("body", e.target.value)} onBlur={() => touch("body")} spellCheck />}
                </Field>
              </div>
              <div className={tab === "write" ? "hidden lg:block" : ""} role="region" aria-label="Markdown preview">
                <p className="mb-1 text-sm font-medium text-parchment">Preview <span className="text-xs font-normal text-mist">(private, safe rendering)</span></p>
                <div className="min-h-40 rounded-lg border border-ink-700 bg-ink-950/50 p-4" data-testid="md-preview">{form.body.trim() ? <Markdown source={form.body} /> : <p className="text-sm text-mist">Nothing to preview yet.</p>}</div>
              </div>
            </div>
          </Panel>
        </div>
        <div className="space-y-4">
          <Panel title="Classification">
            <div className="space-y-3">
              <Field label="Classification" error={err("classification")}>
                {(p) => <select {...p} className={FIELD} value={form.featured ? "highlighted" : form.classification} disabled={form.featured} onChange={(e) => set("classification", e.target.value as Form["classification"])}><option value="normal">Normal</option><option value="highlighted">Highlighted</option></select>}
              </Field>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 h-4 w-4" checked={form.featured} onChange={(e) => set("featured", e.target.checked)} /><span>Featured <span className="block text-xs text-mist">Featured content is always highlighted.</span></span></label>
              {(form.featured || form.classification === "highlighted") && <Notice tone="warning" title="Needs independent approval">Another eligible person must approve this exact revision before it can be published — even if the publisher is an Owner.</Notice>}
              {article && article.classification_floor === 1 && <Notice tone="info" title="V1: no classification downgrade">This article was highlighted before. Saving it as normal is refused by the database.</Notice>}
            </div>
          </Panel>
          <Panel title="Images">
            {images.length ? <ul className="space-y-1 text-sm">{images.map((i) => <li key={i.asset_id}><code className="text-xs text-gold-300">{i.asset_id.slice(0, 8)}…</code> {i.alt}</li>)}</ul> : <p className="text-sm text-mist">No images.</p>}
            <p className="mt-2 text-xs text-mist">Only rights-verified, immutable registry assets can be referenced. There is no upload or registration API yet, so existing references are preserved and none can be added here.</p>
          </Panel>
          <Panel title="SEO">
            <Field label="Description" hint="Optional (defaults to the summary). 20–200 characters." error={err("seo")}>{(p) => <textarea {...p} rows={2} className={FIELD} value={form.seo} onChange={(e) => set("seo", e.target.value)} onBlur={() => touch("seo")} />}</Field>
          </Panel>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className={BTN_PRIMARY} disabled={busy || !canWrite} data-testid="save-draft">{busy ? "Saving…" : creating ? "Create draft" : `Save as r${article!.revision_no + 1}`}</button>
          </div>
        </div>
      </form>
    </>
  );
}
