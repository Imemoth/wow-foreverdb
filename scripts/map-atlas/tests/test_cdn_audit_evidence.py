"""The owner's Cloudflare Pages baseline audit (docs/web/evidence/v2b-cdn-baseline-audit-2026-10-22.json) must stay consistent with the committed pin and
release record. The Cloudflare content ids (BLAKE3 of base64(bytes)+extension, first 32 hex chars) are recomputed from the private baseline zip when it
and the optional `blake3` package are available."""
import base64
import hashlib
import json
import os
import unittest
import zipfile
from pathlib import Path

import common  # noqa: F401
from common import REPO, ROOT

AUDIT = REPO / "docs/web/evidence/v2b-cdn-baseline-audit-2026-10-22.json"
PIN = ROOT / "baseline/atlas-dist-1.60.1.70450.json"
RELEASE = ROOT / "baseline/unified-dist-1.60.1.70450-8da4f1345f65.release.json"


def fingerprint(ids: dict[str, str]) -> str:
    return hashlib.sha256("".join(f"{p}:{ids[p]}\n" for p in sorted(ids)).encode("utf-8")).hexdigest()


class AuditEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.a = json.loads(AUDIT.read_text(encoding="utf-8"))
        cls.pin = json.loads(PIN.read_text())
        cls.rel = json.loads(RELEASE.read_text())

    def test_audit_lists_exactly_the_171_served_baseline_files_with_the_pinned_hashes(self):
        files = self.a["files"]
        self.assertEqual((self.a["verdict"], len(files), self.a["baseline_served_asset_count"], self.a["cloudflare_deployment_file_count"]), ("PASS_FILE_CONTENT_ID_MATCH_171_OF_171", 171, 171, 171))
        self.assertEqual([f["path"] for f in files], sorted(f["path"] for f in files))
        served = {"/" + p: m for p, m in self.pin["files"].items() if p != "_headers"}  # _headers is Pages configuration, never an asset
        self.assertEqual({f["path"] for f in files}, set(served))
        for f in files:
            self.assertEqual((f["sha256"], f["bytes"]), (served[f["path"]]["sha256"], served[f["path"]]["bytes"]), f["path"])

    def test_identifiers_and_fingerprints_are_self_consistent(self):
        a = self.a
        ids = {f["path"]: f["cloudflare_content_id"] for f in a["files"]}
        self.assertTrue(all(len(v) == 32 and v == v.lower() for v in ids.values()))
        self.assertEqual(fingerprint(ids), a["baseline_computed_manifest_sha256"])
        self.assertEqual(a["baseline_computed_manifest_sha256"], a["cloudflare_api_live_deployment_manifest_sha256"])
        self.assertEqual((a["path_mismatches"], a["content_id_mismatches"]), (0, 0))
        self.assertEqual(a["baseline_zip_sha256"], self.pin["distributionZipSha256"])
        self.assertEqual(a["unified_zip_sha256"], self.rel["zip"]["sha256"])
        self.assertEqual((a["cloudflare_project"], a["cloudflare_production_branch"], a["cloudflare_deployment_id"], a["cloudflare_deployment_status"]),
                         ("azerdex-assets", "main", "3ae723a0-df00-4dcd-9159-8ba93d0583aa", "success"))

    def test_the_audit_does_not_claim_http_checks_it_did_not_perform(self):
        self.assertEqual(set(self.a["not_verified"]), {"HTTP status responses for all assets", "Cache-Control/CORS/Content-Type headers", "404 probes",
                                                      "Actual browser image decoding from production CDN"})

    def test_content_ids_recompute_from_the_private_baseline_zip(self):
        zp = os.environ.get("ATLAS_BASELINE_ZIP")
        if not zp or not Path(zp).is_file():
            self.skipTest("set ATLAS_BASELINE_ZIP (private artwork) to recompute the Cloudflare content ids")
        try:
            import blake3
        except ImportError:
            self.skipTest("pip install blake3")
        z = zipfile.ZipFile(zp)
        want = {f["path"]: f["cloudflare_content_id"] for f in self.a["files"]}
        got = {"/" + n: blake3.blake3((base64.b64encode(z.read(n)).decode() + os.path.splitext(n)[1][1:]).encode()).hexdigest()[:32] for n in z.namelist() if n != "_headers"}
        self.assertEqual(got, want)
        self.assertEqual(fingerprint(got), self.a["baseline_computed_manifest_sha256"])


if __name__ == "__main__":
    unittest.main()
