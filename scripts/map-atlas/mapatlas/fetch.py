"""Download exact-build DB2 CSV exports (same source and URL shape the Companion's AutoAtlasBuildVerifier uses)."""
from __future__ import annotations

import hashlib
import json
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

from .csvtables import MAX_CSV_BYTES, SPECS
from .identity import VERSION_RE

ALLOWED_HOST = "wago.tools"


def table_url(table: str, version: str) -> str:
    if table not in SPECS:
        raise ValueError(f"unknown DB2 table {table!r}")
    if not VERSION_RE.match(version):
        raise ValueError(f"invalid client version {version!r}")
    return f"https://{ALLOWED_HOST}/db2/{table}/csv?build={urllib.parse.quote(version)}"


def fetch_tables(version: str, out_dir: Path, tables: list[str] | None = None,
                 opener: Callable[[str], tuple[str, bytes]] | None = None) -> dict:
    """HTTPS only; the final URL (after redirects) must still be https on wago.tools. `opener(url) -> (final_url, body)` is injectable."""
    def default_open(url: str) -> tuple[str, bytes]:
        req = urllib.request.Request(url, headers={"User-Agent": "AzerDex-map-atlas/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 - scheme/host checked below
            body = r.read(MAX_CSV_BYTES + 1)
            return r.geturl(), body

    open_fn = opener or default_open
    out_dir.mkdir(parents=True, exist_ok=True)
    sources = {}
    for t in tables or list(SPECS):
        url = table_url(t, version)
        final, body = open_fn(url)
        host = urllib.parse.urlparse(final)
        if host.scheme != "https" or host.hostname != ALLOWED_HOST:
            raise ValueError(f"{t}: refusing response from {final!r}")
        if len(body) > MAX_CSV_BYTES:
            raise ValueError(f"{t}: export exceeds size limit")
        (out_dir / f"{t}.csv").write_bytes(body)
        sources[t] = {"url": url, "sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body)}
    (out_dir / "_sources.json").write_text(json.dumps({"clientVersion": version, "tables": sources}, indent=2, sort_keys=True) + "\n")
    return sources
