import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { RACE_ART_SIZE, RACE_ART_WIDTHS, RACE_CARD_SIZES, RACE_HERO_POSITION, RACE_HERO_SIZES, raceArt, raceThumbArt } from "@/lib/races/art";
import { RACE_IDENTITIES } from "@/lib/races/identities";
import { RACE_GUIDES } from "@/lib/races/registry";

const DIR = join(process.cwd(), "public", "race-cards");
const SLUGS = RACE_IDENTITIES.map((r) => r.id);

/**
 * The shipped WebP set, produced from the owner's ten PNGs by scripts/build-race-art.mjs (reproducible: re-running it gives these exact
 * hashes). A changed file fails here on purpose; regenerate, then update this table and docs/web/race-art.md together.
 */
const FILES: Record<string, { w: number; h: number; bytes: number; sha256: string }> = {
  "human-240.webp": { w: 240, h: 320, bytes: 21210, sha256: "32c0a925e204ee90c5eaf3231d7cc1eec7638cfd59cac43ba3f9ae886f316537" },
  "human-540.webp": { w: 540, h: 720, bytes: 86250, sha256: "c4267a781e3ae2476a016136086e3209cf76d80ee7d9b23da7acc785c6531bad" },
  "human-800.webp": { w: 800, h: 1067, bytes: 159556, sha256: "23f3575825590c9ae2721f37c56e961ff2299ecea6b341780902ef3957384526" },
  "human.webp": { w: 1086, h: 1448, bytes: 237946, sha256: "8165c6b0bc6d93fb731e5e8e344e0571112d9ee6f5bac64e244edfea913b1d73" },
  "dwarf-240.webp": { w: 240, h: 320, bytes: 22262, sha256: "219de31605742c34c691059474197724ca641592b71b712aaf2c9860dee49a8c" },
  "dwarf-540.webp": { w: 540, h: 720, bytes: 96220, sha256: "bb86796515814e666250ac3dce8b6b1a60abe62adc7e7723b809d97de5de8df3" },
  "dwarf-800.webp": { w: 800, h: 1067, bytes: 180692, sha256: "606f9f9096e92fe3ad0c6190745a4ee5ea0a013294d59b4cf9615f276e81fcfb" },
  "dwarf.webp": { w: 1086, h: 1448, bytes: 279018, sha256: "626757b1b2be9a069097cfed1e5775a23f6177283e7f87740ee2b06be0ba0430" },
  "night-elf-240.webp": { w: 240, h: 320, bytes: 23340, sha256: "10798e774140e34c76b78e41e26dc8a3e053981f7b0414a3dffb27d9bb98c608" },
  "night-elf-540.webp": { w: 540, h: 720, bytes: 103276, sha256: "d9a05f1321382582b92e4118f50e74aa283bd0308a44ccd11e08cd4b8fe36492" },
  "night-elf-800.webp": { w: 800, h: 1067, bytes: 194842, sha256: "0403e8670d48c68414ac64b3343ea84bdefedc96e8f6f8154acffe6867a8afc6" },
  "night-elf.webp": { w: 1086, h: 1448, bytes: 297242, sha256: "01a73a694a258d8894a313d6899dcb61b96a75585e76285b31bff451d2487f1a" },
  "gnome-240.webp": { w: 240, h: 320, bytes: 25020, sha256: "c702837db0345aa68837378eabaf28325e185b7f79c56c142d72f24dc6512e84" },
  "gnome-540.webp": { w: 540, h: 720, bytes: 103498, sha256: "2ef29a4d6c6c5f0b2a157caa6d3397196afea31812dcb6b51b651b7b5cf5f72d" },
  "gnome-800.webp": { w: 800, h: 1067, bytes: 188458, sha256: "13dc9763e1e20867ef8f58dfc9a6748c094c2a338351986432cbc3dadc39f2da" },
  "gnome.webp": { w: 1086, h: 1448, bytes: 278766, sha256: "4cce570c7ab36ca00988e692d1073bfe07b3abadfd61d1ced7643060cefb1dff" },
  "high-order-skyborne-240.webp": { w: 240, h: 320, bytes: 27642, sha256: "7130b333baf021bb68fbf661da226d98a1fca891de79adc06d7d9f5157ce9265" },
  "high-order-skyborne-540.webp": { w: 540, h: 720, bytes: 116176, sha256: "0bb788ff5e5e9952dd5e2aa6f7fdd981b77a91714d0cc6a88a72c170fc0324f5" },
  "high-order-skyborne-800.webp": { w: 800, h: 1067, bytes: 216360, sha256: "c4c0ebd59dd568ce68e26e5a55cd7118551207f89faf6d34f4eccfe93b03e036" },
  "high-order-skyborne.webp": { w: 1086, h: 1448, bytes: 333812, sha256: "03057ee0adace398b3c4bd19f980effb49be0b662a6923ebe4257334ae70bbf8" },
  "orc-240.webp": { w: 240, h: 320, bytes: 23272, sha256: "d48e86d7d91b9c7a8186885442c570be3aebcd69256879ba4529927c50c969a0" },
  "orc-540.webp": { w: 540, h: 720, bytes: 96190, sha256: "f6c6a8e92df9bff714377550ad56226fc34f712a3930c4aaefd2296790963233" },
  "orc-800.webp": { w: 800, h: 1067, bytes: 176936, sha256: "cccfb7c762f86553a50ff80954f435c293b68dc46a0c1b687c50f3ec037afb85" },
  "orc.webp": { w: 1086, h: 1448, bytes: 261938, sha256: "58e1a1ba7878ee242a4a58c198a994992dff26c47a0eb33c5b40b0e48ce57937" },
  "tauren-240.webp": { w: 240, h: 320, bytes: 24706, sha256: "8fccf29190bd04c1700e7f9a53c59927f3e5f6ffa28982699a2950233badf6d4" },
  "tauren-540.webp": { w: 540, h: 720, bytes: 110888, sha256: "cb8d7cb9a2d9f848295ace54e4ded6b3fc4159b4173b682615293a9f209e7f02" },
  "tauren-800.webp": { w: 800, h: 1067, bytes: 205992, sha256: "6c8f2a3a6aae893ce46f579e548856de8a7f063a2acda78eaa33d10fd9b2e01f" },
  "tauren.webp": { w: 1086, h: 1448, bytes: 311974, sha256: "d12fed8140c0e91a01b39ce5c785d9f6f60fd2ea0ec933a3b0503ac2e7aa6e80" },
  "troll-240.webp": { w: 240, h: 320, bytes: 27754, sha256: "79ca201d79af7271f890ca60e5dab952bbd89346bf10e7e3c681f3744b4e6bfc" },
  "troll-540.webp": { w: 540, h: 720, bytes: 125436, sha256: "dc091c36aec0f00a506e13db4c57aec1275fdc4583f188bddc0523e33a81be29" },
  "troll-800.webp": { w: 800, h: 1067, bytes: 234924, sha256: "1effc821113f78128ae89297e680604190dfb1f3ffc2b46dcc93ea602d206684" },
  "troll.webp": { w: 1086, h: 1448, bytes: 350738, sha256: "b5a8b9e8cf3882b54ad49ffa4e0bfb913367aa40bd3431ef06b3f90086be232e" },
  "undead-240.webp": { w: 240, h: 320, bytes: 23476, sha256: "afd791e9fb18d134c992dff90715e6beb4199983888e4ce5e392a88375d8744a" },
  "undead-540.webp": { w: 540, h: 720, bytes: 103752, sha256: "71299459d740887ae1537c7f0c7c46580e608bc22a550d55087c67bbf0170bb2" },
  "undead-800.webp": { w: 800, h: 1067, bytes: 192262, sha256: "bfea665a0fc237e666786572b497bf93c8434106f0e6c573432da761606b0b5a" },
  "undead.webp": { w: 1086, h: 1448, bytes: 289868, sha256: "2da3c5eb897d8ce901ab4521fc3044c60729d2d94a995ea7fd80586b102aa4aa" },
  "windshaper-skyborne-240.webp": { w: 240, h: 320, bytes: 27306, sha256: "3320ae9022c2805b3de72aca31a423f1a42a57793041cbc7315cb3af98a35021" },
  "windshaper-skyborne-540.webp": { w: 540, h: 720, bytes: 114050, sha256: "39b4548932dd4ed79f5e92ab55e818b7addce56de29eaf804a3ce1fe1a0493d5" },
  "windshaper-skyborne-800.webp": { w: 800, h: 1067, bytes: 210318, sha256: "5e70cbd975e6b6b9ad4f08aea9b0b4773a007e4c16376f384945066553a50719" },
  "windshaper-skyborne.webp": { w: 1086, h: 1448, bytes: 311702, sha256: "0e95030319efdb92d46fb185d13bac996be408b11f4cd27851f3ad2f276eeb0e" },
};

/** SHA-256 of the owner-provided source PNGs (not in the repository), for traceability. */
const SOURCE_SHA256: Record<string, string> = {
  "dwarf.png": "a3ea35ea1c71f4221f01621aee3a90031967becb97db15f22face437c5d10abb",
  "gnome.png": "9abab9f61331cafbac0b422cc866ccbd1bad70dc8827664e287a67abca8103c0",
  "High-Order-Skyborne.png": "0e304a4ae08053f48223e49757ace0517a1ac54ac00a49552587599734da645d",
  "Human.png": "b8ee90006acafc4296affc4eda4bf3795f2f3101e66238a64cc2995b74e21fd5",
  "night-elf.png": "0c55d7d4d5b70b094d5faa4ed68171175bf2c2610412ff46993bfe6d4a153500",
  "orc.png": "40fc3e9fdb328b44e6021dfc0c79eed75506530dcc36921caa1f9a13f054c57e",
  "tauren.png": "66f22141cecfe66af40f240c718c1d8454cef07c79fa09dc9df016ef43192e96",
  "troll.png": "c730bc02c91f50f4af558259f97e0c8b7c58373e534bb46cb656b8b3b85822f6",
  "undead.png": "a4a945a5b8ab2935f928cba7d020df99cced1b161e0abb7504a2d2d3233fcbe7",
  "Windshaper-Skyborne.png": "6f5d729cd6a6cefe74789c9dd6221c2d67a182061df2d1d7326641a61050a174",
};

describe("race artwork files", () => {
  it("has exactly the four variants of each of the ten races and nothing else", () => {
    const expected = SLUGS.flatMap((s) => RACE_ART_WIDTHS.map((w) => (w === RACE_ART_SIZE.width ? `${s}.webp` : `${s}-${w}.webp`))).sort();
    expect(readdirSync(DIR).sort()).toEqual(expected);
    expect(Object.keys(FILES).sort()).toEqual(expected);
    expect(SLUGS).toHaveLength(10);
  });

  it("matches the pinned manifest (bytes and SHA-256), so a swapped or re-encoded file is noticed", () => {
    for (const [name, m] of Object.entries(FILES)) {
      const buf = readFileSync(join(DIR, name));
      expect(buf.length, name).toBe(m.bytes);
      expect(createHash("sha256").update(buf).digest("hex"), name).toBe(m.sha256);
    }
  });

  it("keeps the 3:4 portrait aspect ratio of the source at every size and never upscales past the native 1086 x 1448", async () => {
    for (const [name, m] of Object.entries(FILES)) {
      const meta = await sharp(join(DIR, name)).metadata();
      expect(meta.format, name).toBe("webp");
      expect([meta.width, meta.height], name).toEqual([m.w, m.h]);
      expect(meta.width!, name).toBeLessThanOrEqual(RACE_ART_SIZE.width);
      expect(Math.abs(meta.width! / meta.height! - RACE_ART_SIZE.width / RACE_ART_SIZE.height), name).toBeLessThan(0.002);
    }
  });

  it("stays within an asset budget: no PNG in the bundle, small thumbnails, bounded card and hero files, 6.5 MiB in total", () => {
    expect(readdirSync(DIR).filter((f) => !f.endsWith(".webp"))).toEqual([]);
    let total = 0;
    for (const [name, m] of Object.entries(FILES)) {
      total += m.bytes;
      const limit = name.endsWith("-240.webp") ? 40 : name.endsWith("-540.webp") ? 150 : name.endsWith("-800.webp") ? 260 : 400;
      expect(m.bytes / 1024, name).toBeLessThan(limit);
    }
    expect(total / 1024 / 1024).toBeLessThan(6.5);
    // The ten source PNGs were roughly 3 MB each; the largest shipped file is an order of magnitude smaller.
    expect(Math.max(...Object.values(FILES).map((f) => f.bytes))).toBeLessThan(400 * 1024);
  });

  it("gives every race its own picture (including the two Skyborne factions) and no two files are identical", () => {
    const hashes = Object.values(FILES).map((f) => f.sha256);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(FILES["high-order-skyborne.webp"]!.sha256).not.toBe(FILES["windshaper-skyborne.webp"]!.sha256);
    expect(Object.keys(SOURCE_SHA256)).toHaveLength(10);
    expect(new Set(Object.values(SOURCE_SHA256)).size).toBe(10);
  });

  it("does not commit the source PNGs anywhere under public/", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    expect(walk(join(process.cwd(), "public")).filter((f) => /races?[\\/]/i.test(f) && f.endsWith(".png"))).toEqual([]);
  });
});

describe("race art helpers", () => {
  it("builds same-origin, width-described srcsets from the files that exist", () => {
    for (const slug of SLUGS) {
      const a = raceArt(slug);
      expect(a.src).toBe(`/race-cards/${slug}-540.webp`);
      expect(a.srcSet).toBe(`/race-cards/${slug}-540.webp 540w, /race-cards/${slug}-800.webp 800w, /race-cards/${slug}.webp 1086w`);
      for (const part of a.srcSet.split(", ")) expect(existsSync(join(process.cwd(), "public", part.split(" ")[0]!)), part).toBe(true);
      const t = raceThumbArt(slug);
      expect(t.src).toBe(`/race-cards/${slug}-240.webp`);
      for (const part of t.srcSet.split(", ")) expect(existsSync(join(process.cwd(), "public", part.split(" ")[0]!)), part).toBe(true);
      expect(`${a.src}${a.srcSet}${t.src}`).not.toMatch(/https?:|\/\/[a-z]/i);
    }
  });

  it("has hero art direction for exactly the ten races, as literal Tailwind object-position classes (no inline styles needed)", () => {
    expect(Object.keys(RACE_HERO_POSITION).sort()).toEqual([...SLUGS].sort());
    for (const v of Object.values(RACE_HERO_POSITION)) expect(v).toMatch(/^object-\[\d{1,3}%_\d{1,3}%\]$/);
  });

  it("declares responsive sizes for the card and hero images", () => {
    expect(RACE_CARD_SIZES).toMatch(/min-width/);
    expect(RACE_HERO_SIZES).toMatch(/100vw$/);
  });

  it("covers every race the guides serve", () => {
    expect(RACE_GUIDES.map((g) => g.slug).sort()).toEqual([...SLUGS].sort());
  });
});
