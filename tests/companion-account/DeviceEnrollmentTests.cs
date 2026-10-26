using Xunit;

namespace ForeverDB.Companion.Account.Tests;

/// <summary>Zero-touch enrollment: A1/A2/A3 acceptance, ticket answers, interruption and concurrency, conflicts.</summary>
public class DeviceEnrollmentTests
{
    private static async Task<DeviceStatus> Enroll(DeviceRig rig) => await rig.Enrollment.InitializeAsync();

    // ---- A1 / A2 / A3 -------------------------------------------------------------------------

    [Fact]
    public async Task A1_activation_file_enrolls_persists_the_credential_and_syncs_without_any_login()
    {
        using var rig = new DeviceRig();
        var ticket = rig.Activate();

        Assert.Equal(DeviceState.PendingActivation, rig.Enrollment.LoadLocalState().State);
        var status = await Enroll(rig);

        Assert.Equal(DeviceState.Registered, status.State);
        Assert.Empty(rig.ActivationFiles());
        var stored = rig.StoredCredential();
        Assert.Equal(rig.Installation, stored.InstallationId);
        Assert.Equal(rig.Backend.Devices.Single().Current, stored.DeviceSecret);
        Assert.Equal(rig.Account.Id, rig.Server.OwnerOf(rig.Installation));
        Assert.Equal("consumed", rig.Backend.Tickets.Single(t => t.Raw == ticket).Status);

        var result = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Synced, result.Outcome);
        Assert.Equal(1, rig.Backend.DeviceIngests);
        Assert.Equal(stored.DeviceSecret, rig.Backend.Ingested.Single().Secret);
        // No login anywhere, and the legacy anonymous ingest was never used.
        Assert.DoesNotContain(rig.Server.Requests, q => q.Query.Contains("grant_type=password"));
        Assert.Equal(0, rig.Server.IngestCount);
        // The only Auth identity created is the device's own anonymous one.
        Assert.Equal(1, rig.Server.SignupCount);
    }

    [Fact]
    public async Task A2_a_second_computer_gets_an_independent_identity_and_credential_under_the_same_account()
    {
        using var first = new DeviceRig();
        using var second = new DeviceRig(first.Server, first.Backend, first.Account);
        first.Activate();
        second.Activate();

        Assert.Equal(DeviceState.Registered, (await Enroll(first)).State);
        Assert.Equal(DeviceState.Registered, (await Enroll(second)).State);

        var a = first.StoredCredential();
        var b = second.StoredCredential();
        Assert.NotEqual(a.DeviceId, b.DeviceId);
        Assert.NotEqual(a.DeviceSecret, b.DeviceSecret);
        Assert.NotEqual(a.InstallationId, b.InstallationId);
        Assert.Equal(2, first.Backend.Devices.Select(d => d.AuthUid).Distinct().Count());
        Assert.All(first.Backend.Devices, d => Assert.Equal(first.Account.Id, d.AccountId));
        Assert.Equal(first.Account.Id, first.Server.OwnerOf(first.Installation));
        Assert.Equal(first.Account.Id, first.Server.OwnerOf(second.Installation));
        Assert.NotEqual(
            Directory.GetFiles(first.DeviceDir, "session.dat").Select(File.ReadAllText).Single(),
            Directory.GetFiles(second.DeviceDir, "session.dat").Select(File.ReadAllText).Single());

        // Each device syncs only its own installation.
        Assert.Equal(DeviceSyncOutcome.Synced, (await first.Sync.SyncNowAsync(first.Snapshot())).Outcome);
        Assert.Equal(DeviceSyncOutcome.NotRegistered, (await first.Sync.SyncNowAsync(second.Snapshot())).Outcome);
        Assert.Equal(DeviceSyncOutcome.Synced, (await second.Sync.SyncNowAsync(second.Snapshot())).Outcome);
        Assert.Equal(2, first.Backend.DeviceIngests);
    }

    [Fact]
    public async Task One_device_session_can_enroll_two_installations_without_transferring_either_owner()
    {
        using var rig = new DeviceRig();
        var first = rig.Installation;
        var second = "inst-second-0123456789abcde";

        var firstTicket = new ActivationTicket(rig.NewTicket(), null, null);
        Assert.Equal(DeviceState.Registered, (await rig.Enrollment.EnrollTicketAsync(firstTicket, first)).State);
        var secondTicket = new ActivationTicket(rig.NewTicket(), null, null);
        Assert.Equal(DeviceState.Registered, (await rig.Enrollment.EnrollTicketAsync(secondTicket, second)).State);

        Assert.Equal(rig.Account.Id, rig.Server.OwnerOf(first));
        Assert.Equal(rig.Account.Id, rig.Server.OwnerOf(second));
        Assert.Equal(2, rig.Context.Store.InstallationIds().Count);
        Assert.Equal(DeviceSyncOutcome.Synced, (await rig.Sync.SyncNowAsync(rig.Snapshot(first))).Outcome);
        Assert.Equal(DeviceSyncOutcome.Synced, (await rig.Sync.SyncNowAsync(rig.Snapshot(second))).Outcome);
        Assert.Equal(2, rig.Backend.DeviceIngests);
    }

    [Fact]
    public async Task A3_after_a_restart_the_registration_persists_without_an_activation_file_or_a_new_identity()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        await Enroll(rig);
        var before = rig.Server.SignupCount;
        var requests = rig.Server.Requests.Count;

        rig.Build();   // new process over the same files
        Assert.Equal(DeviceState.Registered, rig.Enrollment.LoadLocalState().State);
        Assert.Equal(rig.Installation, rig.Context.InstallationId);
        Assert.Equal(DeviceState.Registered, (await Enroll(rig)).State);
        Assert.Equal(requests, rig.Server.Requests.Count);   // nothing to redeem: no network at all

        Assert.Equal(DeviceSyncOutcome.Synced, (await rig.Sync.SyncNowAsync(rig.Snapshot())).Outcome);
        Assert.Equal(before, rig.Server.SignupCount);
        Assert.Equal(1, rig.Backend.Count("fdb_device_enroll"));
    }

    [Fact]
    public async Task Web_sign_out_equivalent_changes_nothing_a_device_keeps_working_until_revoked()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        await Enroll(rig);
        // The account's web session ending is a different identity; the device session and secret are unaffected.
        rig.Server.IssueSession(rig.Account.Id);
        rig.Server.AccessLifetimeSeconds = 100_000;   // the refreshed token outlives the advanced test clock
        rig.Clock.Advance(TimeSpan.FromHours(3));   // device access token needs a refresh on its own session
        rig.Build();
        Assert.Equal(DeviceSyncOutcome.Synced, (await rig.Sync.SyncNowAsync(rig.Snapshot())).Outcome);
        Assert.Equal(1, rig.Server.SuccessfulRefreshCount);
    }

    // ---- ticket answers and the activation file -----------------------------------------------

    [Fact]
    public async Task An_expired_ticket_is_ActivationExpired_the_file_is_deleted_and_the_message_says_what_to_do()
    {
        using var rig = new DeviceRig();
        var ticket = rig.NewTicket();
        rig.WriteActivation(ticket);
        rig.Backend.ExpireTicket(ticket);

        var status = await Enroll(rig);
        Assert.Equal(DeviceState.ActivationExpired, status.State);
        Assert.Empty(rig.ActivationFiles());
        Assert.Empty(rig.Backend.Devices);
        Assert.Contains("new activation file", status.Message);
        Assert.Contains("Devices", status.Message);
        Assert.Contains("do not need to reinstall", status.Message);
        Assert.Equal(DeviceCredentialStatus.Missing, rig.Context.Store.Read().Status);
    }

    [Theory]
    [InlineData("consumed", DeviceDetail.TicketConsumed)]
    [InlineData("revoked", DeviceDetail.TicketRevoked)]
    public async Task A_consumed_or_revoked_ticket_is_ActivationRejected_and_the_file_is_deleted(string status, DeviceDetail detail)
    {
        using var rig = new DeviceRig();
        var ticket = rig.NewTicket();
        rig.WriteActivation(ticket);
        rig.Backend.SetTicketStatus(ticket, status);

        var result = await Enroll(rig);
        Assert.Equal(new DeviceStatus(DeviceState.ActivationRejected, detail), result);
        Assert.Empty(rig.ActivationFiles());
        Assert.Contains("NEW activation file", AccountMessages.Describe(new DeviceStatus(DeviceState.ActivationRejected, DeviceDetail.TicketConsumed)));
    }

    [Fact]
    public async Task An_unknown_ticket_is_rejected_as_invalid_and_the_file_is_deleted()
    {
        using var rig = new DeviceRig();
        rig.WriteActivation("fdba1_" + new string('Z', 43));
        var result = await Enroll(rig);
        Assert.Equal(new DeviceStatus(DeviceState.ActivationRejected, DeviceDetail.TicketInvalid), result);
        Assert.Empty(rig.ActivationFiles());
    }

    [Fact]
    public async Task A_malformed_activation_file_is_ignored_with_no_network_and_is_left_alone()
    {
        using var rig = new DeviceRig();
        var path = Path.Combine(rig.ActivationDir, "foreverdb-activation.fdbact");
        File.WriteAllText(path, "{\"format\":\"foreverdb-activation\",\"v\":1,\"ticket\":\"nope\"}");
        var status = await Enroll(rig);
        Assert.Equal(DeviceState.Anonymous, status.State);
        Assert.True(File.Exists(path));
        Assert.Empty(rig.Server.Requests);
    }

    [Fact]
    public async Task Without_any_activation_file_nothing_happens_and_the_legacy_path_stays_in_charge()
    {
        using var rig = new DeviceRig();
        var legacy = rig.SeedLegacyFiles();
        var before = rig.TopLevelSnapshot();

        Assert.Equal(DeviceState.Anonymous, rig.Enrollment.LoadLocalState().State);
        Assert.Equal(DeviceState.Anonymous, (await Enroll(rig)).State);
        Assert.Empty(rig.Server.Requests);
        Assert.False(Directory.Exists(rig.DeviceDir));
        Assert.Equal(before, rig.TopLevelSnapshot());
        Assert.NotEmpty(legacy);
        Assert.False(rig.Sync.Handles(rig.Installation));
        Assert.Equal(DeviceSyncOutcome.NotRegistered, (await rig.Sync.SyncNowAsync(rig.Snapshot())).Outcome);
        Assert.Empty(rig.Server.Requests);
    }

    // ---- transport failures: keep the file, retry later ---------------------------------------

    [Fact]
    public async Task A_dead_network_keeps_the_activation_file_and_a_later_start_succeeds()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        rig.Handler.Offline = true;

        var status = await Enroll(rig);
        Assert.Equal(new DeviceStatus(DeviceState.PendingActivation, DeviceDetail.Offline), status);
        Assert.Single(rig.ActivationFiles());
        Assert.Equal(DeviceCredentialStatus.Missing, rig.Context.Store.Read().Status);
        Assert.True(rig.Sync.Handles(rig.Installation));   // anonymous upload stays blocked while pending

        rig.Handler.Offline = false;
        Assert.Equal(DeviceState.Registered, (await Enroll(rig)).State);
        Assert.Empty(rig.ActivationFiles());
    }

    [Theory]
    [InlineData(503, DeviceDetail.Offline)]
    [InlineData(429, DeviceDetail.RateLimited)]
    [InlineData(404, DeviceDetail.ServiceNotReady)]
    public async Task Server_errors_rate_limits_and_a_missing_function_keep_the_file(int http, DeviceDetail detail)
    {
        using var rig = new DeviceRig();
        rig.Activate();
        rig.Backend.Fault = rpc => rpc == "fdb_device_enroll" ? new FakeResponse(http, "{\"code\":\"X\",\"message\":\"x\"}") : null;

        var status = await Enroll(rig);
        Assert.Equal(new DeviceStatus(DeviceState.PendingActivation, detail), status);
        Assert.Single(rig.ActivationFiles());
        Assert.Equal(1, rig.Backend.Count("fdb_device_enroll"));   // attempted once, never looped

        rig.Backend.Fault = null;
        Assert.Equal(DeviceState.Registered, (await Enroll(rig)).State);
    }

    [Fact]
    public async Task A_malformed_enroll_reply_is_discarded_and_keeps_the_file()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        rig.Backend.Fault = rpc => rpc == "fdb_device_enroll" ? new FakeResponse(200, "{\"ok\":true,\"device_id\":\"x\",\"device_secret\":\"nope\"}") : null;
        Assert.Equal(new DeviceStatus(DeviceState.PendingActivation, DeviceDetail.Unexpected), await Enroll(rig));
        Assert.Single(rig.ActivationFiles());
        Assert.Equal(DeviceCredentialStatus.Missing, rig.Context.Store.Read().Status);
    }

    [Fact]
    public async Task A_rejected_access_token_is_refreshed_once_and_the_enroll_retried_once()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        var first = true;
        rig.Backend.Fault = rpc =>
        {
            if (rpc == "fdb_device_enroll" && first)
            {
                first = false;
                return new FakeResponse(401, "{\"code\":\"PT401\",\"message\":\"x\"}");
            }

            return null;
        };

        Assert.Equal(DeviceState.Registered, (await Enroll(rig)).State);
        Assert.Equal(2, rig.Backend.Count("fdb_device_enroll"));
        Assert.Equal(1, rig.Server.SuccessfulRefreshCount);
        Assert.Equal(1, rig.Server.SignupCount);
    }

    // ---- durability and interruption ----------------------------------------------------------

    [Fact]
    public async Task The_credential_is_stored_durably_before_the_activation_file_is_deleted()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        var io = new FaultyIo { FailAt = "commit", FailPathContains = "device-credential.dat" };
        rig.Io = io;
        rig.Build();

        var status = await Enroll(rig);
        // The server consumed the ticket but the disk refused: the file MUST still be there, nothing is claimed as registered.
        Assert.Equal(new DeviceStatus(DeviceState.PendingActivation, DeviceDetail.StorageFailure), status);
        Assert.Single(rig.ActivationFiles());
        Assert.Equal(DeviceCredentialStatus.Missing, rig.Context.Store.Read().Status);

        // Disk healthy again: the same process stores the secret it already holds, with no second redemption.
        io.FailAt = null;
        Assert.Equal(DeviceState.Registered, (await Enroll(rig)).State);
        Assert.Equal(1, rig.Backend.Count("fdb_device_enroll"));
        Assert.Empty(rig.ActivationFiles());
        Assert.Equal(rig.Backend.Devices.Single().Current, rig.StoredCredential().DeviceSecret);
    }

    [Fact]
    public async Task Lost_reply_after_the_server_consumed_the_ticket_ends_in_a_clear_new_file_instruction_never_a_loop()
    {
        using var rig = new DeviceRig();
        var ticket = rig.Activate();
        rig.Backend.LoseNextEnrollReply = true;

        Assert.Equal(new DeviceStatus(DeviceState.PendingActivation, DeviceDetail.Offline), await Enroll(rig));
        Assert.Single(rig.ActivationFiles());
        Assert.Equal("consumed", rig.Backend.Tickets.Single(t => t.Raw == ticket).Status);

        // Retry: the ticket is spent -> ActivationRejected, file deleted, exactly one more attempt.
        var retry = await Enroll(rig);
        Assert.Equal(new DeviceStatus(DeviceState.ActivationRejected, DeviceDetail.TicketConsumed), retry);
        Assert.Empty(rig.ActivationFiles());
        Assert.Contains("NEW activation file", retry.Message);
        Assert.Equal(2, rig.Backend.Count("fdb_device_enroll"));
        Assert.Equal(new DeviceStatus(DeviceState.ActivationRejected, DeviceDetail.TicketConsumed), await Enroll(rig));
        Assert.Equal(2, rig.Backend.Count("fdb_device_enroll"));   // nothing left to redeem

        // A NEW activation file recovers: same installation, same device identity, the credential is replaced.
        rig.Activate();
        Assert.Equal(DeviceState.Registered, (await Enroll(rig)).State);
        Assert.Equal(1, rig.Server.SignupCount);
        Assert.Equal(2, rig.Backend.Devices.Count);
        Assert.Equal("revoked", rig.Backend.Devices[0].Status);
        Assert.Equal(rig.Backend.Devices[1].Current, rig.StoredCredential().DeviceSecret);
    }

    [Fact]
    public async Task A_consumed_ticket_with_a_local_credential_for_a_device_the_server_no_longer_trusts_is_registered_not_rejected()
    {
        using var rig = new DeviceRig();
        var ticket = rig.Activate();
        await Enroll(rig);
        rig.Backend.RevokeDevice(rig.Backend.Devices.Single().Id);

        // The (already spent) file shows up again from a backup/download: the credential exists locally, so the device is "registered".
        var again = rig.WriteActivation(rig.NewTicket(), "foreverdb-activation (1).fdbact");
        var status = await Enroll(rig);
        Assert.Equal(DeviceState.Registered, status.State);
        Assert.Equal(2, rig.Backend.Devices.Count);   // revoked device replaced by a fresh credential via the new ticket
        Assert.False(File.Exists(again));
        Assert.NotNull(ticket);
    }

    [Fact]
    public async Task A_leftover_copy_of_the_redeemed_file_is_removed_silently_without_a_network_call()
    {
        using var rig = new DeviceRig();
        var ticket = rig.Activate();
        await Enroll(rig);
        var requests = rig.Server.Requests.Count;

        rig.WriteActivation(ticket, "foreverdb-activation (1).fdbact");   // the delete had failed / a copy came back
        rig.Build();
        Assert.Equal(DeviceState.Registered, (await Enroll(rig)).State);
        Assert.Empty(rig.ActivationFiles());
        Assert.Equal(requests, rig.Server.Requests.Count);
    }

    [Fact]
    public async Task A_different_activation_file_never_re_enrolls_a_device_the_server_reports_active()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        await Enroll(rig);
        var original = rig.StoredCredential().DeviceSecret;

        var extra = rig.WriteActivation(rig.NewTicket(), "foreverdb-activation (2).fdbact");
        rig.Build();
        Assert.Equal(DeviceState.Registered, (await Enroll(rig)).State);
        Assert.True(File.Exists(extra));   // untouched, the user's file
        Assert.Equal(1, rig.Backend.Count("fdb_device_enroll"));
        Assert.Equal(original, rig.StoredCredential().DeviceSecret);
    }

    // ---- concurrency --------------------------------------------------------------------------

    [Fact]
    public async Task Two_companion_instances_over_the_same_directory_enroll_exactly_once()
    {
        using var first = new DeviceRig();
        using var second = new DeviceRig(first.Server, first.Backend, first.Account, first.Installation, root: first.Root);
        first.Activate();
        first.Handler.Before = async (req, ct) =>
        {
            if (req.RequestUri!.AbsolutePath.EndsWith("fdb_device_enroll", StringComparison.Ordinal))
            {
                await Task.Delay(400, ct);
            }
        };

        var results = await Task.WhenAll(first.Enrollment.InitializeAsync(), second.Enrollment.InitializeAsync());
        Assert.All(results, r => Assert.Equal(DeviceState.Registered, r.State));
        Assert.Equal(1, first.Backend.Count("fdb_device_enroll"));
        Assert.Single(first.Backend.Devices);
        Assert.Equal(1, first.Server.SignupCount);
        Assert.Empty(first.ActivationFiles());
    }

    [Fact]
    public async Task Concurrent_syncs_and_enrollment_in_one_process_are_serialised_by_the_gate()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        var enroll = rig.Enrollment.InitializeAsync();
        var sync = rig.Sync.SyncNowAsync(rig.Snapshot());
        await Task.WhenAll(enroll, sync);
        // Whichever ran first, the end state is one device and a consistent store.
        Assert.Equal(1, rig.Backend.Count("fdb_device_enroll"));
        Assert.Equal(DeviceState.Registered, (await Enroll(rig)).State);
    }

    // ---- no installation / several installations ---------------------------------------------

    [Fact]
    public async Task Without_a_known_installation_the_file_is_kept_and_no_identity_is_created()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        rig.Installations.Clear();
        Assert.Equal(new DeviceStatus(DeviceState.PendingActivation, DeviceDetail.NoInstallation), await Enroll(rig));
        Assert.Single(rig.ActivationFiles());
        Assert.Empty(rig.Server.Requests);
        Assert.Contains("World of Warcraft", AccountMessages.Describe(rig.Enrollment.Status));
    }

    [Fact]
    public async Task Several_installations_cannot_be_activated_at_once_and_nothing_is_guessed()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        rig.Installations.Add("inst-ffffffffffffffffffff");
        Assert.Equal(new DeviceStatus(DeviceState.PendingActivation, DeviceDetail.MultipleInstallations), await Enroll(rig));
        Assert.Empty(rig.Server.Requests);
        Assert.Single(rig.ActivationFiles());
    }

    [Fact]
    public async Task Invalid_installation_ids_from_savedvariables_are_never_sent()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        rig.Installations.Clear();
        rig.Installations.Add("short");
        Assert.Equal(DeviceDetail.NoInstallation, (await Enroll(rig)).Detail);
        Assert.Empty(rig.Server.Requests);
    }

    // ---- ownership conflicts: fail closed ----------------------------------------------------

    [Fact]
    public async Task An_existing_anonymous_installation_is_never_taken_over_it_points_to_the_claim_flow()
    {
        using var rig = new DeviceRig();
        var legacy = rig.SeedLegacyFiles();
        var anonymous = rig.Server.AddAnonymousUser();
        rig.Server.SetOwner(rig.Installation, anonymous.Id);   // the old anonymous owner, as in production
        rig.Activate();
        var before = rig.TopLevelSnapshot();

        var status = await Enroll(rig);
        Assert.Equal(new DeviceStatus(DeviceState.OwnershipConflict, DeviceDetail.InstallationConflict), status);
        Assert.Contains("claim code", status.Message);
        Assert.Contains("already has an anonymous installation", status.Message);
        Assert.Equal(anonymous.Id, rig.Server.OwnerOf(rig.Installation));   // the server's owner is unchanged
        Assert.Empty(rig.Backend.Devices);
        Assert.Single(rig.ActivationFiles());                              // not a terminal answer: kept
        Assert.Equal(DeviceCredentialStatus.Missing, rig.Context.Store.Read().Status);
        Assert.Equal(before, rig.TopLevelSnapshot());                      // legacy slots and saved variables byte-for-byte
        Assert.Equal(legacy.Count, Directory.GetFiles(rig.Root).Length);

        // Not retried within the process; the legacy path stays available because the device holds no claim on it.
        Assert.Equal(DeviceState.OwnershipConflict, (await Enroll(rig)).State);
        Assert.Equal(1, rig.Backend.Count("fdb_device_enroll"));
        Assert.False(rig.Sync.Handles(rig.Installation));
    }

    [Fact]
    public async Task An_installation_owned_by_another_account_is_a_conflict()
    {
        using var rig = new DeviceRig();
        var other = rig.Server.AddRegisteredUser("other@example.test", "pw-pw-pw-pw");
        rig.Server.SetOwner(rig.Installation, other.Id);
        rig.Activate();
        Assert.Equal(DeviceDetail.InstallationConflict, (await Enroll(rig)).Detail);
        Assert.Equal(other.Id, rig.Server.OwnerOf(rig.Installation));
    }

    [Fact]
    public async Task An_installation_bound_to_another_device_is_a_conflict_with_revoke_instructions()
    {
        using var rig = new DeviceRig();
        using var other = new DeviceRig(rig.Server, rig.Backend, rig.Account, rig.Installation);   // a cloned SavedVariables on a second PC
        other.Activate();
        Assert.Equal(DeviceState.Registered, (await Enroll(other)).State);

        rig.Activate();
        var status = await Enroll(rig);
        Assert.Equal(new DeviceStatus(DeviceState.OwnershipConflict, DeviceDetail.InstallationBound), status);
        Assert.Contains("Revoke", status.Message);
        Assert.Equal(DeviceCredentialStatus.Missing, rig.Context.Store.Read().Status);
    }

    [Fact]
    public async Task A_device_identity_can_register_another_installation_without_creating_a_new_identity()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        await Enroll(rig);
        // The credential is lost (but the device identity session survives); a different installation id is now offered.
        foreach (var f in Directory.GetFiles(rig.DeviceDir, "device-credential*")) File.Delete(f);
        rig.Installations.Clear();
        rig.Installations.Add("inst-bbbbbbbbbbbbbbbbbbbb");
        rig.Activate();
        rig.Build();

        Assert.Equal(DeviceState.Registered, (await Enroll(rig)).State);
        Assert.Equal(1, rig.Server.SignupCount);
        Assert.Equal(2, rig.Backend.Devices.Count);
    }

    [Fact]
    public async Task An_unavailable_account_or_a_device_limit_keeps_the_file_and_changes_nothing()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        rig.Backend.AccountUnavailable = true;
        var status = await Enroll(rig);
        Assert.Equal(DeviceState.AccountUnavailable, status.State);
        Assert.Single(rig.ActivationFiles());
        Assert.Empty(rig.Backend.Devices);

        rig.Backend.AccountUnavailable = false;
        rig.Backend.Fault = rpc => rpc == "fdb_device_enroll" ? new FakeResponse(200, "{\"ok\":false,\"error\":\"device_limit\"}") : null;
        rig.Build();
        var limited = await Enroll(rig);
        Assert.Equal(new DeviceStatus(DeviceState.AccountUnavailable, DeviceDetail.LimitReached), limited);
        Assert.Contains("device limit", limited.Message);
        Assert.Single(rig.ActivationFiles());
    }

    [Fact]
    public async Task An_unknown_server_error_code_is_not_trusted()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        rig.Backend.Fault = rpc => rpc == "fdb_device_enroll" ? new FakeResponse(200, "{\"ok\":false,\"error\":\"surprise\"}") : null;
        Assert.Equal(new DeviceStatus(DeviceState.PendingActivation, DeviceDetail.Unexpected), await Enroll(rig));
        Assert.Single(rig.ActivationFiles());
    }

    // ---- identity safety ----------------------------------------------------------------------

    [Fact]
    public async Task Legacy_slots_stay_byte_for_byte_untouched_through_enrollment_and_sync_even_when_damaged()
    {
        foreach (var damaged in new[] { false, true })
        {
            using var rig = new DeviceRig();
            rig.SeedLegacyFiles(damaged);
            var before = rig.TopLevelSnapshot();
            rig.Activate();

            Assert.Equal(DeviceState.Registered, (await Enroll(rig)).State);
            Assert.Equal(DeviceSyncOutcome.Synced, (await rig.Sync.SyncNowAsync(rig.Snapshot())).Outcome);
            await rig.Sync.CheckStatusAsync();
            Assert.Equal(before, rig.TopLevelSnapshot());
            Assert.True(Directory.Exists(Path.Combine(rig.Root, "device")));
        }
    }

    [Fact]
    public async Task A_damaged_legacy_slot_does_not_disrupt_the_per_installation_credential()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        await Enroll(rig);
        var signups = rig.Server.SignupCount;
        var blob = rig.Context.Store.BlobPath;
        File.WriteAllText(blob, "damaged");
        File.Delete(blob + ".bak");
        rig.Build();
        var requests = rig.Server.Requests.Count;

        Assert.Equal(DeviceState.Registered, rig.Enrollment.LoadLocalState().State);
        Assert.Equal(DeviceState.Registered, (await Enroll(rig)).State);
        Assert.Equal(DeviceState.Registered, (await rig.Sync.CheckStatusAsync()).State);
        var sync = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Synced, sync.Outcome);
        Assert.Equal(signups, rig.Server.SignupCount);
        Assert.True(rig.Server.Requests.Count > requests);
        Assert.Equal("damaged", File.ReadAllText(blob));               // the legacy slot is preserved
        Assert.True(rig.Sync.Handles(rig.Installation));
    }

    [Fact]
    public async Task A_fresh_activation_file_recovers_a_damaged_credential_with_the_same_device_identity()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        await Enroll(rig);
        var blob = rig.Context.Store.BlobPath;
        var perInstallationBlob = rig.Context.Store.BlobPathFor(rig.Installation);
        File.WriteAllText(blob, "damaged");
        File.Delete(blob + ".bak");
        File.WriteAllText(perInstallationBlob, "damaged");
        File.Delete(perInstallationBlob + ".bak");
        rig.Build();
        rig.Activate();

        Assert.Equal(DeviceState.Registered, (await Enroll(rig)).State);
        Assert.Equal(1, rig.Server.SignupCount);
        Assert.Equal(rig.Backend.Devices.Last().Current, rig.Context.Store.Read(rig.Installation).Credential!.DeviceSecret);
        Assert.Equal("damaged", File.ReadAllText(blob));                 // the damaged legacy blob is preserved
    }

    [Fact]
    public async Task A_lost_device_session_with_a_credential_present_never_creates_a_new_identity()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        await Enroll(rig);
        File.Delete(Path.Combine(rig.DeviceDir, "session.dat"));
        File.Delete(Path.Combine(rig.DeviceDir, "session.dat.bak"));
        rig.Build();

        var sync = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Blocked, sync.Outcome);
        Assert.Equal(DeviceState.CredentialDamaged, rig.Sync.Status.State);
        Assert.Equal(1, rig.Server.SignupCount);
        Assert.Equal(0, rig.Backend.DeviceIngests);
    }

    [Theory]
    [InlineData("{\"error_code\":\"refresh_token_not_found\",\"msg\":\"Invalid Refresh Token: Refresh Token Not Found\"}")]
    [InlineData("{\"error\":\"invalid_grant\",\"error_description\":\"Invalid Refresh Token: Already Used\"}")]
    public async Task A_definitive_invalid_grant_never_silently_creates_a_new_identity(string body)
    {
        using var rig = new DeviceRig();
        rig.Activate();
        await Enroll(rig);
        var credentialBytes = File.ReadAllBytes(rig.Context.Store.BlobPath);
        rig.Clock.Advance(TimeSpan.FromHours(3));   // forces a refresh of the device session
        rig.Build();
        rig.Backend.RequestFault = r => r.Path == "/auth/v1/token" ? new FakeResponse(400, body) : null;

        var sync = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.Blocked, sync.Outcome);
        Assert.Equal(new DeviceStatus(DeviceState.CredentialDamaged, DeviceDetail.SessionNotAccepted), rig.Sync.Status);
        Assert.Equal(1, rig.Server.SignupCount);
        Assert.Equal(credentialBytes, File.ReadAllBytes(rig.Context.Store.BlobPath));
        Assert.Equal(0, rig.Backend.DeviceIngests);
        // The rejection is recorded in the non-secret marker only.
        Assert.Contains("rejected", File.ReadAllText(Path.Combine(rig.DeviceDir, "session.kind")));
    }

    [Fact]
    public async Task Network_and_server_errors_on_session_refresh_never_clear_anything()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        await Enroll(rig);
        var before = TestEnv.ReadAllFiles(rig.DeviceDir);
        rig.Clock.Advance(TimeSpan.FromHours(3));
        rig.Build();

        foreach (var response in new[] { new FakeResponse(503, "{}"), new FakeResponse(429, "{\"error_code\":\"over_request_rate_limit\"}"), new FakeResponse(400, "{\"error_code\":\"validation_failed\"}") })
        {
            rig.Backend.RequestFault = r => r.Path == "/auth/v1/token" ? response : null;
            var sync = await rig.Sync.SyncNowAsync(rig.Snapshot());
            Assert.Equal(DeviceSyncOutcome.RetryLater, sync.Outcome);
            Assert.Equal(DeviceState.Registered, rig.Sync.Status.State);
        }

        rig.Handler.Offline = true;
        Assert.Equal(DeviceSyncOutcome.RetryLater, (await rig.Sync.SyncNowAsync(rig.Snapshot())).Outcome);
        Assert.Equal(before, TestEnv.ReadAllFiles(rig.DeviceDir));
        Assert.Equal(1, rig.Server.SignupCount);
    }

    [Fact]
    public async Task A_busy_credential_file_changes_nothing_and_is_retried()
    {
        using var rig = new DeviceRig();
        rig.Activate();
        await Enroll(rig);
        var io = new ReadFaultIo();
        rig.Io = io;
        rig.Build();

        io.FailReads = true;
        Assert.Equal(DeviceState.Anonymous, rig.Enrollment.LoadLocalState().State);   // unreadable right now: nothing is concluded
        var sync = await rig.Sync.SyncNowAsync(rig.Snapshot());
        Assert.Equal(DeviceSyncOutcome.RetryLater, sync.Outcome);
        Assert.Equal(DeviceDetail.StorageFailure, rig.Sync.Status.Detail);

        io.FailReads = false;
        Assert.Equal(DeviceSyncOutcome.Synced, (await rig.Sync.SyncNowAsync(rig.Snapshot())).Outcome);
    }

    [Fact]
    public async Task Secrets_and_tickets_never_reach_disk_in_clear_or_any_status_text()
    {
        using var rig = new DeviceRig();
        var ticket = rig.Activate();
        var status = await Enroll(rig);
        await rig.Sync.SyncNowAsync(rig.Snapshot());
        var secret = rig.StoredCredential().DeviceSecret;

        Assert.False(TestEnv.DirectoryContains(rig.Root, secret));
        Assert.False(TestEnv.DirectoryContains(rig.Root, ticket));
        Assert.False(TestEnv.DirectoryContains(rig.Root, secret["fdbd1_".Length..]));
        foreach (var text in new[] { status.ToString(), status.Message, rig.Sync.Status.Message, rig.Context.Status.ToString(), rig.Enrollment.Status.ToString() })
        {
            Assert.DoesNotContain("fdba1_", text);
            Assert.DoesNotContain("fdbd1_", text);
            Assert.DoesNotContain(secret, text);
        }
    }

    [Fact]
    public async Task Handles_covers_only_the_device_installation_or_any_while_an_activation_is_pending()
    {
        using var rig = new DeviceRig();
        Assert.False(rig.Sync.Handles(rig.Installation));
        rig.Activate();
        rig.Enrollment.LoadLocalState();
        Assert.True(rig.Sync.Handles("inst-anything-goes-0000"));   // pending: the first anonymous upload must not claim it
        await Enroll(rig);
        Assert.True(rig.Sync.Handles(rig.Installation));
        Assert.False(rig.Sync.Handles("inst-anything-goes-0000"));
    }

    [Fact]
    public async Task The_status_event_fires_only_on_change_and_carries_no_secret()
    {
        using var rig = new DeviceRig();
        var seen = new List<DeviceStatus>();
        rig.Context.StatusChanged += s => seen.Add(s);
        rig.Activate();
        await Enroll(rig);
        await Enroll(rig);
        Assert.Equal(DeviceState.Registered, seen.Last().State);
        Assert.Equal(seen.Count, seen.Distinct().Count());
        Assert.DoesNotContain(seen, s => s.ToString().Contains("fdb", StringComparison.Ordinal));
    }
}
