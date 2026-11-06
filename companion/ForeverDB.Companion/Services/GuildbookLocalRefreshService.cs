using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public sealed record GuildbookLocalRefreshResult(
    int FilesRead,
    IReadOnlyList<string> AcceptedInstallationIds,
    IReadOnlyList<string> LoadedInstallationIds);

/// <summary>
/// Parses WoW SavedVariables and refreshes the account-scoped encrypted Guildbook cache.
/// This service has no public sync, HTTP, RPC, or Supabase dependency by design.
/// </summary>
public sealed class GuildbookLocalRefreshService
{
    private readonly IAccountGuildbookSync _guildbook;
    private readonly ForeverDbExportParser _parser;

    public GuildbookLocalRefreshService(IAccountGuildbookSync guildbook, ForeverDbExportParser? parser = null)
    {
        _guildbook = guildbook;
        _parser = parser ?? new ForeverDbExportParser();
    }

    public async Task<GuildbookLocalRefreshResult> RefreshAsync(
        IEnumerable<string> savedVariablesFiles,
        CancellationToken cancellationToken = default)
    {
        var filesRead = 0;
        var accepted = new List<string>();
        var loaded = new List<string>();

        foreach (var path in savedVariablesFiles.Where(File.Exists).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var snapshot = _parser.ParseSavedVariables(path);
            filesRead++;
            _guildbook.ObserveSnapshot(snapshot);
            var result = await _guildbook.SyncAsync(snapshot, cancellationToken).ConfigureAwait(false);
            if (result.CaptureAccepted)
                accepted.Add(snapshot.InstallationId);
            if (result.Loaded)
                loaded.Add(snapshot.InstallationId);
        }

        return new GuildbookLocalRefreshResult(filesRead, accepted, loaded);
    }
}
