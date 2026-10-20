using ForeverDB.AtlasExporter.Model;

namespace ForeverDB.AtlasExporter.Client;

/// <summary>
/// Reads Blizzard's pipe-separated <c>.build.info</c>
/// (header cells look like <c>Product!STRING:0</c>).
/// </summary>
public static class BuildInfo
{
    public static IReadOnlyList<BuildInfoEntry> Parse(IEnumerable<string> lines)
    {
        var all = lines
            .Select(line => line.TrimEnd('\r'))
            .Where(line => line.Length > 0)
            .ToArray();

        if (all.Length < 2)
        {
            return Array.Empty<BuildInfoEntry>();
        }

        var headers = all[0]
            .Split('|')
            .Select(header => header.Split('!')[0].Trim())
            .ToArray();

        int Index(string name) => Array.FindIndex(
            headers, header => header.Equals(name, StringComparison.OrdinalIgnoreCase));

        var product = Index("Product");
        var version = Index("Version");
        var branch = Index("Branch");
        var buildKey = Index("Build Key");
        var cdnKey = Index("CDN Key");
        var tags = Index("Tags");
        var active = Index("Active");

        if (product < 0 || version < 0 || buildKey < 0)
        {
            return Array.Empty<BuildInfoEntry>();
        }

        string Cell(string[] fields, int index) =>
            index >= 0 && index < fields.Length ? fields[index].Trim() : "";

        var entries = new List<BuildInfoEntry>();

        foreach (var line in all.Skip(1))
        {
            var fields = line.Split('|');
            var productName = Cell(fields, product);

            if (productName.Length == 0)
            {
                continue;
            }

            entries.Add(new BuildInfoEntry(
                productName,
                Cell(fields, version),
                Cell(fields, branch),
                Cell(fields, buildKey),
                Cell(fields, cdnKey),
                Cell(fields, tags),
                Cell(fields, active) == "1"));
        }

        return entries;
    }

    public static IReadOnlyList<BuildInfoEntry> ReadFile(string path)
    {
        try
        {
            return Parse(File.ReadAllLines(path));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Array.Empty<BuildInfoEntry>();
        }
    }
}
