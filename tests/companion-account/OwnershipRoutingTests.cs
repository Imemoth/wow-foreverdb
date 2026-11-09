using System.Text.Json.Nodes;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public class OwnershipRoutingTests
{
    private static string Snapshot(string installationId, long updatedAt = 100) =>
        $"{{\"p_snapshot\":{{\"installationId\":\"{installationId}\",\"updatedAt\":{updatedAt}}}}}";

    private sealed class World : IDisposable
    {
        public Rig Rig = new();
        public AuthSession Anonymous = default!;
        public FakeSupabase.User Registered = default!;
        public InstallationSyncCoordinator Sync => Rig.Runtime.Sync;
        public FakeSupabase Server => Rig.Server;

        /// <summary>An anonymous installation owner AND a signed-in registered account (legacy slot populated).</summary>
        public static async Task<World> SignedInWithLegacyAsync()
        {
            var w = new World();
            w.Anonymous = w.Rig.SeedAnonymous();
            w.Registered = w.Server.AddRegisteredUser("elara@example.test", "a-long-password-1");
            await w.Rig.Sessions.InitializeAsync();
            Assert.Equal(SignInOutcome.Success, await w.Rig.Sessions.SignInRegisteredAsync("elara@example.test", "a-long-password-1".ToCharArray()));
            return w;
        }

        public IEnumerable<LoggedRequest> Ingests => Server.RequestsTo("/rest/v1/rpc/ingest_foreverdb_snapshot_auth");
        public void Dispose() => Rig.Dispose();
    }

    private static string? SubOf(LoggedRequest r) => JwtInspector.TryDecode(r.Bearer)?.Subject;

    [Fact]
    public async Task Anonymous_owned_installation_syncs_only_with_the_anonymous_token()
    {
        using var w = await World.SignedInWithLegacyAsync();
        w.Server.SetOwner("inst-anon", w.Anonymous.UserId);

        var result = await w.Sync.SyncAsync("inst-anon", Snapshot("inst-anon"), 100, force: false, default);

        Assert.Equal(SyncOutcome.Synced, result.Outcome);
        Assert.Equal(InstallationOwnership.VerifiedTechnicalIdentity, result.Ownership);
        Assert.Equal(SlotRole.LegacyOwner, result.Role);
        var ingest = Assert.Single(w.Ingests);
        Assert.Equal(w.Anonymous.UserId, SubOf(ingest));
        Assert.NotEqual(w.Registered.Id, SubOf(ingest));
        Assert.Equal(w.Anonymous.UserId, w.Server.OwnerOf("inst-anon"));
        Assert.Equal(0, w.Server.SignupCount);
    }

    [Fact]
    public async Task Registered_technical_credential_is_tried_after_the_anonymous_credential_is_refused()
    {
        using var w = await World.SignedInWithLegacyAsync();
        w.Server.SetOwner("inst-reg", w.Registered.Id);

        var result = await w.Sync.SyncAsync("inst-reg", Snapshot("inst-reg"), 100, false, default);

        Assert.Equal(SyncOutcome.Synced, result.Outcome);
        Assert.Equal(InstallationOwnership.VerifiedTechnicalIdentity, result.Ownership);
        Assert.Equal(SlotRole.Primary, result.Role);
        Assert.Equal(w.Registered.Id, SubOf(w.Ingests.Last()));
        Assert.Equal(2, w.Ingests.Count());
        Assert.Empty(w.Server.RequestsTo("/rest/v1/rpc/fdb_installation_link_status"));
    }

    [Fact]
    public async Task Server_validates_each_held_technical_credential_and_new_ids_need_no_owner_choice()
    {
        using var w = await World.SignedInWithLegacyAsync();
        w.Server.SetOwner("a", w.Anonymous.UserId);
        w.Server.SetOwner("b", w.Registered.Id);
        w.Server.SetOwner("c", Guid.NewGuid().ToString());   // someone else's
        // "d" is brand new (no owner)

        var a = await w.Sync.SyncAsync("a", Snapshot("a"), 1, false, default);
        var b = await w.Sync.SyncAsync("b", Snapshot("b"), 1, false, default);
        var c = await w.Sync.SyncAsync("c", Snapshot("c"), 1, false, default);
        var d = await w.Sync.SyncAsync("d", Snapshot("d"), 1, false, default);

        Assert.Equal(SyncOutcome.Synced, a.Outcome);
        Assert.Equal(SyncOutcome.Synced, b.Outcome);
        Assert.Equal(BlockReason.Forbidden, c.Reason);
        Assert.Equal(SyncOutcome.Synced, d.Outcome);

        Assert.Equal(3, w.Server.IngestCount);
        Assert.Equal(w.Anonymous.UserId, w.Server.OwnerOf("d"));
        var byInstallation = w.Ingests.GroupBy(r => JsonNode.Parse(r.Body)!["p_snapshot"]!["installationId"]!.GetValue<string>())
            .ToDictionary(g => g.Key, g => g.Last());
        Assert.Equal(w.Anonymous.UserId, SubOf(byInstallation["a"]));
        Assert.Equal(w.Registered.Id, SubOf(byInstallation["b"]));

        var records = w.Sync.Installations.ToDictionary(r => r.InstallationId);
        Assert.Equal(InstallationOwnership.VerifiedTechnicalIdentity, records["a"].Ownership);
        Assert.Equal(InstallationOwnership.VerifiedTechnicalIdentity, records["b"].Ownership);
    }

    [Fact]
    public async Task Fresh_install_syncs_with_its_authenticated_anonymous_technical_identity_without_owner_choice()
    {
        using var w = await World.SignedInWithLegacyAsync();

        var result = await w.Sync.SyncAsync("brand-new", Snapshot("brand-new"), 1, false, default);

        Assert.Equal(SyncOutcome.Synced, result.Outcome);
        Assert.Equal(w.Anonymous.UserId, SubOf(Assert.Single(w.Ingests)));
        Assert.Equal(w.Anonymous.UserId, w.Server.OwnerOf("brand-new"));
        Assert.Empty(w.Server.RequestsTo("/rest/v1/rpc/fdb_installation_link_status"));
        Assert.Equal(0, w.Server.SignupCount);
    }

    [Fact]
    public async Task First_manual_sync_creates_a_local_anonymous_technical_identity_without_website_login()
    {
        using var rig = new Rig();

        var result = await rig.Runtime.Sync.SyncAsync("fresh-no-login", Snapshot("fresh-no-login"), 1, force: true, default);

        Assert.Equal(SyncOutcome.Synced, result.Outcome);
        Assert.Equal(1, rig.Server.SignupCount);
        Assert.Equal(rig.Server.OwnerOf("fresh-no-login"), SubOf(Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/ingest_foreverdb_snapshot_auth"))));
        Assert.Empty(rig.Server.RequestsTo("/rest/v1/rpc/fdb_installation_link_status"));
        Assert.True(rig.Runtime.Sessions.Status.State == SessionState.Anonymous);
    }

    [Fact]
    public async Task Existing_installation_is_authorized_by_the_server_bound_technical_credential()
    {
        using var w = await World.SignedInWithLegacyAsync();
        w.Server.SetOwner("legacy", w.Anonymous.UserId);

        var result = await w.Sync.SyncAsync("legacy", Snapshot("legacy"), 1, false, default);

        Assert.Equal(SyncOutcome.Synced, result.Outcome);
        Assert.Equal(w.Anonymous.UserId, SubOf(Assert.Single(w.Ingests)));
        Assert.Empty(w.Server.RequestsTo("/rest/v1/rpc/fdb_installation_link_status"));
    }

    [Fact]
    public async Task Fresh_install_needs_no_owner_choice_and_existing_unmapped_install_stays_fail_closed()
    {
        using var w = await World.SignedInWithLegacyAsync();

        var first = await w.Sync.SyncAsync("brand-new", Snapshot("brand-new"), 1, false, default);
        Assert.Equal(SyncOutcome.Synced, first.Outcome);
        Assert.Equal(w.Anonymous.UserId, w.Server.OwnerOf("brand-new"));
        Assert.Equal(w.Anonymous.UserId, SubOf(Assert.Single(w.Ingests)));

        // A known installation with no server-mapped technical credential cannot be claimed by its client-supplied ID.
        w.Server.SetOwner("theirs", Guid.NewGuid().ToString());
        var ingestsBefore = w.Ingests.Count();
        var wrong = await w.Sync.SyncAsync("theirs", Snapshot("theirs"), 1, false, default);
        Assert.Equal(BlockReason.Forbidden, wrong.Reason);
        Assert.Equal(ingestsBefore + 2, w.Ingests.Count());
        var again = await w.Sync.SyncAsync("theirs", Snapshot("theirs"), 1, false, default);
        Assert.Equal(BlockReason.Forbidden, again.Reason);
        Assert.Equal(ingestsBefore + 4, w.Ingests.Count());
    }

    [Fact]
    public async Task Claim_transfer_keeps_the_preserved_technical_upload_identity_valid()
    {
        var w = new World();
        using (w)
        {
            var anon = w.Rig.SeedAnonymous();
            w.Anonymous = anon;
            w.Server.SetOwner("inst", anon.UserId);
            var registered = w.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
            await w.Rig.Sessions.InitializeAsync();

            Assert.Equal(SyncOutcome.Synced, (await w.Sync.SyncAsync("inst", Snapshot("inst"), 1, false, default)).Outcome);

            // The website redeems the claim while the Companion is in anonymous mode.
            var offer = (await w.Rig.Runtime.Claims.StartClaimAsync("inst", default)).Offer!;
            Assert.True(w.Server.Redeem(offer.DisplayCode.Replace("FDB-", "").Replace("-", ""), registered.Id));

            var next = await w.Sync.SyncAsync("inst", Snapshot("inst", 2), 2, force: true, default);
            Assert.Equal(SyncOutcome.Synced, next.Outcome);
            Assert.Equal(2, w.Server.IngestCount);

            // The preserved anonymous technical identity continues without account sign-in.
            var paused = await w.Sync.SyncAsync("inst", Snapshot("inst", 3), 3, force: true, default);
            Assert.Equal(SyncOutcome.Synced, paused.Outcome);
            Assert.Equal(3, w.Server.IngestCount);
            Assert.Equal(registered.Id, w.Server.OwnerOf("inst"));
            Assert.Equal(0, w.Server.SignupCount);

            // Account switching does not change the technical upload credential.
            await w.Rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray());
            var resumed = await w.Sync.SyncAsync("inst", Snapshot("inst", 4), 4, force: true, default);
            Assert.Equal(SyncOutcome.Synced, resumed.Outcome);
            Assert.Equal(w.Anonymous.UserId, SubOf(w.Ingests.Last()));
        }
    }

    [Fact]
    public async Task Unknown_technical_credentials_are_rejected_without_exposing_an_account_owner()
    {
        using var w = await World.SignedInWithLegacyAsync();
        var other = w.Server.AddRegisteredUser("other@example.test", "another-long-pw-1");
        w.Server.SetOwner("inst", other.Id);

        var result = await w.Sync.SyncAsync("inst", Snapshot("inst"), 1, false, default);
        Assert.Equal(BlockReason.Forbidden, result.Reason);
        Assert.Equal(2, w.Ingests.Count());
    }

    [Fact]
    public async Task Registered_reauth_required_pauses_account_installations_but_legacy_installations_keep_syncing()
    {
        using var w = await World.SignedInWithLegacyAsync();
        w.Server.SetOwner("legacy-inst", w.Anonymous.UserId);
        w.Server.SetOwner("acct-inst", w.Registered.Id);

        // Revoke the registered session server-side and expire the local token so the refresh is definitively rejected.
        var vault = w.Rig.Vault();
        var primary = vault.Primary.Read().Session!;
        vault.Primary.Write(new AuthSession { AccessToken = primary.AccessToken, RefreshToken = "dead", ExpiresAt = 1, UserId = primary.UserId, Email = primary.Email }, SlotMarker.For(SessionKind.Registered));
        w.Rig.Restart();
        await w.Rig.Sessions.InitializeAsync();

        var acct = await w.Rig.Runtime.Sync.SyncAsync("acct-inst", Snapshot("acct-inst"), 1, false, default);
        Assert.Equal(SyncOutcome.Blocked, acct.Outcome);
        Assert.Equal(BlockReason.ReauthRequired, acct.Reason);
        Assert.Equal(SessionState.ReauthRequired, w.Rig.Sessions.Status.State);

        var legacy = await w.Rig.Runtime.Sync.SyncAsync("legacy-inst", Snapshot("legacy-inst"), 1, false, default);
        Assert.Equal(SyncOutcome.Synced, legacy.Outcome);
        Assert.Equal(w.Anonymous.UserId, SubOf(w.Ingests.Last()));
        Assert.Equal(0, w.Server.SignupCount);
    }

    [Fact]
    public async Task Sync_does_not_call_installation_owner_lookup()
    {
        using var w = await World.SignedInWithLegacyAsync();
        w.Server.SetOwner("inst", w.Anonymous.UserId);
        var result = await w.Sync.SyncAsync("inst", Snapshot("inst"), 1, false, default);
        Assert.Equal(SyncOutcome.Synced, result.Outcome);
        Assert.Empty(w.Server.RequestsTo("/rest/v1/rpc/fdb_installation_link_status"));
    }

    // ------------------------------------------------------------------ gate closed: 0.8.x behaviour ----

    [Fact]
    public async Task Production_anonymous_behaviour_is_unchanged_with_the_gate_closed()
    {
        using var rig = new Rig(accountsEnabled: false);
        var anon = rig.SeedAnonymous();
        // Production Companion never calls an ownership RPC (it is not deployed there).
        var result = await rig.Runtime.Sync.SyncAsync("inst", Snapshot("inst"), 1, false, default);

        Assert.Equal(SyncOutcome.Synced, result.Outcome);
        Assert.Equal(anon.UserId, rig.Server.OwnerOf("inst"));
        Assert.Empty(rig.Server.RequestsTo("/rest/v1/rpc/fdb_installation_link_status"));
        Assert.Equal(0, rig.Server.SignupCount);
    }

    // ------------------------------------------------------------------ races and caches ----

    [Fact]
    public async Task Snapshot_cache_is_scoped_by_owner_and_identity_generation()
    {
        using var w = await World.SignedInWithLegacyAsync();
        w.Server.SetOwner("inst", w.Anonymous.UserId);

        Assert.Equal(SyncOutcome.Synced, (await w.Sync.SyncAsync("inst", Snapshot("inst"), 5, false, default)).Outcome);
        Assert.Equal(SyncOutcome.UpToDate, (await w.Sync.SyncAsync("inst", Snapshot("inst"), 5, false, default)).Outcome);
        Assert.Equal(1, w.Server.IngestCount);

        // Force bypasses the cache (manual sync semantics).
        Assert.Equal(SyncOutcome.Synced, (await w.Sync.SyncAsync("inst", Snapshot("inst"), 5, true, default)).Outcome);
        Assert.Equal(2, w.Server.IngestCount);

        // Identity switch (sign out / back in): the cache is dropped, the same snapshot is uploaded again by the new identity.
        await w.Rig.Sessions.SignOutRegisteredAsync();
        await w.Rig.Sessions.SignInRegisteredAsync("elara@example.test", "a-long-password-1".ToCharArray());
        Assert.Equal(SyncOutcome.Synced, (await w.Sync.SyncAsync("inst", Snapshot("inst"), 5, false, default)).Outcome);
        Assert.Equal(3, w.Server.IngestCount);
    }

    [Fact]
    public async Task Logout_during_an_active_sync_discards_the_result_and_never_marks_it_synced()
    {
        using var w = await World.SignedInWithLegacyAsync();
        w.Server.SetOwner("inst", w.Registered.Id);
        var hold = w.Server.Hold = new FakeSupabase.IngestHold();

        var inFlight = w.Sync.SyncAsync("inst", Snapshot("inst"), 1, false, default);
        await hold.Entered;                       // the upload is now in flight at the server
        await w.Rig.Sessions.SignOutRegisteredAsync();
        hold.Release();
        var result = await inFlight;

        Assert.Equal(SyncOutcome.StaleDiscarded, result.Outcome);
        // The stale request did not repopulate account-specific state after the switch.
        Assert.All(w.Sync.Installations, r => Assert.Null(r.LastSyncedAt));
        w.Server.Hold = null;

        // The same snapshot is NOT considered synced for whoever acts next.
        Assert.Equal(SyncOutcome.Blocked, (await w.Sync.SyncAsync("inst", Snapshot("inst"), 1, false, default)).Outcome);
    }

    [Fact]
    public async Task Login_during_an_active_sync_discards_the_result()
    {
        using var rig = new Rig();
        var anon = rig.SeedAnonymous();
        rig.Server.SetOwner("inst", anon.UserId);
        rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        await rig.Sessions.InitializeAsync();
        var hold = rig.Server.Hold = new FakeSupabase.IngestHold();

        var inFlight = rig.Runtime.Sync.SyncAsync("inst", Snapshot("inst"), 1, false, default);
        await hold.Entered;
        await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray());
        hold.Release();
        var result = await inFlight;

        Assert.Equal(SyncOutcome.StaleDiscarded, result.Outcome);
        Assert.All(rig.Runtime.Sync.Installations, r => Assert.Null(r.LastSyncedAt));
    }

    [Fact]
    public async Task Two_simultaneous_sync_requests_for_one_installation_are_serialised_and_deduplicated()
    {
        using var w = await World.SignedInWithLegacyAsync();
        w.Server.SetOwner("inst", w.Registered.Id);
        var hold = w.Server.Hold = new FakeSupabase.IngestHold();

        var auto = w.Sync.SyncAsync("inst", Snapshot("inst"), 7, false, default);
        await hold.Entered;                                                   // first request is at the server...
        var manual = w.Sync.SyncAsync("inst", Snapshot("inst"), 7, false, default);   // ...second arrives meanwhile
        await Task.Delay(100);
        Assert.False(manual.IsCompleted);                                     // serialised behind the first
        hold.Release();
        var results = await Task.WhenAll(auto, manual);

        Assert.Equal(1, w.Server.IngestCount);
        Assert.Contains(results, r => r.Outcome == SyncOutcome.Synced);
        Assert.Contains(results, r => r.Outcome == SyncOutcome.UpToDate);
    }

    [Theory]
    [InlineData(401, BlockReason.Unauthorized)]
    [InlineData(403, BlockReason.Forbidden)]
    [InlineData(429, BlockReason.RateLimited)]
    [InlineData(503, BlockReason.ServerUnavailable)]
    [InlineData(404, BlockReason.NotDeployed)]
    public async Task Ingest_failures_are_typed_and_do_not_mark_the_snapshot_synced(int status, BlockReason expected)
    {
        using var w = await World.SignedInWithLegacyAsync();
        w.Server.SetOwner("inst", w.Registered.Id);
        w.Server.Interceptor = r => r.Path.EndsWith("ingest_foreverdb_snapshot_auth", StringComparison.Ordinal)
            ? new FakeResponse(status, "{\"message\":\"secret-detail eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig\"}")
            : null;

        var result = await w.Sync.SyncAsync("inst", Snapshot("inst"), 9, false, default);
        Assert.Equal(expected, result.Reason);

        w.Server.Interceptor = null;
        Assert.Equal(SyncOutcome.Synced, (await w.Sync.SyncAsync("inst", Snapshot("inst"), 9, false, default)).Outcome);
    }

    [Fact]
    public async Task Offline_sync_blocks_with_a_typed_reason_and_creates_no_identity()
    {
        using var rig = new Rig();
        var anon = rig.SeedAnonymous(expired: true);
        rig.Server.SetOwner("inst", anon.UserId);
        rig.Handler.Offline = true;
        await rig.Sessions.InitializeAsync();

        var result = await rig.Runtime.Sync.SyncAsync("inst", Snapshot("inst"), 1, false, default);
        Assert.Equal(SyncOutcome.Blocked, result.Outcome);
        Assert.Equal(0, rig.Server.SignupCount);
        Assert.Equal(SessionState.Anonymous, rig.Sessions.Status.State);
    }
}
