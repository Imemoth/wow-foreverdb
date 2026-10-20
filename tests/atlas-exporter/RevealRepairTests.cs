using System.Text.Json;
using ForeverDB.AtlasExporter.Client;
using ForeverDB.AtlasExporter.Enumeration;
using ForeverDB.AtlasExporter.Export;
using ForeverDB.AtlasExporter.Imaging;
using ForeverDB.AtlasExporter.Model;

namespace Atlas.Exporter.Tests;

/// <summary>
/// Reveal handling after the first real-client export (build 1.60.1.70450): four zones failed with
/// "overlay N has 0 tiles for a 0x0 grid" (1412, 2521, 2548) and "... for a 1x1 grid" (1434).
/// These tests reproduce those *shapes* synthetically. They do not prove the real zones are fixed.
/// </summary>
internal static class RevealRepairTests
{
    private static JsonElement Json(string path) => JsonDocument.Parse(File.ReadAllText(path)).RootElement;

    private static (byte B, byte G, byte R, byte A) Px(BgraImage image, int x, int y)
    {
        var i = (y * image.Width + x) * 4;
        return (image.Pixels[i], image.Pixels[i + 1], image.Pixels[i + 2], image.Pixels[i + 3]);
    }

    private static World OneZone(string root, Action<World>? customise = null)
    {
        var world = new World(root).Map(1, "Zone", 3, 0, flags: 2).Art(50, (0, 1002, 668)).Link(1, 50)
            .Overlay(50, 1, 50, 60, 200, 150);
        customise?.Invoke(world);
        return world;
    }

    private static VariantResult Reveal(ExportResult result) =>
        result.Variants.Single(v => v.Kind == "full-reveal");

    public static void Register()
    {
        Harness.Add("reveal: zero-size overlay rows without tiles no longer block the reveal (shape of 1412/2521/2548)", async () =>
        {
            using var dir = new TempDir();
            var world = OneZone(dir.Combine("w"), w => w.RawOverlay(50, 5551, 0, 0, 0, 0));
            var result = await Run.Export(world, dir.Combine("out"), o => o.Webp = new WebpSettings(100, true));
            var reveal = Reveal(result);
            Assert.Equal(ItemStatus.Exported, reveal.Status);
            Assert.Equal("complete", reveal.RevealCompleteness);
            Assert.Equal(1, reveal.OverlayTiles);
            Assert.True(reveal.RevealSkippedOverlays.Single().StartsWith("overlay 5551: no-artwork"), reveal.RevealSkippedOverlays[0]);

            var manifest = Json(Path.Combine(result.OutputDirectory, "maps/1/full-reveal/manifest.json"));
            Assert.Contains(manifest.GetProperty("provenance").GetProperty("revealSkippedOverlays")[0].GetString()!, "5551");
            var baseImage = WebpCodec.TryDecode(File.ReadAllBytes(Path.Combine(result.OutputDirectory, "maps/1/base/overview.webp")))!;
            var full = WebpCodec.TryDecode(File.ReadAllBytes(Path.Combine(result.OutputDirectory, "maps/1/full-reveal/overview.webp")))!;
            Assert.True(Px(full, 120, 100).R > Px(baseImage, 120, 100).R + 40, "the real overlay is composed");
            Assert.Equal(Px(baseImage, 600, 500), Px(full, 600, 500), "nothing is drawn for the empty row");
        });

        Harness.Add("reveal: a declared-size overlay with no tile records is skipped and labelled (shape of 1434)", async () =>
        {
            using var dir = new TempDir();
            var world = OneZone(dir.Combine("w"), w => w.RawOverlay(50, 5252, 300, 300, 120, 80));
            var result = await Run.Export(world, dir.Combine("out"));
            var reveal = Reveal(result);
            Assert.Equal(ItemStatus.Exported, reveal.Status);
            Assert.Equal("tileless-declared-overlays-skipped", reveal.RevealCompleteness);
            Assert.True(reveal.RevealSkippedOverlays.Single().Contains("tileless-declared"), reveal.RevealSkippedOverlays[0]);
            Assert.Equal(1, reveal.OverlayTiles);
        });

        Harness.Add("reveal: an art whose overlays are all empty gets no reveal variant and no failure", async () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Combine("w")).Map(1, "Z", 3, 0, flags: 2).Art(50, (0, 512, 256)).Link(1, 50)
                .RawOverlay(50, 7, 0, 0, 0, 0);
            var result = await Run.Export(world, dir.Combine("out"));
            Assert.False(result.Variants.Any(v => v.Kind == "full-reveal"));
            Assert.Equal("COMPLETE", result.Status);
            Assert.Equal(0, result.Summary.MapsFailed);
        });

        Harness.Add("reveal: an incomplete overlay grid blocks the reveal with a named stage; base art stays", async () =>
        {
            using var dir = new TempDir();
            var world = OneZone(dir.Combine("w"), w =>
            {
                w.RawOverlay(50, 90, 300, 100, 600, 200);   // 3x1 grid, only two tiles supplied
                w.OverlayTile(90, 0, 0, 0);
                w.OverlayTile(90, 0, 0, 1);
            });
            var output = dir.Combine("out");
            var result = await Run.Export(world, output);
            var reveal = Reveal(result);
            Assert.Equal(ItemStatus.Failed, reveal.Status);
            Assert.Equal("metadata", reveal.RevealFailureStage);
            Assert.True(reveal.Problems[0].Contains("stage=metadata") && reveal.Problems[0].Contains("grid-incomplete") &&
                        reveal.Problems[0].Contains("2 of 3"), reveal.Problems[0]);
            Assert.False(File.Exists(Path.Combine(output, "maps/1/full-reveal/overview.webp")), "no fake reveal written");
            Assert.True(File.Exists(Path.Combine(output, "maps/1/base/overview.webp")), "working base art preserved");
            Assert.Equal(ItemStatus.Exported, result.Variants.Single(v => v.Kind == "base").Status);
            Assert.Equal(0, result.Summary.MapsFailed, "the map itself is not failed");
        });

        Harness.Add("reveal: --allow-partial-reveal composes only complete overlays and says so", async () =>
        {
            using var dir = new TempDir();
            var world = OneZone(dir.Combine("w"), w =>
            {
                w.RawOverlay(50, 90, 300, 100, 600, 200);
                w.OverlayTile(90, 0, 0, 0);
            });
            var result = await Run.Export(world, dir.Combine("out"), o => o.AllowPartialReveal = true);
            var reveal = Reveal(result);
            Assert.Equal(ItemStatus.Partial, reveal.Status);
            Assert.Equal("partial-overlays", reveal.RevealCompleteness);
            Assert.Equal(1, reveal.OverlayTiles, "only the complete overlay was drawn");
            Assert.True(reveal.RevealSkippedOverlays.Any(r => r.Contains("omitted: partial reveal")));
            Assert.True(File.Exists(Path.Combine(result.OutputDirectory, "maps/1/full-reveal/overview.webp")));
            Assert.True(result.Status.StartsWith("COMPLETE WITH WARNINGS"), "never reported as a clean COMPLETE: " + result.Status);
            Assert.Equal(1, result.Summary.MapsExported, "the base map itself is complete");
        });

        Harness.Add("reveal: a missing overlay texture is reported as stage 'resolve' with its FileDataID", async () =>
        {
            using var dir = new TempDir();
            var world = OneZone(dir.Combine("w"));
            var fdid = world.Db.OverlayTiles.Single().FileDataId;
            world.DeleteTexture(fdid);
            var result = await Run.Export(world, dir.Combine("out"));
            var reveal = Reveal(result);
            Assert.Equal(ItemStatus.Failed, reveal.Status);
            Assert.Equal("resolve", reveal.RevealFailureStage);
            Assert.Contains(reveal.Problems[0], fdid.ToString());
            Assert.Equal(ItemStatus.Exported, result.Variants.Single(v => v.Kind == "base").Status);
        });

        Harness.Add("reveal: a corrupt overlay texture is stage 'decode'", async () =>
        {
            using var dir = new TempDir();
            var world = OneZone(dir.Combine("w"));
            world.CorruptTexture(world.Db.OverlayTiles.Single().FileDataId);
            var reveal = Reveal(await Run.Export(world, dir.Combine("out")));
            Assert.Equal("decode", reveal.RevealFailureStage);
        });

        Harness.Add("reveal: an overlay beyond the supported geometry is unsupported, not silently clipped", async () =>
        {
            using var dir = new TempDir();
            var world = OneZone(dir.Combine("w"), w => w.RawOverlay(50, 91, 0, 0, 5000, 100));
            var plan = world.Plan();
            Assert.Equal(OverlayKind.UnsupportedGeometry, plan.Maps[0].PrimaryArt!.Overlays.Single(o => o.Id == 91).Kind);
            var reveal = Reveal(await Run.Export(world, dir.Combine("out")));
            Assert.Equal(ItemStatus.Failed, reveal.Status);
            Assert.Contains(reveal.Problems[0], "unsupported-geometry");
        });

        Harness.Add("reveal: tiles split over layers use the lowest layer that forms the complete grid; duplicates collapse", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Path);
            var overlay = new OverlayRow(10, 1, 300, 100, 0, 0, 0);
            var tiles = new List<OverlayTileRow>
            {
                new(10, 0, 0, 0, 111),                          // layer 0 is incomplete (1 of 2)
                new(10, 1, 0, 0, 211), new(10, 1, 0, 1, 212),   // layer 1 is complete
                new(10, 1, 0, 1, 212)                           // exact duplicate row
            };
            var plan = MapEnumerator.AnalyseOverlay(overlay, tiles);
            Assert.Equal(OverlayKind.Ok, plan.Kind);
            Assert.Equal(1, plan.TileLayerIndex);
            Assert.Equal(2, plan.Tiles.Count, "duplicate collapsed");
            var conflicting = MapEnumerator.AnalyseOverlay(overlay, new List<OverlayTileRow> { new(10, 0, 0, 0, 1), new(10, 0, 0, 0, 2), new(10, 0, 0, 1, 3) });
            Assert.Equal(OverlayKind.GridInvalid, conflicting.Kind, "same cell, different textures");
            _ = world;
        });

        Harness.Add("reveal: conditional (phased) overlays are included and flagged, not dropped", async () =>
        {
            using var dir = new TempDir();
            var world = OneZone(dir.Combine("w"));
            world.Db.Overlays[0] = world.Db.Overlays[0] with { PlayerConditionId = 4242 };
            var plan = world.Plan();
            Assert.True(plan.Maps[0].PrimaryArt!.Overlays.Single().IsConditional);
            Assert.Equal(ItemStatus.Exported, Reveal(await Run.Export(world, dir.Combine("out"))).Status);
        });

        Harness.Add("reveal: the reviewed Mulgore atlas plus an extra empty 0x0 row still reveals and matches the atlas", async () =>
        {
            // Reconstruction of the real 1412 failure: all 15 real regions plus one zero-size row (overlay 5551).
            var embedded = ForeverDB.Companion.Services.FullRevealMapArt.GetEmbeddedAtlas();
            var regions = embedded[1200];
            using var dir = new TempDir();
            var world = new World(dir.Combine("w")).Map(1412, "Mulgore", 3, 1414, flags: 2).Art(1200, (0, 1002, 668)).Link(1412, 1200);
            var id = 1;

            foreach (var region in regions)
            {
                var columns = (region.Width + 255) / 256;
                world.RawOverlay(1200, id, region.OffsetX, region.OffsetY, region.Width, region.Height);

                for (var i = 0; i < region.FileDataIds.Count; i++)
                {
                    File.WriteAllBytes(Path.Combine(world.AssetsDir, region.FileDataIds[i] + ".blp"), BlpWriter.Tile(256, 256, 200, 30, 30, 140));
                    world.Db.OverlayTiles.Add(new OverlayTileRow(id, 0, i / columns, i % columns, region.FileDataIds[i]));
                }

                id++;
            }

            world.RawOverlay(1200, 5551, 0, 0, 0, 0);
            var reveal = Reveal(await Run.Export(world, dir.Combine("out")));
            Assert.Equal(ItemStatus.Exported, reveal.Status);
            Assert.Equal("client-metadata-matches-reviewed-atlas", reveal.RevealStatus);
            Assert.Equal(regions.Sum(r => r.FileDataIds.Count), reveal.OverlayTiles);
            Assert.True(reveal.RevealSkippedOverlays.Single().Contains("5551"));
        });

        Harness.Add("reveal: an earlier export's finished reveals are reused unchanged after the analysis change", async () =>
        {
            using var dir = new TempDir();
            var world = OneZone(dir.Combine("w"));
            var output = dir.Combine("out");
            await Run.Export(world, output);
            var again = await Run.Export(world, output, o => o.Resume = true);
            Assert.Equal(0, again.Summary.MapsExported);
            Assert.Equal(1, again.Summary.MapsReused);
            Assert.Equal(ItemStatus.Reused, Reveal(again).Status);
            Assert.Equal("complete", Reveal(again).RevealCompleteness);
        });
    }
}
