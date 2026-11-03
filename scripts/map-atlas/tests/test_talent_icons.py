"""Talent icons in the unified CDN snapshot: baseline + zone heroes + `talent-icons/<build>/<FileDataID>.webp`. Synthetic icons only (the real ones are
Blizzard-owned and never in Git); the committed inventory is additionally checked against the loader."""
import copy
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import common  # noqa: F401
from common import REPO
from PIL import Image
from test_unified import Fixture, sha
from mapatlas import talenticons
from mapatlas.packaging import HEADERS, TALENT_ICON_PATH_RE, UNIFIED_HEADERS, UNIFIED_ICONS_HEADERS, PackageError, check_limits, file_table
from mapatlas.remote import verify_remote
from mapatlas.heroes import HeroLedger
from mapatlas.unified import build_unified, headers_for, parse_headers, verify_unified
from mapatlas.versioning import Ledger

BUILD = "9.9.9.2"
REAL_ICON_INVENTORY = REPO / "web/src/data/talents/forever/1.60.1.70634/icons-inventory.json"


def icon_webp(seed: int, size=(64, 64)) -> bytes:
    im = Image.new("RGB", size, ((seed * 37) % 256, (seed * 91) % 256, (seed * 13) % 256))
    buf = io.BytesIO()
    im.save(buf, "WEBP", lossless=True)
    return buf.getvalue()


def make_icons(root: Path, ids=(111, 222, 135972)) -> tuple[dict, Path]:
    """A staging directory `<root>/talent-icons/<build>/` and the matching inventory."""
    d = root / "talent-icons" / BUILD
    d.mkdir(parents=True)
    files = {}
    for i, fid in enumerate(ids):
        data = icon_webp(i + 1)
        (d / f"{fid}.webp").write_bytes(data)
        files[str(fid)] = {"webpSha256": sha(data), "webpBytes": len(data), "width": 64, "height": 64}
    return {"schema": talenticons.KIND_SCHEMA, "build": BUILD, "files": files}, root


_FX: Fixture | None = None


def fixture() -> Fixture:
    """This module's own synthetic baseline + heroes (cleaned up in tearDownModule)."""
    global _FX
    if _FX is None:
        _FX = Fixture()
    return _FX


class Env:
    def __init__(self):
        fx = fixture()
        self.inv, self.stage = make_icons(fx.root / "stage")
        self.inv_path = fx.root / "icons-inventory.json"
        self.inv_path.write_text(json.dumps(self.inv))
        self.report = build_unified(fx.opts("icons-out", talent_icons_inventory_path=self.inv_path, talent_icons_source_root=self.stage))
        self.dist = fx.root / "icons-out" / "dist"
        self.plain = build_unified(fx.opts("plain-out"))
        self.plain_dist = fx.root / "plain-out" / "dist"


_ENV: Env | None = None


def env() -> Env:
    global _ENV
    if _ENV is None:
        _ENV = Env()
    return _ENV


def tearDownModule():
    if _FX:
        _FX.tmp.cleanup()


class BuildTests(unittest.TestCase):
    def test_snapshot_is_the_complete_previous_snapshot_plus_the_icons(self):
        e = env()
        old, new = file_table(e.plain_dist), file_table(e.dist)
        added = set(new) - set(old)
        self.assertEqual(added, set(talenticons.icon_records(e.inv)))
        self.assertEqual({"talent-icons/9.9.9.2/111.webp", "talent-icons/9.9.9.2/222.webp", "talent-icons/9.9.9.2/135972.webp"}, added)
        # nothing previously published is dropped or changed (Pages replaces the whole snapshot): every file but _headers is byte-identical
        for rel, meta in old.items():
            if rel != "_headers":
                self.assertEqual(meta, new[rel], rel)
        self.assertEqual((e.plain_dist / "_headers").read_text(), UNIFIED_HEADERS)
        self.assertEqual((e.dist / "_headers").read_text(), UNIFIED_ICONS_HEADERS)
        self.assertTrue(UNIFIED_ICONS_HEADERS.startswith(UNIFIED_HEADERS + "\n"))
        self.assertTrue(UNIFIED_HEADERS.startswith(HEADERS))

    def test_icons_are_byte_identical_to_the_staged_files_and_validated(self):
        e = env()
        for fid, rec in e.inv["files"].items():
            data = (e.dist / "talent-icons" / BUILD / f"{fid}.webp").read_bytes()
            self.assertEqual(sha(data), rec["webpSha256"])
            self.assertEqual(data, (e.stage / "talent-icons" / BUILD / f"{fid}.webp").read_bytes())
        self.assertEqual(check_limits(e.dist)["problems"], [])

    def test_report_and_release_record_name_the_icons(self):
        e = env()
        self.assertEqual(e.report["talentIcons"]["files"], 3)
        self.assertEqual(e.report["dist"]["namespaces"]["talent-icons"]["files"], 3)
        self.assertNotIn("talent-icons", e.plain["dist"]["namespaces"])
        rel = json.loads((env_out("icons-out") / "unified-release.json").read_text())
        self.assertEqual(rel["talentIcons"]["build"], BUILD)
        self.assertIn("+talenticons", rel["distLabel"])

    def test_deterministic(self):
        e = env()
        again = build_unified(fixture().opts("icons-out-2", talent_icons_inventory_path=e.inv_path, talent_icons_source_root=e.stage))
        self.assertEqual(again["dist"]["zip"]["sha256"], e.report["dist"]["zip"]["sha256"])

    def test_verify_unified_accepts_the_snapshot_and_catches_every_deviation(self):
        e, fx = env(), fixture()
        pin, inv = fx.pin, fx.inv
        args = (Ledger.load(fx.map_ledger), HeroLedger.load(fx.hero_ledger))
        self.assertEqual(verify_unified(e.dist, pin, inv, *args, icon_inv=e.inv), [])
        # without telling it about the icons, they are unexpected (and the headers are not the reviewed ones)
        self.assertTrue(any("unexpected file talent-icons/" in p for p in verify_unified(e.dist, pin, inv, *args)))
        tmp = Path(tempfile.mkdtemp())
        try:
            d = tmp / "dist"
            shutil.copytree(e.dist, d)
            (d / "talent-icons" / BUILD / "111.webp").write_bytes(icon_webp(99))
            self.assertTrue(any("111.webp: differs from the inventory" in p for p in verify_unified(d, pin, inv, *args, icon_inv=e.inv)))
            shutil.copy(e.dist / "talent-icons" / BUILD / "111.webp", d / "talent-icons" / BUILD / "111.webp")
            (d / "talent-icons" / BUILD / "222.webp").unlink()
            self.assertTrue(any("missing file talent-icons/9.9.9.2/222.webp" in p for p in verify_unified(d, pin, inv, *args, icon_inv=e.inv)))
            shutil.copy(e.dist / "talent-icons" / BUILD / "222.webp", d / "talent-icons" / BUILD / "222.webp")
            (d / "talent-icons" / BUILD / "333.webp").write_bytes(icon_webp(3))
            self.assertTrue(any("unexpected file talent-icons/9.9.9.2/333.webp" in p for p in verify_unified(d, pin, inv, *args, icon_inv=e.inv)))
            (d / "talent-icons" / BUILD / "333.webp").unlink()
            (d / "_headers").write_text(UNIFIED_HEADERS)
            self.assertTrue(any("_headers differs" in p for p in verify_unified(d, pin, inv, *args, icon_inv=e.inv)))
            (d / "_headers").write_text(UNIFIED_ICONS_HEADERS)
            self.assertEqual(verify_unified(d, pin, inv, *args, icon_inv=e.inv), [])  # restored: clean again
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_headers_for_icons(self):
        rules = parse_headers(UNIFIED_ICONS_HEADERS)
        h = headers_for(rules, "talent-icons/9.9.9.2/111.webp")
        self.assertEqual(h["Cache-Control"], "public, max-age=31536000, immutable")
        self.assertEqual(h["X-Content-Type-Options"], "nosniff")
        self.assertNotIn("Content-Type", h)
        self.assertEqual(headers_for(rules, "forever/1/v1/x.webp").get("Cache-Control"), "public, max-age=31536000, immutable")
        self.assertEqual(headers_for(rules, "atlas/index.json")["Cache-Control"], "public, max-age=300, must-revalidate")


def env_out(name: str) -> Path:
    return fixture().root / name


class RefusalTests(unittest.TestCase):
    def build(self, inv_mutator=None, stage_mutator=None):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        inv, stage = make_icons(tmp / "stage")
        if stage_mutator:
            stage_mutator(stage / "talent-icons" / BUILD)
        if inv_mutator:
            inv_mutator(inv)
        p = tmp / "inv.json"
        p.write_text(json.dumps(inv))
        return build_unified(fixture().opts("refuse-" + tmp.name[-6:], talent_icons_inventory_path=p, talent_icons_source_root=stage))

    def test_missing_staged_file(self):
        with self.assertRaisesRegex(PackageError, "staged file missing"):
            self.build(stage_mutator=lambda d: (d / "111.webp").unlink())

    def test_tampered_bytes(self):
        with self.assertRaisesRegex(PackageError, "differs from the inventory"):
            self.build(stage_mutator=lambda d: (d / "111.webp").write_bytes(icon_webp(50)))

    def test_wrong_dimensions_even_when_the_hash_matches(self):
        def swap(inv):
            data = icon_webp(7, (32, 32))
            inv["files"]["111"].update(webpSha256=sha(data), webpBytes=len(data))
        def write(d):
            (d / "111.webp").write_bytes(icon_webp(7, (32, 32)))
        with self.assertRaisesRegex(PackageError, "expected a 64x64 WebP"):
            self.build(inv_mutator=swap, stage_mutator=write)

    def test_not_a_webp(self):
        def swap(inv):
            inv["files"]["111"].update(webpSha256=sha(b"x" * 500), webpBytes=500)
        with self.assertRaisesRegex(PackageError, "not a WebP container"):
            self.build(inv_mutator=swap, stage_mutator=lambda d: (d / "111.webp").write_bytes(b"x" * 500))

    def test_unexpected_extra_file_in_the_staging_directory(self):
        with self.assertRaisesRegex(PackageError, "unexpected entries"):
            self.build(stage_mutator=lambda d: (d / "999.webp").write_bytes(icon_webp(9)))

    def test_inventory_rejects_unsafe_ids_builds_and_sizes(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        good, _ = make_icons(tmp)
        for mutate, text in (
            (lambda i: i["files"].update({"../1": copy.deepcopy(i["files"]["111"])}), "not a FileDataID"),
            (lambda i: i["files"].update({"0": copy.deepcopy(i["files"]["111"])}), "not a FileDataID"),
            (lambda i: i["files"].update({"2147483648": copy.deepcopy(i["files"]["111"])}), "not a FileDataID"),
            (lambda i: i.update(build="../x"), "malformed build"),
            (lambda i: i["files"]["111"].update(webpSha256="zz"), "bad webpSha256"),
            (lambda i: i["files"]["111"].update(webpBytes=10**7), "over the"),
            (lambda i: i["files"]["111"].update(width=65), "dimensions"),
            (lambda i: i.update(schema="other"), "unsupported schema"),
            (lambda i: i.update(files={}), "no files"),
        ):
            inv = copy.deepcopy(good)
            mutate(inv)
            self.assertTrue(any(text in p for p in talenticons.validate_inventory(inv)), text)

    def test_inventory_and_source_must_come_together(self):
        with self.assertRaisesRegex(PackageError, "both the inventory and the staging directory"):
            build_unified(fixture().opts("half", talent_icons_inventory_path=Path("x")))

    def test_path_convention(self):
        for ok in ("talent-icons/1.60.1.70634/135972.webp",):
            self.assertTrue(TALENT_ICON_PATH_RE.match(ok))
        for bad in ("talent-icons/1.60.1.70634/../1.webp", "talent-icons/1.60.1.70634/1.png", "talent-icons/x/1.webp", "talent-icons/1.60.1.70634/0.webp", "talent-icons/1.60.1.70634/a/1.webp"):
            self.assertFalse(TALENT_ICON_PATH_RE.match(bad), bad)


class RemoteTests(unittest.TestCase):
    def opener(self, e, *, content_type="image/webp", fallback=False, cache="public, max-age=31536000, immutable"):
        table = file_table(e.dist)
        def open_fn(url: str):
            rel = url.split("pages.dev/", 1)[1]
            if rel in table and rel != "_headers":
                h = {"cache-control": "public, max-age=300, must-revalidate" if rel.startswith("atlas/") else cache, "access-control-allow-origin": "*",
                     "content-type": content_type if rel.startswith("talent-icons/") else "image/webp", "x-content-type-options": "nosniff", "timing-allow-origin": "*"}
                return 200, h, (e.dist / rel).read_bytes()
            return (200, {"content-type": "text/html"}, b"<html>app</html>") if fallback else (404, {}, b"")
        return open_fn

    def test_remote_verification_covers_the_icons(self):
        e = env()
        r = verify_remote("https://azerdex-assets.pages.dev", e.dist, self.opener(e))
        self.assertEqual(r["problems"], [])
        self.assertTrue(r["ok"])

    def test_wrong_content_type_cache_or_spa_fallback_fail(self):
        e = env()
        self.assertTrue(any("content-type" in p for p in verify_remote("https://azerdex-assets.pages.dev", e.dist, self.opener(e, content_type="application/octet-stream"))["problems"]))
        self.assertTrue(any("cache-control" in p for p in verify_remote("https://azerdex-assets.pages.dev", e.dist, self.opener(e, cache="public, max-age=60"))["problems"]))
        self.assertTrue(any("talent-icons/9.9.9.9/1.webp: returned HTTP 200" in p for p in verify_remote("https://azerdex-assets.pages.dev", e.dist, self.opener(e, fallback=True))["problems"]))


class CommittedInventoryTests(unittest.TestCase):
    def test_the_real_inventory_is_valid(self):
        inv = talenticons.load_inventory(REAL_ICON_INVENTORY)
        self.assertEqual(inv["build"], "1.60.1.70634")
        self.assertEqual(len(inv["files"]), 358)
        self.assertEqual(len(talenticons.icon_records(inv)), 358)
        self.assertEqual(inv["uniqueImages"], 358)


if __name__ == "__main__":
    unittest.main()
