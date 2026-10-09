using System;
using System.Threading;

namespace ForeverDB.Companion.Services;

// One active request token per search/detail session. Superseded API
// operations are cancelled before they can consume more REST/RPC work.
// Version checks are still required because a request can finish between
// cancellation and response dispatch to the WPF UI thread.
public sealed class SearchRequestEpoch : IDisposable
{
    private CancellationTokenSource _current = new();
    private int _version;
    private bool _disposed;

    public int Version => _version;
    public CancellationToken Token => _current.Token;

    public (int Version, CancellationToken Token) Advance()
    {
        if (_disposed)
        {
            throw new ObjectDisposedException(nameof(SearchRequestEpoch));
        }

        var previous = _current;
        _current = new CancellationTokenSource();
        unchecked { ++_version; }
        previous.Cancel();
        previous.Dispose();
        return (_version, _current.Token);
    }

    public bool IsCurrent(int version) => !_disposed && version == _version;

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _current.Cancel();
        _current.Dispose();
    }
}
