using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using War3BlpFile = War3Net.Drawing.Blp.BlpFile;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public sealed class WowClientMapAssetProvider
{
    private const string ResolverVersion = "5";

    private readonly CompanionSettings _settings;

    public WowClientMapAssetProvider(
        CompanionSettings settings)
    {
        _settings = settings;
    }

    public async Task<MapAssetResult> LoadAsync(
        long mapId,
        CancellationToken cancellationToken = default)
    {
        var metadata = MapMetadataStore.Find(mapId);

        if (metadata is null)
        {
            return Unavailable(
                "Map metadata has not been captured by the addon yet.");
        }

        var layer = metadata.Layers
            .Where(
                candidate =>
                    candidate.LayerWidth > 0 &&
                    candidate.LayerHeight > 0 &&
                    candidate.TileWidth > 0 &&
                    candidate.TileHeight > 0 &&
                    candidate.TextureRefs.Count > 0)
            .OrderByDescending(
                candidate =>
                    (long)candidate.LayerWidth *
                    candidate.LayerHeight)
            .FirstOrDefault();

        if (layer is null)
        {
            return Unavailable(
                $"WoW client map metadata exists for {metadata.Name}, but it has no usable art layer.");
        }

        var wowBuildFingerprint =
            MapAssetCacheStore.GetWowBuildFingerprint(
                _settings.WowRoot);

        var resolutionKey =
            MapAssetCacheStore.BuildKey(
                metadata,
                layer,
                ResolverVersion,
                wowBuildFingerprint);

        var cachedResolution =
            MapAssetCacheStore.Get(
                resolutionKey);

        var cachePath = GetCachePath(
            metadata,
            layer);

        if (File.Exists(cachePath))
        {
            try
            {
                var cached = LoadBitmap(cachePath);

                MapAssetCacheStore.Put(
                    new MapAssetCacheEntry
                    {
                        Key = resolutionKey,
                        MapId = metadata.MapId,
                        MapArtId = metadata.MapArtId,
                        LayerIndex = layer.LayerIndex,
                        ResolverVersion = ResolverVersion,
                        WowBuildFingerprint = wowBuildFingerprint,
                        Success = true,
                        Status =
                            $"WoW client map · cached · art #{metadata.MapArtId}",
                        CacheFile = cachePath,
                        UpdatedAtUtc = DateTimeOffset.UtcNow
                    });

                return new MapAssetResult
                {
                    Image = cached,
                    Width = cached.PixelWidth,
                    Height = cached.PixelHeight,
                    FromCache = true,
                    Status =
                        $"WoW client map · cached · art #{metadata.MapArtId}"
                };
            }
            catch
            {
                try
                {
                    File.Delete(cachePath);
                }
                catch
                {
                }
            }
        }

        if (cachedResolution is not null &&
            !cachedResolution.Success)
        {
            return Unavailable(
                $"Cached map lookup · {cachedResolution.Status}");
        }

        var preferredStorageLabel =
            MapAssetCacheStore.GetPreferredStorageLabel(
                wowBuildFingerprint);

        var stopwatch =
            Stopwatch.StartNew();

        var raw =
            await Task.Run(
                () => ExtractRawMap(
                    metadata,
                    layer,
                    preferredStorageLabel,
                    cancellationToken),
                cancellationToken);

        stopwatch.Stop();

        var cascRoot =
            FindCascRoot(
                _settings.WowRoot);

        var productCandidates =
            cascRoot is null
                ? Array.Empty<string>()
                : GetProductCandidates(
                    cascRoot,
                    _settings.WowRoot)
                    .Take(16)
                    .ToArray();

        var diagnostic =
            new MapAssetDiagnosticEvent
            {
                ResolverVersion = ResolverVersion,
                MapId = metadata.MapId,
                MapName = metadata.Name,
                MapArtId = metadata.MapArtId,
                LayerIndex = layer.LayerIndex,
                WowBuildFingerprint = wowBuildFingerprint,
                Success = raw.Pixels is not null,
                FromCache = false,
                StorageLabel = raw.StorageLabel,
                AssetMode = raw.AssetMode,
                Stage =
                    raw.Pixels is null
                        ? "local-casc-resolve"
                        : "local-casc-render",
                DurationMs =
                    (int)Math.Min(
                        int.MaxValue,
                        stopwatch.ElapsedMilliseconds),
                Status = raw.Status,
                Details = new
                {
                    apiTextureRefs =
                        layer.TextureRefs
                            .Take(24)
                            .ToArray(),
                    textureRefCount =
                        layer.TextureRefs.Count,
                    classicPathCandidates =
                        GetClassicMapDirectoryCandidates(
                            metadata.Name),
                    productCandidates,
                    preferredStorageLabel =
                        preferredStorageLabel ?? "",
                    wowBranch =
                        Path.GetFileName(
                            _settings.WowRoot.TrimEnd(
                                Path.DirectorySeparatorChar,
                                Path.AltDirectorySeparatorChar)),
                    layerWidth =
                        layer.LayerWidth,
                    layerHeight =
                        layer.LayerHeight,
                    tileWidth =
                        layer.TileWidth,
                    tileHeight =
                        layer.TileHeight,
                    layerTextureCount =
                        layer.TextureRefs.Count
                }
            };

        _ = MapAssetDiagnosticUploader.TryUploadAsync(
            _settings,
            diagnostic);

        if (raw.Pixels is null)
        {
            MapAssetCacheStore.Put(
                new MapAssetCacheEntry
                {
                    Key = resolutionKey,
                    MapId = metadata.MapId,
                    MapArtId = metadata.MapArtId,
                    LayerIndex = layer.LayerIndex,
                    ResolverVersion = ResolverVersion,
                    WowBuildFingerprint = wowBuildFingerprint,
                    Success = false,
                    Status = raw.Status,
                    AssetMode = raw.AssetMode,
                    StorageLabel = raw.StorageLabel,
                    UpdatedAtUtc = DateTimeOffset.UtcNow
                });

            return Unavailable(
                raw.Status);
        }

        var bitmap =
            BitmapSource.Create(
                raw.Width,
                raw.Height,
                96,
                96,
                PixelFormats.Bgra32,
                null,
                raw.Pixels,
                raw.Width * 4);

        bitmap.Freeze();

        TrySaveCache(
            bitmap,
            cachePath);

        MapAssetCacheStore.Put(
            new MapAssetCacheEntry
            {
                Key = resolutionKey,
                MapId = metadata.MapId,
                MapArtId = metadata.MapArtId,
                LayerIndex = layer.LayerIndex,
                ResolverVersion = ResolverVersion,
                WowBuildFingerprint = wowBuildFingerprint,
                Success = true,
                Status = raw.Status,
                AssetMode = raw.AssetMode,
                StorageLabel = raw.StorageLabel,
                CacheFile = cachePath,
                UpdatedAtUtc = DateTimeOffset.UtcNow
            });

        return new MapAssetResult
        {
            Image = bitmap,
            Width = raw.Width,
            Height = raw.Height,
            FromCache = false,
            Status = raw.Status
        };
    }

    private RawMapAsset ExtractRawMap(
        ForeverDbMap metadata,
        ForeverDbMapLayer layer,
        string? preferredStorageLabel,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_settings.WowRoot))
        {
            return RawMapAsset.Failed(
                "WoW installation path is not configured.");
        }

        var cascRoot = FindCascRoot(_settings.WowRoot);

        if (cascRoot is null)
        {
            return RawMapAsset.Failed(
                "WoW .build.info was not found. Client map extraction cannot open CASC.");
        }

        NativeCascMapReader? storage = null;
        string? storageLabel = null;
        IReadOnlyList<string> effectiveTextureRefs =
            layer.TextureRefs;
        var assetMode = "FileDataID";

        try
        {
            (storage, storageLabel) =
                OpenStorageForReferences(
                    cascRoot,
                    _settings.WowRoot,
                    effectiveTextureRefs,
                    preferredStorageLabel);

            if (storage is null)
            {
                foreach (var classicCandidate in
                         GetClassicMapTextureCandidates(
                             metadata.Name))
                {
                    var selection =
                        OpenStorageForReferences(
                            cascRoot,
                            _settings.WowRoot,
                            classicCandidate.TextureRefs,
                            preferredStorageLabel);

                    if (selection.Storage is null)
                    {
                        continue;
                    }

                    storage = selection.Storage;
                    storageLabel = selection.Label;
                    effectiveTextureRefs =
                        classicCandidate.TextureRefs;
                    assetMode =
                        $"classic-path:{classicCandidate.Directory}";
                    break;
                }
            }

            if (storage is null)
            {
                var sampleRefs =
                    string.Join(
                        ", ",
                        layer.TextureRefs.Take(4));

                var classicDirs =
                    string.Join(
                        ", ",
                        GetClassicMapDirectoryCandidates(
                            metadata.Name)
                            .Take(6));

                return RawMapAsset.Failed(
                    $"No local WoW CASC product/root contains the map art. " +
                    $"API refs: {sampleRefs}. Classic path candidates: {classicDirs}");
            }

            cancellationToken.ThrowIfCancellationRequested();

            var targetWidth = layer.LayerWidth;
            var targetHeight = layer.LayerHeight;

            var targetPixels =
                new byte[
                    checked(
                        targetWidth *
                        targetHeight *
                        4)];

            var columns =
                (int)Math.Ceiling(
                    targetWidth /
                    (double)layer.TileWidth);

            var rows =
                (int)Math.Ceiling(
                    targetHeight /
                    (double)layer.TileHeight);

            var expectedTiles = columns * rows;
            var usableTiles = Math.Min(
                expectedTiles,
                effectiveTextureRefs.Count);

            var openedTiles = 0;
            var decodedTiles = 0;
            var decodeFailures = 0;
            string? firstDecodeError = null;

            for (var index = 0;
                 index < usableTiles;
                 index++)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var textureRef =
                    effectiveTextureRefs[index];

                using var stream =
                    OpenTexture(
                        storage,
                        textureRef);

                if (stream is null)
                {
                    continue;
                }

                openedTiles++;

                byte[] pixels;
                int tileWidth;
                int tileHeight;

                try
                {
                    using var blp =
                        new War3BlpFile(stream);

                    pixels =
                        blp.GetPixels(
                            0,
                            out tileWidth,
                            out tileHeight,
                            bgra: true);
                }
                catch (Exception ex)
                {
                    decodeFailures++;
                    firstDecodeError ??=
                        $"{ex.GetType().Name}: {ex.Message}";
                    continue;
                }

                if (pixels.Length == 0 ||
                    tileWidth <= 0 ||
                    tileHeight <= 0)
                {
                    continue;
                }

                var column = index % columns;
                var row = index / columns;

                var destinationX =
                    column * layer.TileWidth;

                var destinationY =
                    row * layer.TileHeight;

                if (destinationX >= targetWidth ||
                    destinationY >= targetHeight)
                {
                    continue;
                }

                var copyWidth = Math.Min(
                    tileWidth,
                    targetWidth - destinationX);

                var copyHeight = Math.Min(
                    tileHeight,
                    targetHeight - destinationY);

                if (copyWidth <= 0 ||
                    copyHeight <= 0)
                {
                    continue;
                }

                var sourceStride =
                    tileWidth * 4;

                var copyBytes =
                    copyWidth * 4;

                for (var y = 0;
                     y < copyHeight;
                     y++)
                {
                    Buffer.BlockCopy(
                        pixels,
                        y * sourceStride,
                        targetPixels,
                        ((destinationY + y) *
                         targetWidth +
                         destinationX) * 4,
                        copyBytes);
                }

                decodedTiles++;
            }

            if (decodedTiles == 0)
            {
                var detail =
                    openedTiles == 0
                        ? "No referenced map tile could be opened from CASC."
                        : $"{openedTiles} tile(s) opened, {decodeFailures} decode failure(s)." +
                          (string.IsNullOrWhiteSpace(firstDecodeError)
                              ? ""
                              : $" First error: {firstDecodeError}");

                return RawMapAsset.Failed(
                    $"WoW CASC opened ({storageLabel}), but no map tile was decoded. {detail}");
            }

            return new RawMapAsset
            {
                Pixels = targetPixels,
                Width = targetWidth,
                Height = targetHeight,
                StorageLabel = storageLabel ?? "",
                AssetMode = assetMode,
                Status =
                    $"WoW client map · {decodedTiles}/{expectedTiles} tiles · {storageLabel} · {assetMode}"
            };
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return RawMapAsset.Failed(
                $"WoW client map unavailable: {ex.Message}");
        }
        finally
        {
            try
            {
                storage?.Dispose();
            }
            catch
            {
            }
        }
    }

    private static void TrySaveCache(
        BitmapSource bitmap,
        string cachePath)
    {
        try
        {
            Directory.CreateDirectory(
                Path.GetDirectoryName(cachePath)!);

            var encoder =
                new PngBitmapEncoder();

            encoder.Frames.Add(
                BitmapFrame.Create(bitmap));

            using var file =
                File.Create(cachePath);

            encoder.Save(file);
        }
        catch
        {
            // Cache failure must not hide an otherwise usable map.
        }
    }

    private static Stream? OpenTexture(
        NativeCascMapReader storage,
        string textureRef)
    {
        if (string.IsNullOrWhiteSpace(textureRef))
        {
            return null;
        }

        try
        {
            if (int.TryParse(
                    textureRef,
                    NumberStyles.Integer,
                    CultureInfo.InvariantCulture,
                    out var fileDataId))
            {
                return storage.OpenByFileDataId(
                    fileDataId);
            }

            var normalized =
                textureRef
                    .Replace('/', '\\')
                    .TrimStart('\\');

            return storage.OpenByName(
                normalized);
        }
        catch
        {
            return null;
        }
    }

    private static (
        NativeCascMapReader? Storage,
        string? Label)
        OpenStorageForReferences(
            string cascRoot,
            string wowBranchPath,
            IReadOnlyList<string> textureRefs,
            string? preferredStorageLabel)
    {
        var candidates =
            GetStorageCandidates(
                cascRoot,
                wowBranchPath);

        if (!string.IsNullOrWhiteSpace(
                preferredStorageLabel))
        {
            candidates =
                candidates
                    .OrderBy(
                        candidate =>
                            string.Equals(
                                candidate.Label,
                                preferredStorageLabel,
                                StringComparison.OrdinalIgnoreCase)
                                ? 0
                                : 1)
                    .ThenBy(
                        candidate =>
                            candidate.Label)
                    .ToArray();
        }

        foreach (var candidate in candidates)
        {
            var reader =
                NativeCascMapReader.TryOpenSingle(
                    candidate.Path,
                    candidate.Label);

            if (reader is null)
            {
                continue;
            }

            if (CanOpenAnyTexture(
                    reader,
                    textureRefs))
            {
                return (
                    reader,
                    candidate.Label);
            }

            reader.Dispose();
        }

        return (null, null);
    }

    private static bool CanOpenAnyTexture(
        NativeCascMapReader storage,
        IReadOnlyList<string> textureRefs)
    {
        foreach (var textureRef in
                 textureRefs.Take(12))
        {
            using var stream =
                OpenTexture(
                    storage,
                    textureRef);

            if (stream is not null)
            {
                return true;
            }
        }

        return false;
    }

    private static IReadOnlyList<(
        string Path,
        string Label)>
        GetStorageCandidates(
            string cascRoot,
            string wowBranchPath)
    {
        var candidates =
            new List<(
                string Path,
                string Label)>();

        var products =
            GetProductCandidates(
                cascRoot,
                wowBranchPath);

        // Prefer actual installed product identifiers discovered from
        // .build.info/.flavor.info before generic fallbacks.
        // An explicit product selection must be tested before branch/auto,
        // because a multi-product WoW storage can open successfully while
        // exposing a different ROOT build.
        foreach (var product in products)
        {
            candidates.Add(
                (
                    $"{cascRoot}*{product}",
                    product
                ));
        }

        if (Directory.Exists(wowBranchPath))
        {
            candidates.Add(
                (
                    wowBranchPath,
                    Path.GetFileName(
                        wowBranchPath.TrimEnd(
                            Path.DirectorySeparatorChar,
                            Path.AltDirectorySeparatorChar))
                ));
        }

        candidates.Add(
            (
                cascRoot,
                "auto"
            ));

        return candidates
            .DistinctBy(
                candidate =>
                    candidate.Path,
                StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static IReadOnlyList<string>
        GetProductCandidates(
            string cascRoot,
            string wowBranchPath)
    {
        var folder =
            Path.GetFileName(
                wowBranchPath.TrimEnd(
                    Path.DirectorySeparatorChar,
                    Path.AltDirectorySeparatorChar));

        var candidates =
            new List<string>();

        candidates.AddRange(
            ReadFlavorProducts(
                wowBranchPath));

        candidates.AddRange(
            ReadBuildInfoProducts(
                cascRoot));

        if (string.Equals(
                folder,
                "_classic_beta_",
                StringComparison.OrdinalIgnoreCase))
        {
            candidates.Add(
                "wow_classic_beta");
        }

        if (!string.IsNullOrWhiteSpace(folder))
        {
            var branch =
                folder.Trim('_');

            if (!string.IsNullOrWhiteSpace(branch))
            {
                candidates.Add(
                    branch.StartsWith(
                        "wow",
                        StringComparison.OrdinalIgnoreCase)
                        ? branch
                        : $"wow_{branch}");
            }
        }

        candidates.Add("wow_classic_beta");
        candidates.Add("wow_classic");
        candidates.Add("wow_beta");
        candidates.Add("wowt");
        candidates.Add("wow");

        return candidates
            .Distinct(
                StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static IEnumerable<string>
        ReadBuildInfoProducts(string cascRoot)
    {
        var path =
            Path.Combine(
                cascRoot,
                ".build.info");

        if (!File.Exists(path))
        {
            yield break;
        }

        string[] lines;

        try
        {
            lines =
                File.ReadAllLines(path);
        }
        catch
        {
            yield break;
        }

        if (lines.Length < 2)
        {
            yield break;
        }

        var headers = lines[0]
            .Split('|')
            .Select(
                header =>
                    header.Split('!')[0].Trim())
            .ToArray();

        var productIndex =
            Array.FindIndex(
                headers,
                header =>
                    header.Equals(
                        "Product",
                        StringComparison.OrdinalIgnoreCase));

        var activeIndex =
            Array.FindIndex(
                headers,
                header =>
                    header.Equals(
                        "Active",
                        StringComparison.OrdinalIgnoreCase));

        if (productIndex < 0)
        {
            yield break;
        }

        foreach (var line in lines.Skip(1))
        {
            var fields =
                line.Split('|');

            if (productIndex >= fields.Length)
            {
                continue;
            }

            if (activeIndex >= 0 &&
                activeIndex < fields.Length &&
                fields[activeIndex].Trim() != "1")
            {
                continue;
            }

            var product =
                fields[productIndex].Trim();

            if (!string.IsNullOrWhiteSpace(product))
            {
                yield return product;
            }
        }
    }

    private static IEnumerable<string>
        ReadFlavorProducts(string wowBranchPath)
    {
        var path =
            Path.Combine(
                wowBranchPath,
                ".flavor.info");

        if (!File.Exists(path))
        {
            yield break;
        }

        string text;

        try
        {
            text =
                File.ReadAllText(path);
        }
        catch
        {
            yield break;
        }

        foreach (var token in
                 text.Split(
                     new[]
                     {
                         '|',
                         ':',
                         '=',
                         '\r',
                         '\n',
                         ' ',
                         '\t'
                     },
                     StringSplitOptions.RemoveEmptyEntries))
        {
            var value =
                token.Trim();

            if (value.StartsWith(
                    "wow",
                    StringComparison.OrdinalIgnoreCase))
            {
                yield return value;
            }
        }
    }

    private static IReadOnlyList<ClassicTextureCandidate>
        GetClassicMapTextureCandidates(
            string mapName)
    {
        return GetClassicMapDirectoryCandidates(
                mapName)
            .Select(
                directory =>
                    new ClassicTextureCandidate
                    {
                        Directory = directory,
                        TextureRefs =
                            Enumerable.Range(1, 12)
                                .Select(
                                    index =>
                                        $"Interface\\WorldMap\\{directory}\\{directory}{index}.blp")
                                .ToArray()
                    })
            .ToArray();
    }

    private static IReadOnlyList<string>
        GetClassicMapDirectoryCandidates(
            string mapName)
    {
        var aliases =
            new Dictionary<string, string[]>(
                StringComparer.OrdinalIgnoreCase)
            {
                ["Silverpine Forest"] = new[] { "Silverpine" },
                ["Tirisfal Glades"] = new[] { "Tirisfal" },
                ["Elwynn Forest"] = new[] { "Elwynn" },
                ["Redridge Mountains"] = new[] { "Redridge" },
                ["Duskwood"] = new[] { "Duskwood" },
                ["Westfall"] = new[] { "Westfall" },
                ["Dun Morogh"] = new[] { "DunMorogh" },
                ["Loch Modan"] = new[] { "LochModan" },
                ["Wetlands"] = new[] { "Wetlands" },
                ["Alterac Mountains"] = new[] { "Alterac" },
                ["Arathi Highlands"] = new[] { "Arathi" },
                ["Hillsbrad Foothills"] = new[] { "Hillsbrad" },
                ["Western Plaguelands"] = new[] { "WesternPlaguelands" },
                ["Eastern Plaguelands"] = new[] { "EasternPlaguelands" },
                ["The Hinterlands"] = new[] { "Hinterlands" },
                ["Stranglethorn Vale"] = new[] { "Stranglethorn" },
                ["Swamp of Sorrows"] = new[] { "SwampOfSorrows" },
                ["Deadwind Pass"] = new[] { "DeadwindPass" },
                ["Blasted Lands"] = new[] { "BlastedLands" },
                ["Searing Gorge"] = new[] { "SearingGorge" },
                ["Burning Steppes"] = new[] { "BurningSteppes" },
                ["The Barrens"] = new[] { "Barrens" },
                ["Stonetalon Mountains"] = new[] { "StonetalonMountains", "Stonetalon" },
                ["Ashenvale"] = new[] { "Ashenvale" },
                ["Darkshore"] = new[] { "Darkshore" },
                ["Teldrassil"] = new[] { "Teldrassil" },
                ["Mulgore"] = new[] { "Mulgore" },
                ["Durotar"] = new[] { "Durotar" },
                ["Thousand Needles"] = new[] { "ThousandNeedles" },
                ["Desolace"] = new[] { "Desolace" },
                ["Dustwallow Marsh"] = new[] { "Dustwallow" },
                ["Feralas"] = new[] { "Feralas" },
                ["Tanaris"] = new[] { "Tanaris" },
                ["Un'Goro Crater"] = new[] { "UngoroCrater", "UnGoroCrater" },
                ["Silithus"] = new[] { "Silithus" },
                ["Azshara"] = new[] { "Aszhara", "Azshara" },
                ["Winterspring"] = new[] { "Winterspring" },
                ["Moonglade"] = new[] { "Moonglade" }
            };

        var candidates =
            new List<string>();

        if (aliases.TryGetValue(
                mapName,
                out var known))
        {
            candidates.AddRange(known);
        }

        var compact =
            new string(
                mapName
                    .Where(char.IsLetterOrDigit)
                    .ToArray());

        if (!string.IsNullOrWhiteSpace(compact))
        {
            candidates.Add(compact);
        }

        var stripped =
            mapName;

        foreach (var suffix in
                 new[]
                 {
                     " Forest",
                     " Glades",
                     " Mountains",
                     " Highlands",
                     " Foothills"
                 })
        {
            if (stripped.EndsWith(
                    suffix,
                    StringComparison.OrdinalIgnoreCase))
            {
                stripped =
                    stripped[..^suffix.Length];
                break;
            }
        }

        stripped =
            stripped.StartsWith(
                "The ",
                StringComparison.OrdinalIgnoreCase)
                ? stripped[4..]
                : stripped;

        var compactStripped =
            new string(
                stripped
                    .Where(char.IsLetterOrDigit)
                    .ToArray());

        if (!string.IsNullOrWhiteSpace(
                compactStripped))
        {
            candidates.Add(
                compactStripped);
        }

        return candidates
            .Distinct(
                StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static string? FindCascRoot(
        string configuredWowRoot)
    {
        var current =
            new DirectoryInfo(
                configuredWowRoot);

        for (var i = 0;
             current is not null && i < 4;
             i++, current = current.Parent)
        {
            if (File.Exists(
                    Path.Combine(
                        current.FullName,
                        ".build.info")))
            {
                return current.FullName;
            }
        }

        return null;
    }

    private static string GetCachePath(
        ForeverDbMap map,
        ForeverDbMapLayer layer)
    {
        var folder =
            MapMetadataStore.GetMapCacheDirectory(
                map.MapId);

        return Path.Combine(
            folder,
            $"art-{map.MapArtId}-layer-{layer.LayerIndex}.png");
    }

    private static BitmapSource LoadBitmap(
        string path)
    {
        using var stream =
            File.OpenRead(path);

        var decoder =
            BitmapDecoder.Create(
                stream,
                BitmapCreateOptions.PreservePixelFormat,
                BitmapCacheOption.OnLoad);

        var bitmap = decoder.Frames[0];
        bitmap.Freeze();
        return bitmap;
    }

    private static MapAssetResult Unavailable(
        string status)
    {
        return new MapAssetResult
        {
            Status = status,
            Width = 1000,
            Height = 700
        };
    }

    private sealed class ClassicTextureCandidate
    {
        public string Directory { get; init; } = "";
        public IReadOnlyList<string> TextureRefs { get; init; } =
            Array.Empty<string>();
    }

    private sealed class RawMapAsset
    {
        public byte[]? Pixels { get; init; }
        public int Width { get; init; }
        public int Height { get; init; }
        public string StorageLabel { get; init; } = "";
        public string AssetMode { get; init; } = "";
        public string Status { get; init; } = "";

        public static RawMapAsset Failed(
            string status)
        {
            return new RawMapAsset
            {
                Status = status
            };
        }
    }
}
