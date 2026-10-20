using System.IO.Compression;
using System.Text.Json;
using ForeverDB.AtlasExporter.Enumeration;
using ForeverDB.AtlasExporter.Export;
using ForeverDB.AtlasExporter.Model;

namespace Atlas.Exporter.Tests;

/// <summary>
/// Developer check (not part of the unit suite): rebuilds a plan from a REAL delivered export's own
/// index and seeds a fresh output from it, proving the seeder reads that schema. Fingerprints cannot
/// match without the client's tile tables, which this check does not have.
/// </summary>
internal static class RealExportCheck
{
    public static int Run(string zipPath)
    {
        var temp = Path.Combine(Path.GetTempPath(), "fdb-real-check-" + Guid.NewGuid().ToString("N")[..8]);
        ZipFile.ExtractToDirectory(zipPath, temp);
        var root = Directory.GetDirectories(temp).Single();
        var index = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "atlas", "index.json"))).RootElement;
        var client = index.GetProperty("client");
        var db = new MapDatabase();

        foreach (var map in index.GetProperty("maps").EnumerateArray())
        {
            var id = map.GetProperty("uiMapId").GetInt32();
            var type = Array.IndexOf(new[] { "cosmic", "world", "continent", "zone", "dungeon", "micro", "orphan" },
                map.GetProperty("typeName").GetString());
            db.UiMaps.Add(new UiMapRow(id, map.GetProperty("name").GetString()!, map.GetProperty("parentUiMapId").GetInt32(),
                map.GetProperty("flags").GetInt32(), map.GetProperty("system").GetInt32(), type));

            // The manifest carries the UiMapAssignment rows (internal MapID, AreaID) the exporter read.
            var firstVariant = map.GetProperty("variants")[0];
            var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, firstVariant.GetProperty("manifest").GetString()!))).RootElement;

            foreach (var bounds in manifest.GetProperty("calibration").GetProperty("worldBounds").EnumerateArray())
            {
                db.Assignments.Add(new AssignmentRow(id, bounds.GetProperty("orderIndex").GetInt32(), bounds.GetProperty("mapId").GetInt32(),
                    bounds.GetProperty("areaId").GetInt32(), new double[2], new double[2], new double[6]));
            }

            foreach (var variant in map.GetProperty("variants").EnumerateArray().Where(v => v.GetProperty("kind").GetString() == "base"))
            {
                var art = variant.GetProperty("uiMapArtId").GetInt32();
                var image = variant.GetProperty("images")[0];
                db.ArtLinks.Add(new UiMapArtLinkRow(id, art, variant.GetProperty("phaseId").GetInt32()));
                db.ArtStyle[art] = art + 100000;
                db.StyleLayers.Add(new StyleLayerRow(art + 100000, 0, image.GetProperty("width").GetInt32(), image.GetProperty("height").GetInt32(), 256, 256));
                db.ArtTiles.Add(new ArtTileRow(art, 0, 0, 0, 1));
            }
        }

        var plan = MapEnumerator.Enumerate(db);
        var identity = new BuildIdentity(client.GetProperty("product").GetString()!, client.GetProperty("version").GetString()!,
            client.GetProperty("buildKey").GetString()!, "us", "check");
        var output = Path.Combine(temp, "out", "ForeverDB-Atlas-Export");
        var report = ExportSeeder.Seed(zipPath, output, plan, identity, new ExportOptions { OutputDirectory = output, Resume = true });
        Console.WriteLine($"refused={report.Refused} imported={report.Imported} skipped={report.Skipped}");

        foreach (var note in report.Notes.Take(5))
        {
            Console.WriteLine("  " + note);
        }

        var state = ExportState.Load(output);
        Console.WriteLine($"state items={state.Items.Count}; reveal items={state.Items.Keys.Count(k => k.EndsWith("full-reveal"))}; " +
                          $"sample={state.Items.First().Key} overlayTiles={state.Items.Values.Max(i => i.OverlayTiles)}");

        Console.WriteLine("classification of the real client's 60 UiMaps with the new rules (Map table unavailable, as in that run):");

        foreach (var group in plan.Maps.GroupBy(m => (m.Category, m.CategorySource, m.ClassificationConfidence)).OrderBy(g => g.Key.Category))
        {
            Console.WriteLine($"  {group.Key.Category,-10} {group.Key.CategorySource,-24} {group.Key.ClassificationConfidence,-9} {group.Count(),3}  " +
                              string.Join(", ", group.Where(m => group.Count() <= 6).Select(m => $"{m.UiMapId} {m.Name}")));
        }

        Console.WriteLine($"instance records: {plan.Instances.Records.Count} ({plan.Instances.Coverage})");

        foreach (var record in plan.Instances.Records)
        {
            Console.WriteLine($"  MapID {record.MapId} {record.Name}: {record.Classification} [{record.ClassificationSource}/{record.Confidence}] drawable={record.Drawable}");
        }

        Directory.Delete(temp, recursive: true);
        return report.Imported > 0 && !report.Refused ? 0 : 1;
    }
}
