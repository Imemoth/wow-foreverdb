import hashlib
import json
import os
import shutil
import stat
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path
from unittest import mock

import common  # noqa: F401
from common import REPO, ROOT
import atlas
from synth_export import MAPS, MATCH, ROOT as ZROOT, edit_json, make_export, write_zip
from mapatlas import exporter_zip, importer
from mapatlas.exporter_zip import ImportValidationError, open_source
from mapatlas.import_report import check_web_contract
from mapatlas.importer import ImportOptions, MapPlan, development_flags, plan_files, run_import
from mapatlas.packaging import ASSET_PATH_RE, PackageError, check_limits, file_table, list_files, verify_catalog, verify_superset

LEGACY = REPO / "web/public/maps"
# the map ledger as committed BEFORE the V2-B promotion (only 1420/v1): the synthetic exports in these tests only know that version
REAL_LEDGER = ROOT / "tests/fixtures/ledger-pre-v2b.json"
REF = LEGACY / "forever/1420/v1/tirisfal-glades.webp"
FIXTURE = ROOT / "tests/fixtures/sample-atlas-manifest.json"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)

    def zip(self, F=None, name="src.zip", **kw):
        return write_zip(F if F is not None else make_export(), self.work / name, **kw)

    def opts(self, zp, name="out", ledger=None, previous=None, **kw) -> ImportOptions:
        led = self.work / f"{name}-ledger.json"
        shutil.copy(ledger or REAL_LEDGER, led)
        return ImportOptions(zp, self.work / name, led, previous, LEGACY, REF, **kw)

    def manifest(self, o, mid, ver):
        return json.loads((o.out / f"dist/forever/{mid}/{ver}/manifest.json").read_text())


class HappyPathTests(Base):
    @classmethod
    def setUpClass(cls):
        cls.tmp0 = tempfile.TemporaryDirectory()
        cls.work0 = Path(cls.tmp0.name)
        cls.F = make_export()
        cls.zp = write_zip(cls.F, cls.work0 / "src.zip")
        led = cls.work0 / "ledger.json"
        shutil.copy(REAL_LEDGER, led)
        cls.o = ImportOptions(cls.zp, cls.work0 / "out", led, None, LEGACY, REF, expect_maps=9, expect_variants=12, expect_instances=4, expect_version="1.60.1.70450")
        cls.report = run_import(cls.o)
        cls.dist = cls.o.out / "dist"

    @classmethod
    def tearDownClass(cls):
        cls.tmp0.cleanup()

    def man(self, mid, ver):
        return json.loads((self.dist / f"forever/{mid}/{ver}/manifest.json").read_text())

    def test_every_source_image_is_preserved_byte_for_byte_and_nothing_is_reencoded(self):
        n = 0
        for path, data in self.F.items():
            if not path.endswith(".webp") or not path.startswith("maps/"):
                continue
            _, mid, variant, _ = path.split("/")
            stored = [p for p in (self.dist / f"forever/{mid}").glob(f"v*/{variant}.webp")]
            self.assertEqual(len(stored), 1, path)
            self.assertEqual(stored[0].read_bytes(), data, path)
            n += 1
        self.assertEqual(n, 12)
        self.assertEqual(self.report["package"]["imageFiles"], 12 + 1)  # + the immutable legacy POC image

    def test_base_and_full_reveal_stay_distinct_and_default_is_explicit(self):
        m = self.man(1420, "v2")
        names = {v["variant"]: v["images"][0] for v in m["variants"]}
        self.assertEqual(sorted(names), ["base", "full-reveal"])
        self.assertNotEqual(names["base"]["sha256"], names["full-reveal"]["sha256"])
        self.assertEqual((m["image"]["file"], m["image"]["variant"], m["defaultImage"]["variant"]), ("full-reveal.webp", "full-reveal", "full-reveal"))
        self.assertIn("verified full-reveal", m["defaultImage"]["reason"])
        self.assertEqual([v["isDefault"] for v in m["variants"]], [False, True])
        # base-only map: base is shown and nothing is labelled full-reveal
        a = self.man(947, "v1")
        self.assertEqual((a["image"]["file"], a["image"]["variant"], a["defaultImage"]["reason"]), ("base.webp", "base", "no-full-reveal-variant"))
        self.assertEqual([v["variant"] for v in a["variants"]], ["base"])
        self.assertFalse((self.dist / "forever/947/v1/full-reveal.webp").exists())

    def test_unverified_reveal_is_preserved_but_not_the_default_and_tileless_reveal_is_flagged(self):
        u = self.man(2200, "v1")
        self.assertEqual((u["image"]["variant"], sorted(v["variant"] for v in u["variants"])), ("base", ["base", "full-reveal"]))
        self.assertTrue(any("not used as default" in w for w in u["provenance"]["warnings"]))
        self.assertTrue((self.dist / "forever/2200/v1/full-reveal.webp").is_file())
        sv = self.man(1434, "v1")
        self.assertEqual(sv["image"]["variant"], "full-reveal")
        rv = next(v for v in sv["variants"] if v["kind"] == "full-reveal")["reveal"]
        self.assertEqual((rv["completeness"], len(rv["skippedOverlays"])), ("tileless-declared-overlays-skipped", 1))
        self.assertTrue(any("no tile records" in w for w in sv["provenance"]["warnings"]))

    def test_identifiers_provenance_and_classification_are_preserved_separately(self):
        m = self.man(1420, "v2")
        self.assertEqual((m["uiMapId"], m["zoneId"], m["internalMapId"], m["mapArtIds"], m["parentUiMapId"]), (1420, 1420, 0, [3420], 1414))
        self.assertEqual((m["classificationConfidence"], m["categorySource"], m["category"]), ("confirmed", "uimap-type", "zone"))
        self.assertEqual(m["clientBuild"], {"product": "wow_classic_beta", "version": "1.60.1.70450", "buildKey": "84bea4233331e390fda8724c6f91ffa5", "buildNumber": 70450})
        self.assertEqual(m["source"]["exporter"], {"name": "ForeverDB.AtlasExporter", "version": "0.2.1"})
        self.assertIsNone(m["floor"])
        fr = next(v for v in m["variants"] if v["kind"] == "full-reveal")
        self.assertEqual((fr["mapArtId"], fr["phaseId"], fr["reveal"]["status"], fr["reveal"]["overlayTiles"]), (3420, 0, MATCH, 22))
        self.assertEqual(m["calibration"]["worldBounds"][0]["mapId"], 0)
        self.assertEqual(self.man(1414, "v1")["internalMapId"], 1)  # a different Map ID than 1420, never conflated with the uiMapID
        self.assertEqual(m["provenance"]["licenseStatus"], "unreviewed")

    def test_calibration_is_always_provisional_and_projection_is_the_accepted_model(self):
        for mp in self.dist.glob("forever/*/*/manifest.json"):
            m = json.loads(mp.read_text())
            self.assertEqual(m["calibration"]["status"], "provisional", mp)
            self.assertEqual((m["projection"]["origin"], m["projection"]["xDirection"], m["projection"]["yDirection"], m["projection"]["range"]), ("top-left", "right", "down", [0, 100]))
        self.assertIn("registration", self.man(1420, "v2")["calibration"])  # evidence only

    def test_manifests_satisfy_the_web_contract_and_every_reference_resolves(self):
        for mp in self.dist.glob("forever/*/*/manifest.json"):
            m = json.loads(mp.read_text())
            if m.get("kind") != "azerdex-atlas-map":  # the immutable legacy POC v1 manifest predates this layout
                continue
            self.assertEqual(check_web_contract(m), [], mp)
            for im in [m["image"]] + [i for v in m["variants"] if "images" in v for i in v["images"]]:
                rel = f"forever/{m['zoneId']}/{m['version']}/{im['file']}"
                self.assertRegex(rel, ASSET_PATH_RE)
                self.assertTrue((self.dist / rel).is_file(), rel)
        self.assertEqual(verify_catalog(self.dist), [])

    def test_tirisfal_poc_v1_is_untouched_and_the_real_art_is_a_new_immutable_version(self):
        for n in ("manifest.json", "tirisfal-glades.webp"):
            self.assertEqual(sha(self.dist / "forever/1420/v1" / n), sha(LEGACY / "forever/1420/v1" / n))
        self.assertEqual(sorted(p.name for p in (self.dist / "forever/1420").iterdir()), ["v1", "v2"])
        nxt = json.loads((self.o.out / "ledger.next.json").read_text())
        base = json.loads(REAL_LEDGER.read_text())
        self.assertEqual(nxt["maps"]["1420"]["v1"], base["maps"]["1420"]["v1"])
        self.assertEqual(json.loads(REAL_LEDGER.read_text()), base)  # the committed ledger was not promoted
        self.assertTrue(self.report["tirisfal"]["pocV1"]["preserved"])
        self.assertEqual(sorted(self.report["package"]["newVersionsThisRun"], key=lambda s: int(s.split("/")[0])), ["947/v1", "1414/v1", "1420/v2", "1434/v1", "1459/v1", "2200/v1", "2521/v1", "2522/v1"])

    def test_catalog_keeps_the_five_states_apart_and_slugs_are_not_identifiers(self):
        idx = json.loads((self.dist / "atlas/index.json").read_text())
        by = {e["uiMapId"]: e for e in idx["maps"]}
        self.assertEqual(by[1420]["availability"], "available")
        self.assertEqual((by[3001]["availability"], "manifest" in by[3001]), ("no-artwork", False))  # defined by the client, no art, nothing invented
        self.assertEqual(by[3001]["statusDetail"], "the client gives this map no art of its own")
        self.assertEqual(idx["lookup"]["byName"]["zephras-isle"], [2521, 2522])  # duplicate slug stays list-valued
        self.assertEqual(idx["lookup"]["byParent"]["947"], [1414, 2521])
        self.assertEqual(idx["lookup"]["byFullReveal"]["full-reveal"], [1414, 1420, 1434, 2200])
        self.assertEqual(idx["lookup"]["byCategory"]["instance"], [1459])
        self.assertTrue(any("says nothing about whether any observation exists" in n for n in idx["notes"]))
        h = json.loads((self.dist / "atlas/hierarchy.json").read_text())
        self.assertEqual(h["roots"], [947])
        self.assertEqual(next(n for n in h["nodes"] if n["uiMapId"] == 1414)["children"], sorted([1420, 1434, 2200, 2522, 3001, 1459]))

    def test_instance_catalog_is_preserved_raw_unverified_and_separate_from_the_map_index(self):
        inst = json.loads((self.dist / "atlas/instances.json").read_text())
        src = json.loads(self.F["atlas/instances.json"])
        self.assertEqual(inst["counts"]["records"], 4)
        self.assertEqual((inst["counts"]["drawable"], inst["counts"]["withoutInteriorMap"], inst["counts"]["byClassification"]), (1, 3, {"battleground": 1, "dungeon": 2, "raid": 1}))
        for a, b in zip(sorted(src["instances"], key=lambda r: r["mapId"]), inst["instances"]):
            self.assertEqual({k: v for k, v in b.items() if k != "catalog"}, a)  # source fields untouched
            self.assertEqual((b["catalog"]["visibility"], b["catalog"]["releaseStatus"]), ("unreviewed", "unverified"))
        by = {r["mapId"]: r for r in inst["instances"]}
        self.assertEqual(by[13]["catalog"]["developmentFlags"], ["name-or-directory-looks-like-development-content"])
        self.assertEqual(by[36]["catalog"]["developmentFlags"], [])
        self.assertEqual(by[36]["uiMaps"], [])                       # no fake UiMapIDs for interior-less instances
        self.assertEqual(by[30]["catalog"]["drawableMaps"][0]["uiMapId"], 1459)
        self.assertEqual(by[30]["catalog"]["drawableMaps"][0]["latestVersion"], "v1")
        self.assertFalse(by[30]["catalog"]["floorsVerified"])
        idx = json.loads((self.dist / "atlas/index.json").read_text())
        self.assertFalse(any(e["uiMapId"] in (13, 36, 249) for e in idx["maps"]))  # instances never leak into the drawable-map index as UiMaps

    def test_private_source_material_is_never_published_and_package_limits_hold(self):
        files = list_files(self.dist)
        self.assertEqual(sorted(f for f in files if f.startswith("atlas/")), ["atlas/builds.json", "atlas/hierarchy.json", "atlas/index.json", "atlas/instances.json"])
        self.assertFalse([f for f in files if "diagnostic" in f or "gallery" in f or f.endswith(".txt") or f.endswith(".html")])
        self.assertEqual(check_limits(self.dist)["problems"], [])
        self.assertEqual(self.report["package"]["fileCount"], len(files))
        self.assertTrue(all(p["ok"] for p in self.report["preflight"]), [p for p in self.report["preflight"] if not p["ok"]])
        b = json.loads((self.dist / "atlas/builds.json").read_text())["builds"][-1]
        self.assertEqual((b["import"]["zipSha256"], b["counts"]), (hashlib.sha256(self.zp.read_bytes()).hexdigest(), {"maps": 9, "variants": 12, "images": 12, "instances": 4}))

    def test_review_package_is_generated(self):
        for n in ("coverage.json", "coverage.md", "asset-inventory.json", "asset-inventory.csv", "instance-catalog.json", "instance-catalog.md", "tirisfal-regression.json",
                  "categories-and-reveal.json", "ledger-proposal.md"):
            self.assertTrue((self.o.out / "reports" / n).is_file(), n)
        self.assertTrue((self.o.out / "preview/index.html").is_file())
        review = (self.o.out / "OWNER-REVIEW.md").read_text()
        for needle in ("Automated preflight", "Owner approval steps", "Rollback plan", "Known caveats", "ledger.next.json", "NOT deployed"):
            self.assertIn(needle, review)
        self.assertTrue((self.o.out / "SHA256SUMS.txt").read_text().count("\n") == len(list_files(self.dist)))

    def test_manifest_fixture_for_the_web_contract_test_is_current(self):
        m = json.loads((self.dist / "forever/1420/v2/manifest.json").read_text())
        for im in [m["image"]] + [i for v in m["variants"] for i in v["images"]]:
            im["bytes"], im["sha256"] = 1, "0" * 64  # WebP bytes depend on the libwebp that produced the synthetic art
        text = json.dumps(m, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        if os.environ.get("UPDATE_FIXTURES"):
            FIXTURE.write_text(text)
        self.assertEqual(FIXTURE.read_text(), text, "run with UPDATE_FIXTURES=1; web/tests/unit/map-atlas-contract.test.ts validates this file")


class RefusalTests(Base):
    def refused(self, F=None, contains="", **kw):
        zp = self.zip(F, **{k: v for k, v in kw.items() if k == "root"})
        okw = {k: v for k, v in kw.items() if k != "root"}
        with self.assertRaises(ImportValidationError) as cm:
            open_source(zp, **okw)
        self.assertTrue(any(contains in p for p in cm.exception.problems), f"{contains!r} not in {cm.exception.problems}")

    def mutate(self, fn):
        F = make_export()
        fn(F)
        return F

    def test_a_clean_synthetic_export_is_accepted(self):
        self.assertEqual(len(open_source(self.zip()).maps), 9)

    def test_archive_level_attacks(self):
        self.refused(self.mutate(lambda F: F.__setitem__("../evil.json", b"{}")), "unsafe archive path")
        self.refused(self.mutate(lambda F: F.__setitem__("maps/../../x", b"x")), "unsafe archive path")
        self.refused(self.mutate(lambda F: F.__setitem__("maps\\1420\\x.webp", b"x")), "unsafe archive path")
        self.refused(self.mutate(lambda F: F.__setitem__("C:/windows/x", b"x")), "unsafe archive path")
        F = make_export()
        zp = self.work / "abs.zip"
        with zipfile.ZipFile(zp, "w") as z:
            z.writestr("/abs/atlas/index.json", b"{}")
        with self.assertRaises(ImportValidationError) as cm:
            open_source(zp)
        self.assertTrue(any("unsafe archive path" in p for p in cm.exception.problems))

    def test_duplicate_conflicting_symlink_encrypted_and_non_zip(self):
        F = make_export()
        extra = [(zipfile.ZipInfo(ZROOT + "maps/1420/base/overview.webp"), b"different bytes")]
        with warnings.catch_warnings(), self.assertRaises(ImportValidationError) as cm:
            warnings.simplefilter("ignore")  # zipfile itself warns when a duplicate name is written, which is exactly what this test builds
            open_source(write_zip(F, self.work / "dup.zip", extra=extra))
        self.assertTrue(any("duplicate or conflicting path" in p for p in cm.exception.problems), cm.exception.problems)
        extra = [(zipfile.ZipInfo(ZROOT + "MAPS/1420/BASE/OVERVIEW.WEBP"), b"case collision")]
        with self.assertRaises(ImportValidationError) as cm:
            open_source(write_zip(F, self.work / "case.zip", extra=extra))
        self.assertTrue(any("duplicate or conflicting path" in p for p in cm.exception.problems), cm.exception.problems)
        link = zipfile.ZipInfo(ZROOT + "maps/link.webp")
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(ImportValidationError) as cm:
            open_source(write_zip(F, self.work / "sym.zip", extra=[(link, b"/etc/passwd")]))
        self.assertTrue(any("symbolic link" in p for p in cm.exception.problems))
        (self.work / "x.zip").write_bytes(b"not a zip at all")
        with self.assertRaises(ImportValidationError):
            open_source(self.work / "x.zip")

    def test_corrupt_member_is_detected(self):
        zp = self.zip()
        raw = bytearray(zp.read_bytes())
        i = raw.find(b"RIFF")
        raw[i + 40] ^= 0xFF
        zp.write_bytes(bytes(raw))
        with self.assertRaises(ImportValidationError) as cm:
            open_source(zp)
        self.assertTrue(any("corrupt ZIP member" in p for p in cm.exception.problems), cm.exception.problems)

    def test_size_limits(self):
        with mock.patch.object(exporter_zip, "MAX_MEMBER_BYTES", 500):
            self.refused(None, "exceeds the 500 byte member limit")
        with mock.patch.object(exporter_zip, "MAX_ENTRIES", 5):
            self.refused(None, "entries (limit 5)")

    def test_image_integrity(self):
        def drop(F): del F["maps/1420/full-reveal/overview.webp"]
        self.refused(self.mutate(drop), "missing from archive")
        def tamper(F): F["maps/1420/base/overview.webp"] = F["maps/1420/base/overview.webp"][:-5] + b"XXXXX"
        self.refused(self.mutate(tamper), "sha256 mismatch")
        def notwebp(F):
            import io
            from PIL import Image
            b = io.BytesIO(); Image.new("RGB", (120, 80)).save(b, "PNG")
            F["maps/947/base/overview.webp"] = b.getvalue()
            edit_json(F, "atlas/index.json", lambda d: d["maps"][0]["variants"][0]["images"][0].update(sha256=hashlib.sha256(b.getvalue()).hexdigest(), bytes=len(b.getvalue())))
        self.refused(self.mutate(notwebp), "not WEBP")
        def dims(F): edit_json(F, "atlas/index.json", lambda d: d["maps"][0]["variants"][0]["images"][0].update(width=121))
        self.refused(self.mutate(dims), "decoded size")
        def bytelen(F): edit_json(F, "atlas/index.json", lambda d: d["maps"][0]["variants"][0]["images"][0].update(bytes=7))
        self.refused(self.mutate(bytelen), "bytes !=")
        def same(F):
            F["maps/1420/full-reveal/overview.webp"] = F["maps/1420/base/overview.webp"]
            sha_, n = hashlib.sha256(F["maps/1420/base/overview.webp"]).hexdigest(), len(F["maps/1420/base/overview.webp"])
            edit_json(F, "atlas/index.json", lambda d: next(m for m in d["maps"] if m["uiMapId"] == 1420)["variants"][1]["images"][0].update(sha256=sha_, bytes=n))
            edit_json(F, "maps/1420/full-reveal/manifest.json", lambda d: (d["image"].update(sha256=sha_, bytes=n), d["images"][0].update(sha256=sha_, bytes=n)))
        self.refused(self.mutate(same), "byte-identical to a base image")
        def orphan(F): F["maps/1420/base/extra.webp"] = b"stale art"
        self.refused(self.mutate(orphan), "not referenced by the index")

    def test_identity_and_consistency_across_files(self):
        self.refused(self.mutate(lambda F: edit_json(F, "maps/1420/base/manifest.json", lambda d: d.update(zoneId=999))), "zoneId")
        self.refused(self.mutate(lambda F: edit_json(F, "maps/1420/base/manifest.json", lambda d: d.update(slug="other"))), "slug")
        self.refused(self.mutate(lambda F: edit_json(F, "maps/1420/base/manifest.json", lambda d: d["provenance"].update(clientVersion="1.60.1.70451"))), "provenance build")
        self.refused(self.mutate(lambda F: edit_json(F, "maps/1420/base/manifest.json", lambda d: d["provenance"].update(internalMapId=77))), "internalMapId")
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/index.json", lambda d: d["client"].update(version="1.60.1.70451"))), "differs between index.json")
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/index.json", lambda d: d["maps"][1].update(uiMapId=947))), "duplicate uiMapId")
        self.refused(self.mutate(lambda F: edit_json(F, "maps/1420/base/manifest.json", lambda d: d["calibration"].update(status="validated"))), "not 'provisional'")
        self.refused(self.mutate(lambda F: edit_json(F, "maps/1420/base/manifest.json", lambda d: d["projection"].update(origin="bottom-left"))), "projection")
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/build.json", lambda d: d["client"].update(product="wow_classic"))), "no product substitution")
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/build.json", lambda d: d["client"].update(buildKey="xyz"))), "invalid client build key")

    def test_partial_filtered_or_failed_exports_are_refused(self):
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/export-report.json", lambda d: d.update(status="COMPLETE (FILTERED RUN - not the full atlas)"))), "only a full 'COMPLETE' export")
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/export-report.json", lambda d: d["counts"].update(mapsSkippedByFilter=51))), "filtered export")
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/build.json", lambda d: d["tableRowCounts"].update(UiMap=60))), "filtered or truncated export")
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/export-report.json", lambda d: d["counts"].update(mapsFailed=1))), "mapsFailed")
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/build.json", lambda d: d.update(allowPartial=True))), "allowPartial")
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/build.json", lambda d: d.update(fullReveal=False))), "no full-reveal pass")
        def partial(F):
            edit_json(F, "atlas/index.json", lambda d: next(m for m in d["maps"] if m["uiMapId"] == 1420)["variants"][1].update(status="partial"))
        self.refused(self.mutate(partial), "partial or failed art")
        def pov(F):
            edit_json(F, "atlas/index.json", lambda d: next(m for m in d["maps"] if m["uiMapId"] == 1420)["variants"][1].update(revealCompleteness="partial-overlays"))
            edit_json(F, "maps/1420/full-reveal/manifest.json", lambda d: d["provenance"].update(revealCompleteness="partial-overlays"))
        self.refused(self.mutate(pov), "partial overlays")
        def tiles(F): edit_json(F, "maps/1420/base/manifest.json", lambda d: (d["images"][0].update(tilesPlaced=11, complete=False), d["image"].update(tilesPlaced=11, complete=False)))
        self.refused(self.mutate(tiles), "incomplete")
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/index.json", lambda d: d["maps"][0].update(status="art-incomplete"))), "not an accepted complete-export status")

    def test_expectations_pin_the_source(self):
        self.refused(None, "expected 61 maps", expect_maps=61)
        self.refused(None, "expected 13 image variants", expect_variants=13)
        self.refused(None, "expected 55 instance records", expect_instances=55)
        self.refused(None, "expected 1.60.1.70451", expect_version="1.60.1.70451")
        self.refused(None, "source ZIP sha256", expect_zip_sha256="0" * 64)

    def test_instance_and_hierarchy_consistency(self):
        self.refused(self.mutate(lambda F: F.pop("atlas/instances.json")), "missing instance catalog")
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/instances.json", lambda d: d["instances"][1]["uiMaps"][0].update(uiMapId=424242))), "not in the atlas index")
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/instances.json", lambda d: d["instances"][1].update(mapId=31))), "identifiers conflated")
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/instances.json", lambda d: d["counts"].update(records=99))), "counts disagree")
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/hierarchy.json", lambda d: d.update(cycleMembers=[1, 2]))), "parent cycles")
        self.refused(self.mutate(lambda F: edit_json(F, "atlas/hierarchy.json", lambda d: d["nodes"].pop())), "differ from the index")


class VersioningTests(Base):
    def run_import(self, F, name, ledger=None, previous=None, **kw):
        o = self.opts(self.zip(F, name=f"{name}.zip"), name, ledger=ledger, previous=previous, **kw)
        return o, run_import(o)

    def test_deterministic_and_idempotent(self):
        """Same source = the same archive BYTES (one file, imported repeatedly)."""
        zp = self.zip(name="src.zip")
        o1 = self.opts(zp, "a")
        r1 = run_import(o1)
        o2 = self.opts(zp, "b")
        r2 = run_import(o2)
        self.assertEqual(file_table(o1.out / "dist"), file_table(o2.out / "dist"))
        self.assertEqual(r1["package"]["zip"]["sha256"], r2["package"]["zip"]["sha256"])
        # repeat on the proposed ledger: nothing new, with the previous snapshot and fully offline without it
        for prev in (o1.out / "dist", None):
            o3 = self.opts(zp, f"c{bool(prev)}", ledger=o1.out / "ledger.next.json", previous=prev)
            r3 = run_import(o3)
            self.assertEqual((r3["package"]["newVersionsThisRun"], len(r3["package"]["reusedVersionsThisRun"])), ([], 8))
            self.assertEqual(file_table(o1.out / "dist"), file_table(o3.out / "dist"))
            self.assertEqual((o1.out / "ledger.next.json").read_text(), (o3.out / "ledger.next.json").read_text())
            self.assertEqual(r1["package"]["zip"]["sha256"], r3["package"]["zip"]["sha256"])

    def test_fixture_archives_are_byte_deterministic_whatever_the_wall_clock(self):
        """Regression for the CI failure: two writes straddling a 2-second ZIP-timestamp boundary must still be identical."""
        with mock.patch("time.time", return_value=1_800_000_000.0):
            a = self.zip(name="a.zip").read_bytes()
        with mock.patch("time.time", return_value=1_800_000_003.0):
            b = self.zip(name="b.zip").read_bytes()
        self.assertEqual(a, b)

    def test_repackaged_or_rerun_export_changes_only_the_recorded_source_archive_hash(self):
        """The dist is a deterministic function of the source ARCHIVE BYTES. A different archive with identical content (re-zipped,
        other compression/order/wrapper folder, volatile diagnostics, an exporter re-run that reports `reused` instead of `exported`)
        yields the same immutable assets, manifests, versions, ledger and catalog: the ONLY difference is the provenance field
        atlas/builds.json -> builds[].import.zipSha256, in both the with- and without-previous-dist flows."""
        base_zip = self.zip(name="base.zip")
        o1 = self.opts(base_zip, "first")
        run_import(o1)

        def rerun(F):  # the exporter run again over the same art: run statuses/counters and volatile run data differ
            for path in list(F):
                if path.endswith("manifest.json") and path.startswith("maps/"):
                    edit_json(F, path, lambda d: d.update(status="reused" if d["status"] == "exported" else "exported"))
            def flip(d):
                for m in d["maps"]:
                    for v in m["variants"]:
                        v["status"] = "reused" if v["status"] == "exported" else "exported"
            edit_json(F, "atlas/index.json", flip)
            edit_json(F, "atlas/export-report.json", lambda d: d["counts"].update(mapsExported=7, mapsReused=1))
            edit_json(F, "diagnostics/run-info.json", lambda d: d.update(startedUtc="2031-01-01T00:00:00Z"))
            F["diagnostics/export-summary.txt"] = b"a different run summary\n"
            F["gallery/index.html"] = b"<html>other gallery</html>"

        variants = {
            "stored-compression-reversed-order": dict(compression=zipfile.ZIP_STORED, order="reversed"),
            "sorted-order-other-wrapper-folder": dict(order="sorted", root="Atlas-Export-Renamed/"),
            "no-wrapper-folder": dict(root=""),
            "exporter-rerun-volatile-data": dict(mutate=rerun),
        }
        for label, kw in variants.items():
            F = make_export()
            if "mutate" in kw:
                kw = dict(kw)
                kw.pop("mutate")(F)
            zp = write_zip(F, self.work / f"{label}.zip", **kw)
            self.assertNotEqual(zp.read_bytes(), base_zip.read_bytes(), label)
            for prev in (o1.out / "dist", None):
                o2 = self.opts(zp, f"{label}-{bool(prev)}", ledger=o1.out / "ledger.next.json", previous=prev)
                r2 = run_import(o2)
                self.assertEqual((r2["package"]["newVersionsThisRun"], len(r2["package"]["reusedVersionsThisRun"])), ([], 8), label)
                t1, t2 = file_table(o1.out / "dist"), file_table(o2.out / "dist")
                self.assertEqual(sorted(p for p in set(t1) | set(t2) if t1.get(p) != t2.get(p)), ["atlas/builds.json"], f"{label} prev={bool(prev)}")
                b1 = json.loads((o1.out / "dist/atlas/builds.json").read_text())
                b2 = json.loads((o2.out / "dist/atlas/builds.json").read_text())
                self.assertEqual(b1["builds"][-1]["import"]["zipSha256"], hashlib.sha256(base_zip.read_bytes()).hexdigest())
                self.assertEqual(b2["builds"][-1]["import"]["zipSha256"], hashlib.sha256(zp.read_bytes()).hexdigest())
                for b in (b1, b2):  # neutralise the one provenance field: nothing else may differ
                    for e in b["builds"]:
                        e["import"].pop("zipSha256")
                        e["import"].pop("zipBytes")
                self.assertEqual(b1, b2, label)
                self.assertEqual((o1.out / "ledger.next.json").read_text(), (o2.out / "ledger.next.json").read_text(), label)

    def test_changed_full_reveal_alone_gets_a_new_version_and_never_overwrites_the_old_one(self):
        o1, _ = self.run_import(None, "one")
        F2 = make_export()
        from synth_export import webp
        data = webp(999, 100, 66)
        F2["maps/1420/full-reveal/overview.webp"] = data
        h, n = hashlib.sha256(data).hexdigest(), len(data)
        edit_json(F2, "atlas/index.json", lambda d: next(m for m in d["maps"] if m["uiMapId"] == 1420)["variants"][1]["images"][0].update(sha256=h, bytes=n))
        edit_json(F2, "maps/1420/full-reveal/manifest.json", lambda d: (d["image"].update(sha256=h, bytes=n), d["images"][0].update(sha256=h, bytes=n)))
        o2, r2 = self.run_import(F2, "two", ledger=o1.out / "ledger.next.json", previous=o1.out / "dist")
        self.assertEqual(r2["package"]["newVersionsThisRun"], ["1420/v3"])  # base unchanged, but the asset SET changed
        for f in list_files(o1.out / "dist/forever/1420/v2"):
            self.assertEqual(sha(o1.out / "dist/forever/1420/v2" / f), sha(o2.out / "dist/forever/1420/v2" / f))
        self.assertEqual(sha(o2.out / "dist/forever/1420/v2/base.webp"), sha(o2.out / "dist/forever/1420/v3/base.webp"))
        self.assertNotEqual(sha(o2.out / "dist/forever/1420/v2/full-reveal.webp"), sha(o2.out / "dist/forever/1420/v3/full-reveal.webp"))

    def test_material_metadata_change_alone_gets_a_new_version_but_provenance_only_change_does_not(self):
        o1, _ = self.run_import(None, "one")
        F = make_export()
        edit_json(F, "atlas/index.json", lambda d: next(m for m in d["maps"] if m["uiMapId"] == 1420).update(classificationConfidence="heuristic"))
        o2, r2 = self.run_import(F, "two", ledger=o1.out / "ledger.next.json", previous=o1.out / "dist")
        self.assertEqual(r2["package"]["newVersionsThisRun"], ["1420/v3"])
        # same art and metadata from a newer exporter build: the version is reused and the published manifest bytes stay
        F3 = make_export(exporter_version="0.3.0")
        o3, r3 = self.run_import(F3, "three", ledger=o1.out / "ledger.next.json", previous=o1.out / "dist")
        self.assertEqual((r3["package"]["newVersionsThisRun"], len(r3["package"]["reusedVersionsThisRun"])), ([], 8))
        self.assertEqual(sha(o3.out / "dist/forever/1420/v2/manifest.json"), sha(o1.out / "dist/forever/1420/v2/manifest.json"))
        with self.assertRaisesRegex(PackageError, "exact files were not found"):  # nothing to carry the published bytes forward from
            self.run_import(F3, "four", ledger=o1.out / "ledger.next.json", previous=None)

    def test_a_later_snapshot_keeps_maps_that_this_source_no_longer_lists(self):
        o1, _ = self.run_import(None, "one")
        fewer = [m for m in MAPS if m[0] != 2522]
        o2, r2 = self.run_import(make_export(maps=fewer), "two", ledger=o1.out / "ledger.next.json", previous=o1.out / "dist")
        idx = json.loads((o2.out / "dist/atlas/index.json").read_text())
        e = next(x for x in idx["maps"] if x["uiMapId"] == 2522)
        self.assertEqual((e["availability"], e["versions"]), ("published-earlier", ["v1"]))
        self.assertTrue((o2.out / "dist/forever/2522/v1/base.webp").is_file())
        self.assertEqual(file_table(o1.out / "dist/forever/2522"), file_table(o2.out / "dist/forever/2522"))
        self.assertEqual(verify_superset(o2.out / "dist", json.loads((o2.out / "ledger.next.json").read_text())), [])

    def test_a_tampered_previous_snapshot_is_refused(self):
        o1, _ = self.run_import(None, "one")
        bad = self.work / "bad"
        shutil.copytree(o1.out / "dist", bad)
        (bad / "forever/2522/v1/base.webp").write_bytes(b"tampered")
        fewer = make_export(maps=[m for m in MAPS if m[0] != 2522])  # 2522 can now only come from the previous snapshot
        with self.assertRaisesRegex(PackageError, "exact files were not found"):
            self.run_import(fewer, "two", ledger=o1.out / "ledger.next.json", previous=bad)

    def test_identical_images_inside_one_map_are_stored_once_and_every_reference_resolves(self):
        from mapatlas.exporter_zip import SourceImage, SourceMap, SourceVariant
        def v(name, kind, data_sha):
            im = SourceImage("overview", f"maps/1/{name}/o.webp", 10, 10, 3, data_sha, "webp", 0, b"abc")
            return SourceVariant(name, kind, 1, 0, True, "exported", None, None, {}, "m", [im])
        sm = SourceMap({"uiMapId": 1}, [v("base", "base", "aa" * 32), v("alt", "base", "aa" * 32)])
        plan = plan_files(sm, ImportOptions(Path("x"), Path("y"), Path("z")))
        self.assertEqual(list(plan.files), ["base.webp"])
        self.assertEqual(plan.names[("alt", "overview", 0)], "base.webp")
        self.assertEqual(plan.aliases, {("alt", "overview", 0): "base.webp"})


class CliAndHeuristicTests(Base):
    def test_cli_import_and_refusal(self):
        zp = self.zip()
        led = self.work / "l.json"
        shutil.copy(REAL_LEDGER, led)
        atlas.main(["import-exporter", "--zip", str(zp), "--out", str(self.work / "o"), "--ledger", str(led), "--expect-maps", "9", "--expect-variants", "12", "--expect-instances", "4"])
        self.assertTrue((self.work / "o/dist/atlas/instances.json").is_file())
        with self.assertRaises(SystemExit) as cm:
            atlas.main(["import-exporter", "--zip", str(zp), "--out", str(self.work / "o2"), "--ledger", str(led), "--expect-maps", "60"])
        self.assertIn("import refused", str(cm.exception))
        atlas.main(["verify-dist", "--dist", str(self.work / "o/dist"), "--ledger", str(self.work / "o/ledger.next.json")])

    def test_existing_acquisition_commands_remain(self):
        import argparse
        p = atlas.main.__code__.co_names
        for cmd in ("identity", "fetch-db2", "extract", "build", "verify-dist", "promote-ledger", "import-exporter"):
            with self.assertRaises(SystemExit) as cm:
                atlas.main([cmd, "--help"])
            self.assertEqual(cm.exception.code, 0, cmd)

    def test_development_content_heuristics_are_transparent_and_conservative(self):
        self.assertEqual(development_flags({"name": "Test Dungeon", "directory": "test"}), ["name-or-directory-looks-like-development-content"])
        self.assertEqual(development_flags({"name": "CashTest", "directory": "TEST_01"}), ["name-or-directory-looks-like-development-content"])
        self.assertEqual(development_flags({"name": "<unused> Monastery", "directory": "Monastery"}), ["name-marked-unused"])
        for real in ("Deadmines", "Stormwind Stockade", "Alterac Valley", "Latest News Dungeon X", "Contested Ground"):
            self.assertEqual(development_flags({"name": real, "directory": "2720"}), [], real)


if __name__ == "__main__":
    unittest.main()
