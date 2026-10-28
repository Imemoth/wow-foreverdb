import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TreeBackdrop } from "@/components/classes/backdrops";
import { TREE_BACKGROUNDS, treeBackgroundArt } from "@/lib/classes/art";
import { CLASSES } from "@/lib/classes/classes";
import { getTalentData } from "@/lib/talents/registry";

const DIR = join(process.cwd(), "public", "tree-backgrounds");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function webpSize(b: Buffer): { w: number; h: number } {
  expect(b.subarray(0, 4).toString()).toBe("RIFF");
  expect(b.subarray(8, 12).toString()).toBe("WEBP");
  const kind = b.subarray(12, 16).toString();
  if (kind === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  throw new Error(`unexpected WebP chunk ${kind}`);
}

// SHA-256 of the shipped (optimised) files: the approved illustrations must not be silently replaced.
const SHA: Record<string, string> = {
  "priest-discipline-600": "b151f218e5d2a396a31fb28fab9469e45abc5f0522b0c6c243b5de458f239881",
  "priest-discipline": "51a63420d5076e371a31779262a806f9e6dce853cd8cd9a5a33d6641fa85440a",
  "priest-holy-600": "d31bd8d94823dc9db8c5cb0831780c252a846df57fbba30b896947ddf3faf3db",
  "priest-holy": "fba6fe779da3ceb691d5bfabb62fecc68f5aa86948c1024cc4cbbf7f5568a419",
  "priest-shadow-600": "7e7dcd374a9995220bf8de8bc5a1d611744ba3d9dc9f1eaf67d28d091d0e93f2",
  "priest-shadow": "1a91ec98601a288a3c29a13fc770bcdea370ea2b3b726aa824f254e38e1129fc",
};

describe("talent tree backgrounds", () => {
  it("maps exactly the three Priest trees, each to its own file (the reference implementation)", () => {
    expect(TREE_BACKGROUNDS).toEqual({
      "priest/discipline": "priest-discipline",
      "priest/holy": "priest-holy",
      "priest/shadow-magic": "priest-shadow",
    });
    // Every mapped key is a real tree of a real class.
    for (const key of Object.keys(TREE_BACKGROUNDS)) {
      const [cls, slug] = key.split("/");
      expect(CLASSES.some((c) => c.id === cls), key).toBe(true);
      expect(getTalentData(cls!)?.trees.some((t) => t.slug === slug), key).toBe(true);
    }
    // The three images are different files.
    expect(new Set(Object.values(TREE_BACKGROUNDS)).size).toBe(3);
  });

  it("ships 900w and 600w WebP encodes of each 3:4 image, within a size budget, hashes pinned", () => {
    expect(readdirSync(DIR).map((f) => f.replace(/\.webp$/, "")).sort()).toEqual(Object.keys(SHA).sort());
    for (const stem of Object.values(TREE_BACKGROUNDS)) {
      const large = readFileSync(join(DIR, `${stem}.webp`));
      const small = readFileSync(join(DIR, `${stem}-600.webp`));
      expect(webpSize(large), stem).toEqual({ w: 900, h: 1200 });
      expect(webpSize(small), stem).toEqual({ w: 600, h: 800 });
      expect(large.length, stem).toBeLessThan(200 * 1024);
      expect(small.length, stem).toBeLessThan(120 * 1024);
      expect(sha(large), stem).toBe(SHA[stem]);
      expect(sha(small), `${stem}-600`).toBe(SHA[`${stem}-600`]);
    }
  });

  it("only the mapped trees get a picture; every other tree keeps its vector backdrop alone", () => {
    let withArt = 0;
    for (const c of CLASSES) {
      for (const t of getTalentData(c.id)?.trees ?? []) {
        const html = renderToStaticMarkup(createElement(TreeBackdrop, { classId: c.id, treeSlug: t.slug }));
        const mapped = `${c.id}/${t.slug}` in TREE_BACKGROUNDS;
        expect(html.includes('data-testid="backdrop-photo"'), `${c.id}/${t.slug}`).toBe(mapped);
        expect(html, `${c.id}/${t.slug}`).toContain('data-testid="backdrop-tree"'); // the vector backdrop is always there (fallback)
        if (mapped) {
          withArt++;
          const art = treeBackgroundArt(c.id, t.slug)!;
          expect(html).toContain(`src="${art.src}"`);
          expect(html).toContain('alt="" aria-hidden="true"');
        }
      }
    }
    expect(withArt).toBe(3);
    expect(treeBackgroundArt("priest", "nope")).toBeNull();
  });
});
