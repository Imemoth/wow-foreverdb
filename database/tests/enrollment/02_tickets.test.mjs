// Ticket issuance, hashing, caps, listing, revocation and every refusal state of redemption (tests 5 of the acceptance list).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { TICKET_RE, dumpPrivateTables, expectCode, instId, makeWorld, sha256 } from "./world.mjs";

let w;
before(async () => {
  w = await makeWorld();
});
after(async () => {
  await w.close();
});

describe("issuance", () => {
  it("returns a 256-bit URL-safe ticket once, valid for exactly 168 hours, and stores only its sha256", async () => {
    const a = await w.account();
    const out = await w.ticket(a, "Home PC");
    assert.match(out.ticket, TICKET_RE);
    const ms = new Date(out.expires_at).getTime() - Date.now();
    assert.ok(ms > 168 * 3600_000 - 10_000 && ms <= 168 * 3600_000, `expires in ${ms} ms`);
    const row = await w.ticket_row(out.ticket_id);
    assert.equal(row.account_uid, a.uid);
    assert.equal(row.status, "pending");
    assert.ok(Buffer.from(row.ticket_hash).equals(sha256(out.ticket)), "hash is sha256 of the raw ticket");
    assert.equal(row.label, "Home PC");
    assert.ok(new Date(row.expires_at) <= new Date(new Date(row.created_at).getTime() + 168 * 3600_000));
  });

  it("the raw ticket never appears in any private table or audit row; the audit row has no secret column", async () => {
    const a = await w.account();
    const out = await w.ticket(a);
    const dump = await dumpPrivateTables(w.admin);
    assert.ok(!dump.includes(out.ticket), "raw ticket stored somewhere");
    assert.ok(!dump.includes(out.ticket.slice(6)), "ticket body stored somewhere");
    const [audit] = await w.audit("ticket_id = $1", [out.ticket_id]);
    assert.equal(audit.event, "ticket_issued");
    assert.equal(audit.account_uid, a.uid);
  });

  it("tickets are unique and unguessable (no shared prefix beyond the format marker)", async () => {
    const a = await w.account();
    const seen = new Set();
    for (let i = 0; i < 5; i += 1) {
      const t = await w.ticket(a);
      assert.ok(!seen.has(t.ticket));
      seen.add(t.ticket);
      await w.admin.query("update private.enrollment_tickets set status = 'revoked' where id = $1", [t.ticket_id]); // keep under the cap
    }
    const bodies = [...seen].map((t) => t.slice(6, 12));
    assert.ok(new Set(bodies).size > 1);
  });

  it("sanitises the label (control characters removed, 60 characters, blank becomes null)", async () => {
    const a = await w.account();
    const t1 = await w.ticket(a, "  Work\u0001\u0007 PC\n  ");
    assert.equal((await w.ticket_row(t1.ticket_id)).label, "Work PC");
    await w.admin.query("update private.enrollment_tickets set status = 'revoked' where account_uid = $1", [a.uid]);
    const t2 = await w.ticket(a, "x".repeat(200));
    assert.equal((await w.ticket_row(t2.ticket_id)).label.length, 60);
    await w.admin.query("update private.enrollment_tickets set status = 'revoked' where account_uid = $1", [a.uid]);
    const t3 = await w.ticket(a, "   ");
    assert.equal((await w.ticket_row(t3.ticket_id)).label, null);
  });

  it("caps pending tickets at 5 (a result, not an error) and lifts the cap when one is revoked", async () => {
    const a = await w.account();
    const issued = [];
    for (let i = 0; i < 5; i += 1) issued.push(await w.ticket(a));
    assert.deepEqual(await w.issue(a), { ok: false, error: "ticket_limit" });
    const rev = await a.call("fdb_account_enrollment_ticket_revoke", [issued[0].ticket_id]);
    assert.deepEqual(rev, { ok: true });
    assert.equal((await w.issue(a)).ok, true);
  });

  it("an expired pending ticket no longer counts against the pending cap", async () => {
    const a = await w.account();
    const issued = [];
    for (let i = 0; i < 5; i += 1) issued.push(await w.ticket(a));
    await w.admin.query("update private.enrollment_tickets set expires_at = now() - interval '1 minute' where id = $1", [issued[0].ticket_id]);
    assert.equal((await w.issue(a)).ok, true);
  });

  it("caps issuance at 10 per rolling hour even when tickets were revoked, and is scoped per account", async () => {
    const a = await w.account();
    const b = await w.account();
    for (let i = 0; i < 10; i += 1) {
      const t = await w.ticket(a);
      await a.call("fdb_account_enrollment_ticket_revoke", [t.ticket_id]);
    }
    assert.deepEqual(await w.issue(a), { ok: false, error: "ticket_limit" });
    assert.equal((await w.issue(b)).ok, true, "another account is unaffected");
  });

  it("the per-account call budget raises PT429 (rate limit) after 10 calls in a window", async () => {
    const a = await w.account();
    await w.fx.resetBudgets();
    for (let i = 0; i < 10; i += 1) await a.call("fdb_account_enrollment_ticket_issue", []);
    await expectCode(a.call("fdb_account_enrollment_ticket_issue", []), "PT429");
  });
});

describe("listing and revocation", () => {
  it("lists only the caller's tickets with computed status, newest first, no secret fields", async () => {
    const a = await w.account();
    const b = await w.account();
    const t1 = await w.ticket(a, "one");
    const t2 = await w.ticket(a, "two");
    const t3 = await w.ticket(a, "three");
    await w.ticket(b, "other account");
    await w.admin.query("update private.enrollment_tickets set expires_at = now() - interval '1 second' where id = $1", [t1.ticket_id]);
    await a.call("fdb_account_enrollment_ticket_revoke", [t2.ticket_id]);
    await w.fx.resetBudgets();
    const rows = await a.call("fdb_account_enrollment_tickets");
    assert.equal(rows.length, 3);
    const by = Object.fromEntries(rows.map((r) => [r.label, r.status]));
    assert.deepEqual(by, { one: "expired", two: "revoked", three: "pending" });
    for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ["consumed_at", "created_at", "device_id", "expires_at", "label", "status", "ticket_id"]);
    assert.equal(rows[0].ticket_id, t3.ticket_id, "newest first");
  });

  it("revocation works for the owner on a pending ticket only; every other case is the single answer not_available", async () => {
    const a = await w.account();
    const b = await w.account();
    const t = await w.ticket(a);
    // another account cannot revoke it and cannot learn that it exists
    assert.deepEqual(await b.call("fdb_account_enrollment_ticket_revoke", [t.ticket_id]), { ok: false, error: "not_available" });
    assert.equal((await w.ticket_row(t.ticket_id)).status, "pending");
    assert.deepEqual(await b.call("fdb_account_enrollment_ticket_revoke", ["11111111-1111-1111-1111-111111111111"]), { ok: false, error: "not_available" });
    assert.deepEqual(await a.call("fdb_account_enrollment_ticket_revoke", [t.ticket_id]), { ok: true });
    assert.deepEqual(await a.call("fdb_account_enrollment_ticket_revoke", [t.ticket_id]), { ok: false, error: "not_available" }, "already revoked");
    const audit = await w.audit("ticket_id = $1 and event = 'ticket_revoked'", [t.ticket_id]);
    assert.equal(audit.length, 1);
  });

  it("a consumed ticket cannot be 'revoked' (the device it created is not touched)", async () => {
    const a = await w.account();
    const e = await w.enrolled(a);
    assert.deepEqual(await a.call("fdb_account_enrollment_ticket_revoke", [e.ticket.ticket_id]), { ok: false, error: "not_available" });
    assert.equal((await w.device_row(e.deviceId)).status, "active");
  });
});

describe("redemption refusals (replay, expiry, revocation, format)", () => {
  it("a consumed ticket cannot be replayed: not by the same identity, not by another, not for another installation", async () => {
    const a = await w.account();
    const e = await w.enrolled(a);
    const other = await w.device();
    assert.deepEqual(await w.enroll(e.device, e.ticket.ticket, e.installationId), { ok: false, error: "ticket_consumed" });
    assert.deepEqual(await w.enroll(other, e.ticket.ticket, e.installationId), { ok: false, error: "ticket_consumed" });
    assert.deepEqual(await w.enroll(other, e.ticket.ticket, instId()), { ok: false, error: "ticket_consumed" });
    assert.equal((await w.admin.query("select count(*)::int n from private.devices where ticket_id = $1", [e.ticket.ticket_id])).rows[0].n, 1, "still exactly one device");
    const refused = await w.audit("ticket_id = $1 and event = 'enroll_refused'", [e.ticket.ticket_id]);
    assert.equal(refused.length, 3);
    assert.ok(refused.every((r) => r.detail === "ticket_consumed"));
  });

  it("an expired ticket is refused at redemption time (day 8) and nothing is created or reserved", async () => {
    const a = await w.account();
    const t = await w.ticket(a);
    await w.admin.query("update private.enrollment_tickets set created_at = now() - interval '168 hours 1 minute', expires_at = now() - interval '1 minute' where id = $1", [t.ticket_id]);
    const d = await w.device();
    const inst = instId();
    assert.deepEqual(await w.enroll(d, t.ticket, inst), { ok: false, error: "ticket_expired" });
    assert.equal((await w.row("select count(*)::int n from public.installations where id = $1", [inst]))[0].n, 0, "installation not reserved");
    assert.equal((await w.row("select count(*)::int n from private.devices where account_uid = $1", [a.uid]))[0].n, 0);
    assert.equal((await w.ticket_row(t.ticket_id)).status, "pending", "an expired ticket is not consumed or rewritten");
  });

  it("a ticket is valid right up to 168 hours: 167h59m still redeems, the 168th hour does not", async () => {
    const a = await w.account();
    const t1 = await w.ticket(a);
    await w.admin.query("update private.enrollment_tickets set created_at = now() - interval '167 hours 59 minutes', expires_at = now() + interval '30 seconds' where id = $1", [t1.ticket_id]);
    assert.equal((await w.enroll(await w.device(), t1.ticket, instId())).ok, true);
    const t2 = await w.ticket(a);
    await w.admin.query("update private.enrollment_tickets set created_at = now() - interval '168 hours', expires_at = now() where id = $1", [t2.ticket_id]);
    assert.deepEqual(await w.enroll(await w.device(), t2.ticket, instId()), { ok: false, error: "ticket_expired" });
  });

  it("a revoked ticket is refused (the downloaded file became inert)", async () => {
    const a = await w.account();
    const t = await w.ticket(a);
    await a.call("fdb_account_enrollment_ticket_revoke", [t.ticket_id]);
    assert.deepEqual(await w.enroll(await w.device(), t.ticket, instId()), { ok: false, error: "ticket_revoked" });
  });

  it("unknown and malformed tickets and malformed installation ids are refused without detail; a lookalike of a real ticket is unknown", async () => {
    const a = await w.account();
    const t = await w.ticket(a);
    const d = await w.device();
    const flipped = t.ticket.slice(0, -1) + (t.ticket.endsWith("A") ? "B" : "A");
    for (const bad of [flipped, "fdba1_" + "A".repeat(43), "FDBA1_" + t.ticket.slice(6), t.ticket + "x", t.ticket.slice(0, -1), "", null]) {
      assert.deepEqual(await w.enroll(d, bad, instId()), { ok: false, error: "invalid_ticket" }, String(bad));
    }
    for (const badInst of ["short", "has space 0123456789abcdef", "-leading0123456789abcdef", "x".repeat(129), null]) {
      assert.deepEqual(await w.enroll(d, t.ticket, badInst), { ok: false, error: "invalid_installation" }, String(badInst));
    }
    assert.equal((await w.ticket_row(t.ticket_id)).status, "pending", "garbage attempts never consume the real ticket");
  });

  it("repeated invalid redemptions hit the per-identity budget (PT429), and the budget is charged even though failures are results", async () => {
    const d = await w.device();
    await w.fx.resetBudgets();
    const bad = "fdba1_" + "B".repeat(43);
    for (let i = 0; i < 5; i += 1) assert.deepEqual(await d.call("fdb_device_enroll", [bad, instId(), "x"]), { ok: false, error: "invalid_ticket" });
    await expectCode(d.call("fdb_device_enroll", [bad, instId(), "x"]), "PT429");
  });

  it("a ticket whose account was banned or deleted cannot be redeemed (account_unavailable) and stays unconsumed", async () => {
    const a = await w.account();
    const t = await w.ticket(a);
    await w.admin.query("update auth.users set banned_until = now() + interval '1 day' where id = $1", [a.uid]);
    const inst = instId();
    assert.deepEqual(await w.enroll(await w.device(), t.ticket, inst), { ok: false, error: "account_unavailable" });
    assert.equal((await w.ticket_row(t.ticket_id)).status, "pending");
    assert.equal((await w.row("select count(*)::int n from public.installations where id = $1", [inst]))[0].n, 0);
  });
});
