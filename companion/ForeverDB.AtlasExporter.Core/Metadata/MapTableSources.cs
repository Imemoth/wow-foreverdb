using ForeverDB.AtlasExporter.Client;
using ForeverDB.AtlasExporter.Db2;
using ForeverDB.AtlasExporter.Model;

namespace ForeverDB.AtlasExporter.Metadata;

public sealed record TableReadResult(TableData? Data, string? Error)
{
    public static TableReadResult Ok(TableData data) => new(data, null);
    public static TableReadResult Fail(string error) => new(null, error);
}

/// <summary>One place the DB2 map tables can be read from.</summary>
public interface IMapTableSource
{
    string Label { get; }
    Task<TableReadResult> ReadAsync(string table, CancellationToken cancellationToken);
}

/// <summary>
/// DB2 files decoded with WoWDBDefs layouts. The bytes come from the installed client
/// (CASC, <c>DBFilesClient\Table.db2</c>) or from a folder of exported .db2 files.
/// </summary>
public sealed class Db2TableSource : IMapTableSource
{
    private readonly Func<string, byte[]?> _readDb2;
    private readonly IDbdSource _definitions;
    private readonly Version? _build;

    public Db2TableSource(
        string label,
        Func<string, byte[]?> readDb2,
        IDbdSource definitions,
        Version? build)
    {
        Label = label;
        _readDb2 = readDb2;
        _definitions = definitions;
        _build = build;
    }

    public string Label { get; }

    public static Db2TableSource FromClient(
        IAssetSource assets, IDbdSource definitions, Version? build) =>
        new("client-db2", table => assets.ReadByName($@"DBFilesClient\{table}.db2"), definitions, build);

    public static Db2TableSource FromDirectory(
        string directory, IDbdSource definitions, Version? build) =>
        new("db2-dir", table =>
        {
            var path = Path.Combine(directory, table + ".db2");
            return File.Exists(path) ? File.ReadAllBytes(path) : null;
        }, definitions, build);

    public async Task<TableReadResult> ReadAsync(string table, CancellationToken cancellationToken)
    {
        var bytes = _readDb2(table);

        if (bytes is null)
        {
            return TableReadResult.Fail($"{table}.db2 not found in {Label}");
        }

        Db2File file;

        try
        {
            file = Db2File.Parse(bytes);
        }
        catch (Db2FormatException ex)
        {
            return TableReadResult.Fail($"{table}.db2: {ex.Message}");
        }

        var dbdText = await _definitions.GetAsync(table, cancellationToken);

        if (dbdText is null)
        {
            return TableReadResult.Fail(
                $"No column definition (.dbd) available for {table}. Allow network access once " +
                "(definitions are cached) or pass --dbd-dir.");
        }

        try
        {
            var dbd = DbdFile.Parse(table, dbdText);
            var layout = dbd.Select(file.LayoutHashHex, _build);

            if (layout is null)
            {
                return TableReadResult.Fail(
                    $"{table}: no definition for layout {file.LayoutHashHex}" +
                    (_build is null ? "" : $" / build {_build}") +
                    " in the available .dbd file.");
            }

            return TableReadResult.Ok(file.Read(table, layout));
        }
        catch (Exception ex) when (ex is Db2FormatException or InvalidDataException or OverflowException)
        {
            return TableReadResult.Fail($"{table}.db2: {ex.Message}");
        }
    }
}

/// <summary>Named-column CSV exports (wago.tools style) from a folder.</summary>
public sealed class CsvDirectoryTableSource : IMapTableSource
{
    private readonly string _directory;

    public CsvDirectoryTableSource(string directory) => _directory = directory;

    public string Label => "csv-dir";

    public Task<TableReadResult> ReadAsync(string table, CancellationToken cancellationToken)
    {
        var path = Path.Combine(_directory, table + ".csv");

        if (!File.Exists(path))
        {
            return Task.FromResult(TableReadResult.Fail($"{table}.csv not found"));
        }

        try
        {
            return Task.FromResult(
                TableReadResult.Ok(CsvReader.Parse(table, File.ReadAllText(path))));
        }
        catch (InvalidDataException ex)
        {
            return Task.FromResult(TableReadResult.Fail(ex.Message));
        }
    }
}

/// <summary>
/// Exact-build CSV exports from wago.tools (the same host the Companion's
/// Auto-Atlas verifier already uses). Only the table name and the client's build
/// number are sent. Last-resort metadata source; clearly labelled in build.json.
/// </summary>
public sealed class WagoCsvTableSource : IMapTableSource
{
    private readonly string _version;
    private readonly string _cacheDirectory;
    private readonly bool _allowNetwork;
    private readonly HttpClient _client;

    public WagoCsvTableSource(
        string version, string cacheDirectory, bool allowNetwork, HttpClient? client = null)
    {
        _version = version;
        _cacheDirectory = cacheDirectory;
        _allowNetwork = allowNetwork;
        _client = client ?? new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
    }

    public string Label => $"wago-csv:{_version}";

    public async Task<TableReadResult> ReadAsync(string table, CancellationToken cancellationToken)
    {
        var cache = Path.Combine(_cacheDirectory, $"{table}.{_version}.csv");

        try
        {
            if (!File.Exists(cache))
            {
                if (!_allowNetwork)
                {
                    return TableReadResult.Fail($"{table}: network disabled and no cached CSV");
                }

                var url = $"https://wago.tools/db2/{table}/csv?build={Uri.EscapeDataString(_version)}";
                var text = await _client.GetStringAsync(url, cancellationToken);
                Directory.CreateDirectory(_cacheDirectory);
                await File.WriteAllTextAsync(cache, text, cancellationToken);
            }

            return TableReadResult.Ok(
                CsvReader.Parse(table, await File.ReadAllTextAsync(cache, cancellationToken)));
        }
        catch (Exception ex) when (
            ex is HttpRequestException or InvalidDataException or IOException)
        {
            return TableReadResult.Fail($"{table}: {ex.GetType().Name}");
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return TableReadResult.Fail($"{table}: request timed out");
        }
    }
}
