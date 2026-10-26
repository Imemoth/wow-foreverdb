import { envelope, fail, handle, ok } from "@/lib/api";
import { data } from "@/lib/data";
import { parseEntityId, parseZoneMapPointQuery } from "@/lib/validation";

/**
 * Published, aggregated (1% cell) observation locations of one zone, for the map overlay. UiMapID = the zone id of the URL.
 * Public projection only: no installation/contributor/account fields exist in the data this reads, and cells below the publication
 * privacy floor are never returned (enforced in the database function). `totalCells`/`truncated` describe PUBLISHED cells only.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = parseEntityId((await ctx.params).id);
    if (id == null || id > 999_999) return fail(400, "invalid_id");
    const { lootKind, limit } = parseZoneMapPointQuery(new URL(req.url).searchParams);
    const r = await data().zoneMapPoints(id, lootKind, limit);
    return ok(await envelope({ uiMapId: r.mapId, kind: lootKind, limit, totalCells: r.totalCells, truncated: r.truncated, points: r.points }));
  });
}
