using System.Text.Json;
using System.Text.Json.Serialization;

namespace ForeverDB.AtlasExporter.Export;

/// <summary>Stable JSON: camelCase, LF newlines, nulls omitted - so equal data gives equal bytes.</summary>
public static class JsonOut
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DictionaryKeyPolicy = null,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static string Serialize<T>(T value) =>
        JsonSerializer.Serialize(value, Options).Replace("\r\n", "\n") + "\n";

    public static T? Deserialize<T>(string json) =>
        JsonSerializer.Deserialize<T>(json, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        });

    public static void WriteAtomic(string path, string text) =>
        WriteAtomic(path, new System.Text.UTF8Encoding(false).GetBytes(text));

    public static void WriteAtomic(string path, byte[] bytes)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tmp";
        File.WriteAllBytes(temporary, bytes);
        File.Move(temporary, path, overwrite: true);
    }
}
