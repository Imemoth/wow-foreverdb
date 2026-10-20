using System.Text.Json;
using ForeverDB.AtlasExporter.Enumeration;
using ForeverDB.AtlasExporter.Export;
using ForeverDB.AtlasExporter.Metadata;
using ForeverDB.AtlasExporter.Model;

namespace Atlas.Exporter.Tests;

/// <summary>
/// Instance discovery and classification. First real client (1.60.1.70450): Map.db2 could not be read,
/// UiMap held 60 rows (no dungeon-type map) and the three battlegrounds were typed Orphan, so zero
/// instances were reported. These tests cover each path with synthetic data only.
/// </summary>
internal static class InstanceTests
{
    private static JsonElement Json(string path) => JsonDocument.Parse(File.ReadAllText(path)).RootElement;

    /// <summary>Outdoor continent + three battleground UiMaps with the MapIDs seen in the real client.</summary>
    private static World Realm(string root, bool mapTable)
    {
        var world = new World(root)
            .Map(1415, "Eastern Kingdoms", 2, 947).Art(101, (0, 600, 400)).Link(1415, 101).Assign(1415, 0)
            .Map(1459, "Alterac Valley", 6, 1424, flags: 2).Art(2186, (0, 1002, 668)).Link(1459, 2186).Assign(1459, 30, 2597)
            .Map(1460, "Warsong Gulch", 6, 1413).Art(2188, (0, 1002, 668)).Link(1460, 2188).Assign(1460, 489, 3277)
            .Map(1461, "Arathi Basin", 6, 1417).Art(2187, (0, 1002, 668)).Link(1461, 2187).Assign(1461, 529, 3358)
            .Map(2524, "Darkspear Islands", 6, 1414).Art(2034, (0, 512, 512)).Link(2524, 2034).Assign(2524, 2997, 16606);

        if (mapTable)
        {
            world.WorldMap(0, "Eastern Kingdoms", 0).WorldMap(30, "Alterac Valley", 3, directory: "AlteracValley")
                .WorldMap(489, "Warsong Gulch", 3).WorldMap(529, "Arathi Basin", 3)
                .WorldMap(33, "Shadowfang Keep", 1, parent: 0).WorldMap(409, "Molten Core", 2, parent: 0)
                .WorldMap(559, "Nagrand Arena", 4).WorldMap(2997, "Darkspear Islands", 0);
        }

        return world;
    }

    public static void Register()
    {
        Harness.Add("instances: Map rows become records with confirmed classification, with or without a UiMap", () =>
        {
            using var dir = new TempDir();
            var plan = Realm(dir.Path, mapTable: true).Plan();
            var byId = plan.Instances.Records.ToDictionary(r => r.MapId);
            Assert.Equal(InstanceKinds.Dungeon, byId[33].Classification);
            Assert.Equal(InstanceKinds.Raid, byId[409].Classification);
            Assert.Equal(InstanceKinds.Arena, byId[559].Classification);
            Assert.Equal(InstanceKinds.Battleground, byId[30].Classification);
            Assert.True(byId.Values.All(r => r.Confidence == "confirmed" && r.ClassificationSource == "map-instance-type"));
            Assert.False(byId.ContainsKey(0) || byId.ContainsKey(2997), "non-instance Map rows are not instance records");
            Assert.Equal(3, plan.Instances.Records.Count(r => r.UiMaps.Count == 0), "dungeon, raid and arena have no interior UiMap");
            Assert.Equal(6, plan.Instances.Records.Count);
            Assert.Equal(3, plan.Instances.Records.Count(r => r.Drawable), "the three battlegrounds have interior maps");
            Assert.Contains(byId[33].MissingArtworkReason!, "no UiMap");
            Assert.True(plan.Instances.Coverage.StartsWith("map-table"), plan.Instances.Coverage);
        });

        Harness.Add("instances: without the Map table the battlegrounds still classify from their verified MapIDs, labelled fallback", () =>
        {
            using var dir = new TempDir();
            var plan = Realm(dir.Path, mapTable: false).Plan();
            AtlasMap Of(int id) => plan.Maps.Single(m => m.UiMapId == id);

            foreach (var id in new[] { 1459, 1460, 1461 })
            {
                Assert.Equal(Categories.Instance, Of(id).Category, $"uiMap {id}");
                Assert.Equal("battleground", Of(id).InstanceKind);
                Assert.Equal("compat-mapid", Of(id).CategorySource);
                Assert.Equal("fallback", Of(id).ClassificationConfidence);
            }

            Assert.Equal(Categories.Other, Of(2524).Category, "an orphan whose MapID is unknown stays 'other'");
            Assert.Equal("map-table-unavailable", plan.Instances.Coverage);
            Assert.True(plan.Instances.Notes.Any(n => n.Contains("Map table")));
            Assert.Equal(3, plan.Instances.Records.Count);
        });

        Harness.Add("instances: with the Map table the same battlegrounds are confirmed, not fallback", () =>
        {
            using var dir = new TempDir();
            var plan = Realm(dir.Path, mapTable: true).Plan();
            var av = plan.Maps.Single(m => m.UiMapId == 1459);
            Assert.Equal("map-instance-type", av.CategorySource);
            Assert.Equal("confirmed", av.ClassificationConfidence);
            Assert.Equal(30, av.WorldMapId);
        });

        Harness.Add("instances: MapID, UiMapID and MapArtID stay distinct everywhere", async () =>
        {
            using var dir = new TempDir();
            var world = Realm(dir.Combine("w"), mapTable: true);
            var result = await Run.Export(world, dir.Combine("out"), o => o.Zip = false);
            var instance = Json(Path.Combine(result.OutputDirectory, "atlas/instances.json")).GetProperty("instances").EnumerateArray()
                .Single(i => i.GetProperty("mapId").GetInt32() == 30);
            var uiMap = instance.GetProperty("uiMaps")[0];
            Assert.Equal(1459, uiMap.GetProperty("uiMapId").GetInt32());
            Assert.Equal(30, instance.GetProperty("mapId").GetInt32());
            var manifest = Json(Path.Combine(result.OutputDirectory, "maps/1459/base/manifest.json"));
            Assert.Equal(1459, manifest.GetProperty("uiMapId").GetInt32());
            Assert.Equal(2186, manifest.GetProperty("provenance").GetProperty("mapArtId").GetInt32());
            Assert.Equal(30, manifest.GetProperty("provenance").GetProperty("internalMapId").GetInt32());
            var index = Json(Path.Combine(result.OutputDirectory, "atlas/index.json")).GetProperty("maps").EnumerateArray()
                .Single(m => m.GetProperty("uiMapId").GetInt32() == 1459);
            Assert.Equal(30, index.GetProperty("internalMapId").GetInt32());
            Assert.Equal("instance", index.GetProperty("category").GetString());
        });

        Harness.Add("instances: floors come only from UiMapGroupMember and keep their order and identifiers", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Path)
                .Map(1, "Test Keep - Upper", 4, 0).Art(11, (0, 512, 256)).Link(1, 11).Assign(1, 900)
                .Map(2, "Test Keep - Lower", 4, 0).Art(12, (0, 300, 200)).Link(2, 12).Assign(2, 900)
                .Map(3, "Test Keep - Crypt", 4, 0).Assign(3, 900)                 // floor with no artwork
                .WorldMap(900, "Test Keep", 1)
                .Member(70, 2, 0).Member(70, 1, 1).Member(70, 3, -1);
            var plan = world.Plan();
            var record = plan.Instances.Records.Single(r => r.MapId == 900);
            Assert.Equal(3, record.UiMaps.Count);
            var group = record.FloorGroups.Single();
            Assert.Equal(70, group.GroupId);
            Assert.Equal("3,2,1", string.Join(",", group.Members.Select(m => m.UiMapId)), "ordered by FloorIndex");
            Assert.Equal("-1,0,1", string.Join(",", group.Members.Select(m => m.FloorIndex)));
            Assert.Equal(2, record.DrawableUiMaps, "the crypt floor has no artwork");
            Assert.Equal(MapStatus.NoOwnArt, record.UiMaps.Single(m => m.UiMapId == 3).ArtStatus);
            Assert.Equal(1, plan.Maps.Single(m => m.UiMapId == 1).FloorIndex);
            Assert.Equal(70, plan.Maps.Single(m => m.UiMapId == 2).FloorGroupId);
            Assert.Contains(record.FloorNote, "verified");
        });

        Harness.Add("instances: several UiMaps without a floor group are listed with an explicit 'unverified' note", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Path)
                .Map(1, "A", 4, 0).Art(11, (0, 256, 256)).Link(1, 11).Assign(1, 901)
                .Map(2, "B", 4, 0).Art(12, (0, 256, 256)).Link(2, 12).Assign(2, 901)
                .WorldMap(901, "Two Floor Cave", 1);
            var record = world.Plan().Instances.Records.Single();
            Assert.Equal(0, record.FloorGroups.Count);
            Assert.Contains(record.FloorNote, "unverified");
            Assert.True(record.UiMaps.All(m => m.FloorIndex is null && m.FloorSource == "none"), "no order is invented");
        });

        Harness.Add("instances: entrance maps come from UiMapLink and the region from the parent Map, never inferred", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Path)
                .Map(947, "Azeroth", 1, 0).Art(1, (0, 256, 256)).Link(947, 1).Assign(947, 0)
                .Map(1415, "Eastern Kingdoms", 2, 947).Art(2, (0, 256, 256)).Link(1415, 2).Assign(1415, 0)
                .Map(1430, "Deadwind Pass", 3, 1415, flags: 2).Art(3, (0, 256, 256)).Link(1430, 3).Assign(1430, 0)
                .Map(1600, "Karazhan Foyer", 4, 0).Art(4, (0, 256, 256)).Link(1600, 4).Assign(1600, 532)
                .WorldMap(0, "Eastern Kingdoms", 0).WorldMap(532, "Karazhan", 2, parent: 0);
            world.Db.Links.Add(new UiMapLinkRow(1430, 1600, 0));
            var record = world.Plan().Instances.Records.Single(r => r.MapId == 532);
            Assert.Equal("1430", string.Join(",", record.EntranceUiMapIds));
            Assert.Equal(0, record.ParentMapId);
            Assert.True(record.RegionUiMapIds.Contains(1415), "continent UiMap of the parent MapID");
        });

        Harness.Add("instances: dungeon-finder rows name instances the Map table does not describe", () =>
        {
            using var dir = new TempDir();
            var world = Realm(dir.Path, mapTable: false);
            world.Db.LfgDungeons.Add(new LfgDungeonRow(5, "The Deadmines", 1, 36, 0));
            world.Db.LfgDungeons.Add(new LfgDungeonRow(6, "Random Dungeon", 1, 0, 0));   // MapID 0 is a continent: ignored
            var record = world.Plan().Instances.Records.Single(r => r.MapId == 36);
            Assert.Equal("The Deadmines", record.Name);
            Assert.Equal(InstanceKinds.Unknown, record.Classification, "type is not guessed from LFG");
            Assert.Equal("none", record.ClassificationSource);
            Assert.True(record.Evidence.Single().Contains("LFGDungeons#5"));
        });

        Harness.Add("instances: only the Map table's documented InstanceType (1-4) classifies; other values do not", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Path).Map(1, "X", 3, 0, flags: 2).Art(1, (0, 256, 256)).Link(1, 1).Assign(1, 77)
                .WorldMap(77, "Odd", 5);
            var plan = world.Plan();
            Assert.Equal(Categories.Zone, plan.Maps[0].Category);
            Assert.Equal(0, plan.Instances.Records.Count);
        });

        Harness.Add("category: cities come from client flags (and name list), not from the name alone", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Path)
                .Map(1414, "Kalimdor", 2, 0)
                .Map(1, "Orgrimmar", 3, 1414, flags: 0)           // flags + name
                .Map(2, "Newtown", 3, 1414, flags: 0)             // flags only: a settlement the list does not know
                .Map(3, "Ironforge", 3, 1414, flags: 2)           // name only: has overlays
                .Map(4, "Some Zone", 3, 1414, flags: 2)
                .Map(5, "Floating Map", 3, 0, flags: 0);          // no continent parent
            var plan = world.Plan();
            AtlasMap Of(int id) => plan.Maps.Single(m => m.UiMapId == id);
            Assert.Equal((Categories.City, "uimap-flags+name-list", "confirmed"), (Of(1).Category, Of(1).CategorySource, Of(1).ClassificationConfidence));
            Assert.Equal((Categories.City, "uimap-flags", "derived"), (Of(2).Category, Of(2).CategorySource, Of(2).ClassificationConfidence));
            Assert.Equal((Categories.City, "name-list", "fallback"), (Of(3).Category, Of(3).CategorySource, Of(3).ClassificationConfidence));
            Assert.Equal(Categories.Zone, Of(4).Category);
            Assert.Equal(Categories.Zone, Of(5).Category);
        });

        Harness.Add("category: labels are never evidence of artwork - an instance without art stays an instance with a reason", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Path).Map(1, "Hollow Hall", 4, 0).Assign(1, 910).WorldMap(910, "Hollow Hall", 1);
            var plan = world.Plan();
            Assert.Equal(Categories.Instance, plan.Maps[0].Category);
            Assert.Equal(MapStatus.NoOwnArt, plan.Maps[0].Status);
            Assert.False(plan.Instances.Records.Single().Drawable);
        });

        Harness.Add("instances: per-table fallback gives Map from a second source and records where each table came from", async () =>
        {
            using var dir = new TempDir();
            var world = Realm(dir.Combine("w"), mapTable: true);
            var csv = World.CsvFor(world);
            var primary = new DictionarySource("client-db2", csv.Where(p => p.Key != "Map").ToDictionary(p => p.Key, p => p.Value));
            var secondary = new DictionarySource("wago-csv:1.2.3.4", csv);
            var load = await MapDatabaseBuilder.LoadAsync(new IMapTableSource[] { primary, secondary }, default);
            var database = load.Database!;
            Assert.Equal("client-db2", database.MetadataSource);
            Assert.Equal("client-db2", database.TableSources["UiMap"]);
            Assert.Equal("wago-csv:1.2.3.4", database.TableSources["Map"]);
            Assert.False(database.MissingOptionalTables.ContainsKey("Map"));
            Assert.True(database.WorldMaps.ContainsKey(30));
        });

        Harness.Add("instances: a table no source can provide is reported with every reason", async () =>
        {
            using var dir = new TempDir();
            var csv = World.CsvFor(Realm(dir.Combine("w"), mapTable: true));
            var none = csv.Where(p => p.Key != "Map").ToDictionary(p => p.Key, p => p.Value);
            var load = await MapDatabaseBuilder.LoadAsync(new IMapTableSource[]
                { new DictionarySource("client-db2", none), new DictionarySource("wago", none) }, default);
            var reason = load.Database!.MissingOptionalTables["Map"];
            Assert.Contains(reason, "client-db2");
            Assert.Contains(reason, "wago");
        });

        Harness.Add("instances: exports atlas/instances.json, index/manifest additions and summary lines", async () =>
        {
            using var dir = new TempDir();
            var world = Realm(dir.Combine("w"), mapTable: true);
            var result = await Run.Export(world, dir.Combine("out"));
            var root = result.OutputDirectory;
            var instances = Json(Path.Combine(root, "atlas/instances.json"));
            var counts = instances.GetProperty("counts");
            Assert.Equal(6, counts.GetProperty("records").GetInt32());
            Assert.Equal(3, counts.GetProperty("drawable").GetInt32());
            Assert.Equal(1, counts.GetProperty("byClassification").GetProperty("dungeon").GetInt32());
            Assert.Equal(3, counts.GetProperty("byClassification").GetProperty("battleground").GetInt32());
            var hierarchy = Json(Path.Combine(root, "atlas/hierarchy.json"));
            Assert.Equal(6, hierarchy.GetProperty("instances").GetArrayLength());
            var summary = File.ReadAllText(Path.Combine(root, "diagnostics/export-summary.txt"));
            Assert.Contains(summary, "Instance records: 6 (dungeon 1, raid 1, battleground 3, arena 1");
            Assert.Contains(summary, "3 with a drawable interior map");
            Assert.True(ExportVerifier.Verify(root).IsValid, "additive files do not break verification");
            var build = Json(Path.Combine(root, "atlas/build.json"));
            Assert.True(build.TryGetProperty("tableSources", out _) && build.TryGetProperty("tableRowCounts", out _) &&
                        build.TryGetProperty("tableWarnings", out _), "provenance of every table is recorded");
        });

        Harness.Add("instances: interior floors export separately at native size; no outdoor projection is applied", async () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Combine("w"))
                .Map(1415, "Eastern Kingdoms", 2, 0).Art(101, (0, 1002, 668)).Link(1415, 101).Assign(1415, 0)
                .Map(1, "Keep - Upper", 4, 1415).Art(11, (0, 512, 256)).Link(1, 11).Assign(1, 900)
                .Map(2, "Keep - Lower", 4, 1415).Art(12, (0, 300, 200)).Link(2, 12).Assign(2, 900)
                .WorldMap(900, "Keep", 1).Member(70, 1, 1).Member(70, 2, 0);
            var result = await Run.Export(world, dir.Combine("out"));
            var up = Json(Path.Combine(result.OutputDirectory, "maps/1/base/manifest.json"));
            var low = Json(Path.Combine(result.OutputDirectory, "maps/2/base/manifest.json"));
            Assert.Equal(512, up.GetProperty("image").GetProperty("width").GetInt32());
            Assert.Equal(300, low.GetProperty("image").GetProperty("width").GetInt32());
            Assert.Equal(1, up.GetProperty("floor").GetProperty("floorIndex").GetInt32());
            Assert.Equal(0, low.GetProperty("floor").GetProperty("floorIndex").GetInt32());
            Assert.Equal("provisional", up.GetProperty("calibration").GetProperty("status").GetString());
            Assert.Equal(900, up.GetProperty("calibration").GetProperty("worldBounds")[0].GetProperty("mapId").GetInt32());
            Assert.False(up.TryGetProperty("parentProjection", out _), "no coordinate transform from the outdoor map");
            Assert.Equal("instance", up.GetProperty("category").GetString());
        });
    }

    private sealed class DictionarySource : IMapTableSource
    {
        private readonly Dictionary<string, string> _csv;
        public DictionarySource(string label, Dictionary<string, string> csv) { Label = label; _csv = csv; }
        public string Label { get; }

        public Task<TableReadResult> ReadAsync(string table, CancellationToken cancellationToken) =>
            Task.FromResult(_csv.TryGetValue(table, out var text)
                ? TableReadResult.Ok(CsvReader.Parse(table, text))
                : TableReadResult.Fail($"{table} not in {Label}"));
    }
}
