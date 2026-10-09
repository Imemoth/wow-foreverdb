import { handle, ok, rejectUnknownParams } from "@/lib/api";
import { data } from "@/lib/data";

export async function GET(req: Request) {
  return handle(async () => {
    rejectUnknownParams(new URL(req.url), []);
    return ok(await data().meta());
  });
}
