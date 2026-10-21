using System.IO;
namespace ForeverDB.Companion.Services;

public sealed class WowSavedVariablesWatcher : IDisposable
{
    private readonly string _wowRoot;
    private readonly Func<string, CancellationToken, Task> _onChanged;
    private readonly Action<Exception>? _onError;
    private FileSystemWatcher? _watcher;

    private readonly Dictionary<string, CancellationTokenSource> _debounce =
        new(StringComparer.OrdinalIgnoreCase);

    public WowSavedVariablesWatcher(
        string wowRoot,
        Func<string, CancellationToken, Task> onChanged,
        Action<Exception>? onError = null)
    {
        _wowRoot = wowRoot;
        _onChanged = onChanged;
        _onError = onError;
    }

    public void Start()
    {
        var accountRoot = Path.Combine(
            _wowRoot,
            "WTF",
            "Account");

        if (!Directory.Exists(accountRoot))
        {
            throw new DirectoryNotFoundException(
                $"WoW Account folder not found: {accountRoot}");
        }

        _watcher = new FileSystemWatcher(
            accountRoot,
            "ForeverDB.lua")
        {
            IncludeSubdirectories = true,
            NotifyFilter =
                NotifyFilters.LastWrite |
                NotifyFilters.Size |
                NotifyFilters.FileName,
            EnableRaisingEvents = true
        };

        _watcher.Changed += (_, e) => Schedule(e.FullPath);
        _watcher.Created += (_, e) => Schedule(e.FullPath);
        _watcher.Renamed += (_, e) => Schedule(e.FullPath);
    }

    public IEnumerable<string> FindExistingFiles()
    {
        var accountRoot = Path.Combine(
            _wowRoot,
            "WTF",
            "Account");

        if (!Directory.Exists(accountRoot))
        {
            return Array.Empty<string>();
        }

        return Directory
            .EnumerateFiles(
                accountRoot,
                "ForeverDB.lua",
                SearchOption.AllDirectories)
            .ToArray();
    }

    private void Schedule(string path)
    {
        lock (_debounce)
        {
            if (_debounce.TryGetValue(path, out var old))
            {
                old.Cancel();
                old.Dispose();
            }

            var cts = new CancellationTokenSource();
            _debounce[path] = cts;

            _ = Task.Run(
                async () =>
                {
                    try
                    {
                        await Task.Delay(
                            1500,
                            cts.Token);

                        await WaitForCompletedWriteAsync(
                            path,
                            cts.Token);

                        await _onChanged(
                            path,
                            cts.Token);
                    }
                    catch (OperationCanceledException)
                    {
                    }
                    catch (Exception ex)
                    {
                        _onError?.Invoke(ex);
                    }
                    finally
                    {
                        lock (_debounce)
                        {
                            if (_debounce.TryGetValue(path, out var current) &&
                                current == cts)
                            {
                                _debounce.Remove(path);
                            }
                        }

                        cts.Dispose();
                    }
                });
        }
    }

    private static async Task WaitForCompletedWriteAsync(
        string path,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(10);
        (long Length, DateTime LastWriteUtc)? previous = null;

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();

            try
            {
                await using var stream = new FileStream(
                    path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.Read,
                    bufferSize: 1,
                    useAsync: true);
                var info = new FileInfo(path);
                var current = (stream.Length, info.LastWriteTimeUtc);

                if (previous == current)
                {
                    return;
                }

                previous = current;
            }
            catch (IOException) when (DateTimeOffset.UtcNow < deadline)
            {
                previous = null;
            }
            catch (UnauthorizedAccessException) when (DateTimeOffset.UtcNow < deadline)
            {
                previous = null;
            }

            if (DateTimeOffset.UtcNow >= deadline)
            {
                throw new IOException("ForeverDB SavedVariables was not ready after 10 seconds.");
            }

            await Task.Delay(250, cancellationToken);
        }
    }

    public void Dispose()
    {
        _watcher?.Dispose();

        lock (_debounce)
        {
            foreach (var cts in _debounce.Values)
            {
                cts.Cancel();
                cts.Dispose();
            }

            _debounce.Clear();
        }

    }
}
