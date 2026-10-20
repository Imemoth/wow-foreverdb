using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using ForeverDB.AtlasExporter.Enumeration;

namespace ForeverDB.AtlasExporter.Export;

public sealed record SeedReport(int Imported, int Skipped, IReadOnlyList<string> Notes)
{
    public bool Refused { get; init; }
}

/// <summary>
/// Imports the verified images of an earlier export (folder or delivery ZIP) into a new output
/// folder as resumable state, so a follow-up run regenerates only what is missing, failed or changed.
/// Only images of the same client build whose hash, size and dimensions still check out are adopted.
/// </summary>
public static class ExportSeeder
{
    public static SeedReport Seed(
        string source, string outputRoot, AtlasPlan plan, BuildIdentity identity, ExportOptions options)
    {
        var temp = (string?)null;
        var root = source;

        try
        {
            if (source.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            {
                temp = Path.Combine(Path.GetTempPath(), "fdb-atlas-seed-" + Guid.NewGuid().ToString("N")[..8]);
                ZipFile.ExtractToDirectory(source, temp);
                var roots = Directory.GetDirectories(temp);
                root = roots.Length == 1 && File.Exists(Path.Combine(roots[0], "atlas", "index.json")) ? roots[0] : temp;
            }

            return SeedFrom(root, outputRoot, plan, identity, options);
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or JsonException or UnauthorizedAccessException)
        {
            return new SeedReport(0, 0, new[] { $"could not read the earlier export: {ex.Message}" }) { Refused = true };
        }
        finally
        {
            if (temp is not null)
            {
                try
                {
                    Directory.Delete(temp, recursive: true);
                }
                catch (IOException)
                {
                }
            }
        }
    }

    private static SeedReport SeedFrom(
        string root, string outputRoot, AtlasPlan plan, BuildIdentity identity, ExportOptions options)
    {
        var notes = new List<string>();
        var indexPath = Path.Combine(root, "atlas", "index.json");

        if (!File.Exists(indexPath))
        {
            return new SeedReport(0, 0, new[] { "no atlas/index.json in the earlier export" }) { Refused = true };
        }

        var index = JsonDocument.Parse(File.ReadAllText(indexPath)).RootElement;
        var oldKey = index.GetProperty("client").GetProperty("buildKey").GetString() ?? "";

        if (!oldKey.Equals(identity.BuildKey, StringComparison.OrdinalIgnoreCase))
        {
            return new SeedReport(0, 0, new[]
            {
                $"the earlier export is from build key {oldKey}, this client is {identity.BuildKey}; nothing is reused across builds"
            }) { Refused = true };
        }

        Directory.CreateDirectory(outputRoot);
        var state = ExportState.Load(outputRoot);
        var signature = ExportState.ComputeSignature(identity, options);

        if (state.Signature != signature)
        {
            state = new ExportState { Signature = signature };
        }

        var imported = 0;
        var skipped = 0;
        var mapsById = plan.Maps.ToDictionary(map => map.UiMapId);

        foreach (var oldMap in index.GetProperty("maps").EnumerateArray())
        {
            var uiMapId = oldMap.GetProperty("uiMapId").GetInt32();

            foreach (var variant in oldMap.GetProperty("variants").EnumerateArray())
            {
                var status = variant.GetProperty("status").GetString();
                var name = variant.GetProperty("variant").GetString()!;
                var kind = variant.GetProperty("kind").GetString();
                var key = $"{uiMapId}/{name}";

                if (status is not (ItemStatus.Exported or ItemStatus.Reused) || state.Items.ContainsKey(key))
                {
                    if (status is ItemStatus.Exported or ItemStatus.Reused)
                    {
                        skipped++;
                    }

                    continue;
                }

                var artId = variant.GetProperty("uiMapArtId").GetInt32();
                var art = mapsById.GetValueOrDefault(uiMapId)?.Arts.FirstOrDefault(a => a.UiMapArtId == artId && a.IsDrawable);

                if (art is null)
                {
                    notes.Add($"{key}: art {artId} no longer exists on this client; not reused");
                    skipped++;
                    continue;
                }

                var item = new StateItem
                {
                    Status = ItemStatus.Exported,
                    Fingerprint = ExportState.Fingerprint(art, kind == "full-reveal"),
                    RevealStatus = variant.TryGetProperty("revealStatus", out var reveal) && reveal.ValueKind == JsonValueKind.String
                        ? reveal.GetString() : null
                };

                var manifestPath = variant.TryGetProperty("manifest", out var manifestProperty) && manifestProperty.ValueKind == JsonValueKind.String
                    ? Path.Combine(root, manifestProperty.GetString()!.Replace('/', Path.DirectorySeparatorChar))
                    : null;

                if (manifestPath is not null && File.Exists(manifestPath))
                {
                    var manifest = JsonDocument.Parse(File.ReadAllText(manifestPath)).RootElement;

                    if (manifest.TryGetProperty("provenance", out var provenance) &&
                        provenance.TryGetProperty("overlayTiles", out var overlayTiles) && overlayTiles.ValueKind == JsonValueKind.Number)
                    {
                        item.OverlayTiles = overlayTiles.GetInt32();
                    }
                }

                // An earlier exporter only produced a reveal when every overlay row was complete.
                item.RevealCompleteness = kind == "full-reveal" ? "complete" : null;

                var ok = true;
                var layers = art.Layers.OrderBy(layer => layer.LayerIndex).ToList();

                foreach (var image in variant.GetProperty("images").EnumerateArray())
                {
                    var relative = image.GetProperty("path").GetString()!;
                    var path = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
                    var role = image.GetProperty("role").GetString()!;
                    var width = image.GetProperty("width").GetInt32();
                    var height = image.GetProperty("height").GetInt32();
                    var layer = role == "overview" ? layers[0] : layers.FirstOrDefault(l => l.LayerWidth == width && l.LayerHeight == height);

                    if (!File.Exists(path) || layer is null || layer.LayerWidth != width || layer.LayerHeight != height ||
                        !Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).Equals(
                            image.GetProperty("sha256").GetString(), StringComparison.OrdinalIgnoreCase))
                    {
                        notes.Add($"{key}: {relative} failed verification; will be re-exported");
                        ok = false;
                        break;
                    }

                    item.Images.Add(new ImageRecord(
                        role, relative, width, height, image.GetProperty("bytes").GetInt64(),
                        image.GetProperty("sha256").GetString()!.ToLowerInvariant(), image.GetProperty("format").GetString()!,
                        image.GetProperty("layerIndex").GetInt32(), layer.ExpectedTiles, layer.ExpectedTiles));
                }

                if (!ok || item.Images.Count == 0)
                {
                    skipped++;
                    continue;
                }

                foreach (var image in item.Images)
                {
                    var target = Path.Combine(outputRoot, image.Path.Replace('/', Path.DirectorySeparatorChar));
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    File.Copy(Path.Combine(root, image.Path.Replace('/', Path.DirectorySeparatorChar)), target, overwrite: true);
                }

                item.Sha256 = item.Images[0].Sha256;
                state.Items[key] = item;
                imported++;
            }
        }

        state.Save(outputRoot);
        notes.Insert(0, $"adopted {imported} verified variant(s) from the earlier export; {skipped} not reused");
        return new SeedReport(imported, skipped, notes);
    }
}
