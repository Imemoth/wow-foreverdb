#!/usr/bin/env python3
"""Generate a SYNTHETIC private-database seed for ephemeral test databases.

Everything produced here is invented test data (deterministic, seed=20261009).
It is NOT real ForeverDB observation data and must never be loaded into, or
compared against, the production database. Entity names/IDs resemble classic
WoW content only so the website can be exercised realistically.

Output: database/tests/fixtures/synthetic_private_seed.sql
"""
import random
from pathlib import Path

random.seed(20261009)
OUT = Path(__file__).with_name("synthetic_private_seed.sql")

ZONES = {
    1420: ("Tirisfal Glades", ["Brill", "Deathknell", "Agamand Mills", "Garren's Haunt", "Cold Hearth Manor"]),
    1421: ("Silverpine Forest", ["The Sepulcher", "Pyrewood Village", "Fenris Isle", "Ambermill"]),
    1412: ("Mulgore", ["Bloodhoof Village", "Red Cloud Mesa", "The Golden Plains", "Winterhoof Water Well"]),
    1411: ("Durotar", ["Razor Hill", "Valley of Trials", "Sen'jin Village", "Drygulch Ravine"]),
}

ITEMS = {
    2589: "Linen Cloth", 2318: "Light Leather", 2934: "Ruined Leather Scraps", 783: "Light Hide",
    2672: "Stringy Wolf Meat", 769: "Chunk of Boar Meat", 118: "Minor Healing Potion",
    2770: "Copper Ore", 2771: "Tin Ore", 2835: "Rough Stone", 774: "Malachite", 818: "Tigerseye",
    1210: "Shadowgem", 1206: "Moss Agate", 2447: "Peacebloom", 765: "Silverleaf", 2449: "Earthroot",
    785: "Mageroyal", 2450: "Briarthorn", 6291: "Raw Brilliant Smallfish",
    6289: "Raw Longjaw Mud Snapper", 6358: "Oily Blackmouth", 6361: "Raw Rainbow Fin Albacore",
    10940: "Strange Dust", 10938: "Lesser Magic Essence", 10978: "Small Glimmering Shard",
    4865: "Ruined Pelt", 5465: "Small Spider Leg", 2886: "Crag Boar Rib", 4775: "Cracked Bill",
    # Deliberately hostile/invalid names: the publisher MUST reject these rows.
    999001: "<img src=x onerror=alert(1)>",
    999003: "Totally\u0007Normal Item",
}

# (type, id, name, levels, zone, [(loot_kind, [(item, rate, qty_min, qty_max)])])
SOURCES = [
    ("creature", 1554, "Greater Duskbat", [6, 7], 1420, [("mob", [(2589, .32, 1, 2), (118, .04, 1, 1), (2934, .12, 1, 1)])]),
    ("creature", 1547, "Decrepit Darkhound", [5, 6], 1420, [("mob", [(2672, .41, 1, 1), (2934, .18, 1, 1)]),
                                                           ("skinning", [(2934, .62, 1, 2), (2318, .38, 1, 1), (783, .05, 1, 1)])]),
    ("creature", 1548, "Cursed Darkhound", [7, 8], 1420, [("mob", [(2672, .44, 1, 1), (4865, .21, 1, 1)]),
                                                         ("skinning", [(2934, .48, 1, 2), (2318, .5, 1, 2), (783, .07, 1, 1)])]),
    ("creature", 1549, "Ravenous Darkhound", [9, 10], 1420, [("mob", [(2672, .39, 1, 1)]),
                                                            ("skinning", [(2318, .71, 1, 2), (783, .09, 1, 1)])]),
    ("creature", 1508, "Young Scavenger", [1, 2], 1420, [("mob", [(2672, .25, 1, 1), (4865, .3, 1, 1)])]),
    ("creature", 1766, "Mottled Worg", [14, 15], 1421, [("mob", [(2672, .37, 1, 1), (118, .05, 1, 1)]),
                                                       ("skinning", [(2318, .81, 1, 3), (783, .12, 1, 1)])]),
    ("creature", 1778, "Ferocious Grizzled Bear", [13, 14], 1421, [("mob", [(2589, .06, 1, 1)]),
                                                                  ("skinning", [(2318, .77, 1, 2), (783, .15, 1, 1)])]),
    ("creature", 2959, "Prairie Stalker", [7, 8], 1412, [("mob", [(2672, .4, 1, 1)]),
                                                        ("skinning", [(2318, .66, 1, 2), (2934, .3, 1, 1)])]),
    ("creature", 2956, "Adult Plainstrider", [6, 7], 1412, [("mob", [(4775, .52, 1, 1), (2589, .03, 1, 1)])]),
    ("creature", 3098, "Mottled Boar", [1, 2], 1411, [("mob", [(769, .6, 1, 1), (2886, .1, 1, 1)]),
                                                     ("skinning", [(2934, .88, 1, 1), (2318, .12, 1, 1)])]),
    ("creature", 3127, "Venomtail Scorpid", [9, 10], 1411, [("mob", [(5465, .35, 1, 1), (2589, .08, 1, 1)])]),
    ("gameobject", 1731, "Copper Vein", [0], 1420, [("mining", [(2770, 1.0, 2, 4), (2835, .45, 1, 2), (774, .03, 1, 1),
                                                                (818, .02, 1, 1), (1210, .04, 1, 1)])]),
    ("gameobject", 1732, "Tin Vein", [0], 1421, [("mining", [(2771, 1.0, 1, 3), (2835, .4, 1, 2), (1206, .04, 1, 1),
                                                             (1210, .03, 1, 1)])]),
    ("gameobject", 1618, "Peacebloom", [0], 1412, [("herbalism", [(2447, 1.0, 1, 3)])]),
    ("gameobject", 1617, "Silverleaf", [0], 1420, [("herbalism", [(765, 1.0, 1, 3)])]),
    ("gameobject", 1619, "Earthroot", [0], 1411, [("herbalism", [(2449, 1.0, 1, 3)])]),
    ("gameobject", 1620, "Mageroyal", [0], 1421, [("herbalism", [(785, 1.0, 1, 2), (2450, .2, 1, 1)])]),
    ("gameobject", 2843, "Battered Chest", [0], 1421, [("chest", [(118, .35, 1, 2), (2589, .5, 1, 3), (774, .05, 1, 1)])]),
    ("gameobject", -184513, "Floating Wreckage", [0], 1420, [("fishing_pool", [(6358, .3, 1, 1), (6289, .55, 1, 1)])]),
    ("fishing", 1420, "Fishing - Tirisfal Glades", [0], 1420, [("fishing", [(6291, .55, 1, 1), (6289, .35, 1, 1)])]),
    ("fishing", 1421, "Fishing - Silverpine Forest", [0], 1421, [("fishing", [(6289, .5, 1, 1), (6358, .25, 1, 1)])]),
    ("fishing", 1411, "Fishing - Durotar", [0], 1411, [("fishing", [(6291, .6, 1, 1), (6361, .05, 1, 1)])]),
    ("item", 6585, "Tribal Belt", [0], None, [("disenchant", [(10940, .8, 1, 2), (10938, .2, 1, 1)])]),
    # Hostile/invalid rows the publisher must reject.
    ("creature", 999002, "Evil\u0007Bell", [3], 1411, [("mob", [(2589, .3, 1, 1)])]),
    ("creature", 999004, "Scraps Collector", [4], 1411, [("mob", [(999001, .5, 1, 1), (999003, .5, 1, 1)])]),
]

INSTALLATIONS = ["synthetic-installation-a", "synthetic-installation-b", "synthetic-installation-c"]


def q(s):
    return "'" + s.replace("'", "''") + "'" if s is not None else "null"


def esc(s):
    # Postgres E'' literal so the control characters survive into the test DB.
    out = []
    for ch in s:
        if ch == "'":
            out.append("''")
        elif ch == "\\":
            out.append("\\\\")
        elif ord(ch) < 32:
            out.append("\\x%02x" % ord(ch))
        else:
            out.append(ch)
    return "E'" + "".join(out) + "'"


lines = [
    "-- SYNTHETIC TEST DATA ONLY. Generated by generate_synthetic_private_seed.py.",
    "-- Never load into production. Contains deliberately hostile names.",
    "begin;",
]
for i, inst in enumerate(INSTALLATIONS):
    lines.append(
        f"insert into public.installations (id, schema_version, addon_version, owner_user_id) values "
        f"({q(inst)}, 9, '0.5.0-alpha', '00000000-0000-4000-8000-00000000000{i+1}');")
for item_id, name in ITEMS.items():
    lines.append(f"insert into public.items (item_id, name) values ({item_id}, {esc(name)});")

ss_rows, ii_rows, loc_rows = [], [], []
for stype, sid, sname, levels, zone, buckets in SOURCES:
    for level in levels:
        lines.append(
            f"insert into public.sources (source_type, source_id, source_level, name) values "
            f"({q(stype)}, {sid}, {level}, {esc(sname)});")
        # Vary contributor count: some buckets single-installation, some low-sample.
        n_inst = random.choice([1, 1, 2, 3])
        insts = random.sample(INSTALLATIONS, n_inst)
        for kind, loot in buckets:
            for inst in insts:
                obs = random.choice([2, 3, 6, 12, 25, 40, 75, 140])
                ss_rows.append((inst, stype, sid, level, kind, obs))
                for item_id, rate, qmin, qmax in loot:
                    drops = sum(1 for _ in range(obs) if random.random() < rate)
                    if drops == 0:
                        continue
                    qty = sum(random.randint(qmin, qmax) for _ in range(drops))
                    quest = 0
                    ii_rows.append((inst, stype, sid, level, kind, item_id, drops, qty, quest))
                if zone is None:
                    continue
                zname, subs = ZONES[zone]
                cx, cy = random.uniform(25, 75), random.uniform(25, 75)
                remaining = obs
                cells = {}
                while remaining > 0:
                    take = min(remaining, random.randint(1, 4))
                    remaining -= take
                    x = round(max(0, min(100, cx + random.gauss(0, 5))) * 2) / 2
                    y = round(max(0, min(100, cy + random.gauss(0, 5))) * 2) / 2
                    sub = subs[int((x + y)) % len(subs)]
                    key = (sub, x, y)
                    cells[key] = cells.get(key, 0) + take
                for (sub, x, y), n in cells.items():
                    loc_rows.append((inst, stype, sid, level, kind, zone, zname, sub, x, y, n))

for r in ss_rows:
    lines.append("insert into public.installation_source_stats (installation_id, source_type, source_id, "
                 "source_level, loot_kind, observations) values (%s, %s, %d, %d, %s, %d);"
                 % (q(r[0]), q(r[1]), r[2], r[3], q(r[4]), r[5]))
for r in ii_rows:
    lines.append("insert into public.installation_item_stats (installation_id, source_type, source_id, "
                 "source_level, loot_kind, item_id, drop_count, quantity, quest_drop_count) values "
                 "(%s, %s, %d, %d, %s, %d, %d, %d, %d);"
                 % (q(r[0]), q(r[1]), r[2], r[3], q(r[4]), r[5], r[6], r[7], r[8]))
for r in loc_rows:
    lines.append("insert into public.installation_location_stats (installation_id, source_type, source_id, "
                 "source_level, loot_kind, map_id, zone_name, subzone_name, x, y, observations) values "
                 "(%s, %s, %d, %d, %s, %d, %s, %s, %.1f, %.1f, %d);"
                 % (q(r[0]), q(r[1]), r[2], r[3], q(r[4]), r[5], q(r[6]), q(r[7]), r[8], r[9], r[10]))

# Private Guildbook rows that must NEVER appear in any export or public table.
lines += [
    "insert into public.installation_guilds (installation_id, guild_key, guild_name, realm_name) values "
    "('synthetic-installation-a', 'synthetic-guild-key', 'PRIVATE_GUILD_CANARY', 'PRIVATE_REALM_CANARY');",
    "insert into public.installation_guild_members (installation_id, guild_key, member_guid, member_name, "
    "class_name, level, online, zone_name) values ('synthetic-installation-a', 'synthetic-guild-key', "
    "'Player-0000-CANARY', 'PRIVATE_MEMBER_CANARY', 'Mage', 12, true, 'Tirisfal Glades');",
    "commit;",
]
OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"wrote {OUT} ({len(ss_rows)} buckets, {len(ii_rows)} item rows, {len(loc_rows)} location rows)")
