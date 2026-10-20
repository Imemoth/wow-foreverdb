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
    bad_paths = [f for f in files if not (ASSET_PATH_RE.match(f) or f.startswith("atlas/") or f == "_headers")]
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


def verify_manifests(root: Path) -> list[str]:
    problems = []
    for mp in sorted((root / "forever").glob("*/*/manifest.json")):
        d = json.loads(mp.read_text(encoding="utf-8"))
        mid, ver = mp.parent.parent.name, mp.parent.name
        if str(d.get("zoneId")) != mid or d.get("version") != ver:
            problems.append(f"{mp.relative_to(root)}: id/version do not match its path")
        if "uiMapId" in d and d["uiMapId"] != d["zoneId"]:
            problems.append(f"{mp.relative_to(root)}: uiMapId != zoneId")
        files = [d["image"]] + list(d.get("variants", []))
        for im in files:
            f = mp.parent / im["file"]
            if not f.is_file():
                problems.append(f"{mp.relative_to(root)}: image {im['file']} missing")
            elif sha256_file(f) != im["sha256"] or f.stat().st_size != im["bytes"]:
                problems.append(f"{mp.relative_to(root)}: hash/size mismatch for {im['file']}")
        if d.get("calibration", {}).get("status") not in ("provisional", "validated"):
            problems.append(f"{mp.relative_to(root)}: bad calibration status")
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
