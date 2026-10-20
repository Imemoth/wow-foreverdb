using System.Security.Cryptography;
using System.Text;
using ForeverDB.AtlasExporter.Enumeration;

namespace ForeverDB.AtlasExporter.Export;

public sealed class StateItem
{
    public string Status { get; set; } = "";
    public string Fingerprint { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public List<ImageRecord> Images { get; set; } = new();
    public string? RevealStatus { get; set; }
    public int OverlayTiles { get; set; }
    public string? RevealCompleteness { get; set; }
    public List<string> RevealSkippedOverlays { get; set; } = new();
    public List<string> Problems { get; set; } = new();
}

/// <summary>
/// Resume/incremental bookkeeping, kept in <c>.state/</c> (never packaged).
/// An item is skipped only when the build+settings signature, the art fingerprint,
/// the files and the recorded hash all still match; failures are always retried.
/// </summary>
public sealed class ExportState
{
    public int SchemaVersion { get; set; } = 1;
    public string Signature { get; set; } = "";
    public Dictionary<string, StateItem> Items { get; set; } = new(StringComparer.Ordinal);

    public static string PathFor(string outputDirectory) =>
        Path.Combine(outputDirectory, ".state", "export-state.json");

    public static ExportState Load(string outputDirectory)
    {
        var path = PathFor(outputDirectory);

        try
        {
            if (File.Exists(path))
            {
                return JsonOut.Deserialize<ExportState>(File.ReadAllText(path)) ?? new ExportState();
            }
        }
        catch (Exception ex) when (ex is IOException or System.Text.Json.JsonException)
        {
        }

        return new ExportState();
    }

    public void Save(string outputDirectory) =>
        JsonOut.WriteAtomic(PathFor(outputDirectory), JsonOut.Serialize(this));

    public static string Hash(string text) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    public static string ComputeSignature(BuildIdentity identity, ExportOptions options) =>
        Hash(string.Join('|',
            "v1", identity.Product, identity.Version, identity.BuildKey,
            options.Webp.ToString(), options.IncludeFullReveal, options.AllLayers,
            options.DetailLayer, options.AllowPartial)
            + (options.AllowPartialReveal ? "|partial-reveal" : ""));

    public static string Fingerprint(ArtPlan art, bool includeOverlays)
    {
        var text = new StringBuilder();
        text.Append(art.UiMapArtId).Append(':').Append(art.StyleId);

        foreach (var layer in art.Layers.OrderBy(layer => layer.LayerIndex))
        {
            text.Append("|L").Append(layer.LayerIndex).Append(',').Append(layer.LayerWidth).Append('x')
                .Append(layer.LayerHeight).Append(',').Append(layer.TileWidth).Append('x').Append(layer.TileHeight);

            foreach (var tile in layer.Tiles)
            {
                text.Append(';').Append(tile.Row).Append('.').Append(tile.Column).Append('=').Append(tile.FileDataId);
            }
        }

        if (includeOverlays)
        {
            foreach (var overlay in art.Overlays.OrderBy(overlay => overlay.Id))
            {
                text.Append("|O").Append(overlay.Id).Append(',').Append(overlay.OffsetX).Append(',')
                    .Append(overlay.OffsetY).Append(',').Append(overlay.Width).Append('x').Append(overlay.Height);

                foreach (var tile in overlay.Tiles)
                {
                    text.Append(';').Append(tile.Row).Append('.').Append(tile.Column).Append('=').Append(tile.FileDataId);
                }
            }
        }

        return Hash(text.ToString());
    }
}
