# ForeverDB Guildbook API research

Status: research / design input, 2026-09-25.

A future Guildbook can draw from two distinct sources:

1. the **in-game WoW Lua API** exposed by the actual Forever client;
2. Blizzard's external **Battle.net Web APIs**.

For WoW: Forever, the in-game route should be treated as the primary design until
Forever beta/realm exposure through Blizzard's public profile APIs is verified.

## Implemented capability probe

Addon **0.3.2-alpha** includes a diagnostic-only probe:

`/fdb guildapi`

The probe:

- does **not** write Guildbook data to SavedVariables;
- does **not** upload guild data to Supabase;
- reports whether the relevant guild/profession/recipe functions exist;
- prints the logged-in character's professions when available;
- prints a small cached guild-roster sample;
- requests a roster refresh through `C_GuildInfo.GuildRoster()` or legacy `GuildRoster()`;
- listens for `GUILD_ROSTER_UPDATE` and prints a refreshed sample;
- times out after 12 seconds and falls back to the current roster cache.

Recipe query functions are only checked for existence. The probe intentionally does
not invoke recipe-query APIs because some require UI/query state and should be tested
separately after the base capability matrix is known.

### Test procedure

1. Log in on a character that belongs to a guild.
2. Run `/fdb guildapi`.
3. Wait up to 12 seconds for the refreshed section.
4. Capture the full chat output.
5. Repeat on a character with professions if the first character has none.

The output is the compatibility gate for the Guildbook SavedVariables schema.

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
