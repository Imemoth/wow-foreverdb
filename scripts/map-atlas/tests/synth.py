"""Synthetic client bundle for CI: real BLP2/DXT1 tiles + DB2-shaped CSVs. The art is ONE smooth gradient over each whole map
(red falls with x, green rises with y, blue = per-map constant), so tile ordering/seam errors are visible to the validators."""
from __future__ import annotations

import csv
import json
import struct
from pathlib import Path

TILE = 256


def _565(r: float, g: float, b: float) -> int:
    r, g, b = (max(0, min(255, int(round(v)))) for v in (r, g, b))
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)


def dxt1_gradient_block(x0: int, y0: int, gw: int, gh: int, blue: int, level: float = 1.0) -> bytes:
    def col(x: int, y: int) -> int:
        return _565(255 * (1 - x / gw) * level, 255 * (y / gh), blue)

    left, right = col(x0, y0), col(x0 + 3, y0)
    if left == right:
        return struct.pack("<HHI", left, left, 0)
    c0, c1, idx = (left, right, (0, 2, 3, 1)) if left > right else (right, left, (1, 3, 2, 0))
    row = sum(i << (2 * k) for k, i in enumerate(idx))
    return struct.pack("<HH", c0, c1) + bytes([row & 0xFF] * 4)


def blp2_dxt1(w: int, h: int, blocks: bytes) -> bytes:
    hdr = b"BLP2" + struct.pack("<I", 1) + struct.pack("<BBBB", 2, 0, 0, 0) + struct.pack("<II", w, h)
    off0 = 148 + 1024
    hdr += struct.pack("<16I", off0, *([0] * 15)) + struct.pack("<16I", len(blocks), *([0] * 15)) + b"\0" * 1024
    return hdr + blocks


def blp2_dxt5_solid(w: int, h: int, rgb: tuple[int, int, int], alpha: int) -> bytes:
    c = _565(*rgb)
    blk = bytes([alpha, alpha]) + b"\0" * 6 + struct.pack("<HHI", c, c, 0)
    hdr = b"BLP2" + struct.pack("<I", 1) + struct.pack("<BBBB", 2, 8, 7, 0) + struct.pack("<II", w, h)
    data = blk * ((w // 4) * (h // 4))
    hdr += struct.pack("<16I", 148 + 1024, *([0] * 15)) + struct.pack("<16I", len(data), *([0] * 15)) + b"\0" * 1024
    return hdr + data


def tile_blp(gx0: int, gy0: int, gw: int, gh: int, blue: int, level: float = 1.0) -> bytes:
    blocks = b"".join(dxt1_gradient_block(gx0 + bx * 4, gy0 + by * 4, gw, gh, blue, level) for by in range(TILE // 4) for bx in range(TILE // 4))
    return blp2_dxt1(TILE, TILE, blocks)


def expected_rgb(x: int, y: int, gw: int, gh: int, blue: int) -> tuple[int, int, int]:
    """Gradient value (before DXT quantisation) used by tests with a tolerance."""
    return round(255 * (1 - x / gw)), round(255 * (y / gh)), blue


def write_csv(path: Path, header: list[str], rows: list[list]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


# (uiMapID, name, parent, type, art spec) ; art spec: list of variants [(artId, phase, styleId, [layers (index,w,h)])]
class Bundle:
    def __init__(self, root: Path, version: str = "1.60.1.70450"):
        self.root, self.version = root, version
        self.db2 = root / "db2"
        self.blp = root / "blp"
        self.fd = 900_000
        self.ui_map: list[list] = []
        self.xart: list[list] = []
        self.art: list[list] = []
        self.layers: list[list] = []
        self.tiles: list[list] = []
        self.assign: list[list] = []
        self.maps_tbl: list[list] = []
        self.groups: list[list] = []
        self.tile_files: dict[int, tuple[int, int, int, int, int]] = {}
        self.fd_by_style_layer: dict[tuple[int, int], dict[tuple[int, int], int]] = {}
        self.db2.mkdir(parents=True, exist_ok=True)
        self.blp.mkdir(parents=True, exist_ok=True)

    def add_map(self, mid: int, name: str, parent: int, typ: int, system: int = 0) -> None:
        self.ui_map.append([mid, name, parent, typ, system, 0])

    def add_art(self, mid: int | None, art_id: int, style_id: int, layers: list[tuple[int, int, int]], phase: int = 0, blue: int = 80,
                skip_tiles: set[tuple[int, int]] = frozenset(), write_blps: bool = True, swap: tuple | None = None, level: float = 1.0,
                drop_blps: set[tuple[int, int]] = frozenset(), corrupt: set[tuple[int, int]] = frozenset(), uniform: tuple[int, int, int] | None = None) -> None:
        if mid is not None:
            self.xart.append([len(self.xart) + 1, phase, art_id, mid])
        if not any(a[0] == art_id for a in self.art):
            self.art.append([art_id, style_id])
        for li, w, h in layers:
            self.layers.append([len(self.layers) + 1, style_id, li, w, h, TILE, TILE])
            cols, rows = -(-w // TILE), -(-h // TILE)
            grid = {}
            for r in range(rows):
                for c in range(cols):
                    if (r, c) in skip_tiles:
                        continue
                    self.fd += 1
                    grid[(r, c)] = self.fd
                    self.tiles.append([len(self.tiles) + 1, r, c, li, style_id, self.fd])
                    if write_blps and (r, c) in drop_blps:
                        continue
                    if write_blps and (r, c) in corrupt:
                        (self.blp / f"{self.fd}.blp").write_bytes(b"BLP2" + b"\xff" * 40)
                    elif write_blps and uniform is not None:
                        v = _565(*uniform)
                        (self.blp / f"{self.fd}.blp").write_bytes(blp2_dxt1(TILE, TILE, struct.pack("<HHI", v, v, 0) * ((TILE // 4) ** 2)))
                    elif write_blps:
                        gr, gc = (r, c)
                        if swap and (r, c) == swap[0]:
                            gr, gc = swap[1]
                        elif swap and (r, c) == swap[1]:
                            gr, gc = swap[0]
                        (self.blp / f"{self.fd}.blp").write_bytes(tile_blp(gc * TILE, gr * TILE, w, h, blue, level))
            self.fd_by_style_layer[(style_id, li)] = grid

    def finish(self, extra_tables: bool = True) -> Path:
        write_csv(self.db2 / "UiMap.csv", ["Name_lang", "ID", "ParentUiMapID", "Type", "System", "Flags"], [[n, i, p, t, s, f] for i, n, p, t, s, f in self.ui_map])
        write_csv(self.db2 / "UiMapXMapArt.csv", ["ID", "PhaseID", "UiMapArtID", "UiMapID"], self.xart)
        write_csv(self.db2 / "UiMapArt.csv", ["ID", "UiMapArtStyleID"], self.art)
        write_csv(self.db2 / "UiMapArtStyleLayer.csv", ["ID", "UiMapArtStyleID", "LayerIndex", "LayerWidth", "LayerHeight", "TileWidth", "TileHeight"], self.layers)
        write_csv(self.db2 / "UiMapArtTile.csv", ["ID", "RowIndex", "ColIndex", "LayerIndex", "UiMapArtStyleID", "FileDataID"], self.tiles)
        if extra_tables:
            write_csv(self.db2 / "UiMapAssignment.csv", ["ID", "UiMapID", "MapID", "AreaID"], self.assign)
            write_csv(self.db2 / "Map.csv", ["ID", "Directory", "MapName_lang", "InstanceType"], self.maps_tbl)
            write_csv(self.db2 / "UiMapGroupMember.csv", ["ID", "UiMapGroupID", "UiMapID", "FloorIndex"], self.groups)
        (self.root / "build.json").write_text(json.dumps({"product": "wow_classic_beta", "version": self.version, "buildKey": "ab" * 16, "buildNumber": int(self.version.split(".")[-1]), "branch": "", "source": "synthetic"}))
        return self.root


def standard_bundle(root: Path, version: str = "1.60.1.70450") -> Bundle:
    b = Bundle(root, version)
    b.add_map(946, "Cosmic", 0, 0)                                             # no art
    b.add_map(947, "Azeroth", 946, 1)
    b.add_art(947, 7000, 700, [(0, 400, 300)], blue=40)                        # world, 2x2 tiles
    b.add_map(1414, "Kalimdor", 947, 2)
    b.add_art(1414, 7001, 701, [(0, 700, 520), (1, 350, 260)], blue=60)         # two layers: layer 0 is the largest => overview
    b.add_art(1414, 7002, 702, [(0, 520, 390)], phase=5, blue=70)               # alternate (phased) variant
    b.add_map(1420, "Tirisfal Glades", 1414, 3)
    b.add_art(1420, 7003, 703, [(0, 1002, 668)], blue=90)                      # full Tirisfal-sized art (4x3 tiles, cropped)
    b.add_map(2022, "Zephras Isle", 1414, 3)                                    # Forever-specific: one tile missing from the bundle
    b.add_art(2022, 7004, 704, [(0, 520, 390)], blue=100, drop_blps={(1, 1)})
    b.add_map(2023, "Mount Hyjal", 1414, 3)
    b.add_art(2023, 7005, 705, [(0, 600, 400)], blue=110)
    b.add_map(2024, "Riverglades", 1414, 3)                                     # defined but no art of its own
    b.add_map(3000, "Duplicate Of Kalimdor Variant", 1414, 3)
    b.xart.append([len(b.xart) + 1, 0, 7002, 3000])                             # shares MapArt 7002 -> identical pixels under another uiMapID
    b.add_map(1500, "The Deadmines", 1414, 4)
    b.add_map(1501, "The Deadmines - Floor 1", 1500, 5)
    b.add_art(1501, 7006, 706, [(0, 300, 200)], blue=120)
    b.add_map(1502, "The Deadmines - Floor 2", 1500, 5)
    b.add_art(1502, 7007, 707, [(0, 300, 200)], blue=130)
    b.assign += [[1, 1500, 36, 0], [2, 1501, 36, 0], [3, 1502, 36, 0]]
    b.maps_tbl += [[36, "Deadmines", "The Deadmines", 1], [0, "Azeroth", "Azeroth", 0]]
    b.groups += [[1, 55, 1501, 0], [2, 55, 1502, 1]]
    b.add_map(4000, "Blank Art", 1414, 3)
    b.add_art(4000, 7008, 708, [(0, 256, 256)], uniform=(10, 10, 10))           # blank art
    b.add_map(4001, "Orphaned Child", 99999, 3)                                 # parent does not exist
    b.add_map(4002, "Strange Type", 1414, 9)                                    # unknown map type, no art
    return b
