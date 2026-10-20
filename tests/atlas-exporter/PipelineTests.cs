using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using ForeverDB.AtlasExporter.Client;
using ForeverDB.AtlasExporter.Export;
using ForeverDB.AtlasExporter.Imaging;

namespace Atlas.Exporter.Tests;

internal static class PipelineTests
{
    private static string Sha(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();

    private static JsonElement Json(string path) => JsonDocument.Parse(File.ReadAllText(path)).RootElement;

    private static BgraImage Decode(string path) => WebpCodec.TryDecode(File.ReadAllBytes(path))!;

    private static (byte B, byte G, byte R, byte A) Px(BgraImage image, int x, int y)
    {
        var i = (y * image.Width + x) * 4;
        return (image.Pixels[i], image.Pixels[i + 1], image.Pixels[i + 2], image.Pixels[i + 3]);
    }

    private static IEnumerable<string> Files(string root, params string[] folders) =>
        folders.SelectMany(f => Directory.Exists(Path.Combine(root, f))
            ? Directory.EnumerateFiles(Path.Combine(root, f), "*", SearchOption.AllDirectories)
            : Array.Empty<string>()).OrderBy(p => p, StringComparer.Ordinal);

    public static void Register()
    {
        Harness.Add("export: standard client exports every drawable map and writes the full file set", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var output = dir.Combine("out", "ForeverDB-Atlas-Export");
            var result = await Run.Export(world, output);

            Assert.Equal("COMPLETE", result.Status);
            Assert.Equal(0, result.ExitCode);
            Assert.Equal(10, result.Summary.MapsDiscovered, "discovered");
            Assert.Equal(7, result.Summary.DrawableMaps, "drawable");
            Assert.Equal(6, result.Summary.MapsExported, "exported (art owners)");
            Assert.Equal(1, result.Summary.MapsSharedArt, "shared art");
            Assert.Equal(0, result.Summary.MapsFailed);
            Assert.Equal(1, result.Summary.MapsInherited);
            Assert.Equal(2, result.Summary.MapsMissingArtwork);

            foreach (var required in new[]
            {
                "atlas/index.json", "atlas/hierarchy.json", "atlas/build.json", "atlas/export-report.json",
                "diagnostics/missing-maps.json", "diagnostics/extraction-errors.json",
                "diagnostics/export-summary.txt", "gallery/index.html",
                "maps/1420/base/overview.webp", "maps/1420/base/detail.webp", "maps/1420/base/manifest.json",
                "maps/1420/full-reveal/overview.webp", "maps/1420/full-reveal/manifest.json",
                "maps/947/base/overview.webp", "maps/1500/base/manifest.json"
            })
            {
                Assert.True(File.Exists(Path.Combine(output, required)), $"missing {required}");
            }

            Assert.False(File.Exists(Path.Combine(output, "maps/1500/base/overview.webp")), "shared art is stored once");
            Assert.True(result.ZipPath is not null && File.Exists(result.ZipPath), "zip");
            Assert.True(result.ZipPath!.EndsWith("ForeverDB-Atlas-Export-1.60.1.70245.zip"));
            Assert.Equal(Path.Combine(dir.Combine("out"), "ForeverDB-Atlas-Export-1.60.1.70245.zip"), result.ZipPath);
        });

        Harness.Add("export: dimensions, hashes and manifests agree with the files on disk", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var output = dir.Combine("out");
            await Run.Export(world, output);
            var index = Json(Path.Combine(output, "atlas/index.json"));
            var checkedImages = 0;

            foreach (var map in index.GetProperty("maps").EnumerateArray())
            {
                foreach (var variant in map.GetProperty("variants").EnumerateArray())
                {
                    var manifest = Json(Path.Combine(output, variant.GetProperty("manifest").GetString()!));
                    Assert.Equal(map.GetProperty("uiMapId").GetInt32(), manifest.GetProperty("zoneId").GetInt32(), "zoneId");
                    Assert.Equal(map.GetProperty("name").GetString(), manifest.GetProperty("zoneName").GetString());
                    Assert.Equal("v1", manifest.GetProperty("version").GetString());
                    Assert.Equal("provisional", manifest.GetProperty("calibration").GetProperty("status").GetString());
                    Assert.Equal("normalized-percent", manifest.GetProperty("projection").GetProperty("type").GetString());
                    Assert.Equal("1.60.1.70245", manifest.GetProperty("provenance").GetProperty("clientVersion").GetString());
                    Assert.Equal(variant.GetProperty("uiMapArtId").GetInt32(), manifest.GetProperty("provenance").GetProperty("mapArtId").GetInt32());
                    Assert.Equal(variant.GetProperty("images").GetArrayLength(), manifest.GetProperty("images").GetArrayLength(), "image count");

                    foreach (var image in variant.GetProperty("images").EnumerateArray())
                    {
                        var path = Path.Combine(output, image.GetProperty("path").GetString()!);
                        Assert.True(File.Exists(path), path);
                        Assert.Equal(image.GetProperty("sha256").GetString(), Sha(path), "sha256");
                        Assert.Equal(image.GetProperty("bytes").GetInt64(), new FileInfo(path).Length, "bytes");
                        var decoded = Decode(path);
                        Assert.Equal(image.GetProperty("width").GetInt32(), decoded.Width, "width");
                        Assert.Equal(image.GetProperty("height").GetInt32(), decoded.Height, "height");
                        Assert.Equal("webp", image.GetProperty("format").GetString());
                        checkedImages++;
                    }
                }
            }

            Assert.True(checkedImages >= 9, $"checked {checkedImages} images");
            var overview = Decode(Path.Combine(output, "maps/1420/base/overview.webp"));
            Assert.Equal(1002, overview.Width);
            Assert.Equal(668, overview.Height);
            var detail = Decode(Path.Combine(output, "maps/1420/base/detail.webp"));
            Assert.Equal(1536, detail.Width);
            Assert.Equal(1024, detail.Height);
            var shared = Json(Path.Combine(output, "maps/1500/base/manifest.json"));
            Assert.Equal(1420, shared.GetProperty("imageRef").GetProperty("uiMapId").GetInt32());
            Assert.Equal("shared-art", shared.GetProperty("status").GetString());
        });

        Harness.Add("export: orientation - tile (0,0) is top-left and rows grow downward", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var output = dir.Combine("out");
            await Run.Export(world, output, o => { o.Webp = new WebpSettings(100, true); o.Reveal = false; });
            var image = Decode(Path.Combine(output, "maps/1420/base/overview.webp"));
            var origin = Px(image, 0, 0);
            Assert.True(origin.R == 255 && origin.G == 255 && origin.B == 255, "marker of tile r0c0 at pixel (0,0)");

            foreach (var (row, col) in new[] { (0, 0), (0, 3), (2, 0), (2, 3) })
            {
                var (r, g, b) = World.TileColor(102, 0, row, col);
                var p = Px(image, Math.Min(col * 256 + 6, 1001), Math.Min(row * 256 + 6, 667));
                Assert.True(p.R == r && p.G == g && p.B == b, $"r{row}c{col} {p}");
            }

            var manifest = Json(Path.Combine(output, "maps/1420/base/manifest.json"));
            Assert.Equal("top-left", manifest.GetProperty("projection").GetProperty("origin").GetString());
            Assert.Equal("down", manifest.GetProperty("projection").GetProperty("yDirection").GetString());
            Assert.Equal("imageWidth * xPercent / 100", manifest.GetProperty("projection").GetProperty("pixelX").GetString());
            Assert.Equal("imageHeight * yPercent / 100", manifest.GetProperty("projection").GetProperty("pixelY").GetString());
        });

        Harness.Add("export: full-reveal changes only the overlay rectangle and blends alpha", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var output = dir.Combine("out");
            var result = await Run.Export(world, output, o => o.Webp = new WebpSettings(100, true));
            var baseImage = Decode(Path.Combine(output, "maps/1420/base/overview.webp"));
            var reveal = Decode(Path.Combine(output, "maps/1420/full-reveal/overview.webp"));
            Assert.Equal(baseImage.Width, reveal.Width);
            var inside = (X: 120, Y: 100);                                   // overlay is (50,60) 200x150
            Assert.True(Px(reveal, inside.X, inside.Y).R > Px(baseImage, inside.X, inside.Y).R + 40, "overlay tints inside");
            Assert.Equal(Px(baseImage, 400, 400), Px(reveal, 400, 400), "outside identical");
            Assert.Equal(Px(baseImage, 20, 20), Px(reveal, 20, 20), "outside identical (top-left)");
            Assert.Equal((byte)255, Px(reveal, inside.X, inside.Y).A);
            var variant = result.Variants.Single(v => v.UiMapId == 1420 && v.Kind == "full-reveal");
            Assert.Equal("client-metadata-only", variant.RevealStatus);
            Assert.Equal(1, variant.OverlayTiles);
            var manifest = Json(Path.Combine(output, "maps/1420/full-reveal/manifest.json"));
            Assert.Equal("full-reveal", manifest.GetProperty("provenance").GetProperty("artVariant").GetString());
        });

        Harness.Add("export: reveal matching the reviewed atlas is labelled as such", async () =>
        {
            using var dir = new TempDir();
            var embedded = ForeverDB.Companion.Services.FullRevealMapArt.GetEmbeddedAtlas();
            var art = embedded.Keys.First(k => embedded[k].Max(r => r.OffsetX + r.Width) <= 1002 && embedded[k].Max(r => r.OffsetY + r.Height) <= 668);
            var world = new World(dir.Combine("w")).Map(1, "Atlas Match", 3, 0).Art((int)art, (0, 1002, 668)).Link(1, (int)art);

            foreach (var region in embedded[art])
            {
                for (var i = 0; i < region.FileDataIds.Count; i++)
                {
                    File.WriteAllBytes(Path.Combine(world.AssetsDir, region.FileDataIds[i] + ".blp"), BlpWriter.Tile(256, 256, 200, 10, 10, 120));
                }
            }

            var overlayId = 1;
            var columnsOf = (ForeverDB.Companion.Services.FullRevealRegion r) => (r.Width + 255) / 256;

            foreach (var region in embedded[art])
            {
                world.Db.Overlays.Add(new ForeverDB.AtlasExporter.Model.OverlayRow(overlayId, (int)art, region.Width, region.Height, region.OffsetX, region.OffsetY, 0));

                for (var i = 0; i < region.FileDataIds.Count; i++)
                {
                    world.Db.OverlayTiles.Add(new ForeverDB.AtlasExporter.Model.OverlayTileRow(
                        overlayId, 0, i / columnsOf(region), i % columnsOf(region), region.FileDataIds[i]));
                }

                overlayId++;
            }

            var result = await Run.Export(world, dir.Combine("out"));
            var reveal = result.Variants.Single(v => v.Kind == "full-reveal");
            Assert.Equal(ItemStatus.Exported, reveal.Status);
            Assert.Equal("client-metadata-matches-reviewed-atlas", reveal.RevealStatus);
        });

        Harness.Add("export: missing and corrupt textures fail only their map; the rest still exports", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            world.DeleteTexture(world.TileId(103, 0, 0, 1));                 // Stormwind: missing tile
            world.CorruptTexture(world.TileId(104, 0, 0, 0));                // Deadmines: corrupt BLP
            var output = dir.Combine("out");
            var result = await Run.Export(world, output);

            Assert.Equal(2, result.Summary.MapsFailed, "failed maps");
            Assert.Equal(5, result.Summary.MapsExported + result.Summary.MapsSharedArt, "other maps unaffected");
            Assert.Equal(2, result.ExitCode, "partial exit code");
            Assert.True(result.Status.StartsWith("PARTIAL"), result.Status);
            Assert.False(File.Exists(Path.Combine(output, "maps/1453/base/overview.webp")), "no half-built image delivered");
            Assert.True(File.Exists(Path.Combine(output, "maps/1420/base/overview.webp")), "healthy map exported");
            var errors = Json(Path.Combine(output, "diagnostics/extraction-errors.json"));
            Assert.True(errors.GetProperty("count").GetInt32() >= 2);
            var text = File.ReadAllText(Path.Combine(output, "diagnostics/extraction-errors.json"));
            Assert.Contains(text, "r0c1");
            var missing = File.ReadAllText(Path.Combine(output, "diagnostics/missing-maps.json"));
            Assert.Contains(missing, "Stormwind City");
            Assert.Contains(missing, "no-own-art");
            Assert.Contains(missing, "inherits-parent");
        });

        Harness.Add("export: an empty or unreadable client never reports success", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            Directory.Delete(world.AssetsDir, recursive: true);
            Directory.CreateDirectory(world.AssetsDir);
            var result = await Run.Export(world, dir.Combine("out"));
            Assert.Equal(3, result.ExitCode);
            Assert.True(result.Status.StartsWith("FAILED"), result.Status);
            Assert.Equal(0, result.Summary.MapsExported);
            var text = File.ReadAllText(Path.Combine(result.OutputDirectory, "diagnostics/export-summary.txt"));
            Assert.Contains(text, "Status: FAILED");
            Assert.Contains(text, "Failed: 7");
        });

        Harness.Add("export: allow-partial keeps incomplete maps, labelled partial, holes transparent", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            world.DeleteTexture(world.TileId(103, 0, 0, 1));
            var output = dir.Combine("out");
            var result = await Run.Export(world, output, o => o.AllowPartial = true);
            var variant = result.Variants.Single(v => v.UiMapId == 1453 && v.Kind == "base");
            Assert.Equal(ItemStatus.Partial, variant.Status);
            var image = Decode(Path.Combine(output, "maps/1453/base/overview.webp"));
            Assert.Equal((byte)0, Px(image, 300, 10).A);
            var manifest = Json(Path.Combine(output, "maps/1453/base/manifest.json"));
            Assert.False(manifest.GetProperty("image").GetProperty("complete").GetBoolean());
            Assert.Equal(2, result.ExitCode, "partial maps do not count as clean success");
        });

        Harness.Add("export: identical FileDataIDs shared by two arts are read and decoded once", async () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Combine("w")).Map(1, "A", 3, 0).Map(2, "B", 3, 0).Art(10, (0, 512, 256)).Link(1, 10);
            world.Db.ArtStyle[11] = 10_011;
            world.Db.StyleLayers.Add(new ForeverDB.AtlasExporter.Model.StyleLayerRow(10_011, 0, 512, 256, 256, 256));

            foreach (var tile in world.Db.ArtTiles.Where(t => t.UiMapArtId == 10).ToList())
            {
                world.Db.ArtTiles.Add(tile with { UiMapArtId = 11 });
            }

            world.Link(2, 11);
            var result = await Run.Export(world, dir.Combine("out"));
            Assert.Equal(2, result.Summary.MapsExported, "two distinct arts exported");
            Assert.Equal(2, result.Summary.TextureCacheMisses, "two unique textures read");
            Assert.Equal(2, result.Summary.TextureCacheHits, "second art served from cache");
        });

        Harness.Add("export: a tiny texture budget still works (bounded memory)", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var output = dir.Combine("out");
            var pipeline = new AtlasExportPipeline(world.Plan(), world.Db, world.Identity,
                new DirectoryAssetSource(world.AssetsDir),
                new ExportOptions { OutputDirectory = output, TextureCacheBytes = 300_000, CreateZip = false });
            var result = await pipeline.RunAsync(null, default);
            Assert.Equal("COMPLETE", result.Status);
            Assert.Equal(0, result.Summary.MapsFailed);
        });

        Harness.Add("export: cancellation stops cleanly, keeps state, and resume finishes the job", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var output = dir.Combine("out");
            using var cts = new CancellationTokenSource();
            var progress = new SyncProgress(p => { if (p.Completed >= 3) cts.Cancel(); });
            var first = await Run.Export(world, output, token: cts.Token, progress: progress);
            Assert.True(first.Cancelled);
            Assert.Equal("CANCELLED", first.Status);
            Assert.Equal(130, first.ExitCode);
            Assert.Null(first.ZipPath);
            Assert.True(File.Exists(ExportState.PathFor(output)), "state persisted");
            Assert.True(File.Exists(Path.Combine(output, "maps/947/base/overview.webp")), "finished work kept");
            Assert.Equal(0, Files(output, "maps").Count(f => f.EndsWith(".tmp")), "no temp leftovers");

            var second = await Run.Export(world, output, o => o.Resume = true);
            Assert.Equal("COMPLETE", second.Status);
            Assert.True(second.Summary.MapsReused >= 2, $"reused {second.Summary.MapsReused}");
            Assert.True(second.Summary.MapsExported >= 1, "remaining maps exported");
            Assert.True(second.ZipPath is not null && File.Exists(second.ZipPath));
        });

        Harness.Add("export: resume retries failures and keeps finished maps untouched", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var output = dir.Combine("out");
            var missingId = world.TileId(103, 0, 0, 0);
            var good = File.ReadAllBytes(Path.Combine(world.AssetsDir, missingId + ".blp"));
            world.DeleteTexture(missingId);
            var first = await Run.Export(world, output);
            Assert.Equal(1, first.Summary.MapsFailed);

            var stamp = File.GetLastWriteTimeUtc(Path.Combine(output, "maps/1420/base/overview.webp"));
            await Task.Delay(50);
            File.WriteAllBytes(Path.Combine(world.AssetsDir, missingId + ".blp"), good);

            await Assert.ThrowsAsync<OutputNotEmptyException>(() => Run.Export(world, output));
            var second = await Run.Export(world, output, o => o.Resume = true);
            Assert.Equal("COMPLETE", second.Status);
            Assert.Equal(0, second.Summary.MapsFailed);
            Assert.Equal(1, second.Summary.MapsExported, "only the failed map was redone");
            Assert.Equal(5, second.Summary.MapsReused, "finished maps reused");
            Assert.Equal(stamp, File.GetLastWriteTimeUtc(Path.Combine(output, "maps/1420/base/overview.webp")), "file untouched");
        });

        Harness.Add("export: changed source art is re-exported, unchanged maps are not (incremental)", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var output = dir.Combine("out");
            await Run.Export(world, output);
            var replacement = world.Db.ArtTiles.First(t => t.UiMapArtId == 103 && t.Row == 0 && t.Column == 0);
            File.WriteAllBytes(Path.Combine(world.AssetsDir, "777777.blp"), BlpWriter.Tile(256, 256, 9, 9, 9));
            world.Db.ArtTiles.Remove(replacement);
            world.Db.ArtTiles.Add(replacement with { FileDataId = 777777 });
            var again = await Run.Export(world, output, o => o.Resume = true);
            Assert.Equal(1, again.Summary.MapsExported, "only Stormwind changed");
            Assert.Equal(5, again.Summary.MapsReused);
            var changed = Decode(Path.Combine(output, "maps/1453/base/overview.webp"));
            var p = Px(changed, 40, 40);
            Assert.True(Math.Abs(p.R - 9) < 12 && Math.Abs(p.G - 9) < 12, $"new texture visible {p}");

            var requality = await Run.Export(world, output, o => { o.Resume = true; o.Webp = new WebpSettings(60, false); });
            Assert.Equal(6, requality.Summary.MapsExported, "encoder settings change invalidates everything");
        });

        Harness.Add("export: output is byte-for-byte deterministic, including the ZIP", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var a = await Run.Export(world, dir.Combine("a", "ForeverDB-Atlas-Export"));
            var b = await Run.Export(world, dir.Combine("b", "ForeverDB-Atlas-Export"));
            var left = Files(a.OutputDirectory, "atlas", "maps", "diagnostics", "gallery").Select(f => Path.GetRelativePath(a.OutputDirectory, f)).ToList();
            var right = Files(b.OutputDirectory, "atlas", "maps", "diagnostics", "gallery").Select(f => Path.GetRelativePath(b.OutputDirectory, f)).ToList();
            Assert.Equal(string.Join("\n", left), string.Join("\n", right), "same file set");

            foreach (var relative in left)
            {
                Assert.Equal(Sha(Path.Combine(a.OutputDirectory, relative)), Sha(Path.Combine(b.OutputDirectory, relative)), relative);
            }

            Assert.Equal(Sha(a.ZipPath!), Sha(b.ZipPath!), "zip");
        });

        Harness.Add("zip: sorted entries under one root, required content, no cache/state/temp files", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var result = await Run.Export(world, dir.Combine("out"));
            using var zip = ZipFile.OpenRead(result.ZipPath!);
            var names = zip.Entries.Select(e => e.FullName).ToList();
            Assert.True(names.All(n => n.StartsWith("ForeverDB-Atlas-Export/")), "single root folder");
            Assert.True(names.Contains("ForeverDB-Atlas-Export/atlas/index.json"));
            Assert.True(names.Contains("ForeverDB-Atlas-Export/diagnostics/export-summary.txt"));
            Assert.True(names.Contains("ForeverDB-Atlas-Export/maps/1420/base/overview.webp"));
            Assert.True(names.Contains("ForeverDB-Atlas-Export/gallery/index.html"));
            Assert.False(names.Any(n => n.Contains(".state") || n.EndsWith(".tmp") || n.Contains("casc-cache")));
            var ordered = names.Skip(1).ToList();
            Assert.Equal(string.Join("\n", ordered.OrderBy(n => n, StringComparer.Ordinal)), string.Join("\n", ordered), "sorted");
            Assert.True(zip.Entries.All(e => e.LastWriteTime.Year == 2000), "fixed timestamps");

            foreach (var entry in zip.Entries.Where(e => e.FullName.EndsWith(".webp")))
            {
                using var stream = entry.Open();
                using var memory = new MemoryStream();
                stream.CopyTo(memory);
                Assert.True(WebpCodec.TryDecode(memory.ToArray()) is not null, entry.FullName + " readable inside zip");
            }

            var summaryText = new StreamReader(zip.GetEntry("ForeverDB-Atlas-Export/diagnostics/export-summary.txt")!.Open()).ReadToEnd();
            Assert.Contains(summaryText, $"ZIP size: ");
            Assert.Contains(summaryText, new FileInfo(result.ZipPath!).Length.ToString("N0"));
        });

        Harness.Add("verify: an untouched export (folder and ZIP) is consistent; tampering is detected", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var result = await Run.Export(world, dir.Combine("out"));
            var clean = ExportVerifier.Verify(result.OutputDirectory);
            Assert.True(clean.IsValid, string.Join("; ", clean.Problems));
            Assert.Equal(10, clean.MapsChecked);
            Assert.True(clean.ImagesChecked >= 9);
            var zipped = ExportVerifier.VerifyZip(result.ZipPath!);
            Assert.True(zipped.IsValid, string.Join("; ", zipped.Problems));

            var image = Path.Combine(result.OutputDirectory, "maps/947/base/overview.webp");
            var original = File.ReadAllBytes(image);
            File.WriteAllBytes(image, original.Take(original.Length - 20).ToArray());
            Assert.True(ExportVerifier.Verify(result.OutputDirectory).Problems.Any(p => p.Contains("947")), "truncated image");
            File.WriteAllBytes(image, original);

            File.Delete(Path.Combine(result.OutputDirectory, "maps/1420/base/manifest.json"));
            Assert.True(ExportVerifier.Verify(result.OutputDirectory).Problems.Any(p => p.Contains("manifest missing")));
            File.Delete(Path.Combine(result.OutputDirectory, "maps/1420/base/overview.webp"));
            Assert.True(ExportVerifier.Verify(result.OutputDirectory).Problems.Any(p => p.Contains("missing")));
            Assert.False(ExportVerifier.VerifyZip(Path.Combine(dir.Path, "nonexistent.zip")).IsValid);
        });

        Harness.Add("summary: every figure is the measured value and the required lines exist", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var result = await Run.Export(world, dir.Combine("out"));
            var text = File.ReadAllText(Path.Combine(result.OutputDirectory, "diagnostics/export-summary.txt"));

            foreach (var line in new[]
            {
                "ForeverDB Atlas Export Summary", "Client build: 1.60.1.70245", "Maps discovered: 10", "Drawable maps: 7",
                "Successfully exported: 7", "Failed: 0", "Missing artwork: 2", "World maps: 2", "Continent maps: 1",
                "Zone maps: 3", "City maps: 1", "Instance maps: 2", "Other maps: 1", "Export size: ", "ZIP size: ", "Status: COMPLETE"
            })
            {
                Assert.Contains(text, line);
            }

            Assert.False(text.Contains("<count>") || text.Contains("<size>"), "no placeholders");
        });

        Harness.Add("report: Cloudflare Pages fit uses real file counts and sizes; nothing is dropped", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var result = await Run.Export(world, dir.Combine("out"));
            var report = Json(Path.Combine(result.OutputDirectory, "atlas/export-report.json")).GetProperty("cloudflarePagesFree");
            var files = Files(result.OutputDirectory, "maps", "atlas").ToList();
            Assert.Equal(files.Count, report.GetProperty("cdnFileCount").GetInt32(), "file count");
            Assert.Equal(files.Max(f => new FileInfo(f).Length), report.GetProperty("cdnMaxFileBytes").GetInt64(), "max file");
            Assert.True(report.GetProperty("fitsFileCount").GetBoolean() && report.GetProperty("fitsPerFileSize").GetBoolean());
            Assert.Equal(20000, report.GetProperty("fileLimit").GetInt32());
            Assert.Equal(25 * 1024 * 1024, report.GetProperty("perFileLimitBytes").GetInt64());
        });

        Harness.Add("diagnostics: local paths and account names never reach the delivery files", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            world.DeleteTexture(world.TileId(103, 0, 0, 1));
            var secret = dir.Combine("w");
            var leaky = new LeakySource(new DirectoryAssetSource(world.AssetsDir), secret);
            var output = dir.Combine("out");
            var result = await Run.Export(world, output, o => o.Redactions = new[] { secret, "SecretUser" }, assets: leaky);
            Assert.True(result.Summary.MapsFailed >= 1);

            foreach (var file in Files(output, "atlas", "diagnostics", "gallery", "maps").Where(f => f.EndsWith(".json") || f.EndsWith(".txt") || f.EndsWith(".html")))
            {
                var text = File.ReadAllText(file);
                Assert.DoesNotContain(text, secret);
                Assert.DoesNotContain(text, "SecretUser");
            }

            using var zip = ZipFile.OpenRead(result.ZipPath!);

            foreach (var entry in zip.Entries.Where(e => e.FullName.EndsWith(".json") || e.FullName.EndsWith(".txt")))
            {
                var text = new StreamReader(entry.Open()).ReadToEnd();
                Assert.DoesNotContain(text, secret);
            }
        });

        Harness.Add("regression: Tirisfal Glades (1420) is compared with the P2-D reference dimensions", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var result = await Run.Export(world, dir.Combine("out"));
            var check = Json(Path.Combine(result.OutputDirectory, "diagnostics/regression-1420.json"));
            Assert.True(check.GetProperty("discoverable").GetBoolean());
            Assert.True(check.GetProperty("exported").GetBoolean());
            Assert.True(check.GetProperty("dimensionsMatch").GetBoolean());
            Assert.True(check.GetProperty("aspectRatioMatches").GetBoolean());
            Assert.Equal("a2856ed85f2545f2604e0a7e7fc41e9f270c78e84bf6c08885f43dd500b97678", check.GetProperty("reference").GetProperty("sha256").GetString());

            var other = new World(dir.Combine("w2")).Map(1, "Only", 3, 0).Art(5, (0, 256, 256)).Link(1, 5);
            var none = await Run.Export(other, dir.Combine("out2"));
            var absent = Json(Path.Combine(none.OutputDirectory, "diagnostics/regression-1420.json"));
            Assert.False(absent.GetProperty("discoverable").GetBoolean());
        });

        Harness.Add("gallery: offline page lists every map with thumbnail data and no external requests", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var result = await Run.Export(world, dir.Combine("out"));
            var html = File.ReadAllText(Path.Combine(result.OutputDirectory, "gallery/index.html"));
            Assert.False(html.Contains("http://") || html.Contains("https://"), "no network references");

            foreach (var name in new[] { "Tirisfal Glades", "Stormwind City", "The Deadmines", "No Art Zone", "Cave Under Tirisfal" })
            {
                Assert.Contains(html, name);
            }

            Assert.Contains(html, "\"uiMapId\": 1420");
            Assert.Contains(html, "\"mapArtId\": 102");
            Assert.True(Directory.EnumerateFiles(Path.Combine(result.OutputDirectory, "gallery/thumbs"), "*.webp").Count() >= 7);
            var thumb = Decode(Directory.EnumerateFiles(Path.Combine(result.OutputDirectory, "gallery/thumbs"), "1420-base.webp").Single());
            Assert.True(thumb.Width <= 320 && thumb.Width > 0);
        });

        Harness.Add("options: layer selection, filters and quality flags change the output as documented", async () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Combine("w"));
            var only = await Run.Export(world, dir.Combine("a"), o => { o.Only = new HashSet<int> { 1420 }; o.Detail = false; o.Reveal = false; });
            Assert.Equal(1, only.Summary.MapsExported);
            Assert.False(File.Exists(Path.Combine(only.OutputDirectory, "maps/1420/base/detail.webp")));
            Assert.False(Directory.Exists(Path.Combine(only.OutputDirectory, "maps/1420/full-reveal")));
            Assert.False(Directory.Exists(Path.Combine(only.OutputDirectory, "maps/947")));
            var all = await Run.Export(world, dir.Combine("b"), o => { o.Only = new HashSet<int> { 1420 }; o.AllLayers = true; });
            Assert.True(File.Exists(Path.Combine(all.OutputDirectory, "maps/1420/base/layer-1.webp")));
            var lossless = await Run.Export(world, dir.Combine("c"), o => { o.Only = new HashSet<int> { 1420 }; o.Webp = new WebpSettings(100, true); o.Reveal = false; });
            var lossy = await Run.Export(world, dir.Combine("d"), o => { o.Only = new HashSet<int> { 1420 }; o.Webp = new WebpSettings(40, false); o.Reveal = false; });
            Assert.True(new FileInfo(Path.Combine(lossy.OutputDirectory, "maps/1420/base/overview.webp")).Length <=
                        new FileInfo(Path.Combine(lossless.OutputDirectory, "maps/1420/base/overview.webp")).Length + 2000);
        });
    }

    private sealed class SyncProgress : IProgress<ExportProgress>
    {
        private readonly Action<ExportProgress> _action;
        public SyncProgress(Action<ExportProgress> action) => _action = action;
        public void Report(ExportProgress value) => _action(value);
    }

    private sealed class LeakySource : IAssetSource
    {
        private readonly IAssetSource _inner;
        private readonly string _path;
        public LeakySource(IAssetSource inner, string path) { _inner = inner; _path = path; }
        public string Label => "leaky";
        public byte[]? ReadByFileDataId(int id)
        {
            var bytes = _inner.ReadByFileDataId(id);
            if (bytes is null) throw new IOException($"cannot read {_path}\\assets\\{id}.blp for SecretUser");
            return bytes;
        }
        public byte[]? ReadByName(string path) => _inner.ReadByName(path);
        public void Dispose() => _inner.Dispose();
    }
}

