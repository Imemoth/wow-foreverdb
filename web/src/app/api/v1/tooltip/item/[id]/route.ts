import { fail, handle, ok, rejectUnknownParams } from "@/lib/api";
import { data } from "@/lib/data";
import { itemTooltip } from "@/lib/tooltip";
import { parseEntityId } from "@/lib/validation";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    rejectUnknownParams(new URL(req.url), []);
    const id = parseEntityId((await ctx.params).id);
    if (id == null) return fail(400, "invalid_id");
    const d = await data().item(id);
    if (d) return ok(itemTooltip(d));
    const de = await data().source("item", id);
    return de?.variants[0] ? ok({ title: de.variants[0].name, subtitle: `Item ${id} · disenchanting input`, lines: [] }) : fail(404, "not_found");
  });
}
