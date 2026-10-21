namespace ForeverDB.Companion.Account;

/// <summary>
/// User-facing wording for every state and outcome. Fixed strings only: nothing here ever formats a server
/// response, an exception message, a token or a claim code.
/// </summary>
public static class AccountMessages
{
    public static string Headline(AccountStatus status, string? email = null) => status.State switch
    {
        SessionState.LoggedOut => "Not signed in",
        SessionState.Anonymous => "Using ForeverDB anonymously",
        SessionState.AnonymousClaiming => "Using ForeverDB anonymously (link code shown)",
        SessionState.Registered => string.IsNullOrWhiteSpace(email)
            ? (status.IdentityVerified ? "Signed in" : "Signed in (verifying with the server…)")
            : $"Signed in as {email}",
        SessionState.ReauthRequired => "Sign-in required again",
        SessionState.AnonymousIdentityLost => "Anonymous identity lost",
        _ => "Unknown"
    };

    public static string Detail(AccountStatus status)
    {
        var lines = new List<string>();

        lines.Add(status.State switch
        {
            SessionState.LoggedOut when status.Fault == SessionFault.LocalCredentialCorrupt =>
                "A damaged credential file was found. Nothing was replaced. Sign in to a ForeverDB account, or confirm that you want to start a new anonymous identity.",
            SessionState.LoggedOut =>
                "Choose how to use ForeverDB: sign in to a ForeverDB account, or use ForeverDB anonymously. Public observations work either way; account Guildbook data appears after registered sign-in.",
            SessionState.Anonymous =>
                "Your installations sync with this computer's anonymous ForeverDB identity.",
            SessionState.AnonymousClaiming =>
                "A link code is displayed. Installations keep syncing until the website confirms the transfer.",
            SessionState.Registered =>
                "Installations owned by your account sync with your account. Installations still owned by the preserved anonymous identity keep syncing through it.",
            SessionState.ReauthRequired => status.Fault switch
            {
                SessionFault.LocalCredentialCorrupt => "The stored sign-in is damaged and cannot be read. Sign in again. No anonymous identity was created.",
                SessionFault.FeatureDisabled => "A registered sign-in was found but account features are not enabled in this build. Nothing was changed.",
                SessionFault.RegisteredVerificationFailed => "The server did not confirm this account. Sign in again. No anonymous identity was created.",
                _ => "The server no longer accepts this sign-in. Sign in again to resume syncing your account's installations. No anonymous identity was created."
            },
            SessionState.AnonymousIdentityLost =>
                "The server no longer accepts this computer's anonymous identity (or its credential is damaged). Installations it owned cannot sync from here. Nothing was replaced automatically.",
            _ => ""
        });

        switch (status.Fault)
        {
            case SessionFault.NetworkUnavailable:
                lines.Add("ForeverDB could not be reached. Your sign-in was kept; the Companion will retry.");
                break;
            case SessionFault.RateLimited:
                lines.Add("Too many requests. Your sign-in was kept; try again shortly.");
                break;
            case SessionFault.StorageFailure:
                lines.Add("The credential file could not be read or written just now (another program may hold it). Nothing was changed.");
                break;
            case SessionFault.LockTimeout:
                lines.Add("Another ForeverDB Companion window is using the sign-in. Try again in a moment.");
                break;
        }

        if (status.PendingRevocation)
        {
            lines.Add("A previous sign-out could not be confirmed with the server yet. It will be retried; until then that session may remain active on the server.");
        }

        return string.Join(" ", lines.Where(l => l.Length > 0));
    }

    public static string Describe(BlockReason reason) => reason switch
    {
        BlockReason.None => "",
        BlockReason.NoCredential => "Not signed in: choose a sign-in or anonymous mode on the Account tab.",
        BlockReason.ReauthRequired => "Sign in again on the Account tab to sync this account's installations.",
        BlockReason.AnonymousIdentityLost => "The anonymous identity for this installation is lost; see the Account tab.",
        BlockReason.TransferredSignInRequired => "Ownership moved to a ForeverDB account. Sign in to that account to keep syncing.",
        BlockReason.OwnedByDifferentAccount => "This installation belongs to a different ForeverDB account than the one signed in.",
        BlockReason.OwnerSelectionRequired => "Owner not established yet. Choose who should own this installation on the Account tab.",
        BlockReason.OwnershipConflict => "Ownership could not be verified consistently; sync is paused.",
        BlockReason.OwnershipUnavailable => "Ownership could not be verified right now; sync is paused and will be retried.",
        BlockReason.OwnerMismatch => "The server says this installation belongs to someone else. Nothing was uploaded.",
        BlockReason.Unauthorized => "The server did not accept the sign-in; try again.",
        BlockReason.Forbidden => "The server refused this identity for sync.",
        BlockReason.RateLimited => "Sync is rate limited; it will be retried.",
        BlockReason.ServerUnavailable => "ForeverDB is temporarily unavailable; sync will be retried.",
        BlockReason.NotDeployed => "The ForeverDB service does not support this feature yet.",
        BlockReason.FeatureDisabled => "Account features are not enabled in this build.",
        BlockReason.PilotUploadDisabled => "Snapshot upload is intentionally disabled in this private pilot. Registered sign-in and installation linking remain available on the Account tab.",
        BlockReason.CredentialUnavailable => "The sign-in could not be used just now; sync will be retried.",
        BlockReason.InvalidRequest => "The server rejected the upload.",
        BlockReason.DeviceAutoSyncOff => "This computer is a registered device: automatic upload is off. Use Sync now to upload.",
        BlockReason.DeviceSyncNotCompleted => "The registered device did not upload. See the Registered device line on the Account tab.",
        _ => "Sync is paused."
    };

    public static string Headline(DeviceState state) => state switch
    {
        DeviceState.Anonymous => "No activation",
        DeviceState.PendingActivation => "Activation pending",
        DeviceState.Registered => "Registered device",
        DeviceState.ActivationExpired => "Activation file expired",
        DeviceState.ActivationRejected => "Activation file not accepted",
        DeviceState.DeviceRevoked => "Device revoked",
        DeviceState.OwnershipConflict => "Installation conflict",
        DeviceState.AccountUnavailable => "Account unavailable",
        DeviceState.CredentialDamaged => "Device credential damaged",
        _ => "Unknown"
    };

    /// <summary>Fixed, secret-free wording for the zero-touch device state: what happened and what to do next.</summary>
    public static string Describe(DeviceStatus status)
    {
        var text = status.State switch
        {
            DeviceState.Anonymous => "This computer has no activation file. ForeverDB works as before.",
            DeviceState.PendingActivation => status.Detail switch
            {
                DeviceDetail.NoInstallation => "An activation file was found, but no ForeverDB installation is known yet. Start World of Warcraft with the ForeverDB addon once, then reopen the Companion. The file was kept.",
                DeviceDetail.MultipleInstallations => "An activation file was found, but more than one installation was detected. A computer can be activated for one installation only. The file was kept.",
                DeviceDetail.InvalidInstallation => "The server did not accept this computer's installation identifier. The activation file was kept; nothing was changed.",
                DeviceDetail.StorageFailure => "The device credential could not be stored safely just now. The Companion will try again; do not delete the activation file.",
                _ => "An activation file was found but has not been redeemed yet. It was kept and the Companion will try again when ForeverDB can be reached."
            },
            DeviceState.Registered => status.Detail == DeviceDetail.Synced
                ? "Uploaded with this computer's registered device. No sign-in was needed."
                : "This computer is registered to your ForeverDB account. Use Sync now to upload; automatic upload is off for registered devices.",
            DeviceState.ActivationExpired =>
                "This activation file has expired. Download a new activation file from your ForeverDB account > Devices; you do not need to reinstall. Your local data was not changed.",
            DeviceState.ActivationRejected => status.Detail switch
            {
                DeviceDetail.TicketConsumed => "This activation file was already used. If this computer is not shown as registered, download a NEW activation file from your ForeverDB account > Devices; the old one is spent.",
                DeviceDetail.TicketRevoked => "This activation file was revoked on the website. Download a new activation file from your ForeverDB account > Devices.",
                _ => "This activation file is not valid. Download a new activation file from your ForeverDB account > Devices."
            },
            DeviceState.DeviceRevoked =>
                "This device was revoked in your ForeverDB account. Nothing is uploaded from here. To use this computer again, download a new activation file from your ForeverDB account > Devices.",
            DeviceState.OwnershipConflict => status.Detail switch
            {
                DeviceDetail.InstallationConflict => "This computer already has an anonymous installation; link it with a claim code. The activation did not change the installation's owner.",
                DeviceDetail.InstallationBound => "This installation is already bound to another device of the account. Revoke that device in your ForeverDB account > Devices, then download a new activation file.",
                DeviceDetail.IdentityInUse => "This computer's device identity is already registered for another installation. Nothing was changed.",
                _ => "The server reports that this installation no longer belongs to the account this device was registered for. Nothing was uploaded."
            },
            DeviceState.AccountUnavailable => status.Detail == DeviceDetail.LimitReached
                ? "Your account has reached its device limit. Revoke a device you no longer use in your ForeverDB account > Devices, then try again."
                : "Your ForeverDB account is not available right now. Nothing was uploaded; this computer keeps its registration.",
            DeviceState.CredentialDamaged => status.Detail switch
            {
                DeviceDetail.StaleCredential => "The device credential on this computer is out of date. Download a new activation file from your ForeverDB account > Devices.",
                DeviceDetail.DeviceUnknown or DeviceDetail.SessionNotAccepted => "The server no longer recognises this computer's device credential. Nothing was replaced. Download a new activation file from your ForeverDB account > Devices.",
                _ => "The device credential on this computer is damaged and cannot be read. Nothing was replaced and no new identity was created. Download a new activation file from your ForeverDB account > Devices."
            },
            _ => ""
        };

        var extra = status.Detail switch
        {
            DeviceDetail.Offline => "ForeverDB could not be reached; nothing was lost and it will be retried.",
            DeviceDetail.RateLimited => "Too many requests; try again shortly.",
            DeviceDetail.ServiceNotReady => "The ForeverDB service does not support device activation yet.",
            DeviceDetail.ServiceRefused => "The server refused this request.",
            DeviceDetail.SessionNotAccepted when status.State is not DeviceState.CredentialDamaged => "The server did not accept this computer's device session just now; try again.",
            DeviceDetail.Unexpected => "ForeverDB sent an unexpected answer. Nothing was changed.",
            DeviceDetail.StorageFailure when status.State is not (DeviceState.PendingActivation) => "The credential file could not be read or written just now. Nothing was changed.",
            DeviceDetail.LockTimeout => "Another ForeverDB Companion window is working on this computer's device. Try again in a moment.",
            DeviceDetail.AutoSyncOff => "Automatic upload is off for registered devices; use Sync now.",
            DeviceDetail.StaleCredential when status.State is not DeviceState.CredentialDamaged => "The device credential is being renewed; try Sync now again later.",
            _ => ""
        };

        return extra.Length == 0 ? text : text + " " + extra;
    }

    public static string Describe(DeviceSyncResult result) => result.Outcome switch
    {
        DeviceSyncOutcome.Synced => "Uploaded with this computer's registered device.",
        DeviceSyncOutcome.NotRegistered => "This computer is not a registered device.",
        DeviceSyncOutcome.AutoSyncOff => "Automatic upload is off for registered devices; use Sync now.",
        _ => result.Status.Message
    };

    public static string Describe(InstallationOwnership ownership) => ownership switch
    {
        InstallationOwnership.Unchecked => "Not checked yet",
        InstallationOwnership.OwnedByRegisteredAccount => "Owned by your account",
        InstallationOwnership.OwnedByAnonymousIdentity => "Owned by the anonymous identity",
        InstallationOwnership.TransferredSignInRequired => "Moved to an account: sign in",
        InstallationOwnership.OwnedByDifferentAccount => "Owned by a different account",
        InstallationOwnership.OwnerSelectionRequired => "Owner not established",
        InstallationOwnership.ReauthRequired => "Sign-in required",
        InstallationOwnership.NoCredential => "Not signed in",
        InstallationOwnership.Unavailable => "Could not be verified",
        InstallationOwnership.Conflict => "Conflicting ownership",
        _ => ""
    };

    public static string Describe(SignInOutcome outcome) => outcome switch
    {
        SignInOutcome.Success => "Signed in.",
        SignInOutcome.FeatureDisabled => "Account sign-in is not enabled in this build.",
        SignInOutcome.InvalidInput => "Enter your email address and password.",
        SignInOutcome.InvalidCredentials => "Email or password is incorrect.",
        SignInOutcome.EmailNotConfirmed => "Confirm your email address on the ForeverDB website first.",
        SignInOutcome.RateLimited => "Too many attempts. Wait a moment and try again.",
        SignInOutcome.Unavailable => "ForeverDB could not be reached. Nothing was changed.",
        SignInOutcome.VerificationFailed => "The server did not confirm this as a verified ForeverDB account. Nothing was changed.",
        SignInOutcome.AlreadySignedIn => "Already signed in. Sign out first to use another account.",
        SignInOutcome.StorageFailure => "The sign-in could not be stored safely. Nothing was changed.",
        SignInOutcome.LockTimeout => "Another ForeverDB Companion window is using the sign-in. Try again in a moment.",
        SignInOutcome.LegacySlotOccupied => "Another anonymous identity is already preserved. Nothing was changed.",
        _ => "Sign-in failed."
    };

    public static string Describe(AccountLinkResult result) => result.Outcome switch
    {
        AccountLinkOutcome.Connected => "This installation is linked to your account and this computer is registered. Use Sync now; automatic device sync stays off.",
        AccountLinkOutcome.FeatureDisabled => "Account linking is not enabled in this build.",
        AccountLinkOutcome.InvalidInstallation => "This installation identifier is not valid. Local data was not changed.",
        AccountLinkOutcome.SignInRequired => "Sign in to the ForeverDB account you want to use, then connect this installation.",
        AccountLinkOutcome.NoAnonymousOwner => "The original anonymous identity is not available, so ownership could not be proved.",
        AccountLinkOutcome.NotOwnedByAnonymousIdentity => "The server did not confirm that this computer's anonymous identity owns the installation. Nothing was transferred.",
        AccountLinkOutcome.AccountLimit => "This account has reached its installation limit. The installation was not transferred.",
        AccountLinkOutcome.RateLimited => "Too many linking attempts. Wait a moment and try again.",
        AccountLinkOutcome.ServiceNotReady => "The ForeverDB account-linking service is not available on this environment.",
        AccountLinkOutcome.DeviceRegistrationRequired when result.OwnershipLinked =>
            "The installation is linked to your account, but this computer could not finish registration. Try Connect again or use an activation file from Account > Devices.",
        AccountLinkOutcome.OutcomeUnknown when result.OwnershipLinked =>
            "The installation is linked, but device registration could not be confirmed. Check status, then try Connect again if needed.",
        AccountLinkOutcome.OutcomeUnknown => "ForeverDB could not confirm whether the ownership transfer completed. Check status before trying again.",
        _ => "The account connection could not be completed. Nothing was deleted; try again when ForeverDB is available."
    };

    public static string Describe(SignOutOutcome outcome) => outcome switch
    {
        SignOutOutcome.Confirmed => "Signed out. The server confirmed the session ended.",
        SignOutOutcome.LocalOnlyRevocationPending => "Signed out on this computer. The server could not confirm the session ended; it will be retried.",
        SignOutOutcome.NotSignedIn => "No account is signed in.",
        SignOutOutcome.StorageFailure => "The sign-out could not be stored safely. You are still signed in.",
        SignOutOutcome.LockTimeout => "Another ForeverDB Companion window is using the sign-in. Try again in a moment.",
        SignOutOutcome.FeatureDisabled => "Account features are not enabled in this build.",
        _ => "Sign-out failed."
    };

    public static string Describe(ForgetOutcome outcome) => outcome switch
    {
        ForgetOutcome.ConfirmationRequired => "Confirmation is required.",
        ForgetOutcome.NothingToForget => "There is no preserved anonymous identity.",
        ForgetOutcome.Revoked => "The anonymous identity was ended on the server and removed from this computer.",
        ForgetOutcome.AlreadyEnded => "The anonymous identity was already ended and was removed from this computer.",
        ForgetOutcome.RevocationFailedKept => "The server could not be reached, so the anonymous identity was kept. Try again when online, or choose to discard it without revoking.",
        ForgetOutcome.DiscardedUnrevoked => "The anonymous identity was removed from this computer, but the server session was not revoked.",
        ForgetOutcome.FeatureDisabled => "Original anonymous identity cannot be revoked from the private claim pilot.",
        ForgetOutcome.StorageFailure => "The change could not be stored safely. Nothing was removed.",
        ForgetOutcome.LockTimeout => "Another ForeverDB Companion window is using the sign-in. Try again in a moment.",
        _ => "Done."
    };

    public static string Describe(StartAnonymousOutcome outcome) => outcome switch
    {
        StartAnonymousOutcome.Created => "Using ForeverDB anonymously with a new identity.",
        StartAnonymousOutcome.RestoredLegacyIdentity => "Restored this computer's original anonymous identity.",
        StartAnonymousOutcome.AlreadyAnonymous => "Already using ForeverDB anonymously.",
        StartAnonymousOutcome.AlreadySignedIn => "A ForeverDB account sign-in exists. Sign in again instead of creating an anonymous identity.",
        StartAnonymousOutcome.ConfirmationRequired => "Confirmation is required to replace the lost identity.",
        StartAnonymousOutcome.Unavailable => "ForeverDB could not be reached. Nothing was changed.",
        StartAnonymousOutcome.RateLimited => "Too many requests. Wait a moment and try again.",
        StartAnonymousOutcome.Refused => "The server refused to create an anonymous identity.",
        StartAnonymousOutcome.StorageFailure => "The identity could not be stored safely. Nothing was changed.",
        StartAnonymousOutcome.LockTimeout => "Another ForeverDB Companion window is using the sign-in. Try again in a moment.",
        StartAnonymousOutcome.FeatureDisabled => "Not available.",
        _ => "Done."
    };

    public static string Describe(ClaimStartOutcome outcome) => outcome switch
    {
        ClaimStartOutcome.Granted => "Link code created.",
        ClaimStartOutcome.FeatureDisabled => "Installation linking is not enabled in this build.",
        ClaimStartOutcome.InvalidInstallation => "This installation cannot be linked.",
        ClaimStartOutcome.NoAnonymousOwner => "Linking needs the anonymous identity that owns this installation, which is not available on this computer.",
        ClaimStartOutcome.NotOwnedByAnonymousIdentity => "The anonymous identity on this computer does not own this installation.",
        ClaimStartOutcome.AlreadyTransferred => "This installation already belongs to a ForeverDB account.",
        ClaimStartOutcome.NotAvailable => "A link code is not available for this installation.",
        ClaimStartOutcome.RateLimited => "Too many link requests. Wait a few minutes.",
        ClaimStartOutcome.SessionNotAccepted => "The server did not accept this identity. Nothing was linked.",
        ClaimStartOutcome.NotDeployed => "The ForeverDB service does not support linking yet.",
        ClaimStartOutcome.OutcomeUnknown => "ForeverDB did not answer. A code may or may not have been created. It is not retried automatically; request a new code (it replaces any earlier one).",
        ClaimStartOutcome.CredentialUnavailable => "The sign-in could not be used just now. Nothing was linked.",
        ClaimStartOutcome.AnonymousTokenNeedsRefresh => "The preserved anonymous sign-in is too old to issue a link code. Close this pilot, open the normal anonymous Companion, use Sync now once, close it, then restart this pilot and Check status again. Nothing was linked.",
        ClaimStartOutcome.MalformedResponse => "ForeverDB sent an unexpected answer. Nothing was linked.",
        _ => "Linking failed."
    };

    public static string Describe(LinkCheckOutcome outcome) => outcome switch
    {
        LinkCheckOutcome.StillOwnedByAnonymousIdentity => "Not linked yet: the website has not confirmed the code.",
        LinkCheckOutcome.TransferConfirmed => "The server confirms this installation now belongs to your account.",
        LinkCheckOutcome.OwnedByRegisteredAccount => "This installation belongs to your account.",
        LinkCheckOutcome.TransferredSignInRequired => "The server confirms this installation moved to a ForeverDB account. Sign in to that account to keep syncing.",
        LinkCheckOutcome.OwnedByDifferentAccount => "This installation belongs to a different account than the one signed in.",
        LinkCheckOutcome.Unknown => "Ownership is not established for this installation.",
        _ => "Could not check right now."
    };
}

/// <summary>Website navigation, only to fixed, allow-listed account pages on a validated origin.</summary>
public static class AccountWebLinks
{
    public const string WebUrlVariable = "FOREVERDB_ACCOUNT_WEB_URL";

    public static Uri? Resolve(Func<string, string?> getVariable, string page)
    {
        if (page is not ("register" or "forgot-password"))
        {
            return null;
        }

        var raw = (getVariable(WebUrlVariable) ?? "").Trim();
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var origin) || !string.IsNullOrEmpty(origin.UserInfo) ||
            !string.IsNullOrEmpty(origin.Query) || !string.IsNullOrEmpty(origin.Fragment) ||
            (origin.AbsolutePath != "/" && origin.AbsolutePath.Length != 0))
        {
            return null;
        }

        var allowed = origin.Scheme == Uri.UriSchemeHttps || (origin.Scheme == Uri.UriSchemeHttp && origin.IsLoopback);
        if (!allowed || raw.Contains(AccountFeatureGate.ProductionProjectRef, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return new Uri(origin, "/account/" + page);
    }
}
