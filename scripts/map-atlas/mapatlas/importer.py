"""Package a validated ForeverDB.AtlasExporter ZIP as an immutable, versioned Cloudflare Pages distribution.

No DB2, CASC, BLP decoding or network access is involved: the exporter already produced the final WebP images and metadata.
Images are copied byte-for-byte (never re-encoded), every variant is preserved, and the version ledger is only ever extended.
"""
from __future__ import annotations

import copy
import io
import json
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path

import PIL
from PIL import Image, features

from . import TOOL_VERSION
from .assetset import asset_set_sha256
from .build import _carry_forward
from .exporter_zip import PROJECTION, ExporterSource, SourceMap, SourceVariant, open_source
from .identity import DEFAULT_PRODUCT, BuildIdentity
from .manifest import canonical_json, sha256_hex
from .packaging import HEADERS, PackageError, check_limits, file_table, list_files, verify_catalog, verify_manifests, verify_superset, write_deterministic_zip
from .reference import compare_to_reference
from .versioning import Ledger

TRUSTED_REVEAL_STATUS = ("client-metadata-matches-reviewed-atlas",)
ACCEPTED_REVEAL_COMPLETENESS = ("complete", "tileless-declared-overlays-skipped")
SAFE_FILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
DEV_TOKENS = {"test", "cashtest", "unused", "dev", "debug", "devland", "temp", "tmp"}
LICENSE_NOTE = "Extracted from the owner's locally installed WoW: Forever client for noncommercial development. Not for public redistribution until the owner records a decision."


@dataclass
class ImportOptions:
    zip_path: Path
    out: Path
    ledger_path: Path
    previous_dist: Path | None = None
    legacy_assets: Path | None = None
    reference_1420: Path | None = None
    product: str = DEFAULT_PRODUCT
    expect_version: str | None = None
    expect_zip_sha256: str | None = None
    expect_maps: int | None = None
    expect_variants: int | None = None
    expect_instances: int | None = None
    reveal_statuses: tuple[str, ...] = TRUSTED_REVEAL_STATUS
    reveal_completeness: tuple[str, ...] = ACCEPTED_REVEAL_COMPLETENESS


@dataclass
class MapPlan:
    sm: SourceMap
    files: dict[str, bytes] = field(default_factory=dict)            # stored file name -> exact source bytes
    names: dict[tuple[str, str, int], str] = field(default_factory=dict)  # (variant, role, layer) -> stored file name
    aliases: dict[tuple[str, str, int], str] = field(default_factory=dict)
    default_variant: str = ""
    default_reason: str = ""
    warnings: list[str] = field(default_factory=list)


def _tokens(s: str) -> set[str]:
    return {t.lower() for t in re.findall(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+", s)}


def development_flags(rec: dict) -> list[str]:
    """Transparent heuristics only: they mark records for owner review; nothing is hidden or deleted."""
    flags = []
    if "<unused>" in str(rec.get("name", "")).lower():
        flags.append("name-marked-unused")
    if (_tokens(str(rec.get("name", ""))) | _tokens(str(rec.get("directory", "")))) & (DEV_TOKENS - {"unused"}):
        flags.append("name-or-directory-looks-like-development-content")
    return flags


def choose_default(sm: SourceMap, o: ImportOptions) -> tuple[SourceVariant, str, list[str]]:
    """Verified full-reveal wins; otherwise the valid base image. Never relabels one as the other."""
    warnings: list[str] = []
    base = next((v for v in sm.variants if v.kind == "base" and v.primary), None) or next((v for v in sm.variants if v.kind == "base"), None)
    if base is None:
        raise PackageError(f"map {sm.ui_map_id}: no base variant")
    reveals = sorted((v for v in sm.variants if v.kind == "full-reveal"), key=lambda v: (not v.primary, v.phase_id, v.art_id))
    if not reveals:
        return base, "no-full-reveal-variant", warnings
    for v in reveals:
        if v.reveal_status in o.reveal_statuses and v.reveal_completeness in o.reveal_completeness:
            if v.reveal_completeness != "complete":
                warnings.append(f"default full-reveal is '{v.reveal_completeness}': overlays the client declares have no tile records, so no art exists for them")
            return v, f"verified full-reveal ({v.reveal_status}; {v.reveal_completeness})", warnings
    v = reveals[0]
    warnings.append(f"full-reveal not used as default (status {v.reveal_status!r}, completeness {v.reveal_completeness!r}); base shown")
    return base, f"full-reveal not accepted ({v.reveal_status}/{v.reveal_completeness})", warnings


def ordered(variants):
    """Stable presentation/file-naming order: the variant literally named "base" first, then other base art, then the rest."""
    return sorted(variants, key=lambda v: (v.name != "base", v.kind != "base", v.name))


def _overview(v: SourceVariant):
    return next((i for i in v.images if i.role == "overview"), None) or sorted(v.images, key=lambda i: i.layer_index)[0]


def plan_files(sm: SourceMap, o: ImportOptions) -> MapPlan:
    plan = MapPlan(sm)
    by_sha: dict[str, str] = {}
    for v in ordered(sm.variants):
        for im in sorted(v.images, key=lambda i: (i.layer_index, i.role)):
            key = (v.name, im.role, im.layer_index)
            if im.sha256 in by_sha:  # identical bytes inside one map are stored once; the manifest points both entries at the same file
                plan.aliases[key] = by_sha[im.sha256]
                plan.names[key] = by_sha[im.sha256]
                continue
            stem = f"{v.name}.webp" if im.role == "overview" else f"{v.name}-{im.role}.webp"
            name = stem
            if name in plan.files:
                name = f"{v.name}-{im.role}-layer{im.layer_index}.webp"
            if name in plan.files or not SAFE_FILE.match(name):
                raise PackageError(f"map {sm.ui_map_id}: cannot derive a unique safe file name for {key}")
            plan.files[name] = im.data
            plan.names[key] = name
            by_sha[im.sha256] = name
    dv, reason, warn = choose_default(sm, o)
    plan.default_variant, plan.default_reason, plan.warnings = dv.name, reason, warn
    return plan


def _image_rec(plan: MapPlan, v: SourceVariant, im) -> dict:
    name = plan.names[(v.name, im.role, im.layer_index)]
    rec = {"role": im.role, "file": name, "format": im.format, "width": im.width, "height": im.height, "bytes": im.bytes, "sha256": im.sha256, "layerIndex": im.layer_index}
    if im.tiles_placed is not None:
        rec |= {"tilesPlaced": im.tiles_placed, "tilesExpected": im.tiles_expected, "complete": im.tiles_placed == im.tiles_expected}
    if (v.name, im.role, im.layer_index) in plan.aliases:
        rec["aliasOf"] = name
    return rec


def build_manifest(plan: MapPlan, version: str, src: ExporterSource, o: ImportOptions, registration: dict | None) -> dict:
    sm, e = plan.sm, plan.sm.entry
    ex = src.build["exporter"]
    default = next(v for v in sm.variants if v.name == plan.default_variant)
    dim = _overview(default)
    image = _image_rec(plan, default, dim) | {"variant": default.name}
    variants = []
    for v in ordered(sm.variants):
        prov = v.manifest.get("provenance", {})
        item = {
            "variant": v.name, "kind": v.kind, "mapArtId": v.art_id, "phaseId": v.phase_id, "primary": v.primary, "isDefault": v.name == plan.default_variant,
            "images": [_image_rec(plan, v, im) for im in sorted(v.images, key=lambda i: (i.layer_index, i.role))],
            "extent": v.manifest.get("extent"),
        }
        if v.kind == "full-reveal":
            item["reveal"] = {"status": v.reveal_status, "completeness": v.reveal_completeness, "overlayTiles": prov.get("overlayTiles"),
                              "skippedOverlays": prov.get("revealSkippedOverlays", [])}
        variants.append(item)
    base_man = next((v.manifest for v in sm.variants if v.name == "base"), default.manifest)
    cal = {"status": "provisional",
           "note": "Image extent is the client's own UiMapArtStyleLayer canvas. Registration of normalized-percent coordinates against known landmarks has not been verified.",
           "worldBounds": (base_man.get("calibration") or {}).get("worldBounds", [])}
    if registration is not None:
        cal["registration"] = registration
    parent = e.get("parentUiMapId") or None
    return {
        "schemaVersion": 1, "kind": "azerdex-atlas-map", "layout": "variants-v1",
        "zoneId": e["uiMapId"], "uiMapId": e["uiMapId"], "slug": e["slug"], "zoneName": e["name"], "version": version,
        "parentUiMapId": parent, "internalMapId": e["internalMapId"], "worldMapId": e.get("worldMapId"),
        "category": e["category"], "categorySource": e.get("categorySource"), "classificationConfidence": e["classificationConfidence"],
        "classificationEvidence": e.get("classificationEvidence"), "typeName": e.get("typeName"), "system": e.get("system"), "flags": e.get("flags"),
        "mapArtIds": e.get("mapArtIds", []), "artNotInReviewedAtlas": e.get("artNotInReviewedAtlas"),
        "floor": None,  # no verified floor information exists for drawable maps in this export (UiMapGroupMember is empty)
        "image": image,
        "defaultImage": {"variant": default.name, "file": image["file"], "reason": plan.default_reason,
                         "policy": {"revealStatuses": list(o.reveal_statuses), "revealCompleteness": list(o.reveal_completeness)}},
        "variants": variants,
        "clientBuild": {"product": src.build["client"]["product"], "version": src.build["client"]["version"], "buildKey": src.build["client"]["buildKey"].lower(),
                        "buildNumber": int(src.build["client"]["version"].rsplit(".", 1)[1])},
        "source": {"kind": "exporter-zip", "exporter": {"name": ex.get("name"), "version": ex.get("version")}, "metadataSource": src.build.get("metadataSource"),
                   "sourceManifests": {v.name: v.manifest_path for v in sm.variants}},
        "projection": copy.deepcopy(PROJECTION),
        "provenance": {"source": f"WoW: Forever client {src.build['client']['version']} ({src.build['client']['product']}) map artwork exported by {ex.get('name')} {ex.get('version')}",
                       "exporterVersion": ex.get("version"), "licenseStatus": "unreviewed", "licenseNote": LICENSE_NOTE, "warnings": plan.warnings},
        "calibration": cal,
    }


def _materialize(dist: Path, mid: int, ver: str, files: dict[str, bytes], manifest_text: str, expected: dict[str, dict]) -> bool:
    """Write a version dir from this import only if it reproduces the ledger's recorded bytes exactly."""
    want = {**{n: sha256_hex(b) for n, b in files.items()}, "manifest.json": sha256_hex(manifest_text.encode())}
    if set(want) != set(expected) or any(want[n] != expected[n]["sha256"] for n in want):
        return False
    d = dist / "forever" / str(mid) / ver
    d.mkdir(parents=True, exist_ok=True)
    for n, b in files.items():
        (d / n).write_bytes(b)
    (d / "manifest.json").write_text(manifest_text, encoding="utf-8")
    return True


def run_import(o: ImportOptions) -> dict:
    src = open_source(o.zip_path, product=o.product, expect_version=o.expect_version, expect_zip_sha256=o.expect_zip_sha256,
                      expect_maps=o.expect_maps, expect_variants=o.expect_variants, expect_instances=o.expect_instances)
    client = src.build["client"]
    ident = BuildIdentity(client["product"], client["version"], client["buildKey"].lower(), "", "exporter-zip")
    ledger = Ledger.load(o.ledger_path)
    base_ledger_text = ledger.to_text()
    dist = o.out / "dist"
    if dist.exists():
        shutil.rmtree(dist)
    dist.mkdir(parents=True)
    ref_img = None
    if o.reference_1420 and o.reference_1420.is_file():
        with Image.open(o.reference_1420) as f:
            ref_img = f.convert("RGBA")

    results: dict[int, dict] = {}
    plans: dict[int, MapPlan] = {}
    manifests: dict[int, dict] = {}
    for sm in src.maps:
        mid = sm.ui_map_id
        e = sm.entry
        res = {"uiMapId": mid, "name": e["name"], "category": e["category"], "status": e["status"], "variants": [v.name for v in sm.variants]}
        results[mid] = res
        if not sm.variants:
            res["packaged"] = False
            res["reason"] = e.get("statusDetail") or e["status"]
            continue
        plan = plan_files(sm, o)
        plans[mid] = plan
        registration = None
        if mid == 1420 and ref_img is not None:
            dv = next(v for v in sm.variants if v.name == plan.default_variant)
            with Image.open(io.BytesIO(_overview(dv).data)) as f:
                registration = compare_to_reference(ref_img, f.convert("RGBA")).to_json()
        set_sha = asset_set_sha256({n: sha256_hex(b) for n, b in plan.files.items()}, build_manifest(plan, "v0", src, o, registration))
        version = ledger.lookup_asset_set(mid, set_sha)
        if version is not None:
            ledger.note_seen(mid, version, ident.version)
            text = canonical_json(build_manifest(plan, version, src, o, registration))
            if not _materialize(dist, mid, version, plan.files, text, ledger.versions(mid)[version]["files"]):
                _carry_forward(o, ledger, mid, version, dist)  # same asset set, differently-worded provenance: keep the published bytes
            res["version"], res["reusedVersion"] = version, True
        else:
            version = ledger.next_version(mid)
            man = build_manifest(plan, version, src, o, registration)
            text = canonical_json(man)
            d = dist / "forever" / str(mid) / version
            d.mkdir(parents=True)
            for n, b in plan.files.items():
                (d / n).write_bytes(b)
            (d / "manifest.json").write_text(text, encoding="utf-8")
            files = {n: {"sha256": sha256_hex(b), "bytes": len(b)} for n, b in plan.files.items()}
            files["manifest.json"] = {"sha256": sha256_hex(text.encode()), "bytes": len(text.encode())}
            ledger.record(mid, version, set_sha, files, ident.version, origin={"kind": "exporter-zip", "exporterVersion": src.build["exporter"].get("version")})
            res["version"], res["reusedVersion"] = version, False
        res["packaged"] = True
        res["defaultVariant"], res["defaultReason"] = plan.default_variant, plan.default_reason
        manifests[mid] = json.loads((dist / "forever" / str(mid) / res["version"] / "manifest.json").read_text(encoding="utf-8"))
        if registration:
            res["registration"] = registration

    for mid_s, versions in sorted(ledger.data["maps"].items(), key=lambda kv: int(kv[0])):
        for ver in sorted(versions):
            _carry_forward(o, ledger, int(mid_s), ver, dist)

    from .import_catalog import write_catalog
    catalog = write_catalog(o, dist, src, ident, results, ledger)
    problems = verify_superset(dist, ledger.data) + verify_manifests(dist) + verify_catalog(dist) + check_limits(dist)["problems"]
    if problems:
        raise PackageError("; ".join(problems[:8]))
    limits = check_limits(dist)

    o.out.mkdir(parents=True, exist_ok=True)
    (o.out / "ledger.next.json").write_text(ledger.to_text(), encoding="utf-8")
    zip_info = write_deterministic_zip(dist, o.out / f"atlas-dist-{ident.version}.zip")
    table = file_table(dist)
    (o.out / "dist-files.json").write_text(canonical_json(table), encoding="utf-8")
    (o.out / "SHA256SUMS.txt").write_text("".join(f"{m['sha256']}  {p}\n" for p, m in table.items()), encoding="utf-8")

    from .import_report import build_import_reports
    return build_import_reports(o, src, ident, plans, results, manifests, catalog, limits, zip_info, table, ledger, base_ledger_text)
