// Minimal in-process SMTP sink for the disposable stack: accepts every message GoTrue sends and keeps it in memory.
// Never relays anywhere. Lets the suites run real GoTrue flows (signup, recovery, magic link, email change) without a mail server.
import net from "node:net";

export function startSmtpSink(port = 2525) {
  const messages = [];
  const server = net.createServer((sock) => {
    let buf = "";
    let data = false;
    let cur = { from: "", to: [], body: "" };
    const say = (l) => sock.write(`${l}\r\n`);
    say("220 sink ESMTP");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (data) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end === -1) return;
          cur.body = buf.slice(0, end);
          buf = buf.slice(end + 5);
          data = false;
          messages.push(cur);
          cur = { from: "", to: [], body: "" };
          say("250 queued");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const u = line.toUpperCase();
        if (u.startsWith("EHLO") || u.startsWith("HELO")) say("250 sink");
        else if (u.startsWith("MAIL FROM")) { cur.from = line; say("250 ok"); }
        else if (u.startsWith("RCPT TO")) { cur.to.push(line.slice(8).replace(/[<>\s]/g, "")); say("250 ok"); }
        else if (u === "DATA") { data = true; say("354 go"); }
        else if (u === "QUIT") { say("221 bye"); sock.end(); }
        else say("250 ok");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve({
        messages,
        close: () => new Promise((r) => server.close(r)),
        /** Latest message to `to`, decoded (quoted-printable soft breaks removed). */
        latest(to) {
          const m = [...messages].reverse().find((x) => x.to.includes(to));
          return m ? m.body.replace(/=\r?\n/g, "").replace(/=3D/g, "=") : null;
        },
      }),
    ),
  );
}
