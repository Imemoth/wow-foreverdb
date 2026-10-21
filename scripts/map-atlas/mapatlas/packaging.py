"""dist/ assembly checks, deterministic zip, Cloudflare Pages limits and the append-only (superset) guarantee."""
from __future__ import annotations

import hashlib
import json
import re
import zipfile
from pathlib import Path

from .versioning import VERSION_RE

PAGES_MAX_FILES = 20_000
PAGES_MAX_FILE_BYTES = 25 * 1024 * 1024
ASSET_PATH_RE = re.compile(r"^forever/([1-9]\d{0,5})/(v[1-9]\d{0,3})/([A-Za-z0-9][A-Za-z0-9._-]*)$")

HEADERS = """/forever/*
  Cache-Control: public, max-age=31536000, immutable
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff

/atlas/*
  Cache-Control: public, max-age=300, must-revalidate
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff
"""


class PackageError(ValueError):
    pass


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def list_files(root: Path) -> list[str]:
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())


def file_table(root: Path) -> dict[str, dict]:
    return {rel: {"sha256": sha256_file(root / rel), "bytes": (root / rel).stat().st_size} for rel in list_files(root)}


def check_limits(root: Path) -> dict:
    files = list_files(root)
    over = [f for f in files if (root / f).stat().st_size > PAGES_MAX_FILE_BYTES]
    problems = []
    if len(files) > PAGES_MAX_FILES:
        problems.append(f"{len(files)} files exceeds the {PAGES_MAX_FILES} file limit")
    if over:
        problems.append(f"files over {PAGES_MAX_FILE_BYTES} bytes: {', '.join(over[:5])}")
    bad_paths = [f for f in files if not (ASSET_PATH_RE.match(f) or (f.startswith("atlas/") and f.count("/") == 1) or f == "_headers")]
    if bad_paths:
        problems.append(f"files outside the CDN path convention: {', '.join(bad_paths[:5])}")
    return {"fileCount": len(files), "largestBytes": max(((root / f).stat().st_size for f in files), default=0),
            "totalBytes": sum((root / f).stat().st_size for f in files), "limits": {"files": PAGES_MAX_FILES, "fileBytes": PAGES_MAX_FILE_BYTES},
            "problems": problems}


def verify_superset(root: Path, ledger: dict) -> list[str]:
    """Every file ever recorded in the ledger must still be in dist with identical bytes (Pages Direct Upload is a full snapshot)."""
    problems = []
    for mid, versions in sorted(ledger["maps"].items(), key=lambda kv: int(kv[0])):
        for ver, rec in sorted(versions.items()):
            if not VERSION_RE.match(ver):
                problems.append(f"{mid}/{ver}: invalid version name")
            for name, meta in sorted(rec["files"].items()):
                p = root / "forever" / mid / ver / name
                if not p.is_file():
                    problems.append(f"missing published file forever/{mid}/{ver}/{name}")
                elif sha256_file(p) != meta["sha256"]:
                    problems.append(f"published file changed in place: forever/{mid}/{ver}/{name}")
    return problems


def manifest_image_records(d: dict) -> list[dict]:
    """Every stored-file record a manifest declares, in either layout: the original flat `variants[]` records or the
    atlas-import layout (`variants[].images[]`), plus the top-level display `image`."""
    recs = [d["image"]]
    for v in d.get("variants", []) or []:
        if isinstance(v.get("images"), list):
            recs += v["images"]
        elif "file" in v:
            recs.append(v)
    return recs


def verify_manifests(root: Path) -> list[str]:
    problems = []
    for mp in sorted((root / "forever").glob("*/*/manifest.json")):
        d = json.loads(mp.read_text(encoding="utf-8"))
        mid, ver = mp.parent.parent.name, mp.parent.name
        rel = mp.relative_to(root)
        if str(d.get("zoneId")) != mid or d.get("version") != ver:
            problems.append(f"{rel}: id/version do not match its path")
        if "uiMapId" in d and d["uiMapId"] != d["zoneId"]:
            problems.append(f"{rel}: uiMapId != zoneId")
        for im in manifest_image_records(d):
            f = mp.parent / im["file"]
            if not ASSET_PATH_RE.match(f"forever/{mid}/{ver}/{im['file']}"):
                problems.append(f"{rel}: image name {im['file']!r} breaks the CDN path convention")
            elif not f.is_file():
                problems.append(f"{rel}: image {im['file']} missing")
            elif sha256_file(f) != im["sha256"] or f.stat().st_size != im["bytes"]:
                problems.append(f"{rel}: hash/size mismatch for {im['file']}")
        if d.get("calibration", {}).get("status") not in ("provisional", "validated"):
            problems.append(f"{rel}: bad calibration status")
    return problems


ATLAS_FILES = {"index.json", "hierarchy.json", "builds.json", "instances.json"}


def verify_catalog(root: Path) -> list[str]:
    """The global catalog must resolve completely: every entry's manifest and image paths exist with the recorded hash, nothing
    private (source diagnostics, local paths) is published, and only the documented atlas files exist."""
    problems = []
    extra = [f for f in list_files(root) if f.startswith("atlas/") and f.split("/", 1)[1] not in ATLAS_FILES]
    if extra:
        problems.append(f"unexpected files under atlas/: {extra[:5]}")
    idx_path = root / "atlas/index.json"
    if not idx_path.is_file():
        return problems + ["atlas/index.json missing"]
    idx = json.loads(idx_path.read_text(encoding="utf-8"))
    ids = set()
    for e in idx["maps"]:
        ids.add(e["uiMapId"])
        for ver in e.get("versions", []):
            if not (root / "forever" / str(e["uiMapId"]) / ver / "manifest.json").is_file():
                problems.append(f"index: {e['uiMapId']}/{ver} manifest missing")
        if e.get("manifest") and not (root / e["manifest"]).is_file():
            problems.append(f"index: {e['uiMapId']} latest manifest {e['manifest']} missing")
        img = e.get("image")
        if img and (not (root / img["path"]).is_file() or sha256_file(root / img["path"]) != img["sha256"]):
            problems.append(f"index: {e['uiMapId']} image {img['path']} missing or hash mismatch")
        for v in e.get("variants", []) or []:
            if not (root / v["path"]).is_file() or sha256_file(root / v["path"]) != v["sha256"]:
                problems.append(f"index: {e['uiMapId']} variant {v.get('variant')} file {v['path']} missing or hash mismatch")
    on_disk = {int(p.name) for p in (root / "forever").glob("*") if p.is_dir()}
    if on_disk - ids:
        problems.append(f"forever/ has maps that are not in the index: {sorted(on_disk - ids)[:5]}")
    leaks = re.compile(r"[A-Za-z]:\\\\|/home/|/Users/|/tmp/")  # JSON text escapes a Windows path as C:\\Users
    for rel in list_files(root):
        if rel.endswith(".json") and leaks.search((root / rel).read_text(encoding="utf-8")):
            problems.append(f"{rel}: looks like it contains a local filesystem path")
    return problems


def write_deterministic_zip(root: Path, zip_path: Path) -> dict:
    """Sorted entries, fixed timestamps and permissions: the same tree always yields the same zip bytes."""
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in list_files(root):
            zi = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            zi.create_system = 3
            z.writestr(zi, (root / rel).read_bytes(), compresslevel=9)
    return {"file": zip_path.name, "bytes": zip_path.stat().st_size, "sha256": sha256_file(zip_path)}
