using System.Globalization;
using System.Text;
using ForeverDB.AtlasExporter.Client;
using ForeverDB.AtlasExporter.Enumeration;
using ForeverDB.AtlasExporter.Imaging;
using ForeverDB.AtlasExporter.Model;

namespace ForeverDB.AtlasExporter.Export;

/// <summary>
/// Writes the atlas/ and diagnostics/ files. Everything except diagnostics/run-info.json
/// is a pure function of the plan and results, so two runs produce identical bytes.
/// </summary>
public sealed class AtlasReportWriter
{
    public const long PagesFileLimit = 20_000;
    public const long PagesPerFileBytes = 25L * 1024 * 1024;

    private readonly AtlasPlan _plan;
    private readonly MapDatabase _database;
    private readonly BuildIdentity _identity;
    private readonly ExportOptions _options;
    private readonly Sanitizer _sanitizer;

    public AtlasReportWriter(
        AtlasPlan plan, MapDatabase database, BuildIdentity identity,
        ExportOptions options, Sanitizer sanitizer, IAssetSource assets)
    {
        _plan = plan;
        _database = database;
        _identity = identity;
        _options = options;
        _sanitizer = sanitizer;
        _ = assets;
    }

    private string Root => Path.GetFullPath(_options.OutputDirectory);

    public void WriteAll(ExportResult result, IReadOnlyList<AtlasMap> maps, bool thumbnails)
    {
        var summary = Summarize(result, maps);
        result.Summary = Merge(result.Summary, summary);
        DetermineStatus(result, maps);

        WriteIndex(result, maps);
        WriteHierarchy();
        WriteBuild();
        WriteMissingAndErrors(result, maps);
        WriteRegression(result);

        // The report quotes the file count/size of the very folder it lives in, itself included.
        // Counts only change digit width once, so this settles within a few passes.
        for (var pass = 0; pass < 4; pass++)
        {
            var before = (result.Summary.CdnFileCount, result.Summary.CdnMaxFileBytes);
            JsonOut.WriteAtomic(Path.Combine(Root, "atlas", "export-report.json"), JsonOut.Serialize(BuildReport(result)));
            MeasureCdnFit(result);

            if (before == (result.Summary.CdnFileCount, result.Summary.CdnMaxFileBytes))
            {
                break;
            }
        }

        JsonOut.WriteAtomic(
            Path.Combine(Root, "diagnostics", "run-info.json"),
            JsonOut.Serialize(new
            {
                startedUtc = _options.StartedUtc,
                elapsedSeconds = _options.ElapsedSeconds,
                note = "Volatile run data. Excluded from determinism guarantees."
            }));

        if (thumbnails)
        {
            GalleryWriter.Write(Root, BuildGallery(result, maps), _identity, _options.ThumbnailWidth);
        }

        result.Summary.ExportBytes = DirectorySize();
        WriteSummaryOnly(result);
    }

    public void WriteSummaryOnly(ExportResult result)
    {
        result.Summary.ExportBytes = DirectorySize();
        JsonOut.WriteAtomic(Path.Combine(Root, "diagnostics", "export-summary.txt"), SummaryText(result));
    }

    private static ExportSummary Merge(ExportSummary into, ExportSummary computed)
    {
        computed.TextureCacheHits = into.TextureCacheHits;
        computed.TextureCacheMisses = into.TextureCacheMisses;
        computed.ZipBytes = into.ZipBytes;
        return computed;
    }

    private static VariantResult? PrimaryBase(ExportResult result, int uiMapId) =>
        result.Variants.FirstOrDefault(v => v.UiMapId == uiMapId && v.Primary && v.Kind == "base");

    private ExportSummary Summarize(ExportResult result, IReadOnlyList<AtlasMap> maps)
    {
        var summary = new ExportSummary { MapsDiscovered = maps.Count };

        foreach (var map in maps)
        {
            summary.DiscoveredByCategory[map.Category] = summary.DiscoveredByCategory.GetValueOrDefault(map.Category) + 1;
        }

        foreach (var map in maps)
        {
            switch (map.Status)
            {
                case MapStatus.InheritsParent:
                    summary.MapsInherited++;
                    continue;
                case MapStatus.NoOwnArt or MapStatus.ArtIncomplete:
                    summary.MapsMissingArtwork++;
                    continue;
            }

            summary.DrawableMaps++;
            summary.DrawableByCategory[map.Category] = summary.DrawableByCategory.GetValueOrDefault(map.Category) + 1;
            var variant = PrimaryBase(result, map.UiMapId);

            if (variant is null)
            {
                // Not reached before cancellation.
                continue;
            }

            switch (variant.Status)
            {
                case ItemStatus.Exported:
                    summary.MapsExported++;
                    break;
                case ItemStatus.Reused:
                    summary.MapsReused++;
                    break;
                case ItemStatus.Alias:
                    summary.MapsSharedArt++;
                    break;
                case ItemStatus.Partial:
                    summary.MapsPartial++;
                    break;
                default:
                    summary.MapsFailed++;
                    break;
            }
        }

        return summary;
    }

    private void DetermineStatus(ExportResult result, IReadOnlyList<AtlasMap> maps)
    {
        var s = result.Summary;
        var okMaps = s.MapsExported + s.MapsReused + s.MapsSharedArt;
        var optionalProblems = result.Variants.Any(v =>
            (v.Kind != "base" || !v.Primary) && v.Status is ItemStatus.Failed or ItemStatus.Partial);

        if (result.Cancelled)
        {
            result.Status = "CANCELLED";
            result.ExitCode = 130;
        }
        else if (s.DrawableMaps == 0 || okMaps + s.MapsPartial == 0)
        {
            result.Status = "FAILED - no map was exported";
            result.ExitCode = 3;
        }
        else if (s.MapsFailed > 0 || s.MapsPartial > 0)
        {
            result.Status = "PARTIAL - some drawable maps could not be exported";
            result.ExitCode = 2;
        }
        else if (optionalProblems || result.Variants.Any(v => v.Status == ItemStatus.Failed))
        {
            result.Status = "COMPLETE WITH WARNINGS - every map exported, some extra variants failed";
            result.ExitCode = 0;
        }
        else
        {
            result.Status = "COMPLETE";
            result.ExitCode = 0;
        }

        _ = maps;
    }

    private static object ImageView(ImageRecord image) => new
    {
        image.Role, image.Path, image.Width, image.Height, image.Bytes, image.Sha256, image.Format, image.LayerIndex
    };

    private void WriteIndex(ExportResult result, IReadOnlyList<AtlasMap> maps)
    {
        var entries = maps.OrderBy(map => map.UiMapId).Select(map => new
        {
            map.UiMapId,
            map.Name,
            map.Slug,
            map.Category,
            map.CategorySource,
            map.InstanceKind,
            map.TypeName,
            map.System,
            map.Flags,
            map.ParentUiMapId,
            map.WorldMapId,
            map.Status,
            map.StatusDetail,
            map.InheritsFromUiMapId,
            MapArtIds = map.Arts.Select(art => art.UiMapArtId).Distinct().OrderBy(id => id).ToArray(),
            Variants = result.Variants.Where(v => v.UiMapId == map.UiMapId)
                .OrderBy(v => v.Variant, StringComparer.Ordinal)
                .Select(v => new
                {
                    v.Variant,
                    v.Kind,
                    v.UiMapArtId,
                    v.PhaseId,
                    v.Primary,
                    v.Status,
                    v.SharedWithUiMapId,
                    v.RevealStatus,
                    Manifest = v.ManifestPath,
                    Images = v.Images.Select(ImageView).ToArray(),
                    Problems = v.Problems.Count == 0 ? null : v.Problems.ToArray()
                }).ToArray()
        }).ToArray();

        JsonOut.WriteAtomic(Path.Combine(Root, "atlas", "index.json"), JsonOut.Serialize(new
        {
            SchemaVersion = 1,
            Kind = "foreverdb-atlas-export-index",
            Client = new { _identity.Product, _identity.Version, _identity.BuildKey, _identity.Region },
            MetadataSource = _identity.MetadataSource,
            Counts = new
            {
                result.Summary.MapsDiscovered,
                result.Summary.DrawableMaps,
                Exported = result.Summary.MapsExported + result.Summary.MapsReused,
                result.Summary.MapsSharedArt,
                result.Summary.MapsFailed,
                result.Summary.MapsMissingArtwork,
                result.Summary.MapsInherited
            },
            Maps = entries
        }));
    }

    private void WriteHierarchy()
    {
        var hierarchy = _plan.Hierarchy;
        JsonOut.WriteAtomic(Path.Combine(Root, "atlas", "hierarchy.json"), JsonOut.Serialize(new
        {
            SchemaVersion = 1,
            Roots = hierarchy.Roots.OrderBy(id => id).ToArray(),
            OrphanedByMissingParent = hierarchy.OrphanedByMissingParent.OrderBy(id => id).ToArray(),
            CycleMembers = hierarchy.CycleMembers.OrderBy(id => id).ToArray(),
            Nodes = hierarchy.Nodes.Values.Select(node => new
            {
                node.UiMapId, node.Name, node.ParentUiMapId, node.Depth, node.Children, node.ParentMissing
            }).ToArray(),
            Links = _plan.Links.Select(link => new { link.Parent, link.Child, link.Order }).ToArray(),
            Note = "Parent/child comes from UiMap.ParentUiMapID; Links are UiMapLink rows (clickable regions between maps)."
        }));
    }

    private void WriteBuild()
    {
        JsonOut.WriteAtomic(Path.Combine(Root, "atlas", "build.json"), JsonOut.Serialize(new
        {
            SchemaVersion = 1,
            Exporter = new { Name = "ForeverDB.AtlasExporter", Version = _options.ExporterVersion },
            Client = new { _identity.Product, _identity.Version, _identity.BuildKey, _identity.Region },
            MetadataSource = _identity.MetadataSource,
            MetadataAttempts = _options.MetadataAttempts
                .Select(a => new { a.Source, a.Succeeded, Detail = _sanitizer.Clean(a.Detail) }).ToArray(),
            OptionalTablesMissing = _database.MissingOptionalTables
                .OrderBy(pair => pair.Key, StringComparer.Ordinal)
                .ToDictionary(pair => pair.Key, pair => _sanitizer.Clean(pair.Value)),
            Encoder = _options.Webp.ToString(),
            FullReveal = _options.IncludeFullReveal,
            AllowPartial = _options.AllowPartial,
            Notes = _options.ClientNotes.Select(_sanitizer.Clean).ToArray(),
            Projection = "normalized-percent, top-left origin; pixelX = imageWidth * xPercent / 100",
            Calibration = "provisional"
        }));
    }

    private void WriteMissingAndErrors(ExportResult result, IReadOnlyList<AtlasMap> maps)
    {
        var missing = new List<object>();

        foreach (var map in maps.OrderBy(m => m.UiMapId))
        {
            if (map.Status != MapStatus.Drawable)
            {
                missing.Add(new
                {
                    map.UiMapId, map.Name, map.Category, map.TypeName, Reason = map.Status,
                    Detail = _sanitizer.Clean(map.StatusDetail), map.InheritsFromUiMapId
                });
            }
            else if (PrimaryBase(result, map.UiMapId) is { Status: ItemStatus.Failed or ItemStatus.Partial } variant)
            {
                missing.Add(new
                {
                    map.UiMapId, map.Name, map.Category, map.TypeName, Reason = variant.Status,
                    Detail = string.Join(" | ", variant.Problems.Take(4)), InheritsFromUiMapId = (int?)null
                });
            }
        }

        JsonOut.WriteAtomic(Path.Combine(Root, "diagnostics", "missing-maps.json"),
            JsonOut.Serialize(new { SchemaVersion = 1, Count = missing.Count, Maps = missing }));

        var errors = result.Variants
            .Where(v => v.Problems.Count > 0 || v.Status == ItemStatus.Failed)
            .OrderBy(v => v.UiMapId).ThenBy(v => v.Variant, StringComparer.Ordinal)
            .Select(v => new { v.UiMapId, v.Variant, v.Status, Problems = v.Problems.Select(_sanitizer.Clean).ToArray() })
            .ToArray();

        JsonOut.WriteAtomic(Path.Combine(Root, "diagnostics", "extraction-errors.json"),
            JsonOut.Serialize(new { SchemaVersion = 1, Count = errors.Length, Errors = errors }));
    }

    private void WriteRegression(ExportResult result)
    {
        const int referenceWidth = 1002;
        const int referenceHeight = 668;
        const string referenceSha = "a2856ed85f2545f2604e0a7e7fc41e9f270c78e84bf6c08885f43dd500b97678";
        var variant = result.Variants.FirstOrDefault(v => v.UiMapId == 1420 && v.Primary && v.Kind == "base");
        var image = variant?.Images.FirstOrDefault(i => i.Role == "overview");
        double? pixelError = null;
        string? pixelNote = null;

        if (image is not null && _options.Reference1420Image is { } referencePath && File.Exists(referencePath))
        {
            var reference = WebpCodec.TryDecode(File.ReadAllBytes(referencePath));
            var ours = WebpCodec.TryDecode(File.ReadAllBytes(Path.Combine(Root, image.Path)));

            if (reference is not null && ours is not null)
            {
                var (mean, _) = WebpCodec.Compare(reference, ours);
                pixelError = double.IsInfinity(mean) ? null : Math.Round(mean, 3);
                pixelNote = double.IsInfinity(mean) ? "dimensions differ; no pixel comparison" : null;
            }
        }

        JsonOut.WriteAtomic(Path.Combine(Root, "diagnostics", "regression-1420.json"), JsonOut.Serialize(new
        {
            SchemaVersion = 1,
            Subject = "Tirisfal Glades (uiMapID 1420) vs the P2-D proof-of-concept image",
            Discoverable = _plan.Maps.Any(m => m.UiMapId == 1420),
            Exported = image is not null,
            Reference = new { Width = referenceWidth, Height = referenceHeight, Sha256 = referenceSha },
            Actual = image is null ? null : new { image.Width, image.Height, image.Sha256 },
            DimensionsMatch = image is not null && image.Width == referenceWidth && image.Height == referenceHeight,
            AspectRatioMatches = image is not null &&
                Math.Abs(image.Width / (double)image.Height - referenceWidth / (double)referenceHeight) < 0.002,
            MeanRgbErrorVsReferenceImage = pixelError,
            Note = pixelNote ?? "Byte identity is not expected (different encoder/settings). Pass --reference-1420 <file> for a pixel comparison."
        }));
    }

    private void MeasureCdnFit(ExportResult result)
    {
        var files = new[] { "maps", "atlas" }
            .Select(folder => Path.Combine(Root, folder))
            .Where(Directory.Exists)
            .SelectMany(folder => Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories))
            .Where(path => !path.EndsWith(".tmp", StringComparison.Ordinal))
            .Select(path => new FileInfo(path))
            .ToList();

        result.Summary.CdnFileCount = files.Count;
        result.Summary.CdnMaxFileBytes = files.Count == 0 ? 0 : files.Max(file => file.Length);
    }

    private object BuildReport(ExportResult result)
    {
        var s = result.Summary;
        return new
        {
            SchemaVersion = 1,
            result.Status,
            Counts = new
            {
                s.MapsDiscovered, s.DrawableMaps, s.MapsExported, s.MapsReused, s.MapsSharedArt,
                s.MapsPartial, s.MapsFailed, s.MapsMissingArtwork, s.MapsInherited,
                VariantsExported = result.Variants.Count(v => v.Status is ItemStatus.Exported or ItemStatus.Reused),
                VariantsFailed = result.Variants.Count(v => v.Status == ItemStatus.Failed)
            },
            DiscoveredByCategory = s.DiscoveredByCategory.OrderBy(p => p.Key, StringComparer.Ordinal)
                .ToDictionary(p => p.Key, p => p.Value),
            DrawableByCategory = s.DrawableByCategory.OrderBy(p => p.Key, StringComparer.Ordinal)
                .ToDictionary(p => p.Key, p => p.Value),
            CloudflarePagesFree = new
            {
                FileLimit = PagesFileLimit,
                PerFileLimitBytes = PagesPerFileBytes,
                s.CdnFileCount,
                s.CdnMaxFileBytes,
                FitsFileCount = s.CdnFileCount <= PagesFileLimit,
                FitsPerFileSize = s.CdnMaxFileBytes <= PagesPerFileBytes,
                Note = "Counts maps/ and atlas/ only. No map was dropped to satisfy a limit."
            },
            FullRevealPolicy = "Overlay regions come from the client's own WorldMapOverlay tables; " +
                "'client-metadata-matches-reviewed-atlas' means identical to the Companion's reviewed atlas.",
            Limitations = new[]
            {
                "Calibration is provisional for every map.",
                "City category uses a small English name list; all other categories come from client metadata.",
                "Maps without a UiMapXMapArt row have no artwork and are listed, not synthesised."
            }
        };
    }

    private IReadOnlyList<GalleryEntry> BuildGallery(ExportResult result, IReadOnlyList<AtlasMap> maps)
    {
        var entries = new List<GalleryEntry>();

        foreach (var map in maps.OrderBy(m => m.UiMapId))
        {
            var variants = result.Variants.Where(v => v.UiMapId == map.UiMapId).ToList();

            if (variants.Count == 0)
            {
                entries.Add(new GalleryEntry
                {
                    UiMapId = map.UiMapId, Name = map.Name, Variant = "-", Category = map.Category,
                    InstanceKind = map.InstanceKind, Status = map.Status, Note = map.StatusDetail
                });
                continue;
            }

            foreach (var variant in variants.Where(v => v.Primary || v.Kind == "base"))
            {
                var overview = variant.Images.FirstOrDefault(i => i.Role == "overview");
                entries.Add(new GalleryEntry
                {
                    UiMapId = map.UiMapId,
                    Name = map.Name,
                    MapArtId = variant.UiMapArtId,
                    Variant = variant.Variant,
                    Category = map.Category,
                    InstanceKind = map.InstanceKind,
                    Status = variant.Status,
                    Width = overview?.Width ?? 0,
                    Height = overview?.Height ?? 0,
                    Image = overview?.Path,
                    SourceImagePath = overview?.Path,
                    ThumbFile = overview is null ? null : $"{map.UiMapId}-{variant.Variant}.webp",
                    Note = variant.Problems.Count > 0 ? _sanitizer.Clean(variant.Problems[0]) :
                        variant.SharedWithUiMapId is { } owner ? $"shares art with map {owner}" : null
                });
            }

            foreach (var variant in variants.Where(v => v.Kind == "full-reveal" && v.Primary))
            {
                var overview = variant.Images.FirstOrDefault(i => i.Role == "overview");
                entries.Add(new GalleryEntry
                {
                    UiMapId = map.UiMapId, Name = map.Name, MapArtId = variant.UiMapArtId,
                    Variant = variant.Variant, Category = map.Category, InstanceKind = map.InstanceKind,
                    Status = variant.Status, Width = overview?.Width ?? 0, Height = overview?.Height ?? 0,
                    Image = overview?.Path, SourceImagePath = overview?.Path,
                    ThumbFile = overview is null ? null : $"{map.UiMapId}-{variant.Variant}.webp",
                    Note = variant.RevealStatus
                });
            }
        }

        return entries;
    }

    private long DirectorySize() =>
        Directory.EnumerateFiles(Root, "*", SearchOption.AllDirectories)
            .Where(path => !path.Contains(Path.DirectorySeparatorChar + ".state" + Path.DirectorySeparatorChar))
            .Where(path => !path.EndsWith(".tmp", StringComparison.Ordinal))
            .Sum(path => new FileInfo(path).Length);

    public static string FormatBytes(long bytes)
    {
        string[] units = { "B", "KB", "MB", "GB" };
        var value = (double)bytes;
        var unit = 0;

        while (value >= 1024 && unit < units.Length - 1)
        {
            value /= 1024;
            unit++;
        }

        return string.Create(CultureInfo.InvariantCulture, $"{value:0.##} {units[unit]} ({bytes:N0} bytes)");
    }

    public string SummaryText(ExportResult result)
    {
        var s = result.Summary;
        int D(string key) => s.DiscoveredByCategory.GetValueOrDefault(key);
        int W(string key) => s.DrawableByCategory.GetValueOrDefault(key);
        var inv = CultureInfo.InvariantCulture;
        var builder = new StringBuilder();
        builder.Append("ForeverDB Atlas Export Summary\n\n");
        builder.Append(inv, $"Client product: {_identity.Product}\n");
        builder.Append(inv, $"Client build: {_identity.Version}\n");
        builder.Append(inv, $"Metadata source: {_identity.MetadataSource}\n\n");
        builder.Append(inv, $"Maps discovered: {s.MapsDiscovered}\n");
        builder.Append(inv, $"Drawable maps: {s.DrawableMaps}\n");
        builder.Append(inv, $"Successfully exported: {s.MapsExported + s.MapsReused + s.MapsSharedArt}" +
            $" (new {s.MapsExported}, reused {s.MapsReused}, shared art {s.MapsSharedArt})\n");
        builder.Append(inv, $"Partial: {s.MapsPartial}\n");
        builder.Append(inv, $"Failed: {s.MapsFailed}\n");
        builder.Append(inv, $"Missing artwork: {s.MapsMissingArtwork}\n");
        builder.Append(inv, $"Inherited from parent map: {s.MapsInherited}\n\n");
        builder.Append(inv, $"World maps: {D(Categories.World)} (drawable {W(Categories.World)})\n");
        builder.Append(inv, $"Continent maps: {D(Categories.Continent)} (drawable {W(Categories.Continent)})\n");
        builder.Append(inv, $"Zone maps: {D(Categories.Zone)} (drawable {W(Categories.Zone)})\n");
        builder.Append(inv, $"City maps: {D(Categories.City)} (drawable {W(Categories.City)})\n");
        builder.Append(inv, $"Instance maps: {D(Categories.Instance)} (drawable {W(Categories.Instance)})\n");
        builder.Append(inv, $"Other maps: {D(Categories.Special) + D(Categories.Other)}" +
            $" (drawable {W(Categories.Special) + W(Categories.Other)})\n\n");
        builder.Append(inv, $"Export size: {FormatBytes(s.ExportBytes)}\n");
        builder.Append(inv, $"ZIP size: {(s.ZipBytes > 0 ? FormatBytes(s.ZipBytes) : "not created")}\n");
        builder.Append(inv, $"Cloudflare Pages Free fit: {s.CdnFileCount} files " +
            $"(limit {PagesFileLimit:N0}), largest {FormatBytes(s.CdnMaxFileBytes)} (limit 25 MiB): " +
            $"{(s.CdnFileCount <= PagesFileLimit && s.CdnMaxFileBytes <= PagesPerFileBytes ? "fits" : "DOES NOT FIT")}\n");
        builder.Append(inv, $"Texture cache: {s.TextureCacheHits} hits / {s.TextureCacheMisses} reads\n\n");
        builder.Append(inv, $"Status: {result.Status}\n");
        return builder.ToString();
    }
}
