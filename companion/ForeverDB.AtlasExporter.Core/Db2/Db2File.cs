using System.Buffers.Binary;
using System.Text;
using ForeverDB.AtlasExporter.Model;

namespace ForeverDB.AtlasExporter.Db2;

public sealed class Db2FormatException : Exception
{
    public Db2FormatException(string message) : base(message) { }
}

/// <summary>
/// Reader for the "WDC3"/"WDC4"/"WDC5" client database container used by current
/// World of Warcraft clients. Column names/types come from a WoWDBDefs layout
/// (the file itself carries none), selected by the file's LayoutHash.
///
/// Implemented from the public format documentation (wowdev.wiki). Supported:
/// uncompressed, bitpacked, signed-bitpacked, common-data, palette and palette-array
/// columns, ID lists, copy tables and relationship maps. Variable-length (offset-map)
/// tables and encrypted sections are reported, not guessed.
/// </summary>
public sealed class Db2File
{
    private const int FieldStorageInfoSize = 24;
    private const int SectionHeaderSize = 40;

    private readonly byte[] _data;
    private readonly List<Section> _sections = new();
    private readonly List<StorageInfo> _storage = new();
    private readonly List<uint[]?> _pallets = new();
    private readonly List<Dictionary<uint, uint>?> _common = new();

    private Db2File(byte[] data) => _data = data;

    public string Magic { get; private set; } = "";
    public uint TableHash { get; private set; }
    public uint LayoutHash { get; private set; }
    public string LayoutHashHex => LayoutHash.ToString("X8");
    public int RecordCount { get; private set; }
    public int RecordSize { get; private set; }
    public ushort Flags { get; private set; }
    public int IdIndex { get; private set; }
    public int FieldCount { get; private set; }
    public List<string> Warnings { get; } = new();

    private sealed record Section(
        ulong TactKeyHash, int FileOffset, int RecordCount, int StringTableSize,
        int OffsetRecordsEnd, int IdListSize, int RelationshipDataSize,
        int OffsetMapIdCount, int CopyTableCount);

    private sealed record StorageInfo(
        int OffsetBits, int SizeBits, int AdditionalDataSize, int Type,
        uint Data0, uint Data1, uint Data2);

    public static Db2File Parse(byte[] data)
    {
        if (data.Length < 8)
        {
            throw new Db2FormatException("File too small to be a DB2 container.");
        }

        var file = new Db2File(data);
        file.ParseHeader();
        return file;
    }

    private uint U32(int position)
    {
        RequireRange(position, 4);
        return BinaryPrimitives.ReadUInt32LittleEndian(_data.AsSpan(position));
    }

    private ushort U16(int position)
    {
        RequireRange(position, 2);
        return BinaryPrimitives.ReadUInt16LittleEndian(_data.AsSpan(position));
    }

    private void ParseHeader()
    {
        Magic = Encoding.ASCII.GetString(_data, 0, 4);

        if (Magic is not ("WDC3" or "WDC4" or "WDC5"))
        {
            throw new Db2FormatException(
                $"Unsupported DB2 container '{Magic}'. Supported: WDC3, WDC4, WDC5.");
        }

        var position = 4;

        if (Magic == "WDC5")
        {
            position += 4 + 128; // version + schema string
        }

        RecordCount = checked((int)U32(position)); position += 4;
        FieldCount = checked((int)U32(position)); position += 4;
        RecordSize = checked((int)U32(position)); position += 4;
        var stringTableSize = U32(position); position += 4;
        TableHash = U32(position); position += 4;
        LayoutHash = U32(position); position += 4;
        position += 4 + 4 + 4; // min_id, max_id, locale
        Flags = U16(position); position += 2;
        IdIndex = U16(position); position += 2;
        position += 4; // total_field_count
        position += 4; // bitpacked_data_offset
        position += 4; // lookup_column_count
        var storageInfoSize = checked((int)U32(position)); position += 4;
        var commonDataSize = checked((int)U32(position)); position += 4;
        var palletDataSize = checked((int)U32(position)); position += 4;
        var sectionCount = checked((int)U32(position)); position += 4;
        _ = stringTableSize;

        if ((Flags & 0x1) != 0)
        {
            throw new Db2FormatException(
                "Variable-length (offset-map) DB2 tables are not supported by the exporter.");
        }

        for (var i = 0; i < sectionCount; i++)
        {
            RequireRange(position, SectionHeaderSize);

            _sections.Add(new Section(
                BinaryPrimitives.ReadUInt64LittleEndian(_data.AsSpan(position, 8)),
                checked((int)U32(position + 8)),
                checked((int)U32(position + 12)),
                checked((int)U32(position + 16)),
                checked((int)U32(position + 20)),
                checked((int)U32(position + 24)),
                checked((int)U32(position + 28)),
                checked((int)U32(position + 32)),
                checked((int)U32(position + 36))));
            position += SectionHeaderSize;
        }

        position += FieldCount * 4; // field_structure[]

        var storageCount = storageInfoSize / FieldStorageInfoSize;
        RequireRange(position, storageInfoSize);

        for (var i = 0; i < storageCount; i++)
        {
            var at = position + i * FieldStorageInfoSize;
            _storage.Add(new StorageInfo(
                U16(at), U16(at + 2), checked((int)U32(at + 4)), checked((int)U32(at + 8)),
                U32(at + 12), U32(at + 16), U32(at + 20)));
        }

        position += storageInfoSize;

        var palletEnd = position + palletDataSize;
        RequireRange(position, palletDataSize);

        foreach (var info in _storage)
        {
            if (info.Type is 3 or 4)
            {
                var values = new uint[info.AdditionalDataSize / 4];

                for (var i = 0; i < values.Length; i++)
                {
                    values[i] = U32(position + i * 4);
                }

                position += info.AdditionalDataSize;
                _pallets.Add(values);
            }
            else
            {
                _pallets.Add(null);
            }
        }

        if (position != palletEnd)
        {
            throw new Db2FormatException("Palette block size does not match its declaration.");
        }

        RequireRange(position, commonDataSize);

        foreach (var info in _storage)
        {
            if (info.Type == 2)
            {
                var table = new Dictionary<uint, uint>(info.AdditionalDataSize / 8);

                for (var i = 0; i < info.AdditionalDataSize / 8; i++)
                {
                    table[U32(position + i * 8)] = U32(position + i * 8 + 4);
                }

                position += info.AdditionalDataSize;
                _common.Add(table);
            }
            else
            {
                _common.Add(null);
            }
        }
    }

    private void RequireRange(int position, int length)
    {
        if (position < 0 || length < 0 || (long)position + length > _data.Length)
        {
            throw new Db2FormatException("DB2 structure extends past the end of the file.");
        }
    }

    private static ulong ReadBits(ReadOnlySpan<byte> record, int bitOffset, int bitCount)
    {
        if (bitCount is < 0 or > 64 || bitOffset < 0 ||
            (bitOffset + bitCount + 7) / 8 > record.Length)
        {
            throw new Db2FormatException("Bit field lies outside its record.");
        }

        ulong value = 0;

        for (var bit = 0; bit < bitCount;)
        {
            var byteIndex = (bitOffset + bit) >> 3;
            var shift = (bitOffset + bit) & 7;
            var take = Math.Min(8 - shift, bitCount - bit);
            var chunk = (ulong)((record[byteIndex] >> shift) & ((1 << take) - 1));
            value |= chunk << bit;
            bit += take;
        }

        return value;
    }

    private static long SignExtend(ulong value, int bits) =>
        bits is <= 0 or >= 64
            ? (long)value
            : (long)(value << (64 - bits)) >> (64 - bits);

    private string ReadString(int absolutePosition)
    {
        if (absolutePosition < 0 || absolutePosition >= _data.Length)
        {
            throw new Db2FormatException("String offset lies outside the file.");
        }

        var end = Array.IndexOf(_data, (byte)0, absolutePosition);

        if (end < 0)
        {
            throw new Db2FormatException("Unterminated DB2 string.");
        }

        return Encoding.UTF8.GetString(_data, absolutePosition, end - absolutePosition);
    }

    /// <summary>Reads every row using the given definition.</summary>
    public TableData Read(string tableName, DbdVersionBlock layout)
    {
        var inline = layout.Fields.Where(field => !field.NonInline).ToList();

        if (inline.Count != _storage.Count)
        {
            throw new Db2FormatException(
                $"{tableName}: layout mismatch — definition has {inline.Count} stored columns, " +
                $"file has {_storage.Count}.");
        }

        var table = new TableData(tableName, layout.Fields.Select(field => field.Name).ToArray());
        var byId = new Dictionary<long, TableRow>();
        var rowsBySection = new List<List<(long Id, TableRow Row)>>();
        var idField = layout.Fields.FirstOrDefault(field => field.IsId);
        var relationField = layout.Fields.FirstOrDefault(field => field.IsRelation && field.NonInline);

        foreach (var section in _sections)
        {
            var sectionRows = new List<(long, TableRow)>();
            rowsBySection.Add(sectionRows);

            if (section.TactKeyHash != 0)
            {
                Warnings.Add(
                    $"{tableName}: encrypted section (key {section.TactKeyHash:X16}) skipped " +
                    $"({section.RecordCount} records unavailable).");
                continue;
            }

            var recordsStart = section.FileOffset;
            var recordsBytes = checked(section.RecordCount * RecordSize);
            var stringStart = recordsStart + recordsBytes;
            var idListStart = stringStart + section.StringTableSize;
            var copyStart = idListStart + section.IdListSize;
            var relationStart = copyStart + section.CopyTableCount * 8 + section.OffsetMapIdCount * 6;

            RequireRange(recordsStart, recordsBytes + section.StringTableSize + section.IdListSize);

            uint[]? idList = null;

            if (section.IdListSize > 0)
            {
                idList = new uint[section.IdListSize / 4];

                for (var i = 0; i < idList.Length; i++)
                {
                    idList[i] = U32(idListStart + i * 4);
                }
            }

            for (var index = 0; index < section.RecordCount; index++)
            {
                var recordPosition = recordsStart + index * RecordSize;
                var record = new byte[RecordSize];
                Buffer.BlockCopy(_data, recordPosition, record, 0, RecordSize);
                var row = new TableRow();
                long id = idList is not null ? idList[index] : -1;
                var storageIndex = 0;

                foreach (var field in layout.Fields)
                {
                    if (field.NonInline)
                    {
                        if (field.IsId && idList is not null)
                        {
                            row.Set(field.Name, (long)idList[index]);
                        }

                        continue;
                    }

                    var value = ReadField(
                        record, recordPosition, stringStart, storageIndex, field, id);
                    row.Set(field.Name, value);

                    if (field.IsId && id < 0 && value is long inlineId)
                    {
                        id = inlineId;
                    }

                    storageIndex++;
                }

                if (id < 0 && idField is null)
                {
                    id = index;
                }

                if (idList is not null && idField is not null && !row.Has(idField.Name))
                {
                    row.Set(idField.Name, id);
                }

                sectionRows.Add((id, row));
            }

            if (relationField is not null && section.RelationshipDataSize >= 12)
            {
                RequireRange(relationStart, section.RelationshipDataSize);
                var entries = checked((int)U32(relationStart));

                for (var i = 0; i < entries; i++)
                {
                    var foreign = U32(relationStart + 12 + i * 8);
                    var recordIndex = checked((int)U32(relationStart + 12 + i * 8 + 4));

                    if (recordIndex < sectionRows.Count)
                    {
                        sectionRows[recordIndex].Item2.Set(relationField.Name, (long)foreign);
                    }
                }
            }

            foreach (var (rowId, row) in sectionRows)
            {
                table.Rows.Add(row);

                if (rowId >= 0)
                {
                    byId[rowId] = row;
                }
            }

            for (var i = 0; i < section.CopyTableCount; i++)
            {
                var newId = U32(copyStart + i * 8);
                var sourceId = U32(copyStart + i * 8 + 4);

                if (byId.TryGetValue(sourceId, out var source))
                {
                    var copy = new TableRow();

                    foreach (var field in layout.Fields)
                    {
                        copy.Set(field.Name, source.Has(field.Name) ? ReadBack(source, field) : null);
                    }

                    if (idField is not null)
                    {
                        copy.Set(idField.Name, (long)newId);
                    }

                    table.Rows.Add(copy);
                    byId[newId] = copy;
                }
            }
        }

        return table;
    }

    private static object? ReadBack(TableRow row, DbdField field) =>
        field.ArrayLength > 1
            ? Enumerable.Range(0, field.ArrayLength)
                .Select(i => (object?)row.FloatAt(field.Name, i))
                .ToArray()
            : field.Type switch
            {
                DbdColumnType.String or DbdColumnType.LocString => row.Str(field.Name),
                DbdColumnType.Float => row.Float(field.Name),
                _ => row.Int(field.Name)
            };

    // Explicit boxing: a ?: chain of float/long/uint would silently unify to one numeric type.
    private static object Number(uint raw, DbdField field)
    {
        if (field.Type == DbdColumnType.Float)
        {
            return (double)BitConverter.UInt32BitsToSingle(raw);
        }

        return field.Signed ? (long)(int)raw : (long)raw;
    }

    private object? ReadField(
        byte[] record,
        int recordPosition,
        int stringStart,
        int storageIndex,
        DbdField field,
        long recordId)
    {
        var info = _storage[storageIndex];
        var length = Math.Max(1, field.ArrayLength);
        var isString = field.Type is DbdColumnType.String or DbdColumnType.LocString;

        object? Convert(ulong raw, int bits, int elementOffsetBits)
        {
            if (isString)
            {
                var relative = (long)SignExtend(raw, 32);
                var fieldBytePosition = recordPosition + ((info.OffsetBits + elementOffsetBits) >> 3);
                var position = fieldBytePosition + relative;

                if (position < stringStart || position >= _data.Length)
                {
                    throw new Db2FormatException(
                        $"String offset of column '{field.Name}' lies outside the string table.");
                }

                return ReadString(checked((int)position));
            }

            if (field.Type == DbdColumnType.Float)
            {
                return (double)BitConverter.UInt32BitsToSingle((uint)raw);
            }

            return field.Signed && bits < 64
                ? SignExtend(raw, bits)
                : (long)raw;
        }

        object?[] Many(Func<int, object?> element)
        {
            var values = new object?[length];

            for (var i = 0; i < length; i++)
            {
                values[i] = element(i);
            }

            return values;
        }

        switch (info.Type)
        {
            case 0: // uncompressed
            {
                var elementBits = isString
                    ? 32
                    : info.SizeBits >= length && info.SizeBits % length == 0
                        ? info.SizeBits / length
                        : field.Bits > 0 ? field.Bits : info.SizeBits;
                var read = (int index) =>
                    Convert(ReadBits(record, info.OffsetBits + index * elementBits, elementBits),
                        elementBits, index * elementBits);

                return length > 1 ? Many(read) : read(0);
            }

            case 1: // bitpacked
            case 5: // bitpacked, signed
            {
                var width = (int)info.Data1;

                if (length > 1)
                {
                    throw new Db2FormatException(
                        $"Bitpacked array column '{field.Name}' is not supported.");
                }

                var raw = ReadBits(record, info.OffsetBits, width);
                var value = info.Type == 5 ? (ulong)SignExtend(raw, width) : raw;

                if (isString)
                {
                    return Convert(raw, width, 0);
                }

                if (field.Type == DbdColumnType.Float)
                {
                    return (double)BitConverter.UInt32BitsToSingle((uint)raw);
                }

                return info.Type == 5 ? SignExtend(raw, width) : (long)value;
            }

            case 2: // common data
            {
                var table = _common[storageIndex]!;
                var raw = table.TryGetValue((uint)recordId, out var found) ? found : info.Data0;
                return Number(raw, field);
            }

            case 3: // palette
            {
                var index = (int)ReadBits(record, info.OffsetBits, (int)info.Data1);
                var pallet = _pallets[storageIndex]!;

                if (index >= pallet.Length)
                {
                    throw new Db2FormatException($"Palette index out of range in '{field.Name}'.");
                }

                return Number(pallet[index], field);
            }

            case 4: // palette array
            {
                var index = (int)ReadBits(record, info.OffsetBits, (int)info.Data1);
                var count = (int)info.Data2;
                var pallet = _pallets[storageIndex]!;

                if ((index + 1) * count > pallet.Length)
                {
                    throw new Db2FormatException($"Palette index out of range in '{field.Name}'.");
                }

                var values = new object?[count];

                for (var i = 0; i < count; i++)
                {
                    values[i] = Number(pallet[index * count + i], field);
                }

                return values;
            }

            default:
                throw new Db2FormatException(
                    $"Unsupported field storage type {info.Type} in '{field.Name}'.");
        }
    }
}
