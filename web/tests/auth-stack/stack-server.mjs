// Test-only stand-in for the Supabase API gateway (Kong) in front of a REAL GoTrue process:
//   * /auth/v1/*  ->  GoTrue (prefix stripped, like Supabase's gateway); an `apikey` or Authorization header is required;
//   * a second listener serves the e-mail templates GoTrue fetches over HTTP.
// It adds nothing to the Auth behaviour under test: requests and responses pass through untouched.
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const gatewayPort = Number(process.env.STACK_GATEWAY_PORT ?? 54321);
const templatePort = Number(process.env.STACK_TEMPLATE_PORT ?? 54326);
const target = process.env.STACK_GOTRUE_URL ?? "http://127.0.0.1:9999";

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://gateway");
    if (!url.pathname.startsWith("/auth/v1/")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end('{"message":"no Route matched with those values"}');
    }
    if (!req.headers.apikey && !req.headers.authorization) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end('{"message":"No API key found in request"}');
    }
    const t = new URL(target + url.pathname.slice("/auth/v1".length) + url.search);
    const up = http.request(t, { method: req.method, headers: { ...req.headers, host: t.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  })
  .listen(gatewayPort, "127.0.0.1", () => console.log(`gateway on ${gatewayPort}`));

// The templates are read ONCE at start-up into a fixed table; a request can only select a key of that table (never a path).
const templates = new Map(["confirmation", "recovery"].map((n) => [`/${n}.html`, readFileSync(join(here, "templates", `${n}.html`))]));
http
  .createServer((req, res) => {
    const body = templates.get(req.url ?? "");
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  })
  .listen(templatePort, "127.0.0.1");
