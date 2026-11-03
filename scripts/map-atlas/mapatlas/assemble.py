"""Tile assembly. Same geometry as the Companion's WowClientMapAssetProvider: tile (row, col) is placed at
(col * TileWidth, row * TileHeight) on a transparent LayerWidth x LayerHeight canvas; tiles overhanging the layer are cropped.
Missing or undecodable tiles are NEVER painted over or stretched: they are listed and the map is marked incomplete."""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import Callable

from PIL import Image

from .inventory import Layer

BlpSource = Callable[[int], bytes | None]


@dataclass
class AssembleResult:
    image: Image.Image | None
    expected_tiles: int
    placed: int = 0
    missing_files: list[int] = field(default_factory=list)       # FileDataIDs with no BLP in the bundle
    decode_failures: list[tuple[int, str]] = field(default_factory=list)
    size_mismatches: list[tuple[int, tuple[int, int]]] = field(default_factory=list)
    unfilled_grid_cells: int = 0                                   # grid cells with no DB2 tile row at all

    @property
    def complete(self) -> bool:
        return self.image is not None and not self.missing_files and not self.decode_failures and self.unfilled_grid_cells == 0


def decode_blp(data: bytes) -> Image.Image:
    im = Image.open(io.BytesIO(data))
    if im.format != "BLP":
        raise ValueError(f"not a BLP file (detected {im.format})")
    im.load()
    return im.convert("RGBA")


def assemble_layer(layer: Layer, source: BlpSource) -> AssembleResult:
    res = AssembleResult(None, layer.expected_tiles)
    canvas = Image.new("RGBA", (layer.width, layer.height), (0, 0, 0, 0))
    res.unfilled_grid_cells = layer.expected_tiles - sum(1 for (r, c) in layer.tiles if r < layer.rows and c < layer.columns)
    for (row, col), fdid in sorted(layer.tiles.items()):
        if row >= layer.rows or col >= layer.columns:
            continue
        data = source(fdid)
        if data is None:
            res.missing_files.append(fdid)
            continue
        try:
            tile = decode_blp(data)
        except Exception as e:  # noqa: BLE001 - imaging libraries raise many types (bomb guard, SyntaxError, struct.error...); one bad tile must never abort a build
            res.decode_failures.append((fdid, f"{type(e).__name__}: {e}"))
            continue
        if tile.size != (layer.tile_w, layer.tile_h):
            res.size_mismatches.append((fdid, tile.size))
        # paste without a mask: copies pixels AND alpha verbatim (no blending against the transparent canvas)
        canvas.paste(tile, (col * layer.tile_w, row * layer.tile_h))
        res.placed += 1
    res.image = canvas
    return res
