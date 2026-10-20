"""Post-upload verification: every file of a dist must be served by the CDN with identical bytes and the intended cache/CORS headers.
Read-only (GET only), https only, allow-listed hosts only. Run it AFTER an approved Cloudflare Pages upload; nothing here uploads anything."""
from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

from .asset_url_compat import ALLOWED_ASSET_HOSTS
from .packaging import file_table

Opener = Callable[[str], tuple[int, dict[str, str], bytes]]
EXPECT = (("forever/", "public, max-age=31536000, immutable"), ("atlas/", "public, max-age=300, must-revalidate"))


def _default_open(url: str) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": "AzerDex-map-atlas-verify/1.0", "Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 - scheme/host validated by verify_remote
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read(64 * 1024 * 1024)
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, b""


def verify_remote(base_url: str, dist: Path, opener: Opener | None = None) -> dict:
    u = urllib.parse.urlparse(base_url)
    if u.scheme != "https" or u.hostname not in ALLOWED_ASSET_HOSTS or u.port or u.path not in ("", "/") or u.query or u.username:
        raise ValueError(f"refusing base URL {base_url!r}: https on an allow-listed host only ({', '.join(ALLOWED_ASSET_HOSTS)})")
    open_fn = opener or _default_open
    base = f"https://{u.hostname}"
    table = file_table(dist)
    problems: list[str] = []
    for rel, meta in table.items():
        if rel == "_headers":  # a Pages config file: consumed by Cloudflare, not served
            continue
        status, headers, body = open_fn(f"{base}/{rel}")
        if status != 200:
            problems.append(f"{rel}: HTTP {status}")
            continue
        if hashlib.sha256(body).hexdigest() != meta["sha256"]:
            problems.append(f"{rel}: bytes differ from the audited distribution")
        want = next((c for prefix, c in EXPECT if rel.startswith(prefix)), None)
        if want and headers.get("cache-control", "").replace(" ", "") != want.replace(" ", ""):
            problems.append(f"{rel}: cache-control {headers.get('cache-control')!r} != {want!r}")
        if headers.get("access-control-allow-origin") != "*":
            problems.append(f"{rel}: missing Access-Control-Allow-Origin: *")
    for p in ("forever/9999999/v1/manifest.json",):  # a path that must not exist: guards against a catch-all/SPA fallback masking misses
        status, _, _ = open_fn(f"{base}/{p}")
        if status == 200:
            problems.append(f"{p}: returned 200 (catch-all fallback would hide missing assets)")
    return {"base": base, "checked": len(table) - ("_headers" in table), "problems": problems, "ok": not problems}
