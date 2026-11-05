using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using ForeverDB.AtlasExporter.Imaging;

namespace ForeverDB.AtlasExporter.Export;

public sealed record VerificationReport(
    int MapsChecked, int ImagesChecked, int ManifestsChecked, IReadOnlyList<string> Problems)
{
    public bool IsValid => Problems.Count == 0;
}

/// <summary>
/// Independent re-check of a finished export (folder or ZIP): re-hashes and re-decodes every image
/// and cross-checks index, manifests and report. Does not trust anything the exporter wrote
/// about itself except the claims it is asked to verify.
/// </summary>
public static class ExportVerifier
{
    public static VerificationReport VerifyZip(string zipPath)
    {
        var temp = Path.Combine(Path.GetTempPath(), "fdb-atlas-verify-" + Guid.NewGuid().ToString("N")[..8]);

        try
        {
            ZipFile.ExtractToDirectory(zipPath, temp);
            var roots = Directory.GetDirectories(temp);
            var root = roots.Length == 1 && File.Exists(Path.Combine(roots[0], "atlas", "index.json")) ? roots[0] : temp;
            return Verify(root);
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException)
        {
            return new VerificationReport(0, 0, 0, new[] { $"not a readable ZIP: {ex.Message}" });
        }
        finally
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

    public static VerificationReport Verify(string root)
    {
        var problems = new List<string>();
        var maps = 0;
        var images = 0;
        var manifests = 0;
        var indexPath = Path.Combine(root, "atlas", "index.json");

        foreach (var required in new[]
        {
            "atlas/index.json", "atlas/hierarchy.json", "atlas/build.json", "atlas/export-report.json",
            "diagnostics/export-summary.txt", "diagnostics/missing-maps.json", "diagnostics/extraction-errors.json"
        })
        {
            if (!File.Exists(Path.Combine(root, required.Replace('/', Path.DirectorySeparatorChar))))
            {
                problems.Add($"missing required file {required}");
            }
        }

        if (!File.Exists(indexPath))
        {
            return new VerificationReport(0, 0, 0, problems);
        }

        JsonElement index;

        try
        {
            index = JsonDocument.Parse(File.ReadAllText(indexPath)).RootElement;
        }
        catch (JsonException ex)
        {
            problems.Add($"atlas/index.json is not valid JSON: {ex.Message}");
            return new VerificationReport(0, 0, 0, problems);
        }

        var seenIds = new HashSet<int>();

        foreach (var map in index.GetProperty("maps").EnumerateArray())
        {
            maps++;
            var id = map.GetProperty("uiMapId").GetInt32();

            if (!seenIds.Add(id))
            {
                problems.Add($"map {id} appears twice in the index");
            }

            foreach (var variant in map.GetProperty("variants").EnumerateArray())
            {
                var name = variant.GetProperty("variant").GetString();
                var status = variant.GetProperty("status").GetString();
                var tag = $"map {id} [{name}]";
                var manifestRelative = variant.GetProperty("manifest").GetString();
                JsonElement? manifest = null;

                if (manifestRelative is null || !File.Exists(Path.Combine(root, manifestRelative)))
                {
                    problems.Add($"{tag}: manifest missing");
                }
                else
                {
                    manifests++;

                    try
                    {
                        manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, manifestRelative))).RootElement;

                        if (manifest.Value.GetProperty("zoneId").GetInt32() != id)
                        {
                            problems.Add($"{tag}: manifest zoneId differs from index");
                        }

                        if (manifest.Value.GetProperty("calibration").GetProperty("status").GetString() != "provisional")
                        {
                            problems.Add($"{tag}: calibration is not 'provisional'");
                        }
                    }
                    catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
                    {
                        problems.Add($"{tag}: manifest unreadable ({ex.GetType().Name})");
                    }
                }

                var recorded = variant.GetProperty("images").EnumerateArray().ToList();

                if (status is ItemStatus.Exported or ItemStatus.Reused or ItemStatus.Partial or ItemStatus.Alias && recorded.Count == 0)
                {
                    problems.Add($"{tag}: status '{status}' but no image recorded");
                }

                if (manifest is { } m && m.TryGetProperty("images", out var manifestImages) &&
                    manifestImages.GetArrayLength() != recorded.Count)
                {
                    problems.Add($"{tag}: manifest lists {manifestImages.GetArrayLength()} image(s), index {recorded.Count}");
                }

                foreach (var image in recorded)
                {
                    var relative = image.GetProperty("path").GetString()!;
                    var full = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));

                    if (!File.Exists(full))
                    {
                        problems.Add($"{tag}: image {relative} missing");
                        continue;
                    }

                    images++;
                    var bytes = File.ReadAllBytes(full);

                    if (bytes.LongLength != image.GetProperty("bytes").GetInt64())
                    {
                        problems.Add($"{tag}: {relative} size differs from the index");
                    }

                    if (!Convert.ToHexString(SHA256.HashData(bytes)).Equals(
                            image.GetProperty("sha256").GetString(), StringComparison.OrdinalIgnoreCase))
                    {
                        problems.Add($"{tag}: {relative} SHA-256 differs from the index");
                    }

                    var decoded = WebpCodec.TryDecode(bytes);

                    if (decoded is null)
                    {
                        problems.Add($"{tag}: {relative} is not a readable WebP");
                    }
                    else if (decoded.Width != image.GetProperty("width").GetInt32() ||
                             decoded.Height != image.GetProperty("height").GetInt32())
                    {
                        problems.Add($"{tag}: {relative} is {decoded.Width}x{decoded.Height}, index says " +
                                     $"{image.GetProperty("width").GetInt32()}x{image.GetProperty("height").GetInt32()}");
                    }
                }
            }
        }

        var reported = index.GetProperty("counts").GetProperty("mapsDiscovered").GetInt32();

        if (reported != maps)
        {
            problems.Add($"index counts {reported} maps but lists {maps}");
        }

        var onDisk = Directory.Exists(Path.Combine(root, "maps"))
            ? Directory.EnumerateFiles(Path.Combine(root, "maps"), "*.webp", SearchOption.AllDirectories).Count()
            : 0;
        var distinctIndexed = index.GetProperty("maps").EnumerateArray()
            .SelectMany(map => map.GetProperty("variants").EnumerateArray())
            .SelectMany(variant => variant.GetProperty("images").EnumerateArray())
            .Select(image => image.GetProperty("path").GetString()).Distinct().Count();

        if (onDisk != distinctIndexed)
        {
            problems.Add($"{onDisk} image file(s) on disk but {distinctIndexed} referenced by the index");
        }

        return new VerificationReport(maps, images, manifests, problems);
    }
}
