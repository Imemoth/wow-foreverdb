namespace ForeverDB.Companion.Account;

public enum AccountLinkOutcome
{
    Connected,
    FeatureDisabled,
    InvalidInstallation,
    SignInRequired,
    NoAnonymousOwner,
    NotOwnedByAnonymousIdentity,
    AccountLimit,
    RateLimited,
    ServiceNotReady,
    CredentialUnavailable,
    OutcomeUnknown,
    DeviceRegistrationRequired
}

public sealed record AccountLinkResult(AccountLinkOutcome Outcome, bool OwnershipLinked, DeviceStatus? DeviceStatus = null)
{
    public override string ToString() => $"AccountLinkResult({Outcome}, ownershipLinked={OwnershipLinked})";
}

/// <summary>
/// Connects one existing anonymous installation to the signed-in account, then exchanges a one-time enrollment ticket for the
/// existing registered-device credential. Human and device sessions remain separate; neither bearer is placed in a URL or log.
/// </summary>
public sealed class AccountLinkService
{
    private readonly AccountSessionManager _sessions;
    private readonly OwnershipRpcClient _rpc;
    private readonly ClaimService _claims;
    private readonly DeviceRuntime? _device;
    private readonly SemaphoreSlim _single = new(1, 1);

    public AccountLinkService(AccountSessionManager sessions, OwnershipRpcClient rpc, ClaimService claims, DeviceRuntime? device)
    {
        _sessions = sessions;
        _rpc = rpc;
        _claims = claims;
        _device = device;
    }

    public async Task<AccountLinkResult> ConnectAsync(string installationId, string? deviceLabel, CancellationToken ct = default)
    {
        if (!_sessions.AccountsEnabled || _device is null)
        {
            return new(AccountLinkOutcome.FeatureDisabled, false);
        }

        if (!DeviceContract.InstallationIdPattern.IsMatch(installationId))
        {
            return new(AccountLinkOutcome.InvalidInstallation, false);
        }

        await _single.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var registered = await _sessions.GetAccessTokenAsync(SlotRole.Primary, ct).ConfigureAwait(false);
            if (!registered.Ok || registered.Kind != SessionKind.Registered)
            {
                return new(AccountLinkOutcome.SignInRequired, false);
            }

            // Check only the requested installation. Other local collector credentials are independent and must not block
            // enrollment or cause an ownership transfer.
            var stored = _device.Context.Store.Read(installationId);
            if (stored.Status is DeviceCredentialStatus.Unreadable or DeviceCredentialStatus.IoError)
            {
                _device.Enrollment.LoadLocalState();
                return new(AccountLinkOutcome.DeviceRegistrationRequired, false, _device.Status);
            }

            var linked = await _rpc.LinkStatusAsync(registered.AccessToken, installationId, ct).ConfigureAwait(false);
            if (!linked.Ok)
            {
                return Failure(linked.Failure, ownershipLinked: false);
            }

            var ownershipLinked = linked.Value == LinkState.Owned;
            if (stored.Status == DeviceCredentialStatus.Ok && !ownershipLinked)
            {
                return new(AccountLinkOutcome.DeviceRegistrationRequired, false, _device.Status);
            }

            if (!ownershipLinked)
            {
                var claim = await _claims.StartClaimAsync(installationId, ct).ConfigureAwait(false);
                if (claim.Outcome != ClaimStartOutcome.Granted || claim.Offer is null)
                {
                    return ClaimFailure(claim.Outcome);
                }

                RpcResult<ClaimRedeemReply> redeemed;
                using (var offer = claim.Offer)
                {
                    try
                    {
                        redeemed = await _rpc.ClaimRedeemAsync(registered.AccessToken, offer.CanonicalCode, installationId, ct).ConfigureAwait(false);
                    }
                    finally
                    {
                        _claims.Dismiss(installationId);
                    }
                }
                if (!redeemed.Ok)
                {
                    // A write reply can be lost after commit. Reconcile once with the same registered session; never retry redemption.
                    var reconciled = await _rpc.LinkStatusAsync(registered.AccessToken, installationId, ct).ConfigureAwait(false);
                    if (!reconciled.Ok || reconciled.Value != LinkState.Owned)
                    {
                        return redeemed.Failure == RpcFailure.Unavailable
                            ? new(AccountLinkOutcome.OutcomeUnknown, false)
                            : Failure(redeemed.Failure, ownershipLinked: false);
                    }
                }
                else if (!redeemed.Value!.Linked)
                {
                    return new(
                        redeemed.Value.AccountLimit ? AccountLinkOutcome.AccountLimit : AccountLinkOutcome.NotOwnedByAnonymousIdentity,
                        false);
                }

                ownershipLinked = true;
            }

            await _claims.CheckLinkStatusAsync(installationId, ct).ConfigureAwait(false);

            if (stored.Status == DeviceCredentialStatus.Ok &&
                string.Equals(stored.Credential!.InstallationId, installationId, StringComparison.Ordinal))
            {
                _device.Enrollment.LoadLocalState();
                return new(AccountLinkOutcome.Connected, true, _device.Status);
            }

            var issued = await _rpc.IssueEnrollmentTicketAsync(registered.AccessToken, deviceLabel, ct).ConfigureAwait(false);
            if (!issued.Ok)
            {
                return Failure(issued.Failure, ownershipLinked: true);
            }

            if (!issued.Value!.Issued || issued.Value.Ticket is null)
            {
                return new(AccountLinkOutcome.DeviceRegistrationRequired, true, _device.Status);
            }

            var deviceStatus = await _device.Enrollment.EnrollTicketAsync(issued.Value.Ticket, installationId, ct).ConfigureAwait(false);
            return deviceStatus.State == DeviceState.Registered
                ? new(AccountLinkOutcome.Connected, true, deviceStatus)
                : new(AccountLinkOutcome.DeviceRegistrationRequired, true, deviceStatus);
        }
        finally
        {
            _single.Release();
        }
    }

    private static AccountLinkResult ClaimFailure(ClaimStartOutcome outcome) => outcome switch
    {
        ClaimStartOutcome.FeatureDisabled => new(AccountLinkOutcome.FeatureDisabled, false),
        ClaimStartOutcome.InvalidInstallation => new(AccountLinkOutcome.InvalidInstallation, false),
        ClaimStartOutcome.NoAnonymousOwner => new(AccountLinkOutcome.NoAnonymousOwner, false),
        ClaimStartOutcome.NotOwnedByAnonymousIdentity or ClaimStartOutcome.AlreadyTransferred or ClaimStartOutcome.NotAvailable =>
            new(AccountLinkOutcome.NotOwnedByAnonymousIdentity, false),
        ClaimStartOutcome.RateLimited => new(AccountLinkOutcome.RateLimited, false),
        ClaimStartOutcome.NotDeployed => new(AccountLinkOutcome.ServiceNotReady, false),
        ClaimStartOutcome.OutcomeUnknown => new(AccountLinkOutcome.OutcomeUnknown, false),
        _ => new(AccountLinkOutcome.CredentialUnavailable, false)
    };

    private static AccountLinkResult Failure(RpcFailure failure, bool ownershipLinked) => failure switch
    {
        RpcFailure.RateLimited => new(AccountLinkOutcome.RateLimited, ownershipLinked),
        RpcFailure.NotDeployed => new(AccountLinkOutcome.ServiceNotReady, ownershipLinked),
        RpcFailure.Unavailable => new(AccountLinkOutcome.OutcomeUnknown, ownershipLinked),
        RpcFailure.InvalidRequest => new(AccountLinkOutcome.InvalidInstallation, ownershipLinked),
        _ => new(AccountLinkOutcome.CredentialUnavailable, ownershipLinked)
    };
}
