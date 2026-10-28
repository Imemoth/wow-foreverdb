import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClassCard } from "@/components/classes/ClassCard";
import { ClassGuidesEntry } from "@/components/classes/ClassGuidesEntry";
import { ClassHero } from "@/components/classes/ClassHero";
import { CARD_ART_POSITION, HERO_ART_POSITION, classCardArt, classIconPath } from "@/lib/classes/art";
import { CLASSES, classPath } from "@/lib/classes/classes";

const PUBLIC = join(process.cwd(), "public");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Width and height of a WebP file (lossy VP8, lossless VP8L or extended VP8X). */
function webpSize(b: Buffer): { w: number; h: number } {
  expect(b.subarray(0, 4).toString()).toBe("RIFF");
  expect(b.subarray(8, 12).toString()).toBe("WEBP");
  const kind = b.subarray(12, 16).toString();
  if (kind === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8L") {
    const v = b.readUInt32LE(21);
    return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  throw new Error(`unknown WebP chunk ${kind}`);
}

// SHA-256 of the shipped files: the icon package's manifest.json, and the optimized copies of the owner's card illustrations.
const ICON_SHA: Record<string, string> = {
  "druid": "e88ae24beb5d07529bccde4999574500824f1046ff3ef4dfb7e7583e3be61bfe",
  "hunter": "8d89a85744b2100d5f41fa27bec1c77dde5ec68465d68f1fbb023f3cdd0d2bb8",
  "mage": "a0f9afd88dd33d5243e4c4150263a4b8410e752930d43029d6adce0986c7f231",
  "paladin": "f3246650c86fb7920fae8a6ef10aeb42dbff0639efe45d0bdf9c0ae30aafbfdb",
  "priest": "b762f04a4ffc612e313746402c2dddf1bb694436c033a0caf34f98e824260de9",
  "rogue": "099d5ab983e3ca7a9f5e63d3c49a03c38825ccba2335f9751898d8e1dc1917c7",
  "shaman": "0f4eddfc56fdf042a84573ed9715c0b083e3e156d157f52fc2376c9a5dcdbf36",
  "warlock": "92673cb459dc770a0e9fd3da89a38d3f4a0a1661e7ca4ffa397a96cb74e14aa4",
  "warrior": "ff9a03a0f2951d309c1fdbbf71779dab3a1b09924b031b5863fefd6905699cfc",
};
const CARD_SHA: Record<string, string> = {
  "druid-640": "19ba914e1e271299a03593fdd11b4927bccea502bd8f8c311f8c3389b988a046",
  "druid": "f0462e6712c5050329f8556f98d59a7ae6858be180a6f3b3f672892ddf9df131",
  "hunter-640": "e5a66925888da52172c3585ad5ea6f25b9905a9fe5cddb1900bec905b9fecbdb",
  "hunter": "400ff4c3161df9c92a63fdc8674851a211dde5e625909ce49b79187c411f5d78",
  "mage-640": "cce3fcb0d3ea6c33d1a0498ae764eca1be6398b811c8081fe195e17e08bdbbe5",
  "mage": "649ed64ecbd3d09158549f13a1e9afe9a04dc2c362478b4c066a8b141a30db9d",
  "paladin-640": "7ad7ddb25033914f4d3f695e3e9edd735e14302ba4c3510cdd93dfd309d9e91d",
  "paladin": "c7c3fe44c45fdd9393a4eeb625934cb66e42b95902ba2d13b2eea5b4f9b485ca",
  "priest-640": "2d7460363128c4dfc6c0f7e57594a251efad35d5b490f9e1ed669ce86666674d",
  "priest": "fe2227102c348e62d27cde3cfc3c77905cf2ceffc1397352ef3177e4f2cbdaa5",
  "rogue-640": "0339efaff8eb311ba6e21b889abcb8010ba55e073807c7a66deb6665cc0ee7d2",
  "rogue": "caf9802bce42f91eafb6aaf1aee147a4191de0ae22e8b3f06cf8b94c24994041",
  "shaman-640": "aea6d7bdca91e3dc629efef71b0bb1497048c37d06444d84da3d86ddd44d354f",
  "shaman": "cd861f2ac6bf40756e8484630490be69b0174e8df648059d5b7fdd11f4273493",
  "warlock-640": "bbe300e0305ae34319449a346a48ac5d3a0eccc19d4a12252bc376e9173dac5a",
  "warlock": "965239f44808e3fb2a3624630d72c1cfde9424d612f7e286a3a62f5dfd02d4b4",
  "warrior-640": "6429ab95d0c21a61af619151d8876674fd36e37591b3cec20cbdbe22ed1aba9b",
  "warrior": "fddfb6cc3d4485de912ab674502cd5f7ad60f7e3c5a719f49b7a9a6dc0210682",
};

describe("class icons (Guides navigation)", () => {
  it("ships exactly the nine package icons: 128x128 WebP, hashes from the package manifest", () => {
    expect(Object.keys(ICON_SHA).sort()).toEqual(CLASSES.map((c) => c.id).sort());
    for (const c of CLASSES) {
      const b = readFileSync(join(PUBLIC, classIconPath(c.id)));
      expect(webpSize(b), c.id).toEqual({ w: 128, h: 128 });
      expect(sha(b), c.id).toBe(ICON_SHA[c.id]);
    }
  });

  it("the navigation lists the classes alphabetically from CLASSES, each linking to its own page with a real icon", () => {
    const html = renderToStaticMarkup(createElement(ClassGuidesEntry));
    const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
    const links = (html.match(/<a [^>]*>/g) ?? [])
      .filter((t) => /^\/guides\/classes\/[a-z]+$/.test(attr(t, "href") ?? ""))
      .map((t) => [attr(t, "href"), attr(t, "aria-label")]);
    expect(links).toEqual(CLASSES.map((c) => [classPath(c.id), `${c.name} class guide`]));
    expect(CLASSES.map((c) => c.name)).toEqual(["Druid", "Hunter", "Mage", "Paladin", "Priest", "Rogue", "Shaman", "Warlock", "Warrior"]);
    for (const c of CLASSES) expect(html).toContain(`src="${classIconPath(c.id)}"`);
    expect(html).toContain('href="/guides/classes"');
    expect(html).not.toMatch(/rounded-full/); // the letter emblems are gone from this panel
  });
});

describe("class card artwork (Choose your class)", () => {
  it("ships a 1024w and a 640w WebP per class at the original aspect ratio, within a size budget, hashes pinned", () => {
    expect(Object.keys(CARD_SHA).sort()).toEqual(CLASSES.flatMap((c) => [c.id, `${c.id}-640`]).sort());
    for (const c of CLASSES) {
      const large = readFileSync(join(PUBLIC, "class-cards", `${c.id}.webp`));
      const small = readFileSync(join(PUBLIC, "class-cards", `${c.id}-640.webp`));
      const L = webpSize(large), S = webpSize(small);
      expect(L.w, c.id).toBe(1024);
      expect(S.w, c.id).toBe(640);
      expect(Math.abs(L.w / L.h - S.w / S.h), c.id).toBeLessThan(0.01);
      expect(L.w / L.h, c.id).toBeGreaterThanOrEqual(4 / 3 - 0.01); // never narrower than the 4:3 card window
      expect(L.w / L.h, c.id).toBeLessThan(1.8);
      expect(large.length, c.id).toBeLessThan(200 * 1024);
      expect(small.length, c.id).toBeLessThan(100 * 1024);
      expect(sha(large), c.id).toBe(CARD_SHA[c.id]);
      expect(sha(small), `${c.id}-640`).toBe(CARD_SHA[`${c.id}-640`]);
    }
  });

  it("every class has art direction and a srcset of its own two files", () => {
    for (const c of CLASSES) {
      expect(CARD_ART_POSITION[c.id], c.id).toMatch(/^object-\[\d+%_\d+%\]$/);
      const art = classCardArt(c.id);
      expect(art.src).toBe(`/class-cards/${c.id}.webp`);
      expect(art.srcSet).toBe(`/class-cards/${c.id}-640.webp 640w, /class-cards/${c.id}.webp 1024w`);
    }
  });

  it("a card has one link to the class, one to its calculator, none nested, and a decorative image", () => {
    for (const c of CLASSES) {
      const html = renderToStaticMarkup(createElement(ClassCard, { info: c }));
      const anchors = html.match(/<a [^>]*>/g) ?? [];
      expect(anchors, c.id).toHaveLength(2);
      expect(html).toContain(`href="${classPath(c.id)}"`);
      expect(html).toContain(`href="${classPath(c.id)}#talents"`);
      expect(html).not.toMatch(/<a [^>]*>(?:(?!<\/a>).)*<a /s); // no anchor opens inside another
      expect(html).toContain(`src="/class-cards/${c.id}.webp"`);
      expect(html).toMatch(/alt="" aria-hidden="true"/);
      expect(html).toContain(CARD_ART_POSITION[c.id]);
    }
  });
});

describe("class detail hero", () => {
  it("every class has hero art direction and the hero reuses the card files (no copies, no letter emblem, no SVG)", () => {
    for (const c of CLASSES) {
      expect(HERO_ART_POSITION[c.id], c.id).toMatch(/^object-\[\d+%_\d+%\]$/);
      const html = renderToStaticMarkup(createElement(ClassHero, { info: c, intro: "Intro text.", hasCalculator: true }));
      expect(html).toContain(`src="/class-cards/${c.id}.webp"`);
      expect(html).toContain(`/class-cards/${c.id}-640.webp 640w`);
      expect(html).toContain(HERO_ART_POSITION[c.id]);
      expect(html).toContain(`>${c.name}</h1>`);
      expect(html).toContain('href="#talents"');
      expect(html).not.toContain("<svg");
      expect(html).not.toMatch(/rounded-full/);
    }
    const none = renderToStaticMarkup(createElement(ClassHero, { info: CLASSES[0]!, intro: "x", hasCalculator: false }));
    expect(none).not.toContain("Open the talent calculator");
  });
});
