using ForeverDB.AtlasExporter.Db2;
using ForeverDB.AtlasExporter.Metadata;
using ForeverDB.AtlasExporter.Model;

namespace Atlas.Exporter.Tests;

internal static class Db2Tests
{
    private const string Dbd = """
COLUMNS
locstring Name_lang
int ID
int Flags
int Delta
float Ratio
int CommonValue
int Pal
float UiMin
int PalArr
int<TestTable::ID> ParentID

LAYOUT DB51D55F
BUILD 1.60.1.69876
Name_lang
$id$ID<32>
Flags<u8>
Delta<8>
Ratio
CommonValue<32>
Pal<32>
UiMin[2]
PalArr<32>[2]
$noninline,relation$ParentID<32>

LAYOUT 00000001
BUILD 1.14.0.1-1.14.9.99999
$id$ID<32>
Name_lang

""";

    private static void PutBits(byte[] record, int bitOffset, int bits, ulong value)
    {
        for (var i = 0; i < bits; i++)
        {
            if ((value >> i & 1) == 1)
            {
                record[(bitOffset + i) >> 3] |= (byte)(1 << ((bitOffset + i) & 7));
            }
        }
    }

    private const int RecordSize = 24;

    private static byte[] Sample(ulong tactKey = 0)
    {
        var strings = new byte[] { 0, (byte)'A', (byte)'l', (byte)'p', (byte)'h', (byte)'a', 0, (byte)'B', (byte)'e', (byte)'t', (byte)'a', 0 };
        var offsets = new[] { 1, 7 };
        var ids = new uint[] { 10, 20 };
        var records = new List<byte[]>();

        for (var index = 0; index < 2; index++)
        {
            var record = new byte[RecordSize];
            var relative = 2 * RecordSize + offsets[index] - (index * RecordSize + 0);
            PutBits(record, 0, 32, (uint)relative);
            PutBits(record, 32, 32, ids[index]);
            PutBits(record, 64, 7, (ulong)(index == 0 ? 100 : 5));
            PutBits(record, 71, 6, (ulong)(index == 0 ? 0b111101 : 3));      // -3 / +3 signed 6 bit
            PutBits(record, 80, 32, BitConverter.SingleToUInt32Bits(index == 0 ? 1.5f : -2.25f));
            PutBits(record, 112, 3, (ulong)index);                           // palette index
            PutBits(record, 120, 32, BitConverter.SingleToUInt32Bits(0.25f * (index + 1)));
            PutBits(record, 152, 32, BitConverter.SingleToUInt32Bits(0.75f));
            PutBits(record, 184, 1, (ulong)index);                           // palette array index
            records.Add(record);
        }

        return new Wdc5Writer
        {
            TactKeyHash = tactKey,
            RecordSizeBytes = RecordSize,
            Records = records,
            StringTable = strings,
            IdList = null,
            Relationship = new List<(uint, uint)> { (500, 0), (600, 1) },
            CopyTable = new List<(uint, uint)> { (30, 10) },
            Columns = new List<Wdc5Writer.Column>
            {
                new(Wdc5Writer.Storage.None, 32, 0),
                new(Wdc5Writer.Storage.None, 32, 32),
                new(Wdc5Writer.Storage.Bitpacked, 7, 64, 0, 7),
                new(Wdc5Writer.Storage.BitpackedSigned, 6, 71, 0, 6),
                new(Wdc5Writer.Storage.None, 32, 80),
                new(Wdc5Writer.Storage.Common, 0, 0, 5, 0, 0, CommonValues: new Dictionary<uint, uint> { [20] = 99 }),
                new(Wdc5Writer.Storage.Palette, 3, 112, 0, 3, 0, Palette: new uint[] { 1000, 2000 }),
                new(Wdc5Writer.Storage.None, 64, 120),
                new(Wdc5Writer.Storage.PaletteArray, 1, 184, 0, 1, 2, Palette: new uint[] { 1, 2, 3, 4 })
            }
        }.Build();
    }

    public static void Register()
    {
        Harness.Add("db2: WDC5 rows decode across every storage type", () =>
        {
            var file = Db2File.Parse(Sample());
            Assert.Equal("WDC5", file.Magic);
            Assert.Equal("DB51D55F", file.LayoutHashHex);
            var layout = DbdFile.Parse("TestTable", Dbd).Select(file.LayoutHashHex, null)!;
            var table = file.Read("TestTable", layout);
            var rows = table.Rows.OrderBy(r => r.Int("ID")).ToList();
            Assert.Equal(3, rows.Count, "two records + one copy-table row");

            var first = rows[0];
            Assert.Equal(10L, first.Int("ID"));
            Assert.Equal("Alpha", first.Str("Name_lang"));
            Assert.Equal(100L, first.Int("Flags"));
            Assert.Equal(-3L, first.Int("Delta"));
            Assert.Equal(1.5, first.Float("Ratio"));
            Assert.Equal(5L, first.Int("CommonValue"), "common default");
            Assert.Equal(1000L, first.Int("Pal"));
            Assert.Equal(0.25, first.FloatAt("UiMin", 0));
            Assert.Equal(0.75, first.FloatAt("UiMin", 1));
            Assert.Equal(500L, first.Int("ParentID"), "relationship map");

            var second = rows[1];
            Assert.Equal("Beta", second.Str("Name_lang"));
            Assert.Equal(3L, second.Int("Delta"));
            Assert.Equal(-2.25, second.Float("Ratio"));
            Assert.Equal(99L, second.Int("CommonValue"), "common override for id 20");
            Assert.Equal(2000L, second.Int("Pal"));
            Assert.Equal(600L, second.Int("ParentID"));

            var copy = rows[2];
            Assert.Equal(30L, copy.Int("ID"));
            Assert.Equal("Alpha", copy.Str("Name_lang"), "copy table row duplicates its source");
        });

        Harness.Add("db2: a common-data column declared before the inline ID still resolves per record", () =>
        {
            var records = new List<byte[]>();

            foreach (var id in new uint[] { 10, 20 })
            {
                var record = new byte[4];
                PutBits(record, 0, 32, id);
                records.Add(record);
            }

            var bytes = new Wdc5Writer
            {
                RecordSizeBytes = 4,
                Records = records,
                Columns = new List<Wdc5Writer.Column>
                {
                    new(Wdc5Writer.Storage.Common, 0, 0, 7, 0, 0, CommonValues: new Dictionary<uint, uint> { [20] = 99 }),
                    new(Wdc5Writer.Storage.None, 32, 0)
                }
            }.Build();
            var dbd = DbdFile.Parse("T", "COLUMNS\nint V\nint ID\n\nLAYOUT DB51D55F\nV<32>\n$id$ID<32>\n\n");
            var table = Db2File.Parse(bytes).Read("T", dbd.Select("DB51D55F", null)!);
            Assert.Equal(7L, table.Rows.Single(r => r.Int("ID") == 10).Int("V"));
            Assert.Equal(99L, table.Rows.Single(r => r.Int("ID") == 20).Int("V"));
        });

        Harness.Add("db2: WDC3/WDC4 (no schema prefix) and a WDC5 magic without prefix both parse", () =>
        {
            foreach (var (magic, prefix) in new[] { ("WDC3", false), ("WDC4", false), ("WDC5", true), ("WDC5", false) })
            {
                var bytes = new Wdc5Writer
                {
                    Magic = magic, SchemaPrefix = prefix, RecordSizeBytes = 4,
                    Records = new List<byte[]> { BitConverter.GetBytes(77u) },
                    Columns = new List<Wdc5Writer.Column> { new(Wdc5Writer.Storage.None, 32, 0) }
                }.Build();
                var dbd = DbdFile.Parse("T", "COLUMNS\nint ID\n\nLAYOUT DB51D55F\n$id$ID<32>\n\n");
                var table = Db2File.Parse(bytes).Read("T", dbd.Select("DB51D55F", null)!);
                Assert.Equal(77L, table.Rows.Single().Int("ID"), $"{magic} prefix={prefix}");
            }
        });

        Harness.Add("db2: layout is chosen by LayoutHash first, build range second", () =>
        {
            var dbd = DbdFile.Parse("TestTable", Dbd);
            Assert.Equal(10, dbd.Select("DB51D55F", null)!.Fields.Count);
            Assert.Equal(2, dbd.Select("00000001", null)!.Fields.Count);
            Assert.Equal(2, dbd.Select("FFFFFFFF", new Version(1, 14, 5, 100))!.Fields.Count, "build fallback");
            Assert.True(dbd.Select("FFFFFFFF", new Version(9, 0, 0, 1)) is null, "unknown layout and build");
            Assert.True(dbd.Select("db51d55f", null) is not null, "hash comparison ignores case");
        });

        Harness.Add("db2: a definition with the wrong column count is refused, not misread", () =>
        {
            var file = Db2File.Parse(Sample());
            var wrong = DbdFile.Parse("TestTable", Dbd).Select("00000001", null)!;
            Assert.Throws<Db2FormatException>(() => file.Read("TestTable", wrong));
        });

        Harness.Add("db2: truncated, foreign and encrypted files are reported", () =>
        {
            Assert.Throws<Db2FormatException>(() => Db2File.Parse(new byte[] { 1, 2, 3 }));
            var wrongMagic = Sample();
            wrongMagic[0] = (byte)'X';
            Assert.Throws<Db2FormatException>(() => Db2File.Parse(wrongMagic));
            var truncated = Sample().Take(200).ToArray();
            Assert.Throws<Db2FormatException>(() => Db2File.Parse(truncated).Read(
                "TestTable", DbdFile.Parse("TestTable", Dbd).Select("DB51D55F", null)!));

            var encrypted = Db2File.Parse(Sample(tactKey: 0xAABBCCDD11223344));
            var table = encrypted.Read("TestTable", DbdFile.Parse("TestTable", Dbd).Select("DB51D55F", null)!);
            Assert.Equal(0, table.Rows.Count);
            Assert.Equal(1, encrypted.Warnings.Count, "encrypted section warning");
            Assert.Contains(encrypted.Warnings[0], "encrypted");
        });

        Harness.Add("db2: Db2TableSource reads bytes + definitions and reports a missing definition", async () =>
        {
            var bytes = Sample();
            var source = new Db2TableSource("t", _ => bytes, new Fixed(Dbd), null);
            var ok = await source.ReadAsync("TestTable", default);
            Assert.True(ok.Data is not null, ok.Error ?? "");
            var noDbd = new Db2TableSource("t", _ => bytes, new Fixed(null), null);
            var missing = await noDbd.ReadAsync("TestTable", default);
            Assert.True(missing.Data is null && missing.Error!.Contains(".dbd"), "needs definitions");
            var noFile = new Db2TableSource("t", _ => null, new Fixed(Dbd), null);
            Assert.True((await noFile.ReadAsync("TestTable", default)).Error!.Contains("not found"));
        });

        Harness.Add("db2: a file whose table hash is not the requested table is rejected", async () =>
        {
            var wrongTable = new Wdc5Writer
            {
                TableHash = 0xDEADBEEF, RecordSizeBytes = 4, Records = new List<byte[]> { new byte[4] },
                Columns = new List<Wdc5Writer.Column> { new(Wdc5Writer.Storage.None, 32, 0) }
            }.Build();
            var source = new Db2TableSource("t", _ => wrongTable, new Fixed(Dbd), null);
            var result = await source.ReadAsync("UiMap", default);
            Assert.True(result.Data is null && result.Error!.Contains("table hash"), result.Error ?? "");
        });

        Harness.Add("db2: client source falls back from name to the manifest FileDataID", () =>
        {
            using var assets = new NameMissAssets();
            var source = Db2TableSource.FromClient(assets, new Fixed(null), null);
            _ = source.ReadAsync("UiMap", default).GetAwaiter().GetResult();
            Assert.True(assets.NameTried && assets.IdTried == ForeverDB.AtlasExporter.Db2.KnownTables.FileDataIds["UiMap"]);
        });

        Harness.Add("dbd: parser handles annotations, arrays, comments and build ranges", () =>
        {
            var dbd = DbdFile.Parse("UiMapAssignment", """
COLUMNS
float UiMin
int<UiMap::ID> UiMapID // note

LAYOUT C9CC8DFB, AA
BUILD 11.0.0.1, 11.0.1.1-11.0.2.5
COMMENT something
UiMin[2]
$id$ID<32>
$relation$UiMapID<u16> // trailing

""");
            var block = dbd.Blocks.Single();
            Assert.Equal(2, block.LayoutHashes.Count);
            Assert.True(block.Covers(new Version(11, 0, 1, 500)));
            Assert.False(block.Covers(new Version(11, 0, 3, 1)));
            Assert.Equal(2, block.Fields[0].ArrayLength);
            Assert.True(block.Fields[1].IsId);
            Assert.True(block.Fields[2].IsRelation && !block.Fields[2].Signed && block.Fields[2].Bits == 16);
        });

        Harness.Add("metadata: CSV with quoted commas and array columns feeds the typed model", async () =>
        {
            using var dir = new TempDir();
            var text = World.CsvFor(World.Standard(dir.Combine("w")), new Dictionary<int, string> { [1420] = "Tirisfal, Glades (quoted)" });

            foreach (var (name, csv) in text)
            {
                File.WriteAllText(dir.Combine(name + ".csv"), csv);
            }

            var load = await MapDatabaseBuilder.LoadAsync(
                new IMapTableSource[]
                {
                    new Db2TableSource("db2", _ => null, new Fixed(Dbd), null),
                    new CsvDirectoryTableSource(dir.Path)
                }, default);
            Assert.True(load.Database is not null, "csv fallback must succeed");
            Assert.Equal(2, load.Attempts.Count);
            Assert.False(load.Attempts[0].Succeeded);
            Assert.True(load.Attempts[1].Succeeded);
            Assert.Equal("csv-dir", load.Database!.MetadataSource);
            Assert.True(load.Database.UiMaps.Any(m => m.Name == "Tirisfal, Glades (quoted)"), "quoted comma preserved");
            Assert.Equal(1.0, load.Database.Assignments.First().UiMax[0]);
        });

        Harness.Add("metadata: structurally wrong tables are rejected with a reason", async () =>
        {
            var empty = new TableData("UiMap", new[] { "ID", "Name_lang", "ParentUiMapID", "Flags", "System", "Type" });
            var bad = new Dictionary<string, TableData> { ["UiMap"] = empty };
            Assert.Throws<MetadataException>(() => MapDatabaseBuilder.Build(bad, new Dictionary<string, string>()));

            var row = new TableRow();
            foreach (var (c, v) in new (string, object)[] { ("ID", 1L), ("Name_lang", "x"), ("ParentUiMapID", 0L), ("Flags", 0L), ("System", 0L), ("Type", 99L) })
            {
                row.Set(c, v);
            }

            var wrongType = new TableData("UiMap", new[] { "ID", "Name_lang", "ParentUiMapID", "Flags", "System", "Type" });
            wrongType.Rows.Add(row);
            var tables = new Dictionary<string, TableData>
            {
                ["UiMap"] = wrongType,
                ["UiMapXMapArt"] = Tiny("UiMapXMapArt", "UiMapID", "UiMapArtID", "PhaseID"),
                ["UiMapArt"] = Tiny("UiMapArt", "ID", "UiMapArtStyleID"),
                ["UiMapArtStyleLayer"] = Tiny("UiMapArtStyleLayer", "UiMapArtStyleID", "LayerIndex", "LayerWidth", "LayerHeight", "TileWidth", "TileHeight"),
                ["UiMapArtTile"] = Tiny("UiMapArtTile", "UiMapArtID", "LayerIndex", "RowIndex", "ColIndex", "FileDataID")
            };
            var ex = ThrowsMessage(() => MapDatabaseBuilder.Build(tables, new Dictionary<string, string>()));
            Assert.Contains(ex, "outside 0-6");
            await Task.CompletedTask;
        });
    }

    private static TableData Tiny(string name, params string[] columns)
    {
        var table = new TableData(name, columns);
        var row = new TableRow();

        foreach (var column in columns)
        {
            row.Set(column, 1L);
        }

        table.Rows.Add(row);
        return table;
    }

    private static string ThrowsMessage(Action action)
    {
        try
        {
            action();
        }
        catch (MetadataException ex)
        {
            return ex.Message;
        }

        throw new AssertException("expected MetadataException");
    }

    private sealed class NameMissAssets : ForeverDB.AtlasExporter.Client.IAssetSource
    {
        public bool NameTried { get; private set; }
        public int IdTried { get; private set; }
        public string Label => "x";
        public byte[]? ReadByName(string path) { NameTried = path.EndsWith("UiMap.db2"); return null; }
        public byte[]? ReadByFileDataId(int id) { IdTried = id; return null; }
        public void Dispose() { }
    }

    private sealed class Fixed : IDbdSource
    {
        private readonly string? _text;
        public Fixed(string? text) => _text = text;
        public string Label => "fixed";
        public Task<string?> GetAsync(string table, CancellationToken cancellationToken) => Task.FromResult(_text);
    }
}
