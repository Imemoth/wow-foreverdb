"""DB2 CSV exports (wago.tools format) read by header NAME, never by position. Missing required columns fail loudly."""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

MAX_CSV_BYTES = 256 * 1024 * 1024


class SchemaError(ValueError):
    pass


@dataclass
class Table:
    name: str
    rows: list[dict[str, str]]
    headers: list[str]
    bad_rows: int = 0

    def __len__(self) -> int:
        return len(self.rows)


def _norm(h: str) -> str:
    return h.strip().lstrip("﻿").lower().replace("_", "")


def read_table(path: Path, name: str, required: Iterable[tuple[str, tuple[str, ...]]], optional: Iterable[tuple[str, tuple[str, ...]]] = ()) -> Table:
    """`required`/`optional`: (canonical column, accepted header aliases). Rows are re-keyed to canonical names."""
    if path.stat().st_size > MAX_CSV_BYTES:
        raise SchemaError(f"{name}: export exceeds {MAX_CSV_BYTES} bytes")
    text = path.read_text(encoding="utf-8-sig")
    rd = csv.reader(io.StringIO(text))
    try:
        headers = next(rd)
    except StopIteration:
        raise SchemaError(f"{name}: empty CSV") from None
    index = {_norm(h): i for i, h in enumerate(headers)}

    def locate(canon: str, aliases: tuple[str, ...]) -> int | None:
        for a in (canon, *aliases):
            if _norm(a) in index:
                return index[_norm(a)]
        return None

    cols: dict[str, int] = {}
    for canon, aliases in required:
        i = locate(canon, aliases)
        if i is None:
            raise SchemaError(f"{name}: required column {canon!r} not found (headers: {', '.join(headers)})")
        cols[canon] = i
    for canon, aliases in optional:
        i = locate(canon, aliases)
        if i is not None:
            cols[canon] = i
    rows, bad = [], 0
    for r in rd:
        if not r:
            continue
        if len(r) != len(headers):
            bad += 1
            continue
        rows.append({c: r[i] for c, i in cols.items()})
    return Table(name, rows, headers, bad)


def to_int(v: str | None, default: int = 0) -> int:
    if v is None or v == "":
        return default
    try:
        return int(v)
    except ValueError:
        try:
            f = float(v)
        except ValueError as e:
            raise SchemaError(f"not an integer: {v!r}") from e
        if f != int(f):
            raise SchemaError(f"not an integer: {v!r}")
        return int(f)


# Column contracts. Names are the DB2 field names as exported by wago.tools and as already used by the Companion's
# AtlasMetadataVerifier (WorldMapOverlay*, UiMapArt, UiMapArtStyleLayer). `Name_lang` is the localised name column.
SPECS: dict[str, dict] = {
    "UiMap": dict(required=[("ID", ()), ("Name_lang", ("Name",)), ("ParentUiMapID", ("ParentID",)), ("Type", ())],
                  optional=[("System", ()), ("Flags", ())]),
    "UiMapXMapArt": dict(required=[("UiMapID", ()), ("UiMapArtID", ())], optional=[("ID", ()), ("PhaseID", ())]),
    "UiMapArt": dict(required=[("ID", ()), ("UiMapArtStyleID", ())], optional=[]),
    "UiMapArtStyleLayer": dict(required=[("UiMapArtStyleID", ()), ("LayerIndex", ()), ("LayerWidth", ()), ("LayerHeight", ()),
                                         ("TileWidth", ()), ("TileHeight", ())], optional=[("ID", ())]),
    "UiMapArtTile": dict(required=[("UiMapArtStyleID", ()), ("LayerIndex", ()), ("RowIndex", ()), ("ColIndex", ()), ("FileDataID", ())],
                         optional=[("ID", ())]),
    # optional context tables
    "UiMapAssignment": dict(required=[("UiMapID", ())], optional=[("MapID", ()), ("AreaID", ()), ("ID", ())]),
    "Map": dict(required=[("ID", ())], optional=[("Directory", ()), ("MapName_lang", ("MapName",)), ("InstanceType", ()), ("ParentMapID", ())]),
    "AreaTable": dict(required=[("ID", ())], optional=[("AreaName_lang", ("AreaName",)), ("ContinentID", ()), ("ParentAreaID", ())]),
    "UiMapGroupMember": dict(required=[("UiMapGroupID", ()), ("UiMapID", ())], optional=[("FloorIndex", ()), ("ID", ())]),
    "WorldMapOverlay": dict(required=[("ID", ()), ("UiMapArtID", ())], optional=[("OffsetX", ()), ("OffsetY", ()), ("TextureWidth", ()), ("TextureHeight", ())]),
    "WorldMapOverlayTile": dict(required=[("WorldMapOverlayID", ()), ("RowIndex", ()), ("ColIndex", ()), ("FileDataID", ())], optional=[("LayerIndex", ()), ("ID", ())]),
}
REQUIRED_TABLES = ("UiMap", "UiMapXMapArt", "UiMapArt", "UiMapArtStyleLayer", "UiMapArtTile")
OPTIONAL_TABLES = tuple(t for t in SPECS if t not in REQUIRED_TABLES)


def load_tables(db2_dir: Path) -> tuple[dict[str, Table], list[str]]:
    """Loads required tables (error if absent) and optional ones (recorded as missing). Returns (tables, missing_optional)."""
    tables: dict[str, Table] = {}
    missing: list[str] = []
    for name, spec in SPECS.items():
        p = db2_dir / f"{name}.csv"
        if not p.is_file():
            if name in REQUIRED_TABLES:
                raise SchemaError(f"required DB2 export missing: {p.name}")
            missing.append(name)
            continue
        tables[name] = read_table(p, name, spec["required"], spec["optional"])
    return tables, missing
