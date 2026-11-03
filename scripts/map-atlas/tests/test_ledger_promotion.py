"""The promoted ledgers describe exactly the files of the verified Cloudflare deployment (V2-B): every ledger entry equals the release record that the
live CDN was verified against (Post run PASS 179/179), the previously published 1420/v1 is unchanged, and the promotion record matches the ledger bytes."""
import hashlib
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RELEASE = json.loads((ROOT / "baseline/unified-dist-1.60.1.70450-8da4f1345f65.release.json").read_text(encoding="utf-8"))
ATLAS = json.loads((ROOT / "ledger/published.json").read_text(encoding="utf-8"))
HEROES = json.loads((ROOT / "ledger/zone-heroes.json").read_text(encoding="utf-8"))
RECORD = json.loads((ROOT / "ledger/promotion-04effe36.json").read_text(encoding="utf-8"))
LEGACY_1420_V1 = {  # published before V2 and never allowed to change (pre-promotion ledger content)
    "manifest.json": {"bytes": 1406, "sha256": "342ae5fad6190ef599e45f518de0dc3b75dda6c928b7390368176346e8ba21d7"},
    "tirisfal-glades.webp": {"bytes": 255442, "sha256": "a2856ed85f2545f2604e0a7e7fc41e9f270c78e84bf6c08885f43dd500b97678"},
}


class LedgerPromotionTest(unittest.TestCase):
    def test_every_ledger_file_is_in_the_verified_release(self):
        files, n = RELEASE["files"], 0
        for mid, versions in ATLAS["maps"].items():
            for ver, rec in versions.items():
                for name, f in rec["files"].items():
                    e = files[f"forever/{mid}/{ver}/{name}"]
                    self.assertEqual((e["bytes"], e["sha256"]), (f["bytes"], f["sha256"]), f"{mid}/{ver}/{name}")
                    n += 1
        for zid, versions in HEROES["zones"].items():
            for ver, rec in versions.items():
                for name, f in rec["files"].items():
                    e = files[f"zone-heroes/{zid}/{ver}/{name}"]
                    self.assertEqual((e["bytes"], e["sha256"]), (f["bytes"], f["sha256"]), f"{zid}/{ver}/{name}")
                    n += 1
        self.assertEqual(n, 175)  # 167 atlas files (61 manifests + 106 images) + 8 zone heroes

    def test_the_release_is_fully_covered_by_the_ledgers(self):
        covered = {f"forever/{m}/{v}/{n}" for m, vs in ATLAS["maps"].items() for v, r in vs.items() for n in r["files"]}
        covered |= {f"zone-heroes/{z}/{v}/{n}" for z, vs in HEROES["zones"].items() for v, r in vs.items() for n in r["files"]}
        immutable = {p for p in RELEASE["files"] if p.startswith(("forever/", "zone-heroes/"))}
        self.assertEqual(covered, immutable)

    def test_published_1420_v1_is_unchanged_and_versions_are_append_only(self):
        self.assertEqual(ATLAS["maps"]["1420"]["v1"]["files"], LEGACY_1420_V1)
        self.assertEqual((len(ATLAS["maps"]), sum(len(v) for v in ATLAS["maps"].values())), (60, 61))
        self.assertEqual({z: sorted(v) for z, v in HEROES["zones"].items()}, {"1424": ["v1"], "1431": ["v1"]})

    def test_promotion_record_matches_the_ledger_bytes_and_the_deployment(self):
        for key, name in (("atlasLedger", "ledger/published.json"), ("heroLedger", "ledger/zone-heroes.json")):
            self.assertEqual(RECORD["promoted"][key]["sha256"], hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), name)
        self.assertEqual(RECORD["promoted"]["atlasLedger"]["versions"], 61)
        self.assertEqual(RECORD["promoted"]["heroLedger"]["versions"], 2)
        cf = RECORD["cloudflare"]
        self.assertEqual((cf["deploymentId"], cf["rollbackDeploymentId"], cf["servedFiles"]), ("04effe36-d1e6-45b8-a529-fa32136d1b38", "3ae723a0-df00-4dcd-9159-8ba93d0583aa", 179))
        self.assertEqual(RECORD["package"]["zip"], RELEASE["zip"])
        self.assertEqual(RECORD["package"]["distLabel"], RELEASE["distLabel"])


if __name__ == "__main__":
    unittest.main()
