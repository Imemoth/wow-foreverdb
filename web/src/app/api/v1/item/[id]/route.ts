import { envelope, fail, handle, ok, rejectUnknownParams } from "@/lib/api";
import { data } from "@/lib/data";
import { parseEntityId } from "@/lib/validation";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    rejectUnknownParams(new URL(req.url), []);
    const id = parseEntityId((await ctx.params).id);
    if (id == null) return fail(400, "invalid_id");
    const d = await data().item(id);
    return d ? ok(await envelope(d)) : fail(404, "not_found");
  });
}
