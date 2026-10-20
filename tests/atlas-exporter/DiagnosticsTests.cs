using System.Text.Json;
using ForeverDB.AtlasExporter.Client;
using ForeverDB.AtlasExporter.Db2;
using ForeverDB.AtlasExporter.Diagnostics;
using ForeverDB.AtlasExporter.Export;

namespace Atlas.Exporter.Tests;

internal static class DiagnosticsTests
{
    private static Sanitizer Clean(params string[] secrets) => new(secrets);

    private sealed class FakeProbe : IAssetProbe
    {
        public AssetProbeResult ProbeFileDataId(int id) => new(false, 0, 6002, "ENCRYPTED: the file needs a TACT key that CascLib does not have", "local");
        public AssetProbeResult ProbeName(string path) => new(false, 0, 2, "file not found in this storage", "local");
    }

    private sealed class FixedDbd : IDbdSource
    {
        private readonly string _text;
        public FixedDbd(string text) => _text = text;
        public string Label => "fixed";
        public Task<string?> GetAsync(string table, CancellationToken cancellationToken) => Task.FromResult<string?>(_text);
    }

    public static void Register()
    {
        Harness.Add("diagnose-tables: reports location, storage error, header facts and why a table cannot be read", async () =>
        {
            using var dir = new TempDir();
            var assets = Path.Combine(dir.Path, "assets", "DBFilesClient");
            Directory.CreateDirectory(assets);
            // UiMap is readable; UiMapLink is junk (header failure); everything else is absent.
            var good = new Wdc5Writer
            {
                TableHash = KnownTables.TableHashes["UiMap"], RecordSizeBytes = 4,
                Records = new List<byte[]> { BitConverter.GetBytes(77u) },
                Columns = new List<Wdc5Writer.Column> { new(Wdc5Writer.Storage.None, 32, 0) }
            }.Build();
            File.WriteAllBytes(Path.Combine(assets, "UiMap.db2"), good);
            File.WriteAllBytes(Path.Combine(assets, "UiMapLink.db2"), Enumerable.Repeat((byte)7, 300).Append((byte)0).ToArray()
                .Select((b, i) => i < 4 ? (byte)"WDC5"[i] : b).ToArray());

            var input = new TableDiagnosticsInput(
                new DirectoryAssetSource(Path.Combine(dir.Path, "assets")), new FakeProbe(),
                new FixedDbd("COLUMNS\nint ID\n\nLAYOUT DB51D55F\n$id$ID<32>\n\n"), new Version(1, 60, 1, 70450),
                "1.60.1.70450", dir.Combine("cache"), AllowNetwork: false);
            var doc = await TableDiagnostics.RunAsync(input, Clean(dir.Path), default);
            var text = doc.ToText();

            Assert.Contains(text, "UiMap");
            Assert.Contains(text, "found by name");
            Assert.Contains(text, "decoded 1 row(s)");
            Assert.Contains(text, "NOT FOUND in storage");
            Assert.Contains(text, "ENCRYPTED");                       // the probe's explanation for absent tables
            Assert.Contains(text, "error 6002");
            Assert.Contains(text, "header parse FAILED");             // UiMapLink
            Assert.Contains(text, "prefix 4:");

            var json = JsonDocument.Parse(doc.ToJson()).RootElement.GetProperty("data").GetProperty("tables");
            var uiMap = json.EnumerateArray().Single(t => t.GetProperty("table").GetString() == "UiMap");
            Assert.Equal("by-name", uiMap.GetProperty("located").GetString());
            Assert.True(uiMap.GetProperty("tableHashMatches").GetBoolean());
            Assert.Equal(1, uiMap.GetProperty("rowsRead").GetInt32());
            var link = json.EnumerateArray().Single(t => t.GetProperty("table").GetString() == "UiMapLink");
            Assert.True(link.TryGetProperty("parseError", out _) && link.TryGetProperty("headerCandidates", out _));
            var map = json.EnumerateArray().Single(t => t.GetProperty("table").GetString() == "Map");
            Assert.Equal("no", map.GetProperty("located").GetString());
            Assert.DoesNotContain(text + doc.ToJson(), dir.Path);
        });

        Harness.Add("diagnose-tables: encrypted DB2 sections and unknown layouts are surfaced", async () =>
        {
            using var dir = new TempDir();
            var assets = Path.Combine(dir.Path, "a", "DBFilesClient");
            Directory.CreateDirectory(assets);
            File.WriteAllBytes(Path.Combine(assets, "Map.db2"), new Wdc5Writer
            {
                TableHash = KnownTables.TableHashes["Map"], LayoutHash = 0x12345678, TactKeyHash = 0xAABBCCDDEEFF0011,
                RecordSizeBytes = 4, Records = new List<byte[]> { new byte[4] },
                Columns = new List<Wdc5Writer.Column> { new(Wdc5Writer.Storage.None, 32, 0) }
            }.Build());
            var input = new TableDiagnosticsInput(new DirectoryAssetSource(Path.Combine(dir.Path, "a")), null,
                new FixedDbd("COLUMNS\nint ID\n\nLAYOUT DB51D55F\n$id$ID<32>\n\n"), null, "1.0.0.1", dir.Combine("c"), false);
            var text = (await TableDiagnostics.RunAsync(input, Clean(), default)).ToText();
            Assert.Contains(text, "ENCRYPTED section (TACT key AABBCCDDEEFF0011)");
            Assert.Contains(text, "NO layout for this file's hash");
        });

        Harness.Add("diagnose-map: one map's identifiers, category reasoning, art and instance link; unknown ids are explained", () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            world.Assign(1420, 0, 85);
            var plan = world.Plan();
            using var assets = new DirectoryAssetSource(world.AssetsDir);
            var doc = MapDiagnostics.Map(world.Db, plan, assets, null, Clean(dir.Path), 1420, null, default);
            var text = doc.ToText();
            Assert.Contains(text, "uiMapID 1420, internal MapID 0, MapArtID 102");
            Assert.Contains(text, "category: zone (source uimap-type, confidence confirmed)");
            Assert.Contains(text, "layer 0: 1002x668, tiles 12/12 in the metadata, 12 readable in storage");
            Assert.Contains(text, "Full-reveal overlays");
            var missing = MapDiagnostics.Map(world.Db, plan, assets, null, Clean(), null, 424242, default).ToText();
            Assert.Contains(missing, "never substituted");
            var byMapId = MapDiagnostics.Map(world.Db, plan, assets, null, Clean(), null, 0, default).ToText();
            Assert.Contains(byMapId, "UiMap 1420");
        });

        Harness.Add("diagnose-overlays: each overlay's state and a verdict in the project's vocabulary", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Combine("w"))
                .Map(1, "Ready", 3, 0, flags: 2).Art(1, (0, 1002, 668)).Link(1, 1).Overlay(1, 11, 10, 10, 100, 100)
                .Map(2, "EmptyRows", 3, 0, flags: 2).Art(2, (0, 1002, 668)).Link(2, 2).RawOverlay(2, 21, 0, 0, 0, 0)
                .Map(3, "Incomplete", 3, 0, flags: 2).Art(3, (0, 1002, 668)).Link(3, 3).RawOverlay(3, 31, 0, 0, 600, 100)
                .Map(4, "MissingTile", 3, 0, flags: 2).Art(4, (0, 1002, 668)).Link(4, 4).Overlay(4, 41, 10, 10, 100, 100)
                .Map(5, "Huge", 3, 0, flags: 2).Art(5, (0, 1002, 668)).Link(5, 5).RawOverlay(5, 51, 0, 0, 9000, 100);
            world.OverlayTile(31, 0, 0, 0);
            world.DeleteTexture(world.Db.OverlayTiles.First(t => t.OverlayId == 41).FileDataId);
            var plan = world.Plan();
            using var assets = new DirectoryAssetSource(world.AssetsDir);
            var doc = MapDiagnostics.Overlays(world.Db, plan, assets, null, Clean(dir.Path), null, default);
            var verdicts = JsonDocument.Parse(doc.ToJson()).RootElement.GetProperty("data").GetProperty("verdicts");
            Assert.Equal(1, verdicts.GetProperty("READY_TO_EXPORT").GetInt32());
            Assert.Equal(1, verdicts.GetProperty("NO_REVEAL_ARTWORK").GetInt32());
            Assert.Equal(1, verdicts.GetProperty("METADATA_INCOMPLETE").GetInt32());
            Assert.Equal(1, verdicts.GetProperty("CLIENT_ART_UNAVAILABLE").GetInt32());
            Assert.Equal(1, verdicts.GetProperty("OVERLAY_UNSUPPORTED").GetInt32());
            var text = doc.ToText();
            Assert.Contains(text, "overlay 21: no-artwork");
            Assert.Contains(text, "overlay 31: grid-incomplete");
            Assert.Contains(text, "FileDataID");
            var only = MapDiagnostics.Overlays(world.Db, plan, assets, null, Clean(), 1, default).ToText();
            Assert.DoesNotContain(only, "EmptyRows");
        });

        Harness.Add("diagnose-overlays: the reviewed atlas comparison is reported", () =>
        {
            var embedded = ForeverDB.Companion.Services.FullRevealMapArt.GetEmbeddedAtlas();
            var artId = embedded.Keys.First();
            using var dir = new TempDir();
            var world = new World(dir.Combine("w")).Map(1, "Atlas", 3, 0, flags: 2).Art((int)artId, (0, 1002, 668)).Link(1, (int)artId);
            var id = 1;

            foreach (var region in embedded[artId])
            {
                world.RawOverlay((int)artId, id, region.OffsetX, region.OffsetY, region.Width, region.Height);
                var columns = (region.Width + 255) / 256;

                for (var i = 0; i < region.FileDataIds.Count; i++)
                {
                    File.WriteAllBytes(Path.Combine(world.AssetsDir, region.FileDataIds[i] + ".blp"), BlpWriter.Tile(256, 256, 1, 2, 3));
                    world.Db.OverlayTiles.Add(new ForeverDB.AtlasExporter.Model.OverlayTileRow(id, 0, i / columns, i % columns, region.FileDataIds[i]));
                }

                id++;
            }

            using var assets = new DirectoryAssetSource(world.AssetsDir);
            var text = MapDiagnostics.Overlays(world.Db, world.Plan(), assets, null, Clean(), null, default).ToText();
            Assert.Contains(text, "MATCH it exactly");
        });

        Harness.Add("diagnose-instances: says why there are none (no Map table) and lists what was consulted", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Path).Map(1459, "Alterac Valley", 6, 0).Art(1, (0, 256, 256)).Link(1459, 1).Assign(1459, 30);
            world.Db.MissingOptionalTables["Map"] = "client-db2: Map.db2 not found | wago: network disabled";
            world.Db.TableWarnings.Add("[client-db2] UiMap: encrypted section (key X) skipped (3 records unavailable).");
            var doc = MapDiagnostics.Instances(world.Db, world.Plan(), Clean(dir.Path));
            var text = doc.ToText();
            Assert.Contains(text, "Coverage: map-table-unavailable");
            Assert.Contains(text, "Map rows: 0");
            Assert.Contains(text, "unavailable: Map - client-db2: Map.db2 not found");
            Assert.Contains(text, "warning: [client-db2] UiMap: encrypted section");
            Assert.Contains(text, "MapID 30 Alterac Valley - battleground [compat-mapid, fallback]");
            Assert.Contains(text, "An instance record does not imply a drawable interior map");
            Assert.True(JsonDocument.Parse(doc.ToJson()).RootElement.GetProperty("data").GetProperty("instances").GetArrayLength() == 1);
        });

        Harness.Add("diagnostics: documents are written as .txt and .json and never contain local paths", () =>
        {
            using var dir = new TempDir();
            var doc = new DiagnosticsDocument("t", Clean(dir.Path, "SecretUser"));
            doc.Heading("h").Line($"opened {dir.Path}\\file for SecretUser").Data("x", 1);
            doc.WriteTo(dir.Combine("out"), "report");
            var text = File.ReadAllText(dir.Combine("out", "report.txt"));
            Assert.DoesNotContain(text, dir.Path);
            Assert.DoesNotContain(text, "SecretUser");
            Assert.Equal(1, JsonDocument.Parse(File.ReadAllText(dir.Combine("out", "report.json"))).RootElement.GetProperty("data").GetProperty("x").GetInt32());
        });
    }
}
