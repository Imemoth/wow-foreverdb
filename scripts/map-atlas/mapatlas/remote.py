"""Post-upload verification: every file of a dist must be served by the CDN with identical bytes and the intended cache/CORS headers.
Read-only (GET only), https only, allow-listed hosts only. Run it AFTER an approved Cloudflare Pages upload; nothing here uploads anything."""
from __future__ import annotations

import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

from .asset_url_compat import ALLOWED_ASSET_HOSTS
from .packaging import file_table

# A Pages deployment of the project is also reachable at <deployment-or-branch>.azerdex-assets.pages.dev: allowed ONLY for read-only verification of a
# preview deployment BEFORE the production upload (the website itself never accepts these hosts, see web/src/lib/maps/asset-url.ts).
PREVIEW_HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.azerdex-assets\.pages\.dev$")
Opener = Callable[[str], tuple[int, dict[str, str], bytes]]
EXPECT = (("forever/", "public, max-age=31536000, immutable"), ("zone-heroes/", "public, max-age=31536000, immutable"),
          ("talent-icons/", "public, max-age=31536000, immutable"), ("atlas/", "public, max-age=300, must-revalidate"))
MISSING_PATHS = ("forever/9999999/v1/manifest.json", "zone-heroes/9999999/v1/desktop-1280.webp", "zone-heroes/1424/v999/desktop-1280.webp",
                 "talent-icons/9.9.9.9/1.webp")


def _default_open(url: str) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": "AzerDex-map-atlas-verify/1.0", "Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 - scheme/host validated by verify_remote
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read(64 * 1024 * 1024)
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, b""


def verify_remote(base_url: str, dist: Path, opener: Opener | None = None) -> dict:
    u = urllib.parse.urlparse(base_url)
    if u.scheme != "https" or not (u.hostname in ALLOWED_ASSET_HOSTS or PREVIEW_HOST_RE.match(u.hostname or "")) or u.port or u.path not in ("", "/") or u.query or u.username:
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
        if want and sorted(d.strip() for d in headers.get("cache-control", "").lower().split(",") if d.strip()) != sorted(d.strip() for d in want.lower().split(",")):
            problems.append(f"{rel}: cache-control {headers.get('cache-control')!r} != {want!r}")
        if headers.get("access-control-allow-origin") != "*":
            problems.append(f"{rel}: missing Access-Control-Allow-Origin: *")
        if rel.startswith(("zone-heroes/", "talent-icons/")):  # the newer namespaces are held to the full contract: type, nosniff (+ timing for heroes)
            if headers.get("content-type", "").split(";")[0].strip().lower() != "image/webp":
                problems.append(f"{rel}: content-type {headers.get('content-type')!r} != 'image/webp'")
            if headers.get("x-content-type-options", "").lower() != "nosniff":
                problems.append(f"{rel}: missing X-Content-Type-Options: nosniff")
            if rel.startswith("zone-heroes/") and headers.get("timing-allow-origin") != "*":
                problems.append(f"{rel}: missing Timing-Allow-Origin: *")
    for p in MISSING_PATHS:  # paths that must not exist: guards against a catch-all/SPA fallback masking misses
        status, _, _ = open_fn(f"{base}/{p}")
        if status != 404:
            problems.append(f"{p}: returned HTTP {status}, expected 404 (a catch-all fallback would hide missing assets)")
    return {"base": base, "checked": len(table) - ("_headers" in table), "problems": problems, "ok": not problems}
