import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The read-only CDN verifier against a local stand-in host (synthetic images, not Blizzard art).
const run = promisify(execFile);
const SCRIPT = join(process.cwd(), "scripts", "verify-talent-icons-cdn.mjs");
const BUILD = "9.9.9.2";
const root = mkdtempSync(join(tmpdir(), "azerdex-cdn-verify-"));
const dataset = join(root, "dataset"), staging = join(root, "staging", "talent-icons", BUILD);
let server: Server;
let mode: "good" | "wrong-type" | "spa" | "missing" | "tampered" | "redirect" = "good";
const hits: string[] = [];
let port = 0;
const files = new Map<string, Buffer>();

beforeAll(async () => {
  mkdirSync(dataset, { recursive: true });
  mkdirSync(staging, { recursive: true });
  const inv: Record<string, unknown> = {};
  for (const id of [111, 222]) {
    const b = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: id % 255, g: 1, b: 2 } } }).webp({ lossless: true }).toBuffer();
    files.set(`/talent-icons/${BUILD}/${id}.webp`, b);
    writeFileSync(join(staging, `${id}.webp`), b);
    inv[id] = { webpSha256: createHash("sha256").update(b).digest("hex"), webpBytes: b.length };
  }
  writeFileSync(join(dataset, "icons.json"), JSON.stringify({ build: BUILD, icons: { 1: 111, 2: 222 } }));
  writeFileSync(join(dataset, "icons-inventory.json"), JSON.stringify({ build: BUILD, files: inv }));
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (mode === "redirect") return void res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere.webp" }).end();
    const f = files.get(req.url ?? "");
    const headers = { "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" };
    if (mode === "spa") return void res.writeHead(200, { "content-type": "text/html" }).end("<html>app</html>");
    if (!f || (mode === "missing" && req.url?.endsWith("/222.webp"))) return void res.writeHead(404).end("no");
    const body = mode === "tampered" && req.url?.endsWith("/111.webp") ? Buffer.concat([f.subarray(0, f.length - 1), Buffer.from([0])]) : f;
    res.writeHead(200, { ...headers, "content-type": mode === "wrong-type" ? "application/octet-stream" : "image/webp" }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const verify = async (m: typeof mode) => {
  mode = m;
  try {
    const { stdout } = await run("node", [SCRIPT, "--dataset", dataset, "--base", `http://127.0.0.1:${port}`, "--allow-test-origin"]);
    return { code: 0, out: JSON.parse(stdout) };
  } catch (e) {
    const err = e as { code: number; stdout: string };
    return { code: err.code, out: JSON.parse(err.stdout) };
  }
};

describe("verify-talent-icons-cdn.mjs", () => {
  it("passes a host that serves every icon byte-for-byte with image/webp, immutable caching and a 404 for unknown ids", async () => {
    const r = await verify("good");
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ ok: true, checked: 2, expected: 2, passed: 2, cacheOk: true, negativeControl: { status: 404, ok: true } });
  });

  it("fails a wrong content type, a missing file, a tampered file and a host that answers 200 to everything", async () => {
    for (const m of ["wrong-type", "missing", "tampered", "spa"] as const) {
      const r = await verify(m);
      expect(r.code, m).toBe(1);
      expect(r.out.ok, m).toBe(false);
    }
  });

  it("fails an unreachable host", async () => {
    server.close();
    mode = "good";
    await expect(run("node", [SCRIPT, "--dataset", dataset, "--base", `http://127.0.0.1:${port}`, "--allow-test-origin"])).rejects.toMatchObject({ code: 1 });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  });

  it("never follows a redirect: a 3xx is a failure and nothing else is requested", async () => {
    hits.length = 0;
    const r = await verify("redirect");
    expect(r.code).toBe(1);
    expect(r.out.ok).toBe(false);
    expect(r.out.failed[0]).toMatchObject({ status: 302 });
    expect(hits.every((u) => u.startsWith("/talent-icons/"))).toBe(true);
  });

  it("refuses any base that is not an https allow-listed asset origin, before any request", async () => {
    hits.length = 0;
    const bad = [
      "https://evil.example", "https://azerdex-assets.pages.dev.evil.example", "https://evil.example/azerdex-assets.pages.dev", "http://azerdex-assets.pages.dev",
      "https://azerdex-assets.pages.dev:8443", "https://user:pw@azerdex-assets.pages.dev", "https://azerdex-assets.pages.dev/sub", "https://azerdex-assets.pages.dev/?x=1",
      `http://127.0.0.1:${port}`, // loopback needs the explicit test flag
    ];
    for (const base of bad) await expect(run("node", [SCRIPT, "--dataset", dataset, "--base", base]), base).rejects.toMatchObject({ code: 2 });
    expect(hits).toEqual([]);
  });

  it("accepts exactly the documented hosts (validation only: no request is made)", async () => {
    for (const base of ["https://azerdex-assets.pages.dev", "https://assets.azerdex.com", "https://3ae723a0.azerdex-assets.pages.dev", "https://azerdex-assets.pages.dev/"]) {
      const { stdout } = await run("node", [SCRIPT, "--dataset", dataset, "--base", base, "--validate-only"]);
      expect(JSON.parse(stdout).origin, base).toBe(new URL(base).origin);
    }
  });

  it("verifies a staging directory offline, before any upload", async () => {
    const { stdout } = await run("node", [SCRIPT, "--dataset", dataset, "--dir", join(root, "staging")]);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, mode: "directory", passed: 2 });
    writeFileSync(join(staging, "111.webp"), readFileSync(join(staging, "222.webp")));
    await expect(run("node", [SCRIPT, "--dataset", dataset, "--dir", join(root, "staging")])).rejects.toMatchObject({ code: 1 });
  });
});
