using System.Collections.Concurrent;

namespace ForeverDB.Companion.Account;

/// <summary>
/// Ownership-aware snapshot upload. For each installation it (1) serialises concurrent requests, (2) skips
/// snapshots already uploaded by the SAME owner and identity generation, (3) asks the router for the one
/// credential proven to own the installation, (4) ingests with exactly that credential, and (5) discards the
/// result if the identity changed meanwhile. It never retries a refused ingest with another credential.
/// </summary>
public sealed class InstallationSyncCoordinator
{
    private readonly AccountSessionManager _manager;
    private readonly OwnershipRouter _router;
    private readonly OwnershipRpcClient _rpc;
    private readonly TimeProvider _clock;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _installationGates = new(StringComparer.Ordinal);
    // Keyed by installation AND owner AND identity generation: an upload under one identity is never "synced" for another.
    private readonly ConcurrentDictionary<(string Installation, string Owner, long Generation), long> _lastSynced = new();
    private readonly ConcurrentDictionary<string, InstallationRecord> _records = new(StringComparer.Ordinal);
    private CancellationTokenSource _generationCts = new();
    private readonly object _ctsLock = new();

    public InstallationSyncCoordinator(AccountSessionManager manager, OwnershipRouter router, OwnershipRpcClient rpc, TimeProvider? clock = null)
    {
        _manager = manager;
        _router = router;
        _rpc = rpc;
        _clock = clock ?? TimeProvider.System;
        _manager.IdentityChanged += OnIdentityChanged;
    }

    /// <summary>Raised when an installation's visible account state changed (never for stale work).</summary>
    public event Action<InstallationRecord>? InstallationChanged;

    public IReadOnlyList<InstallationRecord> Installations =>
        _records.Values.OrderBy(r => r.InstallationId, StringComparer.Ordinal).ToArray();

    public OwnershipRouter Router => _router;

    /// <summary>Registers a locally discovered installation (from SavedVariables) without any remote call.</summary>
    public void NoteLocalInstallation(string installationId)
    {
        _records.TryAdd(installationId, new InstallationRecord(installationId, InstallationOwnership.Unchecked, null, BlockReason.None, null, false));
    }

    public void MarkClaimPending(string installationId, bool pending)
    {
        Update(installationId, r => r with { ClaimPending = pending });
    }

    public void SelectOwner(string installationId, OwnerChoice choice)
    {
        _router.SelectOwner(installationId, choice);
        Update(installationId, r => r with { Ownership = InstallationOwnership.Unchecked, LastBlock = BlockReason.None });
    }

    private void OnIdentityChanged(long generation)
    {
        // Account-scoped caches die with the identity; in-flight requests are cancelled.
        _lastSynced.Clear();
        _router.ForgetAll();
        CancellationTokenSource previous;
        lock (_ctsLock)
        {
            previous = _generationCts;
            _generationCts = new CancellationTokenSource();
        }

        try { previous.Cancel(); } catch (ObjectDisposedException) { }

        foreach (var id in _records.Keys)
        {
            Update(id, r => r with { Ownership = InstallationOwnership.Unchecked, OwnerRole = null, LastBlock = BlockReason.None, ClaimPending = false });
        }
    }

    private CancellationToken CurrentGenerationToken()
    {
        lock (_ctsLock)
        {
            return _generationCts.Token;
        }
    }

    public async Task<SyncAttempt> SyncAsync(
        string installationId,
        string snapshotJson,
        long snapshotUpdatedAt,
        bool force,
        CancellationToken ct)
    {
        NoteLocalInstallation(installationId);
        var gate = _installationGates.GetOrAdd(installationId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            for (var attempt = 0; ; attempt++)
            {
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, CurrentGenerationToken());
                var progress = new Progress();
                try
                {
                    return await SyncLockedAsync(installationId, snapshotJson, snapshotUpdatedAt, force, progress, linked.Token).ConfigureAwait(false);
                }
                catch (Exception ex) when (!ct.IsCancellationRequested && (ex is OperationCanceledException || ex is IdentityMovedException))
                {
                    // The identity changed. If nothing was uploaded yet (it moved while ownership was being resolved,
                    // e.g. the server just revealed a dead session), evaluate once more under the new identity;
                    // otherwise nothing may be reported for the old identity.
                    if (progress.IngestSent || attempt >= 1)
                    {
                        return Stale();
                    }
                }
            }
        }
        finally
        {
            gate.Release();
        }
    }

    private sealed class Progress
    {
        public bool IngestSent;
    }

    private sealed class IdentityMovedException : Exception
    {
    }

    private async Task<SyncAttempt> SyncLockedAsync(string id, string json, long updatedAt, bool force, Progress progress, CancellationToken ct)
    {
        var generation = _manager.Generation;
        var route = await _router.ResolveAsync(id, forceRefresh: false, ct).ConfigureAwait(false);

        if (_manager.Generation != generation || route.Generation != generation)
        {
            throw new IdentityMovedException();
        }

        if (!route.CanIngest)
        {
            Update(id, r => r with { Ownership = route.Ownership, OwnerRole = null, LastBlock = route.Block });
            return SyncAttempt.Blocked(route.Block, route.Ownership);
        }

        var cacheKey = (id, route.UserId!, generation);
        if (!force && _lastSynced.TryGetValue(cacheKey, out var last) && updatedAt <= last)
        {
            return new SyncAttempt(SyncOutcome.UpToDate, BlockReason.None, route.Ownership, route.Role, route.Kind);
        }

        // Fresh token for exactly the credential the route proved; refuse if anything shifted underneath us.
        var token = await _manager.GetAccessTokenAsync(route.Role!.Value, ct).ConfigureAwait(false);
        if (!token.Ok || token.UserId != route.UserId || token.Generation != generation)
        {
            _router.Invalidate(id);
            if (token.Generation != generation)
            {
                throw new IdentityMovedException();
            }

            return SyncAttempt.Blocked(MapTokenFault(token), route.Ownership);
        }

        progress.IngestSent = true;
        var result = await _rpc.IngestAsync(token.AccessToken, json, ct).ConfigureAwait(false);

        if (_manager.Generation != generation)
        {
            // Login/logout/switch happened while the request was in flight: do not mark anything synced.
            return Stale();
        }

        if (result.Ok)
        {
            _lastSynced[cacheKey] = updatedAt;
            var now = _clock.GetUtcNow();
            Update(id, r => r with { Ownership = route.Ownership, OwnerRole = route.Role, LastBlock = BlockReason.None, LastSyncedAt = now });
            // The server accepted the snapshot, so the owner is now established for an explicitly chosen installation.
            _router.ClearChoice(id);
            return new SyncAttempt(SyncOutcome.Synced, BlockReason.None, route.Ownership, route.Role, route.Kind);
        }

        _router.Invalidate(id);
        var reason = result.Failure switch
        {
            RpcFailure.OwnerMismatch => BlockReason.OwnerMismatch,
            RpcFailure.Unauthorized => BlockReason.Unauthorized,
            RpcFailure.Forbidden => BlockReason.Forbidden,
            RpcFailure.RateLimited => BlockReason.RateLimited,
            RpcFailure.Unavailable => BlockReason.ServerUnavailable,
            RpcFailure.NotDeployed => BlockReason.NotDeployed,
            _ => BlockReason.InvalidRequest
        };

        if (result.Failure == RpcFailure.OwnerMismatch)
        {
            // The ownership we believed in is wrong (transfer between authorization and ingest, or a wrong explicit
            // choice). Do NOT retry with another credential: forget the cached route and the choice, show the state.
            _router.ClearChoice(id);
            Update(id, r => r with { Ownership = InstallationOwnership.Unchecked, OwnerRole = null, LastBlock = reason });
        }
        else
        {
            Update(id, r => r with { LastBlock = reason });
        }

        var outcome = result.Failure is RpcFailure.InvalidRequest or RpcFailure.MalformedResponse ? SyncOutcome.Failed : SyncOutcome.Blocked;
        return new SyncAttempt(outcome, reason, route.Ownership, route.Role, route.Kind);
    }

    private static BlockReason MapTokenFault(TokenResult token) => token.StateAfter switch
    {
        SessionState.ReauthRequired => BlockReason.ReauthRequired,
        SessionState.AnonymousIdentityLost => BlockReason.AnonymousIdentityLost,
        _ => token.Fault switch
        {
            SessionFault.RateLimited => BlockReason.RateLimited,
            SessionFault.FeatureDisabled => BlockReason.FeatureDisabled,
            _ => BlockReason.CredentialUnavailable
        }
    };

    private static SyncAttempt Stale() =>
        new(SyncOutcome.StaleDiscarded, BlockReason.None, InstallationOwnership.Unchecked, null, null);

    internal void Update(string id, Func<InstallationRecord, InstallationRecord> change)
    {
        var updated = _records.AddOrUpdate(
            id,
            _ => change(new InstallationRecord(id, InstallationOwnership.Unchecked, null, BlockReason.None, null, false)),
            (_, existing) => change(existing));
        InstallationChanged?.Invoke(updated);
    }
}
