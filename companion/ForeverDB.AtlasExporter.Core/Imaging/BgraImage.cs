namespace ForeverDB.AtlasExporter.Imaging;

/// <summary>Decoded pixels, 8-bit BGRA, non-premultiplied, top-left origin.</summary>
public sealed class BgraImage
{
    public BgraImage(int width, int height, byte[] pixels)
    {
        if (width <= 0 || height <= 0 || pixels.LongLength != (long)width * height * 4)
        {
            throw new ArgumentException("Pixel buffer does not match the stated dimensions.");
        }

        Width = width;
        Height = height;
        Pixels = pixels;
    }

    public int Width { get; }
    public int Height { get; }
    public byte[] Pixels { get; }

    public static BgraImage Blank(int width, int height) =>
        new(width, height, new byte[checked(width * height * 4)]);

    public long ByteSize => Pixels.LongLength;
}
