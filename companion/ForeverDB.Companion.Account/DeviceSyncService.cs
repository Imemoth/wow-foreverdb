using System.Text.Json.Nodes;

namespace ForeverDB.Companion.Account;

public enum DeviceSyncOutcome
{
    Synced,
    /// <summary>No device credential for this installation: the caller's normal (legacy) path applies.</summary>
    NotRegistered,
    /// <summary>The device state forbids uploading (revoked, conflict, damaged, pending, account unavailable). Nothing was sent.</summary>
    Blocked,
    /// <summary>A transient condition (network, rate limit, stale credential). Nothing changed; try Sync now again later.</summary>
    RetryLater,
    /// <summary>The server refused the request in a way retrying will not fix.</summary>
    Failed,
    /// <summary>Automatic upload for a registered device is off. Nothing was sent.</summary>
    AutoSyncOff
}

public sealed record DeviceSyncResult(DeviceSyncOutcome Outcome, DeviceStatus Status)
{
    public string Message => AccountMessages.Describe(this);
    public override string ToString() => $"DeviceSyncResult({Outcome}, {Status.State}, {Status.Detail})";
}

/// <summary>
/// Registered-device upload. Manual only: <see cref="SyncNowAsync"/> is the one entry point that sends data;
/// <see cref="SyncAutomaticAsync"/> sends nothing while <see cref="AccountFeatureGate.DeviceAutoSyncApproved"/> is false.
///
/// Every call: device session token (its own anonymous identity) + stored device secret -> <c>fdb_device_ingest</c>. A refused
/// ingest is never retried under another identity or credential, and an installation owned by a device never falls back to the
/// anonymous ingest. Credential rotation persists the NEW secret durably before it is used for the first time.
/// </summary>
public sealed class DeviceSyncService
{
    private readonly DeviceContext _ctx;
    private readonly bool _enabled;
    private bool _checked;
    private bool _needsRotation;
    private int _staleStrikes;

    public DeviceSyncService(DeviceContext context, bool enabled = true)
    {
        _ctx = context;
        _enabled = enabled;
    }

    public DeviceStatus Status => _ctx.Status;

    private static bool AutoAllowed => AccountFeatureGate.DeviceAutoSyncApproved;

    /// <summary>
    /// True when uploads of this installation must go through the device path (or nowhere): it has a device credential on this
    /// computer, or an activation is still pending (the first anonymous upload must not claim the installation before the device does).
    /// </summary>
    public bool Handles(string installationId) =>
        _enabled &&
        (string.Equals(_ctx.InstallationId, installationId, StringComparison.Ordinal) || _ctx.Status.State == DeviceState.PendingActivation);

    public Task<DeviceSyncResult> SyncNowAsync(string snapshotJson, CancellationToken ct = default) =>
        RunAsync(snapshotJson, ct);

    public Task<DeviceSyncResult> SyncAutomaticAsync(string snapshotJson, CancellationToken ct = default) =>
        AutoAllowed
            ? RunAsync(snapshotJson, ct)
            : Task.FromResult(new DeviceSyncResult(DeviceSyncOutcome.AutoSyncOff, new DeviceStatus(_ctx.Status.State, DeviceDetail.AutoSyncOff)));

    /// <summary>Startup classification: <c>fdb_device_status</c>, plus a credential rotation when the server asks for it.</summary>
    public async Task<DeviceStatus> CheckStatusAsync(CancellationToken ct = default)
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

        var read = _ctx.Store.Read();
        if (read.Status != DeviceCredentialStatus.Ok)
        {
            ApplyReadFailure(read);
            return _ctx.Status;
        }

        var credential = read.Credential!;
        if (await PrepareAsync(credential, ct).ConfigureAwait(false) is { } stop)
        {
            return stop.Status;
        }

        return _ctx.Status;
    }

    private async Task<DeviceSyncResult> RunAsync(string snapshotJson, CancellationToken ct)
    {
        if (!_enabled)
        {
            return Result(DeviceSyncOutcome.NotRegistered);
        }

        var installationId = InstallationOf(snapshotJson);
        if (installationId is null)
        {
            return Result(DeviceSyncOutcome.Failed, DeviceDetail.Unexpected);
        }

        using var lease = await _ctx.TryAcquireAsync(ct).ConfigureAwait(false);
        if (lease is null)
        {
            _ctx.Set(_ctx.Status.State, DeviceDetail.LockTimeout);
            return Result(DeviceSyncOutcome.RetryLater);
        }

        var read = _ctx.Store.Read();
        if (read.Status != DeviceCredentialStatus.Ok)
        {
            if (read.Status == DeviceCredentialStatus.Missing)
            {
                return _ctx.Status.State == DeviceState.PendingActivation
                    ? Result(DeviceSyncOutcome.Blocked)
                    : Result(DeviceSyncOutcome.NotRegistered);
            }

            ApplyReadFailure(read);
            return Result(read.Status == DeviceCredentialStatus.IoError ? DeviceSyncOutcome.RetryLater : DeviceSyncOutcome.Blocked);
        }

        var credential = read.Credential!;
        _ctx.NoteInstallation(credential.InstallationId);
        _ctx.MarkLocalRegistered();
        if (!string.Equals(credential.InstallationId, installationId, StringComparison.Ordinal))
        {
            // A snapshot of another installation is not this device's to upload.
            return Result(DeviceSyncOutcome.NotRegistered);
        }

        if (_ctx.Status.State is DeviceState.DeviceRevoked or DeviceState.CredentialDamaged)
        {
            // Revoked or damaged stops here, with no network: only a new activation changes it.
            return Result(DeviceSyncOutcome.Blocked);
        }

        if (await PrepareAsync(credential, ct).ConfigureAwait(false) is { } stop)
        {
            return stop;
        }

        credential = _lastCredential ?? credential;
        var token = await _ctx.Session.GetTokenAsync(allowCreate: false, ct).ConfigureAwait(false);
        if (!token.Ok)
        {
            return TokenFailure(token.Status);
        }

        var reply = await _ctx.Rpc.IngestAsync(token.AccessToken, credential.DeviceSecret, snapshotJson, ct).ConfigureAwait(false);
        if (!reply.Ok && reply.Failure == RpcFailure.Unauthorized)
        {
            // The session may have been revoked server-side while the clock still thought it fresh: refresh once, retry once.
            var refreshed = await _ctx.Session.ForceRefreshAsync(allowCreate: false, ct).ConfigureAwait(false);
            if (!refreshed.Ok)
            {
                return TokenFailure(refreshed.Status);
            }

            reply = await _ctx.Rpc.IngestAsync(refreshed.AccessToken, credential.DeviceSecret, snapshotJson, ct).ConfigureAwait(false);
        }

        if (!reply.Ok)
        {
            return reply.Failure switch
            {
                RpcFailure.RateLimited => Result(DeviceSyncOutcome.RetryLater, DeviceDetail.RateLimited),
                RpcFailure.Unavailable => Result(DeviceSyncOutcome.RetryLater, DeviceDetail.Offline),
                RpcFailure.Unauthorized => Result(DeviceSyncOutcome.RetryLater, DeviceDetail.SessionNotAccepted),
                _ => Result(DeviceSyncOutcome.Failed, DeviceContext.DetailFor(reply.Failure))
            };
        }

        var call = reply.Value!;
        if (call.Ok)
        {
            _staleStrikes = 0;
            _ctx.Set(DeviceState.Registered, DeviceDetail.Synced);
            return new DeviceSyncResult(DeviceSyncOutcome.Synced, _ctx.Status);
        }

        return await RefusedAsync(call.Error, credential, ct).ConfigureAwait(false);
    }

    private DeviceCredential? _lastCredential;

    /// <summary>Classifies the device with the server and rotates the credential when asked. A non-null result stops the caller.</summary>
    private async Task<DeviceSyncResult?> PrepareAsync(DeviceCredential credential, CancellationToken ct)
    {
        _lastCredential = null;
        if (!_checked)
        {
            var probe = await _ctx.ProbeAsync(credential, ct).ConfigureAwait(false);
            if (probe.Token != DeviceTokenStatus.Ok)
            {
                return TokenFailure(probe.Token);
            }

            if (probe.State is not { } state)
            {
                return Result(DeviceSyncOutcome.RetryLater, DeviceContext.DetailFor(probe.Failure));
            }

            _ctx.ApplyServerState(state);
            if (state != DeviceServerState.Active)
            {
                return Result(DeviceSyncOutcome.Blocked);
            }

            _checked = true;
            _needsRotation = probe.NeedsRotation;
        }

        if (!_needsRotation)
        {
            return null;
        }

        var token = await _ctx.Session.GetTokenAsync(allowCreate: false, ct).ConfigureAwait(false);
        if (!token.Ok)
        {
            return TokenFailure(token.Status);
        }

        var rotated = await _ctx.Rpc.RotateAsync(token.AccessToken, credential.DeviceSecret, ct).ConfigureAwait(false);
        if (!rotated.Ok)
        {
            // Rotation is housekeeping: a transient failure keeps the (still valid) current secret and retries on a later call.
            return rotated.Failure is RpcFailure.Unavailable or RpcFailure.RateLimited or RpcFailure.Unauthorized or RpcFailure.NotDeployed
                ? null
                : Result(DeviceSyncOutcome.Failed, DeviceContext.DetailFor(rotated.Failure));
        }

        if (!rotated.Value!.Ok)
        {
            return await RefusedAsync(rotated.Value.Error, credential, ct).ConfigureAwait(false);
        }

        var next = credential.Clone();
        next.DeviceSecret = rotated.Value.NewSecret;
        if (!DeviceContract.SecretMatchesDevice(next.DeviceSecret, next.DeviceId))
        {
            return Result(DeviceSyncOutcome.Failed, DeviceDetail.Unexpected);
        }

        try
        {
            // Durable BEFORE first use. The server accepts the current and the next secret, so a crash anywhere in here loses nothing.
            _ctx.Store.Write(next);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Could not persist: keep using the current secret (the new one is never used unpersisted); rotation is retried later.
            _ctx.Set(_ctx.Status.State, DeviceDetail.StorageFailure);
            return null;
        }

        _needsRotation = false;
        _lastCredential = next;
        return null;
    }

    private async Task<DeviceSyncResult> RefusedAsync(DeviceCallError error, DeviceCredential credential, CancellationToken ct)
    {
        switch (error)
        {
            case DeviceCallError.DeviceRevoked:
                _ctx.Set(DeviceState.DeviceRevoked);
                return Result(DeviceSyncOutcome.Blocked);

            case DeviceCallError.OwnershipConflict:
            case DeviceCallError.WrongInstallation:
                _ctx.Set(DeviceState.OwnershipConflict, DeviceDetail.OwnershipChanged);
                return Result(DeviceSyncOutcome.Blocked);

            case DeviceCallError.AccountUnavailable:
                _ctx.Set(DeviceState.AccountUnavailable);
                return Result(DeviceSyncOutcome.Blocked);

            case DeviceCallError.DeviceCredentialStale:
                // The server holds a newer credential than the one presented. Retry once on a later call; if it is still stale the
                // local credential is not the current one and only a new activation recovers it. Never loops, never swaps identity.
                if (++_staleStrikes >= 2)
                {
                    _ctx.Set(DeviceState.CredentialDamaged, DeviceDetail.StaleCredential);
                    return Result(DeviceSyncOutcome.Blocked);
                }

                return Result(DeviceSyncOutcome.RetryLater, DeviceDetail.StaleCredential);

            default:
                // device_unauthorized: classify with the server instead of guessing between revoked and damaged.
                _checked = false;
                var probe = await _ctx.ProbeAsync(credential, ct).ConfigureAwait(false);
                if (probe.Token != DeviceTokenStatus.Ok)
                {
                    return TokenFailure(probe.Token);
                }

                if (probe.State is not { } serverState)
                {
                    return Result(DeviceSyncOutcome.RetryLater, DeviceContext.DetailFor(probe.Failure));
                }

                if (serverState != DeviceServerState.Active)
                {
                    _ctx.ApplyServerState(serverState);
                    return Result(DeviceSyncOutcome.Blocked);
                }

                // Active according to status yet refused as unauthorized: the credential and the server disagree. Fail closed.
                _ctx.Set(DeviceState.CredentialDamaged, DeviceDetail.DeviceUnknown);
                return Result(DeviceSyncOutcome.Blocked);
        }
    }

    private DeviceSyncResult TokenFailure(DeviceTokenStatus status)
    {
        switch (status)
        {
            case DeviceTokenStatus.Damaged:
                // The device session is gone or rejected. Never replaced here: a new activation is the recovery.
                _ctx.Set(DeviceState.CredentialDamaged, DeviceDetail.SessionNotAccepted);
                return Result(DeviceSyncOutcome.Blocked);
            case DeviceTokenStatus.RateLimited:
                return Result(DeviceSyncOutcome.RetryLater, DeviceDetail.RateLimited);
            case DeviceTokenStatus.StorageFailure:
                return Result(DeviceSyncOutcome.RetryLater, DeviceDetail.StorageFailure);
            default:
                return Result(DeviceSyncOutcome.RetryLater, DeviceDetail.Offline);
        }
    }

    private void ApplyReadFailure(DeviceCredentialRead read)
    {
        _ctx.NoteInstallation(read.MarkerInstallationId);
        switch (read.Status)
        {
            case DeviceCredentialStatus.Unreadable:
                _ctx.Set(DeviceState.CredentialDamaged);
                break;
            case DeviceCredentialStatus.IoError:
                _ctx.Set(_ctx.Status.State, DeviceDetail.StorageFailure);
                break;
        }
    }

    private DeviceSyncResult Result(DeviceSyncOutcome outcome, DeviceDetail? detail = null)
    {
        if (detail is { } d)
        {
            // A transient problem is shown next to the unchanged state; it never rewrites the state.
            _ctx.Set(_ctx.Status.State, d);
        }

        return new DeviceSyncResult(outcome, _ctx.Status);
    }

    private static string? InstallationOf(string snapshotJson)
    {
        try
        {
            return JsonNode.Parse(snapshotJson) is JsonObject root &&
                   root["p_snapshot"] is JsonObject snapshot &&
                   snapshot["installationId"] is JsonValue id && id.TryGetValue<string>(out var value) &&
                   DeviceContract.InstallationIdPattern.IsMatch(value)
                ? value
                : null;
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }
}
