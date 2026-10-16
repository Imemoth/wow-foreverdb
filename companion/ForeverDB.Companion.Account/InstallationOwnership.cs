using System.Collections.Concurrent;

namespace ForeverDB.Companion.Account;

/// <summary>What is currently proven (by the server) about who may write an installation.</summary>
public enum InstallationOwnership
{
    Unchecked,
    /// <summary>The verified registered account owns it (fdb_installation_link_status = owned with the registered token).</summary>
    OwnedByRegisteredAccount,
    /// <summary>An anonymous identity (primary or preserved legacy credential) owns it.</summary>
    OwnedByAnonymousIdentity,
    /// <summary>Ownership moved to a registered account and no registered session is available: sign in.</summary>
    TransferredSignInRequired,
    /// <summary>Ownership moved to a different registered account than the signed-in one.</summary>
    OwnedByDifferentAccount,
    /// <summary>Neither credential owns it (a new installation, or someone else's): the user must pick an owner explicitly.</summary>
    OwnerSelectionRequired,
    /// <summary>The registered session is unusable (reauthentication required); nothing is guessed.</summary>
    ReauthRequired,
    NoCredential,
    /// <summary>Ownership could not be established (network, rate limit, RPC unavailable, contradictory replies). Fail closed.</summary>
    Unavailable,
    Conflict
}

public enum SyncOutcome
{
    Synced,
    UpToDate,
    Blocked,
    Failed,
    /// <summary>The identity changed while the request was in flight; the result was discarded.</summary>
    StaleDiscarded
}

public enum BlockReason
{
    None,
    NoCredential,
    ReauthRequired,
    AnonymousIdentityLost,
    TransferredSignInRequired,
    OwnedByDifferentAccount,
    OwnerSelectionRequired,
    OwnershipConflict,
    OwnershipUnavailable,
    OwnerMismatch,
    Unauthorized,
    Forbidden,
    RateLimited,
    ServerUnavailable,
    NotDeployed,
    FeatureDisabled,
    PilotUploadDisabled,
    CredentialUnavailable,
    InvalidRequest,
    /// <summary>The installation belongs to this computer's registered device: automatic upload is off, only Sync now uploads.</summary>
    DeviceAutoSyncOff,
    /// <summary>The registered-device upload did not run or was refused; the Registered device line says why.</summary>
    DeviceSyncNotCompleted
}

public sealed record SyncAttempt(
    SyncOutcome Outcome,
    BlockReason Reason,
    InstallationOwnership Ownership,
    SlotRole? Role,
    SessionKind? Kind)
{
    public static SyncAttempt Blocked(BlockReason reason, InstallationOwnership ownership = InstallationOwnership.Unchecked) =>
        new(SyncOutcome.Blocked, reason, ownership, null, null);
}

public sealed record InstallationRecord(
    string InstallationId,
    InstallationOwnership Ownership,
    SlotRole? OwnerRole,
    BlockReason LastBlock,
    DateTimeOffset? LastSyncedAt,
    bool ClaimPending);

/// <summary>An explicit user decision for an installation no credential is proven to own yet.</summary>
public enum OwnerChoice
{
    RegisteredAccount,
    AnonymousIdentity
}

/// <summary>
/// Chooses, per installation, the ONE credential that may write it, from server-verified ownership
/// (fdb_installation_link_status). Order: registered session, then the anonymous owner credential.
/// Unknown, conflicting or unavailable ownership fails closed. It never creates an identity and never
/// adopts an unknown installation unless the user explicitly chose an owner.
/// </summary>
public sealed class OwnershipRouter
{
    private static readonly TimeSpan CacheLife = TimeSpan.FromMinutes(5);

    private readonly AccountSessionManager _manager;
    private readonly OwnershipRpcClient _rpc;
    private readonly TimeProvider _clock;
    private readonly ConcurrentDictionary<string, CachedRoute> _cache = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, OwnerChoice> _choices = new(StringComparer.Ordinal);

    public OwnershipRouter(AccountSessionManager manager, OwnershipRpcClient rpc, TimeProvider? clock = null)
    {
        _manager = manager;
        _rpc = rpc;
        _clock = clock ?? TimeProvider.System;
    }

    public sealed record RouteDecision(
        InstallationOwnership Ownership,
        BlockReason Block,
        SlotRole? Role,
        SessionKind? Kind,
        string? UserId,
        long Generation)
    {
        public bool CanIngest => Role is not null && Block == BlockReason.None;
    }

    private sealed record CachedRoute(RouteDecision Decision, DateTimeOffset At);

    public void ForgetAll()
    {
        _cache.Clear();
        _choices.Clear();
    }

    public void Invalidate(string installationId) => _cache.TryRemove(installationId, out _);

    /// <summary>The user explicitly picked who owns a not-yet-owned installation. Memory only: the server is the truth.</summary>
    public void SelectOwner(string installationId, OwnerChoice choice)
    {
        _choices[installationId] = choice;
        _cache.TryRemove(installationId, out _);
    }

    public void ClearChoice(string installationId) => _choices.TryRemove(installationId, out _);

    public async Task<RouteDecision> ResolveAsync(string installationId, bool forceRefresh, CancellationToken ct)
    {
        var generation = _manager.Generation;
        if (!_manager.AccountsEnabled)
        {
            return await ResolveLegacyBehaviourAsync(generation, ct).ConfigureAwait(false);
        }

        if (!forceRefresh && _cache.TryGetValue(installationId, out var cached) &&
            cached.Decision.Generation == generation &&
            _clock.GetUtcNow() - cached.At < CacheLife &&
            cached.Decision.CanIngest)
        {
            return cached.Decision;
        }

        var decision = await ResolveFreshAsync(installationId, generation, ct).ConfigureAwait(false);
        if (_manager.Generation == generation)
        {
            _cache[installationId] = new CachedRoute(decision, _clock.GetUtcNow());
        }

        return decision;
    }

    // Production behaviour (Account System V1 off): exactly the 0.8.x protocol with the anonymous primary
    // credential. No ownership RPC exists there and none is called.
    private async Task<RouteDecision> ResolveLegacyBehaviourAsync(long generation, CancellationToken ct)
    {
        var token = await _manager.GetAccessTokenAsync(SlotRole.Primary, ct).ConfigureAwait(false);
        if (!token.Ok)
        {
            return Unusable(token, generation);
        }

        return new RouteDecision(InstallationOwnership.OwnedByAnonymousIdentity, BlockReason.None, SlotRole.Primary, token.Kind, token.UserId, generation);
    }

    private async Task<RouteDecision> ResolveFreshAsync(string installationId, long generation, CancellationToken ct)
    {
        var status = _manager.Status;
        var registeredUnusable = false;
        var registeredChecked = false;
        var transferred = false;
        var sawCredential = false;

        // 1. The registered session, when there is one.
        if (status.State is SessionState.Registered or SessionState.ReauthRequired && status.PrimaryCredentialPresent)
        {
            sawCredential = true;
            var token = await _manager.GetAccessTokenAsync(SlotRole.Primary, ct).ConfigureAwait(false);
            if (token.Ok && token.Kind == SessionKind.Registered)
            {
                registeredChecked = true;
                var link = await _rpc.LinkStatusAsync(token.AccessToken, installationId, ct).ConfigureAwait(false);
                if (!link.Ok)
                {
                    return Block(InstallationOwnership.Unavailable, BlockReason.OwnershipUnavailable, generation);
                }

                switch (link.Value)
                {
                    case LinkState.Owned:
                        return new RouteDecision(InstallationOwnership.OwnedByRegisteredAccount, BlockReason.None, SlotRole.Primary, SessionKind.Registered, token.UserId, generation);
                    case LinkState.Transferred:
                        // A registered account cannot be a previous owner in V1; a contradictory reply fails closed.
                        return Block(InstallationOwnership.Conflict, BlockReason.OwnershipConflict, generation);
                }
            }
            else if (token.Fault is SessionFault.NetworkUnavailable or SessionFault.RateLimited or SessionFault.LockTimeout or SessionFault.StorageFailure)
            {
                return Block(InstallationOwnership.Unavailable, BlockReason.OwnershipUnavailable, generation);
            }
            else
            {
                registeredUnusable = true;
            }
        }

        // 2. The anonymous owner credential: the primary one in anonymous mode, otherwise the preserved legacy slot.
        SlotRole? anonymousRole = status.State is SessionState.Anonymous or SessionState.AnonymousClaiming
            ? SlotRole.Primary
            : status.HasLegacyOwner ? SlotRole.LegacyOwner : null;

        var anonymousUsable = false;
        if (anonymousRole is { } role)
        {
            sawCredential = true;
            var token = await _manager.GetAccessTokenAsync(role, ct).ConfigureAwait(false);
            if (token.Ok && token.Kind == SessionKind.Anonymous)
            {
                anonymousUsable = true;
                var link = await _rpc.LinkStatusAsync(token.AccessToken, installationId, ct).ConfigureAwait(false);
                if (!link.Ok)
                {
                    return Block(InstallationOwnership.Unavailable, BlockReason.OwnershipUnavailable, generation);
                }

                switch (link.Value)
                {
                    case LinkState.Owned:
                        return new RouteDecision(InstallationOwnership.OwnedByAnonymousIdentity, BlockReason.None, role, SessionKind.Anonymous, token.UserId, generation);
                    case LinkState.Transferred:
                        transferred = true;
                        break;
                }
            }
            else if (token.Fault is SessionFault.NetworkUnavailable or SessionFault.RateLimited or SessionFault.LockTimeout or SessionFault.StorageFailure)
            {
                return Block(InstallationOwnership.Unavailable, BlockReason.OwnershipUnavailable, generation);
            }
        }

        // 3. Conclusions. Nothing below ever picks a credential on its own.
        if (transferred)
        {
            return registeredChecked
                ? Block(InstallationOwnership.OwnedByDifferentAccount, BlockReason.OwnedByDifferentAccount, generation)
                : Block(InstallationOwnership.TransferredSignInRequired, BlockReason.TransferredSignInRequired, generation);
        }

        if (registeredUnusable && !_choices.ContainsKey(installationId))
        {
            return Block(InstallationOwnership.ReauthRequired, BlockReason.ReauthRequired, generation);
        }

        if (!sawCredential && status.State == SessionState.AnonymousIdentityLost)
        {
            return Block(InstallationOwnership.Unavailable, BlockReason.AnonymousIdentityLost, generation);
        }

        if (!sawCredential)
        {
            return Block(InstallationOwnership.NoCredential, BlockReason.NoCredential, generation);
        }

        // 4. Unknown to every credential we hold: only an explicit user choice may establish an owner.
        if (_choices.TryGetValue(installationId, out var choice))
        {
            if (choice == OwnerChoice.RegisteredAccount && registeredChecked)
            {
                var token = await _manager.GetAccessTokenAsync(SlotRole.Primary, ct).ConfigureAwait(false);
                if (token.Ok && token.Kind == SessionKind.Registered)
                {
                    return new RouteDecision(InstallationOwnership.OwnedByRegisteredAccount, BlockReason.None, SlotRole.Primary, SessionKind.Registered, token.UserId, generation);
                }
            }
            else if (choice == OwnerChoice.AnonymousIdentity && anonymousUsable && anonymousRole is { } chosenRole)
            {
                var token = await _manager.GetAccessTokenAsync(chosenRole, ct).ConfigureAwait(false);
                if (token.Ok && token.Kind == SessionKind.Anonymous)
                {
                    return new RouteDecision(InstallationOwnership.OwnedByAnonymousIdentity, BlockReason.None, chosenRole, SessionKind.Anonymous, token.UserId, generation);
                }
            }

            _choices.TryRemove(installationId, out _);
        }

        return Block(InstallationOwnership.OwnerSelectionRequired, BlockReason.OwnerSelectionRequired, generation);
    }

    private static RouteDecision Block(InstallationOwnership ownership, BlockReason reason, long generation) =>
        new(ownership, reason, null, null, null, generation);

    private static RouteDecision Unusable(TokenResult token, long generation) => token.StateAfter switch
    {
        SessionState.AnonymousIdentityLost => Block(InstallationOwnership.Unavailable, BlockReason.AnonymousIdentityLost, generation),
        SessionState.ReauthRequired => Block(InstallationOwnership.ReauthRequired, BlockReason.ReauthRequired, generation),
        SessionState.LoggedOut when token.Fault == SessionFault.None => Block(InstallationOwnership.NoCredential, BlockReason.NoCredential, generation),
        _ => token.Fault switch
        {
            SessionFault.FeatureDisabled => Block(InstallationOwnership.Unavailable, BlockReason.FeatureDisabled, generation),
            SessionFault.RateLimited => Block(InstallationOwnership.Unavailable, BlockReason.RateLimited, generation),
            _ => Block(InstallationOwnership.Unavailable, BlockReason.CredentialUnavailable, generation)
        }
    };
}
