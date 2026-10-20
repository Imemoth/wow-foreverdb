using ForeverDB.AtlasExporter.Imaging;

namespace ForeverDB.AtlasExporter.Export;

public sealed record BuildIdentity(
    string Product,
    string Version,
    string BuildKey,
    string Region,
    string MetadataSource);

public sealed class ExportOptions
{
    public string OutputDirectory { get; init; } = "ForeverDB-Atlas-Export";
    public WebpSettings Webp { get; init; } = WebpSettings.Default;
    public bool Resume { get; init; }
    public bool Force { get; init; }
    public bool AllowPartial { get; init; }

    /// <summary>
    /// Compose a full-reveal from the overlays that are complete even when others declare artwork that
    /// cannot be assembled. The variant is labelled <c>partial-overlays</c>; never the default.
    /// </summary>
    public bool AllowPartialReveal { get; init; }
    public bool IncludeFullReveal { get; init; } = true;
    public bool AllLayers { get; init; }
    public bool DetailLayer { get; init; } = true;
    public IReadOnlySet<int>? OnlyMaps { get; init; }
    public int? MaxMaps { get; init; }
    public long TextureCacheBytes { get; init; } = 96L * 1024 * 1024;
    public int ThumbnailWidth { get; init; } = 320;
    public string? Reference1420Image { get; init; }
    /// <summary>Strings that must never appear in the delivered diagnostics (local paths, user names).</summary>
    public IReadOnlyList<string> Redactions { get; init; } = Array.Empty<string>();
    public bool CreateZip { get; init; } = true;
    public string ExporterVersion { get; init; } = "0.1.0";
    public IReadOnlyList<ForeverDB.AtlasExporter.Metadata.LoadAttempt> MetadataAttempts { get; init; } =
        Array.Empty<ForeverDB.AtlasExporter.Metadata.LoadAttempt>();
    public IReadOnlyList<string> ClientNotes { get; init; } = Array.Empty<string>();
    public string? StartedUtc { get; init; }
    public double? ElapsedSeconds { get; init; }
}

public sealed record ExportProgress(
    int Completed, int Total, string Current, int Exported, int Reused, int Failed);

public static class ItemStatus
{
    public const string Exported = "exported";
    public const string Reused = "reused";
    public const string Partial = "partial";
    public const string Failed = "failed";
    public const string Alias = "shared-art";
}

public sealed record ImageRecord(
    string Role,
    string Path,
    int Width,
    int Height,
    long Bytes,
    string Sha256,
    string Format,
    int LayerIndex,
    int TilesPlaced,
    int TilesExpected);

public sealed class VariantResult
{
    public int UiMapId { get; init; }
    public string Variant { get; init; } = "";
    public int UiMapArtId { get; init; }
    public int PhaseId { get; init; }
    public bool Primary { get; init; }
    public string Kind { get; init; } = "base"; // base | full-reveal
    public string Status { get; set; } = ItemStatus.Failed;
    public List<ImageRecord> Images { get; } = new();
    public List<string> Problems { get; } = new();
    public int? SharedWithUiMapId { get; set; }
    public string? RevealStatus { get; set; }
    public int OverlayTiles { get; set; }

    /// <summary>"complete", "tileless-declared-overlays-skipped" or "partial-overlays".</summary>
    public string? RevealCompleteness { get; set; }

    /// <summary>Overlay rows that contributed no artwork, each with its reason.</summary>
    public List<string> RevealSkippedOverlays { get; } = new();

    /// <summary>"metadata", "resolve", "decode" or "compose" when a reveal failed; otherwise null.</summary>
    public string? RevealFailureStage { get; set; }
    public string Fingerprint { get; set; } = "";
    public string? ManifestPath { get; set; }
}

public sealed class ExportResult
{
    public List<VariantResult> Variants { get; } = new();
    public bool Cancelled { get; set; }
    public string? ZipPath { get; set; }
    public string OutputDirectory { get; set; } = "";
    public string Status { get; set; } = "";
    public int ExitCode { get; set; }
    public ExportSummary Summary { get; set; } = new();
}

public sealed class ExportSummary
{
    public int MapsDiscovered { get; set; }
    public int DrawableMaps { get; set; }
    public int MapsExported { get; set; }
    public int MapsReused { get; set; }
    public int MapsSharedArt { get; set; }
    public int MapsFailed { get; set; }
    public int MapsPartial { get; set; }
    public int MapsInherited { get; set; }
    public int MapsMissingArtwork { get; set; }
    public int MapsSkippedByFilter { get; set; }
    public Dictionary<string, int> DiscoveredByCategory { get; } = new();
    public Dictionary<string, int> DrawableByCategory { get; } = new();
    public long ExportBytes { get; set; }
    public long ZipBytes { get; set; }
    public int CdnFileCount { get; set; }
    public long CdnMaxFileBytes { get; set; }
    public int TextureCacheHits { get; set; }
    public int TextureCacheMisses { get; set; }
}
