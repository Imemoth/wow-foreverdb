using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public sealed class MapAssetCacheEntry
{
    public string Key { get; set; } = "";
    public long MapId { get; set; }
    public long MapArtId { get; set; }
    public int LayerIndex { get; set; }
    public string ResolverVersion { get; set; } = "";
    public string WowBuildFingerprint { get; set; } = "";
    public bool Success { get; set; }
    public string Status { get; set; } = "";
    public string AssetMode { get; set; } = "";
    public string StorageLabel { get; set; } = "";
    public string CacheFile { get; set; } = "";
    public DateTimeOffset UpdatedAtUtc { get; set; }
}

public static class MapAssetCacheStore
{
    private static readonly object Gate = new();

    private static readonly string DirectoryPath =
        Path.Combine(
            Environment.GetFolderPath(
                Environment.SpecialFolder.LocalApplicationData),
            "ForeverDB",
            "maps");

    private static readonly string CacheIndexPath =
        Path.Combine(
            DirectoryPath,
            "map-asset-cache.json");

    public static string BuildKey(
        ForeverDbMap map,
        ForeverDbMapLayer layer,
        string resolverVersion,
        string wowBuildFingerprint)
    {
        var refs =
            string.Join(
                "|",
                layer.TextureRefs);

        var raw =
            $"{map.MapId}|{map.MapArtId}|{layer.LayerIndex}|" +
            $"{layer.LayerWidth}x{layer.LayerHeight}|" +
            $"{layer.TileWidth}x{layer.TileHeight}|" +
            $"{resolverVersion}|{wowBuildFingerprint}|{refs}";

        var hash =
            SHA256.HashData(
                Encoding.UTF8.GetBytes(raw));

        return Convert.ToHexString(hash);
    }

    public static MapAssetCacheEntry? Get(
        string key)
    {
        lock (Gate)
        {
            return LoadAll()
                .FirstOrDefault(
                    entry =>
                        string.Equals(
                            entry.Key,
                            key,
                            StringComparison.Ordinal));
        }
    }

    public static void Put(
        MapAssetCacheEntry entry)
    {
        lock (Gate)
        {
            Directory.CreateDirectory(
                DirectoryPath);

            var all =
                LoadAll()
                    .ToDictionary(
                        item => item.Key,
                        StringComparer.Ordinal);

            all[entry.Key] = entry;

            var pruned =
                all.Values
                    .OrderByDescending(
                        item => item.UpdatedAtUtc)
                    .Take(250)
                    .ToArray();

            File.WriteAllText(
                CacheIndexPath,
                JsonSerializer.Serialize(
                    pruned,
                    new JsonSerializerOptions
                    {
                        WriteIndented = true
                    }));
        }
    }

    public static string GetWowBuildFingerprint(
        string wowRoot)
    {
        var current =
            new DirectoryInfo(
                wowRoot);

        for (var i = 0;
             current is not null && i < 4;
             i++, current = current.Parent)
        {
            var buildInfo =
                Path.Combine(
                    current.FullName,
                    ".build.info");

            if (!File.Exists(buildInfo))
            {
                continue;
            }

            try
            {
                var info =
                    new FileInfo(buildInfo);

                return
                    $"{info.Length}:{info.LastWriteTimeUtc.Ticks}";
            }
            catch
            {
                return "build-info-present";
            }
        }

        return "unknown-build";
    }

    private static IReadOnlyList<MapAssetCacheEntry>
        LoadAll()
    {
        if (!File.Exists(CacheIndexPath))
        {
            return Array.Empty<MapAssetCacheEntry>();
        }

        try
        {
            return JsonSerializer.Deserialize<
                    List<MapAssetCacheEntry>>(
                    File.ReadAllText(
                        CacheIndexPath))
                ?? new List<MapAssetCacheEntry>();
        }
        catch
        {
            return Array.Empty<MapAssetCacheEntry>();
        }
    }
}
