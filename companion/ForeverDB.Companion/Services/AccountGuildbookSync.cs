using ForeverDB.Companion.Account;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public sealed record AccountGuildbookSyncResult(bool Loaded, bool CaptureAccepted, bool Stale);

public sealed record AccountGuildbookImportResult(
    bool CaptureAccepted,
    bool EncryptedCacheLoaded,
    GuildbookImportRejectionReason? RejectionReason,
    long IdentityGeneration,
    ForeverDbSnapshot? CachedSnapshot = null);

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
    Task<AccountGuildbookRestoreResult> RestoreLocalAsync(
        IEnumerable<string> installationIds,
        string? preferredInstallationId = null,
        CancellationToken cancellationToken = default);
    Task<AccountGuildbookSyncResult> SyncAsync(ForeverDbSnapshot snapshot, CancellationToken cancellationToken = default);
    Task<AccountGuildbookImportResult> ImportLocalSnapshotAsync(
        ForeverDbSnapshot snapshot,
        bool authorizeFirstImport,
        long? expectedIdentityGeneration = null,
        CancellationToken cancellationToken = default);
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
    private readonly Dictionary<string, IReadOnlyDictionary<string, ForeverDbGuild>> _cacheByInstallation =
        new(StringComparer.Ordinal);
    private string? _activeInstallationId;
    private CancellationTokenSource _identityCancellation = new();
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

            var binding = _store.GetBindingStatus(status.AccountId!, installationId);
            if (binding is LocalGuildbookBindingStatus.BoundToAnotherAccount or LocalGuildbookBindingStatus.Unreadable)
            {
                if (binding == LocalGuildbookBindingStatus.Unreadable)
                    unreadableIds.Add(installationId);
                continue;
            }

            var result = _store.Load(status.AccountId!, installationId);
            if (result.Snapshot is { } snapshot)
            {
                // A cache that predates persistent installation bindings remains attributable through its DPAPI-protected
                // account/install envelope. Upgrade that already account-scoped cache into a durable installation binding.
                if (binding == LocalGuildbookBindingStatus.Unbound &&
                    _store.TryBindToAccount(status.AccountId!, installationId) != LocalGuildbookBindingStatus.CurrentAccount)
                    continue;
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

    public async Task<AccountGuildbookSyncResult> SyncAsync(
        ForeverDbSnapshot snapshot,
        CancellationToken cancellationToken = default)
    {
        var imported = await ImportLocalSnapshotAsync(snapshot, authorizeFirstImport: false, cancellationToken: cancellationToken)
            .ConfigureAwait(false);
        return new AccountGuildbookSyncResult(
            imported.EncryptedCacheLoaded,
            imported.CaptureAccepted,
            imported.RejectionReason is GuildbookImportRejectionReason.OlderThanLocalSnapshot or GuildbookImportRejectionReason.IdentityChanged);
    }

    public Task<AccountGuildbookImportResult> ImportLocalSnapshotAsync(
        ForeverDbSnapshot snapshot,
        bool authorizeFirstImport,
        long? expectedIdentityGeneration = null,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var status = _sessions.Status;
        if (!CanUseLocal(status))
            return Task.FromResult(new AccountGuildbookImportResult(false, false,
                GuildbookImportRejectionReason.AccountVerificationRequired, status.Generation));
        if (expectedIdentityGeneration is { } expected && expected != status.Generation)
            return Task.FromResult(new AccountGuildbookImportResult(false, false,
                GuildbookImportRejectionReason.IdentityChanged, status.Generation));
        if (!IsValidCapture(snapshot))
            return Task.FromResult(new AccountGuildbookImportResult(false, false,
                GuildbookImportRejectionReason.NoGuildbookCapture, status.Generation));

        var binding = _store.GetBindingStatus(status.AccountId!, snapshot.InstallationId);
        if (binding == LocalGuildbookBindingStatus.BoundToAnotherAccount)
            return Task.FromResult(new AccountGuildbookImportResult(false, false,
                GuildbookImportRejectionReason.BoundToAnotherAccount, status.Generation));
        if (binding == LocalGuildbookBindingStatus.Unreadable)
            return Task.FromResult(new AccountGuildbookImportResult(false, false,
                GuildbookImportRejectionReason.BindingUnreadable, status.Generation));
        if (binding == LocalGuildbookBindingStatus.Unbound)
        {
            if (!authorizeFirstImport)
                return Task.FromResult(new AccountGuildbookImportResult(false, false,
                    GuildbookImportRejectionReason.FirstImportAuthorizationDeclined, status.Generation));
            if (status.Generation != _sessions.Status.Generation || !CanUseLocal(_sessions.Status))
                return Task.FromResult(new AccountGuildbookImportResult(false, false,
                    GuildbookImportRejectionReason.IdentityChanged, _sessions.Status.Generation));
            binding = _store.TryBindToAccount(status.AccountId!, snapshot.InstallationId);
            if (binding == LocalGuildbookBindingStatus.BoundToAnotherAccount)
                return Task.FromResult(new AccountGuildbookImportResult(false, false,
                    GuildbookImportRejectionReason.BoundToAnotherAccount, _sessions.Status.Generation));
            if (binding != LocalGuildbookBindingStatus.CurrentAccount)
                return Task.FromResult(new AccountGuildbookImportResult(false, false,
                    GuildbookImportRejectionReason.BindingUnreadable, _sessions.Status.Generation));
        }

        if (status.Generation != _sessions.Status.Generation || !CanUseLocal(_sessions.Status))
            return Task.FromResult(new AccountGuildbookImportResult(false, false,
                GuildbookImportRejectionReason.IdentityChanged, _sessions.Status.Generation));

        var existing = _store.Load(status.AccountId!, snapshot.InstallationId);
        if (existing.Status is LocalGuildbookReadStatus.Unreadable or LocalGuildbookReadStatus.IoError)
            return Task.FromResult(new AccountGuildbookImportResult(false, false,
                GuildbookImportRejectionReason.CacheUnreadable, status.Generation));

        if (existing.Snapshot is { } cached && IsOlderOrReplay(snapshot, cached))
        {
            GuildbookImportRejectionReason? rejection = string.Equals(snapshot.GuildbookCaptureId, cached.GuildbookCaptureId, StringComparison.Ordinal)
                ? null
                : GuildbookImportRejectionReason.OlderThanLocalSnapshot;
            PublishCacheIfCurrent(status.Generation, snapshot.InstallationId, cached);
            return Task.FromResult(new AccountGuildbookImportResult(false, true, rejection, status.Generation, cached));
        }

        var saved = _store.Save(status.AccountId!, snapshot.InstallationId, snapshot);
        if (saved.Status == LocalGuildbookSaveStatus.Failed)
            return Task.FromResult(new AccountGuildbookImportResult(false, false,
                GuildbookImportRejectionReason.CacheWriteFailed, status.Generation));
        if (saved.Status == LocalGuildbookSaveStatus.OlderSnapshot)
        {
            var prior = saved.Snapshot;
            if (prior is not null)
                PublishCacheIfCurrent(status.Generation, snapshot.InstallationId, prior);
            return Task.FromResult(new AccountGuildbookImportResult(false, prior is not null,
                GuildbookImportRejectionReason.OlderThanLocalSnapshot, status.Generation, prior));
        }

        var loaded = _store.Load(status.AccountId!, snapshot.InstallationId);
        if (status.Generation != _sessions.Status.Generation || !CanUseLocal(_sessions.Status))
            return Task.FromResult(new AccountGuildbookImportResult(false, false,
                GuildbookImportRejectionReason.IdentityChanged, _sessions.Status.Generation));
        if (loaded.Snapshot is not { } local)
            return Task.FromResult(new AccountGuildbookImportResult(true, false,
                GuildbookImportRejectionReason.CacheUnreadable, status.Generation));

        PublishCacheIfCurrent(status.Generation, snapshot.InstallationId, local);
        return Task.FromResult(new AccountGuildbookImportResult(true, true, null, status.Generation, local));
    }

    private void PublishCacheIfCurrent(long generation, string installationId, ForeverDbSnapshot snapshot)
    {
        if (generation != _sessions.Status.Generation || !CanUseLocal(_sessions.Status))
            return;
        var guilds = ToGuildDictionary(snapshot.Guilds);
        lock (_gate)
        {
            if (generation != _sessions.Status.Generation || !CanUseLocal(_sessions.Status))
                return;
            _cacheByInstallation[installationId] = guilds;
            _activeInstallationId = installationId;
        }
        Changed?.Invoke(CachedGuilds);
    }

    private static bool IsValidCapture(ForeverDbSnapshot snapshot) =>
        snapshot.SchemaVersion == 9 &&
        !string.IsNullOrWhiteSpace(snapshot.InstallationId) &&
        snapshot.UpdatedAt > 0 &&
        snapshot.Guilds.Count > 0 &&
        HasCapture(snapshot);

    private static bool HasCapture(ForeverDbSnapshot snapshot) =>
        !string.IsNullOrWhiteSpace(snapshot.GuildbookCaptureId) &&
        snapshot.GuildbookCapturedAt is > 0 &&
        !string.IsNullOrWhiteSpace(snapshot.GuildbookSourceCharacter);

    private static bool IsOlderOrReplay(ForeverDbSnapshot candidate, ForeverDbSnapshot existing)
    {
        var candidateAt = candidate.GuildbookCapturedAt!.Value;
        var existingAt = existing.GuildbookCapturedAt!.Value;
        return candidateAt < existingAt ||
               (candidateAt == existingAt && string.CompareOrdinal(candidate.GuildbookCaptureId, existing.GuildbookCaptureId) <= 0);
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
            _cacheByInstallation.Clear();
            _activeInstallationId = null;
            previous = _identityCancellation;
            _identityCancellation = new CancellationTokenSource();
        }
        try { previous.Cancel(); } finally { previous.Dispose(); }
        Changed?.Invoke(Array.Empty<ForeverDbGuild>());
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
