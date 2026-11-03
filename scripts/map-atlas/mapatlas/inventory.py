"""Map enumeration from client DB2 metadata (no hardcoded lists, nothing inferred from where a character has been).

Identifier discipline: uiMapID (UiMap.ID) != MapArtID (UiMapArt.ID) != UiMapArtStyleID != instance MapID (Map.ID) != FileDataID.
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from .csvtables import Table, load_tables, to_int

UIMAP_TYPES = {0: "cosmic", 1: "world", 2: "continent", 3: "zone", 4: "dungeon", 5: "micro", 6: "orphan"}
# Map.InstanceType (WoW core enum)
INSTANCE_TYPES = {0: None, 1: "dungeon", 2: "raid", 3: "battleground", 4: "arena", 5: "scenario"}


@dataclass
class Layer:
    index: int
    width: int
    height: int
    tile_w: int
    tile_h: int
    tiles: dict[tuple[int, int], int] = field(default_factory=dict)  # (row, col) -> FileDataID
    issues: list[str] = field(default_factory=list)

    @property
    def columns(self) -> int:
        return math.ceil(self.width / self.tile_w) if self.tile_w else 0

    @property
    def rows(self) -> int:
        return math.ceil(self.height / self.tile_h) if self.tile_h else 0

    @property
    def expected_tiles(self) -> int:
        return self.columns * self.rows

    @property
    def usable(self) -> bool:
        return self.width > 0 and self.height > 0 and self.tile_w > 0 and self.tile_h > 0 and bool(self.tiles)


@dataclass
class Variant:
    map_art_id: int
    phase_id: int
    style_id: int
    layers: list[Layer] = field(default_factory=list)

    @property
    def usable_layers(self) -> list[Layer]:
        return [l for l in self.layers if l.usable]

    @property
    def primary_layer(self) -> Layer | None:
        """Same rule as the Companion's WowClientMapAssetProvider: the largest usable layer."""
        u = self.usable_layers
        return max(u, key=lambda l: (l.width * l.height, -l.index)) if u else None


@dataclass
class MapEntry:
    ui_map_id: int
    name: str
    parent_id: int
    type_raw: int
    system: int | None
    flags: int | None
    variants: list[Variant] = field(default_factory=list)
    map_ids: list[int] = field(default_factory=list)       # instance Map IDs from UiMapAssignment
    area_ids: list[int] = field(default_factory=list)
    instance_type: str | None = None
    floor: dict | None = None
    reasons: list[str] = field(default_factory=list)       # why it has no usable art (empty when drawable)
    notes: list[str] = field(default_factory=list)

    @property
    def type_name(self) -> str:
        return UIMAP_TYPES.get(self.type_raw, f"unknown_{self.type_raw}")

    @property
    def drawable(self) -> bool:
        return any(v.primary_layer for v in self.variants)

    @property
    def category(self) -> str:
        if self.instance_type:
            return self.instance_type
        return {"cosmic": "world", "world": "world", "continent": "continent", "zone": "zone",
                "dungeon": "dungeon", "micro": "micro"}.get(self.type_name, "other")


@dataclass
class Inventory:
    maps: dict[int, MapEntry]
    hierarchy_issues: list[str]
    missing_optional_tables: list[str]
    overlay_summary: dict
    table_rows: dict[str, int]
    area_table_rows: int
    areas_without_own_map: int


def build_inventory(db2_dir: Path) -> Inventory:
    t, missing = load_tables(db2_dir)
    layers_by_style: dict[int, list[Layer]] = defaultdict(list)
    for r in t["UiMapArtStyleLayer"].rows:
        layers_by_style[to_int(r["UiMapArtStyleID"])].append(
            Layer(to_int(r["LayerIndex"]), to_int(r["LayerWidth"]), to_int(r["LayerHeight"]), to_int(r["TileWidth"]), to_int(r["TileHeight"])))
    lookup = {(sid, l.index): l for sid, ls in layers_by_style.items() for l in ls}
    for r in t["UiMapArtTile"].rows:
        key = (to_int(r["UiMapArtStyleID"]), to_int(r["LayerIndex"]))
        fd = to_int(r["FileDataID"])
        layer = lookup.get(key)
        if layer is None:
            continue
        pos = (to_int(r["RowIndex"]), to_int(r["ColIndex"]))
        if fd <= 0:
            layer.issues.append(f"tile {pos} has no FileDataID")
        elif pos in layer.tiles and layer.tiles[pos] != fd:
            layer.issues.append(f"conflicting FileDataIDs {layer.tiles[pos]} / {fd} for tile {pos}")
        else:
            layer.tiles[pos] = fd
    for layer in lookup.values():
        outside = [p for p in layer.tiles if p[0] >= layer.rows or p[1] >= layer.columns or p[0] < 0 or p[1] < 0]
        if outside:
            layer.issues.append(f"{len(outside)} tile(s) outside the {layer.columns}x{layer.rows} grid")

    style_of_art = {to_int(r["ID"]): to_int(r["UiMapArtStyleID"]) for r in t["UiMapArt"].rows}
    arts_by_map: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for r in t["UiMapXMapArt"].rows:
        arts_by_map[to_int(r["UiMapID"])].append((to_int(r["UiMapArtID"]), to_int(r.get("PhaseID"))))

    maps: dict[int, MapEntry] = {}
    for r in t["UiMap"].rows:
        mid = to_int(r["ID"])
        maps[mid] = MapEntry(mid, r["Name_lang"], to_int(r["ParentUiMapID"]), to_int(r["Type"]),
                             to_int(r["System"]) if "System" in r else None, to_int(r["Flags"]) if "Flags" in r else None)

    instance_by_mapid: dict[int, str | None] = {}
    if "Map" in t and any("InstanceType" in r for r in t["Map"].rows[:1]):
        instance_by_mapid = {to_int(r["ID"]): INSTANCE_TYPES.get(to_int(r["InstanceType"]), f"instance_{to_int(r['InstanceType'])}") for r in t["Map"].rows}
    assigned_area = set()
    if "UiMapAssignment" in t:
        for r in t["UiMapAssignment"].rows:
            e = maps.get(to_int(r["UiMapID"]))
            if e is None:
                continue
            mp, ar = to_int(r.get("MapID")), to_int(r.get("AreaID"))
            if mp and mp not in e.map_ids:
                e.map_ids.append(mp)
            if ar:
                e.area_ids.append(ar)
                assigned_area.add(ar)
    floors: dict[int, dict] = {}
    if "UiMapGroupMember" in t:
        for r in t["UiMapGroupMember"].rows:
            floors[to_int(r["UiMapID"])] = {"groupId": to_int(r["UiMapGroupID"]), "floorIndex": to_int(r.get("FloorIndex"))}

    for e in maps.values():
        kinds = sorted({instance_by_mapid[m] for m in e.map_ids if instance_by_mapid.get(m)})
        if len(kinds) == 1:
            e.instance_type = kinds[0]
        elif len(kinds) > 1:
            e.instance_type = kinds[0]
            e.notes.append(f"assigned to maps of several instance types: {', '.join(kinds)}")
        e.floor = floors.get(e.ui_map_id)
        refs = sorted(arts_by_map.get(e.ui_map_id, []), key=lambda p: (p[1], p[0]))
        if not refs:
            e.reasons.append("no UiMapXMapArt row (map has no artwork of its own)")
        for art_id, phase in refs:
            style = style_of_art.get(art_id)
            if style is None:
                e.reasons.append(f"UiMapArt {art_id} missing")
                continue
            v = Variant(art_id, phase, style, sorted(layers_by_style.get(style, []), key=lambda l: l.index))
            e.variants.append(v)
            if not v.layers:
                e.reasons.append(f"MapArt {art_id}: style {style} has no layers")
            for l in v.layers:
                if not l.usable:
                    e.reasons.append(f"MapArt {art_id} layer {l.index}: {'no tiles' if not l.tiles else 'zero dimensions'}")
        if e.drawable:
            e.reasons = []  # a map with at least one usable variant is drawable; unusable siblings stay in layer.issues

    issues = check_hierarchy(maps)
    ov_rows = len(t["WorldMapOverlay"]) if "WorldMapOverlay" in t else None
    ovt_rows = len(t["WorldMapOverlayTile"]) if "WorldMapOverlayTile" in t else None
    areas = len(t["AreaTable"]) if "AreaTable" in t else 0
    own = {a for e in maps.values() if e.drawable for a in e.area_ids}
    return Inventory(
        maps=maps, hierarchy_issues=issues, missing_optional_tables=missing,
        overlay_summary={"overlays": ov_rows, "overlayTiles": ovt_rows,
                         "note": "WorldMapOverlay full-reveal layers are recorded, not composited: base artwork only."},
        table_rows={name: len(tab) for name, tab in t.items()}, area_table_rows=areas,
        areas_without_own_map=len(assigned_area - own),
    )


def check_hierarchy(maps: dict[int, MapEntry]) -> list[str]:
    issues = []
    for e in maps.values():
        if e.parent_id and e.parent_id not in maps:
            issues.append(f"uiMap {e.ui_map_id}: parent {e.parent_id} does not exist")
        if e.parent_id == e.ui_map_id:
            issues.append(f"uiMap {e.ui_map_id}: is its own parent")
    for e in maps.values():
        seen, cur = {e.ui_map_id}, e.parent_id
        while cur and cur in maps:
            if cur in seen:
                issues.append(f"uiMap {e.ui_map_id}: parent cycle through {cur}")
                break
            seen.add(cur)
            cur = maps[cur].parent_id
    return sorted(set(issues))


def children_index(maps: dict[int, MapEntry]) -> dict[int, list[int]]:
    ch: dict[int, list[int]] = defaultdict(list)
    for e in maps.values():
        ch[e.parent_id if e.parent_id in maps else 0].append(e.ui_map_id)
    return {k: sorted(v) for k, v in ch.items()}
