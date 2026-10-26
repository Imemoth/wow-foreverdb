"""Per-map manifest. A strict superset of the web app's manifest contract (web/src/lib/maps/manifest.ts):
`zoneId` is the uiMapID (kept for the POC loader); `uiMapId` repeats it explicitly. Calibration is NEVER 'validated' here."""
from __future__ import annotations

import hashlib
import json

from . import MANIFEST_SCHEMA_VERSION, TOOL_VERSION
from .identity import BuildIdentity
from .inventory import MapEntry

PROJECTION = {
    "type": "normalized-percent", "origin": "top-left", "xDirection": "right", "yDirection": "down", "range": [0, 100],
    "pixelX": "imageWidth * xPercent / 100", "pixelY": "imageHeight * yPercent / 100",
}


def canonical_json(obj) -> str:
    return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def image_record(file: str, fmt: str, width: int, height: int, data: bytes, pixel_sha: str) -> dict:
    return {"file": file, "format": fmt, "width": width, "height": height, "bytes": len(data), "sha256": sha256_hex(data), "pixelSha256": pixel_sha}


def tiles_digest(tiles: dict[tuple[int, int], int]) -> str:
    return sha256_hex(json.dumps(sorted([r, c, f] for (r, c), f in tiles.items())).encode())


def build_manifest(entry: MapEntry, slug_: str, version: str, ident: BuildIdentity, primary: dict, primary_meta: dict,
                   extras: list[dict], registration: dict | None, partial: bool, warnings: list[str]) -> dict:
    """`primary`: image_record of overview; `primary_meta`: {mapArtId, phaseId, styleId, layerIndex, tileCount, expectedTiles, tilesSha256};
    `extras`: further variant/layer images (same shape as image_record + variant info)."""
    cal_note = ("Projection is the accepted ForeverDB normalized-percent model by construction; registration against known landmarks "
                "has not been visually verified.")
    cal: dict = {"status": "provisional", "note": cal_note}
    if registration is not None:
        cal["registration"] = registration
    m = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "zoneId": entry.ui_map_id, "uiMapId": entry.ui_map_id,
        "slug": slug_, "zoneName": entry.name, "version": version,
        "parentUiMapId": entry.parent_id or None,
        "mapType": {"name": entry.type_name, "raw": entry.type_raw}, "system": entry.system, "category": entry.category,
        "mapIds": sorted(entry.map_ids), "instanceType": entry.instance_type, "floor": entry.floor,
        "mapArtId": primary_meta["mapArtId"],
        "variant": {k: primary_meta[k] for k in ("mapArtId", "phaseId", "styleId", "layerIndex")} | {"isPrimary": True},
        "image": primary,
        "variants": extras,
        "clientBuild": {"product": ident.product, "version": ident.version, "buildKey": ident.build_key.lower(), "buildNumber": ident.build_number},
        "source": {"tileCount": primary_meta["tileCount"], "expectedTiles": primary_meta["expectedTiles"], "tilesSha256": primary_meta["tilesSha256"],
                   "assembledBy": f"azerdex map-atlas {TOOL_VERSION}", "metadata": "client DB2 (UiMap, UiMapXMapArt, UiMapArt, UiMapArtStyleLayer, UiMapArtTile)"},
        "projection": dict(PROJECTION),
        "provenance": {"source": f"WoW: Forever client {ident.version} ({ident.product}) map tiles assembled from client BLP textures by FileDataID",
                       "partial": partial, "warnings": warnings},
        "calibration": cal,
    }
    return m
