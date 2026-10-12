using System.Text.Json;
using System.Text.Json.Serialization;

namespace ForeverDB.Companion.Account;

/// <summary>
/// Persisted credential. The property names and casing are the 0.8.x format
/// (default System.Text.Json, PascalCase) and must not change: an existing
/// 0.8.x session must stay readable after the upgrade, and 0.8.x readers ignore
/// the optional <see cref="Email"/> field.
/// </summary>
public sealed class AuthSession
{
    public string AccessToken { get; set; } = "";
    public string RefreshToken { get; set; } = "";
    public long ExpiresAt { get; set; }
    public string UserId { get; set; } = "";

    /// <summary>Display hint for a registered session; never trusted until the server confirmed it.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Email { get; set; }

    public AuthSession Clone() => (AuthSession)MemberwiseClone();

    public override string ToString() => "AuthSession(redacted)";
}

public enum SessionKind
{
    Anonymous,
    Registered
}

/// <summary>Which credential slot a token belongs to.</summary>
public enum SlotRole
{
    /// <summary>session.dat: the identity the user is currently working as.</summary>
    Primary,
    /// <summary>legacy-owner.dat: the original anonymous owner kept after a registered sign-in.</summary>
    LegacyOwner
}

/// <summary>The approved Companion session states (ownership-claim-protocol.md section 2).</summary>
public enum SessionState
{
    LoggedOut,
    Anonymous,
    AnonymousClaiming,
    Registered,
    ReauthRequired,
    AnonymousIdentityLost
}

/// <summary>
/// Why the session is in its state, or why it is currently degraded. The state machine keeps these
/// separate: a network problem is never a rejection, and a rejection is never corruption.
/// </summary>
public enum SessionFault
{
    None,
    /// <summary>Network, timeout or 5xx. The credential is untouched; retry later.</summary>
    NetworkUnavailable,
    /// <summary>Auth rate limit. Credential untouched.</summary>
    RateLimited,
    /// <summary>The server definitively invalidated the session.</summary>
    AuthRejected,
    /// <summary>The local credential file cannot be decrypted or parsed.</summary>
    LocalCredentialCorrupt,
    /// <summary>Reading or writing the credential file failed (antivirus lock, disk). Credential untouched.</summary>
    StorageFailure,
    /// <summary>Another Companion process holds the session lock.</summary>
    LockTimeout,
    /// <summary>The registered session could not be proven to be a confirmed, non-anonymous account.</summary>
    RegisteredVerificationFailed,
    /// <summary>Account System V1 is not enabled in this build/configuration.</summary>
    FeatureDisabled
}

/// <summary>Immutable snapshot of what the UI may show. Never carries a token.</summary>
public sealed record AccountStatus(
    SessionState State,
    SessionFault Fault,
    string? VerifiedEmail,
    bool HasLegacyOwner,
    SessionFault LegacyFault,
    bool PendingRevocation,
    bool AccountsEnabled,
    long Generation,
    bool IdentityVerified = false,
    bool PrimaryCredentialPresent = false)
{
    public static AccountStatus Initial(bool accountsEnabled) =>
        new(SessionState.LoggedOut, SessionFault.None, null, false, SessionFault.None, false, accountsEnabled, 0);
}

/// <summary>Result of asking the manager for an access token.</summary>
public sealed class TokenResult
{
    public bool Ok { get; init; }
    public string AccessToken { get; init; } = "";
    public SlotRole Role { get; init; }
    public SessionKind Kind { get; init; }
    public string UserId { get; init; } = "";
    /// <summary>Identity generation the token belongs to; a changed generation invalidates in-flight work.</summary>
    public long Generation { get; init; }
    public SessionFault Fault { get; init; }
    public SessionState StateAfter { get; init; }

    public static TokenResult Fail(SlotRole role, SessionFault fault, SessionState state, long generation) =>
        new() { Ok = false, Role = role, Fault = fault, StateAfter = state, Generation = generation };

    public override string ToString() => Ok ? "TokenResult(ok, redacted)" : $"TokenResult({Fault})";
}

/// <summary>Non-secret JSON marker stored next to a credential blob (recovery classification only).</summary>
public sealed class SlotMarker
{
    public int V { get; set; } = 1;
    /// <summary>"anonymous" or "registered".</summary>
    public string Kind { get; set; } = "";
    /// <summary>"active" or "rejected" (the server definitively invalidated the session).</summary>
    public string Status { get; set; } = "active";

    public static SlotMarker For(SessionKind kind, bool rejected = false) => new()
    {
        Kind = kind == SessionKind.Registered ? "registered" : "anonymous",
        Status = rejected ? "rejected" : "active"
    };

    public SessionKind? KindValue => Kind switch
    {
        "registered" => SessionKind.Registered,
        "anonymous" => SessionKind.Anonymous,
        _ => null
    };

    public bool Rejected => string.Equals(Status, "rejected", StringComparison.Ordinal);

    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
}
