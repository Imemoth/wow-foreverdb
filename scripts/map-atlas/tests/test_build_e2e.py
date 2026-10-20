import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import common  # noqa: F401
from common import REPO, ROOT
from PIL import Image
from synth import TILE, Bundle, standard_bundle, tile_blp
import atlas
from mapatlas import packaging
from mapatlas.build import Options, run_build
from mapatlas.packaging import ASSET_PATH_RE, PackageError, check_limits, file_table, verify_manifests, verify_superset
from mapatlas.versioning import Ledger

LEGACY = REPO / "web/public/maps"
REAL_LEDGER = ROOT / "ledger/published.json"
REF = LEGACY / "forever/1420/v1/tirisfal-glades.webp"
FIXTURE = ROOT / "tests/fixtures/sample-manifest.json"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def opts(work: Path, bundle: Path, name="out", ledger=None, previous=None, **kw) -> Options:
    led = work / f"{name}-ledger.json"
    shutil.copy(ledger or REAL_LEDGER, led)
    return Options(bundle, work / name, led, previous, LEGACY, REF, **kw)


class BuildCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.work = Path(cls.tmp.name)
        cls.b = standard_bundle(cls.work / "bundle")
        cls.b.finish()
        cls.o = opts(cls.work, cls.work / "bundle")
        cls.report = run_build(cls.o)
        cls.dist = cls.o.out / "dist"

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def index(self):
        return json.loads((self.dist / "atlas/index.json").read_text())

    def manifest(self, mid, ver):
        return json.loads((self.dist / f"forever/{mid}/{ver}/manifest.json").read_text())


class CoverageAndLayoutTests(BuildCase):
    def test_client_build_identity_is_carried_everywhere(self):
        builds = json.loads((self.dist / "atlas/builds.json").read_text())
        self.assertEqual(builds["latest"], "1.60.1.70450")
        self.assertEqual(builds["builds"][0]["buildKey"], "ab" * 16)
        self.assertEqual(builds["builds"][0]["tool"]["name"], "azerdex-map-atlas")
        self.assertEqual(self.manifest(2023, "v1")["clientBuild"], {"product": "wow_classic_beta", "version": "1.60.1.70450", "buildKey": "ab" * 16, "buildNumber": 70450})
        self.assertIn("matches the build used", self.report["client"]["referenceBuildNote"])

    def test_discovery_and_extraction_coverage_are_reported_separately(self):
        d, x = self.report["discovery"], self.report["extraction"]
        self.assertEqual((d["totalUiMapEntries"], d["withUsableArtwork"], d["withoutOwnArtwork"]), (14, 9, 5))
        self.assertEqual((x["exportedMaps"], x["failedMaps"], x["mapsWithoutArtwork"]), (7, 2, 5))
        self.assertEqual(x["extractionRatioOfDrawable"], round(7 / 9, 4))
        self.assertEqual(x["exportedByCategory"], {"continent": 1, "dungeon": 2, "world": 1, "zone": 3})
        self.assertEqual(x["exportedWorldContinent"], [947, 1414])
        self.assertEqual(x["missingTileFileDataIds"], 1)
        self.assertEqual(d["unknownTypeIds"], [9])
        self.assertEqual(d["alternateArtVariants"], 1)
        self.assertFalse(self.report["complete"]["allDrawableExported"])
        self.assertTrue(self.report["complete"]["everyDrawableMapExportedOrDocumented"])  # every miss has a documented reason
        self.assertIn("city", json.dumps(d["cityMaps"]).lower())

    def test_every_non_exported_map_has_a_documented_reason(self):
        ex = {e["uiMapId"]: e for e in self.report["exceptions"]}
        self.assertEqual(sorted(ex), [946, 1500, 2022, 2024, 4000, 4001, 4002])
        self.assertTrue(all(e["reasons"] for e in ex.values()))
        self.assertIn("incomplete tile coverage", ex[2022]["reasons"])
        self.assertIn("image is blank (no tonal variation)", ex[4000]["reasons"])

    def test_forever_specific_zones_are_resolved_dynamically_from_client_metadata(self):
        st = {f["name"]: f["status"] for f in self.report["foreverSpecific"]}
        self.assertEqual(st, {"Zephras Isle": "export-failed", "Riverglades": "no-artwork", "Shen'dralas": "not-found-in-client-metadata", "Mount Hyjal": "exported"})

    def test_duplicate_art_under_different_ids_is_flagged_not_hidden(self):
        dup = self.report["validation"]["duplicateArtAcrossMaps"]
        self.assertEqual(len(dup), 1)
        self.assertEqual(sorted(m["uiMapId"] for m in dup[0]["maps"]), [1414, 3000])

    def test_alternate_variants_layers_and_floors_are_exported(self):
        m = self.manifest(1414, "v1")
        self.assertEqual((m["image"]["file"], m["image"]["width"], m["image"]["height"], m["mapArtId"]), ("overview.webp", 700, 520, 7001))
        self.assertEqual(sorted(v["file"] for v in m["variants"]), ["layer-1.webp", "variant-7002.webp"])
        self.assertEqual(self.manifest(1501, "v1")["floor"], {"groupId": 55, "floorIndex": 0})
        self.assertEqual(self.manifest(1501, "v1")["parentUiMapId"], 1500)
        self.assertEqual(self.manifest(1501, "v1")["instanceType"], "dungeon")
        self.assertEqual(self.manifest(1501, "v1")["mapIds"], [36])

    def test_hierarchy_and_atlas_index_support_listing_by_parent_type_name_build_availability(self):
        h = json.loads((self.dist / "atlas/hierarchy.json").read_text())
        self.assertEqual(h["nodes"]["1414"]["children"], [1420, 1500, 2022, 2023, 2024, 3000, 4000, 4002])
        self.assertEqual(h["nodes"]["1500"]["children"], [1501, 1502])
        self.assertIn(946, h["roots"])
        self.assertTrue(h["issues"])
        idx = self.index()
        lk = idx["lookup"]
        self.assertEqual(lk["byParent"]["947"], [1414])
        self.assertIn(1420, lk["byType"]["zone"])
        self.assertEqual(lk["byType"]["micro"], [1501, 1502])
        self.assertEqual(lk["byCategory"]["dungeon"], [1500, 1501, 1502])
        self.assertEqual(lk["byName"]["mount-hyjal"], [2023])
        self.assertEqual(lk["byAvailability"]["available"], [947, 1414, 1420, 1501, 1502, 2023, 3000])
        self.assertEqual(lk["byAvailability"]["export-failed"], [2022, 4000])
        self.assertIn(1420, lk["byBuild"]["1.60.1.70450"])
        e = next(m for m in idx["maps"] if m["uiMapId"] == 1420)
        self.assertEqual((e["latestVersion"], e["versions"]), ("v2", ["v1", "v2"]))

    def test_every_dist_path_follows_the_cdn_convention_and_resolveMapAssetUrl_contract(self):
        for rel in packaging.list_files(self.dist):
            self.assertTrue(ASSET_PATH_RE.match(rel) or rel.startswith("atlas/") or rel == "_headers", rel)
        # /forever/{uiMapID}/{version}/{filename}
        self.assertTrue((self.dist / "forever/2023/v1/overview.webp").is_file())
        self.assertEqual(sorted(p.name for p in (self.dist / "forever/1420").iterdir()), ["v1", "v2"])
        self.assertIn("immutable", (self.dist / "_headers").read_text())

    def test_manifests_are_consistent_with_their_files(self):
        self.assertEqual(verify_manifests(self.dist), [])
        for mp in self.dist.glob("forever/*/*/manifest.json"):
            m = json.loads(mp.read_text())
            self.assertEqual(m["zoneId"], m.get("uiMapId", m["zoneId"]))
            self.assertEqual(m["calibration"]["status"], "provisional")  # never auto-validated
            self.assertEqual(m["projection"]["origin"], "top-left")
            with Image.open(mp.parent / m["image"]["file"]) as im:
                self.assertEqual((im.format, im.size), ("WEBP", (m["image"]["width"], m["image"]["height"])))
            self.assertEqual(sha(mp.parent / m["image"]["file"]), m["image"]["sha256"])
            self.assertEqual((mp.parent / m["image"]["file"]).stat().st_size, m["image"]["bytes"])
            if "pixelSha256" in m["image"]:  # the legacy v1 manifest predates this field
                self.assertRegex(m["image"]["pixelSha256"], r"^[0-9a-f]{64}$")

    def test_tirisfal_v1_is_preserved_byte_for_byte_and_regression_evidence_recorded(self):
        for n in ("manifest.json", "tirisfal-glades.webp"):
            self.assertEqual(sha(self.dist / "forever/1420/v1" / n), sha(LEGACY / "forever/1420/v1" / n))
        v2 = self.manifest(1420, "v2")
        self.assertEqual((v2["image"]["width"], v2["image"]["height"]), (1002, 668))
        reg = v2["calibration"]["registration"]
        self.assertTrue(reg["sameDimensions"])
        self.assertIn(reg["verdict"], ("matches-reference", "cropped-or-shifted", "differs"))
        self.assertEqual(v2["calibration"]["status"], "provisional")
        self.assertEqual(self.report["tirisfalRegression"], reg)

    def test_ledger_is_extended_not_rewritten_and_the_repo_ledger_is_untouched(self):
        nxt = json.loads((self.o.out / "ledger.next.json").read_text())
        base = json.loads(REAL_LEDGER.read_text())
        self.assertEqual(nxt["maps"]["1420"]["v1"], base["maps"]["1420"]["v1"])
        self.assertIn("v2", nxt["maps"]["1420"])
        self.assertEqual(sorted(self.report["package"]["newVersionsThisRun"]), sorted([f"{m}/v1" for m in ("1414", "1501", "1502", "2023", "3000", "947")] + ["1420/v2"]))
        self.assertEqual(json.loads(REAL_LEDGER.read_text()), base)

    def test_package_stays_within_cloudflare_pages_free_limits(self):
        lim = self.report["package"]["limits"]
        self.assertLessEqual(lim["fileCount"], 20_000)
        self.assertLessEqual(lim["largestBytes"], 25 * 1024 * 1024)
        self.assertEqual(lim["problems"], [])
        self.assertTrue((self.o.out / f"atlas-dist-1.60.1.70450.zip").is_file())
        self.assertTrue((self.o.out / "preview/index.html").is_file())
        self.assertTrue((self.o.out / "reports/coverage.md").is_file())


class DeterminismAndVersioningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.b = standard_bundle(self.work / "bundle")
        self.b.finish()

    def test_same_inputs_give_identical_dist_and_zip(self):
        a = run_build(opts(self.work, self.work / "bundle", "a"))
        b = run_build(opts(self.work, self.work / "bundle", "b"))
        self.assertEqual(file_table(self.work / "a/dist"), file_table(self.work / "b/dist"))
        self.assertEqual(a["package"]["zip"]["sha256"], b["package"]["zip"]["sha256"])

    def test_rerun_with_previous_snapshot_reuses_versions(self):
        first = opts(self.work, self.work / "bundle", "one")
        run_build(first)
        second = opts(self.work, self.work / "bundle", "two", ledger=first.out / "ledger.next.json", previous=first.out / "dist")
        r = run_build(second)
        self.assertEqual(r["package"]["newVersionsThisRun"], [])
        self.assertEqual(file_table(first.out / "dist"), file_table(second.out / "dist"))

    def test_changed_art_gets_a_new_version_and_the_old_one_stays_published(self):
        first = opts(self.work, self.work / "bundle", "one")
        run_build(first)
        fd = next(f for f in range(900001, 900400) if (self.work / f"bundle/blp/{f}.blp").is_file() and f in self._fds(2023))
        (self.work / f"bundle/blp/{fd}.blp").write_bytes(tile_blp(0, 0, 600, 400, 200))
        (self.work / "bundle/build.json").write_text(json.dumps({"product": "wow_classic_beta", "version": "1.60.1.70451", "buildKey": "cd" * 16, "buildNumber": 70451, "branch": "", "source": "synthetic"}))
        second = opts(self.work, self.work / "bundle", "two", ledger=first.out / "ledger.next.json", previous=first.out / "dist")
        r = run_build(second)
        self.assertEqual(r["package"]["newVersionsThisRun"], ["2023/v2"])
        d1, d2 = first.out / "dist", second.out / "dist"
        for n in ("overview.webp", "manifest.json"):
            self.assertEqual(sha(d1 / "forever/2023/v1" / n), sha(d2 / "forever/2023/v1" / n))  # v1 untouched
        self.assertNotEqual(sha(d2 / "forever/2023/v1/overview.webp"), sha(d2 / "forever/2023/v2/overview.webp"))
        builds = json.loads((d2 / "atlas/builds.json").read_text())
        self.assertEqual([b["version"] for b in builds["builds"]], ["1.60.1.70450", "1.60.1.70451"])
        idx = json.loads((d2 / "atlas/index.json").read_text())
        self.assertEqual(next(m for m in idx["maps"] if m["uiMapId"] == 2023)["versions"], ["v1", "v2"])
        self.assertEqual(idx["lookup"]["byBuild"]["1.60.1.70451"], [2023])
        self.assertEqual(verify_superset(d2, json.loads((second.out / "ledger.next.json").read_text())), [])

    def _fds(self, ui_map_id):
        from mapatlas.inventory import build_inventory
        inv = build_inventory(self.work / "bundle/db2")
        return {f for v in inv.maps[ui_map_id].variants for l in v.layers for f in l.tiles.values()}

    def test_a_later_snapshot_cannot_silently_drop_or_alter_published_maps(self):
        first = opts(self.work, self.work / "bundle", "one")
        run_build(first)
        led = first.out / "ledger.next.json"
        with self.assertRaises(PackageError):  # ledger knows 2023/v1 but no previous snapshot supplied
            run_build(opts(self.work, self.work / "bundle", "x", ledger=led))
        broken = self.work / "broken"
        shutil.copytree(first.out / "dist", broken)
        (broken / "forever/2023/v1/overview.webp").write_bytes(b"tampered")
        with self.assertRaises(PackageError):
            run_build(opts(self.work, self.work / "bundle", "y", ledger=led, previous=broken))
        self.assertTrue(verify_superset(broken, json.loads(led.read_text())))
        (broken / "forever/2023/v1/overview.webp").unlink()
        self.assertIn("missing published file forever/2023/v1/overview.webp", verify_superset(broken, json.loads(led.read_text())))

    def test_expected_client_version_is_enforced(self):
        with self.assertRaisesRegex(PackageError, "expected 1.60.1.99999"):
            run_build(opts(self.work, self.work / "bundle", "e", expect_version="1.60.1.99999"))

    def test_allow_partial_keeps_incomplete_maps_flagged_instead_of_painting_them(self):
        r = run_build(opts(self.work, self.work / "bundle", "p", allow_partial=True))
        m = json.loads((self.work / "p/dist/forever/2022/v1/manifest.json").read_text())
        self.assertTrue(m["provenance"]["partial"])
        self.assertTrue(any("missing" in w for w in m["provenance"]["warnings"]))
        self.assertEqual(r["extraction"]["partialImages"], 1)
        with Image.open(self.work / "p/dist/forever/2022/v1/overview.webp") as f:
            im = f.convert("RGBA")
        self.assertLess(im.getpixel((400, 300))[3], 255)  # the missing region is still transparent

    def test_html_gallery_escapes_untrusted_names(self):
        w = self.work / "xss"
        b = Bundle(w / "bundle")
        b.add_map(1, "<script>alert(1)</script>", 0, 3)
        b.add_art(1, 1, 1, [(0, 512, 256)])
        b.finish()
        run_build(opts(w, w / "bundle"))
        page = (w / "out/preview/index.html").read_text()
        self.assertNotIn("<script>alert", page)
        self.assertIn("&lt;script&gt;", page)


class LimitsAndCliTests(unittest.TestCase):
    def test_limit_and_path_checks_catch_violations(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "forever/5/v1").mkdir(parents=True)
            (root / "forever/5/v1/overview.webp").write_bytes(b"x" * 100)
            (root / "forever/5/v1/manifest.json").write_text("{}")
            self.assertEqual(check_limits(root)["problems"], [])
            with mock.patch.object(packaging, "PAGES_MAX_FILES", 1):
                self.assertTrue(any("file limit" in p for p in check_limits(root)["problems"]))
            with mock.patch.object(packaging, "PAGES_MAX_FILE_BYTES", 50):
                self.assertTrue(any("over 50 bytes" in p for p in check_limits(root)["problems"]))
            (root / "stray.txt").write_text("x")
            (root / "forever/5/v1/../bad name.webp").write_bytes(b"x")
            self.assertTrue(any("outside the CDN path convention" in p for p in check_limits(root)["problems"]))

    def test_zip_is_independent_of_file_mtimes(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "t"
            (root / "forever/5/v1").mkdir(parents=True)
            f = root / "forever/5/v1/manifest.json"
            f.write_text("{}")
            z1 = packaging.write_deterministic_zip(root, Path(d) / "a.zip")
            os.utime(f, (1, 1))
            z2 = packaging.write_deterministic_zip(root, Path(d) / "b.zip")
            self.assertEqual(z1["sha256"], z2["sha256"])

    def test_cli_verify_and_promote(self):
        with tempfile.TemporaryDirectory() as d:
            w = Path(d)
            std = standard_bundle(w / "bundle")
            std.finish()
            o = opts(w, w / "bundle")
            run_build(o)
            atlas.main(["verify-dist", "--dist", str(o.out / "dist"), "--ledger", str(o.out / "ledger.next.json")])
            repo_copy = w / "published.json"
            shutil.copy(REAL_LEDGER, repo_copy)
            atlas.main(["promote-ledger", "--from", str(o.out / "ledger.next.json"), "--to", str(repo_copy)])
            self.assertIn("v2", json.loads(repo_copy.read_text())["maps"]["1420"])
            shrunk = w / "shrunk.json"
            L = json.loads((o.out / "ledger.next.json").read_text())
            del L["maps"]["1420"]["v1"]
            shrunk.write_text(json.dumps(L))
            with self.assertRaises(SystemExit):
                atlas.main(["promote-ledger", "--from", str(shrunk), "--to", str(repo_copy)])

    def test_the_repository_ledger_matches_the_committed_poc_asset(self):
        led = json.loads(REAL_LEDGER.read_text())["maps"]["1420"]["v1"]["files"]
        for n, meta in led.items():
            p = LEGACY / "forever/1420/v1" / n
            self.assertEqual((sha(p), p.stat().st_size), (meta["sha256"], meta["bytes"]), f"{n}: the immutable v1 POC asset changed")


def normalise_encoder_output(m: dict) -> dict:
    """WebP bytes/hashes depend on the libwebp build; everything else in a manifest is deterministic."""
    m = json.loads(json.dumps(m))
    for im in [m["image"], *m.get("variants", [])]:
        im["bytes"], im["sha256"] = 1, "0" * 64
    return m


class WebContractFixtureTests(BuildCase):
    def test_sample_manifest_fixture_is_current_and_loadable_by_the_web_app(self):
        text = json.dumps(normalise_encoder_output(self.manifest(2023, "v1")), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        if os.environ.get("UPDATE_FIXTURES"):
            FIXTURE.parent.mkdir(exist_ok=True)
            FIXTURE.write_text(text)
        self.assertEqual(FIXTURE.read_text(), text, "run with UPDATE_FIXTURES=1 to refresh; web/tests/unit/map-atlas-contract.test.ts validates this file")


if __name__ == "__main__":
    unittest.main()
