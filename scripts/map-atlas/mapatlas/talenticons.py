"""Talent icons (Class Guides calculator): the `talent-icons/<game build>/<FileDataID>.webp` namespace of the unified CDN snapshot.

Independent of `forever/` (atlas maps) and `zone-heroes/`. The committed inventory (`web/src/data/talents/forever/<build>/icons-inventory.json`) holds only ids,
sizes and SHA-256 hashes: the Blizzard-owned images themselves are never in Git and are read from a local staging directory when a snapshot is built.
A path contains the game build and the FileDataID, so a published file is immutable; another build gets another directory.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
from pathlib import Path

from PIL import Image

from .packaging import TALENT_ICON_PATH_RE

KIND_SCHEMA = "azerdex.talent-icon-inventory/1"
BUILD_RE = re.compile(r"^[1-9]\d{0,3}\.\d{1,4}\.\d{1,4}\.[1-9]\d{0,5}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
ID_RE = re.compile(r"^[1-9]\d{0,9}$")
MAX_FILE_ID = 2**31 - 1
ICON_MAX_BYTES = 256 * 1024  # performance budget per icon (the 358 supplied icons peak at ~11 KB)
ICON_SIZE = (64, 64)


class IconError(ValueError):
    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("; ".join(problems[:6]) + (f"; ... and {len(problems) - 6} more" if len(problems) > 6 else ""))


def inventory_sha256(inv: dict) -> str:
    return hashlib.sha256(json.dumps(inv, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def validate_inventory(inv: dict) -> list[str]:
    p: list[str] = []
    if inv.get("schema") != KIND_SCHEMA:
        return [f"talent icon inventory: unsupported schema {inv.get('schema')!r}"]
    build = inv.get("build")
    if not isinstance(build, str) or not BUILD_RE.match(build):
        return [f"talent icon inventory: malformed build {build!r}"]
    files = inv.get("files")
    if not isinstance(files, dict) or not files:
        return ["talent icon inventory: no files"]
    for fid, rec in files.items():
        if not ID_RE.match(fid) or int(fid) > MAX_FILE_ID:
            p.append(f"inventory id {fid!r} is not a FileDataID")
            continue
        if not isinstance(rec, dict) or not SHA_RE.match(str(rec.get("webpSha256", ""))):
            p.append(f"{fid}: bad webpSha256")
        elif not isinstance(rec.get("webpBytes"), int) or not 0 < rec["webpBytes"] <= ICON_MAX_BYTES:
            p.append(f"{fid}: webpBytes missing or over the {ICON_MAX_BYTES} byte budget")
        elif [rec.get("width"), rec.get("height")] != list(ICON_SIZE):
            p.append(f"{fid}: inventory dimensions are not {ICON_SIZE[0]}x{ICON_SIZE[1]}")
    return p


def load_inventory(path: Path) -> dict:
    inv = json.loads(path.read_text(encoding="utf-8"))
    problems = validate_inventory(inv)
    if problems:
        raise IconError(problems)
    return inv


def dist_path(inv: dict, fid: str) -> str:
    rel = f"talent-icons/{inv['build']}/{fid}.webp"
    if not TALENT_ICON_PATH_RE.match(rel):
        raise IconError([f"{rel}: breaks the talent icon path convention"])
    return rel


def icon_records(inv: dict) -> dict[str, dict]:
    """{dist path: {"sha256", "bytes"}} for every inventoried icon."""
    return {dist_path(inv, fid): {"sha256": r["webpSha256"], "bytes": r["webpBytes"]} for fid, r in sorted(inv["files"].items(), key=lambda kv: int(kv[0]))}


def verify_icon_bytes(rel: str, data: bytes, rec: dict) -> list[str]:
    p: list[str] = []
    if len(data) != rec["bytes"] or hashlib.sha256(data).hexdigest() != rec["sha256"]:
        return [f"{rel}: differs from the inventory (size or SHA-256)"]
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return [f"{rel}: not a WebP container"]
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.load()
            if im.format != "WEBP" or im.size != ICON_SIZE:
                p.append(f"{rel}: {im.format} {im.size}, expected a {ICON_SIZE[0]}x{ICON_SIZE[1]} WebP")
    except Exception as e:  # noqa: BLE001 - any decode failure refuses the icon
        p.append(f"{rel}: does not decode ({e})")
    return p


def load_sources(inv: dict, source_root: Path) -> tuple[dict[str, bytes], list[str]]:
    """{dist path: bytes} for every inventoried icon, read from `<source_root>/talent-icons/<build>/` (the staging directory of the owner's
    converted files), plus all problems. Nothing outside the inventory may be present in that directory."""
    problems = validate_inventory(inv)
    out: dict[str, bytes] = {}
    if problems:
        return out, problems
    d = (source_root / "talent-icons" / inv["build"]).resolve()
    if not d.is_dir():
        return out, [f"icon staging directory {d} does not exist"]
    recs = icon_records(inv)
    for rel, rec in recs.items():
        f = d / rel.rsplit("/", 1)[1]
        if f.is_symlink() or not f.is_file() or f.resolve().parent != d:
            problems.append(f"{rel}: staged file missing under {d}")
            continue
        data = f.read_bytes()
        problems += verify_icon_bytes(rel, data, rec)
        out[rel] = data
    listed = {rel.rsplit("/", 1)[1] for rel in recs}
    unexpected = sorted(p.name for p in d.iterdir() if p.name not in listed)
    if unexpected:
        problems.append(f"unexpected entries in the icon staging directory (not in the inventory): {unexpected[:6]}")
    return out, problems
