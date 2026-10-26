"""Safe reader + strict validator for a ForeverDB.AtlasExporter delivery ZIP (exporter 0.2.x interchange format).

The archive is untrusted input: it is read member-by-member in memory (nothing is extracted to disk), every path is
checked, every image is hash/size/decoded, and every cross-reference between index, manifests, hierarchy and instances is
verified. Only a COMPLETE (not filtered, not partial) export is accepted; all problems are collected before refusing.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import stat
import unicodedata
import zipfile
import zlib
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from PIL import Image

from .identity import BUILD_KEY_RE, DEFAULT_PRODUCT, VERSION_RE

MAX_ENTRIES = 5000
MAX_MEMBER_BYTES = 64 * 1024 * 1024
MAX_JSON_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 1024 * 1024 * 1024
MAX_PIXELS = 64_000_000

PROJECTION = {"type": "normalized-percent", "origin": "top-left", "xDirection": "right", "yDirection": "down", "range": [0, 100],
              "pixelX": "imageWidth * xPercent / 100", "pixelY": "imageHeight * yPercent / 100"}
MAP_STATUS_WITH_ART = {"drawable"}
MAP_STATUS_WITHOUT_ART = {"no-own-art", "inherits-parent"}
VARIANT_OK = {"exported", "reused", "shared-art"}
CATEGORIES = {"world", "continent", "zone", "city", "instance", "special", "other"}
INSTANCE_CLASSES = {"dungeon", "raid", "battleground", "arena", "scenario", "unknown"}
SAFE_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
ALLOWED_TOP = {"atlas", "maps", "diagnostics", "gallery"}


class ImportValidationError(ValueError):
    def __init__(self, problems: list[str]):
        self.problems = problems
        shown = "; ".join(problems[:6]) + (f"; … and {len(problems) - 6} more" if len(problems) > 6 else "")
        super().__init__(f"{len(problems)} import validation problem(s): {shown}")


@dataclass
class SourceImage:
    role: str
    path: str
    width: int
    height: int
    bytes: int
    sha256: str
    format: str
    layer_index: int
    data: bytes = field(repr=False, default=b"")
    tiles_placed: int | None = None
    tiles_expected: int | None = None


@dataclass
class SourceVariant:
    name: str
    kind: str
    art_id: int
    phase_id: int
    primary: bool
    run_status: str
    reveal_status: str | None
    reveal_completeness: str | None
    manifest: dict
    manifest_path: str
    images: list[SourceImage]


@dataclass
class SourceMap:
    entry: dict
    variants: list[SourceVariant]

    @property
    def ui_map_id(self) -> int:
        return self.entry["uiMapId"]


@dataclass
class ExporterSource:
    zip_path: Path
    zip_sha256: str
    zip_bytes: int
    build: dict
    report: dict
    index: dict
    hierarchy: dict
    instances: dict
    maps: list[SourceMap]
    diagnostics: dict
    warnings: list[str]
    stats: dict


def _sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _canon(name: str) -> str:
    return unicodedata.normalize("NFC", name).casefold()


def _check_name(name: str) -> str | None:
    if not name or name.startswith("/") or "\\" in name or "\x00" in name or any(ord(c) < 32 for c in name):
        return "absolute, backslash or control characters"
    parts = name.rstrip("/").split("/")
    if any(p in ("", ".", "..") for p in parts):
        return "empty, '.' or '..' path segment"
    if ":" in parts[0] or re.match(r"^[A-Za-z]:", name):
        return "drive-letter or alternate-stream syntax"
    if any(not SAFE_SEGMENT.match(p) for p in parts):
        return "unsupported characters in a path segment"
    return None


def _read_archive(z: zipfile.ZipFile, problems: list[str], warnings: list[str]) -> tuple[dict[str, zipfile.ZipInfo], str]:
    infos = z.infolist()
    if len(infos) > MAX_ENTRIES:
        problems.append(f"archive has {len(infos)} entries (limit {MAX_ENTRIES})")
        return {}, ""
    files: dict[str, zipfile.ZipInfo] = {}
    seen_canon: dict[str, str] = {}
    total = 0
    for i in infos:
        bad = _check_name(i.filename)
        if bad:
            problems.append(f"unsafe archive path {i.filename[:80]!r}: {bad}")
            continue
        mode = (i.external_attr >> 16) & 0xFFFF
        if mode and stat.S_ISLNK(mode):
            problems.append(f"symbolic link in archive: {i.filename}")
            continue
        if i.flag_bits & 0x1:
            problems.append(f"encrypted entry: {i.filename}")
            continue
        if i.is_dir():
            continue
        key = _canon(i.filename)
        if i.filename in files or key in seen_canon:
            problems.append(f"duplicate or conflicting path: {i.filename} vs {seen_canon.get(key, i.filename)}")
            continue
        seen_canon[key] = i.filename
        if i.file_size > MAX_MEMBER_BYTES:
            problems.append(f"{i.filename}: {i.file_size} bytes exceeds the {MAX_MEMBER_BYTES} byte member limit")
            continue
        if i.file_size > (4 << 20) and i.compress_size and i.file_size / i.compress_size > 200:
            problems.append(f"{i.filename}: implausible compression ratio (decompression bomb?)")
            continue
        total += i.file_size
        files[i.filename] = i
    if total > MAX_TOTAL_BYTES:
        problems.append(f"archive expands to {total} bytes (limit {MAX_TOTAL_BYTES})")
    # a single wrapper folder (the exporter writes ForeverDB-Atlas-Export/…) or files at the top level
    tops = {n.split("/")[0] for n in files}
    prefix = ""
    if "atlas" not in tops and len(tops) == 1 and f"{next(iter(tops))}/atlas/index.json" in files:
        prefix = next(iter(tops)) + "/"
    stripped: dict[str, zipfile.ZipInfo] = {}
    for n, info in files.items():
        rel = n[len(prefix):] if prefix and n.startswith(prefix) else n
        if prefix and not n.startswith(prefix):
            problems.append(f"entry outside the export folder: {n}")
            continue
        stripped[rel] = info
    for n in stripped:
        top = n.split("/")[0]
        if top not in ALLOWED_TOP and n != "README.txt":
            warnings.append(f"ignored unexpected archive entry: {n}")
    return stripped, prefix


def open_source(zip_path: Path, *, product: str = DEFAULT_PRODUCT, expect_version: str | None = None, expect_zip_sha256: str | None = None,
                expect_maps: int | None = None, expect_variants: int | None = None, expect_instances: int | None = None,
                decode_images: bool = True) -> ExporterSource:
    problems: list[str] = []
    warnings: list[str] = []
    zip_sha = _sha256_file(zip_path)
    if expect_zip_sha256 and zip_sha != expect_zip_sha256.lower():
        problems.append(f"source ZIP sha256 {zip_sha} != expected {expect_zip_sha256.lower()}")
    try:
        z = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as e:
        raise ImportValidationError([f"not a valid ZIP archive: {e}"]) from e
    with z:
        try:
            bad = z.testzip()
        except (zipfile.BadZipFile, RuntimeError, EOFError, OSError) as e:
            raise ImportValidationError([f"corrupt ZIP archive: {type(e).__name__}"]) from e
        if bad:
            raise ImportValidationError(problems + [f"corrupt ZIP member (CRC check failed): {bad}"])
        files, _ = _read_archive(z, problems, warnings)
        if problems and not files:
            raise ImportValidationError(problems)

        def read(path: str) -> bytes | None:
            info = files.get(path)
            if info is None:
                return None
            try:
                return z.read(info)
            except (zipfile.BadZipFile, RuntimeError, EOFError, OSError, zlib.error) as e:
                raise ImportValidationError(problems + [f"unreadable archive member {path}: {type(e).__name__}"]) from e

        def load_json(path: str, what: str) -> dict | None:
            info = files.get(path)
            if info is None:
                problems.append(f"missing {what}: {path}")
                return None
            if info.file_size > MAX_JSON_BYTES:
                problems.append(f"{path}: JSON larger than {MAX_JSON_BYTES} bytes")
                return None
            try:
                v = json.loads(read(path).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as e:
                problems.append(f"{path}: invalid JSON ({type(e).__name__})")
                return None
            if not isinstance(v, dict):
                problems.append(f"{path}: expected a JSON object")
                return None
            return v

        build = load_json("atlas/build.json", "build metadata") or {}
        report = load_json("atlas/export-report.json", "export report") or {}
        index = load_json("atlas/index.json", "atlas index") or {}
        hierarchy = load_json("atlas/hierarchy.json", "hierarchy") or {}
        instances = load_json("atlas/instances.json", "instance catalog") or {}
        diagnostics = {}
        for n in ("regression-1420", "missing-maps", "extraction-errors", "run-info"):
            d = load_json(f"diagnostics/{n}.json", f"diagnostic {n}") if f"diagnostics/{n}.json" in files else None
            if d is not None:
                diagnostics[n] = d
        if "diagnostics/export-summary.txt" in files:
            diagnostics["export-summary.txt"] = (read("diagnostics/export-summary.txt") or b"").decode("utf-8", "replace")

        client = _check_build(build, index, report, product, expect_version, problems, warnings)
        maps, stats = _check_index(index, files, read, client, problems, warnings, decode_images)
        _check_report(report, build, index, maps, stats, files, problems, warnings)
        _check_hierarchy(hierarchy, maps, problems)
        _check_instances(instances, maps, problems, warnings)
        if expect_maps is not None and len(maps) != expect_maps:
            problems.append(f"expected {expect_maps} maps, source has {len(maps)}")
        if expect_variants is not None and stats["variants"] != expect_variants:
            problems.append(f"expected {expect_variants} image variants, source has {stats['variants']}")
        if expect_instances is not None and len(instances.get("instances", [])) != expect_instances:
            problems.append(f"expected {expect_instances} instance records, source has {len(instances.get('instances', []))}")
        # every map file must be referenced (no stale/unreferenced art slipping in unnoticed)
        referenced = {im.path for m in maps for v in m.variants for im in v.images} | {v.manifest_path for m in maps for v in m.variants}
        orphans = sorted(n for n in files if n.startswith("maps/") and n not in referenced)
        if orphans:
            problems.append(f"{len(orphans)} file(s) under maps/ not referenced by the index (e.g. {orphans[0]})")
    if problems:
        raise ImportValidationError(problems)
    return ExporterSource(zip_path, zip_sha, zip_path.stat().st_size, build, report, index, hierarchy, instances, maps, diagnostics, warnings, stats)


def _int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _check_build(build: dict, index: dict, report: dict, product: str, expect_version: str | None, problems: list[str], warnings: list[str]) -> dict:
    c = build.get("client") or {}
    if build.get("schemaVersion") != 1:
        problems.append("build.json: unsupported schemaVersion")
    if c.get("product") != product:
        problems.append(f"client product {c.get('product')!r} is not {product!r} (no product substitution)")
    if not VERSION_RE.match(str(c.get("version", ""))):
        problems.append(f"invalid client version {c.get('version')!r}")
    if not BUILD_KEY_RE.match(str(c.get("buildKey", ""))):
        problems.append("invalid client build key")
    if expect_version and c.get("version") != expect_version:
        problems.append(f"client version {c.get('version')} != expected {expect_version}")
    ic = index.get("client") or {}
    for k in ("product", "version", "buildKey"):
        if ic.get(k) != c.get(k):
            problems.append(f"client {k} differs between index.json ({ic.get(k)!r}) and build.json ({c.get(k)!r})")
    if index.get("kind") != "foreverdb-atlas-export-index" or index.get("schemaVersion") != 1:
        problems.append("index.json: unexpected kind/schemaVersion")
    if build.get("allowPartial") is not False:
        problems.append("export was produced with allowPartial: not a complete atlas")
    if build.get("fullReveal") is not True:
        problems.append("export has no full-reveal pass (fullReveal != true): not the full atlas")
    if build.get("calibration") != "provisional":
        problems.append(f"build.json calibration is {build.get('calibration')!r}, expected 'provisional'")
    if build.get("metadataSource") != "client-db2":
        warnings.append(f"metadata source is {build.get('metadataSource')!r}, not the client's own DB2")
    ex = build.get("exporter") or {}
    if not ex.get("version"):
        problems.append("build.json: exporter version missing")
    return c


def _check_report(report: dict, build: dict, index: dict, maps: list[SourceMap], stats: dict, files: dict, problems: list[str], warnings: list[str]) -> None:
    if report.get("status") != "COMPLETE":
        problems.append(f"export status is {report.get('status')!r}; only a full 'COMPLETE' export is accepted (a filtered run reports 'COMPLETE (FILTERED RUN …)')")
    c = report.get("counts") or {}
    if c.get("mapsSkippedByFilter", 0):
        problems.append(f"filtered export: {c['mapsSkippedByFilter']} map(s) skipped by filter")
    for k in ("mapsFailed", "variantsFailed", "mapsPartial"):
        if c.get(k, 0):
            problems.append(f"export report: {k} = {c[k]}")
    rows = (build.get("tableRowCounts") or {}).get("UiMap")
    if not _int(rows):
        problems.append("build.json: tableRowCounts.UiMap missing; cannot prove the export covers every UiMap")
    elif c.get("mapsDiscovered") != rows or len(maps) != rows:
        problems.append(f"UiMap table has {rows} rows but the export lists {len(maps)} maps (report says {c.get('mapsDiscovered')}): filtered or truncated export")
    drawable = sum(1 for m in maps if m.entry["status"] == "drawable")
    if c.get("drawableMaps") != drawable:
        problems.append(f"report drawableMaps {c.get('drawableMaps')} != index {drawable}")
    ic = index.get("counts") or {}
    for k, mine in (("mapsDiscovered", len(maps)), ("drawableMaps", drawable)):
        if ic.get(k) != mine:
            problems.append(f"index counts.{k} {ic.get(k)} != {mine}")
    if c.get("variantsExported") != stats["variants"]:
        problems.append(f"report variantsExported {c.get('variantsExported')} != variants in index {stats['variants']}")
    cdn = (report.get("cloudflarePagesFree") or {}).get("cdnFileCount")
    actual = sum(1 for n in files if n.startswith(("maps/", "atlas/")))
    if _int(cdn) and cdn != actual:
        warnings.append(f"report cdnFileCount {cdn} != files under maps/ + atlas/ ({actual})")


def _check_index(index: dict, files: dict, read, client: dict, problems: list[str], warnings: list[str], decode_images: bool) -> tuple[list[SourceMap], dict]:
    maps: list[SourceMap] = []
    seen_ids: set[int] = set()
    n_images = n_variants = 0
    img_owner: dict[str, str] = {}
    for entry in index.get("maps") or []:
        mid = entry.get("uiMapId")
        if not _int(mid) or mid <= 0 or mid > 999_999:
            problems.append(f"invalid uiMapId {mid!r}")
            continue
        if mid in seen_ids:
            problems.append(f"duplicate uiMapId {mid}")
            continue
        seen_ids.add(mid)
        status = entry.get("status")
        if status not in MAP_STATUS_WITH_ART | MAP_STATUS_WITHOUT_ART:
            problems.append(f"map {mid}: status {status!r} is not an accepted complete-export status")
        if entry.get("category") not in CATEGORIES:
            problems.append(f"map {mid}: unknown category {entry.get('category')!r}")
        for k in ("name", "slug", "classificationConfidence"):
            if not isinstance(entry.get(k), str) or not entry[k]:
                problems.append(f"map {mid}: missing {k}")
        if not _int(entry.get("parentUiMapId")):
            problems.append(f"map {mid}: parentUiMapId missing")
        if not _int(entry.get("internalMapId")):
            problems.append(f"map {mid}: internalMapId missing")
        variants: list[SourceVariant] = []
        raw_variants = entry.get("variants") or []
        if status in MAP_STATUS_WITH_ART and not raw_variants:
            problems.append(f"map {mid}: drawable but has no variants")
        if status in MAP_STATUS_WITHOUT_ART and raw_variants:
            problems.append(f"map {mid}: status {status} but lists variants")
        names_seen: set[str] = set()
        for rv in raw_variants:
            vname = rv.get("variant")
            if not isinstance(vname, str) or not SAFE_NAME.match(vname):
                problems.append(f"map {mid}: unsafe variant name {vname!r}")
                continue
            if vname in names_seen:
                problems.append(f"map {mid}: duplicate variant {vname!r}")
                continue
            names_seen.add(vname)
            n_variants += 1
            rs = rv.get("status")
            if rs not in VARIANT_OK:
                problems.append(f"map {mid}/{vname}: variant status {rs!r} (partial or failed art is not accepted)")
            mpath = rv.get("manifest")
            man = None
            if not isinstance(mpath, str) or mpath not in files:
                problems.append(f"map {mid}/{vname}: manifest {mpath!r} missing from archive")
            else:
                try:
                    man = json.loads((read(mpath) or b"").decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    problems.append(f"{mpath}: invalid JSON")
            images: list[SourceImage] = []
            if not rv.get("images"):
                problems.append(f"map {mid}/{vname}: no images")
            for im in rv.get("images") or []:
                ok = all(isinstance(im.get(k), str) for k in ("role", "path", "sha256", "format")) and all(_int(im.get(k)) for k in ("width", "height", "bytes", "layerIndex"))
                if not ok:
                    problems.append(f"map {mid}/{vname}: malformed image record")
                    continue
                n_images += 1
                path = im["path"]
                if not SHA_RE.match(im["sha256"]):
                    problems.append(f"{path}: malformed sha256")
                if im["format"] != "webp":
                    problems.append(f"{path}: format {im['format']!r} (expected webp)")
                if not SAFE_NAME.match(im["role"]):
                    problems.append(f"{path}: unsafe image role {im['role']!r}")
                if path not in files or not path.startswith(f"maps/{mid}/"):
                    problems.append(f"map {mid}/{vname}: image {path!r} missing from archive or outside maps/{mid}/")
                    continue
                data = read(path) or b""
                if len(data) != im["bytes"]:
                    problems.append(f"{path}: {len(data)} bytes != {im['bytes']}")
                if hashlib.sha256(data).hexdigest() != im["sha256"]:
                    problems.append(f"{path}: sha256 mismatch")
                if path in img_owner and img_owner[path] != f"{mid}/{vname}":
                    problems.append(f"{path}: referenced by both {img_owner[path]} and {mid}/{vname}")
                img_owner[path] = f"{mid}/{vname}"
                if decode_images:
                    try:
                        with Image.open(io.BytesIO(data)) as f:
                            if f.format != "WEBP":
                                problems.append(f"{path}: decodes as {f.format}, not WEBP")
                            elif (f.width, f.height) != (im["width"], im["height"]):
                                problems.append(f"{path}: decoded size {f.size} != {(im['width'], im['height'])}")
                            elif f.width * f.height > MAX_PIXELS or f.width < 1 or f.height < 1:
                                problems.append(f"{path}: implausible dimensions {f.size}")
                            else:
                                f.load()
                    except Exception as e:  # noqa: BLE001 - any decode failure is a corrupt image
                        problems.append(f"{path}: WebP does not decode ({type(e).__name__})")
                images.append(SourceImage(im["role"], path, im["width"], im["height"], im["bytes"], im["sha256"], im["format"], im["layerIndex"], data))
            if man is not None:
                _check_variant_manifest(man, mpath, entry, rv, images, client, problems, warnings)
                for si in images:
                    mi = next((x for x in man.get("images", []) if x.get("role") == si.role and x.get("layerIndex") == si.layer_index), None)
                    if mi:
                        si.tiles_placed, si.tiles_expected = mi.get("tilesPlaced"), mi.get("tilesExpected")
            variants.append(SourceVariant(vname, str(rv.get("kind")), rv.get("uiMapArtId", 0), rv.get("phaseId", 0), bool(rv.get("primary")), str(rs),
                                          rv.get("revealStatus"), rv.get("revealCompleteness"), man or {}, str(mpath), images))
        if raw_variants and "base" not in names_seen:
            problems.append(f"map {mid}: no base variant")
        base_hashes = {i.sha256 for v in variants if v.kind == "base" for i in v.images}
        for v in variants:
            if v.kind == "full-reveal" and any(i.sha256 in base_hashes for i in v.images):
                problems.append(f"map {mid}: full-reveal is byte-identical to a base image (mislabelled or substituted art)")
        maps.append(SourceMap(entry, variants))
    if len(maps) != len(index.get("maps") or []):
        pass  # individual problems already recorded
    return sorted(maps, key=lambda m: m.ui_map_id), {"variants": n_variants, "images": n_images}


def _check_variant_manifest(man: dict, mpath: str, entry: dict, rv: dict, images: list[SourceImage], client: dict, problems: list[str], warnings: list[str]) -> None:
    mid = entry["uiMapId"]
    where = mpath
    if man.get("kind") != "foreverdb-atlas-map-variant" or man.get("schemaVersion") != 1:
        problems.append(f"{where}: unexpected kind/schemaVersion")
    for a, b, label in ((man.get("uiMapId"), mid, "uiMapId"), (man.get("zoneId"), mid, "zoneId"), (man.get("slug"), entry.get("slug"), "slug"),
                        (man.get("zoneName"), entry.get("name"), "name"), (man.get("category"), entry.get("category"), "category"),
                        (man.get("parentUiMapId"), entry.get("parentUiMapId"), "parentUiMapId"), (man.get("variant"), rv.get("variant"), "variant")):
        if a != b:
            problems.append(f"{where}: {label} {a!r} != index {b!r}")
    prov = man.get("provenance") or {}
    if prov.get("clientVersion") != client.get("version") or prov.get("clientBuildKey") != client.get("buildKey") or prov.get("clientProduct") != client.get("product"):
        problems.append(f"{where}: provenance build ({prov.get('clientProduct')}/{prov.get('clientVersion')}/{prov.get('clientBuildKey')}) differs from build.json")
    if prov.get("internalMapId") != entry.get("internalMapId"):
        problems.append(f"{where}: internalMapId {prov.get('internalMapId')!r} != index {entry.get('internalMapId')!r}")
    if prov.get("mapArtId") != rv.get("uiMapArtId"):
        problems.append(f"{where}: mapArtId {prov.get('mapArtId')!r} != index {rv.get('uiMapArtId')!r}")
    if man.get("projection") != PROJECTION:
        problems.append(f"{where}: projection is not the accepted normalized-percent / top-left model")
    if (man.get("calibration") or {}).get("status") != "provisional":
        problems.append(f"{where}: calibration is not 'provisional'")
    if man.get("status") not in VARIANT_OK:
        problems.append(f"{where}: status {man.get('status')!r}")
    if man.get("problems"):
        warnings.append(f"{where}: exporter recorded problems: {man['problems'][:2]}")
    mimgs = man.get("images") or []
    if len(mimgs) != len(images):
        problems.append(f"{where}: lists {len(mimgs)} images, index lists {len(images)}")
    else:
        for mi, si in zip(mimgs, images):
            if (mi.get("sha256"), mi.get("bytes"), mi.get("width"), mi.get("height"), mi.get("role")) != (si.sha256, si.bytes, si.width, si.height, si.role):
                problems.append(f"{where}: image record for role {si.role!r} disagrees with index")
            if mi.get("complete") is not True or mi.get("tilesPlaced") != mi.get("tilesExpected"):
                problems.append(f"{where}: image {si.role!r} is incomplete ({mi.get('tilesPlaced')}/{mi.get('tilesExpected')} tiles)")
    if rv.get("variant") == "full-reveal":
        if rv.get("revealCompleteness") == "partial-overlays" or prov.get("revealCompleteness") == "partial-overlays":
            problems.append(f"{where}: full-reveal has partial overlays (blocking tiles missing)")
        if prov.get("revealCompleteness") != rv.get("revealCompleteness") or prov.get("revealStatus") != rv.get("revealStatus"):
            problems.append(f"{where}: reveal status/completeness differ between manifest and index")
        if not rv.get("revealCompleteness"):
            problems.append(f"{where}: full-reveal without revealCompleteness")


def _check_hierarchy(h: dict, maps: list[SourceMap], problems: list[str]) -> None:
    ids = {m.ui_map_id for m in maps}
    nodes = h.get("nodes") or []
    nid = {n.get("uiMapId") for n in nodes}
    if h.get("schemaVersion") != 1:
        problems.append("hierarchy.json: unsupported schemaVersion")
    if nid != ids:
        problems.append(f"hierarchy.json nodes differ from the index (missing {sorted(ids - nid)[:5]}, extra {sorted(nid - ids)[:5]})")
    if h.get("cycleMembers"):
        problems.append(f"hierarchy.json reports parent cycles: {h['cycleMembers'][:5]}")
    for n in nodes:
        for c in n.get("children") or []:
            if c not in ids:
                problems.append(f"hierarchy node {n.get('uiMapId')}: unknown child {c}")
    parent = {m.ui_map_id: m.entry.get("parentUiMapId") for m in maps}
    for n in nodes:
        p = parent.get(n.get("uiMapId"))
        if p and p in ids and n.get("uiMapId") not in next((x.get("children", []) for x in nodes if x.get("uiMapId") == p), []):
            problems.append(f"hierarchy: {n.get('uiMapId')} is not listed under its parent {p}")


def _check_instances(inst: dict, maps: list[SourceMap], problems: list[str], warnings: list[str]) -> None:
    if inst.get("kind") != "foreverdb-atlas-instances" or inst.get("schemaVersion") != 1:
        problems.append("instances.json: unexpected kind/schemaVersion")
    recs = inst.get("instances")
    if not isinstance(recs, list):
        problems.append("instances.json: instances missing")
        return
    by_id = {m.ui_map_id: m for m in maps}
    seen: set[int] = set()
    cls_count: dict[str, int] = {}
    drawable = 0
    for r in recs:
        mid = r.get("mapId")
        if not _int(mid) or mid in seen:
            problems.append(f"instances.json: invalid or duplicate mapId {mid!r}")
            continue
        seen.add(mid)
        if r.get("classification") not in INSTANCE_CLASSES:
            problems.append(f"instance {mid}: unknown classification {r.get('classification')!r}")
        cls_count[r.get("classification")] = cls_count.get(r.get("classification"), 0) + 1
        if r.get("drawable"):
            drawable += 1
            if not r.get("uiMaps"):
                problems.append(f"instance {mid}: drawable but lists no uiMaps")
        elif not r.get("missingArtworkReason"):
            warnings.append(f"instance {mid}: no artwork and no stated reason")
        for u in r.get("uiMaps") or []:
            m = by_id.get(u.get("uiMapId"))
            if m is None:
                problems.append(f"instance {mid}: uiMap {u.get('uiMapId')} is not in the atlas index")
            elif m.entry.get("internalMapId") != mid:
                problems.append(f"instance {mid}: uiMap {u['uiMapId']} belongs to internal MapID {m.entry.get('internalMapId')} (identifiers conflated)")
    c = inst.get("counts") or {}
    if c.get("records") != len(recs) or c.get("drawable") != drawable:
        problems.append(f"instances.json counts disagree with its records ({c.get('records')}/{c.get('drawable')} vs {len(recs)}/{drawable})")
    if c.get("byClassification") and c["byClassification"] != cls_count:
        problems.append(f"instances.json byClassification {c['byClassification']} != recount {cls_count}")
