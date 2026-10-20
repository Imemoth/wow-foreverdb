using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;
using ForeverDB.AtlasExporter.Db2;
using ForeverDB.AtlasExporter.Enumeration;
using ForeverDB.AtlasExporter.Export;
using ForeverDB.AtlasExporter.Metadata;

namespace Atlas.Exporter.Tests;

internal static class SeedAndCompatTests
{
    private static string Sha(string path) =>
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();

    /// <summary>Removes every field added in this iteration, leaving the schema of the first real-client export.</summary>
    private static void DowngradeToFirstSchema(string root)
    {
        var additive = new[]
        {
            "internalMapId", "classificationConfidence", "classificationEvidence", "floorGroupId", "floorIndex",
            "revealCompleteness", "revealFailureStage", "revealSkippedOverlays", "categoryConfidence", "floor", "artNotInReviewedAtlas"
        };

        void Strip(JsonNode? node)
        {
            switch (node)
            {
                case JsonObject obj:
                    foreach (var name in additive)
                    {
                        obj.Remove(name);
                    }

                    foreach (var child in obj.Select(p => p.Value).ToList())
                    {
                        Strip(child);
                    }

                    break;
                case JsonArray array:
                    foreach (var child in array)
                    {
                        Strip(child);
                    }

                    break;
            }
        }

        foreach (var file in Directory.EnumerateFiles(root, "*.json", SearchOption.AllDirectories)
                     .Where(f => !f.Contains(".state")).ToList())
        {
            var node = JsonNode.Parse(File.ReadAllText(file));
            Strip(node);
            File.WriteAllText(file, node!.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }

        File.Delete(Path.Combine(root, "atlas", "instances.json"));
    }

    public static void Register()
    {
        Harness.Add("compat: an export in the first schema still verifies and can seed a new run (nothing re-exported)", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var first = await Run.Export(world, dir.Combine("old", "ForeverDB-Atlas-Export"));
            DowngradeToFirstSchema(first.OutputDirectory);
            Assert.True(ExportVerifier.Verify(first.OutputDirectory).IsValid, string.Join("; ", ExportVerifier.Verify(first.OutputDirectory).Problems));

            var output = dir.Combine("new", "ForeverDB-Atlas-Export");
            var options = new ExportOptions { OutputDirectory = output, Resume = true, ExporterVersion = "test" };
            var seed = ExportSeeder.Seed(first.OutputDirectory, output, world.Plan(), world.Identity, options);
            Assert.False(seed.Refused, string.Join("; ", seed.Notes));
            Assert.Equal(7, seed.Imported, "6 base + 1 full-reveal of the owner maps");

            var second = await Run.Export(world, output, o => o.Resume = true);
            Assert.Equal(0, second.Summary.MapsExported, "everything came from the seed");
            Assert.Equal(6, second.Summary.MapsReused);
            Assert.Equal("COMPLETE", second.Status);
            Assert.True(ExportVerifier.Verify(output).IsValid);
            Assert.Equal(Sha(Path.Combine(first.OutputDirectory, "maps/1420/base/overview.webp")),
                         Sha(Path.Combine(output, "maps/1420/base/overview.webp")), "images are byte-identical");
        });

        Harness.Add("seed: a delivery ZIP seeds only the missing work; failed items are redone, healthy ones untouched", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var missing = world.TileId(103, 0, 0, 0);
            var good = File.ReadAllBytes(Path.Combine(world.AssetsDir, missing + ".blp"));
            world.DeleteTexture(missing);
            var first = await Run.Export(world, dir.Combine("old", "ForeverDB-Atlas-Export"));
            Assert.Equal(1, first.Summary.MapsFailed);
            File.WriteAllBytes(Path.Combine(world.AssetsDir, missing + ".blp"), good);

            var output = dir.Combine("new", "ForeverDB-Atlas-Export");
            var options = new ExportOptions { OutputDirectory = output, Resume = true, ExporterVersion = "test" };
            var seed = ExportSeeder.Seed(first.ZipPath!, output, world.Plan(), world.Identity, options);
            Assert.Equal(6, seed.Imported, "the failed Stormwind is not adopted");
            var second = await Run.Export(world, output, o => o.Resume = true);
            Assert.Equal(1, second.Summary.MapsExported, "only the previously failed map");
            Assert.Equal(0, second.Summary.MapsFailed);
            Assert.Equal("COMPLETE", second.Status);
        });

        Harness.Add("seed: another build, tampered images and changed art are never adopted", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var first = await Run.Export(world, dir.Combine("old", "ForeverDB-Atlas-Export"));
            var output = dir.Combine("new", "ForeverDB-Atlas-Export");
            var options = new ExportOptions { OutputDirectory = output, Resume = true, ExporterVersion = "test" };

            var otherBuild = world.Identity with { BuildKey = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF" };
            var refused = ExportSeeder.Seed(first.OutputDirectory, output, world.Plan(), otherBuild, options);
            Assert.True(refused.Refused);
            Assert.Contains(refused.Notes[0], "build key");

            var image = Path.Combine(first.OutputDirectory, "maps/947/base/overview.webp");
            var bytes = File.ReadAllBytes(image);
            File.WriteAllBytes(image, bytes.Take(bytes.Length - 8).ToArray());
            var seed = ExportSeeder.Seed(first.OutputDirectory, dir.Combine("n2", "ForeverDB-Atlas-Export"), world.Plan(), world.Identity,
                new ExportOptions { OutputDirectory = dir.Combine("n2", "ForeverDB-Atlas-Export"), Resume = true, ExporterVersion = "test" });
            Assert.Equal(6, seed.Imported, "947 failed verification");
            Assert.True(seed.Notes.Any(n => n.Contains("947/base") && n.Contains("failed verification")));

            File.WriteAllBytes(image, bytes);
            var changed = world.Plan();
            changed.Maps.Single(m => m.UiMapId == 1415).Arts[0].Layers[0].Tiles.Clear();
            changed.Maps.Single(m => m.UiMapId == 1415).Arts[0].Layers[0].Tiles.Add(new TileCell(0, 0, 123456));
            var seed2 = ExportSeeder.Seed(first.OutputDirectory, dir.Combine("n3", "ForeverDB-Atlas-Export"), changed, world.Identity,
                new ExportOptions { OutputDirectory = dir.Combine("n3", "ForeverDB-Atlas-Export"), Resume = true, ExporterVersion = "test" });
            Assert.Equal(7, seed2.Imported, "dimensions still match; the fingerprint decides reuse later");
            var state = ExportState.Load(dir.Combine("n3", "ForeverDB-Atlas-Export"));
            Assert.True(state.Items["1415/base"].Fingerprint != ExportState.Fingerprint(world.Plan().Maps.Single(m => m.UiMapId == 1415).Arts[0], false),
                "a changed tile list gets a different fingerprint, so the item is re-exported on resume");
        });

        Harness.Add("seed: reveal variants already exported are adopted as complete", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var first = await Run.Export(world, dir.Combine("old", "ForeverDB-Atlas-Export"));
            var output = dir.Combine("n", "ForeverDB-Atlas-Export");
            ExportSeeder.Seed(first.OutputDirectory, output, world.Plan(), world.Identity,
                new ExportOptions { OutputDirectory = output, Resume = true, ExporterVersion = "test" });
            var item = ExportState.Load(output).Items["1420/full-reveal"];
            Assert.Equal("complete", item.RevealCompleteness);
            Assert.Equal(1, item.OverlayTiles);
        });

        Harness.Add("db2: an empty table (no records, no sections) parses and yields zero rows instead of a header error", () =>
        {
            foreach (var omit in new[] { false, true })
            {
                var bytes = new Wdc5Writer
                {
                    OmitSection = omit, RecordSizeBytes = 0, Records = new List<byte[]>(),
                    Columns = new List<Wdc5Writer.Column> { new(Wdc5Writer.Storage.None, 32, 0) }
                }.Build();
                var file = Db2File.Parse(bytes);
                var table = file.Read("T", DbdFile.Parse("T", "COLUMNS\nint ID\n\nLAYOUT DB51D55F\n$id$ID<32>\n\n").Select("DB51D55F", null)!);
                Assert.Equal(0, table.Rows.Count, $"omit section={omit}");
            }
        });

        Harness.Add("db2: a file with an implausible header names the reason for each layout it tried", () =>
        {
            var junk = new byte[400];
            "WDC5".Select((c, i) => (c, i)).ToList().ForEach(p => junk[p.i] = (byte)p.c);
            var ex = Assert.ThrowsReturn<Db2FormatException>(() => Db2File.Parse(junk));
            Assert.Contains(ex.Message, "prefix 136");
            Assert.Contains(ex.Message, "prefix 4");
            Assert.Equal(2, Db2File.Describe(junk).Count);
        });

        Harness.Add("db2: encrypted sections become table warnings that reach the loaded database", async () =>
        {
            const string dbd = "COLUMNS\nint ID\n\nLAYOUT DB51D55F\n$id$ID<32>\n\n";
            var bytes = new Wdc5Writer
            {
                TableHash = KnownTables.TableHashes["UiMapGroupMember"], TactKeyHash = 0x1122334455667788, RecordSizeBytes = 4, Records = new List<byte[]> { new byte[4] },
                Columns = new List<Wdc5Writer.Column> { new(Wdc5Writer.Storage.None, 32, 0) }
            }.Build();
            var source = new Db2TableSource("client-db2", _ => bytes, new StaticDbd(dbd), null);
            var result = await source.ReadAsync("UiMapGroupMember", default);
            Assert.True(result.Data is not null && result.Warnings is { Count: > 0 }, result.Error ?? "no warning");
            Assert.True(result.Warnings!.Any(w => w.Contains("encrypted section")), string.Join(" | ", result.Warnings!));
            Assert.True(result.Warnings!.Any(w => w.Contains("declares 1 record")), "unreadable rows are called out");
        });
    }

    private sealed class StaticDbd : IDbdSource
    {
        private readonly string _text;
        public StaticDbd(string text) => _text = text;
        public string Label => "static";
        public Task<string?> GetAsync(string table, CancellationToken cancellationToken) => Task.FromResult<string?>(_text);
    }
}
