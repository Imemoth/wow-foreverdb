import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CLASSES, classPath } from "@/lib/classes/classes";
import { buildRaceGuides } from "@/lib/races/build";
import { RACE_IDENTITIES } from "@/lib/races/identities";
import { RACE_BASELINE, RACE_CHANGE_FILES, RACE_GUIDES, RACE_SOURCES, RACE_STATE, getRaceGuide, racePath } from "@/lib/races/registry";
import { validateRaceGuides } from "@/lib/races/validate";
import { resolveVersioned } from "@/lib/versioned/resolve";
import { BaselineSchema, ChangeFileSchema, SourceCatalogSchema } from "@/lib/versioned/schema";

const guide = (id: string) => getRaceGuide(id)!;
const ability = (raceId: string, name: string) => [...guide(raceId).active, ...guide(raceId).passive].find((a) => a.name === name)!;
const retired = (raceId: string, name: string) => guide(raceId).retired.find((a) => a.name === name)!;
const records = RACE_CHANGE_FILES.flatMap((f) => f.records);

/** Blizzard's race/class tables, 2026-09-22 (news.blizzard.com article 24304075; Skyborne: article 24302071). */
const OFFICIAL_CLASSES: Record<string, string[]> = {
  human: ["hunter", "mage", "paladin", "priest", "rogue", "warlock", "warrior"],
  dwarf: ["hunter", "paladin", "priest", "rogue", "shaman", "warrior"],
  "night-elf": ["druid", "hunter", "priest", "rogue", "warrior"],
  gnome: ["mage", "priest", "rogue", "warlock", "warrior"],
  "high-order-skyborne": ["druid", "hunter", "mage", "rogue", "warrior"],
  orc: ["hunter", "mage", "rogue", "shaman", "warlock", "warrior"],
  tauren: ["druid", "hunter", "shaman", "warrior"],
  troll: ["hunter", "mage", "priest", "rogue", "shaman", "warlock", "warrior"],
  undead: ["mage", "paladin", "priest", "rogue", "warlock", "warrior"],
  "windshaper-skyborne": ["druid", "hunter", "rogue", "shaman", "warrior"],
};
/** The six new combinations Blizzard names ("Orc Mages, Troll Warlocks, Undead Paladins, Human Hunters, Gnome Priests, Dwarf Shamans"). */
const OFFICIAL_NEW: Record<string, string> = { orc: "mage", troll: "warlock", undead: "paladin", human: "hunter", gnome: "priest", dwarf: "shaman" };

describe("race dataset structure", () => {
  it("has exactly ten race-faction entries, five per faction, Skyborne listed once per faction", () => {
    expect(RACE_GUIDES).toHaveLength(10);
    expect(RACE_GUIDES.filter((g) => g.faction === "alliance").map((g) => g.id)).toEqual(["human", "dwarf", "night-elf", "gnome", "high-order-skyborne"]);
    expect(RACE_GUIDES.filter((g) => g.faction === "horde").map((g) => g.id)).toEqual(["orc", "tauren", "troll", "undead", "windshaper-skyborne"]);
    expect(RACE_IDENTITIES.map((r) => r.id)).toEqual(RACE_GUIDES.map((g) => g.id));
    expect(new Set(RACE_GUIDES.map((g) => g.slug)).size).toBe(10);
  });

  it("gives every race exactly two active and two passive current abilities (40 slots), and passes the structural validator", () => {
    for (const g of RACE_GUIDES) {
      expect(g.active.map((a) => a.type)).toEqual(["active", "active"]);
      expect(g.passive.map((a) => a.type)).toEqual(["passive", "passive"]);
    }
    expect(RACE_GUIDES.reduce((n, g) => n + g.active.length + g.passive.length, 0)).toBe(40);
    expect(validateRaceGuides(RACE_GUIDES)).toEqual([]);
  });

  it("shares Skyborne abilities by id instead of duplicating them", () => {
    for (const id of ["skyborne.walk-on-air", "skyborne.wind-blessed", "skyborne.elemental-insight"]) {
      const e = RACE_STATE.byId.get(id)!;
      expect(e.current.races).toEqual(["high-order-skyborne", "windshaper-skyborne"]);
      expect(ability("high-order-skyborne", e.current.name as string).id).toBe(id);
      expect(ability("windshaper-skyborne", e.current.name as string).id).toBe(id);
    }
    expect(guide("high-order-skyborne").active.map((a) => a.name)).toEqual(["Walk on Air", "Read Leyline"]);
    expect(guide("windshaper-skyborne").active.map((a) => a.name)).toEqual(["Walk on Air", "Skysight"]);
  });

  it("has stable, unique, well-formed ability ids", () => {
    const ids = RACE_STATE.entities.filter((e) => e.kind === "ability").map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z-]+\.[a-z-]+$/);
    // Ids never change when an ability is renamed or tuned: spot-check ids that existed before the October changes.
    expect(ids).toEqual(expect.arrayContaining(["human.the-human-spirit", "orc.blood-fury", "undead.touch-of-the-grave", "high-order-skyborne.read-leyline"]));
  });
});

describe("race/class compatibility (Blizzard official tables)", () => {
  it("matches Blizzard's tables exactly", () => {
    for (const [race, classes] of Object.entries(OFFICIAL_CLASSES)) {
      expect(guide(race).classes.map((c) => c.classId), race).toEqual(classes);
    }
  });
  it("links the official source of every class list", () => {
    for (const g of RACE_GUIDES) {
      const urls = g.classSources.map((x) => x.url);
      expect(urls, g.id).toContain("https://news.blizzard.com/en-us/article/24304075/create-the-hero-you-want-to-be-in-world-of-warcraft-forever");
      if (g.id.endsWith("skyborne")) expect(urls, g.id).toContain("https://news.blizzard.com/en-us/article/24302071/wow-forever-meet-the-new-skyborne");
      expect(g.classSources.every((x) => x.kind === "official-article"), g.id).toBe(true);
    }
  });
  it("flags exactly the six officially named new combinations", () => {
    const flagged = RACE_GUIDES.flatMap((g) => g.classes.filter((c) => c.isNew).map((c) => [g.id, c.classId]));
    expect(Object.fromEntries(flagged)).toEqual(OFFICIAL_NEW);
    expect(flagged).toHaveLength(6);
  });
  it("only references the nine existing Class Guides, which resolve", () => {
    const ids = new Set(CLASSES.map((c) => c.id));
    for (const g of RACE_GUIDES) for (const c of g.classes) { expect(ids.has(c.classId)).toBe(true); expect(classPath(c.classId)).toBe(`/guides/classes/${c.classId}`); }
    expect(racePath("night-elf")).toBe("/guides/races/night-elf");
    expect(getRaceGuide("../etc")).toBeNull();
  });
});

/** Exact hosts Blizzard's articles and forum notes are served from. Compared as parsed hostnames, never with a pattern on the URL string. */
const OFFICIAL_HOSTS = ["news.blizzard.com", "us.forums.blizzard.com"];

describe("sources and provenance", () => {
  it("every source URL is https, has no credentials or port, and community sources never use an official host", () => {
    for (const s of RACE_SOURCES.sources) {
      const u = new URL(s.url);
      expect(u.protocol, s.id).toBe("https:");
      expect(u.username + u.password + u.port, s.id).toBe("");
      if (s.kind === "community") expect(OFFICIAL_HOSTS, s.id).not.toContain(u.hostname);
      else expect(OFFICIAL_HOSTS, s.id).toContain(u.hostname);
    }
  });
  it("every file passes its schema and every reference resolves", () => {
    expect(SourceCatalogSchema.safeParse(RACE_SOURCES).success).toBe(true);
    expect(BaselineSchema.safeParse(RACE_BASELINE).success).toBe(true);
    for (const f of RACE_CHANGE_FILES) expect(ChangeFileSchema.safeParse(f).success).toBe(true);
    const known = new Set(RACE_SOURCES.sources.map((s) => s.id));
    for (const e of RACE_BASELINE.entities) for (const s of e.sources) expect(known.has(s), `${e.id} -> ${s}`).toBe(true);
    for (const r of records) for (const s of r.sources) expect(known.has(s), `${r.id} -> ${s}`).toBe(true);
  });
  it("official records cite Blizzard-hosted sources only; community records cite community sources only", () => {
    const byId = new Map(RACE_SOURCES.sources.map((s) => [s.id, s]));
    for (const r of records) {
      for (const sid of r.sources) {
        const s = byId.get(sid)!;
        if (r.evidence === "official") {
          expect(["official-article", "official-dev-notes"]).toContain(s.kind);
          expect(OFFICIAL_HOSTS).toContain(new URL(s.url).hostname);
        } else {
          expect(s.kind).toBe("community");
        }
      }
    }
  });
  it("never attaches a client build to a racial change without client evidence (the 70634 talent build is not reused)", () => {
    for (const r of records) { expect(r.build).toBeNull(); expect(r.effectiveOn).toBeNull(); }
    expect(JSON.stringify([RACE_BASELINE, RACE_CHANGE_FILES])).not.toContain("70634");
  });
  it("every source date is a plausible publication date not after the retrieval date", () => {
    for (const s of RACE_SOURCES.sources) { expect(s.publishedOn <= s.retrievedOn).toBe(true); expect(s.publishedOn >= "2026-09-01").toBe(true); }
  });
  it("shows an official or community label for every displayed field of every current ability", () => {
    for (const g of RACE_GUIDES) for (const a of [...g.active, ...g.passive]) {
      expect(a.sources.length).toBeGreaterThan(0);
      expect(a.evidence.description, a.id).toBeDefined();
      if (a.cooldown) expect(a.evidence.cooldown, a.id).toBeDefined();
      if (a.duration) expect(a.evidence.duration, a.id).toBeDefined();
    }
  });
});

describe("history ordering and append-only preservation", () => {
  it("change files are chronological, named after their dates, and not older than the baseline", () => {
    const dates = RACE_CHANGE_FILES.flatMap((f) => f.records.map((r) => r.announcedOn));
    expect(dates).toEqual([...dates].sort());
    for (const r of records) expect(r.announcedOn >= RACE_BASELINE.asOf).toBe(true);
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length);
    for (const f of RACE_CHANGE_FILES) expect(f.records.map((r) => r.announcedOn)).toEqual([...f.records.map((r) => r.announcedOn)].sort());
  });

  it("freezes published records: editing an existing record fails this test; corrections must be new records (docs/web/race-guides.md)", () => {
    const fp = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
    const actual: Record<string, string> = { baseline: fp(RACE_BASELINE), ...Object.fromEntries(records.map((r) => [r.id, fp(r)])) };
    // Adding new records is allowed (they are simply not listed here yet); every record listed here must be byte-for-byte unchanged.
    for (const [id, hash] of Object.entries(FROZEN_FINGERPRINTS)) expect(actual[id], id).toBe(hash);
    expect(Object.keys(actual)).toEqual(expect.arrayContaining(Object.keys(FROZEN_FINGERPRINTS)));
  });

  it("keeps every historical definition reachable: nothing in the baseline or in any record is lost from the resolved history", () => {
    for (const b of RACE_BASELINE.entities) {
      const e = RACE_STATE.byId.get(b.id)!;
      expect(e.history[0]!.recordId).toBe("baseline");
      expect(e.history[0]!.snapshot).toEqual(b.props);
    }
    const applied = new Map<string, number>();
    for (const r of records) for (const op of r.ops) applied.set(op.entity, (applied.get(op.entity) ?? 0) + 1);
    for (const [id, n] of applied) {
      const e = RACE_STATE.byId.get(id)!;
      expect(e.history.length + e.pending.length, id).toBeGreaterThanOrEqual(n);
    }
  });

  it("never lists a removed ability as current, and keeps it in the retired list with its last definition", () => {
    for (const g of RACE_GUIDES) {
      for (const a of [...g.active, ...g.passive]) expect(a.active).toBe(true);
      for (const a of g.retired) expect(a.active).toBe(false);
    }
    expect(guide("dwarf").retired.map((a) => a.name).sort()).toEqual(["Earth Fury", "Mace Specialization"]);
    expect(guide("orc").retired.map((a) => a.name).sort()).toEqual(["Axe Specialization", "Savage"]);
    expect(guide("human").retired.map((a) => a.name)).toEqual(["Sword Specialization"]);
  });

  it("resolves deterministically: repeated generation gives identical output and does not mutate the inputs", () => {
    const before = JSON.stringify([RACE_BASELINE, RACE_CHANGE_FILES, RACE_SOURCES]);
    const a = buildRaceGuides(resolveVersioned(RACE_BASELINE, RACE_CHANGE_FILES, RACE_SOURCES), RACE_IDENTITIES);
    const b = buildRaceGuides(resolveVersioned(RACE_BASELINE, [...RACE_CHANGE_FILES].reverse(), RACE_SOURCES), RACE_IDENTITIES);
    expect(JSON.stringify(a)).toBe(JSON.stringify(RACE_GUIDES));
    expect(JSON.stringify(b)).toBe(JSON.stringify(RACE_GUIDES));
    expect(JSON.stringify([RACE_BASELINE, RACE_CHANGE_FILES, RACE_SOURCES])).toBe(before);
  });
});

describe("regression: Blizzard's October 26-27 racial updates", () => {
  it("Human: Ruthless 1% (was 2%), The Human Spirit 10% (was 5%)", () => {
    expect(ability("human", "Ruthless").description).toContain("1%");
    expect(ability("human", "The Human Spirit").description).toContain("10%");
    const h = RACE_STATE.byId.get("human.ruthless")!.history;
    expect(h.map((x) => x.recordId)).toEqual(["2026-10-15-racial-update", "2026-10-26-final-racial-pass"]);
    expect(h[0]!.snapshot!.description).toContain("2%");
    expect(RACE_STATE.byId.get("human.the-human-spirit")!.history[0]!.snapshot!.description).toContain("5%");
  });
  it("Dwarf: Earth Fury removed, Artisan's Precision introduced (1% hit)", () => {
    expect(guide("dwarf").passive.map((a) => a.name)).toEqual(["Big Game Hunter", "Artisan's Precision"]);
    expect(ability("dwarf", "Artisan's Precision").description).toContain("hit chance");
    expect(ability("dwarf", "Artisan's Precision").description).toContain("1%");
    expect(retired("dwarf", "Earth Fury").description).toContain("2%");
  });
  it("Orc: Savage removed, Command back (5% pet damage), Blood Fury cooldown 2 min (was 3)", () => {
    expect(guide("orc").passive.map((a) => a.name)).toEqual(["Hardiness", "Command"]);
    expect(ability("orc", "Command").description).toContain("5%");
    expect(ability("orc", "Blood Fury").cooldown).toBe("2 min");
    expect(RACE_STATE.byId.get("orc.blood-fury")!.history.map((h) => h.snapshot!.cooldown)).toEqual(["2 min", "3 min", "2 min"]);
  });
  it("Tauren: Plainsrunning 2% per stack up to 60% and not mounted; Endurance only 5% Health", () => {
    const p = ability("tauren", "Plainsrunning").description;
    expect(p).toContain("2% movement speed per stack");
    expect(p).toContain("60%");
    expect(p).toContain("does not increase mounted");
    expect(ability("tauren", "Endurance").description).toBe("Increases total Health by 5%.");
  });
  it("Troll: Berserking 15 seconds (was 10)", () => {
    expect(ability("troll", "Berserking").duration).toBe("15 sec");
    expect(ability("troll", "Berserking").description).toContain("15 seconds");
    expect(RACE_STATE.byId.get("troll.berserking")!.history[0]!.snapshot!.duration).toBe("10 sec");
  });
  it("Undead: Touch of the Grave internal cooldown 15 seconds (was 25)", () => {
    expect(ability("undead", "Touch of the Grave").cooldown).toBe("15 sec (internal)");
    expect(RACE_STATE.byId.get("undead.touch-of-the-grave")!.history.map((h) => h.snapshot!.cooldown)).toEqual([null, null, "25 sec (internal)", "15 sec (internal)"]);
  });
  it("Skyborne: Wind Blessed 2%, Read Leyline 50%/15 s with Attuned 100%, Skysight 15%/15 s with Charged 30%", () => {
    for (const r of ["high-order-skyborne", "windshaper-skyborne"]) expect(ability(r, "Wind Blessed").description).toContain("2%");
    const rl = ability("high-order-skyborne", "Read Leyline");
    expect(rl.description).toContain("by 50%");
    expect(rl.description).toContain("Attuned for 1 hour");
    expect(rl.description).toContain("to 100%");
    expect(rl.description).toContain("removed when you enter a raid");
    expect(rl.duration).toBe("15 sec");
    const ss = ability("windshaper-skyborne", "Skysight");
    expect(ss.description).toContain("by 15%");
    expect(ss.description).toContain("Charged for 1 hour");
    expect(ss.description).toContain("to 30%");
    expect(ss.duration).toBe("15 sec");
  });
});

describe("intermediate October updates are preserved, not collapsed into baseline -> Oct 26", () => {
  const asOf = (date: string) => {
    const files = RACE_CHANGE_FILES.map((f) => ({ ...f, records: f.records.filter((r) => r.announcedOn <= date) })).filter((f) => f.records.length);
    return buildRaceGuides(resolveVersioned(RACE_BASELINE, files, RACE_SOURCES), RACE_IDENTITIES);
  };
  const find = (gs: typeof RACE_GUIDES, race: string, name: string) => [...gs.find((g) => g.id === race)!.active, ...gs.find((g) => g.id === race)!.passive].find((a) => a.name === name);

  it("the baseline alone still has the weapon specializations and no October abilities", () => {
    const g = asOf("2026-09-22");
    expect(find(g, "human", "Sword Specialization")).toBeTruthy();
    expect(find(g, "human", "Ruthless")).toBeUndefined();
    expect(find(g, "dwarf", "Mace Specialization")).toBeTruthy();
    expect(find(g, "orc", "Axe Specialization")).toBeTruthy();
    expect(find(g, "high-order-skyborne", "Wind Blessed")!.description).toContain("1%");
    expect(find(g, "orc", "Blood Fury")!.cooldown).toBe("2 min");
    expect(g.every((x) => x.active.length === 2 && x.passive.length === 2)).toBe(true);
  });
  it("as of 15 Oct: Ruthless 2%, Earth Fury, Savage, 3-minute Blood Fury, Wind Blessed 3%", () => {
    const g = asOf("2026-10-15");
    expect(find(g, "human", "Ruthless")!.description).toContain("2%");
    expect(find(g, "dwarf", "Earth Fury")).toBeTruthy();
    expect(find(g, "orc", "Savage")).toBeTruthy();
    expect(find(g, "orc", "Command")).toBeUndefined();
    expect(find(g, "orc", "Blood Fury")!.cooldown).toBe("3 min");
    expect(find(g, "windshaper-skyborne", "Wind Blessed")!.description).toContain("3%");
    expect(find(g, "tauren", "War Stomp")!.cooldown).toBe("90 sec");
    expect(g.every((x) => x.active.length === 2 && x.passive.length === 2)).toBe(true);
  });
  it("as of 26 Oct (before the 27 Oct additions): Blood Fury still 3 minutes, Berserking still 10 seconds", () => {
    const g = asOf("2026-10-26");
    expect(find(g, "orc", "Command")).toBeTruthy();
    expect(find(g, "orc", "Blood Fury")!.cooldown).toBe("3 min");
    expect(find(g, "troll", "Berserking")!.duration).toBe("10 sec");
  });
  it("early September/October notes are recorded (Eureka!, Cultivation, Cannibalize, Touch of the Grave)", () => {
    expect(RACE_STATE.byId.get("gnome.eureka")!.history.map((h) => h.recordId)).toEqual(["baseline", "2026-09-24-build-notes", "2026-10-01-build-notes", "2026-10-15-racial-update"]);
    expect(ability("undead", "Cannibalize").details.join(" ")).toContain("immune to Physical damage");
    expect(ability("tauren", "Cultivation").details.join(" ")).toContain("divided by 5");
  });
});

describe("evidence discipline", () => {
  it("community-only details never override Blizzard's statements and are labelled", () => {
    const stoneform = ability("dwarf", "Stoneform");
    expect(stoneform.evidence.description).toBe("official");
    expect(stoneform.evidence.cooldown).toBe("corroborated");
    expect(stoneform.communityNotes).toEqual(["Physical damage taken is reduced by 10%."]);
    expect(RACE_STATE.byId.get("dwarf.stoneform")!.pending).toHaveLength(0);
    expect(ability("orc", "Blood Fury").evidence.cooldown).toBe("official");
  });
  it("leaves unpublished cooldowns explicitly unknown instead of guessing", () => {
    for (const [race, name] of [["human", "Will to Survive"], ["human", "Perception"], ["orc", "Shatter Curse"], ["troll", "Berserking"], ["gnome", "Eureka!"], ["undead", "Cannibalize"]] as const) {
      expect(ability(race, name).cooldown, `${race} ${name}`).toBeNull();
    }
  });
  it("the latest update date ignores community-only detail records", () => {
    expect(guide("dwarf").latestUpdate).toBe("2026-10-26");
    expect(guide("troll").latestUpdate).toBe("2026-10-27");
    expect(guide("night-elf").latestUpdate).toBe("2026-10-15");
    expect(guide("gnome").latestUpdate).toBe("2026-10-15");
  });
});

// Fingerprints of the published records (first 16 hex of sha256 over the JSON). Append a line when you ADD a record; a changed
// fingerprint of an existing record means published history was edited.
const FROZEN_FINGERPRINTS: Record<string, string> = {
  baseline: "82af2266be5a6ccb",
  "2026-09-24-build-notes": "1a28a7ee29890840",
  "2026-10-01-build-notes": "645d953e92f1cec4",
  "2026-10-15-racial-update": "7d1a62bc7f8bb82f",
  "2026-10-26-final-racial-pass": "641b0c0088767d50",
  "2026-10-27-racial-additions": "988e6d3d02ea109e",
  "2026-10-28-community-details": "1fed036b4097d206",
};
