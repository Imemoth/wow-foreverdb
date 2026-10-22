using Xunit;

namespace ForeverDB.Companion.Account.Tests;

/// <summary>Registered-device upload: interpretation of every server answer, rotation, revocation, no fallback.</summary>
public class DeviceSyncTests
{
    private static async Task<DeviceRig> Registered(Action<DeviceRig>? configure = null)
    {
        var rig = new DeviceRig();
        configure?.Invoke(rig);
        rig.Activate();
        var status = await rig.Enrollment.InitializeAsync();
        Assert.Equal(DeviceState.Registered, status.State);
        return rig;
    }

    private static int IngestCalls(DeviceRig rig) => rig.Backend.Count("fdb_device_ingest");

    [Fact]
    public async Task Manual_sync_uploads_with_the_stored_secret_and_reports_success()
    {
        using var rig = await Registered();
        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Synced, result.Outcome);
        Assert.Equal(new DeviceStatus(DeviceState.Registered, DeviceDetail.Synced), result.Status);
        Assert.Contains("registered device", result.Message);
        Assert.Equal(rig.StoredCredential().DeviceSecret, rig.Backend.Ingested.Single().Secret);
        // The bearer is the DEVICE's own anonymous session, never anything else.
        var bearer = rig.Backend.Calls.Last(c => c.Rpc == "fdb_device_ingest").Bearer;
        Assert.False(JwtInspector.TryDecode(bearer)!.IsAnonymous == false);
        Assert.Equal(rig.Backend.Devices.Single().AuthUid, JwtInspector.TryDecode(bearer)!.Subject);
    }

    [Fact]
    public async Task Startup_status_check_classifies_an_active_device_and_changes_nothing()
    {
        using var rig = await Registered();
        var status = await rig.Sync.CheckStatusAsync();
        Assert.Equal(DeviceState.Registered, status.State);
        Assert.Equal(1, rig.Backend.Count("fdb_device_status"));
        Assert.Equal(0, rig.Backend.Count("fdb_device_rotate_credential"));
        Assert.Equal(0, IngestCalls(rig));
    }

    // ---- revocation ---------------------------------------------------------------------------

    [Fact]
    public async Task A_device_revoked_after_the_status_check_is_detected_by_the_refused_ingest_and_stops()
    {
        using var rig = await Registered();
        await rig.Sync.CheckStatusAsync();
        rig.Backend.RevokeDevice(rig.Backend.Devices.Single().Id);

        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Blocked, result.Outcome);
        Assert.Equal(DeviceState.DeviceRevoked, result.Status.State);
        Assert.Contains("revoked", result.Message);
        Assert.Equal(0, rig.Backend.DeviceIngests);

        // Stop: the next Sync now sends nothing at all.
        var calls = rig.Backend.Calls.Count;
        var again = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Blocked, again.Outcome);
        Assert.Equal(calls, rig.Backend.Calls.Count);
        Assert.Equal(0, rig.Server.IngestCount);   // and never an anonymous fallback
    }

    [Fact]
    public async Task A_device_revoked_before_startup_is_classified_by_status_and_ingest_is_never_attempted()
    {
        using var rig = await Registered();
        rig.Backend.RevokeDevice(rig.Backend.Devices.Single().Id);
        rig.Build();

        Assert.Equal(DeviceState.DeviceRevoked, (await rig.Sync.CheckStatusAsync()).State);
        Assert.Equal(DeviceSyncOutcome.Blocked, (await rig.Sync.SyncNowAsync(rig.Snapshot())).Outcome);
        Assert.Equal(0, IngestCalls(rig));
        Assert.Equal(0, rig.Server.IngestCount);
        Assert.Contains("download a new activation file", rig.Sync.Status.Message);
    }

    [Fact]
    public async Task A_revoked_device_can_be_re_activated_with_a_new_file_and_then_uploads_again()
    {
        using var rig = await Registered();
        rig.Backend.RevokeDevice(rig.Backend.Devices.Single().Id);
        rig.Build();
        await rig.Sync.CheckStatusAsync();

        rig.Activate();
        Assert.Equal(DeviceState.Registered, (await rig.Enrollment.InitializeAsync()).State);
        Assert.Equal(DeviceSyncOutcome.Synced, (await rig.Sync.SyncNowAsync(rig.Snapshot())).Outcome);
        Assert.Equal(2, rig.Backend.Devices.Count);
        Assert.Equal(rig.Backend.Devices[1].Current, rig.Backend.Ingested.Single().Secret);
    }

    // ---- ownership and account ----------------------------------------------------------------

    [Fact]
    public async Task Ownership_that_moved_away_is_an_OwnershipConflict_and_nothing_is_uploaded_anywhere()
    {
        using var rig = await Registered();
        rig.Server.SetOwner(rig.Installation, rig.Server.AddRegisteredUser("other@example.test", "pw-pw-pw-pw").Id);

        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Blocked, result.Outcome);
        Assert.Equal(new DeviceStatus(DeviceState.OwnershipConflict, DeviceDetail.OwnershipChanged), result.Status);
        Assert.Equal(0, rig.Backend.DeviceIngests);
        Assert.Equal(0, rig.Server.IngestCount);
    }

    [Fact]
    public async Task Ownership_conflict_reported_by_the_ingest_itself_is_handled_the_same_way()
    {
        using var rig = await Registered();
        await rig.Sync.CheckStatusAsync();
        rig.Server.SetOwner(rig.Installation, rig.Server.AddRegisteredUser("other@example.test", "pw-pw-pw-pw").Id);
        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceState.OwnershipConflict, result.Status.State);
        Assert.Equal(1, IngestCalls(rig));
        Assert.Equal(0, rig.Backend.DeviceIngests);
    }

    [Fact]
    public async Task An_unavailable_account_blocks_the_upload_and_recovers_when_the_account_is_back()
    {
        using var rig = await Registered();
        rig.Backend.AccountUnavailable = true;
        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Blocked, result.Outcome);
        Assert.Equal(DeviceState.AccountUnavailable, result.Status.State);
        Assert.Equal(0, rig.Backend.DeviceIngests);

        rig.Backend.AccountUnavailable = false;
        Assert.Equal(DeviceSyncOutcome.Synced, (await rig.Sync.SyncNowAsync(rig.Snapshot())).Outcome);
        Assert.Equal(DeviceState.Registered, rig.Sync.Status.State);
    }

    [Fact]
    public async Task A_snapshot_of_another_installation_is_not_this_devices_and_costs_no_request()
    {
        using var rig = await Registered();
        var calls = rig.Server.Requests.Count;
        var result = await rig.Sync.SyncNowAsync(rig.Snapshot("inst-someone-else-0000000"));
        Assert.Equal(DeviceSyncOutcome.NotRegistered, result.Outcome);
        Assert.Equal(calls, rig.Server.Requests.Count);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("{\"p_snapshot\":{}}")]
    [InlineData("{\"p_snapshot\":{\"installationId\":\"short\"}}")]
    [InlineData("{\"x\":1}")]
    public async Task A_malformed_snapshot_body_is_refused_locally(string body)
    {
        using var rig = await Registered();
        var calls = rig.Server.Requests.Count;
        Assert.Equal(DeviceSyncOutcome.Failed, (await rig.Sync.SyncNowAsync(body)).Outcome);
        Assert.Equal(calls, rig.Server.Requests.Count);
    }

    // ---- credential problems ------------------------------------------------------------------

    [Fact]
    public async Task A_stale_credential_is_retried_once_later_then_needs_a_new_activation()
    {
        using var rig = await Registered();
        await rig.Sync.CheckStatusAsync();
        var d = rig.Backend.Devices.Single();
        d.Retired = d.Current;
        d.Current = "fdbd1_" + Guid.Parse(d.Id).ToString("N") + "_" + new string('N', 43);

        var first = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.RetryLater, first.Outcome);
        Assert.Equal(new DeviceStatus(DeviceState.Registered, DeviceDetail.StaleCredential), first.Status);

        var second = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Blocked, second.Outcome);
        Assert.Equal(new DeviceStatus(DeviceState.CredentialDamaged, DeviceDetail.StaleCredential), second.Status);
        Assert.Equal(2, IngestCalls(rig));
        Assert.Equal(0, rig.Server.IngestCount);
    }

    [Fact]
    public async Task An_unauthorized_credential_is_classified_with_the_server_not_guessed()
    {
        using var rig = await Registered();
        await rig.Sync.CheckStatusAsync();
        var d = rig.Backend.Devices.Single();
        d.Current = "fdbd1_" + Guid.Parse(d.Id).ToString("N") + "_" + new string('M', 43);   // server no longer knows our secret

        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Blocked, result.Outcome);
        Assert.Equal(new DeviceStatus(DeviceState.CredentialDamaged, DeviceDetail.DeviceUnknown), result.Status);
        Assert.Equal(1, rig.Backend.Count("fdb_device_status") - 1);   // startup check + the post-failure classification
        Assert.Equal(0, rig.Backend.DeviceIngests);
        Assert.Contains("new activation file", result.Message);
    }

    [Fact]
    public async Task An_unauthorized_credential_of_a_revoked_device_is_reported_as_revoked()
    {
        using var rig = await Registered();
        await rig.Sync.CheckStatusAsync();
        var d = rig.Backend.Devices.Single();
        rig.Backend.RevokeDevice(d.Id);
        rig.Backend.Fault = rpc => rpc == "fdb_device_ingest" ? new FakeResponse(200, "{\"ok\":false,\"error\":\"device_unauthorized\"}") : null;
        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceState.DeviceRevoked, result.Status.State);
    }

    [Fact]
    public async Task An_unknown_ingest_error_code_is_not_trusted()
    {
        using var rig = await Registered();
        rig.Backend.Fault = rpc => rpc == "fdb_device_ingest" ? new FakeResponse(200, "{\"ok\":false,\"error\":\"what\"}") : null;
        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Failed, result.Outcome);
        Assert.Equal(DeviceState.Registered, result.Status.State);
        Assert.Equal(DeviceDetail.Unexpected, result.Status.Detail);
    }

    // ---- transport ----------------------------------------------------------------------------

    [Fact]
    public async Task An_automatic_upload_401_refreshes_the_device_session_once_and_retries_once()
    {
        using var rig = await Registered();
        await rig.Sync.CheckStatusAsync();
        var first = true;
        rig.Backend.Fault = rpc =>
        {
            if (rpc == "fdb_device_ingest" && first)
            {
                first = false;
                return new FakeResponse(401, "{\"code\":\"PT401\",\"message\":\"x\"}");
            }

            return null;
        };

        Assert.Equal(DeviceSyncOutcome.Synced, (await rig.Sync.SyncAutomaticAsync(rig.Snapshot())).Outcome);
        Assert.Equal(2, IngestCalls(rig));
        Assert.Equal(1, rig.Server.SuccessfulRefreshCount);
        Assert.Equal(1, rig.Server.SignupCount);
    }

    [Fact]
    public async Task A_persistent_401_gives_up_after_one_retry_without_touching_the_credential()
    {
        using var rig = await Registered();
        await rig.Sync.CheckStatusAsync();
        var before = TestEnv.ReadAllFiles(rig.DeviceDir);
        rig.Backend.Fault = rpc => rpc == "fdb_device_ingest" ? new FakeResponse(401, "{\"code\":\"PT401\"}") : null;

        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.RetryLater, result.Outcome);
        Assert.Equal(DeviceDetail.SessionNotAccepted, result.Status.Detail);
        Assert.Equal(DeviceState.Registered, result.Status.State);
        Assert.Equal(2, IngestCalls(rig));
        Assert.Equal(1, rig.Server.SignupCount);
        Assert.NotEqual(before, TestEnv.ReadAllFiles(rig.DeviceDir));   // the refresh rotated the device session...
        Assert.Equal(rig.StoredCredential().DeviceSecret, rig.Backend.Devices.Single().Current);   // ...but never the device secret
    }

    [Theory]
    [InlineData(429, DeviceDetail.RateLimited)]
    [InlineData(503, DeviceDetail.Offline)]
    [InlineData(500, DeviceDetail.Offline)]
    public async Task Automatic_rate_limits_and_server_errors_are_retry_later_and_keep_the_registration(int http, DeviceDetail detail)
    {
        using var rig = await Registered();
        await rig.Sync.CheckStatusAsync();
        var before = File.ReadAllBytes(rig.Context.Store.BlobPath);
        rig.Backend.Fault = rpc => rpc == "fdb_device_ingest" ? new FakeResponse(http, "{\"code\":\"X\"}") : null;

        var result = await rig.Sync.SyncAutomaticAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.RetryLater, result.Outcome);
        Assert.Equal(new DeviceStatus(DeviceState.Registered, detail), result.Status);
        Assert.Equal(before, File.ReadAllBytes(rig.Context.Store.BlobPath));

        rig.Backend.Fault = null;
        Assert.Equal(DeviceSyncOutcome.Synced, (await rig.Sync.SyncAutomaticAsync(rig.Snapshot())).Outcome);
    }

    [Fact]
    public async Task An_automatic_upload_on_a_dead_network_is_retry_later_and_reports_the_failure()
    {
        using var rig = await Registered();
        rig.Handler.Offline = true;
        var result = await rig.Sync.SyncAutomaticAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.RetryLater, result.Outcome);
        Assert.Equal(DeviceState.Registered, result.Status.State);
        Assert.Contains("could not be reached", result.Message);
        Assert.Contains("nothing was lost", result.Message);
    }

    [Fact]
    public async Task A_status_failure_at_startup_never_changes_the_state()
    {
        using var rig = await Registered();
        rig.Backend.Fault = rpc => rpc == "fdb_device_status" ? new FakeResponse(503, "{}") : null;
        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.RetryLater, result.Outcome);
        Assert.Equal(DeviceState.Registered, rig.Sync.Status.State);
        Assert.Equal(0, IngestCalls(rig));
    }

    [Fact]
    public async Task A_gate_held_by_another_process_is_retry_later_and_changes_nothing()
    {
        using var rig = await Registered();
        var directory = rig.DeviceDir;
        var gate = new CrossProcessSessionGate(directory);
        using var held = await gate.AcquireAsync(TimeSpan.FromSeconds(5), CancellationToken.None);

        var endpoint = TestEnv.StagingGate().Endpoint!;
        var http = new HttpClient(rig.Handler);
        var impatient = new DeviceContext(directory, TestEnv.Protector(), gate, new GoTrueClient(http, endpoint), new DeviceRpcClient(http, endpoint),
            lockTimeout: TimeSpan.FromMilliseconds(200));
        var sync = new DeviceSyncService(impatient);
        var result = await sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.RetryLater, result.Outcome);
        Assert.Equal(DeviceDetail.LockTimeout, result.Status.Detail);
        Assert.Equal(0, rig.Backend.DeviceIngests);
    }

    // ---- rotation -----------------------------------------------------------------------------

    [Fact]
    public async Task Rotation_persists_the_new_secret_durably_before_it_is_used_for_the_first_time()
    {
        using var rig = await Registered();
        var original = rig.StoredCredential().DeviceSecret;
        rig.Backend.Devices.Single().NeedsRotation = true;

        string? onDiskAtIngest = null;
        string? presented = null;
        rig.Backend.OnCall = (rpc, secret) =>
        {
            if (rpc == "fdb_device_ingest")
            {
                presented = secret;
                onDiskAtIngest = rig.Context.Store.Read().Credential!.DeviceSecret;
            }
        };

        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Synced, result.Outcome);
        Assert.Equal(1, rig.Backend.Count("fdb_device_rotate_credential"));
        Assert.NotEqual(original, presented);
        Assert.Equal(presented, onDiskAtIngest);                       // on disk BEFORE the first use
        Assert.Equal(presented, rig.Backend.Devices.Single().Current); // server promoted it on that first use
        Assert.Equal(original, rig.Backend.Devices.Single().Retired);

        // Rotated once: the next sync neither rotates again nor uses the old secret.
        await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(1, rig.Backend.Count("fdb_device_rotate_credential"));
        Assert.All(rig.Backend.Ingested, i => Assert.Equal(presented, i.Secret));
    }

    [Fact]
    public async Task A_rotation_that_cannot_be_persisted_never_uses_the_unpersisted_secret()
    {
        using var rig = await Registered();
        var original = rig.StoredCredential().DeviceSecret;
        var io = new FaultyIo();
        rig.Io = io;
        rig.Build();
        await rig.Sync.CheckStatusAsync();   // reads status; rotation not requested yet
        rig.Backend.Devices.Single().NeedsRotation = true;
        rig.Build();
        io.FailAt = "commit";
        io.FailPathContains = "device-credential.dat";

        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Synced, result.Outcome);
        Assert.Equal(1, rig.Backend.Count("fdb_device_rotate_credential"));
        Assert.Equal(original, rig.Backend.Ingested.Single().Secret);   // the old (still valid) secret was used
        Assert.Equal(original, rig.StoredCredential().DeviceSecret);    // and the old one is still what is stored

        // Disk back: rotation is retried and then persisted before use.
        io.FailAt = null;
        rig.Backend.Devices.Single().NeedsRotation = true;
        rig.Build();
        await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(rig.StoredCredential().DeviceSecret, rig.Backend.Ingested.Last().Secret);
        Assert.NotEqual(original, rig.Backend.Ingested.Last().Secret);
    }

    [Fact]
    public async Task A_crash_between_persisting_the_new_secret_and_its_first_use_loses_nothing()
    {
        using var rig = await Registered();
        var original = rig.StoredCredential().DeviceSecret;
        rig.Backend.Devices.Single().NeedsRotation = true;
        rig.Backend.Fault = rpc => rpc == "fdb_device_ingest" ? new FakeResponse(503, "{}") : null;   // the process "dies" at first use

        var first = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.RetryLater, first.Outcome);
        var persisted = rig.StoredCredential().DeviceSecret;
        Assert.NotEqual(original, persisted);                           // the new secret was already durable
        Assert.Equal(original, rig.Backend.Devices.Single().Current);   // the server still has the old one current, new one pending

        rig.Backend.Fault = null;
        rig.Build();                                                    // restart
        Assert.Equal(DeviceSyncOutcome.Synced, (await rig.Sync.SyncNowAsync(rig.Snapshot())).Outcome);
        Assert.Equal(persisted, rig.Backend.Ingested.Single().Secret);
        Assert.Equal(persisted, rig.Backend.Devices.Single().Current);
    }

    [Fact]
    public async Task A_crash_between_receiving_the_new_secret_and_persisting_it_leaves_the_old_secret_valid()
    {
        using var rig = await Registered();
        var original = rig.StoredCredential().DeviceSecret;
        rig.Backend.Devices.Single().NeedsRotation = true;
        var io = new FaultyIo();
        rig.Io = io;
        rig.Build();
        io.FailAt = "write";                                           // the temp file cannot even be written
        io.FailPathContains = "device-credential.dat";

        await rig.Sync.SyncNowAsync(rig.Snapshot());
        io.FailAt = null;
        rig.Build();
        Assert.Equal(original, rig.StoredCredential().DeviceSecret);
        Assert.Equal(DeviceSyncOutcome.Synced, (await rig.Sync.SyncNowAsync(rig.Snapshot())).Outcome);
    }

    [Fact]
    public async Task A_rotation_refused_because_the_device_was_revoked_stops_the_sync()
    {
        using var rig = await Registered();
        rig.Backend.Devices.Single().NeedsRotation = true;
        rig.Backend.Fault = rpc => rpc == "fdb_device_rotate_credential" ? new FakeResponse(200, "{\"ok\":false,\"error\":\"device_revoked\"}") : null;
        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceState.DeviceRevoked, result.Status.State);
        Assert.Equal(0, IngestCalls(rig));
    }

    [Fact]
    public async Task A_malformed_rotation_reply_is_discarded_and_the_current_secret_is_kept()
    {
        using var rig = await Registered();
        var original = rig.StoredCredential().DeviceSecret;
        rig.Backend.Devices.Single().NeedsRotation = true;
        rig.Backend.Fault = rpc => rpc == "fdb_device_rotate_credential" ? new FakeResponse(200, "{\"ok\":true,\"device_secret\":\"short\"}") : null;
        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Failed, result.Outcome);
        Assert.Equal(original, rig.StoredCredential().DeviceSecret);
        Assert.Equal(0, IngestCalls(rig));
    }

    [Fact]
    public async Task Startup_check_rotates_when_the_server_asks_and_persists_it()
    {
        using var rig = await Registered();
        var original = rig.StoredCredential().DeviceSecret;
        rig.Backend.Devices.Single().NeedsRotation = true;
        rig.Build();
        Assert.Equal(DeviceState.Registered, (await rig.Sync.CheckStatusAsync()).State);
        Assert.NotEqual(original, rig.StoredCredential().DeviceSecret);
        Assert.Equal(1, rig.Backend.Count("fdb_device_rotate_credential"));
    }

    // ---- AutoSync -----------------------------------------------------------------------------

    [Fact]
    public async Task Automatic_upload_for_a_registered_device_uses_the_same_authenticated_device_path()
    {
        using var rig = await Registered();
        var result = await rig.Sync.SyncAutomaticAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Synced, result.Outcome);
        Assert.Equal(DeviceDetail.Synced, result.Status.Detail);
        Assert.Equal(DeviceState.Registered, result.Status.State);
        Assert.Equal(1, rig.Backend.DeviceIngests);
    }

    // ---- pending / not enrolled ----------------------------------------------------------------

    [Fact]
    public async Task While_an_activation_is_pending_a_manual_sync_is_blocked_not_sent_anonymously()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        rig.Handler.Offline = true;
        await rig.Enrollment.InitializeAsync();
        rig.Handler.Offline = false;

        var calls = rig.Server.Requests.Count;
        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Blocked, result.Outcome);
        Assert.Equal(DeviceState.PendingActivation, result.Status.State);
        Assert.Equal(calls, rig.Server.Requests.Count);
    }
}
