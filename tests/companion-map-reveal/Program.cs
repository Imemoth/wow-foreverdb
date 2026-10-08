using ForeverDB.Companion.Services;

var failures = new List<string>();
var assertions = 0;

void Check(bool condition, string name)
{
    assertions++;

    if (!condition)
    {
        failures.Add(name);
    }
}

byte[] Base(int width, int height, byte blue = 20)
{
    var pixels = new byte[width * height * 4];

    for (var index = 0; index < width * height; index++)
    {
        pixels[index * 4] = blue;
        pixels[index * 4 + 1] = 30;
        pixels[index * 4 + 2] = 40;
        pixels[index * 4 + 3] = 255;
    }

    return pixels;
}

FullRevealTile Tile(
    int width,
    int height,
    byte blue,
    byte alpha = 255)
{
    var data = new byte[width * height * 4];

    for (var index = 0; index < width * height; index++)
    {
        data[index * 4] = blue;
        data[index * 4 + 1] = 0;
        data[index * 4 + 2] = 0;
        data[index * 4 + 3] = alpha;
    }

    return new FullRevealTile(data, width, height);
}

byte Blue(byte[] pixels, int width, int x, int y) =>
    pixels[(y * width + x) * 4];

Check(FullRevealMapArt.MapCount == 84,
    "pinned manifest contains exactly 84 Forever art maps");
Check(FullRevealMapArt.OverlayCount == 1073,
    "pinned manifest contains 1073 exploration regions");
Check(FullRevealMapArt.TileCount == 1739,
    "pinned manifest contains 1739 overlay tile references");
Check(FullRevealMapArt.Find(
        1194,
        FullRevealMapArt.SourceBuildVersion).Count > 0,
    "known map art ID resolves on exact build");
Check(FullRevealMapArt.Find(1194, "1.60.1.69913").Count == 0,
    "mismatched build never uses stale overlay data");
Check(FullRevealMapArt.Find(
        -1,
        FullRevealMapArt.SourceBuildVersion).Count == 0,
    "unknown map art ID returns no overlay candidate");

var basePixels = Base(4, 4);
var small = new[]
{
    new FullRevealRegion(2, 2, 1, 1, new[] { 123 })
};

var success = FullRevealMapArt.TryCompose(
    basePixels,
    4,
    4,
    small,
    _ => Tile(4, 4, blue: 180),
    out var rendered,
    out var drawn,
    out _);

Check(success && drawn == 1,
    "valid atlas succeeds with correct tile count");
Check(Blue(rendered, 4, 1, 1) == 180 &&
      Blue(rendered, 4, 2, 2) == 180,
    "overlay pixels use the exact offset");
Check(Blue(rendered, 4, 0, 0) == 20 &&
      Blue(rendered, 4, 3, 3) == 20,
    "canvas outside the overlay retains original art");
Check(Blue(basePixels, 4, 1, 1) == 20,
    "full art composition does not modify shared base bytes");

var translucent = FullRevealMapArt.TryCompose(
    Base(1, 1, blue: 100),
    1,
    1,
    new[] { new FullRevealRegion(1, 1, 0, 0, new[] { 2 }) },
    _ => Tile(1, 1, 200, alpha: 128),
    out var blended,
    out _,
    out _);

Check(translucent && Blue(blended, 1, 0, 0) == 150,
    "alpha blending preserves detail beneath translucent tiles");

var missingBase = Base(2, 2);
var missing = FullRevealMapArt.TryCompose(
    missingBase,
    2,
    2,
    new[]
    {
        new FullRevealRegion(1, 1, 0, 0, new[] { 1 }),
        new FullRevealRegion(1, 1, 1, 1, new[] { 2 })
    },
    id => id == 1 ? Tile(1, 1, 90) : null,
    out var incomplete,
    out var partialCount,
    out _);

Check(!missing && partialCount == 1,
    "a single unavailable overlay rejects full variant");
Check(ReferenceEquals(missingBase, incomplete) &&
      Blue(missingBase, 2, 0, 0) == 20,
    "failed full composition returns unchanged base, never partial reveal");

var corrupt = FullRevealMapArt.TryCompose(
    Base(3, 3),
    3,
    3,
    new[] { new FullRevealRegion(2, 2, 0, 0, new[] { 7 }) },
    _ => Tile(1, 1, 222),
    out _,
    out _,
    out _);

Check(!corrupt,
    "undersized source tile rejects full variant");

var malformed = FullRevealMapArt.TryCompose(
    Base(300, 1),
    300,
    1,
    new[]
    {
        new FullRevealRegion(300, 1, 0, 0, new[] { 1 })
    },
    _ => Tile(256, 1, 100),
    out _,
    out _,
    out _);

Check(!malformed,
    "incomplete 256px tile rows reject full variant");

var clipped = FullRevealMapArt.TryCompose(
    Base(2, 2),
    2,
    2,
    new[] { new FullRevealRegion(2, 2, -1, -1, new[] { 5 }) },
    _ => Tile(2, 2, 240),
    out var clippedPixels,
    out _,
    out _);

Check(clipped && Blue(clippedPixels, 2, 0, 0) == 240 &&
      Blue(clippedPixels, 2, 1, 1) == 20,
    "negative-offset overlays clip to canvas boundaries");

var rowMajor = FullRevealMapArt.TryCompose(
    Base(300, 300),
    300,
    300,
    new[]
    {
        new FullRevealRegion(
            300, 300, 0, 0,
            new[] { 1, 2, 3, 4 })
    },
    id => Tile(256, 256, (byte)(id * 40)),
    out var tiled,
    out var tiledCount,
    out _);

Check(rowMajor && tiledCount == 4 &&
      Blue(tiled, 300, 0, 0) == 40 &&
      Blue(tiled, 300, 299, 0) == 80 &&
      Blue(tiled, 300, 0, 299) == 120 &&
      Blue(tiled, 300, 299, 299) == 160,
    "row-major tile ordering and padded last row/column are correct");

if (failures.Count != 0)
{
    Console.Error.WriteLine(
        $"Companion full-map regressions FAILED ({failures.Count}):");

    foreach (var failure in failures)
    {
        Console.Error.WriteLine($" - {failure}");
    }

    return 1;
}

Console.WriteLine(
    $"Companion full-map regressions PASS ({assertions} assertions).");
return 0;
