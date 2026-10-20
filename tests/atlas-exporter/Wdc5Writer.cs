using System.Text;

namespace Atlas.Exporter.Tests;

/// <summary>
/// Builds minimal WDC5 files for the reader tests. Layout is written from the public
/// format documentation, so these tests prove self-consistency with that documentation,
/// not conformance with a real client file.
/// </summary>
internal sealed class Wdc5Writer
{
    public enum Storage { None = 0, Bitpacked = 1, Common = 2, Palette = 3, PaletteArray = 4, BitpackedSigned = 5 }

    public sealed record Column(
        Storage Type, int SizeBits, int OffsetBits, uint Data0 = 0, uint Data1 = 0, uint Data2 = 0,
        uint[]? Palette = null, Dictionary<uint, uint>? CommonValues = null);

    public uint LayoutHash { get; init; } = 0xDB51D55F;
    public uint TableHash { get; init; } = 0x11223344;
    public required List<Column> Columns { get; init; }
    public required int RecordSizeBytes { get; init; }
    public required List<byte[]> Records { get; init; }
    public List<uint>? IdList { get; init; }
    public List<(uint NewId, uint SourceId)> CopyTable { get; init; } = new();
    public List<(uint ForeignId, uint RecordIndex)> Relationship { get; init; } = new();
    public byte[] StringTable { get; init; } = new byte[] { 0 };
    public ulong TactKeyHash { get; init; }
    public string Magic { get; init; } = "WDC5";
    public bool SchemaPrefix { get; init; } = true;
    public bool OmitSection { get; init; }

    public byte[] Build()
    {
        var infos = new MemoryStream();
        var palletBlock = new MemoryStream();
        var commonBlock = new MemoryStream();

        foreach (var column in Columns)
        {
            var additional = 0;

            if (column.Type is Storage.Palette or Storage.PaletteArray)
            {
                foreach (var value in column.Palette!)
                {
                    palletBlock.Write(BitConverter.GetBytes(value));
                }

                additional = column.Palette!.Length * 4;
            }
            else if (column.Type == Storage.Common)
            {
                foreach (var (id, value) in column.CommonValues!)
                {
                    commonBlock.Write(BitConverter.GetBytes(id));
                    commonBlock.Write(BitConverter.GetBytes(value));
                }

                additional = column.CommonValues!.Count * 8;
            }

            infos.Write(BitConverter.GetBytes((ushort)column.OffsetBits));
            infos.Write(BitConverter.GetBytes((ushort)column.SizeBits));
            infos.Write(BitConverter.GetBytes(additional));
            infos.Write(BitConverter.GetBytes((int)column.Type));
            infos.Write(BitConverter.GetBytes(column.Data0));
            infos.Write(BitConverter.GetBytes(column.Data1));
            infos.Write(BitConverter.GetBytes(column.Data2));
        }

        var records = new MemoryStream();

        foreach (var record in Records)
        {
            records.Write(record, 0, RecordSizeBytes);
        }

        var idList = new MemoryStream();

        foreach (var id in IdList ?? new List<uint>())
        {
            idList.Write(BitConverter.GetBytes(id));
        }

        var copy = new MemoryStream();

        foreach (var (newId, sourceId) in CopyTable)
        {
            copy.Write(BitConverter.GetBytes(newId));
            copy.Write(BitConverter.GetBytes(sourceId));
        }

        var relationship = new MemoryStream();

        if (Relationship.Count > 0)
        {
            relationship.Write(BitConverter.GetBytes((uint)Relationship.Count));
            relationship.Write(BitConverter.GetBytes(Relationship.Min(r => r.ForeignId)));
            relationship.Write(BitConverter.GetBytes(Relationship.Max(r => r.ForeignId)));

            foreach (var (foreign, index) in Relationship)
            {
                relationship.Write(BitConverter.GetBytes(foreign));
                relationship.Write(BitConverter.GetBytes(index));
            }
        }

        var headerSize = 4 + (SchemaPrefix ? 4 + 128 : 0) + 4 * 6 + 4 * 3 + 2 + 2 + 4 * 7 + 40; // up to and including one section header
        var fixedPart = headerSize - (OmitSection ? 40 : 0) + Columns.Count * 4 + (int)infos.Length + (int)palletBlock.Length + (int)commonBlock.Length;

        using var file = new MemoryStream();
        using var w = new BinaryWriter(file, Encoding.ASCII);
        w.Write(Encoding.ASCII.GetBytes(Magic));

        if (SchemaPrefix)
        {
            w.Write(5u);
            w.Write(new byte[128]);
        }

        w.Write((uint)Records.Count);
        w.Write((uint)Columns.Count);
        w.Write((uint)RecordSizeBytes);
        w.Write((uint)StringTable.Length);
        w.Write(TableHash);
        w.Write(LayoutHash);
        w.Write(0u); w.Write(0u); w.Write(0u);                  // min id, max id, locale
        w.Write((ushort)0);                                      // flags
        w.Write((ushort)(IdList is null ? 0 : 0));               // id index
        w.Write((uint)Columns.Count);                            // total fields
        w.Write(0u);                                             // bitpacked offset
        w.Write(0u);                                             // lookup columns
        w.Write((uint)infos.Length);
        w.Write((uint)commonBlock.Length);
        w.Write((uint)palletBlock.Length);
        w.Write(OmitSection ? 0u : 1u);                          // sections

        if (!OmitSection)
        {
            w.Write(TactKeyHash);
            w.Write((uint)fixedPart);                            // file offset
            w.Write((uint)Records.Count);
            w.Write((uint)StringTable.Length);
            w.Write(0u);                                         // offset records end
            w.Write((uint)idList.Length);
            w.Write((uint)relationship.Length);
            w.Write(0u);                                         // offset map id count
            w.Write((uint)CopyTable.Count);
        }

        for (var i = 0; i < Columns.Count; i++)
        {
            w.Write((short)0);
            w.Write((ushort)0);
        }

        w.Write(infos.ToArray());
        w.Write(palletBlock.ToArray());
        w.Write(commonBlock.ToArray());
        w.Write(records.ToArray());
        w.Write(StringTable);
        w.Write(idList.ToArray());
        w.Write(copy.ToArray());
        w.Write(relationship.ToArray());
        return file.ToArray();
    }
}
