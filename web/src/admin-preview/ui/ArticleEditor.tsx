"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { CATEGORIES, MEDIA, emptySnapshot, effectiveClassification, normalizeSnapshot, validateSlug, validateSnapshot } from "../domain/content";
import { articleOf, can, headOf, sessionActive, sessionView } from "../domain/selectors";
import type { ArticleSnapshot } from "../domain/types";
import { useAdmin } from "../state/AdminProvider";
import { BASE } from "./Shell";
import { MarkdownView, MediaTile } from "./common";
import { BTN_GHOST, BTN_PRIMARY, EmptyState, Field, FIELD, Notice, PageHeader, Panel, Segmented } from "./primitives";

interface Form { slug: string; title: string; summary: string; byline: string; category: string; tags: string; classification: "normal" | "highlighted"; featured: boolean; coverMediaId: string; coverAlt: string; seoDescription: string; body: string }

const toForm = (slug: string, s: ArticleSnapshot): Form => ({ slug, title: s.title, summary: s.summary, byline: s.byline, category: s.category, tags: s.tags.join(", "), classification: s.classification, featured: s.featured, coverMediaId: s.coverMediaId ?? "", coverAlt: s.coverAlt, seoDescription: s.seoDescription, body: s.body });
const toSnapshot = (f: Form): ArticleSnapshot => ({ title: f.title, summary: f.summary, body: f.body, byline: f.byline, category: f.category, tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean), classification: f.classification, featured: f.featured, coverMediaId: f.coverMediaId || null, coverAlt: f.coverAlt, seoDescription: f.seoDescription });

export function ArticleEditor({ articleId }: { articleId?: string }) {
  const { state: s, run } = useAdmin();
  const router = useRouter();
  const art = articleId ? articleOf(s, articleId) : undefined;
  const head = art ? headOf(s, art) : undefined;
  const v = sessionView(s);
  const [baseRev] = useState(head?.id ?? "");
  const [form, setForm] = useState<Form>(() => (head && art ? toForm(art.slug, head.snapshot) : toForm("", emptySnapshot(sessionView(s).persona?.name ?? ""))));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [serverNotice, setServerNotice] = useState<{ tone: "error" | "warning"; text: string } | null>(null);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const set = <K extends keyof Form>(k: K, val: Form[K]): void => { setForm((f) => ({ ...f, [k]: val })); setServerErrors((e) => ({ ...e, [k]: "" })); };
  const touch = (k: string): void => setTouched((t) => ({ ...t, [k]: true }));

  const snap = useMemo(() => normalizeSnapshot(toSnapshot(form)), [form]);
  const readiness = useMemo(() => validateSnapshot(snap), [snap]);
  const slugError = !articleId ? validateSlug(form.slug, (x) => s.articles.some((a) => a.slug === x)) : null;
  const dirty = head ? JSON.stringify(normalizeSnapshot(toSnapshot(toForm(art!.slug, head.snapshot)))) !== JSON.stringify(snap) : true;
  const canWrite = can(s, "news.draft.write", articleId);
  const err = (k: string, local?: string | null): string | undefined => serverErrors[k] || (touched[k] || touched.__all ? local ?? undefined : undefined) || undefined;
  const nextClass = effectiveClassification(snap);
  const lockedNote = art && art.classificationFloor === "highlighted";

  if (articleId && !art) return <EmptyState title="Article not found" action={<Link href={`${BASE}/articles`} className={BTN_GHOST}>Back to articles</Link>}>It may not exist in this preview session (preview data resets on “Reset all preview data”).</EmptyState>;

  const save = (e: FormEvent): void => {
    e.preventDefault();
    setTouched({ __all: true });
    setServerNotice(null);
    const o = articleId
      ? run({ type: "article/save", articleId, baseRevisionId: baseRev, snapshot: toSnapshot(form) }, { quiet: false })
      : run({ type: "article/create", slug: form.slug, snapshot: toSnapshot(form) });
    if (o.ok) { router.push(`${BASE}/articles/${articleId ?? o.ref}`); return; }
    if (o.fieldErrors) setServerErrors(o.fieldErrors);
    if (o.kind === "denied" || o.kind === "conflict") setServerNotice({ tone: "error", text: o.message });
  };

  return (
    <>
      <PageHeader title={articleId ? `Edit “${head!.snapshot.title || art!.slug}”` : "New draft"} eyebrow="Articles / News" cap="simulated"
        actions={<Link href={articleId ? `${BASE}/articles/${articleId}` : `${BASE}/articles`} className={BTN_GHOST}>Cancel</Link>}>
        {articleId
          ? <>Saving creates a <strong className="text-parchment">new immutable revision (r{head!.no + 1})</strong> from r{head!.no}. {art!.publishedRevisionId ? "The live revision stays public and untouched." : "Earlier revisions are never modified."}</>
          : <>Creating a draft reserves its slug permanently and writes immutable revision r1. Nothing becomes public.</>}
      </PageHeader>

      {!sessionActive(v) ? <Notice tone="warning" title="Sign in required">Your preview session is not active.</Notice>
        : !canWrite && <div className="mb-4"><Notice tone="warning" role="status" title="Read-only">{v.persona?.name} does not hold <code>news.draft.write</code>{articleId ? " for this article" : ""}. You can still fill the form to see validation, but saving will be denied and audited.</Notice></div>}
      {serverNotice && <div className="mb-4" data-testid="editor-denial"><Notice tone={serverNotice.tone} role="alert" title="Save was denied">{serverNotice.text}</Notice></div>}

      <form onSubmit={save} noValidate aria-label="Article editor" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          <Panel title="Content">
            <div className="grid gap-4">
              <Field label="Slug (permanent)" hint={articleId ? "Slugs are reserved and immutable from creation in V1." : <>Public URL: <code>/news/{form.slug || "your-slug"}</code>. Permanent once created.</>} error={err("slug", slugError)}>
                {(p) => <input {...p} className={FIELD} value={form.slug} readOnly={!!articleId} disabled={!!articleId} onChange={(e) => set("slug", e.target.value)} onBlur={() => touch("slug")} />}
              </Field>
              <Field label="Title" error={err("title", readiness.title)}>
                {(p) => <input {...p} className={FIELD} value={form.title} onChange={(e) => set("title", e.target.value)} onBlur={() => touch("title")} />}
              </Field>
              <Field label="Summary" hint={`${form.summary.trim().length}/280`} error={err("summary", readiness.summary)}>
                {(p) => <textarea {...p} rows={2} className={FIELD} value={form.summary} onChange={(e) => set("summary", e.target.value)} onBlur={() => touch("summary")} />}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Byline" error={err("byline", readiness.byline)}>{(p) => <input {...p} className={FIELD} value={form.byline} onChange={(e) => set("byline", e.target.value)} onBlur={() => touch("byline")} />}</Field>
                <Field label="Category" error={err("category", readiness.category)}>{(p) => <select {...p} className={FIELD} value={form.category} onChange={(e) => set("category", e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>}</Field>
              </div>
              <Field label="Tags" hint="Comma-separated: lowercase letters, digits, hyphens. Max 8." error={err("tags", readiness.tags)}>
                {(p) => <input {...p} className={FIELD} value={form.tags} onChange={(e) => set("tags", e.target.value)} onBlur={() => touch("tags")} />}
              </Field>
            </div>
          </Panel>

          <Panel title="Body (Markdown)" actions={<div className="lg:hidden"><Segmented label="Editor view" value={tab} onChange={setTab} options={[{ id: "write", label: "Write" }, { id: "preview", label: "Preview" }]} /></div>}>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className={tab === "preview" ? "hidden lg:block" : ""}>
                <Field label="Markdown" error={err("body", readiness.body)} hint="GitHub-flavoured Markdown. Raw HTML and unsafe links are rejected.">
                  {(p) => <textarea {...p} rows={16} className={`${FIELD} font-mono text-sm`} value={form.body} onChange={(e) => set("body", e.target.value)} onBlur={() => touch("body")} spellCheck />}
                </Field>
              </div>
              <div className={tab === "write" ? "hidden lg:block" : ""} aria-label="Markdown preview" role="region">
                <p className="mb-1 text-sm font-medium text-parchment">Preview <span className="text-xs font-normal text-mist">(private, never public)</span></p>
                <div className="min-h-40 rounded-lg border border-ink-700 bg-ink-950/50 p-4" data-testid="md-preview">
                  {form.body.trim() ? <MarkdownView source={form.body} /> : <p className="text-sm text-mist">Nothing to preview yet.</p>}
                </div>
              </div>
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Classification">
            <div className="space-y-3">
              <Field label="Classification" error={err("classification")}>
                {(p) => <select {...p} className={FIELD} value={form.classification} onChange={(e) => set("classification", e.target.value as Form["classification"])}><option value="normal">Normal</option><option value="highlighted">Highlighted / high-impact</option></select>}
              </Field>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 h-4 w-4" checked={form.featured} onChange={(e) => set("featured", e.target.checked)} /><span>Featured <span className="block text-xs text-mist">Featured content is always treated as highlighted.</span></span></label>
              {nextClass === "highlighted" && <Notice tone="warning" title="Needs independent approval">Another eligible person must approve this exact revision before it can be published — even if the publisher is an Owner.</Notice>}
              {lockedNote && <Notice tone="info" title="V1: no classification downgrade">This article was highlighted in an earlier revision. Saving it as normal will be rejected.</Notice>}
            </div>
          </Panel>
          <Panel title="Cover media">
            <div className="space-y-3">
              <Field label="Approved media" error={err("coverMediaId", readiness.coverMediaId)} hint="V1: only rights-cleared images with provenance.">
                {(p) => <select {...p} className={FIELD} value={form.coverMediaId} onChange={(e) => set("coverMediaId", e.target.value)} onBlur={() => touch("coverMediaId")}><option value="">No cover</option>{MEDIA.map((m) => <option key={m.id} value={m.id}>{m.label}{m.rightsVerified ? "" : " — rights NOT verified"}</option>)}</select>}
              </Field>
              {form.coverMediaId && <Field label="Alt text" error={err("coverAlt", readiness.coverAlt)}>{(p) => <input {...p} className={FIELD} value={form.coverAlt} onChange={(e) => set("coverAlt", e.target.value)} onBlur={() => touch("coverAlt")} />}</Field>}
              <MediaTile id={form.coverMediaId || null} alt={form.coverAlt} />
            </div>
          </Panel>
          <Panel title="SEO">
            <Field label="Description" hint={`${form.seoDescription.trim().length}/160`} error={err("seoDescription", readiness.seoDescription)}>{(p) => <textarea {...p} rows={2} className={FIELD} value={form.seoDescription} onChange={(e) => set("seoDescription", e.target.value)} onBlur={() => touch("seoDescription")} />}</Field>
          </Panel>
          <Panel title="Readiness">
            <p className="mb-2 text-xs text-mist">Drafts may be incomplete. These checks must pass before review.</p>
            {Object.keys(readiness).length === 0 ? <p className="text-sm text-conf-high">✓ Ready to submit once saved.</p> : <ul className="space-y-1 text-xs text-mist" aria-live="polite">{Object.entries(readiness).map(([k, m]) => <li key={k}>○ {m}</li>)}</ul>}
          </Panel>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className={BTN_PRIMARY} data-testid="save-draft">{articleId ? `Save as r${head!.no + 1}` : "Create draft"}</button>
            {articleId && <span className="text-xs text-mist" aria-live="polite">{dirty ? "Unsaved changes" : "No changes"}</span>}
          </div>
        </div>
      </form>
    </>
  );
}
