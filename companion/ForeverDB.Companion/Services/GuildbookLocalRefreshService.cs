using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public enum GuildbookImportRejectionReason
{
    MissingFile,
    MalformedOrPartialExport,
    NoGuildbookCapture,
    FirstImportAuthorizationDeclined,
    BoundToAnotherAccount,
    BindingUnreadable,
    AccountVerificationRequired,
    IdentityChanged,
    OlderThanLocalSnapshot,
    CacheUnreadable,
    CacheWriteFailed,
    SupersededByNewerFile
}

public enum GuildbookDataSource
{
    None,
    SavedVariables,
    EncryptedCache,
    SavedVariablesAndEncryptedCache
}

public sealed record GuildbookFirstImportAuthorizationRequest(
    string InstallationId,
    int GuildCount,
    int MemberCount,
    int ProfessionCount,
    long CapturedAt,
    long IdentityGeneration);

public sealed record GuildbookLocalRefreshResult(
    int FilesDiscovered,
    int FilesParsed,
    int ValidCaptures,
    int GuildCount,
    int MemberCount,
    int ProfessionCount,
    int CapturesAccepted,
    int EncryptedCachesLoaded,
    GuildbookDataSource DataSource,
    IReadOnlyDictionary<GuildbookImportRejectionReason, int> RejectedByReason);

/// <summary>
/// Parses WoW SavedVariables and refreshes the account-scoped encrypted Guildbook cache.
/// This service has no public sync, HTTP, RPC, or Supabase dependency by design.
/// </summary>
public sealed class GuildbookLocalRefreshService
{
    private readonly IAccountGuildbookSync _guildbook;
    private readonly ForeverDbExportParser _parser;
    private readonly SemaphoreSlim _refreshGate = new(1, 1);

    public GuildbookLocalRefreshService(IAccountGuildbookSync guildbook, ForeverDbExportParser? parser = null)
    {
        _guildbook = guildbook;
        _parser = parser ?? new ForeverDbExportParser();
    }

    public async Task<GuildbookLocalRefreshResult> RefreshAsync(
        IEnumerable<string> savedVariablesFiles,
        Func<GuildbookFirstImportAuthorizationRequest, CancellationToken, Task<bool>>? authorizeFirstImport = null,
        CancellationToken cancellationToken = default)
    {
        await _refreshGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return await RefreshCoreAsync(savedVariablesFiles, authorizeFirstImport, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _refreshGate.Release();
        }
    }

    private async Task<GuildbookLocalRefreshResult> RefreshCoreAsync(
        IEnumerable<string> savedVariablesFiles,
        Func<GuildbookFirstImportAuthorizationRequest, CancellationToken, Task<bool>>? authorizeFirstImport,
        CancellationToken cancellationToken)
    {
        var paths = savedVariablesFiles
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var parsed = new List<(string Path, ForeverDbSnapshot Snapshot)>();
        var rejected = new Dictionary<GuildbookImportRejectionReason, int>();
        var parsedCount = 0;
        var validCount = 0;
        var guildCount = 0;
        var memberCount = 0;
        var professionCount = 0;
        var capturesAccepted = 0;
        var cachesLoaded = 0;
        var loadedInstallations = new HashSet<string>(StringComparer.Ordinal);

        void Reject(GuildbookImportRejectionReason reason) =>
            rejected[reason] = rejected.GetValueOrDefault(reason) + 1;

        foreach (var path in paths)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!File.Exists(path))
            {
                Reject(GuildbookImportRejectionReason.MissingFile);
                continue;
            }

            try
            {
                var snapshot = _parser.ParseSavedVariables(path);
                parsedCount++;
                parsed.Add((path, snapshot));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or
                                       FormatException or OverflowException or ArgumentException)
            {
                Reject(GuildbookImportRejectionReason.MalformedOrPartialExport);
            }
        }

        var candidates = new List<(string Path, ForeverDbSnapshot Snapshot)>();
        foreach (var group in parsed.GroupBy(item => item.Snapshot.InstallationId, StringComparer.Ordinal))
        {
            var valid = group
                .Where(item => IsValidGuildbookCapture(item.Snapshot))
                .OrderByDescending(item => item.Snapshot.GuildbookCapturedAt)
                .ThenByDescending(item => item.Snapshot.GuildbookCaptureId, StringComparer.Ordinal)
                .ThenBy(item => item.Path, StringComparer.OrdinalIgnoreCase)
                .ToArray();
            validCount += valid.Length;
            foreach (var invalid in group.Where(item => !IsValidGuildbookCapture(item.Snapshot)))
                Reject(GuildbookImportRejectionReason.NoGuildbookCapture);
            if (valid.Length == 0)
                continue;

            var selected = valid[0];
            candidates.Add(selected);
            foreach (var superseded in valid.Skip(1))
                Reject(GuildbookImportRejectionReason.SupersededByNewerFile);
        }

        var dataSource = GuildbookDataSource.None;
        foreach (var item in candidates.OrderBy(item => item.Snapshot.InstallationId, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var snapshot = item.Snapshot;
            var preview = await _guildbook.ImportLocalSnapshotAsync(snapshot, authorizeFirstImport: false, cancellationToken: cancellationToken)
                .ConfigureAwait(false);
            if (preview.RejectionReason == GuildbookImportRejectionReason.FirstImportAuthorizationDeclined)
            {
                var authorized = authorizeFirstImport is not null && await authorizeFirstImport(
                    new GuildbookFirstImportAuthorizationRequest(
                        snapshot.InstallationId,
                        snapshot.Guilds.Count,
                        snapshot.Guilds.Sum(guild => guild.Members.Count),
                        snapshot.Guilds.Sum(guild => guild.Members.Sum(member => member.Professions.Count)),
                        snapshot.GuildbookCapturedAt!.Value,
                        preview.IdentityGeneration),
                    cancellationToken).ConfigureAwait(false);
                if (!authorized)
                {
                    Reject(GuildbookImportRejectionReason.FirstImportAuthorizationDeclined);
                    guildCount += snapshot.Guilds.Count;
                    memberCount += snapshot.Guilds.Sum(guild => guild.Members.Count);
                    professionCount += snapshot.Guilds.Sum(guild => guild.Members.Sum(member => member.Professions.Count));
                    continue;
                }

                preview = await _guildbook.ImportLocalSnapshotAsync(
                    snapshot,
                    authorizeFirstImport: true,
                    expectedIdentityGeneration: preview.IdentityGeneration,
                    cancellationToken: cancellationToken).ConfigureAwait(false);
            }

            if (preview.CaptureAccepted)
            {
                capturesAccepted++;
                guildCount += snapshot.Guilds.Count;
                memberCount += snapshot.Guilds.Sum(guild => guild.Members.Count);
                professionCount += snapshot.Guilds.Sum(guild => guild.Members.Sum(member => member.Professions.Count));
                dataSource = dataSource is GuildbookDataSource.EncryptedCache
                    ? GuildbookDataSource.SavedVariablesAndEncryptedCache
                    : GuildbookDataSource.SavedVariables;
            }
            if (preview.EncryptedCacheLoaded && loadedInstallations.Add(snapshot.InstallationId))
            {
                cachesLoaded++;
                if (!preview.CaptureAccepted && preview.CachedSnapshot is { } cached)
                {
                    guildCount += cached.Guilds.Count;
                    memberCount += cached.Guilds.Sum(guild => guild.Members.Count);
                    professionCount += cached.Guilds.Sum(guild => guild.Members.Sum(member => member.Professions.Count));
                    dataSource = dataSource is GuildbookDataSource.SavedVariables
                        ? GuildbookDataSource.SavedVariablesAndEncryptedCache
                        : GuildbookDataSource.EncryptedCache;
                }
            }
            if (preview.RejectionReason is { } reason)
                Reject(reason);
        }

        if (cachesLoaded > 0)
        {
            var loaded = await _guildbook.RestoreLocalAsync(
                candidates.Select(item => item.Snapshot.InstallationId),
                candidates.OrderBy(item => item.Snapshot.InstallationId, StringComparer.Ordinal).FirstOrDefault().Snapshot?.InstallationId,
                cancellationToken).ConfigureAwait(false);
            if (!loaded.Authorized)
            {
                Reject(GuildbookImportRejectionReason.IdentityChanged);
                dataSource = GuildbookDataSource.None;
            }
        }

        return new GuildbookLocalRefreshResult(
            paths.Length,
            parsedCount,
            validCount,
            guildCount,
            memberCount,
            professionCount,
            capturesAccepted,
            cachesLoaded,
            dataSource,
            rejected);
    }

    private static bool IsValidGuildbookCapture(ForeverDbSnapshot snapshot) =>
        snapshot.SchemaVersion == 9 &&
        !string.IsNullOrWhiteSpace(snapshot.InstallationId) &&
        !string.IsNullOrWhiteSpace(snapshot.GuildbookCaptureId) &&
        snapshot.GuildbookCapturedAt is > 0 and <= 253402300799 &&
        !string.IsNullOrWhiteSpace(snapshot.GuildbookSourceCharacter) &&
        snapshot.Guilds.Count > 0;
}
