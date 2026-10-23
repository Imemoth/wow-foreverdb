namespace ForeverDB.AtlasExporter.Export;

/// <summary>Removes local paths and account names from anything that ends up in the delivery ZIP.</summary>
public sealed class Sanitizer
{
    private readonly List<(string Needle, string Replacement)> _rules = new();

    public Sanitizer(IEnumerable<string> redactions)
    {
        var rules = redactions.Where(value => !string.IsNullOrWhiteSpace(value) && value.Length >= 3)
            .SelectMany(value => new[] { value, value.Replace('\\', '/') })
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderByDescending(value => value.Length);

        foreach (var needle in rules)
        {
            _rules.Add((needle, "<redacted>"));
        }
    }

    public static IReadOnlyList<string> DefaultRedactions(IEnumerable<string?> extraPaths)
    {
        var values = new List<string?>
        {
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            Environment.UserName,
            Environment.MachineName
        };
        values.AddRange(extraPaths);
        return values.Where(value => !string.IsNullOrWhiteSpace(value)).Select(value => value!).ToArray();
    }

    public string Clean(string? text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return text ?? "";
        }

        var result = text;

        foreach (var (needle, replacement) in _rules)
        {
            result = result.Replace(needle, replacement, StringComparison.OrdinalIgnoreCase);
        }

        return result;
    }
}
