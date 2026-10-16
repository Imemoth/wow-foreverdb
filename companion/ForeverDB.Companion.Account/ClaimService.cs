namespace ForeverDB.Companion.Account;

/// <summary>
/// A backend-issued claim code held in memory only. Never persisted, never logged, never part of ToString.
/// Disposing wipes the buffer.
/// </summary>
public sealed class ClaimOffer : IDisposable
{
    private char[]? _code;

    internal ClaimOffer(string installationId, string canonicalCode, DateTimeOffset expiresAt)
    {
        InstallationId = installationId;
        _code = canonicalCode.ToCharArray();
        ExpiresAt = expiresAt;
    }

    public string InstallationId { get; }
    public DateTimeOffset ExpiresAt { get; }

    /// <summary>The approved display format FDB-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX.</summary>
    public string DisplayCode =>
        _code is { } c ? Contract.FormatClaimCode(new string(c)) : throw new ObjectDisposedException(nameof(ClaimOffer));

    public bool IsDisposed => _code is null;

    public bool IsExpired(TimeProvider clock) => clock.GetUtcNow() >= ExpiresAt;

    public TimeSpan Remaining(TimeProvider clock)
    {
        var left = ExpiresAt - clock.GetUtcNow();
        return left < TimeSpan.Zero ? TimeSpan.Zero : left;
    }

    public void Dispose()
    {
        var code = Interlocked.Exchange(ref _code, null);
        if (code is not null)
        {
            Array.Clear(code);
        }
    }

    public override string ToString() => "ClaimOffer(redacted)";
}

public enum ClaimStartOutcome
{
    Granted,
    FeatureDisabled,
    InvalidInstallation,
    /// <summary>No usable anonymous owner credential exists (registered-only session, or the anonymous identity is lost).</summary>
    NoAnonymousOwner,
    /// <summary>The anonymous owner credential does not own this installation.</summary>
    NotOwnedByAnonymousIdentity,
    /// <summary>The server already moved this installation to a registered account.</summary>
    AlreadyTransferred,
    /// <summary>Backend business rejection (indistinguishable by design).</summary>
    NotAvailable,
    RateLimited,
    /// <summary>The anonymous session is no longer accepted as a live session.</summary>
    SessionNotAccepted,
    NotDeployed,
    /// <summary>Network/server failure. The outcome is UNKNOWN: no automatic retry; a new request invalidates any earlier code.</summary>
    OutcomeUnknown,
    CredentialUnavailable,
    AnonymousTokenNeedsRefresh,
    MalformedResponse
}

public sealed record ClaimStartResult(ClaimStartOutcome Outcome, ClaimOffer? Offer);

public enum LinkCheckOutcome
{
    /// <summary>Still owned by the anonymous identity: nothing transferred.</summary>
    StillOwnedByAnonymousIdentity,
    /// <summary>The backend confirms the installation now belongs to the registered account (or a claim was redeemed).</summary>
    TransferConfirmed,
    /// <summary>Owned by the signed-in registered account, with no claim of ours pending for it.</summary>
    OwnedByRegisteredAccount,
    TransferredSignInRequired,
    OwnedByDifferentAccount,
    Unknown,
    Unavailable
}

/// <summary>
/// Companion side of the ownership claim protocol: request a backend-generated code with the ANONYMOUS owner
/// credential, show it, and only report a transfer once fdb_installation_link_status confirms it. Redemption is a
/// website feature (PR E) and is deliberately absent here.
/// </summary>
public sealed class ClaimService
{
    private readonly AccountSessionManager _manager;
    private readonly OwnershipRpcClient _rpc;
    private readonly OwnershipRouter _router;
    private readonly InstallationSyncCoordinator _coordinator;
    private readonly TimeProvider _clock;
    private readonly bool _allowClaims;
    private readonly string? _scopedInstallationId;
    private readonly SemaphoreSlim _single = new(1, 1);
    private readonly Dictionary<string, ClaimOffer> _offers = new(StringComparer.Ordinal);

    public ClaimService(
        AccountSessionManager manager,
        OwnershipRpcClient rpc,
        OwnershipRouter router,
        InstallationSyncCoordinator coordinator,
        TimeProvider? clock = null,
        bool allowClaims = true,
        string? scopedInstallationId = null)
    {
        _scopedInstallationId = scopedInstallationId;
        _allowClaims = allowClaims;
        _manager = manager;
        _rpc = rpc;
        _router = router;
        _coordinator = coordinator;
        _clock = clock ?? TimeProvider.System;
        _manager.IdentityChanged += _ => DismissAll();
    }

    public ClaimOffer? OfferFor(string installationId)
    {
        lock (_offers)
        {
            return _offers.TryGetValue(installationId, out var offer) && !offer.IsDisposed ? offer : null;
        }
    }

    public async Task<ClaimStartResult> StartClaimAsync(string installationId, CancellationToken ct)
    {
        if (!_manager.AccountsEnabled || !_allowClaims ||
            (_scopedInstallationId is not null && !string.Equals(installationId, _scopedInstallationId, StringComparison.Ordinal)))
        {
            return new ClaimStartResult(ClaimStartOutcome.FeatureDisabled, null);
        }

        if (!OwnershipRpcClient.InstallationIdPattern.IsMatch(installationId))
        {
            return new ClaimStartResult(ClaimStartOutcome.InvalidInstallation, null);
        }

        await _single.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var status = _manager.Status;
            SlotRole? role = status.State is SessionState.Anonymous or SessionState.AnonymousClaiming
                ? SlotRole.Primary
                : status.HasLegacyOwner ? SlotRole.LegacyOwner : null;
            if (role is not { } anonymousRole)
            {
                return new ClaimStartResult(ClaimStartOutcome.NoAnonymousOwner, null);
            }

            var generation = _manager.Generation;
            var token = await _manager.GetAccessTokenAsync(anonymousRole, ct).ConfigureAwait(false);
            if (!token.Ok || token.Kind != SessionKind.Anonymous)
            {
                // A registered token must never be used for claim_start.
                return new ClaimStartResult(
                    token.Fault switch
                    {
                        SessionFault.AuthRejected or SessionFault.LocalCredentialCorrupt =>
                            ClaimStartOutcome.NoAnonymousOwner,
                        SessionFault.LegacyOwnerRefreshRequired =>
                            ClaimStartOutcome.AnonymousTokenNeedsRefresh,
                        _ => ClaimStartOutcome.CredentialUnavailable
                    },
                    null);
            }

            // Prove the anonymous identity actually owns this installation before asking for a code.
            var link = await _rpc.LinkStatusAsync(token.AccessToken, installationId, ct).ConfigureAwait(false);
            if (!link.Ok)
            {
                return new ClaimStartResult(MapLinkFailure(link.Failure), null);
            }

            if (link.Value == LinkState.Transferred)
            {
                _router.Invalidate(installationId);
                return new ClaimStartResult(ClaimStartOutcome.AlreadyTransferred, null);
            }

            if (link.Value != LinkState.Owned)
            {
                return new ClaimStartResult(ClaimStartOutcome.NotOwnedByAnonymousIdentity, null);
            }

            var started = await _rpc.ClaimStartAsync(token.AccessToken, installationId, ct).ConfigureAwait(false);
            if (_manager.Generation != generation)
            {
                // The identity changed while the request was in flight: discard, show nothing.
                return new ClaimStartResult(ClaimStartOutcome.CredentialUnavailable, null);
            }

            if (!started.Ok)
            {
                return new ClaimStartResult(MapStartFailure(started.Failure), null);
            }

            if (!started.Value!.Granted)
            {
                return new ClaimStartResult(ClaimStartOutcome.NotAvailable, null);
            }

            var offer = new ClaimOffer(installationId, started.Value.Code!, started.Value.ExpiresAt);
            lock (_offers)
            {
                // The backend revoked the previous pending code for this installation when issuing this one.
                if (_offers.TryGetValue(installationId, out var previous))
                {
                    previous.Dispose();
                }

                _offers[installationId] = offer;
            }

            _manager.SetClaimPending(true);
            _coordinator.MarkClaimPending(installationId, true);
            return new ClaimStartResult(ClaimStartOutcome.Granted, offer);
        }
        finally
        {
            _single.Release();
        }
    }

    public void Dismiss(string installationId)
    {
        bool any;
        lock (_offers)
        {
            if (_offers.Remove(installationId, out var offer))
            {
                offer.Dispose();
            }

            any = _offers.Count > 0;
        }

        _coordinator.MarkClaimPending(installationId, false);
        _manager.SetClaimPending(any);
    }

    private void DismissAll()
    {
        string[] ids;
        lock (_offers)
        {
            ids = _offers.Keys.ToArray();
            foreach (var offer in _offers.Values)
            {
                offer.Dispose();
            }

            _offers.Clear();
        }

        foreach (var id in ids)
        {
            _coordinator.MarkClaimPending(id, false);
        }
    }

    /// <summary>
    /// Asks the backend (never assumes) whether ownership moved. Transfer is reported only when
    /// fdb_installation_link_status says so for the credentials we hold.
    /// </summary>
    public async Task<LinkCheckOutcome> CheckLinkStatusAsync(string installationId, CancellationToken ct)
    {
        if (_scopedInstallationId is not null &&
            !string.Equals(installationId, _scopedInstallationId, StringComparison.Ordinal))
            return LinkCheckOutcome.Unavailable;
        var hadOffer = OfferFor(installationId) is not null;
        var route = await _router.ResolveAsync(installationId, forceRefresh: true, ct).ConfigureAwait(false);

        switch (route.Ownership)
        {
            case InstallationOwnership.OwnedByAnonymousIdentity:
                _coordinator.Update(installationId, r => r with { Ownership = route.Ownership, OwnerRole = route.Role, LastBlock = BlockReason.None });
                return LinkCheckOutcome.StillOwnedByAnonymousIdentity;

            case InstallationOwnership.OwnedByRegisteredAccount:
                _coordinator.Update(installationId, r => r with { Ownership = route.Ownership, OwnerRole = route.Role, LastBlock = BlockReason.None });
                if (hadOffer)
                {
                    Dismiss(installationId);
                    return LinkCheckOutcome.TransferConfirmed;
                }

                return LinkCheckOutcome.OwnedByRegisteredAccount;

            case InstallationOwnership.TransferredSignInRequired:
                _coordinator.Update(installationId, r => r with { Ownership = route.Ownership, OwnerRole = null, LastBlock = route.Block });
                if (hadOffer)
                {
                    Dismiss(installationId);
                }

                return LinkCheckOutcome.TransferredSignInRequired;

            case InstallationOwnership.OwnedByDifferentAccount:
                _coordinator.Update(installationId, r => r with { Ownership = route.Ownership, OwnerRole = null, LastBlock = route.Block });
                return LinkCheckOutcome.OwnedByDifferentAccount;

            case InstallationOwnership.OwnerSelectionRequired:
                return LinkCheckOutcome.Unknown;

            default:
                return LinkCheckOutcome.Unavailable;
        }
    }

    private static ClaimStartOutcome MapLinkFailure(RpcFailure failure) => failure switch
    {
        RpcFailure.Unauthorized or RpcFailure.Forbidden => ClaimStartOutcome.SessionNotAccepted,
        RpcFailure.RateLimited => ClaimStartOutcome.RateLimited,
        RpcFailure.NotDeployed => ClaimStartOutcome.NotDeployed,
        RpcFailure.MalformedResponse => ClaimStartOutcome.MalformedResponse,
        RpcFailure.InvalidRequest => ClaimStartOutcome.InvalidInstallation,
        _ => ClaimStartOutcome.CredentialUnavailable
    };

    private static ClaimStartOutcome MapStartFailure(RpcFailure failure) => failure switch
    {
        RpcFailure.Unauthorized or RpcFailure.Forbidden => ClaimStartOutcome.SessionNotAccepted,
        RpcFailure.RateLimited => ClaimStartOutcome.RateLimited,
        RpcFailure.NotDeployed => ClaimStartOutcome.NotDeployed,
        RpcFailure.MalformedResponse => ClaimStartOutcome.MalformedResponse,
        RpcFailure.InvalidRequest => ClaimStartOutcome.InvalidInstallation,
        // The request may or may not have created a code; never auto-retry.
        _ => ClaimStartOutcome.OutcomeUnknown
    };
}
