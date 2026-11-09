# Companion global atlas compatibility

## Root cause confirmed from the user's current client evidence

The current WoW Forever client reports `.build.info` Product `wowf`, Version `1.60.1.70862`, Build Key `5ada954223f7c409ea172361f5c9e565`. The Companion atlas verifier accepted only `wow_classic_beta`, so `wowf` never reached the exact-build DB2 comparison. Separately, the native CASC full-reveal extraction path required the storage label `wow_classic_beta`. Those shared gates explain why full reveal fell back to base artwork across zones. The UI warning described old verified version numbers, obscuring the earlier product rejection.

The code now treats the embedded atlas as reference data, not as a version allowlist. For every active `wowf` build, it validates the four exact-version DB2 tables, then compares each MapArtID's region geometry and ordered FileDataIDs against the reference. Only art with identical metadata is reused. The proof cache remains tied to product, version, exact Build Key and the SHA-256 fingerprint of the atlas. Extraction and overlay loading are pinned to the same validated `wowf` product/build.

Compatibility has three outcomes:

- **Verified compatible:** exact-build metadata is structurally valid and the selected art matches. Existing atlas content is reused and labeled verified.
- **Proven incompatible:** metadata is valid but that art's geometry/tile IDs differ, or the art is missing. The UI identifies the art and keeps the base map for it.
- **Unverified:** the source is unavailable, malformed, unsupported, or the active product/build identity is unavailable. The UI says compatibility is unverified; it does not call the map incompatible or verified.

When validated metadata changes, the probe writes a review-only candidate containing only changed/new MapArtIDs. It reports missing IDs separately. Invalid/incomplete tile grids cannot create a candidate. No generated content is automatically substituted for the reviewed reference atlas.

## Map identity and coordinates

For Wilted Peacebloom object #656160, the saved location scope is UiMapID 1420 and the current WoW API reports MapArtID 2126. The user's supplied screenshot shows that same map/art identity and coordinates around Deathknell. Silverpine Forest and Alterac labels are visible on the client-provided art; those neighboring labels alone do not prove an incorrect map selection. Addon metadata records `parentMapId`, exact `mapArtId`, and layer texture references from `C_Map`; the Companion selects the art by UiMapID and uses the same normalized source coordinate system for all map display modes.

The WPF Fit/viewport alignment issue is deliberately outside this compatibility change and remains a separate follow-up.

## Embedded global coverage inventory

The immutable reference resource currently contains **84 MapArtIDs, 1,073 reveal regions and 1,739 tile references**. The table lists every embedded art and its region/tile counts. It does not claim that every art is compatible with build 1.60.1.70862; that result is produced by the exact-build probe.

| MapArtID | Regions | Tile references |
| ---: | ---: | ---: |
| 1194 | 11 | 12 |
| 1200 | 15 | 18 |
| 1202 | 25 | 25 |
| 1205 | 15 | 32 |
| 1206 | 16 | 16 |
| 1207 | 14 | 25 |
| 1209 | 9 | 13 |
| 1210 | 16 | 18 |
| 1211 | 15 | 15 |
| 1212 | 13 | 22 |
| 1213 | 22 | 27 |
| 1214 | 12 | 24 |
| 1215 | 14 | 20 |
| 1216 | 18 | 19 |
| 1220 | 7 | 22 |
| 1224 | 10 | 30 |
| 1228 | 12 | 18 |
| 1233 | 3 | 10 |
| 1235 | 13 | 29 |
| 1236 | 11 | 26 |
| 1238 | 27 | 27 |
| 1239 | 11 | 27 |
| 1240 | 14 | 17 |
| 1243 | 15 | 19 |
| 1244 | 11 | 12 |
| 1247 | 9 | 9 |
| 1248 | 18 | 21 |
| 1249 | 9 | 15 |
| 1250 | 11 | 19 |
| 1251 | 15 | 22 |
| 1252 | 16 | 19 |
| 1253 | 7 | 13 |
| 1254 | 20 | 20 |
| 1259 | 19 | 31 |
| 1260 | 12 | 12 |
| 1261 | 7 | 30 |
| 1263 | 1 | 6 |
| 1264 | 7 | 24 |
| 1266 | 13 | 13 |
| 1273 | 3 | 8 |
| 1997 | 9 | 30 |
| 2031 | 15 | 27 |
| 2054 | 13 | 35 |
| 2121 | 11 | 44 |
| 2126 | 17 | 22 |
| 2130 | 15 | 24 |
| 2132 | 7 | 28 |
| 2133 | 15 | 30 |
| 2134 | 23 | 47 |
| 2147 | 16 | 16 |
| 2148 | 9 | 13 |
| 2149 | 10 | 30 |
| 2150 | 3 | 10 |
| 2151 | 18 | 19 |
| 2152 | 13 | 29 |
| 2153 | 12 | 18 |
| 2154 | 12 | 24 |
| 2156 | 11 | 26 |
| 2157 | 7 | 22 |
| 2158 | 15 | 15 |
| 2159 | 14 | 25 |
| 2160 | 26 | 26 |
| 2161 | 11 | 27 |
| 2162 | 14 | 20 |
| 2164 | 13 | 22 |
| 2165 | 14 | 17 |
| 2166 | 15 | 19 |
| 2167 | 18 | 21 |
| 2168 | 19 | 31 |
| 2169 | 11 | 12 |
| 2170 | 16 | 19 |
| 2171 | 9 | 9 |
| 2173 | 7 | 13 |
| 2174 | 12 | 12 |
| 2175 | 1 | 6 |
| 2177 | 7 | 24 |
| 2178 | 11 | 19 |
| 2179 | 20 | 20 |
| 2180 | 11 | 12 |
| 2181 | 25 | 25 |
| 2182 | 9 | 15 |
| 2184 | 7 | 30 |
| 2185 | 13 | 13 |
| 2186 | 3 | 8 |

The atlas resource carries only numeric region geometry and FileDataIDs; it does not contain Blizzard art or a UiMapID-to-zone-name catalog. In the exact-build probe, every reference MapArtID is reported as compatible, changed, or missing; newly introduced art IDs are listed separately. Known zone anchors are Mulgore #1200, Tirisfal #2126 and Silverpine #2158.

## Update flow and verification

The Companion discovers active build rows from the installed `.build.info`; it does not need a hardcoded list of future build numbers. It fetches public `WorldMapOverlay`, `WorldMapOverlayTile`, `UiMapArt` and `UiMapArtStyleLayer` CSVs for the active numeric version. Validation checks the complete source tables and per-art geometry, offsets, dimensions, conditions, tile positions and ordered FileDataIDs. Existing artwork can be reused only when the exact-build records match. CASC extraction reads FileDataIDs from the same active product/build; a missing or corrupt tile rejects the complete full-reveal render and retains the original base art.

On Windows CI run `42676198990` at Companion code commit `990de80c20282c45e8afacb6a2a5748494ddc1db`, the supplied `wowf` 1.60.1.70862 identity matched **84/84 MapArtIDs**. All **1,073 regions** and **1,739 ordered tile references** matched; changed, missing, additional and unmatched embedded ID lists were empty. No candidate atlas was generated and the immutable atlas remains unchanged. The run also passed Companion build plus sync-health (21), Guildbook (23), search-zone (70), and full-map (40) assertions. The x64 Windows publish succeeded in build run `42676199245`. This is metadata and repository-test evidence; live owner acceptance of CASC map rendering, overlays and marker alignment is still outstanding. The downloadable JSON inventory is available from the run artifact `atlas-coverage-wowf-1.60.1.70862`.

Regression coverage includes the existing 84-art equality fixture, an isolated changed art that leaves the other 83 compatible, candidate generation limited to that changed art, unsupported product rejection, `wowf` build 1.60.1.70862 acceptance for content validation, incomplete/missing/corrupt tile rejection, and #656160/UiMapID 1420/MapArtID 2126.

No production database, client installation, or deployed service was modified.
