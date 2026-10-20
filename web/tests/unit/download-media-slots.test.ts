import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADDON_MEDIA_SLOTS, COMPANION_MEDIA_SLOTS, MEDIA_SLOTS, slotsFor } from "@/lib/download/media-slots";

const PUBLIC_DIR = join(__dirname, "..", "..", "public");

describe("/download media-slot registry", () => {
  it("every slot has a unique, stable id", () => {
    const ids = MEDIA_SLOTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("splits cleanly into the addon and companion groups", () => {
    expect(slotsFor("addon")).toEqual(ADDON_MEDIA_SLOTS);
    expect(slotsFor("companion")).toEqual(COMPANION_MEDIA_SLOTS);
    expect(ADDON_MEDIA_SLOTS.every((s) => s.group === "addon")).toBe(true);
    expect(COMPANION_MEDIA_SLOTS.every((s) => s.group === "companion")).toBe(true);
  });

  it("no slot currently claims a real asset that isn't actually on disk (prevents a broken-image request)", () => {
    for (const slot of MEDIA_SLOTS) {
      if (!slot.asset) continue;
      const onDisk = join(PUBLIC_DIR, slot.asset.replace(/^\//, ""));
      expect(existsSync(onDisk), `${slot.id}: asset "${slot.asset}" does not exist on disk`).toBe(true);
    }
  });

  it("this round ships no real screenshots yet - every slot is an intentional placeholder", () => {
    expect(MEDIA_SLOTS.every((s) => !s.asset)).toBe(true);
  });

  it("intendedFilename is a plain .webp basename, not a path, for every slot", () => {
    for (const slot of MEDIA_SLOTS) {
      expect(slot.intendedFilename).toMatch(/^[a-z0-9-]+\.webp$/);
    }
  });
});
