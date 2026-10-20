namespace ForeverDB.AtlasExporter.Export;

// Per-variant manifest. Field names `zoneId`, `slug`, `zoneName`, `version`, `image`,
// `projection`, `provenance`, `calibration` follow the P2-D proof-of-concept manifest
// (web/public/maps/forever/1420/v1/manifest.json) so the CDN packaging step can map it 1:1.
public sealed class VariantManifest
{
    public int SchemaVersion { get; init; } = 1;
    public string Kind { get; init; } = "foreverdb-atlas-map-variant";
    public int ZoneId { get; init; }
    public int UiMapId { get; init; }
    public string Slug { get; init; } = "";
    public string ZoneName { get; init; } = "";
    public string Version { get; init; } = "v1";
    public string Variant { get; init; } = "";
    public string ArtVariantKind { get; init; } = "";
    public string Category { get; init; } = "";
    public string CategorySource { get; init; } = "";
    public string? CategoryConfidence { get; init; }
    public string? InstanceKind { get; init; }
    public ManifestFloor? Floor { get; init; }
    public string TypeName { get; init; } = "";
    public int ParentUiMapId { get; init; }
    public string Status { get; init; } = "";
    public ManifestImage? Image { get; init; }
    public List<ManifestImage> Images { get; init; } = new();
    public ImageReference? ImageRef { get; init; }
    public ManifestProjection Projection { get; init; } = new();
    public ManifestExtent? Extent { get; init; }
    public ManifestProvenance Provenance { get; init; } = new();
    public ManifestCalibration Calibration { get; init; } = new();
    public List<string> Problems { get; init; } = new();
}

public sealed class ManifestImage
{
    public string Role { get; init; } = "";
    public string File { get; init; } = "";
    public string Format { get; init; } = "webp";
    public int Width { get; init; }
    public int Height { get; init; }
    public long Bytes { get; init; }
    public string Sha256 { get; init; } = "";
    public int LayerIndex { get; init; }
    public int TilesPlaced { get; init; }
    public int TilesExpected { get; init; }
    public bool Complete { get; init; }
}

public sealed class ImageReference
{
    public int UiMapId { get; init; }
    public string Variant { get; init; } = "";
    public string Path { get; init; } = "";
    public string Reason { get; init; } = "identical UiMapArt shared between maps";
}

public sealed class ManifestProjection
{
    public string Type { get; init; } = "normalized-percent";
    public string Origin { get; init; } = "top-left";
    public string XDirection { get; init; } = "right";
    public string YDirection { get; init; } = "down";
    public int[] Range { get; init; } = { 0, 100 };
    public string PixelX { get; init; } = "imageWidth * xPercent / 100";
    public string PixelY { get; init; } = "imageHeight * yPercent / 100";
}

public sealed class ManifestExtent
{
    public int LayerIndex { get; init; }
    public int LayerWidth { get; init; }
    public int LayerHeight { get; init; }
    public int TileWidth { get; init; }
    public int TileHeight { get; init; }
    public string Cropping { get; init; } =
        "Tiles are placed by RowIndex/ColIndex; padded texture edges are cropped to the layer extent. The image is the full client canvas (no further crop or rescale).";
}

public sealed class ManifestProvenance
{
    public string Source { get; init; } = "ForeverDB.AtlasExporter";
    public string ExporterVersion { get; init; } = "";
    public string ClientProduct { get; init; } = "";
    public string ClientVersion { get; init; } = "";
    public string ClientBuildKey { get; init; } = "";
    public string MetadataSource { get; init; } = "";
    public int MapArtId { get; init; }
    public int PhaseId { get; init; }
    public bool PrimaryArt { get; init; }
    public string ArtVariant { get; init; } = "";
    public string? RevealStatus { get; init; }
    public int OverlayTiles { get; init; }
    public string? RevealCompleteness { get; init; }
    public List<string>? RevealSkippedOverlays { get; init; }

    /// <summary>Internal Map identity (UiMapAssignment). Distinct from uiMapId and mapArtId.</summary>
    public int? InternalMapId { get; init; }
    public string Encoder { get; init; } = "";
    public string LicenseStatus { get; init; } = "unreviewed";
    public string Note { get; init; } =
        "Extracted from the owner's locally installed WoW: Forever client for noncommercial development. Not for public redistribution until the owner records a decision.";
}

public sealed class ManifestCalibration
{
    public string Status { get; init; } = "provisional";
    public string Note { get; init; } =
        "Image extent is the client's own UiMapArtStyleLayer canvas. Registration of normalized-percent coordinates against known landmarks has not been verified; world bounds from UiMapAssignment are listed for later calibration.";
    public List<AssignmentBounds> WorldBounds { get; init; } = new();
}

public sealed class AssignmentBounds
{
    public int MapId { get; init; }
    public int AreaId { get; init; }
    public int OrderIndex { get; init; }
    public double[] UiMin { get; init; } = Array.Empty<double>();
    public double[] UiMax { get; init; } = Array.Empty<double>();
    public double[] Region { get; init; } = Array.Empty<double>();
}

public sealed class ManifestFloor
{
    public int GroupId { get; init; }
    public int FloorIndex { get; init; }
    public string Source { get; init; } = "UiMapGroupMember";
}
