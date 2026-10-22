"""Unified CDN distribution (V2-A): baseline atlas dist + versioned cinematic zone heroes. Synthetic baseline and heroes (no private artwork);
the committed pin/inventory are additionally checked against the REAL committed hero files (public, watermarked derivatives in the repo)."""
import copy
import hashlib
import io
import json
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path

import common  # noqa: F401
from common import REPO, ROOT
from PIL import Image
from synth_export import make_export, write_zip
from mapatlas.heroes import (HERO_MAX_BYTES, HeroLedger, Rendition, inventory_sha256, load_inventory, load_sources, renditions, validate_inventory,
                             verify_source_file, webp_chunks)
from mapatlas.importer import ImportOptions, run_import
from mapatlas.packaging import HEADERS, HERO_PATH_RE, UNIFIED_HEADERS, PackageError, check_limits, file_table, write_deterministic_zip
from mapatlas.remote import verify_remote
from mapatlas.unified import (BaselineError, UnifiedOptions, build_unified, headers_for, make_pin, parse_headers, propose_map_ledger, read_baseline,
                              verify_baseline_against_pin, verify_headers, verify_unified)
from mapatlas.versioning import Ledger

LEGACY = REPO / "web/public/maps"
REAL_LEDGER = ROOT / "ledger/published.json"
REF = LEGACY / "forever/1420/v1/tirisfal-glades.webp"
REAL_PIN = ROOT / "baseline/atlas-dist-1.60.1.70450.json"
REAL_INVENTORY = ROOT / "heroes/zone-heroes.json"
REAL_HERO_SOURCES = REPO / "web/public/zones/hero"


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def hero_webp(w: int, h: int, seed: int, **save) -> bytes:
    im = Image.new("RGB", (w, h))
    px = im.load()
    for x in range(w):
        for y in range(h):
            px[x, y] = ((x * 255 // w + seed * 31) % 256, (y * 255 // h + seed * 7) % 256, (seed * 53 + x // 3) % 256)
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=70, **save)
    return buf.getvalue()


def make_inventory(src: Path) -> dict:
    """Two synthetic zones (ids 1424/1431) with 4 renditions each; files written to `src` under legacy-style source names."""
    zones = {}
    seed = 0
    for zid, name, dims in (("1424", "hillsbrad", ((640, 214), (1000, 334), (300, 162), (450, 243))), ("1431", "duskwood", ((640, 274), (958, 410), (300, 258), (450, 387)))):
        rs = []
        for (w, h), role in zip(dims, ("desktop", "desktop", "mobile", "mobile")):
            seed += 1
            data = hero_webp(w, h, seed)
            fn = f"{zid}-{name}-{role}-{w}.webp"
            (src / fn).write_bytes(data)
            rs.append({"file": f"{role}-{w}.webp", "width": w, "height": h, "bytes": len(data), "sha256": sha(data), "source": fn})
        zones[zid] = {"name": name, "versions": {"v1": {
            "approval": {"status": "approved", "approvedBy": "owner", "date": "2026-10-22", "legalClearance": "not-cleared"},
            "watermark": {"status": "embedded", "appliedBeforeResize": True, "emblem": "web/public/icon.svg", "tint": "#e8cf8f", "opacity": 0.17},
            "provenance": {"reference": "docs/azerdex-hero-art/provenance.md", "masterSha256": sha(f"master-{zid}".encode()), "masterDimensions": "x", "attestation": "owner"},
            "privateMaster": {"inRepository": False}, "renditions": rs}}}
    return {"schemaVersion": 1, "kind": "azerdex-zone-heroes", "namespace": "zone-heroes", "zones": zones}


class Fixture:
    """One synthetic baseline (an importer-built dist, zipped deterministically) + pin + hero sources, shared by the read-only tests."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        led = self.root / "ledger.json"
        shutil.copy(REAL_LEDGER, led)
        zp = write_zip(make_export(), self.root / "src.zip")
        run_import(ImportOptions(zp, self.root / "imp", led, None, LEGACY, REF))
        self.base_dist = self.root / "imp/dist"
        self.baseline_zip = self.root / "atlas-dist.zip"
        write_deterministic_zip(self.base_dist, self.baseline_zip)
        self.files = read_baseline(self.baseline_zip)
        self.pin = make_pin(self.files, sha(self.baseline_zip.read_bytes()), "synthetic")
        self.pin_path = self.root / "pin.json"
        self.pin_path.write_text(json.dumps(self.pin))
        self.src = self.root / "heroes-src"
        self.src.mkdir()
        self.inv = make_inventory(self.src)
        self.inv_path = self.root / "inv.json"
        self.inv_path.write_text(json.dumps(self.inv))
        self.map_ledger = self.root / "map-ledger.json"
        shutil.copy(REAL_LEDGER, self.map_ledger)
        self.hero_ledger = self.root / "hero-ledger.json"  # absent: nothing published yet

    def opts(self, out: str, **kw) -> UnifiedOptions:
        d = dict(baseline=self.baseline_zip, pin_path=self.pin_path, inventory_path=self.inv_path, hero_source_root=self.src, out=self.root / out,
                 map_ledger_path=self.map_ledger, hero_ledger_path=self.hero_ledger)
        d.update(kw)
        return UnifiedOptions(**d)


_FIX: Fixture | None = None


def fixture() -> Fixture:
    global _FIX
    if _FIX is None:
        _FIX = Fixture()
    return _FIX


def tearDownModule():
    if _FIX:
        _FIX.tmp.cleanup()


class BuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.f = fixture()
        cls.report = build_unified(cls.f.opts("u1"))
        cls.out = cls.f.root / "u1"
        cls.dist = cls.out / "dist"

    def test_dist_is_exactly_baseline_plus_the_eight_hero_files_and_atlas_is_byte_identical(self):
        got = file_table(self.dist)
        want = {p: m for p, m in self.f.pin["files"].items() if p != "_headers"}
        heroes = {p for p in got if p.startswith("zone-heroes/")}
        self.assertEqual(len(heroes), 8)
        self.assertTrue(all(HERO_PATH_RE.match(p) for p in heroes))
        for p, m in want.items():
            self.assertEqual(got[p], m, p)  # every baseline file, byte for byte
        self.assertEqual(set(got), set(want) | heroes | {"_headers"})
        self.assertEqual(self.report["dist"]["fileCount"], len(self.f.pin["files"]) + 8)
        self.assertEqual(self.report["status"], "READY_FOR_APPROVED_UPLOAD")
        self.assertFalse(self.report["uploaded"])

    def test_headers_keep_the_atlas_rules_verbatim_and_add_the_hero_rule(self):
        text = (self.dist / "_headers").read_text()
        self.assertEqual(text, UNIFIED_HEADERS)
        self.assertTrue(text.startswith(HEADERS))
        self.assertEqual(self.f.files["_headers"].decode(), HEADERS)
        rules = parse_headers(text)
        hero = headers_for(rules, "zone-heroes/1424/v1/desktop-640.webp")
        self.assertEqual(hero["Cache-Control"], "public, max-age=31536000, immutable")
        self.assertEqual(hero["Access-Control-Allow-Origin"], "*")
        self.assertEqual(hero["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers_for(rules, "forever/1420/v1/base.webp")["Cache-Control"], "public, max-age=31536000, immutable")
        self.assertEqual(headers_for(rules, "atlas/index.json")["Cache-Control"], "public, max-age=300, must-revalidate")
        self.assertNotIn("Cache-Control", headers_for(rules, "somewhere/else.webp"))  # rules never leak outside their prefix

    def test_hero_versions_are_independent_of_atlas_manifests(self):
        for p in self.dist.rglob("*.json"):
            self.assertNotIn("zone-heroes", p.read_text())
        self.assertFalse(list((self.dist / "forever").rglob("desktop-*")))

    def test_deterministic_zip_and_reports(self):
        again = build_unified(self.f.opts("u2"))
        self.assertEqual(again["dist"]["zip"], self.report["dist"]["zip"])
        for name in ("SHA256SUMS.txt", "dist-files.json", "zone-heroes-ledger.next.json", "ledger.next.json", "unified-report.json", "unified-report.md", "zone-heroes-inventory.json"):
            self.assertEqual((self.out / name).read_bytes(), (self.f.root / "u2" / name).read_bytes(), name)
        z = next(self.out.glob("azerdex-cdn-dist-*.zip"))
        with zipfile.ZipFile(z) as zf:
            self.assertEqual(sorted(zf.namelist()), sorted(file_table(self.dist)))

    def test_inventory_audit_copy_records_sha_and_size_found_in_the_dist(self):
        audit = json.loads((self.out / "zone-heroes-inventory.json").read_text())
        for zid, z in audit["zones"].items():
            for ver, v in z["versions"].items():
                for r in v["renditions"]:
                    data = (self.dist / r["distPath"]).read_bytes()
                    self.assertEqual((r["distSha256"], r["distBytes"]), (sha(data), len(data)))
                    self.assertEqual(r["sha256"], r["distSha256"])

    def test_pages_limits_and_proposals(self):
        lim = check_limits(self.dist)
        self.assertEqual(lim["problems"], [])
        ml = Ledger.load(self.out / "ledger.next.json")
        self.assertEqual(ml.versions(1420)["v1"], Ledger.load(REAL_LEDGER).versions(1420)["v1"])  # existing record untouched
        self.assertEqual(verify_unified(self.dist, self.f.pin, self.f.inv, ml, HeroLedger.load(self.out / "zone-heroes-ledger.next.json")), [])
        hl = json.loads((self.out / "zone-heroes-ledger.next.json").read_text())
        self.assertEqual(sorted(hl["zones"]), ["1424", "1431"])
        self.assertFalse((self.f.root / "hero-ledger.json").exists())  # proposal only: never promoted by the build


class BaselineBlockerTests(unittest.TestCase):
    """If the approved baseline cannot be recovered and verified the build stops: no reconstruction, no hero-only snapshot."""

    def setUp(self):
        self.f = fixture()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)

    def mutated(self, fn):
        files = dict(self.f.files)
        fn(files)
        zp = self.work / "b.zip"
        with zipfile.ZipFile(zp, "w") as z:
            for n, b in files.items():
                zi = zipfile.ZipInfo(n, date_time=(1980, 1, 1, 0, 0, 0))
                z.writestr(zi, b)
        return zp

    def build(self, zp, **kw):
        return build_unified(self.f.opts("blk", baseline=zp, **kw))

    def test_missing_baseline_file_is_a_blocker(self):
        victim = next(p for p in self.f.files if p.startswith("forever/") and p.endswith(".webp"))
        with self.assertRaisesRegex(BaselineError, "missing pinned file"):
            self.build(self.mutated(lambda fs: fs.pop(victim)))
        self.assertFalse((self.f.root / "blk/dist").exists())

    def test_changed_baseline_bytes_extra_file_and_wrong_archive_are_blockers(self):
        victim = next(p for p in self.f.files if p.startswith("forever/") and p.endswith(".webp"))
        with self.assertRaisesRegex(BaselineError, "differs from its pin"):
            self.build(self.mutated(lambda fs: fs.__setitem__(victim, fs[victim] + b"x")))
        with self.assertRaisesRegex(BaselineError, "unpinned file"):
            self.build(self.mutated(lambda fs: fs.__setitem__("atlas/extra.json", b"{}")))
        with self.assertRaisesRegex(BaselineError, "--expect-baseline-sha256"):
            self.build(self.f.baseline_zip, expect_baseline_sha256="0" * 64)
        with self.assertRaisesRegex(BaselineError, "archive sha256"):
            pin = dict(self.f.pin, distributionZipSha256="1" * 64)
            self.assertTrue(verify_baseline_against_pin(self.f.files, pin, "2" * 64))
            p2 = self.work / "pin2.json"
            p2.write_text(json.dumps(pin))
            self.build(self.f.baseline_zip, pin_path=p2)

    def test_unsafe_archives_are_refused(self):
        for bad in ("../evil.json", "/abs/_headers", "forever/1/v1/../../x.webp", "forever\\1\\v1\\a.webp", "index.html", "zone-heroes/1424/v1/desktop-640.webp"):
            with self.assertRaises(BaselineError, msg=bad):
                read_baseline(self.mutated(lambda fs, b=bad: fs.__setitem__(b, b"x")))
        zp = self.work / "dup.zip"
        with zipfile.ZipFile(zp, "w") as z:
            z.writestr("_headers", b"a")
            z.writestr("_HEADERS", b"b")
        with self.assertRaisesRegex(BaselineError, "case-conflicting"):
            read_baseline(zp)
        zp = self.work / "link.zip"
        with zipfile.ZipFile(zp, "w") as z:
            zi = zipfile.ZipInfo("_headers")
            zi.external_attr = 0o120777 << 16
            z.writestr(zi, b"/etc/passwd")
        with self.assertRaisesRegex(BaselineError, "not a regular file"):
            read_baseline(zp)
        with self.assertRaises(BaselineError):
            read_baseline(self.work / "nope")

    def test_changed_atlas_header_rules_are_refused(self):
        files = dict(self.f.files)
        files["_headers"] = b"/forever/*\n  Cache-Control: no-store\n"
        pin = make_pin(files, None, "x")
        p = self.work / "p.json"
        p.write_text(json.dumps(pin))
        zp = self.work / "h.zip"
        with zipfile.ZipFile(zp, "w") as z:
            for n, b in files.items():
                z.writestr(zipfile.ZipInfo(n, date_time=(1980, 1, 1, 0, 0, 0)), b)
        with self.assertRaisesRegex(PackageError, "baseline _headers"):
            self.build(zp, pin_path=p)


class InventoryValidationTests(unittest.TestCase):
    def setUp(self):
        self.inv = copy.deepcopy(fixture().inv)

    def v(self, zid="1424"):
        return self.inv["zones"][zid]["versions"]["v1"]

    def problems(self):
        return validate_inventory(self.inv)

    def test_clean_inventory_has_no_problems(self):
        self.assertEqual(self.problems(), [])

    def test_policy_violations_are_each_reported(self):
        cases = {
            "approval.status": lambda: self.v()["approval"].__setitem__("status", "draft"),
            "legalClearance": lambda: self.v()["approval"].pop("legalClearance"),
            "watermark must be": lambda: self.v()["watermark"].__setitem__("status", "none"),
            "appliedBeforeResize": lambda: self.v()["watermark"].__setitem__("appliedBeforeResize", False),
            "opacity": lambda: self.v()["watermark"].__setitem__("opacity", 0.5),
            "masterSha256": lambda: self.v()["provenance"].__setitem__("masterSha256", "nope"),
            "privateMaster.inRepository": lambda: self.v()["privateMaster"].__setitem__("inRepository", True),
            "stable UiMapID": lambda: self.inv["zones"].__setitem__("1424a", self.inv["zones"].pop("1424")),
            "must be desktop-<width>": lambda: self.v()["renditions"][0].__setitem__("file", "hero-640.webp"),
            "name says width": lambda: self.v()["renditions"][0].__setitem__("width", 641),
            "hero budget": lambda: self.v()["renditions"][0].__setitem__("bytes", HERO_MAX_BYTES + 1),
            "equal the private master": lambda: self.v()["renditions"][0].__setitem__("sha256", self.v()["provenance"]["masterSha256"]),
            "approved derivative name": lambda: self.v()["renditions"][0].__setitem__("source", "1424-master.webp"),
            "approved derivative name ": lambda: self.v()["renditions"][0].__setitem__("source", "../x.webp"),
            "aspect ratio": lambda: self.v()["renditions"][0].__setitem__("height", 300),
            "at least one mobile": lambda: self.v().__setitem__("renditions", [r for r in self.v()["renditions"] if r["file"].startswith("desktop")]),
            "contiguous": lambda: self.inv["zones"]["1424"]["versions"].__setitem__("v3", copy.deepcopy(self.v())),
            "identical bytes already used": lambda: self.v("1431")["renditions"][0].__setitem__("sha256", self.v("1424")["renditions"][0]["sha256"]),
            "provenance.reference": lambda: self.v()["provenance"].pop("reference"),
        }
        for needle, mutate in cases.items():
            self.setUp()
            mutate()
            self.assertTrue(any(needle.strip() in p for p in self.problems()), f"{needle!r} not reported: {self.problems()}")

    def test_unsupported_document_is_refused(self):
        self.assertTrue(validate_inventory({"schemaVersion": 2}))
        self.assertTrue(validate_inventory({"schemaVersion": 1, "kind": "azerdex-zone-heroes", "namespace": "zone-heroes", "zones": {}}))


class SourceFileTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture()
        self.inv = self.f.inv
        self.r = renditions(self.inv)[0]
        self.v = self.inv["zones"][str(self.r.zone)]["versions"]["v1"]
        self.data = (self.f.src / self.r.source).read_bytes()

    def test_good_file_passes(self):
        self.assertEqual(verify_source_file(self.r, self.data, self.v), [])
        self.assertEqual(webp_chunks(self.data), ["VP8 "])

    def test_every_defect_class_is_caught(self):
        def probs(data, r=None):
            return " | ".join(verify_source_file(r or self.r, data, self.v))
        flipped = bytearray(self.data)
        flipped[len(flipped) // 2] ^= 0xFF
        self.assertIn("sha256 differs", probs(bytes(flipped)))
        self.assertIn("bytes, inventory says", probs(self.data + b"\x00\x00"))
        wrong_dims = Rendition(self.r.zone, self.r.version, self.r.file, self.r.role, self.r.width + 1, self.r.height, self.r.bytes, self.r.sha256, self.r.source)
        self.assertIn("decoded size", probs(self.data, wrong_dims))
        png = io.BytesIO()
        Image.new("RGB", (8, 8)).save(png, "PNG")
        r_png = Rendition(1424, "v1", "desktop-640.webp", "desktop", 8, 8, len(png.getvalue()), sha(png.getvalue()), "x.webp")
        self.assertIn("RIFF/WebP", probs(png.getvalue(), r_png))
        exif = hero_webp(64, 32, 9, exif=b"Exif\x00\x00II*\x00\x08\x00\x00\x00\x00\x00")
        r_exif = Rendition(1424, "v1", "desktop-640.webp", "desktop", 64, 32, len(exif), sha(exif), "x.webp")
        self.assertIn("forbidden WebP chunk", probs(exif, r_exif))
        frames = [Image.new("RGB", (16, 16), c) for c in ("red", "blue")]
        anim = io.BytesIO()
        frames[0].save(anim, "WEBP", save_all=True, append_images=frames[1:], duration=100)
        r_an = Rendition(1424, "v1", "desktop-640.webp", "desktop", 16, 16, len(anim.getvalue()), sha(anim.getvalue()), "x.webp")
        self.assertIn("forbidden WebP chunk", probs(anim.getvalue(), r_an))
        trunc = self.data[: len(self.data) // 2]
        r_t = Rendition(1424, "v1", "desktop-640.webp", "desktop", self.r.width, self.r.height, len(trunc), sha(trunc), "x.webp")
        self.assertTrue(probs(trunc, r_t))
        v_master = copy.deepcopy(self.v)
        v_master["provenance"]["masterSha256"] = self.r.sha256
        self.assertIn("private master", " ".join(verify_source_file(self.r, self.data, v_master)))

    def test_source_directory_must_match_the_inventory_exactly(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            for p in self.f.src.iterdir():
                shutil.copy(p, t / p.name)
            files, problems = load_sources(self.inv, t)
            self.assertEqual((len(files), problems), (8, []))
            (t / "1424-hillsbrad-master.webp").write_bytes(b"x")
            self.assertTrue(any("unexpected files" in p for p in load_sources(self.inv, t)[1]))
            (t / "1424-hillsbrad-master.webp").unlink()
            (t / self.r.source).unlink()
            self.assertTrue(any("missing under" in p for p in load_sources(self.inv, t)[1]))


class VerifyUnifiedTests(unittest.TestCase):
    """verify_unified (also `atlas.py verify-unified`) must catch every way a finished dist can drift."""

    @classmethod
    def setUpClass(cls):
        cls.f = fixture()
        build_unified(cls.f.opts("vu"))
        cls.good = cls.f.root / "vu/dist"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = Path(self.tmp.name) / "dist"
        shutil.copytree(self.good, self.d)

    def problems(self, **kw):
        return verify_unified(self.d, self.f.pin, self.f.inv, Ledger.load(REAL_LEDGER), kw.get("hero_ledger"))

    def test_good_dist_is_clean(self):
        self.assertEqual(self.problems(), [])

    def test_missing_modified_and_unexpected_files(self):
        victim = next(p for p in self.d.rglob("*.webp") if "forever" in p.parts)
        victim.write_bytes(victim.read_bytes() + b"x")
        self.assertTrue(any("not byte-identical to the baseline" in p for p in self.problems()))
        victim.unlink()
        self.assertTrue(any(p.startswith("missing file forever/") for p in self.problems()))
        (self.d / "index.html").write_text("<html>")
        (self.d / "zone-heroes/1424/v1/master.webp").write_bytes(b"x")
        (self.d / "zone-heroes/1424/v2").mkdir()
        (self.d / "zone-heroes/1424/v2/desktop-640.webp").write_bytes(b"x")
        probs = self.problems()
        self.assertIn("unexpected file index.html", probs)
        self.assertIn("unexpected file zone-heroes/1424/v1/master.webp", probs)
        self.assertIn("unexpected file zone-heroes/1424/v2/desktop-640.webp", probs)

    def test_hero_file_changed_in_place_and_inventory_drift(self):
        h = next(self.d.glob("zone-heroes/1424/v1/mobile-*.webp"))
        h.write_bytes(h.read_bytes()[:-1] + b"\x01")
        self.assertTrue(any("differs from the inventory" in p for p in self.problems()))

    def test_headers_drift(self):
        (self.d / "_headers").write_text(HEADERS)  # hero rule missing
        self.assertTrue(any("_headers differs" in p for p in self.problems()))
        (self.d / "_headers").write_text(UNIFIED_HEADERS + "\n/zone-heroes/*\n  Content-Type: image/png\n")
        self.assertTrue(any("Content-Type" in p or "differs" in p for p in self.problems()))
        (self.d / "_headers").write_text(UNIFIED_HEADERS.replace("/forever/*", "/forever-old/*"))
        self.assertTrue(any("not preserved verbatim" in p for p in self.problems()))

    def test_header_rule_and_line_limits(self):
        many = "".join(f"/p{i}/*\n  X-A: 1\n" for i in range(101))
        (self.d / "_headers").write_text(many)
        self.assertTrue(any("allows 100" in p for p in verify_headers(self.d, [])))
        (self.d / "_headers").write_text("/x/*\n  X-Long: " + "a" * 2000 + "\n")
        self.assertTrue(any("2000 characters" in p for p in verify_headers(self.d, [])))
        (self.d / "_headers").write_text("not-a-path\n")
        self.assertTrue(any("unsupported path" in p for p in verify_headers(self.d, [])))

    def test_hero_art_is_never_mixed_into_atlas_metadata(self):
        p = self.d / "atlas/index.json"
        p.write_text(p.read_text().rstrip()[:-1] + ',"x":"zone-heroes/1424/v1/desktop-640.webp"}')
        self.assertTrue(any("must not reference zone-heroes" in x for x in self.problems()))

    def test_hero_ledger_append_only(self):
        led = HeroLedger({"schemaVersion": 1, "zones": {"1424": {"v1": {"files": {r["file"]: {"sha256": r["sha256"], "bytes": r["bytes"]}
                                                                       for r in self.f.inv["zones"]["1424"]["versions"]["v1"]["renditions"]}}}}})
        self.assertEqual(self.problems(hero_ledger=led), [])
        changed = copy.deepcopy(self.f.inv)
        changed["zones"]["1424"]["versions"]["v1"]["renditions"][0]["sha256"] = "f" * 64
        self.assertTrue(any("changed in place" in p for p in led.problems_against(changed)))
        removed = copy.deepcopy(self.f.inv)
        del removed["zones"]["1424"]
        self.assertTrue(any("missing from the inventory" in p for p in led.problems_against(removed)))
        dropped = copy.deepcopy(self.f.inv)
        dropped["zones"]["1424"]["versions"]["v1"]["renditions"].pop()
        self.assertTrue(any("file set changed" in p for p in led.problems_against(dropped)))
        # a new artwork is a NEW version: allowed, and proposed with the old record untouched
        v2 = copy.deepcopy(self.f.inv)
        v2["zones"]["1424"]["versions"]["v2"] = copy.deepcopy(v2["zones"]["1424"]["versions"]["v1"])
        self.assertEqual(led.problems_against(v2), [])
        prop = led.proposed(v2, inventory_sha256(v2), "x")
        self.assertEqual(prop.data["zones"]["1424"]["v1"], led.data["zones"]["1424"]["v1"])
        self.assertIn("v2", prop.data["zones"]["1424"])

    def test_map_ledger_superset_still_enforced(self):
        led = Ledger.load(REAL_LEDGER)
        led.data["maps"]["1420"]["v1"]["files"]["tirisfal-glades.webp"]["sha256"] = "0" * 64
        self.assertTrue(any("changed in place" in p for p in verify_unified(self.d, self.f.pin, self.f.inv, led)))
        led = Ledger.load(REAL_LEDGER)
        led.data["maps"]["1420"]["v1"]["files"]["gone.webp"] = {"sha256": "0" * 64, "bytes": 1}
        self.assertTrue(any("missing published file" in p for p in verify_unified(self.d, self.f.pin, self.f.inv, led)))


class RemoteHeroTests(unittest.TestCase):
    """verify-remote covers the new namespace: type, cache, CORS, nosniff, timing, and 404 for unknown asset paths."""

    @classmethod
    def setUpClass(cls):
        cls.f = fixture()
        build_unified(cls.f.opts("rh"))
        cls.dist = cls.f.root / "rh/dist"

    def stub(self, **flaw):
        root = self.dist

        def opener(url):
            rel = url.split("pages.dev/", 1)[1]
            p = root / rel
            if rel in flaw.get("catch_all", ()):
                return 200, {"access-control-allow-origin": "*"}, b"<html>"
            if not p.is_file() or rel == flaw.get("missing"):
                return 404, {}, b""
            h = {"access-control-allow-origin": "*", "x-content-type-options": "nosniff"}
            if rel.startswith("zone-heroes/"):
                h.update({"cache-control": "public, max-age=31536000, immutable", "content-type": "image/webp", "timing-allow-origin": "*"})
            elif rel.startswith("forever/"):
                h["cache-control"] = "public, max-age=31536000, immutable"
            else:
                h["cache-control"] = "public, max-age=300, must-revalidate"
            if rel == flaw.get("ctype"):
                h["content-type"] = "application/octet-stream"
            if rel == flaw.get("nosniff"):
                del h["x-content-type-options"]
            if rel == flaw.get("tao"):
                del h["timing-allow-origin"]
            if rel == flaw.get("cache"):
                h["cache-control"] = "public, max-age=300"
            return 200, h, (b"TAMPERED" if rel == flaw.get("tamper") else p.read_bytes())
        return opener

    def run_(self, **flaw):
        return verify_remote("https://azerdex-assets.pages.dev", self.dist, self.stub(**flaw))

    def test_matching_cdn_passes(self):
        r = self.run_()
        self.assertEqual((r["ok"], r["problems"]), (True, []))
        self.assertEqual(r["checked"], len(file_table(self.dist)) - 1)

    def test_hero_specific_defects(self):
        h = "zone-heroes/1424/v1/desktop-1000.webp"
        self.assertTrue(any("content-type" in p for p in self.run_(ctype=h)["problems"]))
        self.assertTrue(any("nosniff" in p for p in self.run_(nosniff=h)["problems"]))
        self.assertTrue(any("Timing-Allow-Origin" in p for p in self.run_(tao=h)["problems"]))
        self.assertTrue(any("cache-control" in p for p in self.run_(cache=h)["problems"]))
        self.assertTrue(any("bytes differ" in p for p in self.run_(tamper=h)["problems"]))
        self.assertIn(f"{h}: HTTP 404", self.run_(missing=h)["problems"])

    def test_unknown_asset_paths_must_404(self):
        for bad in ("zone-heroes/9999999/v1/desktop-1280.webp", "zone-heroes/1424/v999/desktop-1280.webp", "forever/9999999/v1/manifest.json"):
            self.assertTrue(any("catch-all" in p for p in self.run_(catch_all=(bad,))["problems"]), bad)


class MapLedgerProposalTests(unittest.TestCase):
    def test_proposal_adds_every_baseline_version_and_never_rewrites_existing_records(self):
        f = fixture()
        prop = propose_map_ledger(Ledger.load(REAL_LEDGER), f.files, f.pin)
        base = Ledger.load(REAL_LEDGER)
        self.assertEqual(prop.versions(1420)["v1"], base.versions(1420)["v1"])
        versions = {(mid, v) for mid, vs in prop.data["maps"].items() for v in vs}
        self.assertEqual(versions, {tuple(p.split("/")[1:3]) for p in f.files if p.startswith("forever/")} | {("1420", "v1")})
        for mid, vs in prop.data["maps"].items():
            for v, rec in vs.items():
                for name, meta in rec["files"].items():
                    self.assertEqual(sha(f.files[f"forever/{mid}/{v}/{name}"]), meta["sha256"]) if f"forever/{mid}/{v}/{name}" in f.files else None


class CommittedArtifactsTests(unittest.TestCase):
    """The committed pin and inventory against the real, public repository files (no private material involved)."""

    def test_committed_inventory_matches_the_real_hero_files(self):
        inv = load_inventory(REAL_INVENTORY)
        files, problems = load_sources(inv, REAL_HERO_SOURCES)
        self.assertEqual(problems, [])
        self.assertEqual(sorted(files), sorted(f"zone-heroes/{z}/v1/{n}" for z, ns in {
            "1424": ["desktop-1280.webp", "desktop-2000.webp", "mobile-600.webp", "mobile-900.webp"],
            "1431": ["desktop-1280.webp", "desktop-1916.webp", "mobile-600.webp", "mobile-900.webp"]}.items() for n in ns))
        dims = {(r.zone, r.file): (r.width, r.height) for r in renditions(inv)}
        self.assertEqual(dims[(1424, "desktop-2000.webp")], (2000, 667))
        self.assertEqual(dims[(1424, "mobile-900.webp")], (900, 484))
        self.assertEqual(dims[(1431, "desktop-1916.webp")], (1916, 821))
        self.assertEqual(dims[(1431, "mobile-900.webp")], (900, 773))
        self.assertEqual(inv["zones"]["1424"]["versions"]["v1"]["provenance"]["masterSha256"], "a0e6b402237e6ab39cc9b5e7651d8bcda58e543347214aef8af41049d7111504")
        self.assertEqual(inv["zones"]["1431"]["versions"]["v1"]["provenance"]["masterSha256"], "61997e34e01be51b74ff5e0e8d9d621dfa19c56f13eec6d1977837fdd28393f5")

    def test_committed_pin_is_the_approved_distribution(self):
        pin = json.loads(REAL_PIN.read_text())
        self.assertEqual(pin["distributionZipSha256"], "f8a3df96cf9567c8abcd5b80b71d21f6ef44bb09fe455b70b8f32ea75c32c847")
        self.assertEqual((pin["counts"]["files"], pin["counts"]["maps"], pin["counts"]["immutableVersions"], pin["counts"]["images"]), (172, 60, 61, 106))
        self.assertEqual(len(pin["files"]), 172)
        self.assertEqual(pin["client"]["version"], "1.60.1.70450")
        led = Ledger.load(REAL_LEDGER)
        for mid, vs in led.data["maps"].items():  # the committed ledger is a subset of the pinned distribution
            for ver, rec in vs.items():
                for name, meta in rec["files"].items():
                    self.assertEqual(pin["files"][f"forever/{mid}/{ver}/{name}"], meta)
        self.assertEqual(pin["files"]["atlas/index.json"]["sha256"], "5d2b2bc110d20f8a3bb24fd2dac8b786ed0ded979de8435bd8bb747ec0cb8e7c")

    def test_pin_and_inventory_do_not_overlap_and_no_hero_in_atlas(self):
        pin = json.loads(REAL_PIN.read_text())
        self.assertFalse([p for p in pin["files"] if "zone-heroes" in p])
        self.assertTrue(all(not HERO_PATH_RE.match(p) for p in pin["files"]))

    def test_real_baseline_end_to_end_when_the_private_archive_is_available(self):
        import os
        zp = os.environ.get("ATLAS_BASELINE_ZIP")
        if not zp or not Path(zp).is_file():
            self.skipTest("set ATLAS_BASELINE_ZIP to the approved atlas-dist zip (private artwork, never in CI)")
        with tempfile.TemporaryDirectory() as t:
            r = build_unified(UnifiedOptions(Path(zp), REAL_PIN, REAL_INVENTORY, REAL_HERO_SOURCES, Path(t), REAL_LEDGER, ROOT / "ledger/zone-heroes.json"))
            self.assertEqual((r["dist"]["fileCount"], r["heroes"]["renditions"]), (180, 8))


if __name__ == "__main__":
    unittest.main()
