// Test-only fault injector between the website and the end-to-end gateway (never used by any shipped component).
// It forwards everything untouched, except for the modes below, which are switched by the TEST through `POST /__chaos`:
//   drop-redeem-response  the redemption request IS forwarded to PostgREST and COMMITS, but the reply never reaches the website
//                         (socket destroyed): the website sees a connection failure after the request was sent = an UNKNOWN outcome.
//   hang-redeem           the request is forwarded, the reply is withheld until the website's timeout fires.
//   fail-logout           POST /auth/v1/logout answers 500 (the temporary reauthentication session cannot be revoked).
//   fail-global-logout    POST /auth/v1/logout?scope=global answers 500 WITHOUT reaching Auth (nothing is revoked).
//   drop-global-logout-response  the global logout IS forwarded and takes effect, but the reply never reaches the website (ambiguous outcome).
// `GET /__chaos` reports the mode and how many redemption requests were forwarded (proves nothing is retried automatically).
import http from "node:http";

const listen = Number(process.env.CHAOS_PORT ?? 54330);
const upstream = new URL(process.env.CHAOS_UPSTREAM ?? "http://127.0.0.1:54321");
let mode = "pass";
let redeems = 0;
let globalLogouts = 0;

http
  .createServer((req, res) => {
    if (req.url === "/__chaos") {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c)).on("end", () => {
          try { const j = JSON.parse(body); mode = String(j.mode ?? "pass"); if (j.reset) { redeems = 0; globalLogouts = 0; } } catch { /* ignore */ }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ mode, redeems, globalLogouts }));
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ mode, redeems, globalLogouts }));
    }
    const isRedeem = req.url?.startsWith("/rest/v1/rpc/fdb_account_claim_redeem") ?? false;
    if (mode === "fail-logout" && req.url?.startsWith("/auth/v1/logout")) {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end('{"error_code":"unexpected_failure","msg":"injected"}');
    }
    const isGlobalLogout = req.url?.startsWith("/auth/v1/logout?scope=global") ?? false;
    if (isGlobalLogout) globalLogouts += 1;
    if (isGlobalLogout && mode === "fail-global-logout") {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end('{"error_code":"unexpected_failure","msg":"injected"}');
    }
    if (isRedeem) redeems += 1;
    const up = http.request({ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: upstream.host } }, (r) => {
      if (isRedeem && mode === "drop-redeem-response") { r.resume(); r.on("end", () => req.socket.destroy()); return; }
      if (isGlobalLogout && mode === "drop-global-logout-response") { r.resume(); r.on("end", () => req.socket.destroy()); return; }
      if (isRedeem && mode === "hang-redeem") { r.resume(); return; }
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  })
  .listen(listen, "127.0.0.1", () => console.log(`chaos proxy on ${listen} -> ${upstream.origin}`));
