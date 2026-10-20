using ForeverDB.AtlasExporter.Enumeration;
using ForeverDB.AtlasExporter.Model;

namespace ForeverDB.AtlasExporter.Export;

public static class ManifestFactory
{
    public static VariantManifest Create(
        AtlasMap map, ArtPlan art, VariantResult variant, BuildIdentity identity,
        ExportOptions options, AtlasPlan plan, MapDatabase database)
    {
        var overview = variant.Images.FirstOrDefault(image => image.Role == "overview");
        var layer = art.Layers.OrderBy(l => l.LayerIndex).FirstOrDefault();
        var fileName = (ImageRecord image) => System.IO.Path.GetFileName(image.Path);
        var shared = variant.Status == ItemStatus.Alias && variant.SharedWithUiMapId is not null;

        ManifestImage ToImage(ImageRecord image) => new()
        {
            Role = image.Role,
            File = shared ? image.Path : fileName(image),
            Format = image.Format,
            Width = image.Width,
            Height = image.Height,
            Bytes = image.Bytes,
            Sha256 = image.Sha256,
            LayerIndex = image.LayerIndex,
            TilesPlaced = image.TilesPlaced,
            TilesExpected = image.TilesExpected,
            Complete = image.TilesPlaced == image.TilesExpected
        };

        var bounds = database.Assignments
            .Where(assignment => assignment.UiMapId == map.UiMapId)
            .OrderBy(assignment => assignment.OrderIndex)
            .Select(assignment => new AssignmentBounds
            {
                MapId = assignment.MapId,
                AreaId = assignment.AreaId,
                OrderIndex = assignment.OrderIndex,
                UiMin = assignment.UiMin,
                UiMax = assignment.UiMax,
                Region = assignment.Region
            })
            .ToList();

        return new VariantManifest
        {
            ZoneId = map.UiMapId,
            UiMapId = map.UiMapId,
            Slug = map.Slug,
            ZoneName = map.Name,
            Variant = variant.Variant,
            ArtVariantKind = variant.Kind,
            Category = map.Category,
            CategorySource = map.CategorySource,
            CategoryConfidence = map.ClassificationConfidence,
            Floor = map.FloorGroupId is { } group && map.FloorIndex is { } floorIndex
                ? new ManifestFloor { GroupId = group, FloorIndex = floorIndex }
                : null,
            InstanceKind = map.InstanceKind,
            TypeName = map.TypeName,
            ParentUiMapId = map.ParentUiMapId,
            Status = variant.Status,
            Image = overview is null ? null : ToImage(overview),
            Images = variant.Images.Select(ToImage).ToList(),
            ImageRef = shared
                ? new ImageReference
                {
                    UiMapId = variant.SharedWithUiMapId!.Value,
                    Variant = variant.Variant,
                    Path = overview?.Path ?? ""
                }
                : null,
            Extent = layer is null
                ? null
                : new ManifestExtent
                {
                    LayerIndex = layer.LayerIndex,
                    LayerWidth = layer.LayerWidth,
                    LayerHeight = layer.LayerHeight,
                    TileWidth = layer.TileWidth,
                    TileHeight = layer.TileHeight
                },
            Provenance = new ManifestProvenance
            {
                ExporterVersion = options.ExporterVersion,
                ClientProduct = identity.Product,
                ClientVersion = identity.Version,
                ClientBuildKey = identity.BuildKey,
                MetadataSource = identity.MetadataSource,
                MapArtId = art.UiMapArtId,
                PhaseId = art.PhaseId,
                PrimaryArt = variant.Primary,
                ArtVariant = variant.Variant,
                RevealStatus = variant.RevealStatus,
                OverlayTiles = variant.OverlayTiles,
                RevealCompleteness = variant.RevealCompleteness,
                RevealSkippedOverlays = variant.RevealSkippedOverlays.Count == 0 ? null : variant.RevealSkippedOverlays.ToList(),
                InternalMapId = map.InternalMapId,
                Encoder = options.Webp.ToString()
            },
            Calibration = new ManifestCalibration { WorldBounds = bounds },
            Problems = variant.Problems.ToList()
        };
    }
}
