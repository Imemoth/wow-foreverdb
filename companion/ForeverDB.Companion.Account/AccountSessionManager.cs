using System.Text.RegularExpressions;

namespace ForeverDB.Companion.Account;

public enum SignInOutcome
{
    Success,
    FeatureDisabled,
    InvalidInput,
    InvalidCredentials,
    EmailNotConfirmed,
    RateLimited,
    /// <summary>Network/server failure: nothing changed.</summary>
    Unavailable,
    /// <summary>The server's answer could not be proven to be a confirmed, non-anonymous account. Nothing was stored.</summary>
    VerificationFailed,
    AlreadySignedIn,
    /// <summary>A credential file could not be written; the previous state is intact.</summary>
    StorageFailure,
    LockTimeout,
    /// <summary>Another anonymous identity already occupies the legacy slot; nothing was overwritten.</summary>
    LegacySlotOccupied
}

public enum SignOutOutcome
{
    /// <summary>The server confirmed the session ended (or it was already gone).</summary>
    Confirmed,
    /// <summary>Signed out locally; the server-side revocation could NOT be confirmed. The credential is retained for retry.</summary>
    LocalOnlyRevocationPending,
    NotSignedIn,
    StorageFailure,
    LockTimeout,
    FeatureDisabled
}

public enum ForgetOutcome
{
    ConfirmationRequired,
    NothingToForget,
    /// <summary>Server-side session ended and the local credential was removed.</summary>
    Revoked,
    /// <summary>The session was already invalid server-side; the local credential was removed.</summary>
    AlreadyEnded,
    /// <summary>Revocation failed; the credential was KEPT (remote session possibly still active).</summary>
    RevocationFailedKept,
    /// <summary>The user explicitly discarded the credential without server confirmation (residual risk).</summary>
    DiscardedUnrevoked,
    StorageFailure,
    LockTimeout
}

public enum StartAnonymousOutcome
{
    Created,
    /// <summary>The preserved original anonymous identity was promoted back; no new identity was created.</summary>
    RestoredLegacyIdentity,
    AlreadyAnonymous,
    AlreadySignedIn,
    /// <summary>Replacing a lost or unreadable identity needs explicit confirmation.</summary>
    ConfirmationRequired,
    Unavailable,
    RateLimited,
    Refused,
    StorageFailure,
    LockTimeout,
    FeatureDisabled
}

/// <summary>
/// Account System V1 session state machine for the Companion (ownership-claim-protocol.md section 2).
/// Invariants enforced here and covered by tests:
/// transient failures never clear a credential; only a verified GoTrue session-gone reply moves an identity
/// to ReauthRequired/AnonymousIdentityLost; a registered session never becomes an anonymous one; no anonymous
/// sign-up ever happens implicitly; every mutation runs under the machine-wide session gate after re-reading
/// storage; registered credentials only exist when the account feature gate is open.
/// </summary>
public sealed class AccountSessionManager
{
    private const long RefreshSkewSeconds = 90;
    private static readonly Regex EmailPattern = new(@"^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$", RegexOptions.Compiled);

    private readonly SessionVault _vault;
    private readonly ISessionGate _gate;
    private readonly GoTrueClient _auth;
    private readonly TimeProvider _clock;
    private readonly TimeSpan _lockTimeout;
    private readonly object _stateLock = new();
    private readonly Dictionary<SlotRole, SessionFault> _faults = new();
    // A refresh the server accepted but we could not persist yet. Kept in memory only so this process continues
    // with the NEW refresh token (the old one is spent) and retries the write.
    private readonly Dictionary<SlotRole, (AuthSession Session, SlotMarker Marker, string Replaced)> _unpersisted = new();

    private AccountStatus _status;
    private string? _verifiedUserId;
    private string? _verifiedEmail;
    private string? _verificationFailedUserId;
    private bool _claimPending;
    private long _generation;
    private string _identityKey = "";

    public AccountSessionManager(
        SessionVault vault,
        ISessionGate gate,
        GoTrueClient auth,
        bool accountsEnabled,
        TimeProvider? clock = null,
        TimeSpan? lockTimeout = null,
        bool allowAnonymousCreation = true)
    {
        _allowAnonymousCreation = allowAnonymousCreation;
        _vault = vault;
        _gate = gate;
        _auth = auth;
        AccountsEnabled = accountsEnabled;
        _clock = clock ?? TimeProvider.System;
        _lockTimeout = lockTimeout ?? TimeSpan.FromSeconds(30);
        _status = AccountStatus.Initial(accountsEnabled);
    }

    private readonly bool _allowAnonymousCreation;

    public bool AccountsEnabled { get; }

    public AccountStatus Status
    {
        get
        {
            lock (_stateLock)
            {
                return _status;
            }
        }
    }

    public long Generation => Interlocked.Read(ref _generation);

    /// <summary>Raised (outside any lock) whenever the visible status changes.</summary>
    public event Action<AccountStatus>? StatusChanged;

    /// <summary>
    /// Raised when the acting identity changed (sign-in, sign-out, forget, new/lost identity). Account-scoped
    /// caches and in-flight work keyed by the previous generation must be dropped.
    /// </summary>
    public event Action<long>? IdentityChanged;

    // ------------------------------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------------------------------

    /// <summary>Classifies the stored credentials from disk. Never touches the network and never creates an identity.</summary>
    public async Task<AccountStatus> InitializeAsync(CancellationToken ct = default)
    {
        try
        {
            using var lease = await _gate.AcquireAsync(_lockTimeout, ct).ConfigureAwait(false);
            HealStorage();
            return Recompute();
        }
        catch (SessionLockTimeoutException)
        {
            return SetFault(SlotRole.Primary, SessionFault.LockTimeout);
        }
    }

    public async Task<AccountStatus> RefreshStatusAsync(CancellationToken ct = default) => await InitializeAsync(ct).ConfigureAwait(false);

    public void SetClaimPending(bool pending)
    {
        _claimPending = pending;
        Recompute();
    }

    // ------------------------------------------------------------------------------------------
    // Tokens
    // ------------------------------------------------------------------------------------------

    /// <summary>
    /// Returns a usable access token for the slot, refreshing it when needed. Never creates an identity.
    /// A registered primary token is only returned after the server has confirmed the account.
    /// </summary>
    public async Task<TokenResult> GetAccessTokenAsync(SlotRole role, CancellationToken ct = default)
    {
        SessionLease lease;
        try
        {
            lease = await _gate.AcquireAsync(_lockTimeout, ct).ConfigureAwait(false);
        }
        catch (SessionLockTimeoutException)
        {
            SetFault(role, SessionFault.LockTimeout);
            return TokenResult.Fail(role, SessionFault.LockTimeout, Status.State, Generation);
        }

        using (lease)
        {
            return await AcquireLockedAsync(role, ct).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// One forced refresh of the slot's own credential (a token the server refused although the local clock thinks it
    /// is valid). Never switches identity.
    /// </summary>
    public async Task<TokenResult> RefreshNowAsync(SlotRole role, CancellationToken ct = default)
    {
        SessionLease lease;
        try
        {
            lease = await _gate.AcquireAsync(_lockTimeout, ct).ConfigureAwait(false);
        }
        catch (SessionLockTimeoutException)
        {
            SetFault(role, SessionFault.LockTimeout);
            return TokenResult.Fail(role, SessionFault.LockTimeout, Status.State, Generation);
        }

        using (lease)
        {
            return await AcquireLockedAsync(role, ct, forceRefresh: true).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Token for read-only RPCs (Search, stats, detail): the primary credential when usable, otherwise the
    /// preserved legacy owner credential. Never creates an identity.
    /// </summary>
    public async Task<TokenResult> GetReadTokenAsync(CancellationToken ct = default)
    {
        var primary = await GetAccessTokenAsync(SlotRole.Primary, ct).ConfigureAwait(false);
        if (primary.Ok || !Status.HasLegacyOwner || primary.Fault == SessionFault.LockTimeout)
        {
            return primary;
        }

        var legacy = await GetAccessTokenAsync(SlotRole.LegacyOwner, ct).ConfigureAwait(false);
        return legacy.Ok ? legacy : primary;
    }

    /// <summary>
    /// The not-yet-persisted rotated session for the slot, but only while the disk still holds exactly the
    /// credential it replaced. Anything else (another process or an identity change wrote the slot) makes it stale
    /// and it is dropped: a stale in-memory session must never overwrite a newer identity.
    /// </summary>
    private (AuthSession Session, SlotMarker Marker, string Replaced)? TakePending(SlotRole role, SlotReadResult disk)
    {
        if (!_unpersisted.TryGetValue(role, out var pending))
        {
            return null;
        }

        if (disk.Status == SlotReadStatus.Ok &&
            disk.Session!.UserId == pending.Session.UserId &&
            disk.Session.RefreshToken == pending.Replaced)
        {
            return pending;
        }

        if (disk.Status is SlotReadStatus.IoError)
        {
            return null;   // cannot tell right now; keep it for the next attempt
        }

        _unpersisted.Remove(role);
        return null;
    }

    private SlotReadResult Overlay(SlotRole role, SlotReadResult disk)
    {
        var pending = TakePending(role, disk);
        return pending is { } p
            ? new SlotReadResult { Status = SlotReadStatus.Ok, Session = p.Session, Marker = p.Marker }
            : disk;
    }

    private async Task<TokenResult> AcquireLockedAsync(SlotRole role, CancellationToken ct, bool forceRefresh = false)
    {
        HealStorage();
        var slot = _vault.Slot(role);
        var read = slot.Read();

        if (TakePending(role, read) is { } pending)
        {
            if (await TryPersistAsync(slot, pending.Session, pending.Marker, ct).ConfigureAwait(false))
            {
                _unpersisted.Remove(role);
            }

            read = new SlotReadResult { Status = SlotReadStatus.Ok, Session = pending.Session, Marker = pending.Marker };
        }

        switch (read.Status)
        {
            case SlotReadStatus.Missing:
                SetFault(role, SessionFault.None);
                return Fail(role, SessionFault.None);
            case SlotReadStatus.IoError:
                SetFault(role, SessionFault.StorageFailure);
                return Fail(role, SessionFault.StorageFailure);
            case SlotReadStatus.Unreadable:
                SetFault(role, SessionFault.LocalCredentialCorrupt);
                return Fail(role, SessionFault.LocalCredentialCorrupt);
        }

        var kind = read.ProvisionalKind ?? SessionKind.Anonymous;

        if (role == SlotRole.LegacyOwner && kind == SessionKind.Registered)
        {
            // A registered credential has no business in the legacy slot: refuse to use it.
            SetFault(role, SessionFault.LocalCredentialCorrupt);
            return Fail(role, SessionFault.LocalCredentialCorrupt);
        }

        if (kind == SessionKind.Registered && !AccountsEnabled)
        {
            SetFault(role, SessionFault.FeatureDisabled);
            return Fail(role, SessionFault.FeatureDisabled);
        }

        if (read.Marker?.Rejected == true)
        {
            SetFault(role, SessionFault.AuthRejected);
            return Fail(role, SessionFault.AuthRejected);
        }

        var session = read.Session!;
        var marker = read.Marker is { } m ? m : SlotMarker.For(kind);

        if (forceRefresh || NeedsRefresh(session))
        {
            var refreshed = await RefreshLockedAsync(role, slot, session, kind, marker, ct).ConfigureAwait(false);
            if (refreshed.Fault != SessionFault.None)
            {
                return Fail(role, refreshed.Fault);
            }

            session = refreshed.Session!;
        }

        if (kind == SessionKind.Registered && _verifiedUserId != session.UserId)
        {
            var verification = await VerifyRegisteredAsync(slot, session, ct).ConfigureAwait(false);
            if (verification != SessionFault.None)
            {
                return Fail(role, verification);
            }
        }

        if (!_unpersisted.ContainsKey(role))
        {
            SetFault(role, SessionFault.None);
        }

        var status = Recompute();
        return new TokenResult
        {
            Ok = true,
            AccessToken = session.AccessToken,
            Role = role,
            Kind = kind,
            UserId = session.UserId,
            Generation = Generation,
            StateAfter = status.State
        };
    }

    private TokenResult Fail(SlotRole role, SessionFault fault)
    {
        var status = Recompute();
        return TokenResult.Fail(role, fault, status.State, Generation);
    }

    private bool NeedsRefresh(AuthSession session) =>
        session.ExpiresAt <= _clock.GetUtcNow().ToUnixTimeSeconds() + RefreshSkewSeconds;

    private readonly record struct RefreshOutcome(AuthSession? Session, SessionFault Fault);

    private async Task<RefreshOutcome> RefreshLockedAsync(
        SlotRole role, CredentialSlot slot, AuthSession current, SessionKind kind, SlotMarker marker, CancellationToken ct)
    {
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var result = await _auth.RefreshAsync(current.RefreshToken, ct).ConfigureAwait(false);

            if (result.Ok)
            {
                var rotated = result.Value!;
                rotated.Email ??= current.Email;
                if (rotated.UserId != current.UserId)
                {
                    // A refresh must never change who we are. Treat as an ambiguous reply and keep what we have.
                    SetFault(role, SessionFault.NetworkUnavailable);
                    return new RefreshOutcome(null, SessionFault.NetworkUnavailable);
                }

                var rotatedMarker = SlotMarker.For(kind);
                if (!await TryPersistAsync(slot, rotated, rotatedMarker, ct).ConfigureAwait(false))
                {
                    // The server already rotated the token; keep the new session usable in memory and retry the write.
                    _unpersisted[role] = (rotated, rotatedMarker, current.RefreshToken);
                    SetFault(role, SessionFault.StorageFailure);
                    return new RefreshOutcome(rotated, SessionFault.None);
                }

                return new RefreshOutcome(rotated, SessionFault.None);
            }

            switch (result.Failure)
            {
                case AuthFailureKind.SessionRejected:
                {
                    // Another process may have rotated the token while we waited; storage was re-read after the
                    // lock, but verify once more before declaring the identity dead.
                    var reread = slot.Read();
                    if (attempt == 0 && reread.Status == SlotReadStatus.Ok && reread.Session!.RefreshToken != current.RefreshToken)
                    {
                        current = reread.Session;
                        continue;
                    }

                    MarkRejected(slot, kind);
                    SetFault(role, SessionFault.AuthRejected);
                    return new RefreshOutcome(null, SessionFault.AuthRejected);
                }
                case AuthFailureKind.RateLimited:
                    SetFault(role, SessionFault.RateLimited);
                    return new RefreshOutcome(null, SessionFault.RateLimited);
                default:
                    // Transient, ambiguous or refused: fail closed, credential untouched.
                    SetFault(role, SessionFault.NetworkUnavailable);
                    return new RefreshOutcome(null, SessionFault.NetworkUnavailable);
            }
        }

        SetFault(role, SessionFault.NetworkUnavailable);
        return new RefreshOutcome(null, SessionFault.NetworkUnavailable);
    }

    private void MarkRejected(CredentialSlot slot, SessionKind kind)
    {
        try
        {
            slot.WriteMarker(SlotMarker.For(kind, rejected: true));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // The in-memory fault still applies for this run; the next start re-discovers the rejection from the server.
        }
    }

    private async Task<SessionFault> VerifyRegisteredAsync(CredentialSlot slot, AuthSession session, CancellationToken ct)
    {
        var user = await _auth.GetUserAsync(session.AccessToken, ct).ConfigureAwait(false);
        if (!user.Ok)
        {
            if (user.Failure == AuthFailureKind.SessionRejected && SessionIsGone(user.ErrorCode))
            {
                MarkRejected(slot, SessionKind.Registered);
                SetFault(SlotRole.Primary, SessionFault.AuthRejected);
                return SessionFault.AuthRejected;
            }

            SetFault(SlotRole.Primary, user.Failure == AuthFailureKind.RateLimited ? SessionFault.RateLimited : SessionFault.NetworkUnavailable);
            return Status.Fault;
        }

        var verified = user.Value!;
        var claims = JwtInspector.TryDecode(session.AccessToken);
        var sameIdentity =
            string.Equals(verified.Id, session.UserId, StringComparison.OrdinalIgnoreCase) &&
            claims?.Subject is { } sub && string.Equals(sub, session.UserId, StringComparison.OrdinalIgnoreCase);

        if (verified.IsAnonymous || !verified.EmailConfirmed || string.IsNullOrWhiteSpace(verified.Email) || !sameIdentity)
        {
            _verificationFailedUserId = session.UserId;
            SetFault(SlotRole.Primary, SessionFault.RegisteredVerificationFailed);
            return SessionFault.RegisteredVerificationFailed;
        }

        _verifiedUserId = session.UserId;
        _verifiedEmail = verified.Email;
        _verificationFailedUserId = null;
        return SessionFault.None;
    }

    private async Task<bool> TryPersistAsync(CredentialSlot slot, AuthSession session, SlotMarker marker, CancellationToken ct)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                slot.Write(session, marker);
                return true;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                try
                {
                    await Task.Delay(50 * (attempt + 1), ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return false;
                }
            }
        }

        return false;
    }

    // ------------------------------------------------------------------------------------------
    // Explicit anonymous mode
    // ------------------------------------------------------------------------------------------

    /// <summary>
    /// The ONLY place an anonymous identity can be created, and only on an explicit user action. An existing
    /// preserved legacy identity is restored instead of creating a new one.
    /// </summary>
    public async Task<StartAnonymousOutcome> StartAnonymousAsync(bool confirmReplaceLostIdentity, CancellationToken ct = default)
    {
        // An owner-only registered-login pilot must never create extra anonymous
        // identities on the one shared production Supabase instance.
        if (!_allowAnonymousCreation) return StartAnonymousOutcome.FeatureDisabled;
        SessionLease lease;
        try
        {
            lease = await _gate.AcquireAsync(_lockTimeout, ct).ConfigureAwait(false);
        }
        catch (SessionLockTimeoutException)
        {
            return StartAnonymousOutcome.LockTimeout;
        }

        using (lease)
        {
            HealStorage();
            var primary = Overlay(SlotRole.Primary, _vault.Primary.Read());

            switch (primary.Status)
            {
                case SlotReadStatus.IoError:
                    return StartAnonymousOutcome.StorageFailure;
                case SlotReadStatus.Ok:
                {
                    var kind = primary.ProvisionalKind;
                    if (kind == SessionKind.Registered)
                    {
                        return StartAnonymousOutcome.AlreadySignedIn;
                    }

                    if (primary.Marker?.Rejected != true)
                    {
                        return StartAnonymousOutcome.AlreadyAnonymous;
                    }

                    if (!confirmReplaceLostIdentity)
                    {
                        return StartAnonymousOutcome.ConfirmationRequired;
                    }

                    break;
                }
                case SlotReadStatus.Unreadable:
                    if (primary.Marker?.KindValue == SessionKind.Registered)
                    {
                        return StartAnonymousOutcome.AlreadySignedIn;
                    }

                    if (!confirmReplaceLostIdentity)
                    {
                        return StartAnonymousOutcome.ConfirmationRequired;
                    }

                    break;
                case SlotReadStatus.Missing:
                    break;
            }

            try
            {
                if (primary.Status == SlotReadStatus.Missing)
                {
                    var legacy = Overlay(SlotRole.LegacyOwner, _vault.LegacyOwner.Read());
                    if (legacy.Status == SlotReadStatus.Ok && legacy.ProvisionalKind == SessionKind.Anonymous && legacy.Marker?.Rejected != true)
                    {
                        _unpersisted.Clear();
                        _vault.Primary.Write(legacy.Session!, legacy.Marker ?? SlotMarker.For(SessionKind.Anonymous));
                        _vault.LegacyOwner.Delete();
                                        Recompute();
                        return StartAnonymousOutcome.RestoredLegacyIdentity;
                    }
                }

                var signup = await _auth.SignUpAnonymouslyAsync(ct).ConfigureAwait(false);
                if (!signup.Ok)
                {
                    return signup.Failure switch
                    {
                        AuthFailureKind.RateLimited => StartAnonymousOutcome.RateLimited,
                        AuthFailureKind.Refused => StartAnonymousOutcome.Refused,
                        _ => StartAnonymousOutcome.Unavailable
                    };
                }

                var created = signup.Value!;
                var claims = JwtInspector.TryDecode(created.AccessToken);
                if (claims?.IsAnonymous == false)
                {
                    return StartAnonymousOutcome.Refused;
                }

                if (primary.Status is SlotReadStatus.Unreadable or SlotReadStatus.Ok)
                {
                    // Never destroy the old credential: set it aside.
                    _vault.Primary.Quarantine();
                }

                _vault.Primary.Write(created, SlotMarker.For(SessionKind.Anonymous));
                _unpersisted.Clear();
                _verifiedUserId = null;
                        Recompute();
                return StartAnonymousOutcome.Created;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return StartAnonymousOutcome.StorageFailure;
            }
        }
    }

    // ------------------------------------------------------------------------------------------
    // Registered sign-in / sign-out
    // ------------------------------------------------------------------------------------------

    /// <summary>
    /// Registered sign-in via the approved password grant, accepted only after GET /auth/v1/user confirms a
    /// non-anonymous, email-confirmed user matching the returned session. The password buffer is wiped.
    /// </summary>
    public async Task<SignInOutcome> SignInRegisteredAsync(string email, char[] password, CancellationToken ct = default)
    {
        try
        {
            if (!AccountsEnabled)
            {
                return SignInOutcome.FeatureDisabled;
            }

            email = (email ?? "").Trim();
            if (email.Length > 254 || !EmailPattern.IsMatch(email) || password.Length == 0 || password.Length > 256)
            {
                return SignInOutcome.InvalidInput;
            }

            SessionLease lease;
            try
            {
                lease = await _gate.AcquireAsync(_lockTimeout, ct).ConfigureAwait(false);
            }
            catch (SessionLockTimeoutException)
            {
                return SignInOutcome.LockTimeout;
            }

            using (lease)
            {
                HealStorage();
                var primary = Overlay(SlotRole.Primary, _vault.Primary.Read());
                var legacy = Overlay(SlotRole.LegacyOwner, _vault.LegacyOwner.Read());

                if (primary.Status == SlotReadStatus.IoError || legacy.Status == SlotReadStatus.IoError)
                {
                    return SignInOutcome.StorageFailure;
                }

                var primaryIsLiveRegistered =
                    primary.Status == SlotReadStatus.Ok &&
                    primary.ProvisionalKind == SessionKind.Registered &&
                    primary.Marker?.Rejected != true &&
                    _verificationFailedUserId != primary.Session!.UserId;
                if (primaryIsLiveRegistered)
                {
                    return SignInOutcome.AlreadySignedIn;
                }

                var grant = await _auth.PasswordGrantAsync(email, password, ct).ConfigureAwait(false);
                if (!grant.Ok)
                {
                    return grant.Failure switch
                    {
                        AuthFailureKind.InvalidCredentials => SignInOutcome.InvalidCredentials,
                        AuthFailureKind.EmailNotConfirmed => SignInOutcome.EmailNotConfirmed,
                        AuthFailureKind.RateLimited => SignInOutcome.RateLimited,
                        AuthFailureKind.Refused => SignInOutcome.InvalidCredentials,
                        _ => SignInOutcome.Unavailable
                    };
                }

                var session = grant.Value!;

                var user = await _auth.GetUserAsync(session.AccessToken, ct).ConfigureAwait(false);
                var claims = JwtInspector.TryDecode(session.AccessToken);
                var proven =
                    user.Ok &&
                    !user.Value!.IsAnonymous &&
                    user.Value.EmailConfirmed &&
                    !string.IsNullOrWhiteSpace(user.Value.Email) &&
                    string.Equals(user.Value.Id, session.UserId, StringComparison.OrdinalIgnoreCase) &&
                    claims?.Subject is { } sub && string.Equals(sub, session.UserId, StringComparison.OrdinalIgnoreCase) &&
                    claims.IsAnonymous != true;
                if (!proven)
                {
                    await TryRevokeAsync(session.AccessToken).ConfigureAwait(false);
                    return user.Ok || user.Failure is AuthFailureKind.SessionRejected or AuthFailureKind.Ambiguous
                        ? SignInOutcome.VerificationFailed
                        : SignInOutcome.Unavailable;
                }

                session.Email = user.Value!.Email;

                try
                {
                    // Step 1: preserve the anonymous identity in the legacy slot (copy, atomic).
                    if (primary.Status == SlotReadStatus.Ok && primary.ProvisionalKind == SessionKind.Anonymous)
                    {
                        if (legacy.Status == SlotReadStatus.Ok && legacy.Session!.UserId != primary.Session!.UserId)
                        {
                            await TryRevokeAsync(session.AccessToken).ConfigureAwait(false);
                            return SignInOutcome.LegacySlotOccupied;
                        }

                        _vault.LegacyOwner.Write(primary.Session!, primary.Marker ?? SlotMarker.For(SessionKind.Anonymous));
                    }
                    else if (primary.Status == SlotReadStatus.Unreadable ||
                             (primary.Status == SlotReadStatus.Ok && primary.ProvisionalKind == SessionKind.Registered))
                    {
                        // A dead/damaged primary is set aside, never deleted.
                        _vault.Primary.Quarantine();
                    }

                    // Step 2: the registered session becomes primary.
                    _vault.Primary.Write(session, SlotMarker.For(SessionKind.Registered));
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    await TryRevokeAsync(session.AccessToken).ConfigureAwait(false);
                    return SignInOutcome.StorageFailure;
                }

                _unpersisted.Clear();
                _verifiedUserId = session.UserId;
                _verifiedEmail = user.Value.Email;
                _verificationFailedUserId = null;
                SetFault(SlotRole.Primary, SessionFault.None);
                        Recompute();
                return SignInOutcome.Success;
            }
        }
        finally
        {
            Array.Clear(password);
        }
    }

    /// <summary>
    /// Registered logout: POST /auth/v1/logout?scope=local, then local removal. If the server cannot be reached the
    /// credential is moved to a pending-revocation slot (never silently dropped) and the result says so.
    /// The legacy anonymous owner credential is never touched.
    /// </summary>
    public async Task<SignOutOutcome> SignOutRegisteredAsync(CancellationToken ct = default)
    {
        if (!AccountsEnabled)
        {
            return SignOutOutcome.FeatureDisabled;
        }

        SessionLease lease;
        try
        {
            lease = await _gate.AcquireAsync(_lockTimeout, ct).ConfigureAwait(false);
        }
        catch (SessionLockTimeoutException)
        {
            return SignOutOutcome.LockTimeout;
        }

        using (lease)
        {
            HealStorage();
            var primary = _vault.Primary.Read();
            if (primary.Status == SlotReadStatus.Missing)
            {
                return SignOutOutcome.NotSignedIn;
            }

            if (primary.Status == SlotReadStatus.IoError)
            {
                return SignOutOutcome.StorageFailure;
            }

            if (primary.Status == SlotReadStatus.Unreadable)
            {
                if (primary.Marker?.KindValue != SessionKind.Registered)
                {
                    return SignOutOutcome.NotSignedIn;
                }

                // Nothing readable to revoke: set the damaged file aside and sign out locally.
                try { _vault.Primary.Quarantine(); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return SignOutOutcome.StorageFailure; }
                FinishSignOut();
                return SignOutOutcome.LocalOnlyRevocationPending;
            }

            if (primary.ProvisionalKind != SessionKind.Registered)
            {
                return SignOutOutcome.NotSignedIn;
            }

            var outcome = primary.Marker?.Rejected == true
                ? new Revocation(RevocationResult.AlreadyEnded, primary.Session!)
                : await RevokeCoreAsync(primary.Session!, ct).ConfigureAwait(false);
            var revocation = outcome.Result;

            try
            {
                if (revocation == RevocationResult.NotConfirmed)
                {
                    // Keep a secure copy so the revocation can be retried; only then drop the primary slot.
                    _vault.PendingRevocation.Write(outcome.Latest, SlotMarker.For(SessionKind.Registered));
                }

                _vault.Primary.Delete();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return SignOutOutcome.StorageFailure;
            }

            FinishSignOut();
            return revocation == RevocationResult.NotConfirmed ? SignOutOutcome.LocalOnlyRevocationPending : SignOutOutcome.Confirmed;
        }
    }

    private void FinishSignOut()
    {
        _verifiedUserId = null;
        _verifiedEmail = null;
        _verificationFailedUserId = null;
        _unpersisted.Remove(SlotRole.Primary);
        SetFault(SlotRole.Primary, SessionFault.None);
        Recompute();
    }

    /// <summary>Retries a revocation that could not be confirmed at sign-out.</summary>
    public async Task<SignOutOutcome> RetryPendingRevocationAsync(CancellationToken ct = default)
    {
        if (!AccountsEnabled)
        {
            return SignOutOutcome.FeatureDisabled;
        }

        SessionLease lease;
        try
        {
            lease = await _gate.AcquireAsync(_lockTimeout, ct).ConfigureAwait(false);
        }
        catch (SessionLockTimeoutException)
        {
            return SignOutOutcome.LockTimeout;
        }

        using (lease)
        {
            var pending = _vault.PendingRevocation.Read();
            if (pending.Status == SlotReadStatus.Missing)
            {
                Recompute();
                return SignOutOutcome.NotSignedIn;
            }

            if (pending.Status != SlotReadStatus.Ok)
            {
                // Unreadable or busy: keep the file; it is the only evidence of the open session.
                return SignOutOutcome.StorageFailure;
            }

            var result = await RevokeLockedAsync(pending.Session!, ct).ConfigureAwait(false);
            if (result == RevocationResult.NotConfirmed)
            {
                return SignOutOutcome.LocalOnlyRevocationPending;
            }

            try { _vault.PendingRevocation.Delete(); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return SignOutOutcome.StorageFailure; }
            Recompute();
            return SignOutOutcome.Confirmed;
        }
    }

    /// <summary>Explicit user decision to stop retrying; the remote session may remain active until its refresh token ages out.</summary>
    public async Task<bool> DiscardPendingRevocationAsync(bool confirmed, CancellationToken ct = default)
    {
        if (!confirmed || !AccountsEnabled)
        {
            return false;
        }

        try
        {
            using var lease = await _gate.AcquireAsync(_lockTimeout, ct).ConfigureAwait(false);
            _vault.PendingRevocation.Delete();
            Recompute();
            return true;
        }
        catch (Exception ex) when (ex is SessionLockTimeoutException or IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    // ------------------------------------------------------------------------------------------
    // Forget the legacy anonymous identity
    // ------------------------------------------------------------------------------------------

    /// <summary>
    /// Abandon the preserved anonymous owner identity. Requires explicit confirmation, revokes the session with
    /// scope=local when possible, and keeps the credential if revocation fails (unless the user explicitly
    /// chooses to discard it unrevoked). Never called implicitly by a sign-in.
    /// </summary>
    public async Task<ForgetOutcome> ForgetLegacyOwnerAsync(bool confirmed, bool discardIfRevocationFails, CancellationToken ct = default)
    {
        if (!confirmed)
        {
            return ForgetOutcome.ConfirmationRequired;
        }

        if (!AccountsEnabled)
        {
            return ForgetOutcome.NothingToForget;
        }

        SessionLease lease;
        try
        {
            lease = await _gate.AcquireAsync(_lockTimeout, ct).ConfigureAwait(false);
        }
        catch (SessionLockTimeoutException)
        {
            return ForgetOutcome.LockTimeout;
        }

        using (lease)
        {
            HealStorage();
            var legacy = _vault.LegacyOwner.Read();
            if (legacy.Status == SlotReadStatus.Missing)
            {
                return ForgetOutcome.NothingToForget;
            }

            if (legacy.Status == SlotReadStatus.IoError)
            {
                return ForgetOutcome.StorageFailure;
            }

            ForgetOutcome outcome;
            if (legacy.Status == SlotReadStatus.Unreadable)
            {
                outcome = ForgetOutcome.DiscardedUnrevoked;
            }
            else if (legacy.Marker?.Rejected == true)
            {
                outcome = ForgetOutcome.AlreadyEnded;
            }
            else
            {
                var result = await RevokeLockedAsync(legacy.Session!, ct).ConfigureAwait(false);
                switch (result)
                {
                    case RevocationResult.Confirmed:
                        outcome = ForgetOutcome.Revoked;
                        break;
                    case RevocationResult.AlreadyEnded:
                        outcome = ForgetOutcome.AlreadyEnded;
                        break;
                    default:
                        if (!discardIfRevocationFails)
                        {
                            SetFault(SlotRole.LegacyOwner, SessionFault.NetworkUnavailable);
                            Recompute();
                            return ForgetOutcome.RevocationFailedKept;
                        }

                        outcome = ForgetOutcome.DiscardedUnrevoked;
                        break;
                }
            }

            try
            {
                _vault.LegacyOwner.Delete();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return ForgetOutcome.StorageFailure;
            }

            _unpersisted.Remove(SlotRole.LegacyOwner);
            SetFault(SlotRole.LegacyOwner, SessionFault.None);
                Recompute();
            return outcome;
        }
    }

    // ------------------------------------------------------------------------------------------
    // Revocation helper
    // ------------------------------------------------------------------------------------------

    private enum RevocationResult
    {
        Confirmed,
        AlreadyEnded,
        NotConfirmed
    }

    /// <summary>
    /// scope=local logout of the given session. Refreshes an expired access token first; a definitively rejected
    /// session counts as ended. Anything ambiguous is NOT reported as confirmed.
    /// </summary>
    private async Task<RevocationResult> RevokeLockedAsync(AuthSession session, CancellationToken ct) =>
        (await RevokeCoreAsync(session, ct).ConfigureAwait(false)).Result;

    private readonly record struct Revocation(RevocationResult Result, AuthSession Latest);

    private static bool SessionIsGone(string? code) =>
        code is "session_not_found" or "session_expired" or "user_not_found";

    // Returns the newest session known (a refresh rotates the token, so a retry must use the rotated one).
    private async Task<Revocation> RevokeCoreAsync(AuthSession session, CancellationToken ct)
    {
        var latest = session;
        var token = session.AccessToken;
        var refreshedOnce = false;

        async Task<bool> RefreshAsync()
        {
            var refreshed = await _auth.RefreshAsync(latest.RefreshToken, ct).ConfigureAwait(false);
            refreshedOnce = true;
            if (!refreshed.Ok)
            {
                return false;
            }

            latest = refreshed.Value!;
            latest.Email ??= session.Email;
            token = latest.AccessToken;
            return true;
        }

        if (NeedsRefresh(session))
        {
            if (!await RefreshAsync().ConfigureAwait(false))
            {
                // Only a definitive "session does not exist" proves it ended; a spent or unknown refresh token does not.
                return new Revocation(RevocationResult.NotConfirmed, latest);
            }
        }

        var logout = await _auth.LogoutLocalAsync(token, ct).ConfigureAwait(false);
        if (!logout.Ok && logout.ErrorCode == "bad_jwt" && !refreshedOnce && await RefreshAsync().ConfigureAwait(false))
        {
            // The server refused an access token our clock thought valid (clock skew): retry once with a fresh one.
            logout = await _auth.LogoutLocalAsync(token, ct).ConfigureAwait(false);
        }

        if (logout.Ok)
        {
            return new Revocation(RevocationResult.Confirmed, latest);
        }

        return new Revocation(
            logout.Failure == AuthFailureKind.SessionRejected && SessionIsGone(logout.ErrorCode)
                ? RevocationResult.AlreadyEnded
                : RevocationResult.NotConfirmed,
            latest);
    }

    private async Task TryRevokeAsync(string accessToken)
    {
        try
        {
            await _auth.LogoutLocalAsync(accessToken, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // Best effort cleanup of a session we decided not to keep.
        }
    }

    // ------------------------------------------------------------------------------------------
    // State computation
    // ------------------------------------------------------------------------------------------

    private void HealStorage()
    {
        try
        {
            _vault.Primary.Repair();
            _vault.LegacyOwner.Repair();

            // Interrupted sign-in migration: the anonymous credential was copied to the legacy slot but the
            // primary was never replaced. Same identity in both slots: the legacy copy is redundant.
            var primary = _vault.Primary.Read();
            var legacy = _vault.LegacyOwner.Read();
            if (primary.Status == SlotReadStatus.Ok && legacy.Status == SlotReadStatus.Ok &&
                primary.Session!.UserId == legacy.Session!.UserId && primary.ProvisionalKind == SessionKind.Anonymous)
            {
                _vault.LegacyOwner.Delete();
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Healing is opportunistic; reads still classify what is readable.
        }
    }

    private AccountStatus SetFault(SlotRole role, SessionFault fault)
    {
        lock (_stateLock)
        {
            if (fault == SessionFault.None)
            {
                _faults.Remove(role);
            }
            else
            {
                _faults[role] = fault;
            }
        }

        return Recompute();
    }

    private AccountStatus Recompute()
    {
        var primary = _vault.Primary.Read();
        var legacy = _vault.LegacyOwner.Read();
        var pendingRevocation = _vault.PendingRevocation.Read().Status != SlotReadStatus.Missing;

        SessionState state;
        var fault = SessionFault.None;
        string? email = null;
        var verified = false;

        switch (primary.Status)
        {
            case SlotReadStatus.Missing:
                state = SessionState.LoggedOut;
                break;
            case SlotReadStatus.Unreadable:
                fault = SessionFault.LocalCredentialCorrupt;
                state = primary.Marker?.KindValue switch
                {
                    SessionKind.Registered => SessionState.ReauthRequired,
                    SessionKind.Anonymous => SessionState.AnonymousIdentityLost,
                    _ => SessionState.LoggedOut
                };
                break;
            case SlotReadStatus.IoError:
                fault = SessionFault.StorageFailure;
                state = Status.State;
                break;
            default:
            {
                var kind = primary.ProvisionalKind ?? SessionKind.Anonymous;
                var rejected = primary.Marker?.Rejected == true;
                if (kind == SessionKind.Registered)
                {
                    var failed = _verificationFailedUserId == primary.Session!.UserId;
                    if (rejected)
                    {
                        state = SessionState.ReauthRequired;
                        fault = SessionFault.AuthRejected;
                    }
                    else if (!AccountsEnabled)
                    {
                        state = SessionState.ReauthRequired;
                        fault = SessionFault.FeatureDisabled;
                    }
                    else if (failed)
                    {
                        state = SessionState.ReauthRequired;
                        fault = SessionFault.RegisteredVerificationFailed;
                    }
                    else
                    {
                        state = SessionState.Registered;
                        verified = _verifiedUserId == primary.Session!.UserId;
                        email = verified ? _verifiedEmail : null;
                    }
                }
                else if (rejected)
                {
                    state = SessionState.AnonymousIdentityLost;
                    fault = SessionFault.AuthRejected;
                }
                else
                {
                    state = _claimPending ? SessionState.AnonymousClaiming : SessionState.Anonymous;
                }

                break;
            }
        }

        var legacyPresent = legacy.Status != SlotReadStatus.Missing;
        var legacyFault = legacy.Status switch
        {
            SlotReadStatus.Unreadable => SessionFault.LocalCredentialCorrupt,
            SlotReadStatus.IoError => SessionFault.StorageFailure,
            SlotReadStatus.Ok when legacy.Marker?.Rejected == true => SessionFault.AuthRejected,
            _ => SessionFault.None
        };

        AccountStatus next;
        bool changed;
        string key;
        long? raise = null;
        lock (_stateLock)
        {
            if (fault == SessionFault.None && _faults.TryGetValue(SlotRole.Primary, out var transient))
            {
                fault = transient;
            }

            if (legacyFault == SessionFault.None && _faults.TryGetValue(SlotRole.LegacyOwner, out var legacyTransient))
            {
                legacyFault = legacyTransient;
            }

            var usable = state is SessionState.Anonymous or SessionState.AnonymousClaiming or SessionState.Registered;
            var legacyUsable = legacy.Status == SlotReadStatus.Ok && legacy.Marker?.Rejected != true;
            key = $"{primary.Session?.UserId}|{usable}|{legacy.Session?.UserId}|{legacyUsable}|{pendingRevocation}";

            next = new AccountStatus(
                state, fault, email, legacyPresent, legacyFault, pendingRevocation, AccountsEnabled,
                Interlocked.Read(ref _generation), verified, primary.Status != SlotReadStatus.Missing);
            changed = next != _status;
            _status = next;

            var slotReadFailed = primary.Status == SlotReadStatus.IoError || legacy.Status == SlotReadStatus.IoError;
            if (!slotReadFailed && key != _identityKey)
            {
                var first = _identityKey.Length == 0;
                _identityKey = key;
                if (!first)
                {
                    // An identity change not caused by an explicit operation (rejection discovered, file edited,
                    // another process switched). Invalidate scoped work as well.
                    var generation = Interlocked.Increment(ref _generation);
                    next = next with { Generation = generation };
                    _status = next;
                    changed = true;
                    raise = generation;
                }
            }
        }

        if (raise is { } generationChanged)
        {
            IdentityChanged?.Invoke(generationChanged);
        }

        if (changed)
        {
            StatusChanged?.Invoke(next);
        }

        return next;
    }
}
