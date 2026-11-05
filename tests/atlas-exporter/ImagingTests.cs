using ForeverDB.AtlasExporter.Client;
using ForeverDB.AtlasExporter.Enumeration;
using ForeverDB.AtlasExporter.Imaging;

namespace Atlas.Exporter.Tests;

internal static class ImagingTests
{
    private static (byte B, byte G, byte R, byte A) Pixel(BgraImage image, int x, int y)
    {
        var i = (y * image.Width + x) * 4;
        return (image.Pixels[i], image.Pixels[i + 1], image.Pixels[i + 2], image.Pixels[i + 3]);
    }

    public static void Register()
    {
        Harness.Add("texture: BLP2 decodes with size, color, alpha and top-left origin", () =>
        {
            var image = BlpDecoder.Decode(BlpWriter.Tile(256, 256, 200, 100, 50, alpha: 128));
            Assert.Equal(256, image.Width);
            Assert.Equal(256, image.Height);
            var corner = Pixel(image, 0, 0);
            Assert.True(corner.R == 255 && corner.G == 255 && corner.B == 255, "marker pixel is the first pixel");
            var body = Pixel(image, 10, 10);
            Assert.True(body.R == 200 && body.G == 100 && body.B == 50, $"color {body}");
            Assert.Equal((byte)128, body.A, "alpha preserved");
        });

        Harness.Add("texture: corrupt or truncated BLP raises TextureDecodeException", () =>
        {
            Assert.Throws<TextureDecodeException>(() => BlpDecoder.Decode(new byte[] { 1, 2, 3, 4 }));
            var good = BlpWriter.Tile(256, 256, 1, 2, 3);
            Assert.Throws<TextureDecodeException>(() => BlpDecoder.Decode(good.Take(200).ToArray()));
        });

        Harness.Add("texture: cache decodes a shared FileDataID once and stays within its budget", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Path).Art(1, (0, 1024, 256));   // 4 distinct tiles, 256 KiB each
            var counting = new CountingSource(new DirectoryAssetSource(world.AssetsDir));
            var cache = new TextureCache(counting, budgetBytes: 600_000);
            var ids = world.Db.ArtTiles.Select(t => t.FileDataId).ToArray();

            for (var round = 0; round < 3; round++)
            {
                Assert.True(cache.Get(ids[0], out _) is not null);
            }

            Assert.Equal(1, counting.Reads, "same id read once");
            Assert.Equal(2, cache.Hits);

            foreach (var id in ids)
            {
                cache.Get(id, out _);
            }

            Assert.True(cache.UsedBytes <= 600_000, $"budget respected: {cache.UsedBytes}");
            Assert.Null(cache.Get(999_999, out var failure));
            Assert.Contains(failure!, "not found");
            var before = counting.Reads;
            cache.Get(999_999, out _);
            Assert.Equal(before, counting.Reads, "negative result cached");
        });

        Harness.Add("tiles: composition places by row/col, crops padding and keeps orientation", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Path).Art(7, (0, 600, 400));  // 3x2 tiles; edge tiles cropped to 88 / 144 px
            var layer = Layer(world, 7);
            var cache = new TextureCache(new DirectoryAssetSource(world.AssetsDir), 64_000_000);
            var result = TileCompositor.Compose(layer, cache, default);
            Assert.True(result.IsComplete, string.Join("; ", result.Problems));
            var image = result.Image!;
            Assert.Equal(600, image.Width);
            Assert.Equal(400, image.Height);
            Assert.Equal(6, result.TilesPlaced);

            for (var row = 0; row < 2; row++)
            {
                for (var col = 0; col < 3; col++)
                {
                    var (r, g, b) = World.TileColor(7, 0, row, col);
                    var p = Pixel(image, col * 256 + 5, row * 256 + 5);
                    Assert.True(p.R == r && p.G == g && p.B == b, $"tile r{row}c{col} color {p} != {(r, g, b)}");
                }
            }

            var marker = Pixel(image, 256, 0);                       // tile r0c1 top-left pixel
            Assert.True(marker.R == 255 && marker.G == 255, "tile origin is its own top-left");
            Assert.Equal((byte)255, Pixel(image, 599, 399).A, "last pixel inside the cropped canvas");
        });

        Harness.Add("tiles: a missing tile leaves a transparent hole and is reported", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Path).Art(7, (0, 512, 256));
            world.DeleteTexture(world.TileId(7, 0, 0, 1));
            var cache = new TextureCache(new DirectoryAssetSource(world.AssetsDir), 64_000_000);
            var result = TileCompositor.Compose(Layer(world, 7), cache, default);
            Assert.False(result.IsComplete);
            Assert.Equal(1, result.TilesPlaced);
            Assert.Equal((byte)0, Pixel(result.Image!, 300, 10).A, "nothing fabricated in the hole");
            Assert.True(result.Problems.Any(p => p.Contains("r0c1")), string.Join("; ", result.Problems));
        });

        Harness.Add("tiles: a texture smaller than its grid cell is an error, not stretched", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Path).Art(7, (0, 256, 256));
            File.WriteAllBytes(Path.Combine(world.AssetsDir, world.TileId(7, 0, 0, 0) + ".blp"), BlpWriter.Tile(64, 64, 1, 2, 3));
            var cache = new TextureCache(new DirectoryAssetSource(world.AssetsDir), 64_000_000);
            var result = TileCompositor.Compose(Layer(world, 7), cache, default);
            Assert.Equal(0, result.TilesPlaced);
            Assert.True(result.Problems.Any(p => p.Contains("smaller")));
        });

        Harness.Add("tiles: cancellation is honoured between tiles", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Path).Art(7, (0, 512, 512));
            using var cts = new CancellationTokenSource();
            cts.Cancel();
            var cache = new TextureCache(new DirectoryAssetSource(world.AssetsDir), 64_000_000);
            Assert.Throws<OperationCanceledException>(() => TileCompositor.Compose(Layer(world, 7), cache, cts.Token));
        });

        Harness.Add("webp: lossless round trip is pixel exact incl. alpha; lossy stays close", () =>
        {
            var pixels = new byte[64 * 48 * 4];

            for (var y = 0; y < 48; y++)
            {
                for (var x = 0; x < 64; x++)
                {
                    var i = (y * 64 + x) * 4;
                    pixels[i] = (byte)(x * 4);
                    pixels[i + 1] = (byte)(y * 5);
                    pixels[i + 2] = (byte)((x + y) * 2);
                    pixels[i + 3] = (byte)(x < 8 ? 0 : x < 16 ? 100 : 255);
                }
            }

            var image = new BgraImage(64, 48, pixels);
            var lossless = WebpCodec.TryDecode(WebpCodec.Encode(image, new WebpSettings(100, true)))!;
            Assert.Equal(64, lossless.Width);
            Assert.Equal(48, lossless.Height);
            var (error, alpha) = WebpCodec.Compare(image, lossless);
            Assert.True(error <= 1 && alpha <= 1, $"lossless error {error}/{alpha}");
            var lossy = WebpCodec.TryDecode(WebpCodec.Encode(image, new WebpSettings(90, false)))!;
            Assert.True(WebpCodec.Compare(image, lossy).MeanRgbError < 12, "lossy close");
            Assert.True(WebpCodec.TryDecode(new byte[] { 1, 2, 3 }) is null, "garbage is not a webp");
        });

        Harness.Add("reveal: overlay regions equal to the reviewed atlas are recognised; changes are not", () =>
        {
            var embedded = ForeverDB.Companion.Services.FullRevealMapArt.GetEmbeddedAtlas();
            var art = embedded.Keys.First();
            var regions = embedded[art].ToList();
            Assert.True(TileCompositor.MatchesEmbeddedAtlas((int)art, regions) == true);
            var shifted = regions.Select((r, i) => i == 0 ? r with { OffsetX = r.OffsetX + 1 } : r).ToList();
            Assert.True(TileCompositor.MatchesEmbeddedAtlas((int)art, shifted) == false);
            Assert.True(TileCompositor.MatchesEmbeddedAtlas(-5, regions) is null, "unknown art has no reference");
        });
    }

    private static ArtLayerPlan Layer(World world, int art)
    {
        var style = world.Db.ArtStyle[art];
        var layerRow = world.Db.StyleLayers.First(l => l.StyleId == style && l.LayerIndex == 0);
        var layer = new ArtLayerPlan
        {
            LayerIndex = 0, LayerWidth = layerRow.LayerWidth, LayerHeight = layerRow.LayerHeight,
            TileWidth = layerRow.TileWidth, TileHeight = layerRow.TileHeight
        };

        foreach (var tile in world.Db.ArtTiles.Where(t => t.UiMapArtId == art && t.LayerIndex == 0))
        {
            layer.Tiles.Add(new TileCell(tile.Row, tile.Column, tile.FileDataId));
        }

        layer.MissingTiles = layer.ExpectedTiles - layer.Tiles.Count;
        return layer;
    }

    private sealed class CountingSource : IAssetSource
    {
        private readonly IAssetSource _inner;
        public CountingSource(IAssetSource inner) => _inner = inner;
        public int Reads { get; private set; }
        public string Label => "counting";
        public byte[]? ReadByFileDataId(int id) { Reads++; return _inner.ReadByFileDataId(id); }
        public byte[]? ReadByName(string path) => _inner.ReadByName(path);
        public void Dispose() => _inner.Dispose();
    }
}
