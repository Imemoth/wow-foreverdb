"""windows/Verify-AzerdexCdn.ps1 against a local Pages stand-in (http, via -AllowTestBase). Runs only where PowerShell 7 (`pwsh`) is installed
(GitHub's ubuntu runners have it); the same script is what the owner runs on Windows PowerShell 5.1/7. Proves PASS on matching content and FAIL for
every defect class, so a PASS verdict cannot come from an unreachable host or a lenient check."""
import http.server
import json
import shutil
import subprocess
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path

import common  # noqa: F401
from common import ROOT
from mapatlas.packaging import UNIFIED_HEADERS
from mapatlas.unified import headers_for, parse_headers

PWSH = shutil.which("pwsh")
SCRIPT = ROOT / "windows/Verify-AzerdexCdn.ps1"
RELEASE = ROOT / "baseline/unified-dist-1.60.1.70450-8da4f1345f65.release.json"
PIN = ROOT / "baseline/atlas-dist-1.60.1.70450.json"
RULES = parse_headers(UNIFIED_HEADERS)


def synthetic_table(root: Path, names: dict[str, bytes]) -> Path:
    import hashlib
    files = {}
    for n, b in names.items():
        (root / n).parent.mkdir(parents=True, exist_ok=True)
        (root / n).write_bytes(b)
        files[n] = {"sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)}
    return files


class Pages(http.server.BaseHTTPRequestHandler):
    root: Path
    flaws: dict = {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        rel = self.path.lstrip("/").split("?")[0]
        f = self.root / rel
        if rel in self.flaws.get("fallback", ()):
            return self._send(200, b"<html>spa</html>", {"Content-Type": "text/html"})
        if rel == "_headers" or not f.is_file() or rel in self.flaws.get("missing", ()):
            return self._send(404, b"nf", {})
        body = f.read_bytes()
        if rel in self.flaws.get("tamper", ()):
            body = body + b"x"
        h = {k: v for k, v in headers_for(RULES, rel).items()}
        h["Content-Type"] = "image/webp" if rel.endswith(".webp") else "application/json"
        if rel in self.flaws.get("cache", ()):
            h["Cache-Control"] = "no-store"
        if rel in self.flaws.get("ctype", ()):
            h["Content-Type"] = "application/octet-stream"
        self._send(200, body, h)

    def _send(self, code, body, headers):
        self.send_response(code)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@unittest.skipUnless(PWSH, "PowerShell 7 (pwsh) not installed")
class PowerShellVerifyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.work = Path(cls.tmp.name)
        # a small synthetic "unified" snapshot with the real path convention (the real 180-file table needs private artwork)
        names = {"atlas/index.json": b"{}", "atlas/hierarchy.json": b"{}", "atlas/builds.json": b"{}", "atlas/instances.json": b"{}"}
        for i in range(1, 51):
            names[f"forever/{1000 + i}/v1/base.webp"] = b"RIFFxxxxWEBP" + bytes([i]) * 40
            names[f"forever/{1000 + i}/v1/manifest.json"] = b'{"k":%d}' % i
        names["forever/1420/v2/full-reveal.webp"] = b"RIFFxxxxWEBPfull"
        for z in (1424, 1431):
            for f in ("desktop-1280", "desktop-2000", "mobile-600", "mobile-900"):
                names[f"zone-heroes/{z}/v1/{f}.webp"] = b"RIFFxxxxWEBP" + f.encode() + str(z).encode()
        cls.dist = cls.work / "dist"
        files = synthetic_table(cls.dist, names)
        (cls.dist / "_headers").write_text(UNIFIED_HEADERS)
        import hashlib
        files["_headers"] = {"sha256": hashlib.sha256(UNIFIED_HEADERS.encode()).hexdigest(), "bytes": len(UNIFIED_HEADERS.encode())}
        cls.table = cls.work / "release.json"
        cls.table.write_text(json.dumps({"kind": "azerdex-cdn-unified-release", "files": files}))
        base_files = {k: v for k, v in files.items() if not k.startswith("zone-heroes/")}
        cls.base_table = cls.work / "pin.json"
        cls.base_table.write_text(json.dumps({"kind": "azerdex-cdn-baseline", "files": base_files}))
        cls.zip = cls.work / "dist.zip"
        with zipfile.ZipFile(cls.zip, "w") as z:
            for n in files:
                z.write(cls.dist / n, n)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def serve(self, **flaws):
        Pages.root, Pages.flaws = self.dist, flaws
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Pages)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        self.addCleanup(srv.server_close)
        return f"http://127.0.0.1:{srv.server_port}"

    def run_ps(self, *args):
        ev = self.work / "ev.json"
        p = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-File", str(SCRIPT), *args, "-EvidencePath", str(ev)], capture_output=True, text=True, timeout=300)
        return p.returncode, p.stdout + p.stderr, (json.loads(ev.read_text(encoding="utf-8-sig")) if ev.exists() else None)

    def test_post_passes_on_matching_content_and_headers(self):
        url = self.serve()
        code, out, ev = self.run_ps("-Mode", "Post", "-BaseUrl", url, "-TablePath", str(self.table), "-AllowTestBase")
        self.assertEqual(code, 0, out)
        self.assertEqual((ev["verdict"], ev["checked"], ev["ok"], ev["failures"]), ("PASS", 113, 113, []))
        self.assertTrue(all(p["status"] == 404 for p in ev["probes"] if p["path"] in ("forever/9999999/v1/manifest.json", "zone-heroes/1424/v999/desktop-1280.webp")))

    def test_baseline_mode_passes_when_heroes_are_not_there_yet_and_warns_when_they_are(self):
        url = self.serve(missing={f"zone-heroes/{z}/v1/{f}.webp" for z in (1424, 1431) for f in ("desktop-1280", "desktop-2000", "mobile-600", "mobile-900")})
        code, out, ev = self.run_ps("-Mode", "Baseline", "-BaseUrl", url, "-TablePath", str(self.base_table), "-AllowTestBase")
        self.assertEqual((code, ev["verdict"], ev["warnings"]), (0, "PASS", []), out)
        url = self.serve()  # heroes already live
        code, out, ev = self.run_ps("-Mode", "Baseline", "-BaseUrl", url, "-TablePath", str(self.base_table), "-AllowTestBase")
        self.assertEqual((code, ev["verdict"]), (0, "PASS"))
        self.assertTrue(any("NOT the atlas-only baseline" in w for w in ev["warnings"]))

    def test_every_defect_class_is_a_fail(self):
        hero = "zone-heroes/1424/v1/desktop-1280.webp"
        cases = {
            "bytes differ": dict(tamper={"forever/1001/v1/base.webp"}),
            "HTTP 404, expected 200": dict(missing={"atlas/index.json"}),
            "header cache-control": dict(cache={hero}),
            "Content-Type": dict(ctype={hero}),
            "fallback page": dict(fallback={"forever/9999999/v1/manifest.json"}),
        }
        for needle, flaw in cases.items():
            url = self.serve(**flaw)
            code, out, ev = self.run_ps("-Mode", "Post", "-BaseUrl", url, "-TablePath", str(self.table), "-AllowTestBase")
            self.assertEqual((code, ev["verdict"]), (1, "FAIL"), needle)
            self.assertTrue(any(needle in f for f in ev["failures"]), f"{needle}: {ev['failures']}")

    def test_unreachable_host_is_never_a_pass(self):
        code, out, ev = self.run_ps("-Mode", "Post", "-BaseUrl", "http://127.0.0.1:9", "-TablePath", str(self.table), "-AllowTestBase", "-TimeoutSec", "3")
        self.assertEqual((code, ev["verdict"], ev["ok"]), (1, "FAIL", 0))
        self.assertTrue(any("NOT a verification" in f for f in ev["failures"]))

    def test_non_allow_listed_base_urls_are_refused_without_the_test_switch(self):
        for bad in ("http://azerdex-assets.pages.dev", "https://evil.example", "https://azerdex-assets.pages.dev:8443", "https://azerdex-assets.pages.dev/sub", "http://127.0.0.1:8080", "https://a.b.azerdex-assets.pages.dev", "https://azerdex-assets.pages.dev.evil.example"):
            code, out, ev = self.run_ps("-Mode", "Post", "-BaseUrl", bad, "-TablePath", str(self.table))
            self.assertNotEqual(code, 0, bad)
            self.assertIn("Refusing base URL", out, bad)

    def test_local_mode_verifies_a_zip_and_a_folder_and_catches_tampering(self):
        code, out, ev = self.run_ps("-Mode", "Local", "-LocalDist", str(self.zip), "-TablePath", str(self.table))
        self.assertEqual((code, ev["verdict"], ev["checked"], ev["ok"]), (0, "PASS", 114, 114), out)
        self.assertEqual(len(ev["archiveSha256"]), 64)
        code, out, ev = self.run_ps("-Mode", "Local", "-LocalDist", str(self.dist), "-TablePath", str(self.table))
        self.assertEqual((code, ev["verdict"]), (0, "PASS"))
        bad = self.work / "bad.zip"
        with zipfile.ZipFile(bad, "w") as z:
            for n in json.loads(self.table.read_text())["files"]:
                z.writestr(n, b"tampered" if n == "atlas/index.json" else (self.dist / n).read_bytes())
            z.writestr("zone-heroes/1424/v1/master.webp", b"x")
        code, out, ev = self.run_ps("-Mode", "Local", "-LocalDist", str(bad), "-TablePath", str(self.table))
        self.assertEqual((code, ev["verdict"]), (1, "FAIL"))
        self.assertTrue(any("bytes differ: atlas/index.json" in f for f in ev["failures"]))
        self.assertTrue(any("unexpected file: zone-heroes/1424/v1/master.webp" in f for f in ev["failures"]))

    def test_the_committed_tables_are_loadable_and_have_the_documented_counts(self):
        code, out, ev = self.run_ps("-Mode", "Local", "-LocalDist", str(self.work), "-TablePath", str(RELEASE))
        self.assertEqual(code, 1)  # a wrong folder fails ...
        self.assertEqual(ev["checked"], 180)  # ... but the real release table lists exactly 180 files
        code, out, ev = self.run_ps("-Mode", "Local", "-LocalDist", str(self.work), "-TablePath", str(PIN))
        self.assertEqual(ev["checked"], 172)


if __name__ == "__main__":
    unittest.main()
