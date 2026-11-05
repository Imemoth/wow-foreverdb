using System.Security.Cryptography;
using ForeverDB.AtlasExporter.Client;
using ForeverDB.AtlasExporter.Enumeration;
using ForeverDB.AtlasExporter.Imaging;
using ForeverDB.AtlasExporter.Model;

namespace ForeverDB.AtlasExporter.Export;

public sealed class OutputNotEmptyException : Exception
{
    public OutputNotEmptyException(string message) : base(message) { }
}

/// <summary>
/// Sequential, memory-bounded export: one map canvas at a time, bounded texture LRU,
/// per-variant fault isolation, atomic writes and resumable state.
/// </summary>
public sealed class AtlasExportPipeline
{
    private static readonly string[] OwnedFolders = { "atlas", "maps", "diagnostics", "gallery", ".state" };

    private readonly AtlasPlan _plan;
    private readonly MapDatabase _database;
    private readonly BuildIdentity _identity;
    private readonly IAssetSource _assets;
    private readonly ExportOptions _options;
    private readonly Sanitizer _sanitizer;

    public AtlasExportPipeline(
        AtlasPlan plan, MapDatabase database, BuildIdentity identity,
        IAssetSource assets, ExportOptions options)
    {
        _plan = plan;
        _database = database;
        _identity = identity;
        _assets = assets;
        _options = options;
        _sanitizer = new Sanitizer(options.Redactions);
    }

    public string Root => Path.GetFullPath(_options.OutputDirectory);

    public async Task<ExportResult> RunAsync(IProgress<ExportProgress>? progress, CancellationToken cancellationToken)
    {
        PrepareOutput();

        var result = new ExportResult { OutputDirectory = Root };
        var signature = ExportState.ComputeSignature(_identity, _options);
        var state = ExportState.Load(Root);

        if (state.Signature != signature)
        {
            state = new ExportState { Signature = signature };
        }

        var textures = new TextureCache(_assets, _options.TextureCacheBytes);
        var maps = SelectMaps();
        var drawable = maps.Where(map => map.Status == MapStatus.Drawable).ToList();
        var owners = ComputeArtOwners(drawable);
        var total = drawable.Sum(map => map.Arts.Count(art => art.IsDrawable));
        var completed = 0;
        var exported = 0;
        var reused = 0;
        var failed = 0;
        var savedAt = 0;

        try
        {
            foreach (var map in drawable)
            {
                foreach (var art in map.Arts.Where(art => art.IsDrawable))
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    var primary = ReferenceEquals(art, map.PrimaryArt);
                    var prefix = primary ? "" : $"art{art.UiMapArtId}-";
                    var kinds = new List<string> { "base" };

                    if (_options.IncludeFullReveal && art.Overlays.Count > 0)
                    {
                        kinds.Add("full-reveal");
                    }

                    BgraImage? baseCanvas = null;

                    foreach (var kind in kinds)
                    {
                        var variantId = prefix + kind;
                        var variant = new VariantResult
                        {
                            UiMapId = map.UiMapId,
                            Variant = variantId,
                            UiMapArtId = art.UiMapArtId,
                            PhaseId = art.PhaseId,
                            Primary = primary,
                            Kind = kind
                        };
                        result.Variants.Add(variant);
                        progress?.Report(new ExportProgress(
                            completed, total, $"{map.UiMapId} {map.Name} [{variantId}]", exported, reused, failed));

                        var owner = owners[art.UiMapArtId];

                        if (owner != map.UiMapId)
                        {
                            variant.Status = ItemStatus.Alias;
                            variant.SharedWithUiMapId = owner;
                            continue;
                        }

                        var key = $"{map.UiMapId}/{variantId}";
                        variant.Fingerprint = ExportState.Fingerprint(art, kind == "full-reveal");

                        if (TryReuse(state, key, variant))
                        {
                            reused++;
                            baseCanvas = null;
                            WriteManifest(map, art, variant);
                            continue;
                        }

                        try
                        {
                            if (kind == "base")
                            {
                                baseCanvas = ExportBase(map, art, variant, textures, cancellationToken);
                            }
                            else
                            {
                                ExportReveal(map, art, variant, baseCanvas, textures, cancellationToken);
                            }
                        }
                        catch (OperationCanceledException)
                        {
                            throw;
                        }
                        catch (Exception ex) when (ex is not OutOfMemoryException)
                        {
                            variant.Status = ItemStatus.Failed;
                            variant.Problems.Add(
                                _sanitizer.Clean($"{ex.GetType().Name}: {ex.Message}"));
                        }

                        if (variant.Status is ItemStatus.Exported or ItemStatus.Partial)
                        {
                            exported++;
                        }
                        else
                        {
                            failed++;
                        }

                        WriteManifest(map, art, variant);
                        state.Items[key] = ToStateItem(variant);

                        if (++savedAt % 25 == 0)
                        {
                            state.Save(Root);
                        }
                    }

                    baseCanvas = null;
                    completed++;
                    progress?.Report(new ExportProgress(completed, total, "", exported, reused, failed));
                }
            }
        }
        catch (OperationCanceledException)
        {
            result.Cancelled = true;
        }
        finally
        {
            state.Save(Root);
        }

        ResolveAliases(result, maps);

        result.Summary.TextureCacheHits = textures.Hits;
        result.Summary.TextureCacheMisses = textures.Misses;
        new AtlasReportWriter(_plan, _database, _identity, _options, _sanitizer, _assets)
            .WriteAll(result, maps, thumbnails: !result.Cancelled);

        if (!result.Cancelled && _options.CreateZip)
        {
            // The summary quotes the ZIP size and is itself inside the ZIP. It is stored
            // uncompressed with a fixed-width size, so one refresh reaches a fixed point.
            var writer = new AtlasReportWriter(_plan, _database, _identity, _options, _sanitizer, _assets);

            for (var attempt = 0; attempt < 4; attempt++)
            {
                result.ZipPath = ZipPackager.Create(Root, _identity, result);
                var size = new FileInfo(result.ZipPath).Length;

                if (size == result.Summary.ZipBytes)
                {
                    break;
                }

                result.Summary.ZipBytes = size;
                writer.WriteSummaryOnly(result);
            }
        }

        await Task.CompletedTask;
        return result;
    }

    private void PrepareOutput()
    {
        var root = Root;
        var existing = OwnedFolders.Any(folder => Directory.Exists(Path.Combine(root, folder)));

        if (existing && _options.Force)
        {
            foreach (var folder in OwnedFolders)
            {
                var path = Path.Combine(root, folder);

                if (Directory.Exists(path))
                {
                    Directory.Delete(path, recursive: true);
                }
            }
        }
        else if (existing && !_options.Resume)
        {
            throw new OutputNotEmptyException(
                "The output folder already holds an export. Use --resume to continue/refresh it " +
                "or --force to start over.");
        }

        Directory.CreateDirectory(root);
    }

    private List<AtlasMap> SelectMaps()
    {
        IEnumerable<AtlasMap> maps = _plan.Maps;

        if (_options.OnlyMaps is { Count: > 0 })
        {
            maps = maps.Where(map => _options.OnlyMaps.Contains(map.UiMapId));
        }

        if (_options.MaxMaps is { } max)
        {
            var kept = new HashSet<int>(maps.Where(map => map.Status == MapStatus.Drawable)
                .Take(max).Select(map => map.UiMapId));
            maps = maps.Where(map => map.Status != MapStatus.Drawable || kept.Contains(map.UiMapId));
        }

        return maps.OrderBy(map => map.UiMapId).ToList();
    }

    private static Dictionary<int, int> ComputeArtOwners(IEnumerable<AtlasMap> drawable)
    {
        var owners = new Dictionary<int, int>();

        foreach (var map in drawable.OrderBy(map => map.UiMapId))
        {
            foreach (var art in map.Arts.Where(art => art.IsDrawable))
            {
                owners.TryAdd(art.UiMapArtId, map.UiMapId);
            }
        }

        return owners;
    }

    private bool TryReuse(ExportState state, string key, VariantResult variant)
    {
        if (!_options.Resume || !state.Items.TryGetValue(key, out var item) ||
            item.Fingerprint != variant.Fingerprint ||
            item.Status is not (ItemStatus.Exported or ItemStatus.Partial) ||
            (item.Status == ItemStatus.Partial && !_options.AllowPartial))
        {
            return false;
        }

        foreach (var image in item.Images)
        {
            var path = Path.Combine(Root, image.Path.Replace('/', Path.DirectorySeparatorChar));

            if (!File.Exists(path) || new FileInfo(path).Length != image.Bytes ||
                HashFile(path) != image.Sha256)
            {
                return false;
            }
        }

        if (item.Images.Count == 0)
        {
            return false;
        }

        variant.Status = ItemStatus.Reused;
        variant.Images.AddRange(item.Images);
        variant.RevealStatus = item.RevealStatus;
        variant.OverlayTiles = item.OverlayTiles;
        variant.Problems.AddRange(item.Problems);
        return true;
    }

    private static StateItem ToStateItem(VariantResult variant) => new()
    {
        Status = variant.Status,
        Fingerprint = variant.Fingerprint,
        Sha256 = variant.Images.FirstOrDefault()?.Sha256 ?? "",
        Images = variant.Images.ToList(),
        RevealStatus = variant.RevealStatus,
        OverlayTiles = variant.OverlayTiles,
        Problems = variant.Problems.ToList()
    };

    private static string HashFile(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private IEnumerable<(string Role, ArtLayerPlan Layer)> SelectLayers(ArtPlan art)
    {
        var ordered = art.Layers.OrderBy(layer => layer.LayerIndex).ToList();
        var overview = ordered[0];
        yield return ("overview", overview);

        if (_options.AllLayers)
        {
            foreach (var layer in ordered.Skip(1))
            {
                yield return ($"layer-{layer.LayerIndex}", layer);
            }
        }
        else if (_options.DetailLayer)
        {
            var largest = ordered.OrderByDescending(layer => (long)layer.LayerWidth * layer.LayerHeight).First();

            if ((long)largest.LayerWidth * largest.LayerHeight > (long)overview.LayerWidth * overview.LayerHeight)
            {
                yield return ("detail", largest);
            }
        }
    }

    private BgraImage? ExportBase(
        AtlasMap map, ArtPlan art, VariantResult variant, TextureCache textures, CancellationToken token)
    {
        BgraImage? overviewCanvas = null;

        foreach (var (role, layer) in SelectLayers(art))
        {
            var composition = TileCompositor.Compose(layer, textures, token);
            var problems = composition.Problems.Select(_sanitizer.Clean).ToList();
            var isOverview = role == "overview";

            if (composition.Image is null || composition.TilesPlaced == 0 ||
                (!composition.IsComplete && !_options.AllowPartial))
            {
                variant.Problems.AddRange(problems.Select(problem => $"{role}: {problem}"));

                if (isOverview)
                {
                    variant.Status = ItemStatus.Failed;
                    variant.Problems.Add(
                        $"overview incomplete ({composition.TilesPlaced}/{composition.TilesExpected} tiles); " +
                        "nothing was written. Use --allow-partial to keep incomplete maps.");
                    return null;
                }

                variant.Status = ItemStatus.Partial;
                continue;
            }

            var record = WriteImage(map.UiMapId, variant.Variant, role, composition.Image, layer, composition);

            if (record is null)
            {
                variant.Problems.Add($"{role}: image failed read-back verification");

                if (isOverview)
                {
                    variant.Status = ItemStatus.Failed;
                    return null;
                }

                variant.Status = ItemStatus.Partial;
                continue;
            }

            variant.Images.Add(record);
            variant.Problems.AddRange(problems.Select(problem => $"{role}: {problem}"));

            if (isOverview)
            {
                overviewCanvas = composition.Image;
            }
        }

        if (variant.Status != ItemStatus.Partial)
        {
            variant.Status = variant.Problems.Count > 0 ? ItemStatus.Partial : ItemStatus.Exported;
        }

        return overviewCanvas;
    }

    private void ExportReveal(
        AtlasMap map, ArtPlan art, VariantResult variant, BgraImage? baseCanvas,
        TextureCache textures, CancellationToken token)
    {
        var overviewLayer = art.Layers.OrderBy(layer => layer.LayerIndex).First();

        if (baseCanvas is null)
        {
            var composition = TileCompositor.Compose(overviewLayer, textures, token);

            if (composition.Image is null || (!composition.IsComplete && !_options.AllowPartial))
            {
                variant.Status = ItemStatus.Failed;
                variant.Problems.Add("full-reveal needs a complete base map, which is unavailable.");
                return;
            }

            baseCanvas = composition.Image;
        }

        var regions = TileCompositor.ToRegions(art.Overlays, out var problem);

        if (regions is null)
        {
            variant.Status = ItemStatus.Failed;
            variant.Problems.Add($"full-reveal overlay metadata unusable: {problem}");
            return;
        }

        var (image, tiles, failure) = TileCompositor.ApplyOverlays(baseCanvas, regions, textures, token);

        if (image is null)
        {
            variant.Status = ItemStatus.Failed;
            variant.Problems.Add(_sanitizer.Clean($"full-reveal unavailable: {failure}"));
            return;
        }

        var matches = TileCompositor.MatchesEmbeddedAtlas(art.UiMapArtId, regions);
        variant.RevealStatus = matches switch
        {
            true => "client-metadata-matches-reviewed-atlas",
            false => "client-metadata-differs-from-reviewed-atlas",
            null => "client-metadata-only"
        };
        variant.OverlayTiles = tiles;

        var composition2 = new CompositionResult(image, overviewLayer.ExpectedTiles, overviewLayer.ExpectedTiles,
            Array.Empty<string>());
        var record = WriteImage(map.UiMapId, variant.Variant, "overview", image, overviewLayer, composition2);

        if (record is null)
        {
            variant.Status = ItemStatus.Failed;
            variant.Problems.Add("full-reveal image failed read-back verification");
            return;
        }

        variant.Images.Add(record);
        variant.Status = ItemStatus.Exported;
    }

    private ImageRecord? WriteImage(
        int uiMapId, string variantId, string role, BgraImage image, ArtLayerPlan layer, CompositionResult composition)
    {
        var bytes = WebpCodec.Encode(image, _options.Webp);
        var decoded = WebpCodec.TryDecode(bytes);

        if (decoded is null || decoded.Width != image.Width || decoded.Height != image.Height)
        {
            return null;
        }

        var (meanError, alphaError) = WebpCodec.Compare(image, decoded);
        var limit = _options.Webp.Lossless ? 1.0 : 12.0;

        if (meanError > limit || (_options.Webp.Lossless && alphaError > 1))
        {
            return null;
        }

        var relative = $"maps/{uiMapId}/{variantId}/{role}.webp";
        var full = Path.Combine(Root, relative.Replace('/', Path.DirectorySeparatorChar));
        JsonOut.WriteAtomic(full, bytes);

        return new ImageRecord(
            role, relative, image.Width, image.Height, bytes.LongLength,
            Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), "webp",
            layer.LayerIndex, composition.TilesPlaced, composition.TilesExpected);
    }

    private void WriteManifest(AtlasMap map, ArtPlan art, VariantResult variant)
    {
        var manifest = ManifestFactory.Create(map, art, variant, _identity, _options, _plan, _database);
        var relative = $"maps/{map.UiMapId}/{variant.Variant}/manifest.json";
        variant.ManifestPath = relative;
        JsonOut.WriteAtomic(
            Path.Combine(Root, relative.Replace('/', Path.DirectorySeparatorChar)),
            JsonOut.Serialize(manifest));
    }

    private void ResolveAliases(ExportResult result, List<AtlasMap> maps)
    {
        var byKey = result.Variants.Where(v => v.Status != ItemStatus.Alias)
            .ToDictionary(v => (v.UiMapId, v.Variant, v.UiMapArtId));
        var ownerVariants = result.Variants.Where(v => v.Status != ItemStatus.Alias)
            .GroupBy(v => (v.UiMapArtId, v.Kind)).ToDictionary(g => g.Key, g => g.First());

        foreach (var alias in result.Variants.Where(v => v.Status == ItemStatus.Alias))
        {
            if (!ownerVariants.TryGetValue((alias.UiMapArtId, alias.Kind), out var owner))
            {
                alias.Status = ItemStatus.Failed;
                alias.Problems.Add("owner variant missing");
                continue;
            }

            alias.SharedWithUiMapId = owner.UiMapId;
            alias.Images.AddRange(owner.Images);
            alias.RevealStatus = owner.RevealStatus;
            alias.OverlayTiles = owner.OverlayTiles;

            if (owner.Status is ItemStatus.Failed or ItemStatus.Partial)
            {
                alias.Status = owner.Status;
                alias.Problems.Add($"shared art owned by map {owner.UiMapId} did not export completely");
            }

            var map = maps.First(m => m.UiMapId == alias.UiMapId);
            var art = map.Arts.First(a => a.UiMapArtId == alias.UiMapArtId);
            WriteManifest(map, art, alias);
        }

        _ = byKey;
    }
}
