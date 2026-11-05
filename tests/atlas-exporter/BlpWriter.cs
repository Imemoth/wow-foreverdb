using System.Text;

namespace Atlas.Exporter.Tests;

/// <summary>Writes small palettised BLP2 textures (the decoder under test reads real client BLPs).</summary>
internal static class BlpWriter
{
    /// <summary>
    /// Solid color tile; pixel (0,0) is white to expose orientation mistakes.
    /// Alpha is applied to every pixel.
    /// </summary>
    public static byte[] Tile(int width, int height, byte r, byte g, byte b, byte alpha = 255)
    {
        var palette = new uint[256];
        palette[0] = Pack(b, g, r);
        palette[1] = Pack(255, 255, 255);

        var indices = new byte[width * height];
        indices[0] = 1;
        return Build(width, height, palette, indices, Enumerable.Repeat(alpha, width * height).ToArray());
    }

    private static uint Pack(byte b, byte g, byte r) => (uint)(b | g << 8 | r << 16 | 0xFF << 24);

    private static byte[] Build(int width, int height, uint[] palette, byte[] indices, byte[] alpha)
    {
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, Encoding.ASCII);
        writer.Write(Encoding.ASCII.GetBytes("BLP2"));
        writer.Write(1u);          // type
        writer.Write((byte)1);     // encoding: palette
        writer.Write((byte)8);     // alpha depth
        writer.Write((byte)0);     // alpha type
        writer.Write((byte)0);     // has mips
        writer.Write((uint)width);
        writer.Write((uint)height);

        const int headerSize = 4 + 4 + 4 + 4 + 4 + 64 + 64 + 1024;
        var size = indices.Length + alpha.Length;

        for (var i = 0; i < 16; i++)
        {
            writer.Write(i == 0 ? (uint)headerSize : 0u);
        }

        for (var i = 0; i < 16; i++)
        {
            writer.Write(i == 0 ? (uint)size : 0u);
        }

        foreach (var color in palette)
        {
            writer.Write(color);
        }

        writer.Write(indices);
        writer.Write(alpha);
        return stream.ToArray();
    }
}
