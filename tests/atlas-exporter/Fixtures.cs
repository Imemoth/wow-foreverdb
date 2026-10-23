using ForeverDB.AtlasExporter.Client;
using ForeverDB.AtlasExporter.Enumeration;
using ForeverDB.AtlasExporter.Export;
using ForeverDB.AtlasExporter.Imaging;
using ForeverDB.AtlasExporter.Model;

namespace Atlas.Exporter.Tests;

/// <summary>Builds a synthetic client: typed map metadata plus loose &lt;FileDataID&gt;.blp textures.</summary>
internal sealed class World
{
    private int _nextFileDataId = 5000;

    public World(string root)
    {
        Root = root;
        AssetsDir = System.IO.Path.Combine(root, "assets");
        Directory.CreateDirectory(AssetsDir);
    }

    public string Root { get; }
    public string AssetsDir { get; }
    public MapDatabase Db { get; } = new() { MetadataSource = "fixture" };
    public BuildIdentity Identity { get; } = new("wow_classic_beta", "1.60.1.70245", "ABCDEF0123456789ABCDEF0123456789", "us", "fixture");

    public static (byte R, byte G, byte B) TileColor(int art, int layer, int row, int col) =>
        ((byte)(30 + row * 50), (byte)(30 + col * 50), (byte)((art + layer * 7) % 200 + 30));

    public World Map(int id, string name, int type, int parent, int flags = 0, int system = 0)
    {
        Db.UiMaps.Add(new UiMapRow(id, name, parent, flags, system, type));
        return this;
    }

    public World Link(int uiMapId, int art, int phase = 0)
    {
        Db.ArtLinks.Add(new UiMapArtLinkRow(uiMapId, art, phase));
        return this;
    }

    /// <summary>Defines an art with generated tiles for every layer (tile textures are full 256x256).</summary>
    public World Art(int art, params (int Index, int Width, int Height)[] layers)
    {
        var style = art + 10_000;
        Db.ArtStyle[art] = style;

        foreach (var (index, width, height) in layers)
        {
            Db.StyleLayers.Add(new StyleLayerRow(style, index, width, height, 256, 256));
            var columns = (width + 255) / 256;
            var rows = (height + 255) / 256;

            for (var row = 0; row < rows; row++)
            {
                for (var col = 0; col < columns; col++)
                {
                    var id = _nextFileDataId++;
                    var (r, g, b) = TileColor(art, index, row, col);
                    File.WriteAllBytes(System.IO.Path.Combine(AssetsDir, id + ".blp"), BlpWriter.Tile(256, 256, r, g, b));
                    Db.ArtTiles.Add(new ArtTileRow(art, index, row, col, id));
                }
            }
        }

        return this;
    }

    public int TileId(int art, int layer, int row, int col) =>
        Db.ArtTiles.First(t => t.UiMapArtId == art && t.LayerIndex == layer && t.Row == row && t.Column == col).FileDataId;

    public World Overlay(int art, int id, int x, int y, int width, int height, byte alpha = 160)
    {
        Db.Overlays.Add(new OverlayRow(id, art, width, height, x, y, 0));
        var columns = (width + 255) / 256;
        var rows = (height + 255) / 256;

        for (var row = 0; row < rows; row++)
        {
            for (var col = 0; col < columns; col++)
            {
                var fdid = _nextFileDataId++;
                File.WriteAllBytes(System.IO.Path.Combine(AssetsDir, fdid + ".blp"), BlpWriter.Tile(256, 256, 250, 20, 20, alpha));
                Db.OverlayTiles.Add(new OverlayTileRow(id, 0, row, col, fdid));
            }
        }

        return this;
    }

    public void DeleteTexture(int fileDataId) => File.Delete(System.IO.Path.Combine(AssetsDir, fileDataId + ".blp"));

    public void CorruptTexture(int fileDataId) =>
        File.WriteAllBytes(System.IO.Path.Combine(AssetsDir, fileDataId + ".blp"), new byte[] { 1, 2, 3, 4, 5 });

    public AtlasPlan Plan() => MapEnumerator.Enumerate(Db);

    /// <summary>The metadata as wago.tools-style CSV exports (named columns, arrays flattened).</summary>
    public static Dictionary<string, string> CsvFor(World world, IReadOnlyDictionary<int, string>? names = null)
    {
        static string Q(object? value)
        {
            var text = Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) ?? "";
            return text.Contains(',') || text.Contains('"') ? "\"" + text.Replace("\"", "\"\"") + "\"" : text;
        }

        static string Table(string header, IEnumerable<object?[]> rows) =>
            header + "\n" + string.Join("\n", rows.Select(r => string.Join(",", r.Select(Q)))) + "\n";

        var db = world.Db;
        var tables = new Dictionary<string, string>
        {
            ["UiMap"] = Table("Name_lang,ID,Flags,System,Type,ParentUiMapID", db.UiMaps.Select(m =>
                new object?[] { names?.GetValueOrDefault(m.Id) ?? m.Name, m.Id, m.Flags, m.System, m.Type, m.ParentUiMapId })),
            ["UiMapXMapArt"] = Table("ID,PhaseID,UiMapArtID,UiMapID", db.ArtLinks.Select((l, i) =>
                new object?[] { i + 1, l.PhaseId, l.UiMapArtId, l.UiMapId })),
            ["UiMapArt"] = Table("ID,UiMapArtStyleID", db.ArtStyle.Select(a => new object?[] { a.Key, a.Value })),
            ["UiMapArtStyleLayer"] = Table("ID,LayerIndex,LayerWidth,LayerHeight,TileWidth,TileHeight,UiMapArtStyleID",
                db.StyleLayers.Select((l, i) => new object?[] { i + 1, l.LayerIndex, l.LayerWidth, l.LayerHeight, l.TileWidth, l.TileHeight, l.StyleId })),
            ["UiMapArtTile"] = Table("ID,RowIndex,ColIndex,LayerIndex,FileDataID,UiMapArtID", db.ArtTiles.Select((t, i) =>
                new object?[] { i + 1, t.Row, t.Column, t.LayerIndex, t.FileDataId, t.UiMapArtId })),
            ["UiMapAssignment"] = Table("UiMin_0,UiMin_1,UiMax_0,UiMax_1,Region_0,Region_1,Region_2,Region_3,Region_4,Region_5,ID,UiMapID,OrderIndex,MapID,AreaID",
                db.Assignments.Select((a, i) => new object?[] { a.UiMin[0], a.UiMin[1], a.UiMax[0], a.UiMax[1],
                    a.Region[0], a.Region[1], a.Region[2], a.Region[3], a.Region[4], a.Region[5], i + 1, a.UiMapId, a.OrderIndex, a.MapId, a.AreaId })),
            ["Map"] = Table("ID,Directory,MapName_lang,MapType,InstanceType,ParentMapID,ExpansionID",
                db.WorldMaps.Values.Select(m => new object?[] { m.Id, m.Directory, m.Name, m.MapType, m.InstanceType, m.ParentMapId, m.ExpansionId })),
            ["WorldMapOverlay"] = Table("ID,UiMapArtID,TextureWidth,TextureHeight,OffsetX,OffsetY,PlayerConditionID",
                db.Overlays.Select(o => new object?[] { o.Id, o.UiMapArtId, o.Width, o.Height, o.OffsetX, o.OffsetY, o.PlayerConditionId })),
            ["WorldMapOverlayTile"] = Table("ID,RowIndex,ColIndex,LayerIndex,FileDataID,WorldMapOverlayID",
                db.OverlayTiles.Select((t, i) => new object?[] { i + 1, t.Row, t.Column, t.LayerIndex, t.FileDataId, t.OverlayId }))
        };

        return tables;
    }

    /// <summary>The standard set used by most pipeline tests.</summary>
    public static World Standard(string root)
    {
        var world = new World(root);
        world.Map(946, "Cosmic", 0, 0)
            .Map(947, "Azeroth", 1, 946).Art(100, (0, 512, 256)).Link(947, 100)
            .Map(1415, "Eastern Kingdoms", 2, 947).Art(101, (0, 600, 400)).Link(1415, 101)
            .Map(1420, "Tirisfal Glades", 3, 1415).Art(102, (0, 1002, 668), (1, 1536, 1024)).Link(1420, 102)
            .Overlay(102, 1, 50, 60, 200, 150)
            .Map(1453, "Stormwind City", 3, 1415).Art(103, (0, 512, 256)).Link(1453, 103)
            .Map(1500, "Shared Zone", 3, 1415).Link(1500, 102)
            .Map(1600, "The Deadmines", 4, 1415).Art(104, (0, 300, 200)).Link(1600, 104)
            .Map(1601, "Cave Under Tirisfal", 5, 1420, flags: MapEnumerator.FlagFallbackToParentMap)
            .Map(1610, "Test Raid", 3, 1415).Art(109, (0, 300, 200)).Link(1610, 109)
            .Map(1800, "No Art Zone", 3, 1415);
        world.Db.WorldMaps[0] = new WorldMapRow(0, "azeroth", "Azeroth", 0, 0, 0, 0);
        world.Db.WorldMaps[409] = new WorldMapRow(409, "raid", "Raid", 2, 2, 0, 0);
        world.Db.Assignments.Add(new AssignmentRow(1420, 0, 0, 85, new[] { 0.0, 0.0 }, new[] { 1.0, 1.0 },
            new double[] { 2250, 1100, 0, 1500, -400, 0 }));
        world.Db.Assignments.Add(new AssignmentRow(1610, 0, 409, 0, new[] { 0.0, 0.0 }, new[] { 1.0, 1.0 }, new double[6]));
        return world;
    }
}

internal static class Run
{
    public static async Task<ExportResult> Export(
        World world, string output, Action<ExportOptionsBuilder>? configure = null,
        CancellationToken token = default, IProgress<ExportProgress>? progress = null, IAssetSource? assets = null)
    {
        var builder = new ExportOptionsBuilder { Output = output };
        configure?.Invoke(builder);
        using var source = assets is null ? new DirectoryAssetSource(world.AssetsDir) : null;
        var pipeline = new AtlasExportPipeline(
            world.Plan(), world.Db, world.Identity, assets ?? source!, builder.Build());
        return await pipeline.RunAsync(progress, token);
    }
}

internal sealed class ExportOptionsBuilder
{
    public string Output { get; set; } = "";
    public bool Resume { get; set; }
    public bool Force { get; set; }
    public bool Reveal { get; set; } = true;
    public bool Detail { get; set; } = true;
    public bool AllLayers { get; set; }
    public bool AllowPartial { get; set; }
    public bool Zip { get; set; } = true;
    public WebpSettings Webp { get; set; } = new(90, false);
    public IReadOnlySet<int>? Only { get; set; }
    public IReadOnlyList<string> Redactions { get; set; } = Array.Empty<string>();
    public string? Reference { get; set; }

    public ExportOptions Build() => new()
    {
        OutputDirectory = Output,
        Resume = Resume,
        Force = Force,
        IncludeFullReveal = Reveal,
        DetailLayer = Detail,
        AllLayers = AllLayers,
        AllowPartial = AllowPartial,
        CreateZip = Zip,
        Webp = Webp,
        OnlyMaps = Only,
        Redactions = Redactions,
        Reference1420Image = Reference,
        ExporterVersion = "test"
    };
}
