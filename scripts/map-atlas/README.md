# AzerDex map atlas pipeline

Turns the WoW: Forever client's map metadata + BLP textures into a versioned, CDN-ready WebP atlas
(`dist/forever/{uiMapID}/{version}/…`, `dist/atlas/*.json`, `dist/_headers`). Full guide: [`docs/web/map-atlas.md`](../../docs/web/map-atlas.md).

```
pip install -r scripts/map-atlas/requirements.txt
python scripts/map-atlas/atlas.py identity   --wow-root <WoW or _classic_beta_ folder> --bundle map-atlas-bundle
python scripts/map-atlas/atlas.py fetch-db2  --bundle map-atlas-bundle            # exact-build DB2 CSVs (wago.tools)
python scripts/map-atlas/atlas.py extract    --wow-root <...> --bundle map-atlas-bundle   # BLPs by FileDataID (Windows, CascLib.dll)
python scripts/map-atlas/atlas.py build      --bundle map-atlas-bundle --out map-atlas-out [--previous-dist <last published dist>]
python scripts/map-atlas/atlas.py verify-dist --dist map-atlas-out/dist --ledger map-atlas-out/ledger.next.json
```

Unified CDN snapshot (atlas baseline + cinematic zone heroes, V2-A; nothing is uploaded — see [`docs/web/unified-cdn-v2a.md`](../../docs/web/unified-cdn-v2a.md)):

```
python scripts/map-atlas/atlas.py build-unified  --baseline <atlas-dist-1.60.1.70450.zip> --out <out>   # verifies the baseline against baseline/*.json first
python scripts/map-atlas/atlas.py verify-unified --dist <out>/dist
python scripts/map-atlas/atlas.py verify-baseline --baseline <zip or extracted dir>                      # e.g. a download of the live CDN
python scripts/map-atlas/atlas.py hero-measure   --dir <derivatives>                                      # inventory records for a new hero
```

Read-only CDN verification for the owner (Windows PowerShell 5.1/7, no dependencies): `windows\Verify-AzerdexCdn.ps1 -Mode Local|Baseline|Post` — see [`docs/web/v2b-cloudflare-cdn-pilot.md`](../../docs/web/v2b-cloudflare-cdn-pilot.md).

Tests (synthetic client, no network): `cd scripts/map-atlas && python -m unittest discover -s tests`.

| Module | Role |
| --- | --- |
| `identity.py` | Client build from `.build.info` (product, version, build key) — never assumed |
| `csvtables.py`, `fetch.py` | DB2 CSVs read by column **name**; exact-build download (same source/shape as the Companion) |
| `inventory.py` | Every UiMap, art variants, layers, tiles, hierarchy, floors, instance types; drawable vs. no-artwork |
| `casc.py` | CascLib.dll FileDataID → BLP extraction (mirrors `NativeCascMapReader.cs`) |
| `assemble.py`, `validate.py` | Tile placement identical to the Companion; blank/transparent/seam/aspect/WebP checks |
| `versioning.py`, `packaging.py` | Append-only ledger, Pages limits, deterministic zip, superset (no-drop) guarantee |
| `heroes.py`, `unified.py` | V2-A: hero inventory/ledger validation and the unified baseline + heroes snapshot (pin, headers, Pages limits, append-only) |
| `reference.py` | Evidence-only comparison with an accepted reference image (Tirisfal) |
| `report.py`, `gallery.py` | Coverage report (discovery ≠ extraction) and offline preview gallery |
