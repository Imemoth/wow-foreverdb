"""Acquisition / validation report. Discovery coverage (what the client metadata defines) is kept strictly separate from
extraction coverage (what was actually assembled and exported). Only measured counts and their ratios are reported."""
from __future__ import annotations

import json
import tempfile
from collections import Counter
from pathlib import Path

from .identity import BuildIdentity
from .inventory import UIMAP_TYPES, Inventory, build_inventory
from .manifest import canonical_json
from .versioning import Ledger, slug

REFERENCE_BUILD = "1.60.1.70450"  # externally identified when the task was written; never assumed to be current


def _ratio(a: int, b: int) -> float | None:
    return round(a / b, 4) if b else None


def forever_checks(names: tuple[str, ...], inv: Inventory, per_map: dict[int, dict]) -> list[dict]:
    out = []
    by_slug: dict[str, list[int]] = {}
    for mid, e in inv.maps.items():
        by_slug.setdefault(slug(e.name, mid), []).append(mid)
    for n in names:
        ids = sorted(by_slug.get(slug(n, 0), []))
        if not ids:
            out.append({"name": n, "status": "not-found-in-client-metadata", "uiMapIds": []})
            continue
        sts = {i: per_map[i]["status"] for i in ids}
        status = "exported" if any(v == "exported" for v in sts.values()) else ("no-artwork" if all(v == "no-artwork" for v in sts.values()) else "export-failed")
        out.append({"name": n, "status": status, "uiMapIds": ids, "perMap": {str(k): v for k, v in sts.items()}})
    return out


def baseline_diff(baseline_db2: Path, inv: Inventory) -> dict:
    """Optional: maps that do not exist in (or whose tile FileDataIDs differ from) a baseline (e.g. Classic Era) export."""
    base = build_inventory(baseline_db2)

    def tiles(e) -> frozenset:
        return frozenset(f for v in e.variants for l in v.layers for f in l.tiles.values())

    new = sorted(i for i in inv.maps if i not in base.maps)
    changed = sorted(i for i, e in inv.maps.items() if i in base.maps and tiles(e) and tiles(e) != tiles(base.maps[i]))
    return {"newUiMapIds": new, "newNames": {str(i): inv.maps[i].name for i in new}, "changedArtUiMapIds": changed,
            "changedNames": {str(i): inv.maps[i].name for i in changed}}


def build_report(o, ident: BuildIdentity, inv: Inventory, per_map: dict[int, dict], exported: set[int], dupes: list[dict],
                 missing_fd: list[int], decode_fail: list[dict], limits: dict, zip_info: dict, ledger: Ledger, base_ledger_text: str) -> dict:
    maps = inv.maps
    drawable = [i for i, e in maps.items() if e.drawable]
    by_type = Counter(e.type_name for e in maps.values())
    unknown_types = sorted({e.type_raw for e in maps.values() if e.type_raw not in UIMAP_TYPES})
    exp_by_cat = Counter(maps[i].category for i in exported)
    drawable_by_cat = Counter(maps[i].category for i in drawable)
    images = [im for r in per_map.values() for im in r["images"]]
    status_counts = Counter(r["status"] for r in per_map.values())
    exc = []
    for mid, r in sorted(per_map.items()):
        if r["status"] != "exported":
            exc.append({"uiMapId": mid, "name": r["name"], "type": r["type"], "status": r["status"], "reasons": r.get("reasons", [])})
    ref = per_map.get(1420, {}).get("referenceComparison")
    rep = {
        "schemaVersion": 1,
        "client": ident.to_json() | {"referenceBuildNote": f"externally identified reference build {REFERENCE_BUILD}; "
                                     + ("matches the build used" if ident.version == REFERENCE_BUILD else f"DIFFERS from the build used ({ident.version})")},
        "discovery": {
            "totalUiMapEntries": len(maps), "byType": dict(sorted(by_type.items())), "unknownTypeIds": unknown_types,
            "withArtDefinition": sum(1 for e in maps.values() if e.variants), "withUsableArtwork": len(drawable),
            "withoutOwnArtwork": len(maps) - len(drawable), "drawableByCategory": dict(sorted(drawable_by_cat.items())),
            "alternateArtVariants": sum(max(0, len([v for v in e.variants if v.primary_layer]) - 1) for e in maps.values()),
            "tables": inv.table_rows, "missingOptionalTables": inv.missing_optional_tables,
            "worldMapOverlays": inv.overlay_summary, "areaTableRows": inv.area_table_rows, "assignedAreasWithoutOwnMap": inv.areas_without_own_map,
            "hierarchyIssues": inv.hierarchy_issues,
            "cityMaps": "not separately classifiable: no verified city discriminator in the client metadata used; cities appear under 'zone'",
        },
        "extraction": {
            "exportedMaps": len(exported), "exportedImages": sum(1 for im in images if im["ok"]),
            "exportedByCategory": dict(sorted(exp_by_cat.items())),
            "exportedWorldContinent": sorted(i for i in exported if maps[i].category in ("world", "continent")),
            "failedMaps": status_counts.get("export-failed", 0), "mapsWithoutArtwork": status_counts.get("no-artwork", 0),
            "extractionRatioOfDrawable": _ratio(len(exported), len(drawable)),
            "missingTileFileDataIds": len(missing_fd), "missingTileFileDataIdSample": missing_fd[:50],
            "decodeFailures": len(decode_fail), "decodeFailureSample": decode_fail[:20],
            "partialImages": sum(1 for im in images if im.get("partial")),
        },
        "validation": {
            "imagesWithErrors": sum(1 for im in images if im["errors"]), "imagesWithWarnings": sum(1 for im in images if im["warnings"]),
            "duplicateArtAcrossMaps": dupes,
        },
        "exceptions": exc,
        "foreverSpecific": forever_checks(o.forever_checks, inv, per_map),
        "tirisfalRegression": ref if ref is not None else ("1420 not exported in this run" if 1420 not in exported else "no reference image supplied"),
        "package": {"limits": limits, "zip": zip_info, "newVersionsThisRun": _new_versions(ledger, base_ledger_text)},
        "complete": {"everyDrawableMapExportedOrDocumented": all(r["status"] == "exported" or r.get("reasons") for r in per_map.values()),
                     "allDrawableExported": len(exported) == len(drawable)},
    }
    if o.baseline_db2:
        rep["baselineComparison"] = baseline_diff(o.baseline_db2, inv)
    return rep


def _new_versions(ledger: Ledger, base_text: str) -> list[str]:
    base = json.loads(base_text)["maps"]
    return sorted(f"{m}/{v}" for m, vs in ledger.data["maps"].items() for v in vs if v not in base.get(m, {}))


def write_report(out: Path, rep: dict) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "coverage.json").write_text(canonical_json(rep), encoding="utf-8")
    d, x = rep["discovery"], rep["extraction"]
    lines = [f"# Map atlas coverage — client {rep['client']['version']} ({rep['client']['product']})", "",
             f"Build key `{rep['client']['buildKey']}`. {rep['client']['referenceBuildNote']}.", "",
             "## Discovery (what the client metadata defines)", f"- UiMap entries: **{d['totalUiMapEntries']}**  ·  by type: {d['byType']}",
             f"- With an art definition: {d['withArtDefinition']}  ·  with usable artwork: **{d['withUsableArtwork']}**  ·  without own artwork: {d['withoutOwnArtwork']}",
             f"- Alternate art variants (usable, beyond the first per map): {d['alternateArtVariants']}",
             f"- Unknown map types: {d['unknownTypeIds'] or 'none'}  ·  hierarchy issues: {len(d['hierarchyIssues'])}",
             f"- City maps: {d['cityMaps']}", "",
             "## Extraction (what was actually assembled and exported)", f"- Exported maps: **{x['exportedMaps']}** of {d['withUsableArtwork']} drawable (ratio {x['extractionRatioOfDrawable']})  ·  images: {x['exportedImages']}",
             f"- By category: {x['exportedByCategory']}", f"- World/continent maps exported: {x['exportedWorldContinent']}",
             f"- Failed maps: {x['failedMaps']}  ·  missing tile FileDataIDs: {x['missingTileFileDataIds']}  ·  decode failures: {x['decodeFailures']}", "",
             "## Forever-specific zones"]
    for f in rep["foreverSpecific"]:
        lines.append(f"- {f['name']}: **{f['status']}** {f['uiMapIds']}")
    lines += ["", "## Tirisfal regression (uiMapID 1420)", f"```\n{json.dumps(rep['tirisfalRegression'], indent=2)}\n```", "",
              f"## Package\n- Files: {rep['package']['limits']['fileCount']} (limit {rep['package']['limits']['limits']['files']}); largest file {rep['package']['limits']['largestBytes']} bytes (limit {rep['package']['limits']['limits']['fileBytes']})",
              f"- Zip: {rep['package']['zip']['bytes']} bytes, sha256 `{rep['package']['zip']['sha256']}`", f"- New versions this run: {rep['package']['newVersionsThisRun']}", "",
              f"## Exceptions ({len(rep['exceptions'])})"]
    for e in rep["exceptions"][:200]:
        lines.append(f"- {e['uiMapId']} {e['name']} [{e['type']}] — {e['status']}: {'; '.join(e['reasons'][:2])}")
    (out / "coverage.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
