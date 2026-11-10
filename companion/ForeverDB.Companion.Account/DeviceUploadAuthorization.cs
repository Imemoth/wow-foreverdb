namespace ForeverDB.Companion.Account;

/// <summary>
/// Local authorization gate for a registered-device upload initiated while a human account is selected in the Companion.
/// The server's fresh installation-link result is required before the independent device credential may be used.
/// </summary>
public static class DeviceUploadAuthorization
{
    public static bool IsAuthorized(
        string installationId,
        AccountStatus currentStatus,
        TokenResult currentAccountToken,
        OwnershipRouter.RouteDecision ownership,
        long currentGeneration)
    {
        if (string.IsNullOrWhiteSpace(installationId) ||
            currentStatus.State != SessionState.Registered ||
            !currentStatus.AccountsEnabled ||
            !currentStatus.IdentityVerified ||
            currentStatus.Generation != currentGeneration ||
            string.IsNullOrWhiteSpace(currentStatus.AccountId))
        {
            return false;
        }

        if (!currentAccountToken.Ok ||
            currentAccountToken.Role != SlotRole.Primary ||
            currentAccountToken.Kind != SessionKind.Registered ||
            currentAccountToken.Generation != currentGeneration ||
            !string.Equals(currentAccountToken.UserId, currentStatus.AccountId, StringComparison.Ordinal))
        {
            return false;
        }

        return ownership.CanIngest &&
            ownership.Ownership == InstallationOwnership.OwnedByRegisteredAccount &&
            ownership.Role == SlotRole.Primary &&
            ownership.Kind == SessionKind.Registered &&
            ownership.Generation == currentGeneration &&
            string.Equals(ownership.UserId, currentAccountToken.UserId, StringComparison.Ordinal);
    }
}
