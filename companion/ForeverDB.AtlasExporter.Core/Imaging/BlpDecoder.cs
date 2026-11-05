using War3BlpFile = War3Net.Drawing.Blp.BlpFile;

namespace ForeverDB.AtlasExporter.Imaging;

public sealed class TextureDecodeException : Exception
{
    public TextureDecodeException(string message, Exception? inner = null) : base(message, inner) { }
}

public static class BlpDecoder
{
    /// <summary>Decodes mip 0 of a BLP1/BLP2 texture (the same library the Companion uses).</summary>
    public static BgraImage Decode(byte[] blp)
    {
        try
        {
            using var stream = new MemoryStream(blp, writable: false);
            using var file = new War3BlpFile(stream);
            var pixels = file.GetPixels(0, out var width, out var height, bgra: true);

            if (pixels.Length == 0 || width <= 0 || height <= 0 ||
                pixels.LongLength != (long)width * height * 4)
            {
                throw new TextureDecodeException("BLP decoded to an empty or inconsistent bitmap.");
            }

            return new BgraImage(width, height, pixels);
        }
        catch (TextureDecodeException)
        {
            throw;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            throw new TextureDecodeException($"{ex.GetType().Name}: {ex.Message}", ex);
        }
    }
}
