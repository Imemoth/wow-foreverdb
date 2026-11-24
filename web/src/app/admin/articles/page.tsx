import Link from "next/link";
import { Suspense } from "react";
import { ArticleTable } from "@/components/admin/ArticleTable";
import { Failure } from "@/components/admin/Failure";
import { ADMIN_BASE } from "@/components/admin/Shell";
import { BTN_PRIMARY, Notice, PageHeader } from "@/components/admin/primitives";
import { adminCtxForPage, loadArticles, loadContext } from "@/lib/admin/cms/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin · Articles" };

export default async function ArticlesPage() {
  const r = await adminCtxForPage();
  if (!r.ok) return <Notice tone="warning" title="Admin access unavailable">Complete a fresh TOTP verification from your account.</Notice>;
  const [ctx, list] = await Promise.all([loadContext(r.ctx), loadArticles(r.ctx)]);
  if (!ctx.ok) return <Failure f={ctx} what="open the CMS" />;
  return (
    <>
      <PageHeader title="Articles / News" eyebrow="Content" cap="implemented" actions={ctx.data.can_create ? <Link href={`${ADMIN_BASE}/articles/new`} className={BTN_PRIMARY} data-testid="new-article">New draft</Link> : <span className="btn-ghost opacity-50" aria-disabled title="You do not hold news.draft.write">New draft</span>}>
        Every row is read from the real CMS database. Public status comes from the delivery receipt, not from an assumption.
      </PageHeader>
      {!list.ok ? <Failure f={list} what="read articles" /> : <Suspense fallback={null}><ArticleTable items={list.data} canCreate={ctx.data.can_create} /></Suspense>}
    </>
  );
}
