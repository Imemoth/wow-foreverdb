using ForeverDB.AtlasExporter.Client;
using ForeverDB.Companion.Services;

namespace ForeverDB.AtlasExporter.Cli;

/// <summary>
/// IAssetSource over the Companion's proven NativeCascMapReader (CascLib P/Invoke,
/// FileDataID + name open, exact-build CDN open). Read-only: nothing in the game
/// folder is modified.
/// </summary>
internal sealed class CascAssetSource : IAssetSource
{
    private readonly NativeCascMapReader _reader;

    private CascAssetSource(NativeCascMapReader reader) => _reader = reader;

    public string Label => _reader.Label;

    public static CascAssetSource? OpenLocal(string cascRoot, string product, string? branchDirectory)
    {
        var candidates = new List<(string Path, string Label)>
        {
            ($"{cascRoot}*{product}", $"local:{product}")
        };

        // A branch folder is accepted only when it belongs to the selected product,
        // so a different installed product can never be read by accident.
        if (branchDirectory is not null &&
            string.Equals(
                Client.ClientLocator.ProductForBranchFolder(Path.GetFileName(branchDirectory)),
                product, StringComparison.OrdinalIgnoreCase))
        {
            candidates.Add((branchDirectory, $"local:{product}:branch"));
        }

        var reader = NativeCascMapReader.TryOpen(candidates);
        return reader is null ? null : new CascAssetSource(reader);
    }

    public static CascAssetSource? OpenOnline(
        string cachePath, string product, string region, string buildKey, out int errorCode)
    {
        var reader = NativeCascMapReader.TryOpenOnline(
            cachePath, product, region, buildKey, $"cdn:{product}:{region}", out errorCode);
        return reader is null ? null : new CascAssetSource(reader);
    }

    public byte[]? ReadByFileDataId(int fileDataId)
    {
        using var stream = _reader.OpenByFileDataId(fileDataId);
        return Drain(stream);
    }

    public byte[]? ReadByName(string path)
    {
        using var stream = _reader.OpenByName(path.Replace('/', '\\').TrimStart('\\'));
        return Drain(stream);
    }

    private static byte[]? Drain(Stream? stream)
    {
        if (stream is null)
        {
            return null;
        }

        using var memory = new MemoryStream();
        stream.CopyTo(memory);
        return memory.ToArray();
    }

    public void Dispose() => _reader.Dispose();
}
