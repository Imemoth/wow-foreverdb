"""Slugs and the append-only publication ledger. A published (uiMapID, version) is immutable; new content gets a NEW version."""
from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

VERSION_RE = re.compile(r"^v([1-9]\d{0,3})$")


def slug(name: str, ui_map_id: int) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[’'`]", "", s.lower())
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or f"map-{ui_map_id}"


class LedgerError(ValueError):
    pass


@dataclass
class Ledger:
    """{"maps": {"<uiMapId>": {"<version>": {"contentSha256": ..., "pixelSha256": ..., "firstBuild": ..., "seenBuilds": [...], "files": {name: {"sha256","bytes"}}}}}}"""
    data: dict

    @classmethod
    def load(cls, path: Path) -> "Ledger":
        if not path.exists():
            return cls({"schemaVersion": 1, "maps": {}})
        d = json.loads(path.read_text(encoding="utf-8"))
        if d.get("schemaVersion") != 1 or not isinstance(d.get("maps"), dict):
            raise LedgerError("unsupported ledger format")
        return cls(d)

    def versions(self, ui_map_id: int) -> dict:
        return self.data["maps"].get(str(ui_map_id), {})

    def lookup(self, ui_map_id: int, layout_sha: str, pixel_sha: str) -> str | None:
        """Version already published/recorded for exactly this pixel content, or None."""
        for ver, rec in self.versions(ui_map_id).items():
            if rec["pixelSha256"] == pixel_sha and rec["layoutSha256"] == layout_sha:
                return ver
        return None

    def next_version(self, ui_map_id: int) -> str:
        nums = [int(m.group(1)) for v in self.versions(ui_map_id) if (m := VERSION_RE.match(v))]
        return f"v{(max(nums) if nums else 0) + 1}"

    def note_seen(self, ui_map_id: int, version: str, build: str) -> None:
        seen = self.versions(ui_map_id)[version]["seenBuilds"]
        if build not in seen:
            seen.append(build)

    def record(self, ui_map_id: int, version: str, layout_sha: str, pixel_sha: str, files: dict[str, dict], build: str) -> None:
        vs = self.data["maps"].setdefault(str(ui_map_id), {})
        if version in vs:
            raise LedgerError(f"refusing to overwrite {ui_map_id}/{version}")
        vs[version] = {"layoutSha256": layout_sha, "pixelSha256": pixel_sha, "firstBuild": build, "seenBuilds": [build], "files": files}

    def to_text(self) -> str:
        return json.dumps(self.data, indent=2, sort_keys=True) + "\n"

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.to_text(), encoding="utf-8")
