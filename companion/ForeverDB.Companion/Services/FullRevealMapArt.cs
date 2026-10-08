using System.Globalization;
using System.Text.Json;

namespace ForeverDB.Companion.Services;

// WorldMapOverlay + WorldMapOverlayTile metadata from the WoW Forever 1.60.1.70009
// client. Source: jonlipin/map-tab (MIT), Data/MapOverlays.lua, 2026.
// NO Blizzard artwork is embedded: FileDataIDs are read from the user's CASC.
public sealed record FullRevealRegion(
    int Width,
    int Height,
    int OffsetX,
    int OffsetY,
    IReadOnlyList<int> FileDataIds);

public sealed record FullRevealTile(
    byte[] Bgra,
    int Width,
    int Height);

public static class FullRevealMapArt
{
    public const string SourceBuildVersion = "1.60.1.70009";
    public const string VariantId = "full-overlays-70009-maptab-13cafe8e-v1";

    private const int TileSize = 256;
    private const string ResourceName =
        "ForeverDB.Companion.FullRevealOverlays.json";

    private static readonly Lazy<
        IReadOnlyDictionary<long, IReadOnlyList<FullRevealRegion>>> Data =
        new(Load);

    public static int MapCount => Data.Value.Count;
    public static int OverlayCount => Data.Value.Values.Sum(regions => regions.Count);
    public static int TileCount => Data.Value.Values.Sum(
        regions => regions.Sum(region => region.FileDataIds.Count));

    // Describe an exact-build/atlas gate failure without attempting any
    // cross-build FileDataID lookups. Keep the displayed version compact and
    // numeric so diagnostic UI cannot leak arbitrary .build.info strings.
    public static string ExplainUnavailability(
        long mapArtId,
        IReadOnlyList<string> activeBuildVersions)
    {
        if (!Data.Value.ContainsKey(mapArtId))
        {
            return $"art #{mapArtId} is not in the reveal atlas";
        }

        if (activeBuildVersions.Contains(
                SourceBuildVersion,
                StringComparer.Ordinal))
        {
            return "";
        }

        var installed = activeBuildVersions
            .Where(version => !string.IsNullOrWhiteSpace(version))
            .Select(version =>
                new string(version
                    .Where(character =>
                        char.IsAsciiDigit(character) || character == '.')
                    .Take(32)
                    .ToArray()))
            .Where(version => version.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .Take(3)
            .ToArray();

        return installed.Length == 0
            ? $"active client build unknown; atlas requires {SourceBuildVersion}"
            : $"active build {string.Join(", ", installed)}; atlas requires {SourceBuildVersion}";
    }

    public static IReadOnlyList<FullRevealRegion> Find(
        long mapArtId,
        string? activeBuildVersion)
    {
        if (!string.Equals(
                activeBuildVersion,
                SourceBuildVersion,
                StringComparison.Ordinal))
        {
            return Array.Empty<FullRevealRegion>();
        }

        return Data.Value.TryGetValue(mapArtId, out var regions)
            ? regions
            : Array.Empty<FullRevealRegion>();
    }

    // Transactional: a missing/corrupt overlay leaves the original base art intact.
    // Geometry uses the same map-canvas pixels and row-major 256px tiles as WoW.
    public static bool TryCompose(
        byte[] baseBgra,
        int canvasWidth,
        int canvasHeight,
        IReadOnlyList<FullRevealRegion> regions,
        Func<int, FullRevealTile?> loadTile,
        out byte[] result,
        out int tileCount,
        out string failure)
    {
        result = baseBgra;
        tileCount = 0;
        failure = "";

        if (canvasWidth <= 0 ||
            canvasHeight <= 0 ||
            baseBgra.LongLength !=
                (long)canvasWidth * canvasHeight * 4 ||
            regions.Count == 0)
        {
            failure = "Missing or invalid map dimensions/overlay manifest.";
            return false;
        }

        var target = (byte[])baseBgra.Clone();

        foreach (var region in regions)
        {
            if (region.Width <= 0 ||
                region.Height <= 0 ||
                region.Width > 4096 ||
                region.Height > 4096 ||
                Math.Abs((long)region.OffsetX) > 4096 ||
                Math.Abs((long)region.OffsetY) > 4096)
            {
                failure = "Invalid exploration overlay geometry.";
                return false;
            }

            var columns = (region.Width + TileSize - 1) / TileSize;
            var rows = (region.Height + TileSize - 1) / TileSize;

            if (region.FileDataIds.Count != columns * rows)
            {
                failure = "Exploration overlay has an incomplete tile manifest.";
                return false;
            }

            for (var row = 0; row < rows; row++)
            {
                for (var column = 0; column < columns; column++)
                {
                    var id = region.FileDataIds[row * columns + column];
                    FullRevealTile? tile;

                    try
                    {
                        tile = id > 0 ? loadTile(id) : null;
                    }
                    catch
                    {
                        tile = null;
                    }

                    var width = Math.Min(
                        TileSize, region.Width - column * TileSize);
                    var height = Math.Min(
                        TileSize, region.Height - row * TileSize);

                    if (tile is null ||
                        tile.Width < width ||
                        tile.Height < height ||
                        tile.Bgra.LongLength <
                            (long)tile.Width * tile.Height * 4)
                    {
                        failure =
                            $"overlay FileDataID {id} unavailable or corrupt " +
                            $"(region {region.OffsetX},{region.OffsetY}; " +
                            $"tile {row * columns + column + 1}/{region.FileDataIds.Count})";
                        return false;
                    }

                    BlendTile(
                        target,
                        canvasWidth,
                        canvasHeight,
                        tile,
                        region.OffsetX + column * TileSize,
                        region.OffsetY + row * TileSize,
                        width,
                        height);

                    tileCount++;
                }
            }
        }

        result = target;
        return true;
    }

    private static void BlendTile(
        byte[] target,
        int targetWidth,
        int targetHeight,
        FullRevealTile tile,
        int left,
        int top,
        int width,
        int height)
    {
        // Crop the padded power-of-two BLP edges; preserve alpha and clip
        // any overlay extending past the native map canvas.
        for (var y = Math.Max(0, -top);
             y < height && top + y < targetHeight;
             y++)
        {
            for (var x = Math.Max(0, -left);
                 x < width && left + x < targetWidth;
                 x++)
            {
                var src = (y * tile.Width + x) * 4;
                var dst =
                    ((top + y) * targetWidth + left + x) * 4;
                var alpha = tile.Bgra[src + 3];

                if (alpha == 0)
                {
                    continue;
                }

                if (alpha == 255)
                {
                    target[dst] = tile.Bgra[src];
                    target[dst + 1] = tile.Bgra[src + 1];
                    target[dst + 2] = tile.Bgra[src + 2];
                    target[dst + 3] = 255;
                    continue;
                }

                var destinationAlpha = target[dst + 3];
                var retainedDestinationAlpha =
                    (destinationAlpha * (255 - alpha) + 127) / 255;
                var outputAlpha = alpha + retainedDestinationAlpha;

                for (var channel = 0; channel < 3; channel++)
                {
                    target[dst + channel] = (byte)(
                        (tile.Bgra[src + channel] * alpha +
                         target[dst + channel] * retainedDestinationAlpha +
                         outputAlpha / 2) / outputAlpha);
                }

                target[dst + 3] = (byte)outputAlpha;
            }
        }
    }

    private static IReadOnlyDictionary<
        long, IReadOnlyList<FullRevealRegion>> Load()
    {
        var maps = new Dictionary<
            long, IReadOnlyList<FullRevealRegion>>();

        try
        {
            using var stream =
                typeof(FullRevealMapArt).Assembly
                    .GetManifestResourceStream(ResourceName);

            if (stream is null)
            {
                return maps;
            }

            using var json = JsonDocument.Parse(stream);

            if (json.RootElement.GetProperty("sourceBuild").GetString() !=
                SourceBuildVersion)
            {
                return maps;
            }

            foreach (var art in
                     json.RootElement.GetProperty("art").EnumerateObject())
            {
                if (!long.TryParse(
                        art.Name,
                        NumberStyles.Integer,
                        CultureInfo.InvariantCulture,
                        out var artId))
                {
                    continue;
                }

                var regions = new List<FullRevealRegion>();

                foreach (var record in art.Value.EnumerateArray())
                {
                    var ids = record.GetProperty("ids")
                        .EnumerateArray()
                        .Select(id => id.GetInt32())
                        .ToArray();

                    regions.Add(new FullRevealRegion(
                        record.GetProperty("w").GetInt32(),
                        record.GetProperty("h").GetInt32(),
                        record.GetProperty("x").GetInt32(),
                        record.GetProperty("y").GetInt32(),
                        ids));
                }

                if (regions.Count > 0)
                {
                    maps[artId] = regions;
                }
            }
        }
        catch (Exception)
        {
            // Malformed/missing resource cannot prevent normal map rendering.
            return new Dictionary<long, IReadOnlyList<FullRevealRegion>>();
        }

        return maps;
    }
}
