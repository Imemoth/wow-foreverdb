"""Acceptance test against the owner's REAL export. Skipped unless ATLAS_REAL_EXPORT_ZIP points at the ZIP (it is private game artwork and
never lives in Git/CI). Run locally:  ATLAS_REAL_EXPORT_ZIP=/path/ForeverDB-Atlas-Export-1.60.1.70450.zip python -m unittest test_real_source -v
Optional: ATLAS_REAL_EXPORT_SHA256 pins the archive; ATLAS_REAL_DIST_OUT keeps the produced output folder for the web checks."""
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

import common  # noqa: F401
from common import REPO, ROOT
from mapatlas.importer import ImportOptions, run_import
from mapatlas.packaging import file_table, list_files, verify_catalog, verify_superset

ZIP = os.environ.get("ATLAS_REAL_EXPORT_ZIP")
LEGACY = REPO / "web/public/maps"


@unittest.skipUnless(ZIP and Path(ZIP).is_file(), "ATLAS_REAL_EXPORT_ZIP not set (private real export)")
class RealSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keep = os.environ.get("ATLAS_REAL_DIST_OUT")
        cls.tmp = tempfile.TemporaryDirectory()
        cls.work = Path(cls.keep or cls.tmp.name)
        cls.work.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / "ledger/published.json", cls.work / "ledger.in.json")
        cls.o = ImportOptions(Path(ZIP), cls.work / "out", cls.work / "ledger.in.json", None, LEGACY, LEGACY / "forever/1420/v1/tirisfal-glades.webp",
                              expect_version="1.60.1.70450", expect_zip_sha256=os.environ.get("ATLAS_REAL_EXPORT_SHA256"),
                              expect_maps=60, expect_variants=105, expect_instances=55)
        cls.r = run_import(cls.o)
        cls.dist = cls.o.out / "dist"

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_source_claims_are_independently_true(self):
        c = self.r["counts"]
        self.assertEqual((c["maps"], c["mapsWithArtwork"], c["variants"], c["images"]), (60, 60, 105, 105))
        self.assertEqual(c["byCategory"], {"city": 6, "continent": 4, "instance": 4, "world": 1, "zone": 45})
        self.assertEqual(c["instances"]["byClassification"], {"battleground": 5, "dungeon": 37, "raid": 13})
        self.assertEqual((c["instances"]["records"], c["instances"]["drawable"], c["instances"]["withoutInteriorMap"]), (55, 4, 51))
        self.assertEqual(self.r["source"]["status"], "COMPLETE")
        self.assertEqual(self.r["source"]["client"]["version"], "1.60.1.70450")
        self.assertEqual(self.r["source"]["client"]["product"], "wow_classic_beta")

    def test_full_reveal_variants_including_the_four_repaired_ones(self):
        fr = self.r["fullReveal"]
        self.assertEqual(fr["mapsWithFullReveal"], 45)
        self.assertEqual(fr["completeness"], {"complete": 44, "tileless-declared-overlays-skipped": 1})
        self.assertEqual(fr["defaultVariantCounts"], {"base": 15, "full-reveal": 45})
        for mid in (1412, 1434, 2521, 2548):
            m = json.loads(next((self.dist / f"forever/{mid}").glob("v*/manifest.json")).read_text())
            self.assertEqual(m["defaultImage"]["variant"], "full-reveal", mid)
            self.assertEqual(sorted(v["variant"] for v in m["variants"]), ["base", "full-reveal"], mid)
        self.assertEqual(sorted(fr["mapsWithDefaultWarnings"]), ["1434"])  # the one tileless-overlay reveal

    def test_package_shape_limits_and_immutability(self):
        p = self.r["package"]
        self.assertEqual((p["imageFiles"], p["manifests"], p["immutableVersions"]), (106, 61, 61))
        self.assertEqual(len(p["newVersionsThisRun"]), 60)
        self.assertIn("1420/v2", p["newVersionsThisRun"])
        self.assertEqual(p["limits"], {"files": 20000, "fileBytes": 26214400})
        self.assertLessEqual(p["fileCount"], 20_000)
        self.assertLessEqual(p["largestBytes"], 25 * 1024 * 1024)
        self.assertTrue(all(x["ok"] for x in self.r["preflight"]), [x for x in self.r["preflight"] if not x["ok"]])
        for n in ("manifest.json", "tirisfal-glades.webp"):
            self.assertEqual((self.dist / "forever/1420/v1" / n).read_bytes(), (LEGACY / "forever/1420/v1" / n).read_bytes())
        self.assertEqual(verify_catalog(self.dist), [])
        self.assertEqual(verify_superset(self.dist, json.loads((self.o.out / "ledger.next.json").read_text())), [])

    def test_instances_are_preserved_and_not_presented_as_released(self):
        inst = json.loads((self.dist / "atlas/instances.json").read_text())
        by = {r["mapId"]: r for r in inst["instances"]}
        self.assertEqual(sorted(r["mapId"] for r in inst["instances"] if r["drawable"]), [30, 489, 529, 2997])
        self.assertEqual({by[i]["name"] for i in (30, 489, 529, 2997)}, {"Alterac Valley", "Warsong Gulch", "Arathi Basin", "Darkspear Islands"})
        self.assertFalse(by[3005]["drawable"])  # Battle for Gilneas: a battleground record without interior art
        self.assertTrue(all(r["catalog"]["releaseStatus"] == "unverified" and r["catalog"]["visibility"] == "unreviewed" for r in inst["instances"]))
        self.assertEqual({13, 29, 44}, {i for i, r in by.items() if r["catalog"]["developmentFlags"]})
        self.assertTrue(all(r["uiMaps"] == [] for r in inst["instances"] if not r["drawable"]))

    def test_deterministic_and_idempotent_on_the_real_source(self):
        out2 = self.work / "again"
        shutil.copy(ROOT / "ledger/published.json", self.work / "ledger2.in.json")
        r2 = run_import(ImportOptions(Path(ZIP), out2, self.work / "ledger2.in.json", None, LEGACY, self.o.reference_1420, expect_maps=60, expect_variants=105, expect_instances=55))
        self.assertEqual(file_table(self.dist), file_table(out2 / "dist"))
        self.assertEqual(r2["package"]["zip"]["sha256"], self.r["package"]["zip"]["sha256"])
        r3 = run_import(ImportOptions(Path(ZIP), self.work / "idem", self.o.out / "ledger.next.json", self.dist, LEGACY, self.o.reference_1420))
        self.assertEqual(r3["package"]["newVersionsThisRun"], [])


if __name__ == "__main__":
    unittest.main()
