using System.Text.RegularExpressions;

namespace ForeverDB.Companion.Account;

/// <summary>The approved zero-touch Companion states (zero-touch-rpc-contract.md, "Companion states").</summary>
public enum DeviceState
{
    /// <summary>No activation and no device credential: the legacy anonymous path is unchanged.</summary>
    Anonymous,
    /// <summary>An activation file was found but not redeemed yet (offline, rate limited, no installation known).</summary>
    PendingActivation,
    /// <summary>A device credential exists locally (and, once checked, the server reports the device active).</summary>
    Registered,
    ActivationExpired,
    /// <summary>The ticket is invalid, already consumed or revoked.</summary>
    ActivationRejected,
    DeviceRevoked,
    /// <summary>installation_conflict / installation_bound / identity_in_use / ownership_conflict.</summary>
    OwnershipConflict,
    AccountUnavailable,
    /// <summary>The local device credential or device session is unreadable or no longer accepted. Nothing was replaced.</summary>
    CredentialDamaged
}

/// <summary>Why the device is in its state; picks the wording. Never carries a server body, ticket or secret.</summary>
public enum DeviceDetail
{
    None,
    Offline,
    RateLimited,
    NoInstallation,
    MultipleInstallations,
    InvalidInstallation,
    ServiceNotReady,
    ServiceRefused,
    Unexpected,
    StorageFailure,
    LockTimeout,
    TicketConsumed,
    TicketRevoked,
    TicketInvalid,
    TicketExpired,
    InstallationConflict,
    InstallationBound,
    IdentityInUse,
    OwnershipChanged,
    LimitReached,
    StaleCredential,
    DeviceUnknown,
    SessionNotAccepted,
    AutoSyncOff,
    Synced
}

/// <summary>Immutable snapshot of the device state for the UI. Never carries a ticket, secret or token.</summary>
public sealed record DeviceStatus(DeviceState State, DeviceDetail Detail = DeviceDetail.None)
{
    public static DeviceStatus Initial => new(DeviceState.Anonymous);
    public string Message => AccountMessages.Describe(this);
    public override string ToString() => $"DeviceStatus({State}, {Detail})";
}

/// <summary>Formats and limits fixed by the RPC contract; used to validate every value before it is stored or sent.</summary>
public static class DeviceContract
{
    public const int MaxActivationFileBytes = 1024;
    public const string ActivationFormat = "foreverdb-activation";
    public const int ActivationVersion = 1;
    public const string ActivationFileName = "foreverdb-activation.fdbact";
    public const string DeviceSubdirectory = "device";

    public static readonly Regex TicketPattern = new("^fdba1_[A-Za-z0-9_-]{43}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    public static readonly Regex SecretPattern = new("^fdbd1_([0-9a-f]{32})_[A-Za-z0-9_-]{43}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    // p_installation_id: 16-128 characters.
    public static readonly Regex InstallationIdPattern = new("^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>True when <paramref name="secret"/> is well formed and its embedded device id equals <paramref name="deviceId"/>.</summary>
    public static bool SecretMatchesDevice(string secret, string deviceId)
    {
        var m = SecretPattern.Match(secret);
        return m.Success && Guid.TryParse(deviceId, out var g) && string.Equals(g.ToString("N"), m.Groups[1].Value, StringComparison.Ordinal);
    }
}

/// <summary>The persisted device credential. Stored only inside the DPAPI blob; never logged, never in settings or SavedVariables.</summary>
public sealed class DeviceCredential
{
    public string DeviceId { get; set; } = "";
    public string DeviceSecret { get; set; } = "";
    public string InstallationId { get; set; } = "";
    public DateTimeOffset EnrolledAt { get; set; }

    /// <summary>SHA-256 (hex) of the ticket this device was enrolled with, so a leftover activation file can be recognised and removed.</summary>
    public string? RedeemedTicketHash { get; set; }

    public DeviceCredential Clone() => (DeviceCredential)MemberwiseClone();

    public bool IsWellFormed =>
        Guid.TryParse(DeviceId, out _) &&
        DeviceContract.SecretMatchesDevice(DeviceSecret, DeviceId) &&
        DeviceContract.InstallationIdPattern.IsMatch(InstallationId);

    public override string ToString() => "DeviceCredential(redacted)";
}
