import { notFound } from "next/navigation";
import { ArticleDetailView } from "@/components/admin/ArticleDetailView";
import { Failure } from "@/components/admin/Failure";
import { Notice } from "@/components/admin/primitives";
import { adminCtxForPage, loadArticle } from "@/lib/admin/cms/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin · Article" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const r = await adminCtxForPage();
  if (!r.ok) return <Notice tone="warning" title="Admin access unavailable">Complete a fresh TOTP verification from your account.</Notice>;
  const d = await loadArticle(r.ctx, id);
  if (!d.ok) return <Failure f={d} what="read this article" />;
  return <ArticleDetailView detail={d.data} uid={r.ctx.uid} />;
}
