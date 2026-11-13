import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apply, initialState, type PreviewAction } from "@/admin-preview/domain/engine";
import { emptySnapshot } from "@/admin-preview/domain/content";
import { sha256Hex } from "@/admin-preview/domain/sha256";
import { diffLines } from "@/admin-preview/domain/diff";
import { sessionView } from "@/admin-preview/domain/selectors";
import type { ArticleSnapshot, Outcome, PreviewState } from "@/admin-preview/domain/types";

class Sim {
  s: PreviewState = initialState();
  last!: Outcome;
  do(a: PreviewAction): Outcome { const r = apply(this.s, a); this.s = r.state; this.last = r.outcome; return r.outcome; }
  as(id: string): this { this.do({ type: "session/switchPersona", personaId: id }); return this; }
}
const good = (over: Partial<ArticleSnapshot> = {}): ArticleSnapshot => ({
  ...emptySnapshot("Test Author"), title: "A perfectly valid title", summary: "A summary that is comfortably longer than twenty characters.",
  body: "## Heading\n\nThis body is comfortably longer than eighty characters so that validation passes for the synthetic preview article.", ...over,
});
function failure(o: Outcome) { if (o.ok) throw new Error("expected failure, got: " + o.message); return o; }
function success(o: Outcome) { if (!o.ok) throw new Error("expected success, got: " + o.message); return o; }

describe("sha256", () => {
  it("matches node:crypto", () => {
    for (const t of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "héllo wörld ✓", "a".repeat(1000)]) {
      expect(sha256Hex(t)).toBe(createHash("sha256").update(t).digest("hex"));
    }
  });
});

describe("diff", () => {
  it("marks added/removed lines", () => {
    const d = diffLines("a\nb\nc", "a\nx\nc");
    expect(d.map((l) => l.kind)).toEqual(["same", "del", "add", "same"]);
  });
});

describe("session", () => {
  it("requires sign-in, TOTP, and derives freshness expiry from the preview clock", () => {
    const sim = new Sim();
    expect(sessionView(sim.s).status).toBe("signed_out");
    failure(sim.do({ type: "article/create", slug: "nope", snapshot: good() }));
    sim.do({ type: "session/signIn", personaId: "st-mira" });
    expect(sessionView(sim.s).status).toBe("mfa_required");
    expect(failure(sim.do({ type: "session/submitMfa", code: "000000" })).code).toBe("mfa_incorrect");
    success(sim.do({ type: "session/submitMfa", code: "123456" }));
    expect(sessionView(sim.s).status).toBe("mfa_verified");
    sim.do({ type: "clock/advance", minutes: 16 });
    expect(sessionView(sim.s).status).toBe("mfa_stale");
    success(sim.do({ type: "session/stepUp", code: "123456" }));
    expect(sessionView(sim.s).status).toBe("mfa_verified");
  });
  it("locks after repeated wrong codes", () => {
    const sim = new Sim();
    sim.do({ type: "session/signIn", personaId: "st-mira" });
    for (let i = 0; i < 3; i++) sim.do({ type: "session/submitMfa", code: "111111" });
    expect(failure(sim.do({ type: "session/submitMfa", code: "123456" })).code).toBe("mfa_locked");
  });
  it("denies a plain User and a suspended account", () => {
    const sim = new Sim();
    sim.do({ type: "session/signIn", personaId: "st-pip" });
    expect(sessionView(sim.s).status).toBe("access_denied");
    sim.do({ type: "session/signIn", personaId: "st-corin" });
    expect(sessionView(sim.s).status).toBe("access_denied");
  });
  it("a revoked session denies every protected action", () => {
    const sim = new Sim().as("st-mira");
    sim.do({ type: "session/revoke" });
    expect(sessionView(sim.s).status).toBe("revoked");
    expect(failure(sim.do({ type: "article/create", slug: "after-revoke", snapshot: good() })).code).toBe("session_revoked");
  });
  it("critical actions need a fresh TOTP, non-critical do not", () => {
    const sim = new Sim().as("st-selene");
    sim.do({ type: "clock/advance", minutes: 20 });
    success(sim.do({ type: "article/create", slug: "still-works", snapshot: good() }));
    expect(failure(sim.do({ type: "article/publish", articleId: "art-4", revisionId: "art-4-r1" })).code).toBe("step_up_required");
  });
});

describe("drafts, immutable revisions and the working-vs-published revision", () => {
  it("creates a draft, reserves the slug, and each save makes a new immutable revision", () => {
    const sim = new Sim().as("st-mira");
    const created = success(sim.do({ type: "article/create", slug: "my-first-draft", snapshot: good() }));
    const id = created.ref!;
    expect(sim.s.revisions.filter((r) => r.articleId === id)).toHaveLength(1);
    const r1 = sim.s.revisions.find((r) => r.id === `${id}-r1`)!;
    success(sim.do({ type: "article/save", articleId: id, baseRevisionId: r1.id, snapshot: good({ title: "A perfectly valid title v2" }) }));
    const revs = sim.s.revisions.filter((r) => r.articleId === id);
    expect(revs.map((r) => r.no)).toEqual([1, 2]);
    expect(sim.s.revisions.find((r) => r.id === r1.id)!.snapshot.title).toBe("A perfectly valid title"); // r1 untouched
    expect(Object.isFrozen(r1.snapshot)).toBe(true);
    expect(failure(sim.do({ type: "article/create", slug: "my-first-draft", snapshot: good() })).fieldErrors?.slug).toMatch(/already reserved/);
    expect(failure(sim.do({ type: "article/create", slug: "entry", snapshot: good() })).fieldErrors?.slug).toMatch(/reserved/);
  });
  it("saving identical content makes no revision; a stale base revision is a conflict", () => {
    const sim = new Sim().as("st-mira");
    const id = success(sim.do({ type: "article/create", slug: "same-content", snapshot: good() })).ref!;
    expect(failure(sim.do({ type: "article/save", articleId: id, baseRevisionId: `${id}-r1`, snapshot: good() })).kind).toBe("noop");
    success(sim.do({ type: "article/save", articleId: id, baseRevisionId: `${id}-r1`, snapshot: good({ title: "A perfectly valid title v2" }) }));
    expect(failure(sim.do({ type: "article/save", articleId: id, baseRevisionId: `${id}-r1`, snapshot: good({ title: "Edited from a stale tab" }) })).code).toBe("stale_revision");
  });
  it("editing a published article leaves the live revision untouched", () => {
    const sim = new Sim().as("st-mira");
    const art = sim.s.articles.find((a) => a.id === "art-1")!;
    expect(art.publishedRevisionId).toBe("art-1-r1");
    success(sim.do({ type: "article/save", articleId: "art-1", baseRevisionId: art.currentRevisionId, snapshot: good({ title: "Census, revised again" }) }));
    const after = sim.s.articles.find((a) => a.id === "art-1")!;
    expect(after.publishedRevisionId).toBe("art-1-r1");
    expect(after.currentRevisionId).toBe("art-1-r3");
  });
});

describe("classification: V1 downgrade prohibition", () => {
  it("refuses to lower a highlighted article, including by unticking featured", () => {
    const sim = new Sim().as("st-isolde");
    const art = sim.s.articles.find((a) => a.id === "art-2")!;
    const head = sim.s.revisions.find((r) => r.id === art.currentRevisionId)!;
    const o = failure(sim.do({ type: "article/save", articleId: "art-2", baseRevisionId: head.id, snapshot: { ...head.snapshot, featured: false, classification: "normal" } }));
    expect(o.code).toBe("classification_downgrade_prohibited");
  });
  it("featured implies highlighted", () => {
    const sim = new Sim().as("st-mira");
    const id = success(sim.do({ type: "article/create", slug: "featured-item", snapshot: good({ featured: true }) })).ref!;
    expect(sim.s.articles.find((a) => a.id === id)!.classificationFloor).toBe("highlighted");
    expect(sim.s.revisions.find((r) => r.id === `${id}-r1`)!.snapshot.classification).toBe("highlighted");
  });
});

describe("independent revision-bound approval of highlighted content", () => {
  const draftHighlighted = (sim: Sim, author: string) => {
    sim.as(author);
    const id = success(sim.do({ type: "article/create", slug: `hl-${author}`, snapshot: good({ featured: true }) })).ref!;
    success(sim.do({ type: "article/submit", articleId: id, revisionId: `${id}-r1` }));
    return id;
  };
  it("rejects self-approval even for an Owner, then accepts an independent Administrator", () => {
    const sim = new Sim();
    const id = draftHighlighted(sim, "st-selene");
    sim.as("st-selene");
    const o = failure(sim.do({ type: "article/approve", articleId: id, revisionId: `${id}-r1` }));
    expect(o.code).toBe("self_approval_forbidden");
    expect(o.message).toMatch(/authored r1/);
    expect(sim.s.audit.at(-1)).toMatchObject({ action: "article.approve", result: "denied", permission: "news.article.approve_highlighted" });
    sim.as("st-aldric");
    success(sim.do({ type: "article/approve", articleId: id, revisionId: `${id}-r1` }));
    expect(sim.s.approvals.find((a) => a.revisionId === `${id}-r1`)).toMatchObject({ approverId: "st-aldric", classification: "highlighted" });
  });
  it("an Editor without the grant cannot approve; an Editor with the grant but who authored cannot either", () => {
    const sim = new Sim();
    const id = draftHighlighted(sim, "st-mira");
    sim.as("st-tomas");
    expect(failure(sim.do({ type: "article/approve", articleId: id, revisionId: `${id}-r1` })).code).toBe("permission_missing");
    const sim2 = new Sim();
    const id2 = draftHighlighted(sim2, "st-isolde");
    sim2.as("st-isolde");
    expect(failure(sim2.do({ type: "article/approve", articleId: id2, revisionId: `${id2}-r1` })).code).toBe("self_approval_forbidden");
    sim2.as("st-mira");
    expect(failure(sim2.do({ type: "article/approve", articleId: id2, revisionId: `${id2}-r1` })).code).toBe("permission_missing");
  });
  it("a substantive editor is not independent either", () => {
    const sim = new Sim().as("st-aldric");
    // art-2 is in review by Isolde; make Aldric... Aldric cannot edit (no draft.write); use an Editor with the approval grant instead.
    sim.as("st-isolde");
    const id = success(sim.do({ type: "article/create", slug: "edited-by-two", snapshot: good({ featured: true }) })).ref!;
    sim.as("st-tomas");
    success(sim.do({ type: "article/save", articleId: id, baseRevisionId: `${id}-r1`, snapshot: good({ featured: true, title: "Edited by another editor" }) }));
    sim.as("st-mira");
    success(sim.do({ type: "article/submit", articleId: id, revisionId: `${id}-r2` }));
    // Isolde authored r1; she holds the approval grant but is a contributor of the article.
    sim.as("st-isolde");
    expect(failure(sim.do({ type: "article/approve", articleId: id, revisionId: `${id}-r2` })).code).toBe("self_approval_forbidden");
  });
  it("approval is bound to the exact revision: an edit voids it for publication", () => {
    const sim = new Sim();
    const id = draftHighlighted(sim, "st-mira");
    sim.as("st-aldric");
    success(sim.do({ type: "article/approve", articleId: id, revisionId: `${id}-r1` }));
    sim.as("st-mira");
    success(sim.do({ type: "article/save", articleId: id, baseRevisionId: `${id}-r1`, snapshot: good({ featured: true, title: "Changed after approval" }) }));
    sim.as("st-selene");
    expect(failure(sim.do({ type: "article/publish", articleId: id, revisionId: `${id}-r1` })).code).toBe("stale_revision");
    expect(failure(sim.do({ type: "article/publish", articleId: id, revisionId: `${id}-r2` })).code).toBe("not_approved");
  });
  it("publishes only after approval, consumes the approval once, and goes public only after the simulated receipt", () => {
    const sim = new Sim();
    const id = draftHighlighted(sim, "st-selene");
    sim.as("st-aldric");
    success(sim.do({ type: "article/approve", articleId: id, revisionId: `${id}-r1` }));
    sim.as("st-selene");
    success(sim.do({ type: "article/publish", articleId: id, revisionId: `${id}-r1` }));
    let art = sim.s.articles.find((a) => a.id === id)!;
    expect(art.delivery).toBe("publish_pending");
    expect(art.publishedRevisionId).toBeNull();
    expect(sim.s.approvalUses).toHaveLength(2); // seeded art-5 + this one
    success(sim.do({ type: "delivery/receipt", articleId: id }));
    art = sim.s.articles.find((a) => a.id === id)!;
    expect(art.delivery).toBe("published");
    expect(art.publishedRevisionId).toBe(`${id}-r1`);
  });
  it("an Owner cannot publish highlighted content without independent approval", () => {
    const sim = new Sim().as("st-selene");
    success(sim.do({ type: "article/create", slug: "owner-highlight", snapshot: good({ featured: true }) }));
    const id = sim.s.articles.at(-1)!.id;
    success(sim.do({ type: "article/submit", articleId: id, revisionId: `${id}-r1` }));
    expect(failure(sim.do({ type: "article/publish", articleId: id, revisionId: `${id}-r1` })).code).toBe("not_approved");
  });
  it("the approver is re-checked at publication time", () => {
    const sim = new Sim();
    const id = draftHighlighted(sim, "st-mira");
    sim.as("st-isolde");
    success(sim.do({ type: "article/approve", articleId: id, revisionId: `${id}-r1` }));
    sim.as("st-selene");
    success(sim.do({ type: "staff/revokeGrant", grantId: "gr-isolde-approve" }));
    expect(failure(sim.do({ type: "article/publish", articleId: id, revisionId: `${id}-r1` })).code).toBe("approval_no_longer_valid");
  });
});

describe("normal publishing and delegation", () => {
  it("an Editor without a grant cannot publish; with an active scoped grant they can self-publish; an expired grant stops working", () => {
    const sim = new Sim().as("st-mira");
    expect(failure(sim.do({ type: "article/publish", articleId: "art-4", revisionId: "art-4-r1" })).code).toBe("permission_missing"); // expired article grant
    sim.as("st-tomas");
    const id = success(sim.do({ type: "article/create", slug: "tomas-self-publish", snapshot: good() })).ref!;
    success(sim.do({ type: "article/submit", articleId: id, revisionId: `${id}-r1` }));
    success(sim.do({ type: "article/approve", articleId: id, revisionId: `${id}-r1` }));
    success(sim.do({ type: "article/publish", articleId: id, revisionId: `${id}-r1` }));
    sim.do({ type: "clock/advance", minutes: 21 * 24 * 60 });
    sim.as("st-tomas");
    expect(failure(sim.do({ type: "article/publish", articleId: "art-4", revisionId: "art-4-r1" })).message).toMatch(/expired/);
  });
  it("Administrator needs a separate grant; Owner may publish a normal article", () => {
    const sim = new Sim().as("st-brenna");
    expect(failure(sim.do({ type: "article/publish", articleId: "art-4", revisionId: "art-4-r1" })).code).toBe("permission_missing");
    sim.as("st-selene");
    success(sim.do({ type: "article/publish", articleId: "art-4", revisionId: "art-4-r1" }));
  });
  it("unpublish removes the live pointer only after the receipt", () => {
    const sim = new Sim().as("st-brenna");
    success(sim.do({ type: "article/unpublish", articleId: "art-1" }));
    expect(sim.s.articles.find((a) => a.id === "art-1")!.publishedRevisionId).toBe("art-1-r1");
    success(sim.do({ type: "delivery/receipt", articleId: "art-1" }));
    expect(sim.s.articles.find((a) => a.id === "art-1")!.publishedRevisionId).toBeNull();
  });
  it("the worker cancels an intent whose actor was revoked before dispatch", () => {
    const sim = new Sim().as("st-selene");
    success(sim.do({ type: "article/publish", articleId: "art-4", revisionId: "art-4-r1" }));
    // Selene cannot suspend herself or an Owner; revoke through Aldric (G grant for access.revoke is absent) -> use Owner on a delegated publisher instead.
    sim.as("st-tomas");
    const id = success(sim.do({ type: "article/create", slug: "revoked-before-dispatch", snapshot: good() })).ref!;
    success(sim.do({ type: "article/submit", articleId: id, revisionId: `${id}-r1` }));
    success(sim.do({ type: "article/approve", articleId: id, revisionId: `${id}-r1` }));
    success(sim.do({ type: "article/publish", articleId: id, revisionId: `${id}-r1` }));
    sim.as("st-selene");
    success(sim.do({ type: "staff/suspend", targetId: "st-tomas", reason: "Compromised session (test)" }));
    const o = failure(sim.do({ type: "delivery/receipt", articleId: id }));
    expect(o.code).toBe("intent_cancelled");
    expect(sim.s.articles.find((a) => a.id === id)!.publishedRevisionId).toBeNull();
  });
  it("failed delivery leaves the previous public state and can be retried without re-authorization", () => {
    const sim = new Sim().as("st-selene");
    success(sim.do({ type: "article/publish", articleId: "art-4", revisionId: "art-4-r1" }));
    success(sim.do({ type: "delivery/fail", articleId: "art-4" }));
    expect(sim.s.articles.find((a) => a.id === "art-4")!.delivery).toBe("delivery_failed");
    success(sim.do({ type: "delivery/retry", articleId: "art-4" }));
    success(sim.do({ type: "delivery/receipt", articleId: "art-4" }));
    expect(sim.s.articles.find((a) => a.id === "art-4")!.delivery).toBe("published");
  });
  it("validation blocks submission (unverified media rights)", () => {
    const sim = new Sim().as("st-mira");
    const id = success(sim.do({ type: "article/create", slug: "bad-media", snapshot: good({ coverMediaId: "media-forum-shot", coverAlt: "A forum screenshot" }) })).ref!;
    const o = failure(sim.do({ type: "article/submit", articleId: id, revisionId: `${id}-r1` }));
    expect(o.fieldErrors?.coverMediaId).toMatch(/rights/);
  });
  it("restoring an old revision makes a NEW head revision that needs fresh approval", () => {
    const sim = new Sim().as("st-mira");
    success(sim.do({ type: "article/restore", articleId: "art-1", fromRevisionId: "art-1-r1" }));
    const art = sim.s.articles.find((a) => a.id === "art-1")!;
    const head = sim.s.revisions.find((r) => r.id === art.currentRevisionId)!;
    expect(head.restoredFromRevisionId).toBe("art-1-r1");
    expect(head.state).toBe("draft");
  });
});

describe("permission denial is audited", () => {
  it("records a denied audit event with the relevant permission and a correlation id", () => {
    const sim = new Sim().as("st-garrick");
    const o = failure(sim.do({ type: "article/create", slug: "moderator-draft", snapshot: good() }));
    expect(o.code).toBe("permission_missing");
    const ev = sim.s.audit.at(-1)!;
    expect(ev).toMatchObject({ result: "denied", permission: "news.draft.write", previewOnly: true, seeded: false });
    expect(ev.correlationId).toMatch(/^PV-\d+$/);
  });
});

describe("staff & roles", () => {
  it("enforces the 90-day grant maximum and rejects missing expiry", () => {
    const sim = new Sim().as("st-selene");
    const base = { type: "staff/createGrant", targetId: "st-mira", permission: "news.article.publish", scope: { kind: "collection", key: "news" }, reason: "Test ticket ED-1" } as const;
    expect(failure(sim.do({ ...base, days: 91 })).code).toBe("grant_too_long");
    expect(failure(sim.do({ ...base, days: 0 })).fieldErrors?.days).toBeDefined();
    const g = success(sim.do({ ...base, days: 30 }));
    expect(sim.s.grants.find((x) => x.id === g.ref)!.expiresAt - sim.s.now).toBe(30 * 86_400_000);
    success(sim.do({ type: "staff/setGrantExpiry", grantId: g.ref!, days: 90 }));
    expect(sim.s.grants.find((x) => x.id === g.ref)!.expiresAt - sim.s.grants.find((x) => x.id === g.ref)!.startsAt).toBe(90 * 86_400_000);
    expect(failure(sim.do({ type: "staff/setGrantExpiry", grantId: g.ref!, days: 91 })).code).toBe("grant_too_long");
  });
  it("blocks privilege escalation: self-assignment, Owner role, above-ceiling roles and grants", () => {
    const sim = new Sim().as("st-brenna");
    expect(failure(sim.do({ type: "staff/proposeRole", targetId: "st-brenna", role: "editor", reason: "make myself editor" })).code).toBe("self_assignment");
    expect(failure(sim.do({ type: "staff/proposeRole", targetId: "st-mira", role: "owner", reason: "promote mira to owner" })).code).toBe("owner_ceremony_only");
    expect(failure(sim.do({ type: "staff/proposeRole", targetId: "st-mira", role: "administrator", reason: "promote mira to admin" })).code).toBe("above_ceiling");
    expect(failure(sim.do({ type: "staff/createGrant", targetId: "st-mira", permission: "news.article.publish", scope: { kind: "collection", key: "news" }, days: 30, reason: "I do not hold publish" })).code).toBe("above_ceiling");
    sim.as("st-mira");
    expect(failure(sim.do({ type: "staff/proposeRole", targetId: "st-mira", role: "administrator", reason: "self promote now" })).code).toBe("permission_missing");
  });
  it("an Administrator can only propose; an independent approver decides; the proposer cannot", () => {
    const sim = new Sim().as("st-brenna");
    const o = success(sim.do({ type: "staff/proposeRole", targetId: "st-pip", role: "moderator", reason: "New community moderator" }));
    expect(failure(sim.do({ type: "staff/decideRequest", requestId: o.ref!, decision: "approve" })).code).toBe("permission_missing");
    sim.as("st-selene");
    success(sim.do({ type: "staff/decideRequest", requestId: o.ref!, decision: "approve" }));
    expect(sim.s.staff.find((x) => x.id === "st-pip")!.roles).toContain("moderator");
  });
  it("an Administrator assignment needs a different approver than the proposer", () => {
    const sim = new Sim().as("st-selene");
    const o = success(sim.do({ type: "staff/proposeRole", targetId: "st-mira", role: "administrator", reason: "Promote Mira to Administrator" }));
    expect(sim.s.staff.find((x) => x.id === "st-mira")!.roles).not.toContain("administrator");
    expect(failure(sim.do({ type: "staff/decideRequest", requestId: o.ref!, decision: "approve" })).code).toBe("own_proposal");
    sim.as("st-aldric");
    success(sim.do({ type: "staff/decideRequest", requestId: o.ref!, decision: "approve" }));
    expect(sim.s.staff.find((x) => x.id === "st-mira")!.roles).toContain("administrator");
  });
  it("protects Owners and the actor from ordinary administration; suspension takes effect on the next decision", () => {
    const sim = new Sim().as("st-selene");
    expect(failure(sim.do({ type: "staff/suspend", targetId: "st-selene", reason: "suspend myself please" })).code).toBe("owner_protected");
    success(sim.do({ type: "staff/suspend", targetId: "st-mira", reason: "Policy review (test)" }));
    sim.do({ type: "session/signIn", personaId: "st-mira" });
    expect(sessionView(sim.s).status).toBe("access_denied");
    sim.as("st-selene");
    success(sim.do({ type: "staff/reactivate", targetId: "st-mira" }));
    sim.as("st-mira");
    expect(sessionView(sim.s).status).toBe("mfa_verified");
  });
  it("owner bootstrap is closed and recovery is a no-op drill", () => {
    const sim = new Sim().as("st-selene");
    expect(failure(sim.do({ type: "owner/bootstrapSim" })).code).toBe("bootstrap_closed");
    const staffBefore = JSON.stringify(sim.s.staff);
    success(sim.do({ type: "owner/recoveryDrill" }));
    expect(JSON.stringify(sim.s.staff)).toBe(staffBefore);
    sim.as("st-brenna");
    expect(failure(sim.do({ type: "owner/recoveryDrill" })).code).toBe("permission_missing");
  });
  it("audit events from simulated operations are all preview-only", () => {
    const sim = new Sim().as("st-selene");
    success(sim.do({ type: "staff/suspend", targetId: "st-garrick", reason: "Test suspension" }));
    expect(sim.s.audit.every((e) => e.previewOnly === true)).toBe(true);
    expect(sim.s.audit.at(-1)).toMatchObject({ action: "staff.suspend", result: "success", permission: "staff.access.revoke" });
  });
});

describe("determinism and immutability of inputs", () => {
  it("apply never mutates its input state", () => {
    const sim = new Sim();
    const frozen = JSON.stringify(sim.s);
    apply(sim.s, { type: "session/switchPersona", personaId: "st-selene" });
    expect(JSON.stringify(sim.s)).toBe(frozen);
  });
});
