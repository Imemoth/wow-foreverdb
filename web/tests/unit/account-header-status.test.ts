import { describe, expect, it, vi } from "vitest";
import type { ApiReply } from "@/lib/account/client";
import { createHeaderStatusStore } from "@/lib/account/header-status";

const reply = (status: number, data: ApiReply["data"] = {}): ApiReply => ({ status, data });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("header Account status store", () => {
  it("starts unknown on the server and on first render", () => {
    const s = createHeaderStatusStore(() => Promise.resolve(reply(401)));
    expect(s.getSnapshot()).toBe("unknown");
    expect(s.getServerSnapshot()).toBe("unknown");
  });

  it("looks the session up once and shares the answer with every entry, including one that mounts later (the mobile menu)", async () => {
    const load = vi.fn(() => Promise.resolve(reply(200, { ok: true })));
    const s = createHeaderStatusStore(load);
    const desktop = vi.fn();
    s.subscribe(desktop);
    s.ensureLoaded();
    s.ensureLoaded(); // a second mounted entry asks again while the first request is in flight
    await flush();
    expect(s.getSnapshot()).toBe("authed");
    expect(desktop).toHaveBeenCalledTimes(1);
    // The mobile menu opens later: it reads "authed" immediately (no guest-link flash) and triggers no new request.
    expect(s.getSnapshot()).toBe("authed");
    s.ensureLoaded();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("maps 401 to guest and an ok:false body to guest", async () => {
    const a = createHeaderStatusStore(() => Promise.resolve(reply(401, { ok: false, error: "unauthenticated" })));
    a.ensureLoaded();
    await flush();
    expect(a.getSnapshot()).toBe("guest");
    const b = createHeaderStatusStore(() => Promise.resolve(reply(200, { ok: false })));
    b.ensureLoaded();
    await flush();
    expect(b.getSnapshot()).toBe("guest");
  });

  it("keeps the guest link and retries later after a failed lookup (network, 404, 503)", async () => {
    for (const status of [0, 404, 503, 500]) {
      const load = vi.fn().mockResolvedValueOnce(reply(status)).mockResolvedValueOnce(reply(200, { ok: true }));
      const s = createHeaderStatusStore(load);
      s.ensureLoaded();
      await flush();
      expect(s.getSnapshot(), String(status)).toBe("unknown");
      s.ensureLoaded();
      await flush();
      expect(s.getSnapshot(), String(status)).toBe("authed");
    }
    const rejects = createHeaderStatusStore(vi.fn().mockRejectedValue(new Error("offline")));
    rejects.ensureLoaded();
    await flush();
    expect(rejects.getSnapshot()).toBe("unknown");
  });

  it("stops notifying an unsubscribed entry", async () => {
    const s = createHeaderStatusStore(() => Promise.resolve(reply(200, { ok: true })));
    const l = vi.fn();
    s.subscribe(l)();
    s.ensureLoaded();
    await flush();
    expect(l).not.toHaveBeenCalled();
  });
});
