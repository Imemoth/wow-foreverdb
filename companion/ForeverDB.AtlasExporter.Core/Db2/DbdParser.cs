using System.Globalization;
using System.Text.RegularExpressions;

namespace ForeverDB.AtlasExporter.Db2;

public enum DbdColumnType
{
    Int,
    Float,
    String,
    LocString
}

public sealed record DbdField(
    string Name,
    DbdColumnType Type,
    bool Signed,
    int Bits,
    int ArrayLength,
    bool IsId,
    bool IsRelation,
    bool NonInline);

public sealed class DbdVersionBlock
{
    public List<string> LayoutHashes { get; } = new();
    public List<(Version From, Version To)> Builds { get; } = new();
    public List<DbdField> Fields { get; } = new();

    public bool Covers(Version build) =>
        Builds.Any(range => build >= range.From && build <= range.To);

    public bool HasLayout(string hash) =>
        LayoutHashes.Contains(hash, StringComparer.OrdinalIgnoreCase);
}

/// <summary>
/// Parser for WoWDBDefs <c>.dbd</c> files (community column definitions, CC BY-SA 4.0,
/// https://github.com/wowdev/WoWDBDefs). The definitions are fetched at run time and
/// cached outside the repository; they are not redistributed with the exporter.
/// </summary>
public sealed class DbdFile
{
    private static readonly Regex FieldLine = new(
        @"^(?:\$(?<ann>[a-z,]+)\$)?(?<name>[A-Za-z0-9_]+)\??(?:<(?<u>u)?(?<bits>\d+)>)?(?:\[(?<len>\d+)\])?\s*(?://.*)?$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex ColumnLine = new(
        @"^(?<type>int|uint|float|string|locstring)(?:<[^>]*>)?\s+(?<name>[A-Za-z0-9_]+)\??\s*(?://.*)?$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public string Table { get; }
    public IReadOnlyList<DbdVersionBlock> Blocks => _blocks;
    private readonly List<DbdVersionBlock> _blocks = new();
    private readonly Dictionary<string, DbdColumnType> _columns =
        new(StringComparer.OrdinalIgnoreCase);

    private DbdFile(string table) => Table = table;

    public static DbdFile Parse(string table, string text)
    {
        var file = new DbdFile(table);
        var section = "";
        DbdVersionBlock? block = null;
        var blockHasFields = false;

        foreach (var rawLine in text.Split('\n'))
        {
            var line = rawLine.Trim();

            if (line.Length == 0)
            {
                if (section == "block" && blockHasFields)
                {
                    block = null;
                    blockHasFields = false;
                    section = "";
                }

                continue;
            }

            if (line == "COLUMNS")
            {
                section = "columns";
                continue;
            }

            if (line.StartsWith("COMMENT ", StringComparison.Ordinal))
            {
                continue;
            }

            if (line.StartsWith("LAYOUT ", StringComparison.Ordinal))
            {
                if (block is null || blockHasFields)
                {
                    block = new DbdVersionBlock();
                    file._blocks.Add(block);
                    blockHasFields = false;
                }

                section = "block";
                block.LayoutHashes.AddRange(
                    line[7..].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
                continue;
            }

            if (line.StartsWith("BUILD ", StringComparison.Ordinal))
            {
                if (block is null || blockHasFields)
                {
                    block = new DbdVersionBlock();
                    file._blocks.Add(block);
                    blockHasFields = false;
                }

                section = "block";

                foreach (var token in line[6..].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                {
                    var parts = token.Split('-', 2);

                    if (Version.TryParse(parts[0], out var from) &&
                        (parts.Length == 1
                            ? true
                            : Version.TryParse(parts[1], out _)))
                    {
                        var to = parts.Length == 1
                            ? from
                            : Version.Parse(parts[1]);
                        block.Builds.Add((from, to));
                    }
                }

                continue;
            }

            if (section == "columns")
            {
                var column = ColumnLine.Match(line);

                if (column.Success)
                {
                    var type = column.Groups["type"].Value switch
                    {
                        "float" => DbdColumnType.Float,
                        "string" => DbdColumnType.String,
                        "locstring" => DbdColumnType.LocString,
                        _ => DbdColumnType.Int
                    };
                    file._columns[column.Groups["name"].Value] = type;
                }

                continue;
            }

            if (section == "block" && block is not null)
            {
                var match = FieldLine.Match(line);

                if (!match.Success)
                {
                    throw new InvalidDataException(
                        $"Unrecognised field line in {table}.dbd: '{line}'");
                }

                var name = match.Groups["name"].Value;
                var annotations = match.Groups["ann"].Value.Split(',', StringSplitOptions.RemoveEmptyEntries);
                var type = file._columns.TryGetValue(name, out var known)
                    ? known
                    : DbdColumnType.Int;
                var bits = match.Groups["bits"].Success
                    ? int.Parse(match.Groups["bits"].Value, CultureInfo.InvariantCulture)
                    : 0;
                var length = match.Groups["len"].Success
                    ? int.Parse(match.Groups["len"].Value, CultureInfo.InvariantCulture)
                    : 1;

                block.Fields.Add(new DbdField(
                    name,
                    type,
                    Signed: !match.Groups["u"].Success,
                    Bits: bits,
                    ArrayLength: length,
                    IsId: annotations.Contains("id"),
                    IsRelation: annotations.Contains("relation"),
                    NonInline: annotations.Contains("noninline")));
                blockHasFields = true;
            }
        }

        return file;
    }

    /// <summary>Layout hash is authoritative; the build range is the fallback.</summary>
    public DbdVersionBlock? Select(string layoutHash, Version? build)
    {
        var byHash = _blocks.FirstOrDefault(candidate => candidate.HasLayout(layoutHash));

        if (byHash is not null)
        {
            return byHash;
        }

        return build is null
            ? null
            : _blocks.FirstOrDefault(candidate => candidate.Covers(build));
    }
}
