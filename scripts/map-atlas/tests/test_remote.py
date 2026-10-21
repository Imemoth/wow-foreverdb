import json
import re
import tempfile
import unittest
from pathlib import Path

import common  # noqa: F401
from common import REPO
from mapatlas.asset_url_compat import ALLOWED_ASSET_HOSTS
from mapatlas.packaging import HEADERS
from mapatlas.remote import verify_remote


def make_dist(root: Path) -> None:
    (root / "forever/5/v1").mkdir(parents=True)
    (root / "forever/5/v1/base.webp").write_bytes(b"IMG")
    (root / "forever/5/v1/manifest.json").write_text("{}")
    (root / "atlas").mkdir()
    (root / "atlas/index.json").write_text("{}")
    (root / "_headers").write_text(HEADERS)


class CdnStub:
    def __init__(self, root: Path, **flaw):
        self.root, self.flaw, self.calls = root, flaw, []

    def __call__(self, url):
        rel = url.split("pages.dev/", 1)[1]
        self.calls.append(rel)
        p = self.root / rel
        if rel == self.flaw.get("catch_all_for"):
            return 200, {"access-control-allow-origin": "*"}, b"<html>spa</html>"
        if not p.is_file() or rel == self.flaw.get("missing"):
            return 404, {}, b""
        body = b"TAMPERED" if rel == self.flaw.get("tamper") else p.read_bytes()
        h = {"access-control-allow-origin": "*", "cache-control": "public, max-age=31536000, immutable" if rel.startswith("forever/") else "public, max-age=300, must-revalidate"}
        if rel == self.flaw.get("cache"):
            h["cache-control"] = "no-store"
        if rel == self.flaw.get("nocors"):
            del h["access-control-allow-origin"]
        return 200, h, body


class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        make_dist(self.root)

    def run_(self, **flaw):
        return verify_remote("https://azerdex-assets.pages.dev", self.root, CdnStub(self.root, **flaw))

    def test_matching_remote_passes_and_does_not_fetch_the_pages_config_file(self):
        stub = CdnStub(self.root)
        r = verify_remote("https://azerdex-assets.pages.dev", self.root, stub)
        self.assertEqual((r["ok"], r["checked"]), (True, 3))
        self.assertNotIn("_headers", stub.calls)

    def test_every_class_of_remote_defect_is_caught(self):
        self.assertIn("forever/5/v1/base.webp: bytes differ from the audited distribution", self.run_(tamper="forever/5/v1/base.webp")["problems"])
        self.assertIn("atlas/index.json: HTTP 404", self.run_(missing="atlas/index.json")["problems"])
        self.assertTrue(any("cache-control" in p for p in self.run_(cache="forever/5/v1/manifest.json")["problems"]))
        self.assertTrue(any("Access-Control-Allow-Origin" in p for p in self.run_(nocors="forever/5/v1/base.webp")["problems"]))
        self.assertTrue(any("catch-all" in p for p in self.run_(catch_all_for="forever/9999999/v1/manifest.json")["problems"]))

    def test_only_https_allow_listed_hosts_without_ports_or_credentials_are_accepted(self):
        for bad in ("http://azerdex-assets.pages.dev", "https://evil.example", "https://azerdex-assets.pages.dev:8443", "https://u:p@azerdex-assets.pages.dev",
                    "https://azerdex-assets.pages.dev/sub", "https://azerdex-assets.pages.dev.evil.example", "https://azerdex-assets.pages.dev/?x=1"):
            with self.assertRaises(ValueError, msg=bad):
                verify_remote(bad, self.root, CdnStub(self.root))
        verify_remote("https://assets.azerdex.com", self.root, lambda u: (404, {}, b""))

    def test_host_allow_list_is_identical_to_the_web_resolvers(self):
        src = (REPO / "web/src/lib/maps/asset-url.ts").read_text()
        m = re.search(r"ALLOWED_ASSET_HOSTS: readonly string\[\] = \[(.*?)\]", src)
        self.assertEqual(tuple(re.findall(r'"([^"]+)"', m.group(1))), ALLOWED_ASSET_HOSTS)


if __name__ == "__main__":
    unittest.main()
