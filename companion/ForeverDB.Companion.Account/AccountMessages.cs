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
                "Choose how to use ForeverDB: sign in to a ForeverDB account, or use ForeverDB anonymously. Local collection and the Guildbook work either way.",
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
        BlockReason.CredentialUnavailable => "The sign-in could not be used just now; sync will be retried.",
        BlockReason.InvalidRequest => "The server rejected the upload.",
        _ => "Sync is paused."
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
