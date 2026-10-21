using ForeverDB.Companion.Models;
using ForeverDB.Companion.Services;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

/// <summary>
/// The wired path: AccountRuntime (staging gate) + the real linked SyncService and SavedVariables parser. Registered devices
/// upload through the device identity; every non-device installation behaves exactly as before.
/// </summary>
public class DeviceIntegrationTests
{
    private sealed class Wiring : IDisposable
    {
        public FakeSupabase Server = new();
        public FakeDeviceBackend Backend;
        public FakeHandler Handler;
        public string Dir = TestEnv.NewDirectory();
        public string Activation => Path.Combine(Dir, "activation");
        public string Installation = "inst-" + Guid.NewGuid().ToString("N")[..20];
        public AccountRuntime Runtime;
        public SyncService Sync;
        public FakeSupabase.User Account;
        public List<string> Events = new();
        public List<BlockReason> Blocks = new();
        public List<string?> BlockMessages = new();
        public int GuildbookCalls;
        public string SavedVariables;

        public Wiring()
        {
            Backend = new FakeDeviceBackend(Server);
            Handler = new FakeHandler(Server);
            Account = Server.AddRegisteredUser("owner@example.test", "correct horse battery");
            Directory.CreateDirectory(Activation);
            Runtime = AccountRuntime.Create(
                TestEnv.StagingGate(), TestEnv.ProductionEndpoint, Handler, TestEnv.Protector(), Dir, null, null,
                new FileActivationSource(new[] { new ActivationSearchLocation(Activation, "*.fdbact") }),
                () => new[] { Installation });
            SavedVariables = Path.Combine(Dir, $"ForeverDB-{Installation}.lua");
            Write(100);
            Sync = new SyncService(Runtime.Sync, device: Runtime.Device!.Sync);
            Sync.SyncCompleted += (_, e) => Events.Add($"synced:{e.Trigger}");
            Sync.Authenticated += () => Events.Add("auth");
            Sync.SyncBlocked += (_, e) => { Blocks.Add(e.Reason); BlockMessages.Add(e.Message); };
            Sync.GuildbookChanged += _ => GuildbookCalls++;
        }

        public void Write(long updatedAt)
        {
            var lua = $"ForeverDB_Export = \"H|9|0.5.0-alpha|{Installation}|{updatedAt}\\nM|1|Eastern%20Kingdoms|0|1\\nG|gk|Guild|Realm|50\\nC|gk|guid0|Member0|Rogue|ROGUE|60|Officer|1|1|Tirisfal%20Glades|0\\nS|creature|1|1|Wolf\"";
            File.WriteAllText(SavedVariables, lua);
        }

        public async Task Enroll()
        {
            File.WriteAllText(Path.Combine(Activation, "foreverdb-activation.fdbact"), FakeDeviceBackend.ActivationJson(Backend.IssueTicket(Account.Id)));
            Sync.DiscoverInstallations(new[] { SavedVariables });
            Assert.Equal(DeviceState.Registered, (await Runtime.Device!.Enrollment.InitializeAsync()).State);
        }

        public void Dispose()
        {
            try { Directory.Delete(Dir, true); } catch { }
        }
    }

    private static int AnonymousIngests(Wiring w) => w.Server.RequestsTo("/rest/v1/rpc/ingest_foreverdb_snapshot_auth").Count;

    [Fact]
    public async Task Manual_sync_of_a_registered_device_uploads_through_the_device_path_and_raises_the_usual_events()
    {
        using var w = new Wiring();
        await w.Enroll();

        var attempt = await w.Sync.SyncFileAsync(w.SavedVariables, force: true, trigger: SyncTrigger.Manual);
        Assert.Equal(SyncOutcome.Synced, attempt!.Outcome);
        Assert.Equal(new[] { "auth", "synced:Manual" }, w.Events);
        Assert.Equal(1, w.Backend.DeviceIngests);
        Assert.Equal(0, AnonymousIngests(w));
        Assert.Equal(0, w.GuildbookCalls); // device/public sync never routes private Guildbook data
    }

    [Fact]
    public async Task Accepted_device_upload_shows_the_installation_as_owned_by_the_account_and_only_then()
    {
        using var w = new Wiring();
        await w.Enroll();

        // Enrolled and discovered, but nothing server-verified yet: the row must not claim ownership.
        Assert.Equal(InstallationOwnership.Unchecked, w.Runtime.Sync.Installations.Single(r => r.InstallationId == w.Installation).Ownership);

        var changed = new List<InstallationRecord>();
        w.Runtime.Sync.InstallationChanged += changed.Add;
        Assert.Equal(SyncOutcome.Synced, (await w.Sync.SyncFileAsync(w.SavedVariables, force: false, trigger: SyncTrigger.Auto))!.Outcome);

        var record = w.Runtime.Sync.Installations.Single(r => r.InstallationId == w.Installation);
        Assert.Equal(InstallationOwnership.OwnedByRegisteredAccount, record.Ownership);
        Assert.Equal(BlockReason.None, record.LastBlock);
        Assert.NotNull(record.LastSyncedAt);
        Assert.Equal("Owned by your account", AccountMessages.Describe(record.Ownership));
        Assert.Contains(changed, r => r.Ownership == InstallationOwnership.OwnedByRegisteredAccount);   // the Account tab is notified
        Assert.Equal(0, AnonymousIngests(w));
        Assert.Equal(1, w.Backend.DeviceIngests);
    }

    [Fact]
    public async Task A_refused_device_upload_never_shows_the_installation_as_owned_and_clears_an_earlier_owned_state()
    {
        using var w = new Wiring();
        await w.Enroll();
        Assert.Equal(SyncOutcome.Synced, (await w.Sync.SyncFileAsync(w.SavedVariables, force: true, trigger: SyncTrigger.Manual))!.Outcome);
        Assert.Equal(InstallationOwnership.OwnedByRegisteredAccount, w.Runtime.Sync.Installations.Single().Ownership);

        w.Backend.RevokeDevice(w.Backend.Devices.Single().Id);
        w.Write(200);
        Assert.Equal(SyncOutcome.Blocked, (await w.Sync.SyncFileAsync(w.SavedVariables, force: true, trigger: SyncTrigger.Manual))!.Outcome);

        var record = w.Runtime.Sync.Installations.Single();
        Assert.Equal(InstallationOwnership.Unchecked, record.Ownership);
        Assert.Equal(BlockReason.DeviceSyncNotCompleted, record.LastBlock);
    }

    [Theory]
    [InlineData(SyncTrigger.Auto)]
    [InlineData(SyncTrigger.Startup)]
    public async Task Automatic_triggers_upload_non_empty_snapshots_for_a_registered_device_and_update_local_data(SyncTrigger trigger)
    {
        using var w = new Wiring();
        await w.Enroll();

        var attempt = await w.Sync.SyncFileAsync(w.SavedVariables, force: false, trigger: trigger);
        Assert.Equal(SyncOutcome.Synced, attempt!.Outcome);
        Assert.Equal(BlockReason.None, attempt.Reason);
        Assert.Equal(1, w.Backend.DeviceIngests);
        Assert.Equal(0, AnonymousIngests(w));
        Assert.Equal(1, w.Backend.Count("fdb_device_ingest"));
        Assert.Equal(new[] { "auth", $"synced:{trigger}" }, w.Events);
        Assert.Empty(w.Blocks);
        Assert.Equal(0, w.GuildbookCalls);
    }

    [Fact]
    public async Task Repeated_automatic_snapshot_is_deduplicated_but_manual_sync_still_uploads()
    {
        using var w = new Wiring();
        await w.Enroll();

        var first = await w.Sync.SyncFileAsync(w.SavedVariables, force: false, trigger: SyncTrigger.Auto);
        var duplicate = await w.Sync.SyncFileAsync(w.SavedVariables, force: false, trigger: SyncTrigger.Auto);
        var manual = await w.Sync.SyncFileAsync(w.SavedVariables, force: true, trigger: SyncTrigger.Manual);

        Assert.Equal(SyncOutcome.Synced, first!.Outcome);
        Assert.Equal(SyncOutcome.UpToDate, duplicate!.Outcome);
        Assert.Equal(SyncOutcome.Synced, manual!.Outcome);
        Assert.Equal(2, w.Backend.DeviceIngests);
    }

    [Fact]
    public async Task Concurrent_automatic_events_produce_one_device_upload()
    {
        using var w = new Wiring();
        await w.Enroll();
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var firstIngest = 0;
        w.Backend.OnCall = (rpc, _) =>
        {
            if (rpc == "fdb_device_ingest" && Interlocked.Increment(ref firstIngest) == 1)
            {
                entered.Set();
                Assert.True(release.Wait(TimeSpan.FromSeconds(5)), "test did not release the first ingest");
            }
        };

        var first = Task.Run(() => w.Sync.SyncFileAsync(w.SavedVariables, force: false, trigger: SyncTrigger.Auto));
        Assert.True(entered.Wait(TimeSpan.FromSeconds(5)), "first ingest did not start");
        var second = Task.Run(() => w.Sync.SyncFileAsync(w.SavedVariables, force: false, trigger: SyncTrigger.Auto));

        await Task.Delay(100);
        Assert.Equal(1, w.Backend.Count("fdb_device_ingest"));
        release.Set();

        var attempts = await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Contains(attempts, attempt => attempt!.Outcome == SyncOutcome.Synced);
        Assert.Contains(attempts, attempt => attempt!.Outcome == SyncOutcome.UpToDate);
        Assert.Equal(1, w.Backend.DeviceIngests);
    }

    [Theory]
    [InlineData(SyncTrigger.Manual)]
    [InlineData(SyncTrigger.Auto)]
    public async Task A_revoked_device_never_falls_back_to_the_anonymous_ingest_even_with_a_legacy_session_present(SyncTrigger trigger)
    {
        using var w = new Wiring();
        await w.Enroll();
        // A preserved legacy anonymous identity exists in the account vault, exactly the fallback a bug could pick.
        var legacyUser = w.Server.AddAnonymousUser();
        var vault = new SessionVault(Path.Combine(w.Dir, w.Runtime.Gate.CredentialSubdirectory), TestEnv.Protector());
        vault.Primary.Write(w.Server.IssueSession(legacyUser.Id), SlotMarker.For(SessionKind.Anonymous));
        await w.Runtime.Sessions.InitializeAsync();
        w.Backend.RevokeDevice(w.Backend.Devices.Single().Id);

        var attempt = await w.Sync.SyncFileAsync(w.SavedVariables, force: trigger == SyncTrigger.Manual, trigger: trigger);
        Assert.Equal(SyncOutcome.Blocked, attempt!.Outcome);
        Assert.Equal(BlockReason.DeviceSyncNotCompleted, attempt.Reason);
        Assert.Equal(0, w.Server.IngestCount);
        Assert.Equal(0, AnonymousIngests(w));
        Assert.Single(w.Blocks);
        Assert.Contains("revoked", w.BlockMessages.Single());
    }

    [Fact]
    public async Task While_the_activation_is_pending_even_a_manual_sync_stays_off_the_anonymous_path()
    {
        using var w = new Wiring();
        File.WriteAllText(Path.Combine(w.Activation, "foreverdb-activation.fdbact"), FakeDeviceBackend.ActivationJson(w.Backend.IssueTicket(w.Account.Id)));
        Assert.Equal(DeviceState.PendingActivation, w.Runtime.Device!.Enrollment.LoadLocalState().State);

        var manual = await w.Sync.SyncFileAsync(w.SavedVariables, force: true, trigger: SyncTrigger.Manual);
        var auto = await w.Sync.SyncFileAsync(w.SavedVariables, force: true, trigger: SyncTrigger.Auto);
        Assert.Equal(SyncOutcome.Blocked, manual!.Outcome);
        Assert.Equal(BlockReason.DeviceSyncNotCompleted, auto!.Reason);
        Assert.Equal(0, w.Server.IngestCount);
        Assert.Empty(w.Server.Requests);   // not even a token request
    }

    [Fact]
    public async Task Installations_without_a_device_credential_keep_the_unchanged_anonymous_behaviour()
    {
        using var w = new Wiring();
        // No activation: the device runtime exists (staging gate) but handles nothing.
        var user = w.Server.AddAnonymousUser();
        var vault = new SessionVault(Path.Combine(w.Dir, w.Runtime.Gate.CredentialSubdirectory), TestEnv.Protector());
        vault.Primary.Write(w.Server.IssueSession(user.Id), SlotMarker.For(SessionKind.Anonymous));
        await w.Runtime.Sessions.InitializeAsync();
        w.Runtime.Device!.Enrollment.LoadLocalState();
        w.Runtime.Sync.SelectOwner(w.Installation, OwnerChoice.AnonymousIdentity);   // the existing explicit owner choice

        var attempt = await w.Sync.SyncFileAsync(w.SavedVariables, force: true, trigger: SyncTrigger.Auto);
        Assert.Equal(SyncOutcome.Synced, attempt!.Outcome);
        Assert.Equal(1, w.Server.IngestCount);
        Assert.Equal(0, w.Backend.Count("fdb_device_ingest"));
    }

    [Fact]
    public async Task Without_a_device_sync_service_the_sync_service_is_exactly_the_old_one()
    {
        using var w = new Wiring();
        var user = w.Server.AddAnonymousUser();
        var vault = new SessionVault(Path.Combine(w.Dir, w.Runtime.Gate.CredentialSubdirectory), TestEnv.Protector());
        vault.Primary.Write(w.Server.IssueSession(user.Id), SlotMarker.For(SessionKind.Anonymous));
        await w.Runtime.Sessions.InitializeAsync();
        w.Runtime.Sync.SelectOwner(w.Installation, OwnerChoice.AnonymousIdentity);
        var plain = new SyncService(w.Runtime.Sync);
        var attempt = await plain.SyncFileAsync(w.SavedVariables, force: true, trigger: SyncTrigger.Manual);
        Assert.Equal(SyncOutcome.Synced, attempt!.Outcome);
        Assert.Equal(1, w.Server.IngestCount);
    }

    [Fact]
    public async Task Public_device_autosync_survives_sign_out_and_account_switch_without_using_anonymous_ingest()
    {
        using var w = new Wiring();
        await w.Enroll();

        var vault = new SessionVault(
            Path.Combine(w.Dir, w.Runtime.Gate.CredentialSubdirectory),
            TestEnv.Protector());
        vault.Primary.Write(
            w.Server.IssueSession(w.Account.Id),
            SlotMarker.For(SessionKind.Registered));
        await w.Runtime.Sessions.InitializeAsync();

        Assert.Equal(SyncOutcome.Synced, (await w.Sync.SyncFileAsync(w.SavedVariables, trigger: SyncTrigger.Auto))!.Outcome);
        Assert.Equal(SignOutOutcome.Confirmed, await w.Runtime.Sessions.SignOutRegisteredAsync());

        var other = w.Server.AddRegisteredUser("other@example.test", "correct horse battery");
        Assert.Equal(SignInOutcome.Success, await w.Runtime.Sessions.SignInRegisteredAsync(other.Email!, other.Password!.ToCharArray()));
        w.Write(200);

        var switched = await w.Sync.SyncFileAsync(w.SavedVariables, trigger: SyncTrigger.Auto);

        Assert.Equal(SyncOutcome.Synced, switched!.Outcome);
        Assert.Equal(2, w.Backend.DeviceIngests);
        Assert.Equal(0, AnonymousIngests(w));
    }
}
