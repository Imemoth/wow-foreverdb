using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

namespace ForeverDB.Companion.Account;

public sealed class SessionLockTimeoutException : Exception
{
    public SessionLockTimeoutException() : base("Another ForeverDB Companion process is using the account session.") { }
}

/// <summary>Held while a session transition runs. Dispose releases the machine-wide lock.</summary>
public sealed class SessionLease : IDisposable
{
    private Action? _release;

    internal SessionLease(Action release, bool abandoned)
    {
        _release = release;
        Abandoned = abandoned;
    }

    /// <summary>The previous owner died while holding the lock; callers re-read and repair storage (they always do).</summary>
    public bool Abandoned { get; }

    public void Dispose() => Interlocked.Exchange(ref _release, null)?.Invoke();
}

public interface ISessionGate
{
    /// <exception cref="SessionLockTimeoutException">The lock could not be taken within <paramref name="timeout"/>.</exception>
    Task<SessionLease> AcquireAsync(TimeSpan timeout, CancellationToken cancellationToken);
}

/// <summary>
/// Machine-wide session gate: an in-process <see cref="SemaphoreSlim"/> (cheap, async) in front of a named
/// <see cref="Mutex"/> (cross-process). A Windows mutex is owned by a THREAD, and async continuations hop
/// threads, so the mutex is acquired, held and released by one dedicated thread per lease that blocks on an
/// event; the async caller never touches the mutex itself. Waiting is bounded and cancellable and never
/// happens on the caller's (UI) thread.
/// </summary>
public sealed class CrossProcessSessionGate : ISessionGate
{
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> LocalGates = new();

    private static readonly TimeSpan PollSlice = TimeSpan.FromMilliseconds(50);

    private readonly string _mutexName;
    private readonly SemaphoreSlim _local;

    public CrossProcessSessionGate(string vaultDirectory)
    {
        var normalized = Path.GetFullPath(vaultDirectory).TrimEnd(Path.DirectorySeparatorChar).ToLowerInvariant();
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)))[..32];
        _mutexName = (OperatingSystem.IsWindows() ? "Global\\" : "") + "ForeverDB.Account.Session." + hash;
        _local = LocalGates.GetOrAdd(_mutexName, _ => new SemaphoreSlim(1, 1));
    }

    public async Task<SessionLease> AcquireAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        var clock = Stopwatch.StartNew();

        if (!await _local.WaitAsync(timeout, cancellationToken).ConfigureAwait(false))
        {
            throw new SessionLockTimeoutException();
        }

        var handedOver = false;
        try
        {
            var remaining = timeout - clock.Elapsed;
            if (remaining < TimeSpan.Zero)
            {
                remaining = TimeSpan.Zero;
            }

            var acquired = new TaskCompletionSource<(bool Owned, bool Abandoned, bool Cancelled)>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            var releaseSignal = new ManualResetEventSlim(false);
            var name = _mutexName;

            var thread = new Thread(() =>
            {
                Mutex? mutex = null;
                try
                {
                    mutex = new Mutex(false, name);
                    var owned = false;
                    var abandoned = false;
                    var cancelled = false;
                    try
                    {
                        // Poll in short slices (instead of WaitAny with the cancellation handle, which Unix does not
                        // support for named mutexes) so cancellation and the deadline are honoured promptly.
                        var deadline = Stopwatch.StartNew();
                        while (true)
                        {
                            if (cancellationToken.IsCancellationRequested)
                            {
                                cancelled = true;
                                break;
                            }

                            var left = remaining - deadline.Elapsed;
                            if (left < TimeSpan.Zero)
                            {
                                break;
                            }

                            if (mutex.WaitOne(left < PollSlice ? left : PollSlice))
                            {
                                owned = true;
                                break;
                            }
                        }
                    }
                    catch (AbandonedMutexException)
                    {
                        // We own it now; the previous holder crashed. Every caller re-reads and repairs storage.
                        owned = true;
                        abandoned = true;
                    }

                    acquired.TrySetResult((owned, abandoned, cancelled));
                    if (owned)
                    {
                        releaseSignal.Wait();
                        mutex.ReleaseMutex();
                    }
                }
                catch (Exception ex)
                {
                    acquired.TrySetException(ex);
                }
                finally
                {
                    mutex?.Dispose();
                }
            })
            {
                IsBackground = true,
                Name = "ForeverDB.SessionGate"
            };
            thread.Start();

            var outcome = await acquired.Task.ConfigureAwait(false);
            if (!outcome.Owned)
            {
                thread.Join();
                releaseSignal.Dispose();
                if (outcome.Cancelled)
                {
                    throw new OperationCanceledException(cancellationToken);
                }

                throw new SessionLockTimeoutException();
            }

            handedOver = true;
            var local = _local;
            return new SessionLease(
                () =>
                {
                    // Signal the owning thread and wait until it really released the mutex.
                    releaseSignal.Set();
                    thread.Join();
                    releaseSignal.Dispose();
                    local.Release();
                },
                outcome.Abandoned);
        }
        finally
        {
            if (!handedOver)
            {
                _local.Release();
            }
        }
    }
}
