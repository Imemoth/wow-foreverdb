import { ArticleEditor } from "@/components/admin/ArticleEditor";
import { Failure } from "@/components/admin/Failure";
import { Notice } from "@/components/admin/primitives";
import { adminCtxForPage, loadContext } from "@/lib/admin/cms/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin · New draft" };

export default async function NewArticlePage() {
  const r = await adminCtxForPage();
  if (!r.ok) return <Notice tone="warning" title="Admin access unavailable">Complete a fresh TOTP verification from your account.</Notice>;
  const ctx = await loadContext(r.ctx);
  if (!ctx.ok) return <Failure f={ctx} what="open the CMS" />;
  return <ArticleEditor mode="create" canWrite={ctx.data.can_create} denyNote="You do not hold news.draft.write at collection scope." />;
}
