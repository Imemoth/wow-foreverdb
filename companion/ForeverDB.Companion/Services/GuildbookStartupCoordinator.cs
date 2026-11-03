namespace ForeverDB.Companion.Services;

/// <summary>
/// Startup boundary for restoring encrypted local Guildbook data. Keeping this
/// call separate from public synchronization makes the no-network restoration
/// path explicit and testable while MainWindow remains the production caller.
/// </summary>
public static class GuildbookStartupCoordinator
{
    public static Task<AccountGuildbookRestoreResult> RestoreAsync(
        IAccountGuildbookSync guildbook,
        IEnumerable<string> installationIds,
        string? preferredInstallationId = null,
        CancellationToken cancellationToken = default) =>
        guildbook.RestoreLocalAsync(installationIds, preferredInstallationId, cancellationToken);
}
