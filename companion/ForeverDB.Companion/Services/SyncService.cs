using System.Collections.Concurrent;
using System.Text.Json;
using ForeverDB.Companion.Account;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

/// <summary>
/// Reads a SavedVariables export and uploads it through the ownership-aware coordinator.
/// Parsing and map metadata always run first and never depend on remote authentication. Private Guildbook records
/// use the separate account RPC boundary and are never included in public collector/device payloads.
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
    private readonly IAccountGuildbookSync? _guildbook;
    private readonly Dictionary<string, string> _knownFiles =
        new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _deviceGates = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, long> _lastDeviceSync = new(StringComparer.Ordinal);

    public event Action? Authenticated;
    public event EventHandler<SyncCompletedEventArgs>? SyncCompleted;
    public event Action<IReadOnlyList<ForeverDbGuild>>? GuildbookChanged;
    public event EventHandler<SyncBlockedEventArgs>? SyncBlocked;

    public SyncService(
        InstallationSyncCoordinator coordinator,
        Action<IEnumerable<ForeverDbMap>>? mapSink = null,
        Action<ForeverDbSnapshot>? afterSynced = null,
        DeviceSyncService? device = null,
        IAccountGuildbookSync? guildbook = null)
    {
        _device = device;
        _guildbook = guildbook;
        _coordinator = coordinator;
        _mapSink = mapSink;
        _afterSynced = afterSynced;
        if (_guildbook is not null)
        {
            _guildbook.Changed += guilds => GuildbookChanged?.Invoke(guilds);
        }
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

        // Capture provenance and private records never enter a public
        // collector/device payload. Account Guildbook routing is invoked
        // separately below and is guarded by the active registered session.
        _guildbook?.ObserveSnapshot(snapshot);

        var publicSnapshot = new ForeverDbSnapshot
        {
            SchemaVersion = snapshot.SchemaVersion,
            AddonVersion = snapshot.AddonVersion,
            InstallationId = snapshot.InstallationId,
            UpdatedAt = snapshot.UpdatedAt,
            Sources = snapshot.Sources,
            Maps = snapshot.Maps
        };

        var json = JsonSerializer.Serialize(
            new
            {
                p_snapshot = publicSnapshot
            },
            SnapshotJson);

        // An installation owned by this computer's registered device (or about to be) never takes the anonymous path.
        if (_device is { } device && device.Handles(snapshot.InstallationId))
        {
            // The device credential is an independent public collector. An
            // interactive account session must not gate it, so sign-out and
            // A -> B switches preserve public AutoSync while Guildbook stays
            // on the account RPC below.
            var deviceAttempt = await SyncRegisteredDeviceAsync(device, snapshot, json, force, trigger, cancellationToken);
            await SyncGuildbookAsync(snapshot, cancellationToken).ConfigureAwait(false);
            return deviceAttempt;
        }

        var attempt = await _coordinator.SyncAsync(
            snapshot.InstallationId,
            json,
            snapshot.UpdatedAt,
            force,
            cancellationToken);

        await SyncGuildbookAsync(snapshot, cancellationToken).ConfigureAwait(false);

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

    private async Task SyncGuildbookAsync(
        ForeverDbSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        if (_guildbook is null)
        {
            return;
        }

        try
        {
            await _guildbook.SyncAsync(snapshot, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // Account identity cancellation is an expected stale-work result.
        }
    }

    private async Task<SyncAttempt?> SyncRegisteredDeviceAsync(
        DeviceSyncService device,
        ForeverDbSnapshot snapshot,
        string json,
        bool force,
        SyncTrigger trigger,
        CancellationToken cancellationToken)
    {
        var gate = _deviceGates.GetOrAdd(snapshot.InstallationId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!force && _lastDeviceSync.TryGetValue(snapshot.InstallationId, out var last) && snapshot.UpdatedAt <= last)
            {
                Authenticated?.Invoke();
                return new SyncAttempt(
                    SyncOutcome.UpToDate,
                    BlockReason.None,
                    InstallationOwnership.OwnedByRegisteredAccount,
                    null,
                    null);
            }

            var result = trigger == SyncTrigger.Manual
                ? await device.SyncNowAsync(json, cancellationToken).ConfigureAwait(false)
                : await device.SyncAutomaticAsync(json, cancellationToken).ConfigureAwait(false);

            if (result.Outcome == DeviceSyncOutcome.Synced)
            {
                _lastDeviceSync.AddOrUpdate(
                    snapshot.InstallationId,
                    snapshot.UpdatedAt,
                    (_, current) => Math.Max(current, snapshot.UpdatedAt));
                Authenticated?.Invoke();
                SyncCompleted?.Invoke(
                    this,
                    new SyncCompletedEventArgs(
                        DateTimeOffset.Now,
                        snapshot.Sources.Count,
                        snapshot.Guilds.Sum(guild => guild.Members.Count),
                        trigger));
                _afterSynced?.Invoke(snapshot);
                _coordinator.NoteDeviceUploadAccepted(snapshot.InstallationId);
                return new SyncAttempt(SyncOutcome.Synced, BlockReason.None, InstallationOwnership.OwnedByRegisteredAccount, null, null);
            }

            if (result.Outcome == DeviceSyncOutcome.AutoSyncOff)
            {
                return SyncAttempt.Blocked(BlockReason.DeviceAutoSyncOff, InstallationOwnership.OwnedByRegisteredAccount);
            }

            _coordinator.NoteDeviceUploadNotCompleted(snapshot.InstallationId, BlockReason.DeviceSyncNotCompleted);
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
        finally
        {
            gate.Release();
        }
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
