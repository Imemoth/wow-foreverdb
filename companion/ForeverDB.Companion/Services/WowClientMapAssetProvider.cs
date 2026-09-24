using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using BLPSharp;
using CASCLib;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public sealed class WowClientMapAssetProvider
{
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

        var cachePath = GetCachePath(
            metadata,
            layer);

        if (File.Exists(cachePath))
        {
            try
            {
                var cached = LoadBitmap(cachePath);

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

        var raw =
            await Task.Run(
                () => ExtractRawMap(
                    metadata,
                    layer,
                    cancellationToken),
                cancellationToken);

        if (raw.Pixels is null)
        {
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

        CASCHandler? storage = null;
        string? product = null;

        try
        {
            (storage, product) =
                OpenLocalStorage(
                    cascRoot,
                    _settings.WowRoot);

            if (storage is null)
            {
                return RawMapAsset.Failed(
                    "WoW CASC storage could not be opened for this client.");
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
                layer.TextureRefs.Count);

            var decodedTiles = 0;

            for (var index = 0;
                 index < usableTiles;
                 index++)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var textureRef =
                    layer.TextureRefs[index];

                using var stream =
                    OpenTexture(
                        storage,
                        textureRef);

                if (stream is null)
                {
                    continue;
                }

                byte[] pixels;
                int tileWidth;
                int tileHeight;

                try
                {
                    using var blp =
                        new BLPFile(stream);

                    pixels =
                        blp.GetPixels(
                            0,
                            out tileWidth,
                            out tileHeight);
                }
                catch
                {
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
                return RawMapAsset.Failed(
                    $"WoW CASC opened ({product}), but none of the map tiles could be decoded.");
            }

            return new RawMapAsset
            {
                Pixels = targetPixels,
                Width = targetWidth,
                Height = targetHeight,
                Status =
                    $"WoW client map · {decodedTiles}/{expectedTiles} tiles · {product}"
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
                storage?
                    .GetType()
                    .GetMethod("Clear")
                    ?.Invoke(
                        storage,
                        null);
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
        CASCHandler storage,
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
                if (!storage.FileExists(fileDataId))
                {
                    return null;
                }

                return storage.OpenFile(fileDataId);
            }

            var normalized =
                textureRef
                    .Replace('/', '\\')
                    .TrimStart('\\');

            if (!storage.FileExists(normalized))
            {
                return null;
            }

            return storage.OpenFile(normalized);
        }
        catch
        {
            return null;
        }
    }

    private static (
        CASCHandler? Handler,
        string? Product)
        OpenLocalStorage(
            string cascRoot,
            string wowBranchPath)
    {
        SetCascOption(
            "ValidateData",
            true);

        SetCascOption(
            "ThrowOnFileNotFound",
            false);

        SetCascOption(
            "ThrowOnMissingDecryptionKey",
            false);

        SetCascOption(
            "UseOnlineFallbackForMissingFiles",
            false);

        SetCascEnumOption(
            "LoadFlags",
            "None");

        foreach (var product in
                 GetProductCandidates(wowBranchPath))
        {
            try
            {
                var handler =
                    CASCHandler.OpenLocalStorage(
                        cascRoot,
                        product);

                return (handler, product);
            }
            catch
            {
            }
        }

        return (null, null);
    }

    private static void SetCascOption(
        string propertyName,
        object value)
    {
        try
        {
            var property =
                typeof(CASCConfig)
                    .GetProperty(
                        propertyName,
                        System.Reflection.BindingFlags.Public |
                        System.Reflection.BindingFlags.Static);

            if (property?.CanWrite == true)
            {
                property.SetValue(
                    null,
                    value);
            }
        }
        catch
        {
        }
    }

    private static void SetCascEnumOption(
        string propertyName,
        string enumValue)
    {
        try
        {
            var property =
                typeof(CASCConfig)
                    .GetProperty(
                        propertyName,
                        System.Reflection.BindingFlags.Public |
                        System.Reflection.BindingFlags.Static);

            if (property?.CanWrite != true ||
                !property.PropertyType.IsEnum)
            {
                return;
            }

            var parsed =
                Enum.Parse(
                    property.PropertyType,
                    enumValue,
                    ignoreCase: true);

            property.SetValue(
                null,
                parsed);
        }
        catch
        {
        }
    }

    private static IReadOnlyList<string>
        GetProductCandidates(string wowBranchPath)
    {
        var folder =
            Path.GetFileName(
                wowBranchPath.TrimEnd(
                    Path.DirectorySeparatorChar,
                    Path.AltDirectorySeparatorChar));

        var candidates =
            new List<string>();

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

    private sealed class RawMapAsset
    {
        public byte[]? Pixels { get; init; }
        public int Width { get; init; }
        public int Height { get; init; }
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
