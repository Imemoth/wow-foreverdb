"""Cinematic zone hero artwork: the auditable inventory (`heroes/zone-heroes.json`), its validation against the real files, and the
append-only hero version ledger.

Namespace `zone-heroes/{uiMapID}/{vN}/{desktop|mobile}-{width}.webp` is independent of `forever/` (atlas maps): versions are keyed by
(uiMapID, vN), immutable once published, and a changed artwork gets the NEXT version. Only watermarked derivatives are ever published:
the private master is never in the repository, and a derivative whose bytes equal the recorded master hash is refused.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import struct
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from .versioning import VERSION_RE

KIND = "azerdex-zone-heroes"
RENDITION_RE = re.compile(r"^(desktop|mobile)-([1-9]\d{2,4})\.webp$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
UI_MAP_ID_RE = re.compile(r"^[1-9]\d{0,5}$")
SOURCE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
FORBIDDEN_NAME_RE = re.compile(r"source|master|original|raw|unwatermarked", re.I)
# A published derivative is a still, metadata-free VP8/VP8L WebP: no EXIF/XMP/ICC, no animation.
ALLOWED_CHUNKS = {"VP8 ", "VP8L", "VP8X", "ALPH"}
HERO_MAX_BYTES = 512 * 1024  # performance budget per rendition (the pilot set peaks at ~113 KB)
WATERMARK_OPACITY = (0.12, 0.18)  # the owner-approved band (docs/azerdex-hero-art/provenance.md)
ASPECT_TOLERANCE_PX = 1
STATUSES_PUBLISHABLE = {"approved"}


class HeroError(ValueError):
    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("; ".join(problems[:6]) + (f"; … and {len(problems) - 6} more" if len(problems) > 6 else ""))


def sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def webp_chunks(data: bytes) -> list[str]:
    """RIFF chunk ids of a WebP file (raises ValueError on a malformed container)."""
    if len(data) < 20 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ValueError("not a RIFF/WebP container")
    if struct.unpack("<I", data[4:8])[0] + 8 != len(data):
        raise ValueError("RIFF size does not match the file size")
    out, o = [], 12
    while o < len(data):
        if o + 8 > len(data):
            raise ValueError("truncated chunk header")
        cid, n = data[o:o + 4].decode("latin-1"), struct.unpack("<I", data[o + 4:o + 8])[0]
        o += 8 + n + (n & 1)
        if o > len(data):
            raise ValueError("chunk overruns the file")
        out.append(cid)
    return out


@dataclass(frozen=True)
class Rendition:
    zone: int
    version: str
    file: str
    role: str
    width: int
    height: int
    bytes: int
    sha256: str
    source: str

    @property
    def dist_path(self) -> str:
        return f"zone-heroes/{self.zone}/{self.version}/{self.file}"


def load_inventory(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def renditions(inv: dict) -> list[Rendition]:
    out = []
    for zid, z in sorted(inv.get("zones", {}).items(), key=lambda kv: int(kv[0])):
        for ver, v in sorted(z.get("versions", {}).items()):
            for r in v.get("renditions", []):
                m = RENDITION_RE.match(r["file"])
                out.append(Rendition(int(zid), ver, r["file"], m.group(1) if m else "", r["width"], r["height"], r["bytes"], r["sha256"], r["source"]))
    return out


def validate_inventory(inv: dict) -> list[str]:
    """Structure and policy only (no file access): ids, versions, names, approval, watermark, provenance, rendition geometry."""
    p: list[str] = []
    if inv.get("schemaVersion") != 1 or inv.get("kind") != KIND or inv.get("namespace") != "zone-heroes":
        return ["inventory: unsupported schemaVersion/kind/namespace"]
    zones = inv.get("zones")
    if not isinstance(zones, dict) or not zones:
        return ["inventory: no zones"]
    seen_sha: dict[str, str] = {}
    for zid, z in zones.items():
        if not UI_MAP_ID_RE.match(zid):
            p.append(f"zone {zid!r}: not a stable UiMapID (1..999999)")
            continue
        if not isinstance(z.get("name"), str) or not z["name"]:
            p.append(f"zone {zid}: name missing")
        versions = z.get("versions")
        if not isinstance(versions, dict) or not versions:
            p.append(f"zone {zid}: no versions")
            continue
        nums = sorted(int(VERSION_RE.match(v).group(1)) for v in versions if VERSION_RE.match(v))
        for ver in versions:
            if not VERSION_RE.match(ver):
                p.append(f"zone {zid}: invalid version name {ver!r}")
        if nums and nums != list(range(1, len(nums) + 1)):
            p.append(f"zone {zid}: versions must be contiguous from v1 (append-only), found {nums}")
        for ver, v in versions.items():
            tag = f"{zid}/{ver}"
            if (v.get("approval") or {}).get("status") not in STATUSES_PUBLISHABLE:
                p.append(f"{tag}: approval.status must be one of {sorted(STATUSES_PUBLISHABLE)} to be packaged")
            if (v.get("approval") or {}).get("legalClearance") not in ("not-cleared", "cleared"):
                p.append(f"{tag}: approval.legalClearance must be recorded explicitly (not-cleared | cleared)")
            for k in ("approvedBy", "date"):
                if not (v.get("approval") or {}).get(k):
                    p.append(f"{tag}: approval.{k} missing")
            w = v.get("watermark") or {}
            if w.get("status") != "embedded" or w.get("appliedBeforeResize") is not True:
                p.append(f"{tag}: watermark must be status=embedded and appliedBeforeResize=true")
            if not (isinstance(w.get("opacity"), (int, float)) and WATERMARK_OPACITY[0] <= w["opacity"] <= WATERMARK_OPACITY[1]):
                p.append(f"{tag}: watermark.opacity outside the approved {WATERMARK_OPACITY} band")
            pr = v.get("provenance") or {}
            if not pr.get("reference") or not pr.get("attestation"):
                p.append(f"{tag}: provenance.reference/attestation missing")
            if not SHA_RE.match(str(pr.get("masterSha256", ""))):
                p.append(f"{tag}: provenance.masterSha256 must be a sha256 (the private master's hash, audit only)")
            if (v.get("privateMaster") or {}).get("inRepository") is not False:
                p.append(f"{tag}: privateMaster.inRepository must be false")
            rs = v.get("renditions")
            if not isinstance(rs, list) or not rs:
                p.append(f"{tag}: no renditions")
                continue
            names: set[str] = set()
            by_role: dict[str, list[dict]] = {"desktop": [], "mobile": []}
            for r in rs:
                m = RENDITION_RE.match(str(r.get("file", "")))
                if not m:
                    p.append(f"{tag}: rendition name {r.get('file')!r} must be desktop-<width>.webp or mobile-<width>.webp")
                    continue
                role, width = m.group(1), int(m.group(2))
                if r["file"] in names:
                    p.append(f"{tag}: duplicate rendition {r['file']}")
                names.add(r["file"])
                if r.get("width") != width:
                    p.append(f"{tag}/{r['file']}: name says width {width}, inventory says {r.get('width')}")
                if not all(isinstance(r.get(k), int) and r[k] > 0 for k in ("width", "height", "bytes")):
                    p.append(f"{tag}/{r['file']}: width/height/bytes must be positive integers")
                    continue
                if r["bytes"] > HERO_MAX_BYTES:
                    p.append(f"{tag}/{r['file']}: {r['bytes']} bytes exceeds the {HERO_MAX_BYTES} byte hero budget")
                if not SHA_RE.match(str(r.get("sha256", ""))):
                    p.append(f"{tag}/{r['file']}: sha256 invalid")
                    continue
                if r["sha256"] == pr.get("masterSha256"):
                    p.append(f"{tag}/{r['file']}: bytes equal the private master (unwatermarked artwork must never be published)")
                src = str(r.get("source", ""))
                if not SOURCE_RE.match(src) or FORBIDDEN_NAME_RE.search(src):
                    p.append(f"{tag}/{r['file']}: source file name {src!r} is not an approved derivative name")
                if r["sha256"] in seen_sha and seen_sha[r["sha256"]] != tag:
                    p.append(f"{tag}/{r['file']}: identical bytes already used by {seen_sha[r['sha256']]}")
                seen_sha[r["sha256"]] = tag
                by_role[role].append(r)
            for role, lst in by_role.items():
                if not lst:
                    p.append(f"{tag}: needs at least one {role} rendition")
                    continue
                ws = [r["width"] for r in lst]
                if len(set(ws)) != len(ws):
                    p.append(f"{tag}: duplicate {role} widths")
                ref = max(lst, key=lambda r: r["width"])
                for r in lst:
                    if abs(round(r["width"] * ref["height"] / ref["width"]) - r["height"]) > ASPECT_TOLERANCE_PX:
                        p.append(f"{tag}/{r['file']}: aspect ratio differs from the {ref['file']} rendition of the same crop")
    return p


def verify_source_file(r: Rendition, data: bytes, inv_version: dict) -> list[str]:
    """One rendition's real bytes against its inventory record (size, sha256, container, decode, dimensions, metadata, animation)."""
    tag = r.dist_path
    p: list[str] = []
    if len(data) != r.bytes:
        p.append(f"{tag}: {len(data)} bytes, inventory says {r.bytes}")
    if sha256_hex(data) != r.sha256:
        p.append(f"{tag}: sha256 differs from the inventory (approved artwork changed in place: publish a new version instead)")
    if sha256_hex(data) == inv_version["provenance"]["masterSha256"]:
        p.append(f"{tag}: equals the private master")
    try:
        chunks = webp_chunks(data)
    except ValueError as e:
        return p + [f"{tag}: {e}"]
    bad = [c.strip() for c in chunks if c not in ALLOWED_CHUNKS]
    if bad:
        p.append(f"{tag}: forbidden WebP chunk(s) {bad} (metadata or animation must not be published)")
    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.format != "WEBP":
                p.append(f"{tag}: decodes as {im.format}, not WEBP")
            if getattr(im, "is_animated", False):
                p.append(f"{tag}: animated WebP")
            if im.size != (r.width, r.height):
                p.append(f"{tag}: decoded size {im.size[0]}x{im.size[1]}, inventory says {r.width}x{r.height}")
            im.load()
    except Exception as e:  # noqa: BLE001 - any decode failure is a refusal
        p.append(f"{tag}: WebP does not decode ({type(e).__name__}: {e})")
    return p


def load_sources(inv: dict, source_root: Path) -> tuple[dict[str, bytes], list[str]]:
    """{dist path: bytes} for every inventoried rendition, read from `source_root` (never the private master), plus all problems."""
    out: dict[str, bytes] = {}
    problems = validate_inventory(inv)
    if problems:
        return out, problems
    root = source_root.resolve()
    listed = {r.source for r in renditions(inv)}
    for r in renditions(inv):
        f = (root / r.source)
        if f.is_symlink() or not f.is_file() or f.resolve().parent != root:
            problems.append(f"{r.dist_path}: source file {r.source} missing under {source_root}")
            continue
        data = f.read_bytes()
        problems += verify_source_file(r, data, inv["zones"][str(r.zone)]["versions"][r.version])
        out[r.dist_path] = data
    unexpected = sorted(p.name for p in root.iterdir() if p.is_file() and p.name not in listed)
    if unexpected:
        problems.append(f"unexpected files in the hero source directory (not in the inventory): {unexpected[:6]}")
    return out, problems


# --- append-only hero ledger ------------------------------------------------------------------------------------------------------

class HeroLedgerError(ValueError):
    pass


class HeroLedger:
    """{"schemaVersion": 1, "zones": {"<uiMapId>": {"<version>": {"files": {name: {"sha256","bytes"}}, "inventorySha256", "firstDist"}}}}"""

    def __init__(self, data: dict):
        self.data = data

    @classmethod
    def load(cls, path: Path) -> "HeroLedger":
        if not path.exists():
            return cls({"schemaVersion": 1, "zones": {}})
        d = json.loads(path.read_text(encoding="utf-8"))
        if d.get("schemaVersion") != 1 or not isinstance(d.get("zones"), dict):
            raise HeroLedgerError("unsupported hero ledger format")
        return cls(d)

    def to_text(self) -> str:
        return json.dumps(self.data, indent=2, sort_keys=True) + "\n"

    def problems_against(self, inv: dict) -> list[str]:
        """Append-only: every published (zone, version) must still be in the inventory with identical files; nothing may change in place."""
        p = []
        for zid, vs in sorted(self.data["zones"].items(), key=lambda kv: int(kv[0])):
            for ver, rec in sorted(vs.items()):
                cur = {r["file"]: r for r in (inv.get("zones", {}).get(zid, {}).get("versions", {}).get(ver, {}).get("renditions", []))}
                if not cur:
                    p.append(f"published hero version {zid}/{ver} is missing from the inventory")
                    continue
                if set(cur) != set(rec["files"]):
                    p.append(f"published hero version {zid}/{ver}: file set changed (published {sorted(rec['files'])}, now {sorted(cur)})")
                for name, meta in rec["files"].items():
                    c = cur.get(name)
                    if c and (c["sha256"] != meta["sha256"] or c["bytes"] != meta["bytes"]):
                        p.append(f"published hero file {zid}/{ver}/{name} changed in place: an artwork change must create a new version")
        return p

    def proposed(self, inv: dict, inventory_sha256: str, dist_label: str) -> "HeroLedger":
        new = json.loads(self.to_text())
        for zid, z in inv["zones"].items():
            for ver, v in z["versions"].items():
                if ver not in new["zones"].get(zid, {}):
                    new["zones"].setdefault(zid, {})[ver] = {
                        "files": {r["file"]: {"sha256": r["sha256"], "bytes": r["bytes"]} for r in v["renditions"]},
                        "inventorySha256": inventory_sha256, "firstDist": dist_label}
        return HeroLedger(new)


def inventory_sha256(inv: dict) -> str:
    return sha256_hex(json.dumps(inv, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
