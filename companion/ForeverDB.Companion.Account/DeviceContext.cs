namespace ForeverDB.Companion.Account;

public enum DeviceTokenStatus
{
    Ok,
    /// <summary>The device's own session is missing, unreadable, rejected or not anonymous and may not be replaced here.</summary>
    Damaged,
    Unavailable,
    RateLimited,
    /// <summary>The server refused to create an anonymous identity.</summary>
    Refused,
    StorageFailure
}

public sealed class DeviceTokenResult
{
    public DeviceTokenStatus Status { get; init; }
    public string AccessToken { get; init; } = "";
    public bool Ok => Status == DeviceTokenStatus.Ok;
    public override string ToString() => Ok ? "DeviceTokenResult(ok, redacted)" : $"DeviceTokenResult({Status})";
}

/// <summary>
/// The device's OWN anonymous Supabase Auth session, in a separate DPAPI slot (<c>device/session.dat</c>). It is created
/// lazily (enrollment only), refreshed with the refresh token, and never replaced silently: a definitive rejection or an
/// unreadable slot is a "damaged" result unless the caller states that no device credential exists yet (nothing is bound to
/// this identity, so the damaged slot is moved aside and a fresh identity may be created). The legacy session.dat,
/// legacy-owner.dat and pending-revoke slots are in another directory and are never touched.
/// Callers must hold the device session gate.
/// </summary>
public sealed class DeviceSessionProvider
{
    private const long RefreshSkewSeconds = 90;

    private readonly CredentialSlot _slot;
    private readonly GoTrueClient _auth;
    private readonly TimeProvider _clock;
    // A session the server issued but the disk refused: kept in memory so this process continues with the NEW refresh token.
    private AuthSession? _unpersisted;

    public DeviceSessionProvider(CredentialSlot slot, GoTrueClient auth, TimeProvider clock)
    {
        _slot = slot;
        _auth = auth;
        _clock = clock;
    }

    /// <param name="allowCreate">True only while no device credential exists: enrollment may create or replace the identity.</param>
    public async Task<DeviceTokenResult> GetTokenAsync(bool allowCreate, CancellationToken ct)
    {
        if (_unpersisted is { } held)
        {
            if (TryPersist(held))
            {
                _unpersisted = null;
            }

            return await UseAsync(held, allowCreate, ct).ConfigureAwait(false);
        }

        var read = _slot.Read();
        switch (read.Status)
        {
            case SlotReadStatus.IoError:
                return Fail(DeviceTokenStatus.StorageFailure);
            case SlotReadStatus.Missing:
                return allowCreate ? await CreateAsync(ct).ConfigureAwait(false) : Fail(DeviceTokenStatus.Damaged);
            case SlotReadStatus.Unreadable:
                return allowCreate ? await ReplaceAsync(ct).ConfigureAwait(false) : Fail(DeviceTokenStatus.Damaged);
        }

        var session = read.Session!;
        if (read.Marker?.Rejected == true || JwtInspector.TryDecode(session.AccessToken)?.IsAnonymous == false)
        {
            // A rejected session, or a registered token in the device slot, is never used for device calls.
            return allowCreate ? await ReplaceAsync(ct).ConfigureAwait(false) : Fail(DeviceTokenStatus.Damaged);
        }

        if (read.Recovered)
        {
            try { _slot.Repair(); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }

        return await UseAsync(session, allowCreate, ct).ConfigureAwait(false);
    }

    /// <summary>Forces one refresh (after the server answered 401 to a token the clock still considered fresh).</summary>
    public async Task<DeviceTokenResult> ForceRefreshAsync(bool allowCreate, CancellationToken ct)
    {
        var session = _unpersisted ?? ReadUsable();
        return session is null ? Fail(DeviceTokenStatus.Damaged) : await RefreshAsync(session, allowCreate, ct).ConfigureAwait(false);
    }

    private AuthSession? ReadUsable()
    {
        var read = _slot.Read();
        return read.Status == SlotReadStatus.Ok && read.Marker?.Rejected != true ? read.Session : null;
    }

    private Task<DeviceTokenResult> UseAsync(AuthSession session, bool allowCreate, CancellationToken ct) =>
        session.ExpiresAt - _clock.GetUtcNow().ToUnixTimeSeconds() > RefreshSkewSeconds
            ? Task.FromResult(new DeviceTokenResult { Status = DeviceTokenStatus.Ok, AccessToken = session.AccessToken })
            : RefreshAsync(session, allowCreate, ct);

    private async Task<DeviceTokenResult> RefreshAsync(AuthSession session, bool allowCreate, CancellationToken ct)
    {
        var result = await _auth.RefreshAsync(session.RefreshToken, ct).ConfigureAwait(false);
        if (result.Ok)
        {
            return Accept(result.Value!);
        }

        if (result.Failure == AuthFailureKind.SessionRejected)
        {
            // Definitive: the server ended this identity. Flag it (non-secret marker) but never create another one for a bound device.
            try { _slot.WriteMarker(SlotMarker.For(SessionKind.Anonymous, rejected: true)); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
            return allowCreate ? await ReplaceAsync(ct).ConfigureAwait(false) : Fail(DeviceTokenStatus.Damaged);
        }

        return Fail(result.Failure switch
        {
            AuthFailureKind.RateLimited => DeviceTokenStatus.RateLimited,
            _ => DeviceTokenStatus.Unavailable
        });
    }

    private async Task<DeviceTokenResult> ReplaceAsync(CancellationToken ct)
    {
        try
        {
            _slot.Quarantine();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Fail(DeviceTokenStatus.StorageFailure);
        }

        return await CreateAsync(ct).ConfigureAwait(false);
    }

    private async Task<DeviceTokenResult> CreateAsync(CancellationToken ct)
    {
        var result = await _auth.SignUpAnonymouslyAsync(ct).ConfigureAwait(false);
        if (!result.Ok)
        {
            return Fail(result.Failure switch
            {
                AuthFailureKind.RateLimited => DeviceTokenStatus.RateLimited,
                AuthFailureKind.Refused => DeviceTokenStatus.Refused,
                _ => DeviceTokenStatus.Unavailable
            });
        }

        // The device identity must be an anonymous user; anything else is refused before it is stored.
        return JwtInspector.TryDecode(result.Value!.AccessToken)?.IsAnonymous == true
            ? Accept(result.Value!)
            : Fail(DeviceTokenStatus.Refused);
    }

    private DeviceTokenResult Accept(AuthSession session)
    {
        session.Email = null;
        if (!TryPersist(session))
        {
            _unpersisted = session;
        }

        return new DeviceTokenResult { Status = DeviceTokenStatus.Ok, AccessToken = session.AccessToken };
    }

    private bool TryPersist(AuthSession session)
    {
        try
        {
            _slot.Write(session, SlotMarker.For(SessionKind.Anonymous));
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static DeviceTokenResult Fail(DeviceTokenStatus status) => new() { Status = status };
}

/// <summary>
/// State shared by <see cref="DeviceEnrollmentService"/> and <see cref="DeviceSyncService"/>: the device directory, its
/// machine-wide gate (one enrollment/sync/rotation at a time across Companion processes), the credential store, the device
/// session, the RPC client and the observable <see cref="DeviceStatus"/>.
/// </summary>
public sealed class DeviceContext
{
    private readonly object _statusLock = new();
    private DeviceStatus _status = DeviceStatus.Initial;
    private string? _installationId;
    private readonly HashSet<string> _installationIds = new(StringComparer.Ordinal);

    public DeviceContext(
        string directory,
        ICredentialProtector protector,
        ISessionGate gate,
        GoTrueClient auth,
        DeviceRpcClient rpc,
        TimeProvider? clock = null,
        TimeSpan? lockTimeout = null,
        ISlotIo? io = null)
    {
        Directory = directory;
        Gate = gate;
        Rpc = rpc;
        Clock = clock ?? TimeProvider.System;
        LockTimeout = lockTimeout ?? TimeSpan.FromSeconds(30);
        Store = new DeviceCredentialStore(directory, protector, io);
        Session = new DeviceSessionProvider(new CredentialSlot(directory, "session", protector, io), auth, Clock);
    }

    public string Directory { get; }
    public ISessionGate Gate { get; }
    public DeviceRpcClient Rpc { get; }
    public TimeProvider Clock { get; }
    public TimeSpan LockTimeout { get; }
    public DeviceCredentialStore Store { get; }
    public DeviceSessionProvider Session { get; }

    public event Action<DeviceStatus>? StatusChanged;

    public DeviceStatus Status
    {
        get { lock (_statusLock) { return _status; } }
    }

    /// <summary>
    /// The installation id this computer's device credential belongs to, once known (from the credential or its non-secret marker).
    /// While set, that installation must never be uploaded through the anonymous path.
    /// </summary>
    public string? InstallationId
    {
        get { lock (_statusLock) { return _installationId; } }
    }

    /// <summary>All installation ids observed locally, including credentials migrated from the legacy single slot.</summary>
    public IReadOnlyCollection<string> InstallationIds
    {
        get { lock (_statusLock) { return _installationIds.ToArray(); } }
    }

    internal void NoteInstallation(string? installationId)
    {
        if (installationId is null) return;
        lock (_statusLock)
        {
            _installationId = installationId;
            _installationIds.Add(installationId);
        }
    }

    internal void NoteInstallations(IEnumerable<string> installationIds)
    {
        foreach (var installationId in installationIds)
        {
            NoteInstallation(installationId);
        }
    }

    /// <summary>A readable device credential exists: the local state is Registered unless a more specific state is already known.</summary>
    internal void MarkLocalRegistered()
    {
        if (Status.State is DeviceState.Anonymous or DeviceState.PendingActivation or DeviceState.CredentialDamaged
            or DeviceState.ActivationExpired or DeviceState.ActivationRejected)
        {
            Set(DeviceState.Registered);
        }
    }

    internal void Set(DeviceState state, DeviceDetail detail = DeviceDetail.None)
    {
        var next = new DeviceStatus(state, detail);
        bool changed;
        lock (_statusLock)
        {
            changed = _status != next;
            _status = next;
        }

        if (changed)
        {
            StatusChanged?.Invoke(next);
        }
    }

    /// <summary>Takes the device gate; null when another Companion process holds it for longer than <see cref="LockTimeout"/>.</summary>
    internal async Task<SessionLease?> TryAcquireAsync(CancellationToken ct)
    {
        try
        {
            return await Gate.AcquireAsync(LockTimeout, ct).ConfigureAwait(false);
        }
        catch (SessionLockTimeoutException)
        {
            return null;
        }
    }

    internal sealed record Probe(DeviceTokenStatus Token, RpcFailure Failure, DeviceServerState? State, bool NeedsRotation);

    /// <summary>
    /// <c>fdb_device_status</c> with the device's own session (one refresh-and-retry on HTTP 401). Caller holds the gate. Nothing is
    /// created, changed or cleared here: the result only classifies.
    /// </summary>
    internal async Task<Probe> ProbeAsync(DeviceCredential credential, CancellationToken ct)
    {
        var token = await Session.GetTokenAsync(allowCreate: false, ct).ConfigureAwait(false);
        if (!token.Ok)
        {
            return new Probe(token.Status, RpcFailure.None, null, false);
        }

        var reply = await Rpc.StatusAsync(token.AccessToken, credential.DeviceSecret, ct).ConfigureAwait(false);
        if (!reply.Ok && reply.Failure == RpcFailure.Unauthorized)
        {
            var refreshed = await Session.ForceRefreshAsync(allowCreate: false, ct).ConfigureAwait(false);
            if (!refreshed.Ok)
            {
                return new Probe(refreshed.Status, RpcFailure.None, null, false);
            }

            reply = await Rpc.StatusAsync(refreshed.AccessToken, credential.DeviceSecret, ct).ConfigureAwait(false);
        }

        return reply.Ok
            ? new Probe(DeviceTokenStatus.Ok, RpcFailure.None, reply.Value!.State, reply.Value.NeedsRotation)
            : new Probe(DeviceTokenStatus.Ok, reply.Failure, null, false);
    }

    /// <summary>Applies a server-reported device state. Unknown means the server does not recognise this credential for this device identity.</summary>
    internal void ApplyServerState(DeviceServerState state)
    {
        switch (state)
        {
            case DeviceServerState.Active: Set(DeviceState.Registered); break;
            case DeviceServerState.Revoked: Set(DeviceState.DeviceRevoked); break;
            case DeviceServerState.OwnershipConflict: Set(DeviceState.OwnershipConflict, DeviceDetail.OwnershipChanged); break;
            case DeviceServerState.AccountUnavailable: Set(DeviceState.AccountUnavailable); break;
            default: Set(DeviceState.CredentialDamaged, DeviceDetail.DeviceUnknown); break;
        }
    }

    /// <summary>
    /// Maps one device RPC failure to a state change. A network or server problem never changes the state: only the detail
    /// shown next to the unchanged state. Returns the detail for the caller's result.
    /// </summary>
    internal static DeviceDetail DetailFor(RpcFailure failure) => failure switch
    {
        RpcFailure.RateLimited => DeviceDetail.RateLimited,
        RpcFailure.Unavailable => DeviceDetail.Offline,
        RpcFailure.NotDeployed => DeviceDetail.ServiceNotReady,
        RpcFailure.Unauthorized => DeviceDetail.SessionNotAccepted,
        RpcFailure.Forbidden => DeviceDetail.ServiceRefused,
        _ => DeviceDetail.Unexpected
    };
}
