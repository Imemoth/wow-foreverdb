import type { NextRequest } from "next/server";
import { handleCmsPost } from "@/lib/admin/cms/route";

export const dynamic = "force-dynamic";
// Next's default body buffer for the proxy is capped in next.config.ts; this route only accepts the CMS action names.
export async function POST(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  return handleCmsPost(req, (await ctx.params).action);
}
