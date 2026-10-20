namespace ForeverDB.AtlasExporter.Model;

public sealed record UiMapRow(
    int Id, string Name, int ParentUiMapId, int Flags, int System, int Type);

public sealed record UiMapArtLinkRow(int UiMapId, int UiMapArtId, int PhaseId);

public sealed record StyleLayerRow(
    int StyleId, int LayerIndex, int LayerWidth, int LayerHeight,
    int TileWidth, int TileHeight);

public sealed record ArtTileRow(
    int UiMapArtId, int LayerIndex, int Row, int Column, int FileDataId);

public sealed record AssignmentRow(
    int UiMapId, int OrderIndex, int MapId, int AreaId,
    double[] UiMin, double[] UiMax, double[] Region);

public sealed record UiMapLinkRow(
    int ParentUiMapId, int ChildUiMapId, int OrderIndex);

public sealed record WorldMapRow(
    int Id, string Directory, string Name, int MapType, int InstanceType,
    int ParentMapId, int ExpansionId, int CosmeticParentMapId = 0);

public sealed record GroupMemberRow(int GroupId, int UiMapId, int FloorIndex, int RelativeHeightIndex);

public sealed record LfgDungeonRow(int Id, string Name, int TypeId, int MapId, int ExpansionLevel);

public sealed record OverlayRow(
    int Id, int UiMapArtId, int Width, int Height, int OffsetX, int OffsetY,
    int PlayerConditionId);

public sealed record OverlayTileRow(
    int OverlayId, int LayerIndex, int Row, int Column, int FileDataId);

/// <summary>Typed map metadata of one exact client build.</summary>
public sealed class MapDatabase
{
    public List<UiMapRow> UiMaps { get; } = new();
    public List<UiMapArtLinkRow> ArtLinks { get; } = new();
    public Dictionary<int, int> ArtStyle { get; } = new();
    public List<StyleLayerRow> StyleLayers { get; } = new();
    public List<ArtTileRow> ArtTiles { get; } = new();
    public List<AssignmentRow> Assignments { get; } = new();
    public List<UiMapLinkRow> Links { get; } = new();
    public Dictionary<int, WorldMapRow> WorldMaps { get; } = new();
    public List<OverlayRow> Overlays { get; } = new();
    public List<OverlayTileRow> OverlayTiles { get; } = new();

    public List<GroupMemberRow> GroupMembers { get; } = new();
    public List<LfgDungeonRow> LfgDungeons { get; } = new();

    /// <summary>Which source provided each table (name → source label).</summary>
    public Dictionary<string, string> TableSources { get; } = new(StringComparer.Ordinal);

    /// <summary>Row counts per table as read (name → rows).</summary>
    public Dictionary<string, int> TableRowCounts { get; } = new(StringComparer.Ordinal);

    /// <summary>Non-fatal findings while reading (e.g. encrypted DB2 sections whose rows are unavailable).</summary>
    public List<string> TableWarnings { get; } = new();

    /// <summary>Optional tables that could not be read (name → reason).</summary>
    public Dictionary<string, string> MissingOptionalTables { get; } =
        new(StringComparer.Ordinal);

    public string MetadataSource { get; set; } = "";
}
