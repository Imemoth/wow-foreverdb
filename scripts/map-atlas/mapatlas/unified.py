"""Unified CDN distribution (V2-A): the owner-approved atlas distribution (read-only baseline) + versioned cinematic zone heroes.

Cloudflare Pages Direct Upload deploys a COMPLETE snapshot, so a hero-only dist must never be produced: this module only ever emits
baseline ∪ heroes. The baseline (zip or directory) is verified against a committed pin (every path, size and SHA-256) before anything is
written; `atlas/*` and `forever/*` are copied byte-for-byte, `_headers` only gains a `/zone-heroes/*` block, and hero renditions come from
the committed inventory (`heroes/zone-heroes.json`) after size/hash/decode/dimension/metadata checks. Nothing is uploaded.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import stat
import zipfile
from dataclasses import dataclass
from pathlib import Path

from .assetset import asset_set_sha256
from .heroes import HeroLedger, inventory_sha256, load_inventory, load_sources, renditions, validate_inventory
from .packaging import (ASSET_PATH_RE, HEADERS, HERO_PATH_RE, PAGES_MAX_FILES, PAGES_MAX_FILE_BYTES, UNIFIED_HEADERS, PackageError, check_limits,
                        file_table, list_files, sha256_file, verify_catalog, verify_manifests, verify_superset, write_deterministic_zip)
from .versioning import Ledger

PIN_KIND = "azerdex-cdn-baseline"
RELEASE_KIND = "azerdex-cdn-unified-release"
PAGES_MAX_HEADER_RULES = 100
PAGES_MAX_HEADER_LINE = 2000
MAX_BASELINE_ENTRIES = 5000
MAX_BASELINE_TOTAL = 512 * 1024 * 1024
BASELINE_NAME_RE = re.compile(r"^(?:_headers|atlas/[a-z]+\.json|forever/[1-9]\d{0,5}/v[1-9]\d{0,3}/[A-Za-z0-9][A-Za-z0-9._-]*)$")


class BaselineError(ValueError):
    """The baseline cannot be recovered and verified: stop, never guess."""


def canonical_json(o) -> str:
    return json.dumps(o, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


# --- baseline ---------------------------------------------------------------------------------------------------------------------

def read_baseline(path: Path) -> dict[str, bytes]:
    """The baseline's files as {path: bytes}. A zip is read member-by-member in memory (never extracted); a directory is walked without
    following symlinks. Unsafe names, duplicates, case conflicts, symlinks, oversized members and CRC errors refuse the whole baseline."""
    files: dict[str, bytes] = {}
    problems: list[str] = []
    if path.is_dir():
        for f in sorted(path.rglob("*")):
            if f.is_symlink():
                problems.append(f"symlink in baseline: {f.relative_to(path)}")
            elif f.is_file():
                files[f.relative_to(path).as_posix()] = f.read_bytes()
    elif zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            infos = z.infolist()
            if len(infos) > MAX_BASELINE_ENTRIES:
                raise BaselineError(f"baseline has {len(infos)} entries")
            bad_crc = z.testzip()
            if bad_crc:
                raise BaselineError(f"baseline CRC error in {bad_crc}")
            total, lower = 0, set()
            for i in infos:
                if i.is_dir():
                    continue
                n = i.filename
                mode = i.external_attr >> 16
                if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) and not stat.S_ISREG(mode)):  # the deterministic zips carry bare 0644 (no type bits)
                    problems.append(f"{n}: not a regular file")
                if i.flag_bits & 0x1:
                    problems.append(f"{n}: encrypted")
                if n in files or n.lower() in lower:
                    problems.append(f"{n}: duplicate or case-conflicting entry")
                lower.add(n.lower())
                if i.file_size > PAGES_MAX_FILE_BYTES:
                    problems.append(f"{n}: {i.file_size} bytes exceeds the Pages per-file limit")
                    continue
                total += i.file_size
                if total > MAX_BASELINE_TOTAL:
                    raise BaselineError("baseline is implausibly large")
                files[n] = z.read(i)
    else:
        raise BaselineError(f"{path} is neither a zip archive nor a directory")
    for n in files:
        if not BASELINE_NAME_RE.match(n) or ".." in n.split("/"):
            problems.append(f"{n}: path outside the atlas CDN convention")
    if problems:
        raise BaselineError("; ".join(problems[:10]))
    return files


def make_pin(files: dict[str, bytes], dist_zip_sha256: str | None, name: str) -> dict:
    """The committed fingerprint of an approved distribution: every path with size and SHA-256 (no artwork in Git)."""
    idx = json.loads(files["atlas/index.json"])
    versions = sorted({tuple(p.split("/")[1:3]) for p in files if p.startswith("forever/")})
    return {
        "schemaVersion": 1, "kind": PIN_KIND, "name": name,
        "distributionZipSha256": dist_zip_sha256,
        "client": idx["currentBuild"],
        "counts": {"files": len(files), "maps": len({v[0] for v in versions}), "immutableVersions": len(versions),
                   "images": sum(1 for p in files if p.endswith(".webp")), "totalBytes": sum(len(b) for b in files.values())},
        "files": {p: {"sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)} for p, b in sorted(files.items())},
    }


def verify_baseline_against_pin(files: dict[str, bytes], pin: dict, zip_sha256: str | None = None) -> list[str]:
    p: list[str] = []
    if pin.get("kind") != PIN_KIND or pin.get("schemaVersion") != 1:
        return ["baseline pin: unsupported kind/schemaVersion"]
    if zip_sha256 is not None and pin.get("distributionZipSha256") not in (None, zip_sha256):
        p.append(f"baseline archive sha256 {zip_sha256} != pinned {pin['distributionZipSha256']}")
    pinned = pin["files"]
    for n in sorted(set(pinned) - set(files)):
        p.append(f"baseline is missing pinned file {n}")
    for n in sorted(set(files) - set(pinned)):
        p.append(f"baseline has an unpinned file {n}")
    for n in sorted(set(pinned) & set(files)):
        if len(files[n]) != pinned[n]["bytes"] or hashlib.sha256(files[n]).hexdigest() != pinned[n]["sha256"]:
            p.append(f"baseline file {n} differs from its pin")
    if len(files) != pin["counts"]["files"]:
        p.append(f"baseline has {len(files)} files, pin says {pin['counts']['files']}")
    return p


# --- headers ----------------------------------------------------------------------------------------------------------------------

def parse_headers(text: str) -> list[tuple[str, dict[str, str]]]:
    """Cloudflare Pages `_headers`: a path line, then indented `Name: value` lines. Only splat patterns are supported (all this repo uses)."""
    rules: list[tuple[str, dict[str, str]]] = []
    for ln, line in enumerate(text.split("\n"), 1):
        if not line.strip():
            continue
        if len(line) > PAGES_MAX_HEADER_LINE:
            raise PackageError(f"_headers line {ln} exceeds {PAGES_MAX_HEADER_LINE} characters")
        if not line[0].isspace():
            if not line.startswith("/") or line.count("*") > 1:
                raise PackageError(f"_headers line {ln}: unsupported path pattern {line!r}")
            rules.append((line.strip(), {}))
        else:
            if not rules or ":" not in line:
                raise PackageError(f"_headers line {ln}: header without a path or without a colon")
            k, v = line.split(":", 1)
            rules[-1][1][k.strip()] = v.strip()
    return rules


def headers_for(rules: list[tuple[str, dict[str, str]]], path: str) -> dict[str, str]:
    """Headers Pages applies to `/path`: every matching rule contributes; a header named by two rules is joined with a comma."""
    out: dict[str, str] = {}
    for pat, hs in rules:
        if re.fullmatch(re.escape(pat).replace(r"\*", ".*"), "/" + path.lstrip("/")):
            for k, v in hs.items():
                out[k] = f"{out[k]}, {v}" if k in out else v
    return out


EXPECTED_HEADERS = (
    ("forever/", {"Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff"}),
    ("atlas/", {"Cache-Control": "public, max-age=300, must-revalidate", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff"}),
    ("zone-heroes/", {"Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff",
                      "Timing-Allow-Origin": "*"}),
)


def verify_headers(root: Path, files: list[str]) -> list[str]:
    p: list[str] = []
    text = (root / "_headers").read_text(encoding="utf-8")
    if text != UNIFIED_HEADERS:
        p.append("_headers differs from the reviewed unified rules (baseline rules + /zone-heroes/*)")
    if not text.startswith(HEADERS):
        p.append("_headers: the baseline /forever/* and /atlas/* rules are not preserved verbatim")
    try:
        rules = parse_headers(text)
    except PackageError as e:
        return p + [str(e)]
    if len(rules) > PAGES_MAX_HEADER_RULES:
        p.append(f"_headers has {len(rules)} rules; Pages allows {PAGES_MAX_HEADER_RULES}")
    for f in files:
        if f == "_headers":
            continue
        want = next((h for prefix, h in EXPECTED_HEADERS if f.startswith(prefix)), None)
        got = headers_for(rules, f)
        if want is None or any(got.get(k) != v for k, v in want.items()):
            p.append(f"{f}: Pages would serve {got}, expected {want}")
        if "Content-Type" in got:
            p.append(f"{f}: _headers must not override Content-Type (Pages derives it from the extension)")
    return p


# --- unified verification ---------------------------------------------------------------------------------------------------------

def expected_file_set(pin: dict, inv: dict) -> set[str]:
    return set(pin["files"]) | {r.dist_path for r in renditions(inv)}


def verify_unified(root: Path, pin: dict, inv: dict, map_ledger: Ledger | None = None, hero_ledger: HeroLedger | None = None,
                   hero_sources: dict[str, bytes] | None = None) -> list[str]:
    """Everything a unified dist must satisfy. Returns all problems (empty = ready for an approved upload)."""
    p: list[str] = validate_inventory(inv)
    files = list_files(root)
    want = expected_file_set(pin, inv)
    p += [f"unexpected file {f}" for f in sorted(set(files) - want)]
    p += [f"missing file {f}" for f in sorted(want - set(files))]
    table = file_table(root)
    for n, meta in pin["files"].items():  # nothing previously published may change; only _headers is extended
        if n != "_headers" and n in table and table[n] != meta:
            p.append(f"previously published file {n} is not byte-identical to the baseline")
    if (root / "_headers").is_file():
        p += verify_headers(root, files)
    for r in renditions(inv):
        t = table.get(r.dist_path)
        if t and (t["sha256"] != r.sha256 or t["bytes"] != r.bytes):
            p.append(f"{r.dist_path}: differs from the inventory")
        if not HERO_PATH_RE.match(r.dist_path):
            p.append(f"{r.dist_path}: breaks the hero path convention")
    if hero_sources is not None:
        for path, data in hero_sources.items():
            if (root / path).is_file() and (root / path).read_bytes() != data:
                p.append(f"{path}: differs from the verified source bytes")
    # hero art is never mixed into the atlas: no catalog/manifest may reference the namespace
    for f in files:
        if f.endswith(".json") and b"zone-heroes" in (root / f).read_bytes():
            p.append(f"{f}: atlas metadata must not reference zone-heroes")
    p += verify_manifests(root) + verify_catalog(root)
    if map_ledger is not None:
        p += verify_superset(root, map_ledger.data)
    if hero_ledger is not None:
        p += hero_ledger.problems_against(inv)
    lim = check_limits(root)
    p += lim["problems"]
    return p


# --- ledger proposal for the baseline's maps --------------------------------------------------------------------------------------

def propose_map_ledger(base: Ledger, files: dict[str, bytes], pin: dict) -> Ledger:
    """published.json + one record per baseline (uiMapID, version) not yet recorded. Derived from the verified baseline only; existing
    records (e.g. the legacy 1420/v1) are untouched, and the result is a PROPOSAL (never promoted by the build)."""
    new = Ledger(json.loads(base.to_text()))
    build = pin["client"]["version"]
    groups: dict[tuple[int, str], dict[str, bytes]] = {}
    for n, b in files.items():
        if n.startswith("forever/"):
            _, mid, ver, name = n.split("/")
            groups.setdefault((int(mid), ver), {})[name] = b
    for (mid, ver), fs in sorted(groups.items()):
        if ver in new.versions(mid):
            continue
        manifest = json.loads(fs["manifest.json"])
        img = {n: hashlib.sha256(b).hexdigest() for n, b in fs.items() if n != "manifest.json"}
        rec = {n: {"sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)} for n, b in fs.items()}
        new.record(mid, ver, asset_set_sha256(img, manifest), rec, build,
                   origin={"kind": "baseline-distribution", "distributionZipSha256": pin.get("distributionZipSha256")})
    return new


# --- build ------------------------------------------------------------------------------------------------------------------------

@dataclass
class UnifiedOptions:
    baseline: Path
    pin_path: Path
    inventory_path: Path
    hero_source_root: Path
    out: Path
    map_ledger_path: Path
    hero_ledger_path: Path
    expect_baseline_sha256: str | None = None


def build_unified(o: UnifiedOptions) -> dict:
    pin = json.loads(o.pin_path.read_text(encoding="utf-8"))
    zip_sha = sha256_file(o.baseline) if o.baseline.is_file() else None
    files = read_baseline(o.baseline)
    problems = verify_baseline_against_pin(files, pin, zip_sha)
    if o.expect_baseline_sha256 and zip_sha != o.expect_baseline_sha256:
        problems.append(f"baseline archive sha256 {zip_sha} != --expect-baseline-sha256 {o.expect_baseline_sha256}")
    if problems:
        raise BaselineError("baseline cannot be verified, refusing to build (no reconstruction from guesses): " + "; ".join(problems[:8]))

    inv = load_inventory(o.inventory_path)
    hero_files, hp = load_sources(inv, o.hero_source_root)
    if hp:
        raise PackageError("hero artwork refused: " + "; ".join(hp[:8]))
    map_ledger = Ledger.load(o.map_ledger_path)
    hero_ledger = HeroLedger.load(o.hero_ledger_path)

    dist = o.out / "dist"
    if dist.exists():
        shutil.rmtree(dist)
    try:
        if files["_headers"].decode("utf-8") != HEADERS:
            raise PackageError("baseline _headers is not the reviewed atlas rule set; refusing to extend it")
        for n, b in {**{k: v for k, v in files.items() if k != "_headers"}, **hero_files}.items():
            (dist / n).parent.mkdir(parents=True, exist_ok=True)
            (dist / n).write_bytes(b)
        (dist / "_headers").write_text(UNIFIED_HEADERS, encoding="utf-8")
        problems = verify_unified(dist, pin, inv, map_ledger, hero_ledger, hero_files)
        if problems:
            raise PackageError("unified distribution failed validation: " + "; ".join(problems[:8]))
    except Exception:
        shutil.rmtree(dist, ignore_errors=True)  # never leave a half-built snapshot that could be uploaded by mistake
        raise

    table = file_table(dist)
    lim = check_limits(dist)
    rev = hashlib.sha256(json.dumps(table, sort_keys=True).encode()).hexdigest()[:12]
    label = f"{pin['client']['version']}+heroes.{rev}"
    zip_info = write_deterministic_zip(dist, o.out / f"azerdex-cdn-dist-{pin['client']['version']}-{rev}.zip")
    (o.out / "dist-files.json").write_text(canonical_json(table), encoding="utf-8")
    # The commit-able release record of this exact snapshot: what the owner's read-only verification (Verify-AzerdexCdn.ps1, verify-remote) expects to be served.
    (o.out / "unified-release.json").write_text(canonical_json({
        "schemaVersion": 1, "kind": RELEASE_KIND, "distLabel": label, "client": pin["client"], "baselineZipSha256": pin.get("distributionZipSha256"),
        "zip": zip_info, "heroInventorySha256": inventory_sha256(inv), "counts": {"files": len(table), "totalBytes": sum(m["bytes"] for m in table.values())},
        "files": table}), encoding="utf-8")
    (o.out / "SHA256SUMS.txt").write_text("".join(f"{m['sha256']}  {p}\n" for p, m in table.items()), encoding="utf-8")
    inv_sha = inventory_sha256(inv)
    (o.out / "zone-heroes-ledger.next.json").write_text(hero_ledger.proposed(inv, inv_sha, label).to_text(), encoding="utf-8")
    (o.out / "ledger.next.json").write_text(propose_map_ledger(map_ledger, files, pin).to_text(), encoding="utf-8")
    report = build_report(o, pin, inv, inv_sha, table, lim, zip_info, label, zip_sha)
    (o.out / "unified-report.json").write_text(canonical_json(report), encoding="utf-8")
    (o.out / "unified-report.md").write_text(render_report(report), encoding="utf-8")
    (o.out / "zone-heroes-inventory.json").write_text(canonical_json(audit_inventory(inv, table)), encoding="utf-8")
    return report


def audit_inventory(inv: dict, table: dict) -> dict:
    """The review copy of the inventory: every rendition with its published URL path and the hash/size actually found in the dist."""
    out = json.loads(json.dumps(inv))
    for zid, z in out["zones"].items():
        for ver, v in z["versions"].items():
            for r in v["renditions"]:
                t = table[f"zone-heroes/{zid}/{ver}/{r['file']}"]
                r["distPath"] = f"zone-heroes/{zid}/{ver}/{r['file']}"
                r["distSha256"], r["distBytes"] = t["sha256"], t["bytes"]
    return out


def build_report(o: UnifiedOptions, pin: dict, inv: dict, inv_sha: str, table: dict, lim: dict, zip_info: dict, label: str, baseline_zip_sha: str | None) -> dict:
    ns = {"atlas": [], "forever": [], "zone-heroes": [], "_headers": []}
    for p, m in table.items():
        ns[p.split("/", 1)[0]].append(m)
    nsum = {k: {"files": len(v), "bytes": sum(m["bytes"] for m in v)} for k, v in ns.items()}
    largest = sorted(((m["bytes"], p) for p, m in table.items()), reverse=True)[:5]
    return {
        "status": "READY_FOR_APPROVED_UPLOAD", "distLabel": label, "uploaded": False,
        "baseline": {"name": pin["name"], "client": pin["client"], "archiveSha256": baseline_zip_sha, "pinnedArchiveSha256": pin.get("distributionZipSha256"),
                     "files": pin["counts"]["files"], "maps": pin["counts"]["maps"], "immutableVersions": pin["counts"]["immutableVersions"],
                     "verifiedAgainstPin": True, "verifiedAgainstLiveCdn": False},
        "heroes": {"inventorySha256": inv_sha, "renditions": len(renditions(inv)),
                   "zones": {zid: sorted(z["versions"]) for zid, z in inv["zones"].items()}},
        "dist": {"fileCount": lim["fileCount"], "totalBytes": lim["totalBytes"], "largestBytes": lim["largestBytes"], "namespaces": nsum,
                 "zip": zip_info, "limits": {"pagesFreeFiles": PAGES_MAX_FILES, "pagesFileBytes": PAGES_MAX_FILE_BYTES, "headerRules": PAGES_MAX_HEADER_RULES},
                 "fileHeadroom": PAGES_MAX_FILES - lim["fileCount"], "largest": [{"path": p, "bytes": b} for b, p in largest]},
        "checks": ["baseline == pin (172 paths, sizes, SHA-256)", "atlas/ and forever/ byte-identical to the baseline", "_headers = baseline rules + /zone-heroes/*",
                   "exact file set (no unexpected, no missing)", "hero size/SHA-256/decode/dimensions/metadata/animation", "no master bytes",
                   "no zone-heroes reference in atlas metadata", "manifests + catalog resolve", "map and hero ledgers are a subset (append-only)",
                   "Pages limits (files, per-file bytes, header rules)", "per-file response headers"],
    }


def render_report(r: dict) -> str:
    d, b, h = r["dist"], r["baseline"], r["heroes"]
    lines = [f"# Unified CDN distribution — {r['distLabel']}", "",
             f"Status: **{r['status']}** — nothing has been uploaded.", "",
             f"- Baseline: {b['name']} ({b['files']} files, {b['maps']} maps, {b['immutableVersions']} immutable versions), archive sha256 `{b['archiveSha256']}`; pinned `{b['pinnedArchiveSha256']}`.",
             "  Verified against the committed pin; **not** verified against the live CDN (run `verify-remote --dist <baseline>` first, see the deploy guide).",
             f"- Hero inventory sha256 `{h['inventorySha256']}`: {h['renditions']} renditions, zones {h['zones']}.",
             f"- Files: **{d['fileCount']}** (Pages Free limit {d['limits']['pagesFreeFiles']}, headroom {d['fileHeadroom']}); total {d['totalBytes']:,} bytes; largest {d['largestBytes']:,} bytes (limit {d['limits']['pagesFileBytes']:,}).",
             f"- Zip `{d['zip']['file']}`: {d['zip']['bytes']:,} bytes, sha256 `{d['zip']['sha256']}`.", "",
             "| Namespace | Files | Bytes |", "| --- | ---: | ---: |"]
    lines += [f"| `{k}` | {v['files']} | {v['bytes']:,} |" for k, v in d["namespaces"].items()]
    lines += ["", "Checks passed: " + "; ".join(r["checks"]) + ".", ""]
    return "\n".join(lines)
