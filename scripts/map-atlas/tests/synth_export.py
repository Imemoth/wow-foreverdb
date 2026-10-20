"""Synthetic ForeverDB.AtlasExporter delivery archive (exporter 0.2.1 interchange format) for CI. No game artwork: tiny gradient WebPs.
The whole archive lives in a dict {path: bytes} so tests can mutate any file before zipping."""
from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path

from PIL import Image

CLIENT = {"product": "wow_classic_beta", "version": "1.60.1.70450", "buildKey": "84bea4233331e390fda8724c6f91ffa5", "region": "us"}
PROJECTION = {"type": "normalized-percent", "origin": "top-left", "xDirection": "right", "yDirection": "down", "range": [0, 100],
              "pixelX": "imageWidth * xPercent / 100", "pixelY": "imageHeight * yPercent / 100"}
MATCH = "client-metadata-matches-reviewed-atlas"
ROOT = "ForeverDB-Atlas-Export/"


def webp(seed: int, w: int, h: int) -> bytes:
    im = Image.new("RGB", (w, h))
    px = im.load()
    for x in range(w):
        for y in range(h):
            px[x, y] = ((x * 255 // w + seed * 37) % 256, (y * 255 // h + seed * 11) % 256, (seed * 53 + x + y) % 256)
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=80)
    return buf.getvalue()


def jdump(o) -> bytes:
    return (json.dumps(o, indent=1, ensure_ascii=False) + "\n").encode("utf-8")


# (uiMapId, name, slug, category, parent, internalMapId, status, variants: list of (kind, completeness, revealStatus, runStatus))
MAPS = [
    (947, "Azeroth", "azeroth", "world", 0, 1, "drawable", [("base", None, None, "reused")]),
    (1414, "Kalimdor", "kalimdor", "continent", 947, 1, "drawable", [("base", None, None, "reused"), ("full-reveal", "complete", MATCH, "reused")]),
    (1420, "Tirisfal Glades", "tirisfal-glades", "zone", 1414, 0, "drawable", [("base", None, None, "reused"), ("full-reveal", "complete", MATCH, "exported")]),
    (1434, "Stranglethorn Vale", "stranglethorn-vale", "zone", 1414, 0, "drawable", [("base", None, None, "reused"), ("full-reveal", "tileless-declared-overlays-skipped", MATCH, "exported")]),
    (2200, "Unmatched Reveal", "unmatched-reveal", "zone", 1414, 0, "drawable", [("base", None, None, "exported"), ("full-reveal", "complete", "client-metadata-differs-from-reviewed-atlas", "exported")]),
    (2521, "Zephras Isle", "zephras-isle", "zone", 947, 0, "drawable", [("base", None, None, "exported")]),
    (2522, "Zephras Isle", "zephras-isle", "zone", 1414, 1, "drawable", [("base", None, None, "exported")]),
    (1459, "Alterac Valley", "alterac-valley", "instance", 1414, 30, "drawable", [("base", None, None, "reused")]),
    (3001, "Inherits Parent", "inherits-parent", "zone", 1414, 0, "inherits-parent", []),
]
INSTANCES = [
    (13, "Test Dungeon", "test", "dungeon", False, []),
    (30, "Alterac Valley", "PVPZone01", "battleground", True, [1459]),
    (36, "Deadmines", "DeadminesInstance", "dungeon", False, []),
    (249, "Onyxia's Lair", "OnyxiaLairInstance", "raid", False, []),
]


def make_export(maps=MAPS, instances=INSTANCES, exporter_version="0.2.1") -> dict[str, bytes]:
    F: dict[str, bytes] = {}
    idx_maps = []
    for n, (mid, name, slug, cat, parent, internal, status, variants) in enumerate(maps):
        vs = []
        for kind, comp, rstat, run in variants:
            seed = mid * 7 + (3 if kind == "full-reveal" else 0)
            w, h = (120, 80) if mid != 1420 else (100, 66)
            data = webp(seed, w, h)
            path = f"maps/{mid}/{kind}/overview.webp"
            F[path] = data
            sha = hashlib.sha256(data).hexdigest()
            img = {"role": "overview", "path": path, "width": w, "height": h, "bytes": len(data), "sha256": sha, "format": "webp", "layerIndex": 0}
            mimg = {"role": "overview", "file": "overview.webp", "format": "webp", "width": w, "height": h, "bytes": len(data), "sha256": sha, "layerIndex": 0,
                    "tilesPlaced": 12, "tilesExpected": 12, "complete": True}
            prov = {"source": "ForeverDB.AtlasExporter", "exporterVersion": exporter_version, "clientProduct": CLIENT["product"], "clientVersion": CLIENT["version"],
                    "clientBuildKey": CLIENT["buildKey"], "metadataSource": "client-db2", "mapArtId": 2000 + mid, "phaseId": 0, "primaryArt": True, "artVariant": kind,
                    "internalMapId": internal, "encoder": "lossy-q90", "licenseStatus": "unreviewed", "note": "Extracted from the owner's locally installed client."}
            iv = {"variant": kind, "kind": kind, "uiMapArtId": 2000 + mid, "phaseId": 0, "primary": True, "status": run, "manifest": f"maps/{mid}/{kind}/manifest.json", "images": [img]}
            if kind == "full-reveal":
                prov |= {"revealStatus": rstat, "overlayTiles": 22, "revealCompleteness": comp, "revealSkippedOverlays": (["overlay 5252: tileless-declared - declares a 256x256 texture but has no tile records"] if comp != "complete" else [])}
                iv |= {"revealStatus": rstat, "revealCompleteness": comp}
            man = {"schemaVersion": 1, "kind": "foreverdb-atlas-map-variant", "zoneId": mid, "uiMapId": mid, "slug": slug, "zoneName": name, "version": "v1", "variant": kind,
                   "artVariantKind": kind, "category": cat, "categorySource": "uimap-type", "categoryConfidence": "confirmed", "typeName": "zone", "parentUiMapId": parent,
                   "status": run, "image": mimg, "images": [mimg], "projection": PROJECTION,
                   "extent": {"layerIndex": 0, "layerWidth": w, "layerHeight": h, "tileWidth": 256, "tileHeight": 256, "cropping": "cropped to layer extent"},
                   "provenance": prov, "calibration": {"status": "provisional", "note": "n", "worldBounds": [{"mapId": internal, "areaId": 1, "orderIndex": 0, "uiMin": [0, 0], "uiMax": [1, 1], "region": [0, 0, 0, 1, 1, 1]}]}, "problems": []}
            F[iv["manifest"]] = jdump(man)
            vs.append(iv)
        idx_maps.append({"uiMapId": mid, "name": name, "slug": slug, "category": cat, "categorySource": "uimap-type", "classificationConfidence": "confirmed",
                         "classificationEvidence": "UiMap.Type=3", "internalMapId": internal, "typeName": "zone", "system": 0, "flags": 2, "parentUiMapId": parent,
                         "worldMapId": internal, "status": status, "statusDetail": "" if variants else "the client gives this map no art of its own", "mapArtIds": [2000 + mid] if variants else [],
                         "artNotInReviewedAtlas": False, "variants": vs})
    drawable = sum(1 for m in idx_maps if m["status"] == "drawable")
    n_var = sum(len(m["variants"]) for m in idx_maps)
    ids = {m["uiMapId"] for m in idx_maps}
    nodes = [{"uiMapId": m["uiMapId"], "name": m["name"], "parentUiMapId": m["parentUiMapId"], "depth": 0, "parentMissing": False,
              "children": sorted(c["uiMapId"] for c in idx_maps if c["parentUiMapId"] == m["uiMapId"])} for m in idx_maps]
    recs = []
    for mapid, name, dirn, cls, drawable_i, uimaps in instances:
        r = {"mapId": mapid, "name": name, "directory": dirn, "classification": cls, "classificationSource": "map-instance-type", "confidence": "confirmed", "instanceTypeRaw": 1,
             "mapTypeRaw": 2, "expansionId": 0, "parentMapId": -1, "cosmeticParentMapId": -1, "evidence": [f"Map#{mapid} InstanceType=1"], "drawable": drawable_i,
             "drawableUiMaps": len(uimaps), "entranceUiMapIds": [], "regionUiMapIds": [], "floorNote": "single map; no floor group" if uimaps else "no interior UiMap",
             "uiMaps": [{"uiMapId": u, "name": name, "category": "instance", "artStatus": "drawable", "parentUiMapId": 1414, "floorSource": "none"} for u in uimaps], "floorGroups": []}
        if not drawable_i:
            r["missingArtworkReason"] = "the client defines no UiMap (UiMapAssignment) for this MapID, so there is no interior map"
        recs.append(r)
    byc: dict[str, int] = {}
    for r in recs:
        byc[r["classification"]] = byc.get(r["classification"], 0) + 1
    F["atlas/instances.json"] = jdump({"schemaVersion": 1, "kind": "foreverdb-atlas-instances", "coverage": "map-table (synthetic)", "notes": [],
                                       "counts": {"records": len(recs), "drawable": sum(r["drawable"] for r in recs), "withoutInteriorMap": sum(not r["drawable"] for r in recs),
                                                  "byClassification": byc}, "identity": "mapId is the internal Map ID.", "instances": recs})
    F["atlas/hierarchy.json"] = jdump({"schemaVersion": 1, "roots": [947], "orphanedByMissingParent": [], "cycleMembers": [], "nodes": nodes, "links": [], "instances": [], "note": "n"})
    F["atlas/index.json"] = jdump({"schemaVersion": 1, "kind": "foreverdb-atlas-export-index", "client": CLIENT, "metadataSource": "client-db2",
                                   "counts": {"mapsDiscovered": len(idx_maps), "drawableMaps": drawable}, "maps": idx_maps})
    F["atlas/build.json"] = jdump({"schemaVersion": 1, "exporter": {"name": "ForeverDB.AtlasExporter", "version": exporter_version}, "client": CLIENT, "metadataSource": "client-db2",
                                   "tableSources": {"UiMap": "client-db2"}, "tableRowCounts": {"UiMap": len(idx_maps)}, "encoder": "lossy-q90", "fullReveal": True, "allowPartial": False,
                                   "notes": [], "projection": "normalized-percent, top-left origin", "calibration": "provisional"})
    cdn = sum(1 for p in F if p.startswith(("maps/", "atlas/"))) + 1  # + export-report.json itself
    F["atlas/export-report.json"] = jdump({"schemaVersion": 1, "status": "COMPLETE", "counts": {"mapsDiscovered": len(idx_maps), "drawableMaps": drawable, "mapsExported": 0, "mapsReused": drawable,
                                                                                               "mapsSharedArt": 0, "mapsPartial": 0, "mapsFailed": 0, "mapsMissingArtwork": 0, "mapsInherited": len(idx_maps) - drawable,
                                                                                               "variantsExported": n_var, "variantsFailed": 0},
                                           "cloudflarePagesFree": {"cdnFileCount": cdn}})
    F["diagnostics/regression-1420.json"] = jdump({"schemaVersion": 1, "subject": "synthetic", "exported": True})
    F["diagnostics/missing-maps.json"] = jdump({"schemaVersion": 1, "count": 0, "maps": []})
    F["diagnostics/extraction-errors.json"] = jdump({"schemaVersion": 1, "count": 0, "errors": []})
    F["diagnostics/run-info.json"] = jdump({"startedUtc": "2026-01-01T00:00:00Z"})
    F["diagnostics/export-summary.txt"] = b"synthetic summary\n"
    F["README.txt"] = b"synthetic export\n"
    F["gallery/index.html"] = b"<html></html>"
    return F


def edit_json(F: dict[str, bytes], path: str, fn) -> None:
    d = json.loads(F[path].decode("utf-8"))
    fn(d)
    F[path] = jdump(d)


def write_zip(F: dict[str, bytes], path: Path, root: str = ROOT, extra: list[tuple[zipfile.ZipInfo, bytes]] | None = None) -> Path:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in F.items():
            z.writestr(root + name, data)
        for info, data in extra or []:
            z.writestr(info, data)
    return path
