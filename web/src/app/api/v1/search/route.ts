import { envelope, handle, ok } from "@/lib/api";
import { data } from "@/lib/data";
import { MAX_API_PAGE_SIZE, parseSearchQuery } from "@/lib/validation";

export async function GET(req: Request) {
  return handle(async () => {
    const url = new URL(req.url);
    const q = parseSearchQuery(url.searchParams, "strict", MAX_API_PAGE_SIZE);
    const page = await data().search(q);
    return ok(await envelope({ query: q, total: page.total, rows: page.rows }));
  });
}
