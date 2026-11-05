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

public sealed class OverlayPlan
{
    public int Id { get; init; }
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
    public int? WorldMapId { get; set; }
    public string? WorldMapDirectory { get; set; }
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
}
