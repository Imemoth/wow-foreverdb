import type { RaceIdentity } from "./build";

/**
 * Race identity: the facts that never change between game versions (name, faction, URL slug) plus a short AzerDex-written
 * summary. Every gameplay fact (classes, abilities) lives in the versioned data under src/data/races/forever and is never
 * stated here. Order is the display order: Alliance first, then Horde, as on Blizzard's overview article.
 */
export const RACE_IDENTITIES: readonly (RaceIdentity & { isNewRace: boolean })[] = [
  { id: "human", name: "Human", faction: "alliance", isNewRace: false,
    summary: "Versatile and ambitious, Humans anchor the Alliance. Hunter is a new class option for them in Forever." },
  { id: "dwarf", name: "Dwarf", faction: "alliance", isNewRace: false,
    summary: "Mountain-dwelling treasure seekers and archaeologists from Khaz Modan. Forever adds the Shaman class to their options." },
  { id: "night-elf", name: "Night Elf", faction: "alliance", isNewRace: false,
    summary: "An ancient people of Kalimdor's forests who returned from seclusion to face the Burning Legion." },
  { id: "gnome", name: "Gnome", faction: "alliance", isNewRace: false,
    summary: "Brilliant tinkerers from the lost city of Gnomeregan. Priest is a new class option for Gnomes in Forever." },
  { id: "high-order-skyborne", name: "High Order Skyborne", faction: "alliance", isNewRace: true,
    summary: "A new Alliance race: Highborne descendants from the elemental plane of Skywall, seeking the arcane knowledge their people lost." },
  { id: "orc", name: "Orc", faction: "horde", isNewRace: false,
    summary: "Proud warriors from Draenor who broke free of demonic corruption. Mage is a new class option for Orcs in Forever." },
  { id: "tauren", name: "Tauren", faction: "horde", isNewRace: false,
    summary: "Nature-revering people devoted to the Earth Mother, bound to the Horde by a blood-debt to the orcs." },
  { id: "troll", name: "Troll", faction: "horde", isNewRace: false,
    summary: "The Darkspear tribe, jungle-born allies of the Horde. Warlock is a new class option for Trolls in Forever." },
  { id: "undead", name: "Undead", faction: "horde", isNewRace: false,
    summary: "The Forsaken, free of the Lich King and hungry for vengeance. Paladin is a new class option for the Undead in Forever." },
  { id: "windshaper-skyborne", name: "Windshaper Skyborne", faction: "horde", isNewRace: true,
    summary: "A new Horde race: shen'dorei who received the wind spirits' gift of elemental skysight and now search for their missing mentors." },
];
