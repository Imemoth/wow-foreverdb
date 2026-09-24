using System.Text.Json;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public static class MapMetadataStore
{
    private static readonly string DirectoryPath =
        Path.Combine(
            Environment.GetFolderPath(
                Environment.SpecialFolder.LocalApplicationData),
            "ForeverDB",
            "maps");

    private static readonly string ManifestPath =
        Path.Combine(
            DirectoryPath,
            "map-metadata.json");

    public static void Merge(
        IEnumerable<ForeverDbMap> maps)
    {
        var incoming = maps
            .Where(map => map.MapId != 0)
            .ToArray();

        if (incoming.Length == 0)
        {
            return;
        }

        Directory.CreateDirectory(DirectoryPath);

        var all = LoadAll()
            .ToDictionary(map => map.MapId);

        foreach (var map in incoming)
        {
            all[map.MapId] = map;
        }

        File.WriteAllText(
            ManifestPath,
            JsonSerializer.Serialize(
                all.Values
                    .OrderBy(map => map.MapId)
                    .ToArray(),
                new JsonSerializerOptions
                {
                    WriteIndented = true
                }));
    }

    public static IReadOnlyList<ForeverDbMap> LoadAll()
    {
        if (!File.Exists(ManifestPath))
        {
            return Array.Empty<ForeverDbMap>();
        }

        try
        {
            return JsonSerializer.Deserialize<List<ForeverDbMap>>(
                File.ReadAllText(ManifestPath))
                ?? Array.Empty<ForeverDbMap>();
        }
        catch
        {
            return Array.Empty<ForeverDbMap>();
        }
    }

    public static ForeverDbMap? Find(long mapId)
    {
        return LoadAll()
            .FirstOrDefault(map => map.MapId == mapId);
    }

    public static string GetMapCacheDirectory(long mapId)
    {
        var path = Path.Combine(
            DirectoryPath,
            mapId.ToString(
                System.Globalization.CultureInfo.InvariantCulture));

        Directory.CreateDirectory(path);
        return path;
    }
}
