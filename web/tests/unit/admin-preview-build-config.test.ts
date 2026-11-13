import { afterEach, describe, expect, it, vi } from "vitest";

async function loadConfig() {
  vi.resetModules();
  return (await import("../../next.config")).default;
}
afterEach(() => vi.unstubAllEnvs());

describe("next.config: the preview build switch", () => {
  it("a normal build has the flag constant-folded to 0 and none of the preview build options", async () => {
    vi.stubEnv("AZERDEX_ADMIN_PREVIEW_BUILD", "");
    const c = await loadConfig();
    expect(c.env).toEqual({ AZERDEX_ADMIN_PREVIEW_BUILD: "0" });
    expect(c.distDir).toBeUndefined();
    expect(c.pageExtensions).toBeUndefined();
  });
  it("only the exact value 1 selects the preview build, with its own distDir and page extension", async () => {
    for (const v of ["true", "yes", "2", " 1"]) { vi.stubEnv("AZERDEX_ADMIN_PREVIEW_BUILD", v); expect((await loadConfig()).pageExtensions, v).toBeUndefined(); }
    vi.stubEnv("AZERDEX_ADMIN_PREVIEW_BUILD", "1");
    const c = await loadConfig();
    expect(c.env).toEqual({ AZERDEX_ADMIN_PREVIEW_BUILD: "1" });
    expect(c.distDir).toBe(".next-admin-preview");
    expect(c.pageExtensions).toContain("preview.tsx");
  });
  it("refuses to configure a preview build in any hosted (Vercel) environment", async () => {
    vi.stubEnv("AZERDEX_ADMIN_PREVIEW_BUILD", "1");
    for (const k of ["VERCEL", "VERCEL_ENV", "VERCEL_URL"]) {
      vi.stubEnv(k, "1");
      await expect(loadConfig(), k).rejects.toThrow(/never be set for a hosted/);
      vi.stubEnv(k, "");
    }
  });
});
