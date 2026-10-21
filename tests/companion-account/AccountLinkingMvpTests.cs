using ForeverDB.Companion.Services;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public sealed class AccountLinkingMvpTests
{
    private const string InstallationId = "0123456789abcdef0123456789abcdef";

    [Fact]
    public async Task Standard_build_supports_fresh_anonymous_use_account_linking_and_manual_device_sync()
    {
        var server = new FakeSupabase();
        var handler = new FakeHandler(server);
        var directory = TestEnv.NewDirectory();
        var gate = AccountFeatureGate.EvaluateForRuntime(_ => null, TestEnv.ProductionEndpoint);
        var runtime = AccountRuntime.Create(
            gate,
            TestEnv.ProductionEndpoint,
            handler,
            TestEnv.Protector(),
            directory,
            activationSource: new FileActivationSource(Array.Empty<ActivationSearchLocation>()));

        await runtime.Sessions.InitializeAsync();
        Assert.Equal(StartAnonymousOutcome.Created, await runtime.Sessions.StartAnonymousAsync(false));
        var anonymous = await runtime.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        server.SetOwner(InstallationId, JwtInspector.TryDecode(anonymous.AccessToken)!.Subject);
        server.AddRegisteredUser("elara@example.test", "a-long-password-1");

        Assert.Equal(SignInOutcome.Success,
            await runtime.Sessions.SignInRegisteredAsync("elara@example.test", "a-long-password-1".ToCharArray()));
        Assert.Equal(AccountLinkOutcome.Connected,
            (await runtime.Linking.ConnectAsync(InstallationId, "This PC")).Outcome);

        var automatic = await runtime.Device!.Sync.SyncAutomaticAsync(
            $"{{\"p_snapshot\":{{\"installationId\":\"{InstallationId}\"}}}}");
        var manual = await runtime.Device.Sync.SyncNowAsync(
            $"{{\"p_snapshot\":{{\"installationId\":\"{InstallationId}\"}}}}");

        Assert.Equal(DeviceSyncOutcome.Synced, automatic.Outcome);
        Assert.Equal(DeviceSyncOutcome.Synced, manual.Outcome);
        Assert.Equal(2, server.RequestsTo("/rest/v1/rpc/fdb_device_ingest").Count);
        Assert.False(AccountFeatureGate.ZeroTouchAvailable(gate));
        Assert.True(AccountFeatureGate.DeviceAutoSyncApproved);
    }

    [Fact]
    public async Task Signed_in_user_can_link_the_existing_anonymous_installation_and_register_this_device()
    {
        using var rig = new Rig();
        var anonymous = rig.SeedAnonymous();
        var account = rig.Server.AddRegisteredUser("elara@example.test", "a-long-password-1");
        rig.Server.SetOwner(InstallationId, anonymous.UserId);
        await rig.Sessions.InitializeAsync();

        Assert.Equal(
            SignInOutcome.Success,
            await rig.Sessions.SignInRegisteredAsync("elara@example.test", "a-long-password-1".ToCharArray()));

        var result = await rig.Runtime.Linking.ConnectAsync(InstallationId, "This PC", default);

        Assert.Equal(AccountLinkOutcome.Connected, result.Outcome);
        Assert.Equal(account.Id, rig.Server.OwnerOf(InstallationId));
        Assert.Equal(DeviceState.Registered, rig.Runtime.Device!.Status.State);
        var stored = rig.Runtime.Device.Context.Store.Read();
        Assert.Equal(DeviceCredentialStatus.Ok, stored.Status);
        Assert.Equal(InstallationId, stored.Credential!.InstallationId);

        var claim = Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_start"));
        var redeem = Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_redeem"));
        var issue = Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_enrollment_ticket_issue"));
        var enroll = Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/fdb_device_enroll"));
        Assert.Equal(anonymous.UserId, JwtInspector.TryDecode(claim.Bearer)!.Subject);
        Assert.Equal(account.Id, JwtInspector.TryDecode(redeem.Bearer)!.Subject);
        Assert.Equal(account.Id, JwtInspector.TryDecode(issue.Bearer)!.Subject);
        Assert.NotEqual(account.Id, JwtInspector.TryDecode(enroll.Bearer)!.Subject);

        Assert.False(TestEnv.DirectoryContains(rig.Directory, rig.Server.LastClaimCode!));
        Assert.False(TestEnv.DirectoryContains(rig.Directory, rig.Server.LastEnrollmentTicket!));
        Assert.False(TestEnv.DirectoryContains(rig.Directory, stored.Credential.DeviceSecret));
        Assert.DoesNotContain(rig.Server.LastClaimCode!, result.ToString());
        Assert.DoesNotContain(rig.Server.LastEnrollmentTicket!, result.ToString());
    }

    [Fact]
    public async Task Closed_account_gate_sends_no_linking_or_device_requests()
    {
        using var rig = new Rig(accountsEnabled: false);

        var result = await rig.Runtime.Linking.ConnectAsync(InstallationId, "This PC", default);

        Assert.Equal(AccountLinkOutcome.FeatureDisabled, result.Outcome);
        Assert.Empty(rig.Server.Requests);
    }

    [Fact]
    public async Task Installation_id_without_the_anonymous_owner_credential_cannot_be_claimed()
    {
        using var rig = new Rig();
        var actualOwner = rig.Server.AddAnonymousUser();
        var account = rig.Server.AddRegisteredUser("elara@example.test", "a-long-password-1");
        rig.Server.SetOwner(InstallationId, actualOwner.Id);
        rig.Vault().Primary.Write(rig.Server.IssueSession(account.Id), SlotMarker.For(SessionKind.Registered));
        await rig.Sessions.InitializeAsync();

        var result = await rig.Runtime.Linking.ConnectAsync(InstallationId, "This PC", default);

        Assert.Equal(AccountLinkOutcome.NoAnonymousOwner, result.Outcome);
        Assert.Equal(actualOwner.Id, rig.Server.OwnerOf(InstallationId));
        Assert.Empty(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_start"));
        Assert.Empty(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_redeem"));
        Assert.Empty(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_enrollment_ticket_issue"));
    }

    [Fact]
    public async Task Revoked_registered_session_cannot_transfer_ownership()
    {
        using var rig = new Rig();
        var anonymous = rig.SeedAnonymous();
        rig.Server.AddRegisteredUser("elara@example.test", "a-long-password-1");
        rig.Server.SetOwner(InstallationId, anonymous.UserId);
        await rig.Sessions.InitializeAsync();
        Assert.Equal(SignInOutcome.Success, await rig.Sessions.SignInRegisteredAsync("elara@example.test", "a-long-password-1".ToCharArray()));
        var token = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary, default);
        Assert.Equal(204, (await rig.Server.HandleAsync("POST", "/auth/v1/logout?scope=local", token.AccessToken, "test", "{}")).Status);

        var result = await rig.Runtime.Linking.ConnectAsync(InstallationId, "This PC", default);

        Assert.Equal(AccountLinkOutcome.CredentialUnavailable, result.Outcome);
        Assert.Equal(anonymous.UserId, rig.Server.OwnerOf(InstallationId));
        Assert.Empty(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_start"));
    }

    [Fact]
    public async Task Concurrent_connect_clicks_transfer_and_register_exactly_once()
    {
        using var rig = new Rig();
        var anonymous = rig.SeedAnonymous();
        rig.Server.AddRegisteredUser("elara@example.test", "a-long-password-1");
        rig.Server.SetOwner(InstallationId, anonymous.UserId);
        await rig.Sessions.InitializeAsync();
        Assert.Equal(SignInOutcome.Success, await rig.Sessions.SignInRegisteredAsync("elara@example.test", "a-long-password-1".ToCharArray()));

        var results = await Task.WhenAll(
            rig.Runtime.Linking.ConnectAsync(InstallationId, "This PC", default),
            rig.Runtime.Linking.ConnectAsync(InstallationId, "This PC", default));

        Assert.All(results, x => Assert.Equal(AccountLinkOutcome.Connected, x.Outcome));
        Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_start"));
        Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_redeem"));
        Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_enrollment_ticket_issue"));
        Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/fdb_device_enroll"));
    }

    [Fact]
    public async Task Manual_and_automatic_sync_after_connection_use_the_device_identity()
    {
        using var rig = new Rig();
        var anonymous = rig.SeedAnonymous();
        var account = rig.Server.AddRegisteredUser("elara@example.test", "a-long-password-1");
        rig.Server.SetOwner(InstallationId, anonymous.UserId);
        await rig.Sessions.InitializeAsync();
        Assert.Equal(SignInOutcome.Success, await rig.Sessions.SignInRegisteredAsync("elara@example.test", "a-long-password-1".ToCharArray()));
        Assert.Equal(AccountLinkOutcome.Connected, (await rig.Runtime.Linking.ConnectAsync(InstallationId, "This PC", default)).Outcome);

        var before = rig.Server.RequestsTo("/rest/v1/rpc/fdb_device_ingest").Count;
        var automatic = await rig.Runtime.Device!.Sync.SyncAutomaticAsync(
            $"{{\"p_snapshot\":{{\"installationId\":\"{InstallationId}\"}}}}", default);
        var manual = await rig.Runtime.Device.Sync.SyncNowAsync(
            $"{{\"p_snapshot\":{{\"installationId\":\"{InstallationId}\"}}}}", default);

        Assert.Equal(DeviceSyncOutcome.Synced, automatic.Outcome);
        Assert.Equal(DeviceSyncOutcome.Synced, manual.Outcome);
        var ingests = rig.Server.RequestsTo("/rest/v1/rpc/fdb_device_ingest").Skip(before).ToArray();
        Assert.Equal(2, ingests.Length);
        Assert.All(ingests, ingest =>
        {
            Assert.NotEqual(account.Id, JwtInspector.TryDecode(ingest.Bearer)!.Subject);
            Assert.DoesNotContain("access_token", ingest.Body, StringComparison.OrdinalIgnoreCase);
        });
        Assert.True(AccountFeatureGate.DeviceAutoSyncApproved);
    }

    [Fact]
    public async Task Existing_device_session_can_enroll_another_installation_without_a_second_identity()
    {
        const string secondInstallation = "fedcba9876543210fedcba9876543210";
        using var rig = new Rig();
        var anonymous = rig.SeedAnonymous();
        var account = rig.Server.AddRegisteredUser("elara@example.test", "a-long-password-1");
        rig.Server.SetOwner(InstallationId, anonymous.UserId);
        rig.Server.SetOwner(secondInstallation, account.Id);
        await rig.Sessions.InitializeAsync();
        Assert.Equal(SignInOutcome.Success, await rig.Sessions.SignInRegisteredAsync("elara@example.test", "a-long-password-1".ToCharArray()));
        Assert.Equal(AccountLinkOutcome.Connected, (await rig.Runtime.Linking.ConnectAsync(InstallationId, "This PC", default)).Outcome);
        var claimsBefore = rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_start").Count;

        var result = await rig.Runtime.Linking.ConnectAsync(secondInstallation, "This PC", default);

        Assert.Equal(AccountLinkOutcome.Connected, result.Outcome);
        Assert.True(result.OwnershipLinked);
        Assert.Equal(account.Id, rig.Server.OwnerOf(secondInstallation));
        Assert.Equal(claimsBefore, rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_start").Count);
    }

    [Fact]
    public async Task Switching_to_an_account_that_does_not_own_the_registered_installation_keeps_public_device_sync_independent()
    {
        using var rig = new Rig();
        var anonymous = rig.SeedAnonymous();
        var firstAccount = rig.Server.AddRegisteredUser("first@example.test", "a-long-password-1");
        rig.Server.AddRegisteredUser("second@example.test", "a-long-password-2");
        rig.Server.SetOwner(InstallationId, anonymous.UserId);
        await rig.Sessions.InitializeAsync();
        Assert.Equal(SignInOutcome.Success,
            await rig.Sessions.SignInRegisteredAsync("first@example.test", "a-long-password-1".ToCharArray()));
        Assert.Equal(AccountLinkOutcome.Connected,
            (await rig.Runtime.Linking.ConnectAsync(InstallationId, "This PC", default)).Outcome);
        Assert.Equal(firstAccount.Id, rig.Server.OwnerOf(InstallationId));
        var deviceCredentialBefore = File.ReadAllBytes(rig.Runtime.Device!.Context.Store.BlobPath);

        Assert.Equal(SignOutOutcome.Confirmed, await rig.Sessions.SignOutRegisteredAsync());
        Assert.Equal(SignInOutcome.Success,
            await rig.Sessions.SignInRegisteredAsync("second@example.test", "a-long-password-2".ToCharArray()));

        var claimsBefore = rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_start").Count;
        var relink = await rig.Runtime.Linking.ConnectAsync(InstallationId, "This PC", default);
        Assert.Equal(AccountLinkOutcome.DeviceRegistrationRequired, relink.Outcome);
        Assert.False(relink.OwnershipLinked);
        Assert.Equal(claimsBefore, rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_start").Count);
        Assert.Equal(firstAccount.Id, rig.Server.OwnerOf(InstallationId));

        var path = Path.Combine(rig.Directory, "ForeverDB.lua");
        File.WriteAllText(path,
            $"ForeverDB_Export = \"H|9|0.5.0-alpha|{InstallationId}|100\\nS|creature|1|1|Wolf\"");
        var sync = new ForeverDB.Companion.Services.SyncService(
            rig.Runtime.Sync,
            device: rig.Runtime.Device!.Sync);
        var before = rig.Server.RequestsTo("/rest/v1/rpc/fdb_device_ingest").Count;

        var attempt = await sync.SyncFileAsync(
            path,
            force: true,
            trigger: ForeverDB.Companion.Services.SyncTrigger.Manual);

        Assert.Equal(SyncOutcome.Synced, attempt!.Outcome);
        Assert.Equal(InstallationOwnership.OwnedByRegisteredAccount, attempt.Ownership);
        Assert.Equal(before + 1, rig.Server.RequestsTo("/rest/v1/rpc/fdb_device_ingest").Count);
        Assert.Equal(firstAccount.Id, rig.Server.OwnerOf(InstallationId));
        Assert.Equal(InstallationId, rig.Runtime.Device.Context.Store.Read().Credential!.InstallationId);
        Assert.Equal(deviceCredentialBefore, File.ReadAllBytes(rig.Runtime.Device.Context.Store.BlobPath));
        Assert.True(File.Exists(path));
    }

    [Fact]
    public async Task Device_sync_does_not_depend_on_interactive_account_ownership_verification()
    {
        using var rig = new Rig();
        var anonymous = rig.SeedAnonymous();
        rig.Server.AddRegisteredUser("owner@example.test", "a-long-password-1");
        rig.Server.SetOwner(InstallationId, anonymous.UserId);
        await rig.Sessions.InitializeAsync();
        Assert.Equal(SignInOutcome.Success,
            await rig.Sessions.SignInRegisteredAsync("owner@example.test", "a-long-password-1".ToCharArray()));
        Assert.Equal(AccountLinkOutcome.Connected,
            (await rig.Runtime.Linking.ConnectAsync(InstallationId, "This PC", default)).Outcome);

        var path = Path.Combine(rig.Directory, "ForeverDB.lua");
        File.WriteAllText(path,
            $"ForeverDB_Export = \"H|9|0.5.0-alpha|{InstallationId}|100\\nS|creature|1|1|Wolf\"");
        var sync = new ForeverDB.Companion.Services.SyncService(
            rig.Runtime.Sync,
            device: rig.Runtime.Device!.Sync);
        var blocks = new List<SyncBlockedEventArgs>();
        sync.SyncBlocked += (_, blocked) => blocks.Add(blocked);
        var before = rig.Server.RequestsTo("/rest/v1/rpc/fdb_device_ingest").Count;
        rig.Server.Interceptor = request =>
            request.Path == "/rest/v1/rpc/fdb_installation_link_status"
                ? new FakeResponse(503, "{}")
                : null;
        rig.Runtime.Router.Invalidate(InstallationId);

        var attempt = await sync.SyncFileAsync(
            path,
            force: true,
            trigger: ForeverDB.Companion.Services.SyncTrigger.Manual);

        Assert.Equal(SyncOutcome.Synced, attempt!.Outcome);
        Assert.Equal(before + 1, rig.Server.RequestsTo("/rest/v1/rpc/fdb_device_ingest").Count);
        Assert.Empty(blocks);
    }
}
