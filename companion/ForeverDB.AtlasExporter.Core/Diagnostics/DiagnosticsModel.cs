using System.Text;
using ForeverDB.AtlasExporter.Export;

namespace ForeverDB.AtlasExporter.Diagnostics;

public sealed record AssetProbeResult(bool Found, long Size, int ErrorCode, string ErrorMeaning, string Source);

/// <summary>Optional low-level storage probe (Windows CASC) that can say *why* a file did not open.</summary>
public interface IAssetProbe
{
    AssetProbeResult ProbeFileDataId(int fileDataId);
    AssetProbeResult ProbeName(string path);
}

/// <summary>
/// A diagnostic result that renders both as readable text and as structured JSON from the same
/// content. Every string goes through the <see cref="Sanitizer"/> so no local paths or account names
/// leave the machine.
/// </summary>
public sealed class DiagnosticsDocument
{
    private readonly Sanitizer _sanitizer;
    private readonly StringBuilder _text = new();
    private readonly Dictionary<string, object?> _data = new(StringComparer.Ordinal);

    public DiagnosticsDocument(string title, Sanitizer sanitizer)
    {
        Title = title;
        _sanitizer = sanitizer;
        _text.Append(title).Append('\n').Append(new string('=', title.Length)).Append("\n\n");
    }

    public string Title { get; }

    public string Clean(string? value) => _sanitizer.Clean(value);

    public DiagnosticsDocument Heading(string heading)
    {
        _text.Append('\n').Append(heading).Append('\n').Append(new string('-', heading.Length)).Append('\n');
        return this;
    }

    public DiagnosticsDocument Line(string line)
    {
        _text.Append(_sanitizer.Clean(line)).Append('\n');
        return this;
    }

    public DiagnosticsDocument Data(string key, object? value)
    {
        _data[key] = value;
        return this;
    }

    public string ToText() => _text.ToString();

    public string ToJson() => JsonOut.Serialize(new { Title, Data = _data });

    public void WriteTo(string directory, string baseName)
    {
        JsonOut.WriteAtomic(Path.Combine(directory, baseName + ".txt"), ToText());
        JsonOut.WriteAtomic(Path.Combine(directory, baseName + ".json"), ToJson());
    }
}
