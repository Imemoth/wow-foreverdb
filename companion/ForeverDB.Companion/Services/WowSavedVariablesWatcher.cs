namespace ForeverDB.Companion.Services;

public sealed class WowSavedVariablesWatcher : IDisposable
{
    private readonly string _wowRoot;
    private readonly Func<string, Task> _onChanged;
    private FileSystemWatcher? _watcher;

    private readonly Dictionary<string, CancellationTokenSource> _debounce =
        new(StringComparer.OrdinalIgnoreCase);

    public WowSavedVariablesWatcher(
        string wowRoot,
        Func<string, Task> onChanged)
    {
        _wowRoot = wowRoot;
        _onChanged = onChanged;
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

                        await _onChanged(path);
                    }
                    catch (OperationCanceledException)
                    {
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
