using ForeverDB.AtlasExporter.Db2;

namespace Atlas.Exporter.Tests;

/// <summary>Developer check against the real WoWDBDefs corpus (not part of the unit suite).</summary>
internal static class DbdDirectoryCheck
{
    public static int Run(string directory)
    {
        var failures = 0;
        var files = Directory.EnumerateFiles(directory, "*.dbd").OrderBy(f => f, StringComparer.Ordinal).ToList();

        foreach (var file in files)
        {
            try
            {
                var dbd = DbdFile.Parse(Path.GetFileNameWithoutExtension(file), File.ReadAllText(file));

                if (dbd.Blocks.Count == 0)
                {
                    Console.WriteLine($"NOBLOCKS {Path.GetFileName(file)}");
                    failures++;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"FAIL {Path.GetFileName(file)}: {ex.Message}");
                failures++;
            }
        }

        Console.WriteLine($"{files.Count} definitions, {failures} problems");

        foreach (var (table, hash, fields) in new[]
        {
            ("UiMap", "DB51D55F", 15), ("UiMapArt", "3AE7D144", 4), ("UiMapArtStyleLayer", "3F597F5A", 10),
            ("UiMapArtTile", "2DA5B77B", 6), ("UiMapXMapArt", "EAE7DA2A", 4), ("UiMapAssignment", "C9CC8DFB", 12),
            ("Map", "D43AFAC3", 26), ("WorldMapOverlay", "9A196494", 13), ("WorldMapOverlayTile", "2C843422", 6)
        })
        {
            var dbd = DbdFile.Parse(table, File.ReadAllText(Path.Combine(directory, table + ".dbd")));
            var block = dbd.Select(hash, new Version(1, 60, 1, 70245));
            Console.WriteLine(block is null
                ? $"MISSING {table} {hash}"
                : $"{table} {hash}: {block.Fields.Count} fields (inline {block.Fields.Count(f => !f.NonInline)}) {(block.Fields.Count == fields ? "ok" : "UNEXPECTED, wanted " + fields)}");
        }

        return failures == 0 ? 0 : 1;
    }
}
