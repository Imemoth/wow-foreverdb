"""Build orchestration: bundle (DB2 CSVs + BLPs) -> assembled/validated/encoded maps -> versioned dist/ + reports + preview."""
from __future__ import annotations

import io
import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path

import PIL
from PIL import Image, features

from . import TOOL_VERSION
from .assemble import assemble_layer
from .assetset import asset_set_sha256
from .identity import BuildIdentity, identity_from_json
from .inventory import Inventory, MapEntry, Variant, build_inventory, children_index
from .manifest import build_manifest, canonical_json, image_record, sha256_hex, tiles_digest
from .packaging import HEADERS, PackageError, check_limits, file_table, sha256_file, verify_manifests, verify_superset, write_deterministic_zip
from .reference import compare_to_reference
from .validate import check_image, pixel_sha256, verify_webp
from .versioning import Ledger, slug

DEFAULT_FOREVER_CHECKS = ("Zephras Isle", "Riverglades", "Shen'dralas", "Mount Hyjal")


@dataclass
class Options:
    bundle: Path
    out: Path
    ledger_path: Path
    previous_dist: Path | None = None
    legacy_assets: Path | None = None       # e.g. web/public/maps  (holds the immutable POC forever/1420/v1)
    reference_1420: Path | None = None
    quality: int = 90
    allow_partial: bool = False
    baseline_db2: Path | None = None
    forever_checks: tuple[str, ...] = DEFAULT_FOREVER_CHECKS
    expect_version: str | None = None


@dataclass
class _Img:
    role: str                 # "primary" or "variant:<art>:layer:<idx>"
    variant: Variant
    layer_index: int
    file: str = ""
    data: bytes = b""
    pixel_sha: str = ""
    size: tuple[int, int] = (0, 0)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    assembly: dict = field(default_factory=dict)
    partial: bool = False
    ok: bool = False
    tiles_sha: str = ""
    tile_count: int = 0
    expected_tiles: int = 0
    thumb: Image.Image | None = None


def _encode(img: Image.Image, quality: int) -> bytes:
    buf = io.BytesIO()
    opaque = img.getchannel("A").getextrema()[0] == 255
    (img.convert("RGB") if opaque else img).save(buf, "WEBP", quality=quality, method=6, alpha_quality=100)
    return buf.getvalue()


def _norm(name: str) -> str:
    return slug(name, 0)


def run_build(o: Options) -> dict:
    ident = identity_from_json(json.loads((o.bundle / "build.json").read_text(encoding="utf-8")))
    if o.expect_version and ident.version != o.expect_version:
        raise PackageError(f"bundle is client {ident.version}, expected {o.expect_version}")
    inv = build_inventory(o.bundle / "db2")
    ledger = Ledger.load(o.ledger_path)
    base_ledger_text = ledger.to_text()
    blp_dir = o.bundle / "blp"
    present = {int(p.stem) for p in blp_dir.glob("*.blp") if p.stem.isdigit()} if blp_dir.is_dir() else set()

    def source(fd: int) -> bytes | None:
        return (blp_dir / f"{fd}.blp").read_bytes() if fd in present else None

    dist = o.out / "dist"
    if dist.exists():
        shutil.rmtree(dist)
    dist.mkdir(parents=True)
    ref_img = None
    if o.reference_1420 and o.reference_1420.is_file():
        with Image.open(o.reference_1420) as f:
            ref_img = f.convert("RGBA")

    per_map: dict[int, dict] = {}
    exported_ids: set[int] = set()
    produced: dict[int, str] = {}
    all_pixel: dict[str, list[tuple[int, str]]] = {}
    missing_fd: set[int] = set()
    decode_fail: list[dict] = []
    thumbs: dict[int, Image.Image] = {}
    build_label = ident.version

    for mid in sorted(inv.maps):
        e = inv.maps[mid]
        rec: dict = {"uiMapId": mid, "name": e.name, "type": e.type_name, "category": e.category, "drawable": e.drawable, "images": [], "notes": list(e.notes)}
        per_map[mid] = rec
        if not e.drawable:
            rec["status"] = "no-artwork"
            rec["reasons"] = e.reasons
            continue
        imgs: list[_Img] = []
        variants = sorted(e.variants, key=lambda v: (v.phase_id, v.map_art_id))
        for v in variants:
            primary_layer = v.primary_layer
            for layer in v.usable_layers:
                role_img = _Img("", v, layer.index)
                res = assemble_layer(layer, source)
                role_img.assembly = {"expectedTiles": res.expected_tiles, "placed": res.placed, "missingFileDataIds": res.missing_files,
                                     "decodeFailures": [{"fileDataId": f, "error": err} for f, err in res.decode_failures],
                                     "sizeMismatches": [{"fileDataId": f, "size": list(s)} for f, s in res.size_mismatches],
                                     "unfilledGridCells": res.unfilled_grid_cells, "layerIssues": layer.issues}
                missing_fd.update(res.missing_files)
                decode_fail += [{"uiMapId": mid, "fileDataId": f, "error": err} for f, err in res.decode_failures]
                role_img.tile_count, role_img.expected_tiles = len(layer.tiles), layer.expected_tiles
                role_img.tiles_sha = tiles_digest(layer.tiles)
                chk = check_image(res.image, layer.width, layer.height, layer.tile_w, layer.tile_h, res.complete)
                role_img.errors, role_img.warnings = list(chk.errors) + [f"layer: {i}" for i in layer.issues], list(chk.warnings)
                if res.size_mismatches:
                    role_img.warnings.append(f"{len(res.size_mismatches)} tile(s) not {layer.tile_w}x{layer.tile_h}")
                if res.missing_files:
                    role_img.errors.append(f"{len(res.missing_files)} tile BLP(s) missing from the bundle")
                if res.decode_failures:
                    role_img.errors.append(f"{len(res.decode_failures)} tile(s) failed to decode")
                only_incomplete = bool(role_img.errors) and all(x == "incomplete tile coverage" or x.endswith("missing from the bundle") or x.endswith("failed to decode") or x.startswith("layer: ") for x in role_img.errors) and res.placed > 0
                if o.allow_partial and only_incomplete:
                    role_img.partial = True
                    role_img.warnings += role_img.errors
                    role_img.errors = []
                role_img.size = res.image.size
                role_img.pixel_sha = pixel_sha256(res.image)
                if not role_img.errors:
                    data = _encode(res.image, o.quality)
                    bad = verify_webp(data, res.image)
                    if bad:
                        role_img.errors += bad
                    else:
                        role_img.data, role_img.ok = data, True
                        t = res.image.copy()
                        t.thumbnail((320, 320))
                        role_img.thumb = t
                imgs.append(role_img)
        # primary: first variant (by phase, art id) whose primary layer is ok
        primary = next((i for v in variants for i in imgs if i.variant is v and v.primary_layer and i.layer_index == v.primary_layer.index and i.ok), None)
        for i in imgs:
            rec["images"].append({"mapArtId": i.variant.map_art_id, "phaseId": i.variant.phase_id, "layerIndex": i.layer_index,
                                  "size": list(i.size), "ok": i.ok, "partial": i.partial, "errors": i.errors, "warnings": i.warnings, "assembly": i.assembly})
        if primary is None:
            rec["status"] = "export-failed"
            rec["reasons"] = sorted({x for i in imgs for x in i.errors}) or ["no exportable primary image"]
            continue
        if primary.thumb is not None:
            thumbs[mid] = primary.thumb
        # file names
        primary.role = "primary"
        primary.file = "overview.webp"
        for i in imgs:
            if i is primary or not i.ok:
                continue
            same_variant = i.variant is primary.variant
            i.role = f"variant:{i.variant.map_art_id}:layer:{i.layer_index}"
            i.file = f"layer-{i.layer_index}.webp" if same_variant else (f"variant-{i.variant.map_art_id}.webp" if i.layer_index == (i.variant.primary_layer.index if i.variant.primary_layer else -1) else f"variant-{i.variant.map_art_id}-layer-{i.layer_index}.webp")
        kept = [primary] + [i for i in imgs if i is not primary and i.ok]
        for i in kept:
            all_pixel.setdefault(i.pixel_sha, []).append((mid, i.file))
        slug_ = slug(e.name, mid)
        reg = None
        if mid == 1420 and ref_img is not None:
            with Image.open(io.BytesIO(primary.data)) as f:
                reg = compare_to_reference(ref_img, f.convert("RGBA")).to_json()
        pm = {"mapArtId": primary.variant.map_art_id, "phaseId": primary.variant.phase_id, "styleId": primary.variant.style_id,
              "layerIndex": primary.layer_index, "tileCount": primary.tile_count, "expectedTiles": primary.expected_tiles, "tilesSha256": primary.tiles_sha}
        extras = [image_record(i.file, "webp", i.size[0], i.size[1], i.data, i.pixel_sha) | {
            "mapArtId": i.variant.map_art_id, "phaseId": i.variant.phase_id, "layerIndex": i.layer_index, "partial": i.partial} for i in kept[1:]]
        warnings = sorted({w for i in kept for w in i.warnings})

        def manifest_for(ver: str) -> dict:
            return build_manifest(e, slug_, ver, ident, image_record(primary.file, "webp", primary.size[0], primary.size[1], primary.data, primary.pixel_sha),
                                  pm, extras, reg, any(i.partial for i in kept), warnings)

        # The version is keyed on the COMPLETE asset set (every file's bytes + material manifest content), never on the primary image alone.
        set_sha = asset_set_sha256({i.file: sha256_hex(i.data) for i in kept}, manifest_for("v0"))
        version = ledger.lookup_asset_set(mid, set_sha)
        if version is not None:
            ledger.note_seen(mid, version, build_label)
            _carry_forward(o, ledger, mid, version, dist)
            mf = json.loads((dist / "forever" / str(mid) / version / "manifest.json").read_text(encoding="utf-8"))
            rec["version"], rec["reusedVersion"] = version, True
            rec["image"] = mf["image"]
        else:
            version = ledger.next_version(mid)
            man = manifest_for(version)
            mdir = dist / "forever" / str(mid) / version
            mdir.mkdir(parents=True)
            for i in kept:
                (mdir / i.file).write_bytes(i.data)
            mtext = canonical_json(man)
            (mdir / "manifest.json").write_text(mtext, encoding="utf-8")
            files = {i.file: {"sha256": sha256_hex(i.data), "bytes": len(i.data)} for i in kept}
            files["manifest.json"] = {"sha256": sha256_hex(mtext.encode()), "bytes": len(mtext.encode())}
            ledger.record(mid, version, set_sha, files, build_label, pixelSha256=primary.pixel_sha)
            rec["version"], rec["reusedVersion"] = version, False
            rec["image"] = man["image"]
            if reg:
                rec["referenceComparison"] = reg
        rec["status"] = "exported"
        exported_ids.add(mid)
        produced[mid] = version

    # carry forward every previously recorded version so the dist is a complete snapshot
    for mid_s, versions in sorted(ledger.data["maps"].items(), key=lambda kv: int(kv[0])):
        for ver in sorted(versions):
            _carry_forward(o, ledger, int(mid_s), ver, dist)

    problems = verify_superset(dist, ledger.data) + verify_manifests(dist)
    index = _write_global_files(o, dist, inv, per_map, ident, ledger, exported_ids)
    problems += check_limits(dist)["problems"]
    if problems:
        raise PackageError("; ".join(problems[:8]))
    limits = check_limits(dist)

    (o.out / "ledger.next.json").write_text(ledger.to_text(), encoding="utf-8")
    zip_info = write_deterministic_zip(dist, o.out / f"atlas-dist-{ident.version}.zip")
    (o.out / "dist-files.json").write_text(canonical_json(file_table(dist)), encoding="utf-8")

    from .gallery import write_gallery
    from .report import build_report, write_report
    dupes = [{"pixelSha256": h, "maps": [{"uiMapId": m, "file": f} for m, f in v]} for h, v in sorted(all_pixel.items()) if len({m for m, _ in v}) > 1]
    report = build_report(o, ident, inv, per_map, exported_ids, dupes, sorted(missing_fd), decode_fail, limits, zip_info, ledger, base_ledger_text)
    write_report(o.out / "reports", report)
    write_gallery(o.out / "preview", dist, per_map, ident, thumbs, index)
    return report


def _carry_forward(o: Options, ledger: Ledger, mid: int, ver: str, dist: Path) -> None:
    """Copy a recorded (id, version) into dist from the previous snapshot or legacy assets; bytes must equal the ledger."""
    target = dist / "forever" / str(mid) / ver
    rec = ledger.versions(mid)[ver]
    if target.is_dir() and all((target / n).is_file() for n in rec["files"]):
        return
    for base in [b for b in (o.previous_dist, o.legacy_assets) if b]:
        src = (base / "forever" / str(mid) / ver)
        if src.is_dir() and all((src / n).is_file() and sha256_file(src / n) == m["sha256"] for n, m in rec["files"].items()):
            target.mkdir(parents=True, exist_ok=True)
            for n in rec["files"]:
                shutil.copy2(src / n, target / n)
            return
    raise PackageError(f"published asset forever/{mid}/{ver} is in the ledger but its exact files were not found in --previous-dist/--legacy-assets")


def _write_global_files(o: Options, dist: Path, inv: Inventory, per_map: dict[int, dict], ident: BuildIdentity, ledger: Ledger, exported_ids: set[int]) -> dict:
    atlas = dist / "atlas"
    atlas.mkdir(exist_ok=True)
    (dist / "_headers").write_text(HEADERS, encoding="utf-8")
    on_disk: dict[int, dict[str, dict]] = {}
    for mp in sorted((dist / "forever").glob("*/*/manifest.json")):
        on_disk.setdefault(int(mp.parent.parent.name), {})[mp.parent.name] = json.loads(mp.read_text(encoding="utf-8"))

    def vnum(v: str) -> int:
        return int(v[1:])

    entries = []
    for mid in sorted(set(inv.maps) | set(on_disk)):
        e = inv.maps.get(mid)
        rec = per_map.get(mid)
        versions = sorted(on_disk.get(mid, {}), key=vnum)
        if mid in exported_ids:
            availability = "available"
        elif versions and e is None:
            availability = "published-earlier"
        elif versions:
            availability = "published-earlier"  # present in the CDN from an earlier build; this build did not (re-)export it
        elif rec and rec["status"] == "export-failed":
            availability = "export-failed"
        else:
            availability = "no-artwork"
        ent: dict = {"uiMapId": mid, "availability": availability, "versions": versions}
        latest = on_disk[mid][versions[-1]] if versions else None
        if latest:
            # the legacy POC manifest (1420/v1) predates the atlas fields, hence the defaults
            ent |= {"name": latest["zoneName"], "slug": latest["slug"], "parentUiMapId": latest.get("parentUiMapId"),
                    "type": (latest.get("mapType") or {}).get("name"), "category": latest.get("category"), "system": latest.get("system"),
                    "mapArtId": latest.get("mapArtId"), "mapIds": latest.get("mapIds", []), "floor": latest.get("floor"),
                    "latestVersion": versions[-1], "manifest": f"forever/{mid}/{versions[-1]}/manifest.json",
                    "image": {"path": f"forever/{mid}/{versions[-1]}/{latest['image']['file']}", "width": latest["image"]["width"], "height": latest["image"]["height"],
                              "bytes": latest["image"]["bytes"], "sha256": latest["image"]["sha256"]},
                    "clientBuild": (latest.get("clientBuild") or {}).get("version", "legacy-poc")}
        if e is not None and not latest:
            ent |= {"name": e.name, "slug": slug(e.name, mid), "parentUiMapId": e.parent_id or None, "type": e.type_name, "category": e.category, "system": e.system,
                    "mapIds": sorted(e.map_ids), "floor": e.floor, "reason": (rec or {}).get("reasons")}
        elif e is not None and latest and e.parent_id != (latest.get("parentUiMapId") or 0):
            ent["currentParentUiMapId"] = e.parent_id or None
        entries.append(ent)

    def group(key) -> dict:
        out: dict[str, list[int]] = {}
        for en in entries:
            k = key(en)
            for kk in (k if isinstance(k, list) else [k]):
                if kk is not None:
                    out.setdefault(str(kk), []).append(en["uiMapId"])
        return {k: sorted(v) for k, v in sorted(out.items())}

    by_name: dict[str, list[int]] = {}
    for en in entries:
        if en.get("slug"):
            by_name.setdefault(en["slug"], []).append(en["uiMapId"])
    index = {
        "schemaVersion": 1,
        "currentBuild": ident.to_json(),
        "counts": {"maps": len(entries), **{k: len(v) for k, v in group(lambda x: x["availability"]).items()}},
        "maps": entries,
        "lookup": {
            "byParent": group(lambda x: x.get("parentUiMapId") or 0),
            "byType": group(lambda x: x.get("type")),
            "byCategory": group(lambda x: x.get("category")),
            "byAvailability": group(lambda x: x["availability"]),
            "byBuild": {k: v for k, v in group(lambda x: sorted({(m.get("clientBuild") or {}).get("version", "legacy-poc") for m in on_disk.get(x["uiMapId"], {}).values()})).items()},
            "byName": {k: sorted(v) for k, v in sorted(by_name.items())},
        },
    }
    (atlas / "index.json").write_text(canonical_json(index), encoding="utf-8")

    avail = {en["uiMapId"]: en["availability"] for en in entries}
    nodes = {}
    ch = children_index(inv.maps)
    for mid, e in sorted(inv.maps.items()):
        nodes[str(mid)] = {"name": e.name, "type": e.type_name, "parentUiMapId": e.parent_id if e.parent_id in inv.maps else None,
                           "children": ch.get(mid, []), "availability": avail.get(mid, "no-artwork")}
    h = {"schemaVersion": 1, "build": ident.version, "roots": ch.get(0, []), "nodes": nodes, "issues": inv.hierarchy_issues}
    (atlas / "hierarchy.json").write_text(canonical_json(h), encoding="utf-8")

    prev_builds = []
    if o.previous_dist and (o.previous_dist / "atlas" / "builds.json").is_file():
        prev_builds = json.loads((o.previous_dist / "atlas" / "builds.json").read_text(encoding="utf-8"))["builds"]
    seen = {b["version"] for b in prev_builds}
    sources = {}
    sp = o.bundle / "db2" / "_sources.json"
    if sp.is_file():
        sources = json.loads(sp.read_text(encoding="utf-8")).get("tables", {})
    this = ident.to_json() | {
        "uiMapCount": len(inv.maps), "exportedMaps": len(exported_ids),
        "tool": {"name": "azerdex-map-atlas", "version": TOOL_VERSION, "pillow": PIL.__version__, "libwebp": features.version("webp")},
        "db2": {t: {"sha256": m.get("sha256")} for t, m in sorted(sources.items())},
    }
    builds = [b for b in prev_builds if b["version"] != ident.version] + [this]
    builds.sort(key=lambda b: (b["buildNumber"], b["version"]))
    (atlas / "builds.json").write_text(canonical_json({"schemaVersion": 1, "builds": builds, "latest": builds[-1]["version"]}), encoding="utf-8")
    return index
