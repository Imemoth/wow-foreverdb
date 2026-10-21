import { envelope, fail, handle, ok } from "@/lib/api";
import { data } from "@/lib/data";
import { LOCATED_SOURCE_TYPES, parseEntityId, parseSourceMapPointQuery, parseSourceType } from "@/lib/validation";

/**
 * Published, aggregated observation locations of ONE source (creature / game object / fishing), optionally for one zone (`zone` = UiMapID),
 * loot kind and source level. Same privacy rules and cells as the zone read (a source page and the zone overview cannot disagree).
 */
export async function GET(req: Request, ctx: { params: Promise<{ type: string; id: string }> }) {
  return handle(async () => {
    const p = await ctx.params;
    const type = parseSourceType(p.type);
    if (!type || !(LOCATED_SOURCE_TYPES as readonly string[]).includes(type)) return fail(400, "invalid_id");
    const id = parseEntityId(p.id, { allowNegative: type === "gameobject" });
    if (id == null) return fail(400, "invalid_id");
    const query = parseSourceMapPointQuery(type, id, new URL(req.url).searchParams);
    if (!(await data().source(type, id))) return fail(404, "not_found");
    const r = await data().sourceMapPoints(query);
    return ok(await envelope({
      source: { type, id }, uiMapId: query.mapId, kind: query.lootKind, level: query.sourceLevel, limit: query.limit,
      totalCells: r.totalCells, truncated: r.truncated, points: r.points,
    }));
  });
}
