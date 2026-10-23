namespace ForeverDB.AtlasExporter.Db2;

public interface IDbdSource
{
    string Label { get; }
    Task<string?> GetAsync(string table, CancellationToken cancellationToken);
}

/// <summary>Definitions from a local folder (offline/CI use, or --dbd-dir).</summary>
public sealed class DirectoryDbdSource : IDbdSource
{
    private readonly string _directory;

    public DirectoryDbdSource(string directory) => _directory = directory;

    public string Label => "dbd-dir";

    public Task<string?> GetAsync(string table, CancellationToken cancellationToken)
    {
        var path = Path.Combine(_directory, table + ".dbd");

        return Task.FromResult<string?>(
            File.Exists(path) ? File.ReadAllText(path) : null);
    }
}

/// <summary>
/// Downloads definitions from WoWDBDefs once and caches them. Only the table name
/// is sent; no credentials or local data leave the machine.
/// </summary>
public sealed class CachedHttpDbdSource : IDbdSource
{
    public const string BaseUrl =
        "https://raw.githubusercontent.com/wowdev/WoWDBDefs/master/definitions/";

    private readonly string _cacheDirectory;
    private readonly HttpClient _client;
    private readonly bool _allowNetwork;

    public CachedHttpDbdSource(string cacheDirectory, bool allowNetwork, HttpClient? client = null)
    {
        _cacheDirectory = cacheDirectory;
        _allowNetwork = allowNetwork;
        _client = client ?? new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
    }

    public string Label => "wowdbdefs";

    public async Task<string?> GetAsync(string table, CancellationToken cancellationToken)
    {
        var cached = Path.Combine(_cacheDirectory, table + ".dbd");

        if (File.Exists(cached))
        {
            return await File.ReadAllTextAsync(cached, cancellationToken);
        }

        if (!_allowNetwork)
        {
            return null;
        }

        try
        {
            var text = await _client.GetStringAsync(BaseUrl + table + ".dbd", cancellationToken);
            Directory.CreateDirectory(_cacheDirectory);
            await File.WriteAllTextAsync(cached, text, cancellationToken);
            return text;
        }
        catch (HttpRequestException)
        {
            return null;
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }
    }
}

/// <summary>Tries each source in order.</summary>
public sealed class ChainedDbdSource : IDbdSource
{
    private readonly IReadOnlyList<IDbdSource> _sources;

    public ChainedDbdSource(params IDbdSource[] sources) => _sources = sources;

    public string Label => string.Join("+", _sources.Select(source => source.Label));

    public async Task<string?> GetAsync(string table, CancellationToken cancellationToken)
    {
        foreach (var source in _sources)
        {
            var text = await source.GetAsync(table, cancellationToken);

            if (text is not null)
            {
                return text;
            }
        }

        return null;
    }
}
