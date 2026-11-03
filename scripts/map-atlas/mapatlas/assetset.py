"""Identity of a COMPLETE published asset set: every file's exact bytes plus the manifest's material content.

An immutable (uiMapID, version) is only ever reused for an identical asset set. Pixels of the primary image alone are NOT
enough: a changed full-reveal, an alternate variant or materially different manifest metadata must allocate a new version.
"""
from __future__ import annotations

import copy
import hashlib
import json

# Provenance-only fields: they describe who/when/which tool produced the set, not what the set contains. They are kept in the
# stored manifest but do not make a set "different" (a re-run with a newer exporter version over identical art reuses its version).
VOLATILE_TOP = ("version", "clientBuild")
VOLATILE_PROVENANCE = ("source", "exporterVersion", "importerVersion", "assembledBy")
VOLATILE_SOURCE = ("assembledBy", "exporter", "metadataSource")  # who/what produced the set, not what it contains


def material_view(manifest: dict) -> dict:
    m = copy.deepcopy(manifest)
    for k in VOLATILE_TOP:
        m.pop(k, None)
    for k in VOLATILE_PROVENANCE:
        (m.get("provenance") or {}).pop(k, None)
    for k in VOLATILE_SOURCE:
        (m.get("source") or {}).pop(k, None)
    return m


def asset_set_sha256(file_sha256: dict[str, str], manifest: dict) -> str:
    """`file_sha256`: stored file name -> sha256 of its exact bytes (images only; the manifest enters through its material view)."""
    payload = {"files": dict(sorted(file_sha256.items())), "manifest": material_view(manifest)}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()
