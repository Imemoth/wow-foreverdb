# ForeverDB Guildbook API research

Status: research / design input, 2026-09-25.

A future Guildbook can draw from two distinct sources:

1. the **in-game WoW Lua API** exposed by the actual Forever client;
2. Blizzard's external **Battle.net Web APIs**.

For WoW: Forever, the in-game route should be treated as the primary design until
Forever beta/realm exposure through Blizzard's public profile APIs is verified.

## Implemented capability probe

Addon **0.4.0-alpha** includes diagnostic-only Guildbook probes:

`/fdb guild`

with the legacy alias:

`/fdb guildapi`

Targeted recipe/crafter probes use the simpler forms:

`/fdb recipe <profession>`

or:

`/fdb recipe <member> <profession>`

The short alias `/fdb gr ...` is equivalent. Legacy `/fdb guildrecipe <member> <skillLineID>` remains supported.

The probe:

- does **not** write Guildbook data to SavedVariables;
- does **not** upload guild data to Supabase;
- reports whether the relevant guild/profession/recipe functions exist;
- prints the logged-in character's professions when available;
- prints a small cached guild-roster sample;
- requests a roster refresh through `C_GuildInfo.GuildRoster()` or legacy `GuildRoster()`;
- listens for `GUILD_ROSTER_UPDATE` and prints a refreshed sample;
- times out after 12 seconds and falls back to the current roster cache.

The base `/fdb guildapi` probe validates roster/profession capability and expanded guild-member profession rows. The separate `/fdb guildrecipe` command performs recipe queries only on explicit request and follows the required event sequence before reading recipe-crafter results.

### Test procedure

1. Log in on a character that belongs to a guild.
2. Run `/fdb guildapi`.
3. Wait up to 12 seconds for the refreshed section.
4. Capture the full chat output.
5. Repeat on a character with professions if the first character has none.

The output is the compatibility gate for the Guildbook SavedVariables schema.

## Runtime probe result — 2026-09-25

Tested on Forever addon **0.3.2-alpha**, schema **8**.

### Confirmed present in the Forever client

Guild roster:
- `IsInGuild`
- `GetGuildInfo`
- `GetNumGuildMembers`
- `GetGuildRosterInfo`
- `GetGuildRosterLastOnline`
- `C_GuildInfo.GuildRoster`

The legacy global `GuildRoster` function is **not** present, so current code should
prefer `C_GuildInfo.GuildRoster()`.

Professions / guild profession APIs:
- `GetProfessions`
- `GetProfessionInfo`
- `GetNumGuildTradeSkill`
- `GetGuildTradeSkillInfo`
- `GetGuildMemberRecipes`
- `GetGuildRecipeMember`
- `CanViewGuildRecipes`
- `C_GuildInfo.QueryGuildMemberRecipes`
- `C_GuildInfo.QueryGuildMembersForRecipe`

### Own-character profession read: PASS

The probe successfully returned live profession values, including:

- Mining — 14/75, skillLine 186
- Skinning — 64/75, skillLine 393
- First Aid — 41/75, skillLine 129
- Fishing — 43/75, skillLine 356
- Cooking — 12/75, skillLine 185

This proves the Forever client exposes usable own-character profession skill data.

### Guild roster data: pending guilded-character test

The tested character was **not in a guild**:

- `player in guild=false`
- cached guild members: 0
- guild name/rank: unavailable
- roster refresh was correctly skipped

Therefore function availability is proven, but actual populated
`GetGuildRosterInfo()` records still require one test on a guilded character.

### Guild trade-skill cache: partial evidence

`GetNumGuildTradeSkill()` returned 10 and `GetGuildTradeSkillInfo()` returned
profession headers such as Alchemy, Blacksmithing, Enchanting, Engineering and
Herbalism even while the player was not guilded.

Treat those header rows as evidence that the API is functional, **not** yet as
evidence that guild-member profession rows are populated. That must be verified on
a guilded character.

### Guilded-character roster acceptance — PASS

A guilded character test returned:

- guild name: `gulp`
- rank: `Initiate`, rank index 4
- cached roster: 95 members, 85 online
- refreshed roster: 95 members, 84 online
- `GUILD_ROSTER_UPDATE`: received successfully
- sampled members included readable name, level, class, rank, online state, zone and GUID

Examples observed:
- Bald Greenskin — level 8 Warrior — Durotar
- Bhekron Skyward — level 8 Shaman — Orgrimmar
- Big Hoon — level 8 Rogue — Tirisfal Glades

This closes the base Guildbook roster compatibility gate.

### Guild profession table — member rows PASS

The guilded-character test showed 10 collapsed profession headers with live
per-profession population counts. Examples included:

- Alchemy: 9 players
- Blacksmithing: 9
- Enchanting: 15
- Engineering: 8
- Herbalism: 29
- Leatherworking: 27
- Mining: 36
- Skinning: 59
- Tailoring: 15

After expansion, the client returned real member rows with player name, profession,
skillLineID, skill, online state and zone. The captured sample contained 13 member
rows across the two headers that the 0.3.5 probe managed to expand, including
Alchemy and Blacksmithing members.

That result is sufficient to mark guild-member profession discovery **PASS**.

The 0.3.5 implementation expanded headers while iterating the same mutable list,
which caused only two headers to expand. Addon 0.3.15-alpha fixes this by snapshotting
all collapsed skillLineIDs first, then expanding them in a second pass.

### Secondary professions

Forever's guild tradeskill header list does not include Cooking, Fishing or First Aid,
even though the logged-in character exposes them through `GetProfessions()` /
`GetProfessionInfo()`.

Observed Forever runtime skillLineIDs:

- Cooking: 185
- Fishing: 356
- First Aid: 129

Addon 0.3.15-alpha therefore resolves those secondary professions separately. This
allows targeted recipe probes such as `/fdb recipe cooking`, even though Cooking
does not appear in `GetNumGuildTradeSkill()` / `GetGuildTradeSkillInfo()`.

Guild-wide discovery of *which members* have a secondary profession remains a
separate capability question because the guild tradeskill roster omits those headers.

### Forever member-recipe event compatibility

Runtime tests with both Cooking (185) and Fishing (356) showed the same behavior:

- `C_GuildInfo.QueryGuildMemberRecipes(guid, skillLineID)` returns without error;
- the documented `TRADE_SKILL_SHOW` event does **not** arrive;
- the probe reaches its timeout.

Addon 0.3.15-alpha therefore treats the modern member-query path as present-but-not-yet
runtime-compatible and automatically tries the legacy guild recipe path:

1. `GetGuildMemberRecipes(name, skillLineID)`;
2. `QueryGuildRecipes()`;
3. `CanViewGuildRecipes(skillLineID)`;
4. `ViewGuildRecipes(skillLineID)` when the guild recipe cache reports the profession as viewable.

This fallback is diagnostic-only and is intended to identify which older guild-recipe
surface Forever actually wires up.

### Secondary profession guild-cache result — Cooking

A 0.3.10-alpha runtime test for the logged-in character's Cooking (skillLine 185)
produced:

- modern `QueryGuildMemberRecipes`: call accepted;
- `TRADE_SKILL_SHOW`: not fired;
- legacy `GetGuildMemberRecipes(name, 185)`: callable, no direct return values;
- `QueryGuildRecipes()`: callable;
- `CanViewGuildRecipes(185)`: false;
- `ViewGuildRecipes(185)`: therefore skipped.

This is strong evidence that Forever does not expose Cooking through the same
guild-wide recipe cache used by the primary guild tradeskill headers. It does **not**
affect character-local Cooking data, which is already confirmed through
`GetProfessions` / `GetProfessionInfo`.

Fishing (356) and First Aid (129) are treated as the same secondary-profession class
until separately disproven.

### Primary crafting control — self Tailoring

A self-targeted Tailoring test (skillLine 197) produced the same high-level recipe
behavior as secondary/gathering professions:

- member recipe query accepted;
- no `TRADE_SKILL_SHOW`;
- legacy member recipe call accepted;
- guild recipe cache refresh accepted;
- `CanViewGuildRecipes(197)` returned false.

However, this character had not been observed as a Tailoring member row in the
expanded guild tradeskill cache at the time of the earlier probe. Therefore this
result alone does **not** prove the recipe API is globally incompatible; the guild may
simply not be publishing that character/profession into the recipe cache.

Addon 0.3.15-alpha now prints whether the target member/profession is present in the
current guild tradeskill member cache before the recipe query. The decisive control
remains a known published crafting member such as an Alchemy member returned by the
expanded guild tradeskill probe.

### Recipe probe preflight — 0.3.15-alpha

The recipe probe now performs its own publication preflight before calling the
member-recipe API:

1. refresh the guild recipe/tradeskill cache;
2. locate the requested profession header;
3. expand that header when collapsed;
4. wait one second for the member rows to populate;
5. verify whether the requested character/profession pair is present;
6. restore the header state;
7. only then run the member-recipe query and fallback chain.

This makes a negative result distinguishable:

- target member present + recipe cache still unavailable -> strong API/cache limitation;
- target member absent -> guild publication/state issue, not a decisive recipe API failure.

### Primary crafting recipe gate — RUNTIME LIMITED

The 0.3.14-alpha Tailoring control is decisive for the current Forever build.

Observed sequence for a known published Tailoring member:

- target profession header: Tailoring / skillLine 197;
- preflight expansion: PASS;
- target member present in expanded guild tradeskill cache: PASS;
- member skill value readable;
- `C_GuildInfo.QueryGuildMemberRecipes(guid, 197)`: call accepted;
- `TRADE_SKILL_SHOW`: not fired;
- `GetGuildMemberRecipes(member, 197)`: callable, no direct return values;
- `QueryGuildRecipes()`: callable;
- `CanViewGuildRecipes(197)`: false;
- `ViewGuildRecipes(197)`: unavailable as a consequence.

Because the member/profession pair is demonstrably published in the guild tradeskill
cache, this is no longer explainable as a stale/unpublished member row.

**Conclusion for the current Forever build:** guild roster and guild profession
discovery are supported, but guild member recipe discovery / recipe-to-crafter
resolution is runtime-limited through the tested API surfaces.

Recommended Guildbook scope for now:

- roster: PASS;
- class/level/rank/online/zone/GUID: PASS;
- guild-visible primary professions and skill values: PASS;
- current-character secondary professions: PASS;
- guild-wide recipe lists / recipe-to-crafter lookup: DEFER until the Forever client
  exposes a working recipe cache/event path.

### Next implementation gate

Do not spend more runtime-probe cycles on guild recipe lookup for this Forever build.

Proceed with Guildbook V1 around the verified data surface:

1. guild roster snapshot;
2. character identity/class/level/rank/online/zone;
3. guild-visible primary profession + skill;
4. current-character secondary professions;
5. SavedVariables contract;
6. Companion/Supabase sync and Guildbook UI.

Keep recipe/crafter lookup behind a feature flag / future compatibility gate.


## Guildbook V1 implementation

Implemented in addon **0.4.0-alpha**, export schema **9**, Companion **0.8.0-alpha**.

The V1 persisted contract includes:

- guild key, name, realm and capture timestamp;
- member GUID, name, class, level, rank, online state, zone and last-online age;
- guild-visible primary profession + skill;
- logged-in character secondary professions;
- no officer notes;
- no recipe/crafter data.

Export record types:

- `G` — guild
- `C` — character/member
- `P` — profession

Supabase stores these in private per-installation tables. Direct anon/authenticated
table reads are revoked; ingestion is only through the authenticated
`ingest_foreverdb_snapshot_auth` security-definer RPC.

The Companion exposes a Guildbook tab with guild selection and filtering by character,
class, rank, zone or profession.

## Candidate Guildbook data

A useful first version could store:

- character name
- character GUID when exposed
- class
- level
- guild rank
- online/offline state
- last-online information
- zone when available
- public note
- primary professions
- profession skill level
- optionally known recipes/crafts

Officer notes should not be uploaded by default.

## In-game guild roster API

Relevant guild roster calls include:

- `C_GuildInfo.GuildRoster()`
- `GetNumGuildMembers()`
- `GetGuildRosterInfo(index)`
- `GetGuildRosterLastOnline(index)`

These are suitable for the core character roster and can be sampled after
`GUILD_ROSTER_UPDATE`.

References:

- https://warcraft.wiki.gg/wiki/API:C_GuildInfo.GuildRoster
- https://warcraft.wiki.gg/wiki/API:GetGuildRosterInfo
- https://warcraft.wiki.gg/wiki/World_of_Warcraft_API/Classic

## In-game professions and recipes

Potential guild profession/recipe calls include:

- `GetNumGuildTradeSkill()`
- `GetGuildTradeSkillInfo(index)`
- `C_GuildInfo.QueryGuildMemberRecipes(guildMemberGUID, skillLineID)`
- `GetGuildMemberRecipes(name, skillLineID)`
- `C_GuildInfo.QueryGuildMembersForRecipe(skillLineID, recipeSpellID, recipeLevel)`
- `GetGuildRecipeMember(index)`

For the currently logged-in character, relevant calls include:

- `GetProfessions()`
- `GetProfessionInfo(index)`
- Classic trade-skill / skill APIs for additional own-character data.

### Compatibility gate

Do not assume every Classic Era guild-tradeskill function is available in Forever
just because the surrounding API family exists.

Before defining the SavedVariables schema around profession data, add a small
runtime capability probe in the Forever beta that records:

- whether each function exists;
- whether it can be called without error;
- whether it returns useful guild-member data.

This is the fastest way to establish the real Forever API surface.

## Battle.net Web API

Relevant Blizzard profile/data endpoints include guild and character resources such as:

Guild:
- `GET /data/wow/guild/{realmSlug}/{guildNameSlug}`
- `GET /data/wow/guild/{realmSlug}/{guildNameSlug}/roster`

Character:
- `GET /profile/wow/character/{realmSlug}/{characterName}`
- `GET /profile/wow/character/{realmSlug}/{characterName}/professions`

Classic Era API namespaces commonly use families such as:

- `static-classic1x-{region}`
- `dynamic-classic1x-{region}`
- `profile-classic1x-{region}`

Official documentation:

- https://community.developer.battle.net/documentation/world-of-warcraft/profile-apis
- https://community.developer.battle.net/documentation/world-of-warcraft-classic/game-data-apis

### Forever-specific limitation

The existence of Retail or Classic Era endpoints does **not** prove that current
WoW: Forever beta characters or realms are exposed through Battle.net Profile APIs.

That must be tested with a Blizzard developer client/token against the actual Forever
realm/character identifiers. Until such a probe succeeds, the Guildbook should not
depend on the web API for its core roster.

## Recommended architecture

### Phase 1 — addon-first Guildbook

1. Add a guild roster collector to the addon.
2. Refresh it from `GUILD_ROSTER_UPDATE` with throttling/debouncing.
3. Export roster identity/rank/level/class/online metadata through SavedVariables.
4. Runtime-probe guild profession/recipe APIs.
5. Export profession data only when the client proves it is available.
6. Sync the Guildbook snapshot through the Companion to Supabase.
7. Add a dedicated Guildbook tab to the Companion.

This matches the existing ForeverDB architecture:

`WoW addon -> SavedVariables -> Companion -> authenticated Supabase`

and does not require every user to configure Blizzard developer credentials.

### Phase 2 — optional Battle.net enrichment

If Blizzard exposes Forever realms through Profile APIs, use the web API as an
enrichment layer for data that the client does not expose conveniently. It should
not be the sole Guildbook source until that support is demonstrated.

## Privacy / authorization

Guildbook data is player/community data rather than anonymous loot telemetry.
Before a public rollout define:

- which guild fields are uploaded;
- who can read a guild's data;
- whether public notes are stored;
- retention when a character leaves the guild;
- guild-level visibility/opt-in rules;
- how ownership/administration of a guild dataset is established.

Officer notes and other privileged guild information should be excluded by default.
