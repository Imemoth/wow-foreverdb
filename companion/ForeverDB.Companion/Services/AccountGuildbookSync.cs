using ForeverDB.Companion.Account;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public sealed record AccountGuildbookSyncResult(bool Loaded, bool CaptureAccepted, bool Stale);

public sealed record AccountGuildbookRestoreResult(
    bool Authorized,
    int DiscoveredInstallations,
    IReadOnlyList<string> LoadedInstallationIds,
    IReadOnlyList<string> UnreadableInstallationIds);

/// <summary>Local Guildbook boundary. It deliberately has no RPC or token method.</summary>
public interface IAccountGuildbookSync
{
    event Action<IReadOnlyList<ForeverDbGuild>>? Changed;
    bool IsAvailable { get; }
    void ObserveSnapshot(ForeverDbSnapshot snapshot);
    Task<AccountGuildbookRestoreResult> RestoreLocalAsync(
        IEnumerable<string> installationIds,
        string? preferredInstallationId = null,
        CancellationToken cancellationToken = default);
    Task<AccountGuildbookSyncResult> SyncAsync(ForeverDbSnapshot snapshot, CancellationToken cancellationToken = default);
    void Clear();
}

/// <summary>
/// Authenticated local Guildbook cache and capture freshness gate. No Guildbook
/// data is sent to Supabase; public observation sync may invoke this boundary
/// without being coupled to a private network operation.
/// </summary>
public sealed class AccountGuildbookSync : IAccountGuildbookSync, IDisposable
{
    private readonly AccountSessionManager _sessions;
    private readonly LocalGuildbookStore _store;
    private readonly object _gate = new();
    private readonly Dictionary<string, CaptureStamp> _lastObserved = new(StringComparer.Ordinal);
    private readonly Dictionary<string, CaptureStamp> _identityFloor = new(StringComparer.Ordinal);
    private readonly Dictionary<string, CaptureStamp> _lastAccepted = new(StringComparer.Ordinal);
    private readonly Dictionary<string, IReadOnlyDictionary<string, ForeverDbGuild>> _cacheByInstallation =
        new(StringComparer.Ordinal);
    private string? _activeInstallationId;
    private CancellationTokenSource _identityCancellation = new();
    private long _identityEnteredAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    private bool _disposed;

    public AccountGuildbookSync(AccountSessionManager sessions, LocalGuildbookStore store)
    {
        _sessions = sessions;
        _store = store;
        _sessions.IdentityChanged += OnIdentityChanged;
    }

    public event Action<IReadOnlyList<ForeverDbGuild>>? Changed;
    public bool IsAvailable => CanUseLocal(_sessions.Status);

    public IReadOnlyList<ForeverDbGuild> CachedGuilds
    {
        get
        {
            lock (_gate)
            {
                return _activeInstallationId is { } id && _cacheByInstallation.TryGetValue(id, out var guilds)
                    ? guilds.Values.ToArray()
                    : Array.Empty<ForeverDbGuild>();
            }
        }
    }

    public string? ActiveInstallationId
    {
        get { lock (_gate) return _activeInstallationId; }
    }

    public IReadOnlyList<ForeverDbGuild> GetCachedGuilds(string installationId)
    {
        lock (_gate)
        {
            return _cacheByInstallation.TryGetValue(installationId, out var guilds)
                ? guilds.Values.ToArray()
                : Array.Empty<ForeverDbGuild>();
        }
    }

    public void ObserveSnapshot(ForeverDbSnapshot snapshot)
    {
        if (TryGetCapture(snapshot) is not { } capture) return;
        lock (_gate) _lastObserved[snapshot.InstallationId] = capture;
    }

    /// <summary>
    /// Restores already encrypted local snapshots only. It never parses a
    /// SavedVariables file, obtains a token, or calls a network endpoint.
    /// </summary>
    public Task<AccountGuildbookRestoreResult> RestoreLocalAsync(
        IEnumerable<string> installationIds,
        string? preferredInstallationId = null,
        CancellationToken cancellationToken = default)
    {
        if (cancellationToken.IsCancellationRequested)
            return Task.FromCanceled<AccountGuildbookRestoreResult>(cancellationToken);

        var ids = installationIds
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var status = _sessions.Status;
        if (!CanUseLocal(status))
        {
            Clear();
            return Task.FromResult(new AccountGuildbookRestoreResult(false, ids.Length, Array.Empty<string>(), Array.Empty<string>()));
        }

        var generation = status.Generation;
        var loaded = new Dictionary<string, IReadOnlyDictionary<string, ForeverDbGuild>>(StringComparer.Ordinal);
        var loadedIds = new List<string>();
        var unreadableIds = new List<string>();

        foreach (var installationId in ids)
        {
            if (cancellationToken.IsCancellationRequested)
                return Task.FromCanceled<AccountGuildbookRestoreResult>(cancellationToken);

            var result = _store.Load(status.AccountId!, installationId);
            if (result.Snapshot is { } snapshot)
            {
                loaded[installationId] = ToGuildDictionary(snapshot.Guilds);
                loadedIds.Add(installationId);
            }
            else if (result.Status is LocalGuildbookReadStatus.Unreadable or LocalGuildbookReadStatus.IoError)
            {
                unreadableIds.Add(installationId);
            }
        }

        if (generation != _sessions.Status.Generation || !CanUseLocal(_sessions.Status))
        {
            Clear();
            return Task.FromResult(new AccountGuildbookRestoreResult(false, ids.Length, Array.Empty<string>(), Array.Empty<string>()));
        }

        lock (_gate)
        {
            _cacheByInstallation.Clear();
            foreach (var pair in loaded)
                _cacheByInstallation[pair.Key] = pair.Value;
            _activeInstallationId = preferredInstallationId is { } preferred && loaded.ContainsKey(preferred)
                ? preferred
                : loadedIds.FirstOrDefault();
        }
        Changed?.Invoke(CachedGuilds);
        return Task.FromResult(new AccountGuildbookRestoreResult(true, ids.Length, loadedIds, unreadableIds));
    }

    public Task<AccountGuildbookSyncResult> SyncAsync(
        ForeverDbSnapshot snapshot,
        CancellationToken cancellationToken = default)
    {
        ObserveSnapshot(snapshot);
        if (cancellationToken.IsCancellationRequested)
            return Task.FromCanceled<AccountGuildbookSyncResult>(cancellationToken);

        var status = _sessions.Status;
        if (!CanUseLocal(status))
            return Task.FromResult(new AccountGuildbookSyncResult(false, false, false));
        var generation = status.Generation;

        var candidate = TryGetCapture(snapshot);
        var accepted = false;
        var stale = false;
        if (candidate is { } capture)
        {
            if (IsFresh(snapshot.InstallationId, capture))
            {
                var saved = _store.Save(status.AccountId!, snapshot.InstallationId, snapshot);
                accepted = saved.Status == LocalGuildbookSaveStatus.Saved;
                stale = saved.Status == LocalGuildbookSaveStatus.OlderSnapshot;
                if (accepted)
                    lock (_gate) _lastAccepted[snapshot.InstallationId] = capture;
            }
            else
            {
                stale = true;
            }
        }

        var loaded = _store.Load(status.AccountId!, snapshot.InstallationId);
        // A sign-out/switch can happen while local IO is in progress. Do not
        // publish the old account's result after the session generation moved.
        if (generation != _sessions.Status.Generation || !CanUseLocal(_sessions.Status))
        {
            Clear();
            return Task.FromResult(new AccountGuildbookSyncResult(false, false, true));
        }
        if (loaded.Snapshot is { } local)
        {
            var guilds = ToGuildDictionary(local.Guilds);
            lock (_gate)
            {
                _cacheByInstallation[snapshot.InstallationId] = guilds;
                _activeInstallationId = snapshot.InstallationId;
            }
            Changed?.Invoke(CachedGuilds);
            return Task.FromResult(new AccountGuildbookSyncResult(true, accepted, stale));
        }

        return Task.FromResult(new AccountGuildbookSyncResult(false, accepted, stale));
    }

    private static IReadOnlyDictionary<string, ForeverDbGuild> ToGuildDictionary(IEnumerable<ForeverDbGuild> guilds) =>
        guilds
            .Where(guild => !string.IsNullOrWhiteSpace(guild.GuildKey))
            .GroupBy(guild => guild.GuildKey, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.OrderByDescending(guild => guild.CapturedAt).First(), StringComparer.OrdinalIgnoreCase);

    public void Clear()
    {
        if (_disposed) return;
        CancellationTokenSource previous;
        lock (_gate)
        {
            _cacheByInstallation.Clear();
            _activeInstallationId = null;
            previous = _identityCancellation;
            _identityCancellation = new CancellationTokenSource();
        }
        try { previous.Cancel(); } finally { previous.Dispose(); }
        Changed?.Invoke(Array.Empty<ForeverDbGuild>());
    }

    private void OnIdentityChanged(long _)
    {
        CancellationTokenSource previous;
        lock (_gate)
        {
            _identityEnteredAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            _identityFloor.Clear();
            foreach (var pair in _lastObserved) _identityFloor[pair.Key] = pair.Value;
            _cacheByInstallation.Clear();
            _activeInstallationId = null;
            _lastAccepted.Clear();
            previous = _identityCancellation;
            _identityCancellation = new CancellationTokenSource();
        }
        try { previous.Cancel(); } finally { previous.Dispose(); }
        Changed?.Invoke(Array.Empty<ForeverDbGuild>());
    }

    private bool IsFresh(string installationId, CaptureStamp candidate)
    {
        lock (_gate)
        {
            if (_lastAccepted.TryGetValue(installationId, out var accepted) &&
                string.Equals(accepted.CaptureId, candidate.CaptureId, StringComparison.Ordinal)) return false;
            if (_identityFloor.TryGetValue(installationId, out var floor) &&
                (string.Equals(floor.CaptureId, candidate.CaptureId, StringComparison.Ordinal) ||
                 candidate.CapturedAt <= floor.CapturedAt)) return false;
            return candidate.CapturedAt > _identityEnteredAt;
        }
    }

    private static bool CanUseLocal(AccountStatus status) =>
        status.State == SessionState.Registered &&
        status.IdentityVerified &&
        status.PrimaryCredentialPresent &&
        !status.PendingRevocation &&
        status.AccountsEnabled &&
        status.AccountId is not null &&
        status.Fault is not (SessionFault.AuthRejected or SessionFault.LocalCredentialCorrupt or
            SessionFault.StorageFailure or SessionFault.RegisteredVerificationFailed or SessionFault.FeatureDisabled);

    private static CaptureStamp? TryGetCapture(ForeverDbSnapshot snapshot)
    {
        if (string.IsNullOrWhiteSpace(snapshot.GuildbookCaptureId) ||
            snapshot.GuildbookCapturedAt is not > 0 ||
            string.IsNullOrWhiteSpace(snapshot.GuildbookSourceCharacter)) return null;
        return new CaptureStamp(snapshot.GuildbookCaptureId, snapshot.GuildbookCapturedAt.Value, snapshot.GuildbookSourceCharacter);
    }

    private readonly record struct CaptureStamp(string CaptureId, long CapturedAt, string SourceCharacter);

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _sessions.IdentityChanged -= OnIdentityChanged;
        lock (_gate)
        {
            _identityCancellation.Cancel();
            _identityCancellation.Dispose();
            _cacheByInstallation.Clear();
            _activeInstallationId = null;
        }
    }
}
