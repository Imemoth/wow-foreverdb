namespace ForeverDB.Companion.Account;

/// <summary>
/// Zero-touch first run: finds the activation file, redeems its ticket for a device credential with the device's own anonymous
/// session, stores that credential durably and only then deletes the file. Enrollment never reads or changes the legacy anonymous
/// session, the saved installations or SavedVariables; it enrolls the installation id the Addon already wrote, and the server
/// refuses (installation_conflict) any installation it cannot hand to the ticket's account, which fails closed here.
///
/// One enrollment at a time per computer: the whole flow runs under the device session gate, so a second Companion process waits,
/// then finds the credential and does not enroll again. Everything is attempted once per call; nothing loops.
/// </summary>
public sealed class DeviceEnrollmentService
{
    private readonly DeviceContext _ctx;
    private readonly IActivationSource _source;
    private readonly Func<IReadOnlyCollection<string>> _installations;
    private readonly bool _enabled;
    // The server consumed the ticket but the disk refused the secret: kept in memory so this process can still store it.
    private DeviceCredential? _unpersisted;
    // Tickets the server answered with a non-terminal refusal this process (conflict, limit): not tried again until restart.
    private readonly HashSet<string> _refused = new(StringComparer.Ordinal);

    public DeviceEnrollmentService(DeviceContext context, IActivationSource source, Func<IReadOnlyCollection<string>> installations, bool enabled = true)
    {
        _ctx = context;
        _source = source;
        _installations = installations;
        _enabled = enabled;
    }

    public DeviceStatus Status => _ctx.Status;

    /// <summary>
    /// Local-only classification, safe to call on the UI thread at startup: reads the device credential and looks for an activation
    /// file. No network, no gate, nothing created or deleted. Lets the sync layer know which installation is (or is about to be)
    /// device-owned before any upload can start.
    /// </summary>
    public DeviceStatus LoadLocalState()
    {
        if (!_enabled)
        {
            return _ctx.Status;
        }

        var read = _ctx.Store.Read();
        _ctx.NoteInstallation(read.Credential?.InstallationId ?? read.MarkerInstallationId);
        switch (read.Status)
        {
            case DeviceCredentialStatus.Ok:
                SetLocalRegistered();
                break;
            case DeviceCredentialStatus.Unreadable:
                _ctx.Set(DeviceState.CredentialDamaged);
                break;
            case DeviceCredentialStatus.Missing when _ctx.Status.State == DeviceState.Anonymous && _source.Discover().Count > 0:
                _ctx.Set(DeviceState.PendingActivation);
                break;
        }

        return _ctx.Status;
    }

    public async Task<DeviceStatus> InitializeAsync(CancellationToken ct = default)
    {
        if (!_enabled)
        {
            return _ctx.Status;
        }

        using var lease = await _ctx.TryAcquireAsync(ct).ConfigureAwait(false);
        if (lease is null)
        {
            _ctx.Set(_ctx.Status.State, DeviceDetail.LockTimeout);
            return _ctx.Status;
        }

        if (_unpersisted is { } held && TryStore(held))
        {
            _unpersisted = null;
            _source.Discover();
            _source.Remove(held.RedeemedTicketHash ?? "");
            _ctx.NoteInstallation(held.InstallationId);
            _ctx.Set(DeviceState.Registered);
            return _ctx.Status;
        }

        var read = _ctx.Store.Read();
        _ctx.NoteInstallation(read.Credential?.InstallationId ?? read.MarkerInstallationId);

        switch (read.Status)
        {
            case DeviceCredentialStatus.IoError:
                _ctx.Set(_ctx.Status.State, DeviceDetail.StorageFailure);
                return _ctx.Status;

            case DeviceCredentialStatus.Ok:
            {
                var credential = read.Credential!;
                if (read.Recovered)
                {
                    TryStore(credential);
                }

                SetLocalRegistered();
                var fresh = FreshCandidate(credential.RedeemedTicketHash);
                if (fresh is null)
                {
                    return _ctx.Status;
                }

                // A different activation file while a credential exists: redeem it only when the server says this device is not
                // active (revoked, replaced or unknown); an active device is never re-enrolled.
                var probe = await _ctx.ProbeAsync(credential, ct).ConfigureAwait(false);
                if (probe.State is null && probe.Token == DeviceTokenStatus.Ok)
                {
                    _ctx.Set(DeviceState.Registered, DeviceContext.DetailFor(probe.Failure));
                    return _ctx.Status;
                }

                if (probe.State is DeviceServerState.Active or DeviceServerState.AccountUnavailable)
                {
                    _ctx.ApplyServerState(probe.State.Value);
                    return _ctx.Status;
                }

                if (probe.State is null && probe.Token is DeviceTokenStatus.Unavailable or DeviceTokenStatus.RateLimited or DeviceTokenStatus.StorageFailure)
                {
                    _ctx.Set(DeviceState.Registered, probe.Token == DeviceTokenStatus.RateLimited ? DeviceDetail.RateLimited : DeviceDetail.Offline);
                    return _ctx.Status;
                }

                await RedeemAsync(fresh, credential, credential.InstallationId, ct).ConfigureAwait(false);
                return _ctx.Status;
            }

            case DeviceCredentialStatus.Unreadable:
            {
                // Damaged: never replaced silently. A fresh activation file is the explicit recovery; Write keeps the damaged blob as .bak.
                _ctx.Set(DeviceState.CredentialDamaged);
                var fresh = FreshCandidate(null);
                if (fresh is not null)
                {
                    await RedeemAsync(fresh, null, read.MarkerInstallationId, ct).ConfigureAwait(false);
                }

                return _ctx.Status;
            }

            default:
            {
                var fresh = FreshCandidate(null);
                if (fresh is null)
                {
                    if (_ctx.Status.State is DeviceState.Anonymous or DeviceState.PendingActivation)
                    {
                        _ctx.Set(DeviceState.Anonymous);
                    }

                    return _ctx.Status;
                }

                await RedeemAsync(fresh, null, null, ct).ConfigureAwait(false);
                return _ctx.Status;
            }
        }
    }

    private void SetLocalRegistered() => _ctx.MarkLocalRegistered();

    private ActivationCandidate? FreshCandidate(string? redeemedHash)
    {
        var all = _source.Discover();
        if (redeemedHash is not null)
        {
            // A leftover copy of the file this device was enrolled with (the delete failed or was interrupted): remove it.
            _source.Remove(redeemedHash);
        }

        return all.FirstOrDefault(c => c.Ticket.Hash != redeemedHash && !_refused.Contains(c.Ticket.Hash));
    }

    private async Task RedeemAsync(ActivationCandidate candidate, DeviceCredential? existing, string? knownInstallation, CancellationToken ct)
    {
        var ticket = candidate.Ticket;
        string installationId;
        if (knownInstallation is not null)
        {
            installationId = knownInstallation;
        }
        else
        {
            var found = _installations().Where(i => DeviceContract.InstallationIdPattern.IsMatch(i)).Distinct(StringComparer.Ordinal).ToArray();
            if (found.Length != 1)
            {
                _ctx.Set(DeviceState.PendingActivation, found.Length == 0 ? DeviceDetail.NoInstallation : DeviceDetail.MultipleInstallations);
                return;
            }

            installationId = found[0];
        }

        // Only a computer without a usable device credential may create its anonymous identity; re-activation of a registered
        // device reuses the session it has.
        var token = await _ctx.Session.GetTokenAsync(allowCreate: true, ct).ConfigureAwait(false);
        if (!token.Ok)
        {
            _ctx.Set(token.Status switch
            {
                DeviceTokenStatus.Damaged => DeviceState.CredentialDamaged,
                _ => DeviceState.PendingActivation
            }, token.Status switch
            {
                DeviceTokenStatus.RateLimited => DeviceDetail.RateLimited,
                DeviceTokenStatus.Refused => DeviceDetail.ServiceRefused,
                DeviceTokenStatus.StorageFailure => DeviceDetail.StorageFailure,
                DeviceTokenStatus.Damaged => DeviceDetail.SessionNotAccepted,
                _ => DeviceDetail.Offline
            });
            return;
        }

        var reply = await _ctx.Rpc.EnrollAsync(token.AccessToken, ticket, installationId, ct).ConfigureAwait(false);
        if (!reply.Ok && reply.Failure == RpcFailure.Unauthorized)
        {
            var refreshed = await _ctx.Session.ForceRefreshAsync(allowCreate: true, ct).ConfigureAwait(false);
            if (refreshed.Ok)
            {
                reply = await _ctx.Rpc.EnrollAsync(refreshed.AccessToken, ticket, installationId, ct).ConfigureAwait(false);
            }
        }

        if (!reply.Ok)
        {
            // Transport or contract failure: the ticket may or may not have been spent. Keep the file and show the reason.
            _ctx.Set(existing is null ? DeviceState.PendingActivation : DeviceState.Registered, DeviceContext.DetailFor(reply.Failure));
            return;
        }

        var answer = reply.Value!;
        if (answer.Ok)
        {
            var credential = new DeviceCredential
            {
                DeviceId = answer.DeviceId,
                DeviceSecret = answer.DeviceSecret,
                InstallationId = answer.InstallationId,
                EnrolledAt = _ctx.Clock.GetUtcNow(),
                RedeemedTicketHash = ticket.Hash
            };

            // The secret exists nowhere else. It is on disk (atomic, flushed) BEFORE the activation file is touched.
            if (!TryStore(credential))
            {
                _unpersisted = credential;
                _ctx.Set(DeviceState.PendingActivation, DeviceDetail.StorageFailure);
                return;
            }

            _ctx.NoteInstallation(credential.InstallationId);
            _source.Remove(ticket.Hash);
            _ctx.Set(DeviceState.Registered);
            return;
        }

        switch (answer.Error)
        {
            case DeviceEnrollError.TicketExpired:
                _source.Remove(ticket.Hash);
                _ctx.Set(DeviceState.ActivationExpired, DeviceDetail.TicketExpired);
                break;

            case DeviceEnrollError.TicketConsumed:
                // The ticket is spent. If this computer already holds a credential for the installation, it is simply registered;
                // otherwise the reply of the first redemption was lost and only a NEW activation file helps.
                _source.Remove(ticket.Hash);
                _ctx.Set(existing is not null ? DeviceState.Registered : DeviceState.ActivationRejected, existing is not null ? DeviceDetail.None : DeviceDetail.TicketConsumed);
                break;

            case DeviceEnrollError.TicketRevoked:
                _source.Remove(ticket.Hash);
                _ctx.Set(DeviceState.ActivationRejected, DeviceDetail.TicketRevoked);
                break;

            case DeviceEnrollError.InvalidTicket:
                _source.Remove(ticket.Hash);
                _ctx.Set(DeviceState.ActivationRejected, DeviceDetail.TicketInvalid);
                break;

            case DeviceEnrollError.InvalidInstallation:
                // Our installation id was not accepted; the ticket is not spent. Keep the file.
                _refused.Add(ticket.Hash);
                _ctx.Set(DeviceState.PendingActivation, DeviceDetail.InvalidInstallation);
                break;

            case DeviceEnrollError.InstallationConflict:
                _refused.Add(ticket.Hash);
                _ctx.Set(DeviceState.OwnershipConflict, DeviceDetail.InstallationConflict);
                break;
            case DeviceEnrollError.InstallationBound:
                _refused.Add(ticket.Hash);
                _ctx.Set(DeviceState.OwnershipConflict, DeviceDetail.InstallationBound);
                break;
            case DeviceEnrollError.IdentityInUse:
                _refused.Add(ticket.Hash);
                _ctx.Set(DeviceState.OwnershipConflict, DeviceDetail.IdentityInUse);
                break;

            case DeviceEnrollError.DeviceLimit:
            case DeviceEnrollError.AccountLimit:
                _refused.Add(ticket.Hash);
                _ctx.Set(DeviceState.AccountUnavailable, DeviceDetail.LimitReached);
                break;

            default:
                _refused.Add(ticket.Hash);
                _ctx.Set(DeviceState.AccountUnavailable);
                break;
        }
    }

    private bool TryStore(DeviceCredential credential)
    {
        try
        {
            _ctx.Store.Write(credential);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }
}
