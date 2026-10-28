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
  "druid-balance-600": "390a06acc1278b2cb94d139f7b30870c47f23ac915efcf4560b51fa9218e1941",
  "druid-balance": "2c11859309d067c0c819e2ca7a4aea91786096c9eb34089eaba208292be9c796",
  "druid-feral-600": "a30dcfb173fe9966961041be789b2f5f74b8b685535a5ab63f2f633fa67e9eb9",
  "druid-feral": "bdbcb8aec52c7a83fd0ea90556d0f0fae7c707546ce9e4892c40d866d72797f3",
  "druid-restoration-600": "b025e36b67a6dc37bd5c0ed375fc6754bb141fc9bcd8fe8108d1f1375480112b",
  "druid-restoration": "377707fbf501d03fe245d61c728d9d816432a6bae235dfbdb983e818a871ee6c",
  "hunter-beast-mastery-600": "604236b581fc6b1a0083ca2f794160d86fddaa859ff18dcd5b80f57e3492ab95",
  "hunter-beast-mastery": "280b6118fe514074ed6de8612a9987d3bf63824d683c09c1c5bc793880bec19e",
  "hunter-marksmanship-600": "43969572ecf45601f5ff82310eb7784a3462337bc4b483423876905e35c1ad8a",
  "hunter-marksmanship": "c864be27f748333da7552a3bc81ff5d01f5cd8b96541b027e0afb676b2ad919d",
  "hunter-survival-600": "9280ad0804811facb250450e500bda94955d255b85b69ee541230279c9a4e0fe",
  "hunter-survival": "aaa261bacd3f1b6e99264ed876f578c234a4ddac92427687d6e904d8595da620",
  "mage-arcane-600": "7c22590e065cc08646df9cd8ce7c61ed87bb57764422f3f926e05901c948ce1d",
  "mage-arcane": "c84245f335d2178429ab08efee3fe06d6ff07d4bc073578ec566a42580aa35ae",
  "mage-fire-600": "21593ffd31b26b113cdc740189c58c09cead6bd8c81b3a7953624a4536ec2682",
  "mage-fire": "cc9a50fb7a82c927440f73c423ba6fc25fb6545876b5b91ffd9e567221ad171b",
  "mage-frost-600": "b4b7eb2098be81b908a5c6728ba4f6962a95ba388f7541bb5eb27dac27787045",
  "mage-frost": "6a3918c8c8a9523085cc74164acf452317d822a273c92a81670d9022f2bee84c",
  "paladin-holy-600": "d765f2af4abf701ec0aa81563357de7bad77f548ab1c858188c95b5a51366555",
  "paladin-holy": "b0de60e24079528172a37f52aefb62a767a11b6445185de6acd9f6e8adcc1cca",
  "paladin-protection-600": "e3a78248175ca53899ff86f3ec582765b8b33262c365aef5a6848359f4c7984a",
  "paladin-protection": "69e371a1eb68be4bdd1c95ce0b11b51622549978eb19c22a7d10981c2f1caa4a",
  "paladin-retribution-600": "2eafd3accd6831437647cd11b946f1c31e9f0b3548ce2b483968c2055db0f083",
  "paladin-retribution": "d1de779fad92dcc8e4d857143bb034a82e26a8b2b9068314c199050f98479b81",
  "priest-discipline-600": "b151f218e5d2a396a31fb28fab9469e45abc5f0522b0c6c243b5de458f239881",
  "priest-discipline": "51a63420d5076e371a31779262a806f9e6dce853cd8cd9a5a33d6641fa85440a",
  "priest-holy-600": "d31bd8d94823dc9db8c5cb0831780c252a846df57fbba30b896947ddf3faf3db",
  "priest-holy": "fba6fe779da3ceb691d5bfabb62fecc68f5aa86948c1024cc4cbbf7f5568a419",
  "priest-shadow-600": "7e7dcd374a9995220bf8de8bc5a1d611744ba3d9dc9f1eaf67d28d091d0e93f2",
  "priest-shadow": "1a91ec98601a288a3c29a13fc770bcdea370ea2b3b726aa824f254e38e1129fc",
  "rogue-assassination-600": "2b73cee768aa60145f4aaad75277920b337ff9ee273aa3ed99c6a2dd36266021",
  "rogue-assassination": "9855cdbbd0f68cddbdd5a6bda64a485d3ea856509499dd77e52c9f01d5d6bb49",
  "rogue-combat-600": "c25b874e9c562a70ecc042b6cdfad49d0630d83dd7aec789b9fd8af2e645db88",
  "rogue-combat": "6c4bae813f2ddc770d2641f11a5e7bf4a4460ed29d293f25948fe6e6e5987c92",
  "rogue-subtlety-600": "70b111e342a49a37c0b78f27a162f71e273c04c8cfef984aa989b3cc4be0533f",
  "rogue-subtlety": "f89f72e67095658b7776d194c91e939da09ef2ed5e8afd5c8747547a23aabae8",
  "shaman-elemental-600": "8f7f70ccd4eaf88695a60bf1b9b27489b8926b49f74c2378b99d36e153f102eb",
  "shaman-elemental": "4babd672f022b02755b912473aeae0f75b30cfc359b3a74eb19e7d6962ff3c60",
  "shaman-enhancement-600": "f4f36e65c3b9c04b015f47698eb46a44513236c4ff706edd128e4c6537033252",
  "shaman-enhancement": "683b94599be56000640808d2cba80ece8dfbf9c51a8fb8ca09287eafdc9bc846",
  "shaman-restoration-600": "5f34656e0ddb55bd536027674995697b5b8b45e023f456eed0256cf85b5d7a23",
  "shaman-restoration": "e88cd60f5e2de87caebcc83f935c67046a2d7e8b0501f38b24e73e0e9722c839",
  "warlock-affliction-600": "47709bedaa1383c6513a903905152665914b8f704cf0f2bb7a9fa89654fcc9f2",
  "warlock-affliction": "564c932489060489207105a7e41b26a78fc4db1e553ebfbf564234b258afa19f",
  "warlock-demonology-600": "8f5c09a802a505f91c4e51f91355d0b6415bd8bd2d2933b2db58e74def459470",
  "warlock-demonology": "2f50b87cf48ec84f208620c428a7c8bdc2072bdbc646f2829e401a513719cd4a",
  "warlock-destruction-600": "c53806e19a282d93bfad0d566dec020a18d981dc699f3958e137a7786dfcc9e3",
  "warlock-destruction": "ff975631d4dfb5243716208b6808bf33b317cc97a33b428f38be4ee8660e1c0c",
  "warrior-arms-600": "35418c30b7fad0e88b16bcabb46a46deda9006185070e1513482b8e435d729ed",
  "warrior-arms": "ef35c3962fc831d26b690885b7effbf54ed9512244a4a29b4d7e358768b6c76f",
  "warrior-fury-600": "d02dfe35d62de74f6d114b8e0c50472c76c203fc973357792bc892a602978db3",
  "warrior-fury": "d649b633b2c813198439f688b46b6dcbddb2dfaa9af8c1c8ba777b5bedf695b3",
  "warrior-protection-600": "124d9e0726178971e08b9d5dd69159975013cab41e4dea3100dbc3cb71500db1",
  "warrior-protection": "a2fb3912857ce27f888ad4916eb90fd844c72be4abaa2490c3a81ce9024dcff9",
};

describe("talent tree backgrounds", () => {
  it("maps every one of the 27 talent trees to its own file, by the real tree slug", () => {
    const keys = CLASSES.flatMap((c) => (getTalentData(c.id)?.trees ?? []).map((t) => `${c.id}/${t.slug}`));
    expect(keys).toHaveLength(27);
    expect(Object.keys(TREE_BACKGROUNDS).sort()).toEqual([...keys].sort());
    // Every image is used by exactly one tree, and its name starts with its class.
    expect(new Set(Object.values(TREE_BACKGROUNDS)).size).toBe(27);
    for (const [key, stem] of Object.entries(TREE_BACKGROUNDS)) expect(stem.startsWith(`${key.split("/")[0]}-`), key).toBe(true);
    // The names that differ from the tree slug are mapped by slug, not by file name.
    expect(TREE_BACKGROUNDS["druid/feral-combat"]).toBe("druid-feral");
    expect(TREE_BACKGROUNDS["shaman/elemental-combat"]).toBe("shaman-elemental");
    expect(TREE_BACKGROUNDS["priest/shadow-magic"]).toBe("priest-shadow");
  });

  it("ships 900w and 600w WebP encodes of each of the 27 3:4 images, within a size budget, hashes pinned", () => {
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

  it("every tree gets exactly one picture over its vector backdrop (the fallback is always there)", () => {
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
    expect(withArt).toBe(27);
    expect(treeBackgroundArt("priest", "nope")).toBeNull();
  });
});
