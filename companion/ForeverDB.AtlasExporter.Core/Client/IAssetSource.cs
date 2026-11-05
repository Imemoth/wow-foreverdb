namespace ForeverDB.AtlasExporter.Client;

/// <summary>Read-only access to game files (CASC in production, folders in tests).</summary>
public interface IAssetSource : IDisposable
{
    string Label { get; }

    /// <summary>Complete file bytes, or null when the file is not present.</summary>
    byte[]? ReadByFileDataId(int fileDataId);

    byte[]? ReadByName(string path);
}

/// <summary>
/// Tries several sources in order (e.g. local CASC first, exact-build CDN second).
/// Records which source actually served each file.
/// </summary>
public sealed class FallbackAssetSource : IAssetSource
{
    private readonly IReadOnlyList<Func<IAssetSource?>> _factories;
    private readonly List<IAssetSource?> _opened = new();
    private readonly bool[] _attempted;
    private readonly Dictionary<string, int> _served = new(StringComparer.Ordinal);

    public FallbackAssetSource(params Func<IAssetSource?>[] factories)
    {
        _factories = factories;
        _attempted = new bool[factories.Length];

        foreach (var _ in factories)
        {
            _opened.Add(null);
        }
    }

    public string Label => "fallback";

    public IReadOnlyDictionary<string, int> ServedBy => _served;

    public byte[]? ReadByFileDataId(int fileDataId) =>
        Read(source => source.ReadByFileDataId(fileDataId));

    public byte[]? ReadByName(string path) =>
        Read(source => source.ReadByName(path));

    private byte[]? Read(Func<IAssetSource, byte[]?> read)
    {
        for (var i = 0; i < _factories.Count; i++)
        {
            // Sources are opened lazily (a healthy local CASC never touches the CDN) and
            // at most once: a CDN that failed to open is not retried for every missing file.
            if (!_attempted[i])
            {
                _attempted[i] = true;
                _opened[i] = _factories[i]();
            }

            if (_opened[i] is null)
            {
                continue;
            }

            var bytes = read(_opened[i]!);

            if (bytes is not null)
            {
                var label = _opened[i]!.Label;
                _served[label] = _served.GetValueOrDefault(label) + 1;
                return bytes;
            }
        }

        return null;
    }

    public void Dispose()
    {
        foreach (var source in _opened)
        {
            source?.Dispose();
        }
    }
}

/// <summary>Folder-backed source: <c>{fdid}.blp</c> / relative names. Used by tests and --loose-dir.</summary>
public sealed class DirectoryAssetSource : IAssetSource
{
    private readonly string _root;

    public DirectoryAssetSource(string root) => _root = root;

    public string Label => "directory";

    public byte[]? ReadByFileDataId(int fileDataId)
    {
        foreach (var extension in new[] { ".blp", ".bin", "" })
        {
            var path = Path.Combine(_root, fileDataId.ToString() + extension);

            if (File.Exists(path))
            {
                return File.ReadAllBytes(path);
            }
        }

        return null;
    }

    public byte[]? ReadByName(string path)
    {
        var normalized = path.Replace('\\', Path.DirectorySeparatorChar)
            .Replace('/', Path.DirectorySeparatorChar)
            .TrimStart(Path.DirectorySeparatorChar);
        var full = Path.GetFullPath(Path.Combine(_root, normalized));

        if (!full.StartsWith(Path.GetFullPath(_root), StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return File.Exists(full) ? File.ReadAllBytes(full) : null;
    }

    public void Dispose()
    {
    }
}
