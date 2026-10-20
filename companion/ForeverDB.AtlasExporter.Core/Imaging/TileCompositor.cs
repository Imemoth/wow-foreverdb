using ForeverDB.AtlasExporter.Enumeration;
using ForeverDB.Companion.Services;

namespace ForeverDB.AtlasExporter.Imaging;

public sealed record CompositionResult(
    BgraImage? Image,
    int TilesPlaced,
    int TilesExpected,
    IReadOnlyList<string> Problems)
{
    public bool IsComplete => Image is not null && TilesPlaced == TilesExpected && Problems.Count == 0;
}

public static class TileCompositor
{
    private const int MaxProblemsReported = 8;
    public const long MaxCanvasPixels = 16_384L * 16_384L;

    /// <summary>
    /// Places each tile at (column * tileWidth, row * tileHeight) from its row/column
    /// record - never from list order - and crops padded power-of-two BLP edges to the
    /// layer extent. Missing or corrupt tiles stay fully transparent and are reported;
    /// nothing is invented to fill them.
    /// </summary>
    public static CompositionResult Compose(ArtLayerPlan layer, TextureCache textures, CancellationToken cancellationToken)
    {
        if ((long)layer.LayerWidth * layer.LayerHeight > MaxCanvasPixels)
        {
            return new CompositionResult(null, 0, layer.ExpectedTiles,
                new[] { $"Layer {layer.LayerWidth}x{layer.LayerHeight} exceeds the supported canvas size." });
        }

        var canvas = BgraImage.Blank(layer.LayerWidth, layer.LayerHeight);
        var problems = new List<string>();
        var placed = 0;

        if (layer.MissingTiles > 0)
        {
            problems.Add($"{layer.MissingTiles} of {layer.ExpectedTiles} tile positions have no FileDataID.");
        }

        if (layer.ConflictingTiles > 0)
        {
            problems.Add($"{layer.ConflictingTiles} conflicting/out-of-range tile records ignored.");
        }

        var failures = 0;

        foreach (var cell in layer.Tiles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var texture = textures.Get(cell.FileDataId, out var failure);

            if (texture is null)
            {
                failures++;

                if (problems.Count < MaxProblemsReported)
                {
                    problems.Add($"tile r{cell.Row}c{cell.Column}: {failure}");
                }

                continue;
            }

            var left = cell.Column * layer.TileWidth;
            var top = cell.Row * layer.TileHeight;
            var width = Math.Min(Math.Min(texture.Width, layer.TileWidth), layer.LayerWidth - left);
            var height = Math.Min(Math.Min(texture.Height, layer.TileHeight), layer.LayerHeight - top);

            if (width <= 0 || height <= 0)
            {
                continue;
            }

            if (texture.Width < Math.Min(layer.TileWidth, layer.LayerWidth - left) ||
                texture.Height < Math.Min(layer.TileHeight, layer.LayerHeight - top))
            {
                failures++;

                if (problems.Count < MaxProblemsReported)
                {
                    problems.Add(
                        $"tile r{cell.Row}c{cell.Column}: texture {texture.Width}x{texture.Height} " +
                        "is smaller than its grid cell.");
                }

                continue;
            }

            for (var y = 0; y < height; y++)
            {
                Buffer.BlockCopy(
                    texture.Pixels, y * texture.Width * 4,
                    canvas.Pixels, ((top + y) * layer.LayerWidth + left) * 4,
                    width * 4);
            }

            placed++;
        }

        if (failures > MaxProblemsReported)
        {
            problems.Add($"... {failures - MaxProblemsReported} more tile failure(s).");
        }

        return new CompositionResult(canvas, placed, layer.ExpectedTiles, problems);
    }

    /// <summary>
    /// Applies WorldMapOverlay regions on a base canvas through the Companion's verified,
    /// transactional compositor. Returns null (base untouched) when any tile is unusable.
    /// </summary>
    public static (BgraImage? Image, int Tiles, string? Failure) ApplyOverlays(
        BgraImage baseImage,
        IReadOnlyList<FullRevealRegion> regions,
        TextureCache textures,
        CancellationToken cancellationToken)
    {
        FullRevealTile? Load(int fileDataId)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var texture = textures.Get(fileDataId, out _);
            return texture is null ? null : new FullRevealTile(texture.Pixels, texture.Width, texture.Height);
        }

        if (!FullRevealMapArt.TryCompose(
                baseImage.Pixels, baseImage.Width, baseImage.Height, regions, Load,
                out var pixels, out var count, out var failure))
        {
            return (null, 0, failure);
        }

        return (new BgraImage(baseImage.Width, baseImage.Height, pixels), count, null);
    }

    public static IReadOnlyList<FullRevealRegion>? ToRegions(IReadOnlyList<OverlayPlan> overlays, out string? problem)
    {
        problem = null;
        var regions = new List<FullRevealRegion>();

        foreach (var overlay in overlays)
        {
            var columns = (overlay.Width + 255) / 256;
            var rows = (overlay.Height + 255) / 256;

            if (overlay.Width <= 0 || overlay.Height <= 0 || overlay.Tiles.Count != columns * rows)
            {
                problem = $"overlay {overlay.Id} has {overlay.Tiles.Count} tiles for a {columns}x{rows} grid";
                return null;
            }

            var ordered = overlay.Tiles.OrderBy(tile => tile.Row).ThenBy(tile => tile.Column).ToList();

            if (ordered.Select((tile, index) => tile.Row * columns + tile.Column == index).Any(ok => !ok))
            {
                problem = $"overlay {overlay.Id} tile grid is not contiguous";
                return null;
            }

            regions.Add(new FullRevealRegion(
                overlay.Width, overlay.Height, overlay.OffsetX, overlay.OffsetY,
                ordered.Select(tile => tile.FileDataId).ToArray()));
        }

        return regions;
    }

    /// <summary>
    /// True when the client's own overlay data equals the Companion's reviewed atlas for
    /// the same art (exact geometry and FileDataIDs, order-insensitive).
    /// </summary>
    public static bool? MatchesEmbeddedAtlas(int uiMapArtId, IReadOnlyList<FullRevealRegion> regions)
    {
        if (!FullRevealMapArt.GetEmbeddedAtlas().TryGetValue(uiMapArtId, out var reference))
        {
            return null;
        }

        static string Key(FullRevealRegion r) =>
            $"{r.OffsetX},{r.OffsetY},{r.Width},{r.Height}:{string.Join(',', r.FileDataIds)}";

        return reference.Select(Key).OrderBy(k => k, StringComparer.Ordinal)
            .SequenceEqual(regions.Select(Key).OrderBy(k => k, StringComparer.Ordinal));
    }
}
