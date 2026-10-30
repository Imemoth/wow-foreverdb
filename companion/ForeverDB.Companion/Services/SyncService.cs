using System.Text.Json;
using ForeverDB.Companion.Account;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

/// <summary>
/// Reads a SavedVariables export and uploads ONLY public observations through the ownership-aware coordinator.
/// Guildbook is parsed and persisted locally through a separate local boundary (<see cref="IAccountGuildbookSync"/>); it is never part
/// of a public payload and never reaches any RPC. Parsing, map metadata and the local Guildbook always run first and never depend on
/// remote authentication, so local data collection keeps working when sign-in, the network or the server is unavailable.
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

    public event Action? Authenticated;
    public event EventHandler<SyncCompletedEventArgs>? SyncCompleted;
    public event EventHandler<GuildbookSyncCompletedEventArgs>? GuildbookSyncCompleted;
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
            // The Guildbook view is fed ONLY by the account-gated local cache, never by the raw parsed snapshot.
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
    public IReadOnlyList<string> DiscoverInstallations(IEnumerable<string> paths)
    {
        var discovered = new HashSet<string>(StringComparer.Ordinal);
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
                    discovered.Add(snapshot.InstallationId);
                }
            }
            catch (Exception)
            {
                // An unreadable file is reported by the normal sync path; discovery stays silent.
            }
        }

        return discovered.ToArray();
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

        // Capture provenance and private records never enter a public collector/device payload. Local Guildbook processing is
        // independent of whether any public request succeeds.
        _guildbook?.ObserveSnapshot(snapshot);

        // Do NOT serialize ForeverDbSnapshot: its Guildbook members intentionally stay available to the parser and the local store.
        // The explicit public projection has no Guildbook member at all, and PublicSnapshotGuard re-checks the final JSON at the
        // transport boundary (RpcClient / DeviceRpcClient), so even a future private property cannot reach the wire.
        var json = JsonSerializer.Serialize(
            new
            {
                p_snapshot = PublicObservationSnapshot.From(snapshot)
            },
            SnapshotJson);

        // Local persistence is completed BEFORE any network call: a Supabase outage, a sign-in problem or a failed upload can never
        // prevent (or undo) retaining an authenticated local Guildbook snapshot.
        await SyncGuildbookAsync(snapshot, cancellationToken).ConfigureAwait(false);

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
                        0,
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

    private async Task<AccountGuildbookSyncResult?> SyncGuildbookAsync(
        ForeverDbSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        if (_guildbook is null)
        {
            return null;
        }

        try
        {
            var result = await _guildbook.SyncAsync(snapshot, cancellationToken).ConfigureAwait(false);
            GuildbookSyncCompleted?.Invoke(this, new GuildbookSyncCompletedEventArgs(snapshot.InstallationId, result));
            return result;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // Account identity cancellation is an expected stale-work result.
            var result = new AccountGuildbookSyncResult(false, false, true);
            GuildbookSyncCompleted?.Invoke(this, new GuildbookSyncCompletedEventArgs(snapshot.InstallationId, result));
            return result;
        }
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
                    0,
                    trigger));
            _afterSynced?.Invoke(snapshot);
            _coordinator.NoteDeviceUploadAccepted(snapshot.InstallationId);
            return new SyncAttempt(SyncOutcome.Synced, BlockReason.None, InstallationOwnership.OwnedByRegisteredAccount, null, null);
        }

        if (result.Outcome == DeviceSyncOutcome.AutoSyncOff)
        {
            // By design, not an error: no message on every SavedVariables save.
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
}

public sealed record SyncCompletedEventArgs(
    DateTimeOffset CompletedAt,
    int SourceCount,
    int GuildMemberCount,
    SyncTrigger Trigger);

public sealed record GuildbookSyncCompletedEventArgs(
    string InstallationId,
    AccountGuildbookSyncResult Result);

public sealed record SyncBlockedEventArgs(
    string InstallationId,
    BlockReason Reason,
    bool Failed,
    string? Message = null);
