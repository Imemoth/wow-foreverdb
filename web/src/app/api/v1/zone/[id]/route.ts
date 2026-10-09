import { envelope, fail, handle, ok } from "@/lib/api";
import { data } from "@/lib/data";
import { parseEntityId, parseZoneEntityQuery } from "@/lib/validation";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = parseEntityId((await ctx.params).id);
    if (id == null || id > 999_999) return fail(400, "invalid_id");
    const q = parseZoneEntityQuery(id, new URL(req.url).searchParams, "strict");
    const zone = await data().zone(id);
    if (!zone) return fail(404, "not_found");
    const entities = await data().zoneEntities(q);
    return ok(await envelope({ zone, query: q, total: entities.total, rows: entities.rows }));
  });
}
