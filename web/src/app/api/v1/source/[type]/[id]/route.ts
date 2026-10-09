import { envelope, fail, handle, ok, rejectUnknownParams } from "@/lib/api";
import { data } from "@/lib/data";
import { parseEntityId, parseSourceType } from "@/lib/validation";

export async function GET(req: Request, ctx: { params: Promise<{ type: string; id: string }> }) {
  return handle(async () => {
    rejectUnknownParams(new URL(req.url), []);
    const p = await ctx.params;
    const type = parseSourceType(p.type);
    const id = type ? parseEntityId(p.id, { allowNegative: type === "gameobject" }) : null;
    if (!type || id == null) return fail(400, "invalid_id");
    const d = await data().source(type, id);
    return d ? ok(await envelope(d)) : fail(404, "not_found");
  });
}
