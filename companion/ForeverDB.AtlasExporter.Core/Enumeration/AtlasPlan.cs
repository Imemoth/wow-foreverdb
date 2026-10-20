namespace ForeverDB.AtlasExporter.Enumeration;

public static class Categories
{
    public const string World = "world";
    public const string Continent = "continent";
    public const string Zone = "zone";
    public const string City = "city";
    public const string Instance = "instance";
    public const string Special = "special";
    public const string Other = "other";
}

public static class MapStatus
{
    public const string Drawable = "drawable";
    public const string NoOwnArt = "no-own-art";
    public const string InheritsParent = "inherits-parent";
    public const string ArtIncomplete = "art-incomplete";
}

public sealed record TileCell(int Row, int Column, int FileDataId);

public sealed class ArtLayerPlan
{
    public int LayerIndex { get; init; }
    public int LayerWidth { get; init; }
    public int LayerHeight { get; init; }
    public int TileWidth { get; init; }
    public int TileHeight { get; init; }
    public int Columns => (LayerWidth + TileWidth - 1) / TileWidth;
    public int Rows => (LayerHeight + TileHeight - 1) / TileHeight;
    public List<TileCell> Tiles { get; } = new();
    public int ExpectedTiles => Columns * Rows;
    public int MissingTiles { get; set; }
    public int ConflictingTiles { get; set; }
    public bool IsComplete => MissingTiles == 0 && ConflictingTiles == 0;
}

/// <summary>What an exploration overlay row actually provides, judged from its own tile records.</summary>
public static class OverlayKind
{
    /// <summary>Artwork complete: every cell of its tile grid has a FileDataID.</summary>
    public const string Ok = "ok";

    /// <summary>Zero size and no tile records: a hit-rectangle/area row that carries no artwork at all.</summary>
    public const string NoArtwork = "no-artwork";

    /// <summary>Declares a texture size but has no tile records: nothing to draw.</summary>
    public const string TilelessDeclared = "tileless-declared";

    /// <summary>Some tiles exist but the grid is incomplete or inconsistent: artwork that cannot be assembled.</summary>
    public const string GridIncomplete = "grid-incomplete";

    /// <summary>Overlay rectangle is larger/farther out than the compositor supports (4096 px).</summary>
    public const string UnsupportedGeometry = "unsupported-geometry";

    /// <summary>Tile records contradict the declared geometry (out of range, conflicting, zero-size with tiles).</summary>
    public const string GridInvalid = "grid-invalid";
}

public sealed class OverlayPlan
{
    public int Id { get; init; }
    public string Kind { get; set; } = OverlayKind.Ok;
    public string KindDetail { get; set; } = "";
    public int TileLayerIndex { get; set; }
    public int TileRecordCount { get; set; }
    public int ExpectedTiles { get; set; }
    public bool IsConditional => PlayerConditionId != 0;
    public int Width { get; init; }
    public int Height { get; init; }
    public int OffsetX { get; init; }
    public int OffsetY { get; init; }
    public int PlayerConditionId { get; init; }
    public List<TileCell> Tiles { get; } = new();
}

public sealed class ArtPlan
{
    public int UiMapArtId { get; init; }
    public int PhaseId { get; init; }
    public int StyleId { get; init; }
    public List<ArtLayerPlan> Layers { get; } = new();
    public List<OverlayPlan> Overlays { get; } = new();
    public IEnumerable<OverlayPlan> UsableOverlays => Overlays.Where(o => o.Kind == OverlayKind.Ok);
    public IEnumerable<OverlayPlan> BlockingOverlays =>
        Overlays.Where(o => o.Kind is OverlayKind.GridIncomplete or OverlayKind.GridInvalid or OverlayKind.UnsupportedGeometry);
    public IEnumerable<OverlayPlan> SkippedOverlays =>
        Overlays.Where(o => o.Kind is OverlayKind.NoArtwork or OverlayKind.TilelessDeclared);
    /// <summary>A reveal variant is meaningful only when at least one overlay carries artwork.</summary>
    public bool HasRevealArtwork => UsableOverlays.Any() || BlockingOverlays.Any();
    public List<string> Issues { get; } = new();
    public bool IsDrawable => Layers.Count > 0;
}

public sealed class AtlasMap
{
    public int UiMapId { get; init; }
    public string Name { get; init; } = "";
    public string Slug { get; init; } = "";
    public int ParentUiMapId { get; init; }
    public int Type { get; init; }
    public string TypeName { get; init; } = "";
    public int System { get; init; }
    public int Flags { get; init; }
    public string Category { get; set; } = Categories.Other;
    public string CategorySource { get; set; } = "";
    public string? InstanceKind { get; set; }
    /// <summary>Row in the Map table (set only when that table is available and has the map).</summary>
    public int? WorldMapId { get; set; }
    public string? WorldMapDirectory { get; set; }

    /// <summary>Internal MapID from UiMapAssignment - never a UiMapID or a MapArtID.</summary>
    public int? InternalMapId { get; set; }

    /// <summary>"confirmed" (client table says so), "derived" (client data, indirect), "fallback" (documented heuristic).</summary>
    public string ClassificationConfidence { get; set; } = "confirmed";
    public string ClassificationEvidence { get; set; } = "";
    public int? FloorGroupId { get; set; }
    public int? FloorIndex { get; set; }
    public string Status { get; set; } = MapStatus.NoOwnArt;
    public int? InheritsFromUiMapId { get; set; }
    public string StatusDetail { get; set; } = "";
    public List<ArtPlan> Arts { get; } = new();
    public ArtPlan? PrimaryArt => Arts.FirstOrDefault(art => art.IsDrawable);
}

public sealed class HierarchyNode
{
    public int UiMapId { get; init; }
    public string Name { get; init; } = "";
    public int ParentUiMapId { get; init; }
    public int Depth { get; set; }
    public List<int> Children { get; } = new();
    public bool ParentMissing { get; set; }
}

public sealed class MapHierarchy
{
    public List<int> Roots { get; } = new();
    public SortedDictionary<int, HierarchyNode> Nodes { get; } = new();
    public List<int> OrphanedByMissingParent { get; } = new();
    public List<int> CycleMembers { get; } = new();
}

public sealed class AtlasPlan
{
    public List<AtlasMap> Maps { get; } = new();
    public MapHierarchy Hierarchy { get; init; } = new();
    public List<(int Parent, int Child, int Order)> Links { get; } = new();
    public InstanceCatalog Instances { get; set; } = new();
}
