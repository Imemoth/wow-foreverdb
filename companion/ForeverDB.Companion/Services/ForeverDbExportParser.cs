using System.Text.RegularExpressions;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public sealed class ForeverDbExportParser
{
    private static readonly Regex ExportRegex = new(
        "ForeverDB_Export\\s*=\\s*\"((?:\\\\.|[^\"])*)\"",
        RegexOptions.Singleline | RegexOptions.Compiled);

    public ForeverDbSnapshot ParseSavedVariables(string path)
    {
        var raw = File.ReadAllText(path);
        var match = ExportRegex.Match(raw);

        if (!match.Success)
        {
            throw new InvalidOperationException(
                $"ForeverDB_Export not found in {path}");
        }

        return ParseExport(DecodeLuaString(match.Groups[1].Value));
    }

    public ForeverDbSnapshot ParseExport(string exportText)
    {
        var lines = exportText
            .Split(
                new[] { "\r\n", "\n" },
                StringSplitOptions.RemoveEmptyEntries);

        if (lines.Length == 0)
        {
            throw new InvalidOperationException("ForeverDB export is empty.");
        }

        var header = lines[0].Split('|');

        if (header.Length < 5 || header[0] != "H")
        {
            throw new InvalidOperationException(
                "Unsupported ForeverDB export header.");
        }

        var snapshot = new ForeverDbSnapshot
        {
            SchemaVersion = int.Parse(header[1]),
            AddonVersion = header[2],
            InstallationId = header[3],
            UpdatedAt = long.Parse(header[4])
        };

        if (snapshot.SchemaVersion < 7)
        {
            throw new InvalidOperationException(
                $"ForeverDB schema {snapshot.SchemaVersion} is too old.");
        }

        var sourceMap = new Dictionary<string, ForeverDbSource>();
        var bucketMap = new Dictionary<string, ForeverDbBucket>();

        foreach (var line in lines.Skip(1))
        {
            var parts = line.Split('|');

            switch (parts[0])
            {
                case "S":
                {
                    var key = Key(
                        parts[1],
                        long.Parse(parts[2]),
                        int.Parse(parts[3]));

                    var source = new ForeverDbSource
                    {
                        SourceType = parts[1],
                        SourceId = long.Parse(parts[2]),
                        SourceLevel = int.Parse(parts[3]),
                        Name = DecodeField(parts[4])
                    };

                    sourceMap[key] = source;
                    snapshot.Sources.Add(source);
                    break;
                }

                case "B":
                {
                    var sourceKey = Key(
                        parts[1],
                        long.Parse(parts[2]),
                        int.Parse(parts[3]));

                    var source = sourceMap[sourceKey];
                    var bucket = new ForeverDbBucket
                    {
                        Kind = parts[4],
                        Observations = long.Parse(parts[5])
                    };

                    source.Buckets.Add(bucket);
                    bucketMap[$"{sourceKey}|{parts[4]}"] = bucket;
                    break;
                }

                case "L":
                {
                    var bucketKey =
                        $"{Key(parts[1], long.Parse(parts[2]), int.Parse(parts[3]))}|{parts[4]}";

                    bucketMap[bucketKey].Locations.Add(
                        new ForeverDbLocation
                        {
                            MapId = long.Parse(parts[5]),
                            ZoneName = DecodeField(parts[6]),
                            SubZoneName = DecodeField(parts[7]),
                            X = parts[8],
                            Y = parts[9],
                            Observations = long.Parse(parts[10])
                        });

                    break;
                }

                case "I":
                {
                    var bucketKey =
                        $"{Key(parts[1], long.Parse(parts[2]), int.Parse(parts[3]))}|{parts[4]}";

                    bucketMap[bucketKey].Items.Add(
                        new ForeverDbItem
                        {
                            ItemId = long.Parse(parts[5]),
                            Name = DecodeField(parts[6]),
                            Drops = long.Parse(parts[7]),
                            Quantity = long.Parse(parts[8]),
                            QuestDrops = long.Parse(parts[9]),
                            QuestIds = ParseQuestIds(DecodeField(parts[10]))
                        });

                    break;
                }
            }
        }

        return snapshot;
    }

    private static string Key(
        string type,
        long id,
        int level)
        => $"{type}|{id}|{level}";

    private static string DecodeLuaString(string value)
        => value
            .Replace("\\n", "\n")
            .Replace("\\r", "\r")
            .Replace("\\t", "\t")
            .Replace("\\\"", "\"")
            .Replace("\\\\", "\\");

    private static string DecodeField(string value)
        => Uri.UnescapeDataString(value);

    private static List<long> ParseQuestIds(string csv)
        => csv
            .Split(
                ',',
                StringSplitOptions.RemoveEmptyEntries)
            .Select(long.Parse)
            .ToList();
}
