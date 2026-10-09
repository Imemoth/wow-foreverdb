using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace ForeverDB.Companion.Services;

// Pure, fail-closed validator for exact-build WorldMapOverlay DB2 CSV exports.
// Only a complete, internally consistent source can verify existing map arts.
// No FileDataIDs or geometry from an untrusted export are rendered: all art
// remains sourced from the embedded, reviewed MIT-attributed atlas.
public sealed class AtlasMetadataComparison
{
    public bool SourceValid { get; init; }
    public IReadOnlyList<long> VerifiedArtIds { get; init; } =
        Array.Empty<long>();
    public int SourceArtCount { get; init; }
    public int SourceRegionCount { get; init; }
    public int SourceTileCount { get; init; }
    public string Reason { get; init; } = "";
}

public static class AtlasMetadataVerifier
{
    public const int MaximumCsvCharacters = 16 * 1024 * 1024;

    public static readonly IReadOnlyList<string> RequiredTables =
        new[]
        {
            "WorldMapOverlay",
            "WorldMapOverlayTile",
            "UiMapArt",
            "UiMapArtStyleLayer"
        };

    private sealed record Overlay(
        int Id, long Art, int X, int Y, int Width, int Height,
        int PlayerCondition);
    private sealed record Tile(
        int OverlayId, int Layer, int Row, int Column, int FileId);
    private sealed record Art(long Id, int Style);
    private sealed record Layer(int Style, int Index, int Width, int Height);

    public static string Fingerprint(
        IReadOnlyDictionary<long, IReadOnlyList<FullRevealRegion>> atlas)
    {
        var canonical = new StringBuilder();

        foreach (var art in atlas.OrderBy(item => item.Key))
        {
            canonical.Append(art.Key).Append('|');

            foreach (var region in SortRegions(art.Value))
            {
                canonical.Append(region.OffsetX).Append(',')
                    .Append(region.OffsetY).Append(',')
                    .Append(region.Width).Append(',')
                    .Append(region.Height).Append(':');

                foreach (var id in region.FileDataIds)
                {
                    canonical.Append(id).Append(',');
                }

                canonical.Append(';');
            }
        }

        return Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString())));
    }

    public static AtlasMetadataComparison Compare(
        IReadOnlyDictionary<string, string> exports,
        IReadOnlyDictionary<long, IReadOnlyList<FullRevealRegion>> atlas)
    {
        try
        {
            var overlays = ReadTable(
                exports, "WorldMapOverlay",
                "ID", "UiMapArtID", "OffsetX", "OffsetY",
                "TextureWidth", "TextureHeight", "PlayerConditionID")
                .Select(row => new Overlay(
                    Number(row, "ID"), Number(row, "UiMapArtID"),
                    Number(row, "OffsetX"), Number(row, "OffsetY"),
                    Number(row, "TextureWidth"),
                    Number(row, "TextureHeight"),
                    Number(row, "PlayerConditionID")))
                .ToDictionary(row => row.Id);

            var tiles = ReadTable(
                exports, "WorldMapOverlayTile",
                "ID", "WorldMapOverlayID", "LayerIndex", "RowIndex",
                "ColIndex", "FileDataID")
                .Select(row => new
                {
                    Id = Number(row, "ID"),
                    Value = new Tile(
                        Number(row, "WorldMapOverlayID"),
                        Number(row, "LayerIndex"),
                        Number(row, "RowIndex"),
                        Number(row, "ColIndex"),
                        Number(row, "FileDataID"))
                })
                .ToDictionary(row => row.Id, row => row.Value);

            var arts = ReadTable(
                exports, "UiMapArt", "ID", "UiMapArtStyleID")
                .Select(row => new Art(
                    Number(row, "ID"), Number(row, "UiMapArtStyleID")))
                .ToDictionary(row => row.Id);

            var layers = ReadTable(
                exports, "UiMapArtStyleLayer",
                "ID", "UiMapArtStyleID", "LayerIndex",
                "TileWidth", "TileHeight")
                .Select(row => new
                {
                    Id = Number(row, "ID"),
                    Value = new Layer(
                        Number(row, "UiMapArtStyleID"),
                        Number(row, "LayerIndex"),
                        Number(row, "TileWidth"),
                        Number(row, "TileHeight"))
                })
                .ToDictionary(row => row.Id, row => row.Value);

            if (overlays.Count == 0 || tiles.Count == 0 ||
                arts.Count == 0 || layers.Count == 0)
            {
                throw new InvalidDataException(
                    "At least one source DB2 table is empty.");
            }

            var styleLayers = new Dictionary<(int Style, int Layer), Layer>();

            foreach (var layer in layers.Values)
            {
                if (layer.Width <= 0 || layer.Height <= 0 ||
                    !styleLayers.TryAdd((layer.Style, layer.Index), layer))
                {
                    throw new InvalidDataException(
                        "A DB2 map style layer is invalid or duplicated.");
                }
            }

            var tileGroups = new Dictionary<int, List<Tile>>();

            foreach (var tile in tiles.Values)
            {
                if (!overlays.ContainsKey(tile.OverlayId) ||
                    tile.Layer < 0 || tile.Row < 0 || tile.Column < 0 ||
                    tile.FileId <= 0)
                {
                    throw new InvalidDataException(
                        "An exploration tile is invalid or orphaned.");
                }

                if (!tileGroups.TryGetValue(tile.OverlayId, out var group))
                {
                    group = new List<Tile>();
                    tileGroups.Add(tile.OverlayId, group);
                }

                group.Add(tile);
            }

            var current = new Dictionary<long, List<FullRevealRegion>>();
            var rectangles = new HashSet<(long, int, int, int, int)>();
            var tileCount = 0;

            foreach (var overlay in overlays.Values)
            {
                if (!tileGroups.TryGetValue(overlay.Id, out var regionTiles) ||
                    regionTiles.Count == 0)
                {
                    continue;
                }

                if (overlay.PlayerCondition != 0 ||
                    overlay.Width <= 0 || overlay.Height <= 0 ||
                    overlay.X < 0 || overlay.Y < 0 ||
                    overlay.Width > 4096 || overlay.Height > 4096 ||
                    !arts.TryGetValue(overlay.Art, out var art) ||
                    !rectangles.Add((
                        overlay.Art, overlay.X, overlay.Y,
                        overlay.Width, overlay.Height)))
                {
                    throw new InvalidDataException(
                        "Unsupported conditional, missing or duplicated exploration region.");
                }

                var groupByLayer = regionTiles.GroupBy(t => t.Layer).ToArray();

                // The embedded atlas represents only native base art layer 0.
                // Never silently discard extra layers or guess a zoom transform.
                if (groupByLayer.Length != 1 || groupByLayer[0].Key != 0 ||
                    !styleLayers.TryGetValue((art.Style, 0), out var layer) ||
                    layer.Width != 256 || layer.Height != 256)
                {
                    throw new InvalidDataException(
                        "Exploration layer layout changed from 256px base art.");
                }

                var columns = (overlay.Width + 255) / 256;
                var rows = (overlay.Height + 255) / 256;
                var tileCoordinates = new Dictionary<(int Row, int Col), int>();

                foreach (var tile in regionTiles)
                {
                    if (tile.Row >= rows || tile.Column >= columns ||
                        !tileCoordinates.TryAdd((tile.Row, tile.Column), tile.FileId))
                    {
                        throw new InvalidDataException(
                            "An exploration tile position is duplicated or out of range.");
                    }
                }

                if (tileCoordinates.Count != rows * columns)
                {
                    throw new InvalidDataException(
                        "Exploration texture grid is incomplete.");
                }

                var ids = new List<int>(tileCoordinates.Count);

                for (var row = 0; row < rows; row++)
                {
                    for (var col = 0; col < columns; col++)
                    {
                        ids.Add(tileCoordinates[(row, col)]);
                    }
                }

                tileCount += ids.Count;

                if (!current.TryGetValue(overlay.Art, out var regions))
                {
                    regions = new List<FullRevealRegion>();
                    current.Add(overlay.Art, regions);
                }

                regions.Add(new FullRevealRegion(
                    overlay.Width, overlay.Height,
                    overlay.X, overlay.Y, ids));
            }

            var verified = new List<long>();

            foreach (var original in atlas)
            {
                if (current.TryGetValue(original.Key, out var candidate) &&
                    EqualRegions(original.Value, candidate))
                {
                    verified.Add(original.Key);
                }
            }

            return new AtlasMetadataComparison
            {
                SourceValid = true,
                VerifiedArtIds = verified.OrderBy(id => id).ToArray(),
                SourceArtCount = current.Count,
                SourceRegionCount = current.Sum(entry => entry.Value.Count),
                SourceTileCount = tileCount,
                Reason = verified.Count == 0
                    ? "No existing map art matches the installed build's DB2 data."
                    : $"Verified {verified.Count}/{atlas.Count} embedded map arts " +
                      "against the exact-build DB2 tables."
            };
        }
        catch (Exception ex) when (
            ex is InvalidDataException or ArgumentException or
            FormatException or OverflowException or
            KeyNotFoundException or InvalidOperationException)
        {
            return new AtlasMetadataComparison
            {
                SourceValid = false,
                Reason = $"Invalid or incompatible DB2 export ({ex.GetType().Name})."
            };
        }
    }

    private static bool EqualRegions(
        IReadOnlyList<FullRevealRegion> left,
        IReadOnlyList<FullRevealRegion> right)
    {
        if (left.Count != right.Count)
        {
            return false;
        }

        var a = SortRegions(left);
        var b = SortRegions(right);

        return a.Zip(b).All(pair =>
            pair.First.OffsetX == pair.Second.OffsetX &&
            pair.First.OffsetY == pair.Second.OffsetY &&
            pair.First.Width == pair.Second.Width &&
            pair.First.Height == pair.Second.Height &&
            pair.First.FileDataIds.SequenceEqual(pair.Second.FileDataIds));
    }

    private static FullRevealRegion[] SortRegions(
        IReadOnlyList<FullRevealRegion> regions) =>
        regions.OrderBy(r => r.OffsetX)
            .ThenBy(r => r.OffsetY)
            .ThenBy(r => r.Width)
            .ThenBy(r => r.Height)
            .ToArray();

    private static int Number(
        IReadOnlyDictionary<string, string> row, string key)
    {
        if (!row.TryGetValue(key, out var value) ||
            !int.TryParse(value.Trim(), NumberStyles.Integer,
                CultureInfo.InvariantCulture, out var result))
        {
            throw new InvalidDataException("Numeric DB2 field is invalid.");
        }

        return result;
    }

    private static List<Dictionary<string, string>> ReadTable(
        IReadOnlyDictionary<string, string> exports,
        string table, params string[] columns)
    {
        if (!exports.TryGetValue(table, out var content) ||
            string.IsNullOrWhiteSpace(content) ||
            content.Length > MaximumCsvCharacters)
        {
            throw new InvalidDataException("A required DB2 CSV is missing or too large.");
        }

        var rows = ParseCsv(content.TrimStart('\uFEFF'));

        if (rows.Count < 2)
        {
            throw new InvalidDataException("The DB2 CSV has no records.");
        }

        var headers = rows[0]
            .Select((column, index) => new { column, index })
            .ToArray();

        if (headers.GroupBy(h => h.column, StringComparer.Ordinal)
            .Any(group => group.Count() != 1))
        {
            throw new InvalidDataException("Duplicate DB2 CSV header.");
        }

        var indexes = headers.ToDictionary(
            h => h.column, h => h.index, StringComparer.Ordinal);

        if (columns.Any(column => !indexes.ContainsKey(column)))
        {
            throw new InvalidDataException("DB2 CSV schema changed.");
        }

        var result = new List<Dictionary<string, string>>(rows.Count - 1);

        foreach (var values in rows.Skip(1))
        {
            if (values.Length != indexes.Count)
            {
                throw new InvalidDataException("DB2 CSV record width changed.");
            }

            var row = new Dictionary<string, string>(StringComparer.Ordinal);

            foreach (var column in columns)
            {
                row.Add(column, values[indexes[column]]);
            }

            result.Add(row);
        }

        return result;
    }

    // RFC 4180 quoted fields, including comma/escaped quote/newline.
    // Strict enough to reject unterminated data rather than comparing
    // partially downloaded files as if they were complete.
    private static List<string[]> ParseCsv(string content)
    {
        var rows = new List<string[]>();
        var row = new List<string>();
        var field = new StringBuilder();
        var quoted = false;
        var closedQuote = false;

        for (var index = 0; index < content.Length; index++)
        {
            var ch = content[index];

            if (quoted)
            {
                if (ch == '"')
                {
                    if (index + 1 < content.Length &&
                        content[index + 1] == '"')
                    {
                        field.Append('"');
                        index++;
                    }
                    else
                    {
                        quoted = false;
                        closedQuote = true;
                    }
                }
                else
                {
                    field.Append(ch);
                }
            }
            else if (ch == '"' && field.Length == 0 && !closedQuote)
            {
                quoted = true;
            }
            else if (ch == ',' || ch == '\r' || ch == '\n')
            {
                row.Add(field.ToString());
                field.Clear();
                closedQuote = false;

                if (ch != ',')
                {
                    if (ch == '\r' && index + 1 < content.Length &&
                        content[index + 1] == '\n')
                    {
                        index++;
                    }

                    if (row.Any(value => value.Length != 0))
                    {
                        rows.Add(row.ToArray());
                    }

                    row.Clear();
                }
            }
            else if (ch == '"' || closedQuote)
            {
                throw new InvalidDataException("Malformed quoted CSV field.");
            }
            else
            {
                field.Append(ch);
            }
        }

        if (quoted)
        {
            throw new InvalidDataException("Unterminated quoted CSV field.");
        }

        row.Add(field.ToString());

        if (row.Any(value => value.Length != 0))
        {
            rows.Add(row.ToArray());
        }

        return rows;
    }
}
