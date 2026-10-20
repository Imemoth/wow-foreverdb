#!/usr/bin/env python3
"""AzerDex map atlas pipeline CLI. See scripts/map-atlas/README.md and docs/web/map-atlas.md."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from mapatlas.build import DEFAULT_FOREVER_CHECKS, Options, run_build  # noqa: E402
from mapatlas.casc import CtypesCasc, extract_blps  # noqa: E402
from mapatlas.fetch import fetch_tables  # noqa: E402
from mapatlas.exporter_zip import ImportValidationError  # noqa: E402
from mapatlas.identity import DEFAULT_PRODUCT, IdentityError, read_identity  # noqa: E402
from mapatlas.importer import ImportOptions, run_import  # noqa: E402
from mapatlas.inventory import build_inventory  # noqa: E402
from mapatlas.packaging import PackageError, check_limits, verify_manifests, verify_superset  # noqa: E402
from mapatlas.remote import verify_remote  # noqa: E402
from mapatlas.versioning import Ledger  # noqa: E402

REPO = HERE.parent.parent
DEFAULT_LEDGER = HERE / "ledger" / "published.json"


def cmd_identity(a):
    ident = read_identity(Path(a.wow_root), a.product, a.expect_version)
    out = Path(a.bundle)
    out.mkdir(parents=True, exist_ok=True)
    (out / "build.json").write_text(json.dumps(ident.to_json(), indent=2, sort_keys=True) + "\n")
    print(json.dumps(ident.to_json(), indent=2))


def cmd_fetch(a):
    ident = json.loads((Path(a.bundle) / "build.json").read_text())
    src = fetch_tables(ident["version"], Path(a.bundle) / "db2")
    print(f"fetched {len(src)} DB2 exports for client {ident['version']}")


def cmd_extract(a):
    bundle = Path(a.bundle)
    inv = build_inventory(bundle / "db2")
    ids = {fd for e in inv.maps.values() for v in e.variants for l in v.layers for fd in l.tiles.values()}
    dll = Path(a.casclib) if a.casclib else None
    if dll is None:
        for c in (REPO / ".build/CascLib/build/Release/CascLib.dll", Path.home() / ".nuget/packages/casclib.net/1.50.0.206-alpha.3/runtimes/win-x64/native/CascLib.dll"):
            if c.is_file():
                dll = c
                break
    if dll is None:
        sys.exit("CascLib.dll not found: run scripts/build-current-casclib.ps1 or pass --casclib")
    be = CtypesCasc(dll, Path(a.wow_root))
    try:
        s = extract_blps(be, ids, bundle / "blp", a.force)
    finally:
        be.close()
    print(f"requested {s['requested']} · written {s['written']} · already present {s['alreadyPresent']} · missing {len(s['missingFromClient'])} · not BLP {len(s['notBlp'])}")


def cmd_build(a):
    opts = Options(Path(a.bundle), Path(a.out), Path(a.ledger), Path(a.previous_dist) if a.previous_dist else None,
                   Path(a.legacy_assets) if a.legacy_assets else None, Path(a.reference_1420) if a.reference_1420 else None,
                   a.quality, a.allow_partial, Path(a.baseline_db2) if a.baseline_db2 else None, tuple(a.forever_check or DEFAULT_FOREVER_CHECKS), a.expect_version)
    r = run_build(opts)
    x, d = r["extraction"], r["discovery"]
    print(f"client {r['client']['version']} · UiMaps {d['totalUiMapEntries']} · drawable {d['withUsableArtwork']} · exported {x['exportedMaps']} · failed {x['failedMaps']}")
    print(f"dist files {r['package']['limits']['fileCount']} · zip {r['package']['zip']['bytes']} bytes · new versions {r['package']['newVersionsThisRun']}")


def cmd_import(a):
    o = ImportOptions(Path(a.zip), Path(a.out), Path(a.ledger), Path(a.previous_dist) if a.previous_dist else None,
                      Path(a.legacy_assets) if a.legacy_assets else None, Path(a.reference_1420) if a.reference_1420 else None, a.product,
                      a.expect_version, a.expect_zip_sha256, a.expect_maps, a.expect_variants, a.expect_instances)
    r = run_import(o)
    c, pk = r["counts"], r["package"]
    print(f"client {r['source']['client']['version']} · maps {c['maps']} ({c['mapsWithArtwork']} with artwork) · variants {c['variants']} · instances {c['instances']['records']}")
    print(f"dist files {pk['fileCount']} ({pk['imageFiles']} images) · {pk['totalBytes']} bytes · versions {pk['immutableVersions']} (new {len(pk['newVersionsThisRun'])}) · zip {pk['zip']['bytes']} bytes")
    bad = [p for p in r["preflight"] if not p["ok"]]
    print("preflight: " + ("all automated checks passed" if not bad else "FAILED: " + "; ".join(p["check"] for p in bad)))
    if bad:
        sys.exit(1)


def cmd_verify(a):
    root = Path(a.dist)
    ledger = Ledger.load(Path(a.ledger))
    problems = verify_superset(root, ledger.data) + verify_manifests(root) + check_limits(root)["problems"]
    if problems:
        print("\n".join(problems))
        sys.exit(1)
    print(f"dist OK: {check_limits(root)['fileCount']} files")


def cmd_verify_remote(a):
    r = verify_remote(a.base_url, Path(a.dist))
    print(f"checked {r['checked']} files at {r['base']}")
    if not r["ok"]:
        print("\n".join(r["problems"][:50]))
        sys.exit(1)
    print("remote matches the audited distribution")


def cmd_promote(a):
    old, new = Ledger.load(Path(a.to)), Ledger.load(Path(a.src))
    for mid, vs in old.data["maps"].items():
        for ver, rec in vs.items():
            if new.data["maps"].get(mid, {}).get(ver, {}).get("files") != rec["files"]:
                sys.exit(f"refusing: {mid}/{ver} would change or disappear")
    new.save(Path(a.to))
    print(f"ledger updated: {a.to}")


def main(argv=None):
    p = argparse.ArgumentParser(prog="atlas.py")
    sub = p.add_subparsers(required=True, dest="cmd")
    s = sub.add_parser("identity", help="read the installed client build from .build.info")
    s.add_argument("--wow-root", required=True); s.add_argument("--bundle", required=True)
    s.add_argument("--product", default=DEFAULT_PRODUCT); s.add_argument("--expect-version"); s.set_defaults(f=cmd_identity)
    s = sub.add_parser("fetch-db2", help="download exact-build DB2 CSV exports (needs network access to wago.tools)")
    s.add_argument("--bundle", required=True); s.set_defaults(f=cmd_fetch)
    s = sub.add_parser("extract", help="copy needed BLP textures out of the installed client (Windows, CascLib.dll)")
    s.add_argument("--wow-root", required=True); s.add_argument("--bundle", required=True); s.add_argument("--casclib"); s.add_argument("--force", action="store_true"); s.set_defaults(f=cmd_extract)
    s = sub.add_parser("build", help="assemble, validate, version and package the atlas")
    s.add_argument("--bundle", required=True); s.add_argument("--out", required=True); s.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    s.add_argument("--previous-dist"); s.add_argument("--legacy-assets", default=str(REPO / "web/public/maps"))
    s.add_argument("--reference-1420", default=str(REPO / "web/public/maps/forever/1420/v1/tirisfal-glades.webp"))
    s.add_argument("--quality", type=int, default=90); s.add_argument("--allow-partial", action="store_true")
    s.add_argument("--baseline-db2"); s.add_argument("--forever-check", action="append"); s.add_argument("--expect-version"); s.set_defaults(f=cmd_build)
    s = sub.add_parser("import-exporter", help="package a ForeverDB.AtlasExporter delivery ZIP (no DB2/CASC/network needed) as a versioned dist")
    s.add_argument("--zip", required=True); s.add_argument("--out", required=True); s.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    s.add_argument("--previous-dist"); s.add_argument("--legacy-assets", default=str(REPO / "web/public/maps"))
    s.add_argument("--reference-1420", default=str(REPO / "web/public/maps/forever/1420/v1/tirisfal-glades.webp"))
    s.add_argument("--product", default=DEFAULT_PRODUCT); s.add_argument("--expect-version"); s.add_argument("--expect-zip-sha256")
    s.add_argument("--expect-maps", type=int); s.add_argument("--expect-variants", type=int); s.add_argument("--expect-instances", type=int)
    s.set_defaults(f=cmd_import)
    s = sub.add_parser("verify-dist", help="re-check a dist directory against the ledger, manifests and Pages limits")
    s.add_argument("--dist", required=True); s.add_argument("--ledger", default=str(DEFAULT_LEDGER)); s.set_defaults(f=cmd_verify)
    s = sub.add_parser("verify-remote", help="AFTER an approved upload: compare every served file and header with the audited dist (read-only)")
    s.add_argument("--base-url", required=True); s.add_argument("--dist", required=True); s.set_defaults(f=cmd_verify_remote)
    s = sub.add_parser("promote-ledger", help="after the owner has published a build, adopt its ledger (append-only)")
    s.add_argument("--from", dest="src", required=True); s.add_argument("--to", default=str(DEFAULT_LEDGER)); s.set_defaults(f=cmd_promote)
    a = p.parse_args(argv)
    try:
        a.f(a)
    except ImportValidationError as e:
        sys.exit("import refused:\n  - " + "\n  - ".join(e.problems[:40]))
    except (IdentityError, PackageError, OSError, ValueError) as e:
        sys.exit(f"error: {e}")


if __name__ == "__main__":
    main()
