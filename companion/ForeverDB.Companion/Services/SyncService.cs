using System.Text.Json;
using ForeverDB.Companion.Account;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

/// <summary>
/// Reads a SavedVariables export and uploads it through the ownership-aware coordinator.
/// Parsing, map metadata and the local Guildbook always run first and never depend on remote authentication,
/// so local data collection keeps working when sign-in, the network or the server is unavailable.
/// </summary>
public sealed class SyncService
{
    private static readonly JsonSerializerOptions SnapshotJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private readonly InstallationSyncCoordinator _coordinator;
    private readonly ForeverDbExportParser _parser = new();
    private readonly Action<IEnumerable<ForeverDbMap>>? _mapSink;
    private readonly Action<ForeverDbSnapshot>? _afterSynced;
    private readonly DeviceSyncService? _device;
    private readonly Dictionary<string, string> _knownFiles =
        new(StringComparer.Ordinal);

    public event Action? Authenticated;
    public event EventHandler<SyncCompletedEventArgs>? SyncCompleted;
    public event Action<IReadOnlyList<ForeverDbGuild>>? GuildbookChanged;
    public event EventHandler<SyncBlockedEventArgs>? SyncBlocked;

    public SyncService(
        InstallationSyncCoordinator coordinator,
        Action<IEnumerable<ForeverDbMap>>? mapSink = null,
        Action<ForeverDbSnapshot>? afterSynced = null,
        DeviceSyncService? device = null)
    {
        _device = device;
        _coordinator = coordinator;
        _mapSink = mapSink;
        _afterSynced = afterSynced;
    }

    /// <summary>SavedVariables file per installation ID seen so far (for re-syncing after an owner choice).</summary>
    public string? FileFor(string installationId)
    {
        lock (_knownFiles)
        {
            return _knownFiles.TryGetValue(installationId, out var path)
                ? path
                : null;
        }
    }

    /// <summary>
    /// Parses SavedVariables only to learn installation IDs for the Account tab. No upload, no authentication.
    /// </summary>
    public void DiscoverInstallations(IEnumerable<string> paths)
    {
        foreach (var path in paths)
        {
            try
            {
                var snapshot = _parser.ParseSavedVariables(path);

                if (!string.IsNullOrWhiteSpace(snapshot.InstallationId))
                {
                    lock (_knownFiles)
                    {
                        _knownFiles[snapshot.InstallationId] = path;
                    }

                    _coordinator.NoteLocalInstallation(snapshot.InstallationId);
                }
            }
            catch (Exception)
            {
                // An unreadable file is reported by the normal sync path; discovery stays silent.
            }
        }
    }

    public async Task<SyncAttempt?> SyncFileAsync(
        string path,
        CancellationToken cancellationToken = default,
        bool force = false,
        SyncTrigger trigger = SyncTrigger.Auto)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        var snapshot = _parser.ParseSavedVariables(path);

        lock (_knownFiles)
        {
            _knownFiles[snapshot.InstallationId] = path;
        }

        _mapSink?.Invoke(snapshot.Maps);

        GuildbookChanged?.Invoke(
            snapshot.Guilds);

        var json = JsonSerializer.Serialize(
            new
            {
                p_snapshot = snapshot
            },
            SnapshotJson);

        // Zero-touch: an installation owned by this computer's registered device (or about to be) never takes the anonymous path.
        // Only the explicit Sync now uploads; the watcher and startup sync send nothing for it.
        if (_device is { } device && device.Handles(snapshot.InstallationId))
        {
            return await SyncRegisteredDeviceAsync(device, snapshot, json, trigger, cancellationToken);
        }

        var attempt = await _coordinator.SyncAsync(
            snapshot.InstallationId,
            json,
            snapshot.UpdatedAt,
            force,
            cancellationToken);

        switch (attempt.Outcome)
        {
            case SyncOutcome.Synced:
                Authenticated?.Invoke();
                SyncCompleted?.Invoke(
                    this,
                    new SyncCompletedEventArgs(
                        DateTimeOffset.Now,
                        snapshot.Sources.Count,
                        snapshot.Guilds.Sum(
                            guild =>
                                guild.Members.Count),
                        trigger));
                _afterSynced?.Invoke(snapshot);
                break;

            case SyncOutcome.UpToDate:
                Authenticated?.Invoke();
                break;

            case SyncOutcome.StaleDiscarded:
                // The identity changed while the request was in flight: report nothing for the old identity.
                break;

            default:
                SyncBlocked?.Invoke(
                    this,
                    new SyncBlockedEventArgs(
                        snapshot.InstallationId,
                        attempt.Reason,
                        attempt.Outcome == SyncOutcome.Failed));
                break;
        }

        return attempt;
    }

    private async Task<SyncAttempt?> SyncRegisteredDeviceAsync(
        DeviceSyncService device,
        ForeverDbSnapshot snapshot,
        string json,
        SyncTrigger trigger,
        CancellationToken cancellationToken)
    {
        var result = trigger == SyncTrigger.Manual
            ? await device.SyncNowAsync(json, cancellationToken)
            : await device.SyncAutomaticAsync(json, cancellationToken);

        if (result.Outcome == DeviceSyncOutcome.Synced)
        {
            Authenticated?.Invoke();
            SyncCompleted?.Invoke(
                this,
                new SyncCompletedEventArgs(
                    DateTimeOffset.Now,
                    snapshot.Sources.Count,
                    snapshot.Guilds.Sum(guild => guild.Members.Count),
                    trigger));
            _afterSynced?.Invoke(snapshot);
            return new SyncAttempt(SyncOutcome.Synced, BlockReason.None, InstallationOwnership.OwnedByRegisteredAccount, null, null);
        }

        if (result.Outcome == DeviceSyncOutcome.AutoSyncOff)
        {
            // By design, not an error: no message on every SavedVariables save.
            return SyncAttempt.Blocked(BlockReason.DeviceAutoSyncOff, InstallationOwnership.OwnedByRegisteredAccount);
        }

        SyncBlocked?.Invoke(
            this,
            new SyncBlockedEventArgs(
                snapshot.InstallationId,
                BlockReason.DeviceSyncNotCompleted,
                result.Outcome == DeviceSyncOutcome.Failed,
                result.Message));
        return new SyncAttempt(
            result.Outcome == DeviceSyncOutcome.Failed ? SyncOutcome.Failed : SyncOutcome.Blocked,
            BlockReason.DeviceSyncNotCompleted,
            InstallationOwnership.OwnedByRegisteredAccount, null, null);
    }
}

public sealed record SyncCompletedEventArgs(
    DateTimeOffset CompletedAt,
    int SourceCount,
    int GuildMemberCount,
    SyncTrigger Trigger);

public sealed record SyncBlockedEventArgs(
    string InstallationId,
    BlockReason Reason,
    bool Failed,
    string? Message = null);
