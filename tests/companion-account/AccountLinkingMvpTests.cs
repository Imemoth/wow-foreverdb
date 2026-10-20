using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public sealed class AccountLinkingMvpTests
{
    private const string InstallationId = "0123456789abcdef0123456789abcdef";

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
    public async Task Manual_sync_after_connection_uses_the_device_identity_and_auto_sync_stays_off()
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

        Assert.Equal(DeviceSyncOutcome.AutoSyncOff, automatic.Outcome);
        Assert.Equal(DeviceSyncOutcome.Synced, manual.Outcome);
        var ingest = Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/fdb_device_ingest").Skip(before));
        Assert.NotEqual(account.Id, JwtInspector.TryDecode(ingest.Bearer)!.Subject);
        Assert.DoesNotContain("access_token", ingest.Body, StringComparison.OrdinalIgnoreCase);
        Assert.False(AccountFeatureGate.DeviceAutoSyncApproved);
    }
}
