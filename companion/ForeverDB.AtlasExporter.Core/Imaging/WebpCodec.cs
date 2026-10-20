using System.Runtime.InteropServices;
using SkiaSharp;

namespace ForeverDB.AtlasExporter.Imaging;

public sealed record WebpSettings(int Quality, bool Lossless)
{
    public static WebpSettings Default { get; } = new(90, false);
    public override string ToString() => Lossless ? "lossless" : $"lossy-q{Quality}";
}

public static class WebpCodec
{
    public static byte[] Encode(BgraImage image, WebpSettings settings)
    {
        var info = new SKImageInfo(image.Width, image.Height, SKColorType.Bgra8888, SKAlphaType.Unpremul);
        using var bitmap = new SKBitmap(info);
        Marshal.Copy(image.Pixels, 0, bitmap.GetPixels(), image.Pixels.Length);
        using var pixmap = bitmap.PeekPixels();
        var options = new SKWebpEncoderOptions(
            settings.Lossless ? SKWebpEncoderCompression.Lossless : SKWebpEncoderCompression.Lossy,
            settings.Lossless ? 100 : Math.Clamp(settings.Quality, 1, 100));
        using var data = pixmap.Encode(options);

        if (data is null || data.Size == 0)
        {
            throw new InvalidOperationException("WebP encoder produced no data.");
        }

        return data.ToArray();
    }

    /// <summary>Decodes (for integrity checks); null when the bytes are not a readable WebP.</summary>
    public static BgraImage? TryDecode(byte[] webp)
    {
        try
        {
            using var codec = SKCodec.Create(new SKMemoryStream(webp));

            if (codec is null || codec.EncodedFormat != SKEncodedImageFormat.Webp)
            {
                return null;
            }

            var info = new SKImageInfo(
                codec.Info.Width, codec.Info.Height, SKColorType.Bgra8888, SKAlphaType.Unpremul);
            using var bitmap = new SKBitmap(info);
            var result = codec.GetPixels(info, bitmap.GetPixels());

            if (result != SKCodecResult.Success)
            {
                return null;
            }

            var pixels = new byte[info.BytesSize];
            Marshal.Copy(bitmap.GetPixels(), pixels, 0, pixels.Length);
            return new BgraImage(info.Width, info.Height, pixels);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>Mean absolute RGB difference over visible pixels, and the worst alpha error.</summary>
    public static (double MeanRgbError, int MaxAlphaError) Compare(BgraImage expected, BgraImage actual)
    {
        if (expected.Width != actual.Width || expected.Height != actual.Height)
        {
            return (double.PositiveInfinity, 255);
        }

        long sum = 0;
        long count = 0;
        var maxAlpha = 0;
        var a = expected.Pixels;
        var b = actual.Pixels;

        for (var i = 0; i < a.Length; i += 4)
        {
            maxAlpha = Math.Max(maxAlpha, Math.Abs(a[i + 3] - b[i + 3]));

            if (a[i + 3] == 0)
            {
                continue;
            }

            sum += Math.Abs(a[i] - b[i]) + Math.Abs(a[i + 1] - b[i + 1]) + Math.Abs(a[i + 2] - b[i + 2]);
            count += 3;
        }

        return (count == 0 ? 0 : (double)sum / count, maxAlpha);
    }
}
