import { notFound } from "next/navigation";
import { ArticleEditor } from "@/components/admin/ArticleEditor";
import { Failure } from "@/components/admin/Failure";
import { Notice } from "@/components/admin/primitives";
import { adminCtxForPage, loadArticle } from "@/lib/admin/cms/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin · Edit article" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const r = await adminCtxForPage();
  if (!r.ok) return <Notice tone="warning" title="Admin access unavailable">Complete a fresh TOTP verification from your account.</Notice>;
  const d = await loadArticle(r.ctx, id);
  if (!d.ok) return <Failure f={d} what="read this article" />;
  const editable = ["draft", "in_review", "approved", "rejected"].includes(d.data.article.review_state);
  return (
    <>
      {!editable && <div className="mb-4"><Notice tone="warning" role="status" title="Not editable now">This article is {d.data.article.review_state.replace("_", " ")}; saving a new revision would be refused.</Notice></div>}
      <ArticleEditor key={d.data.article.current_revision_id} mode="edit" article={d.data.article} canWrite={d.data.permitted.edit && editable} />
    </>
  );
}
