using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public class ClaimTests
{
    private static string Canonical(string display) => display.Replace("FDB-", "").Replace("-", "");

    private static async Task<(Rig Rig, AuthSession Anon, FakeSupabase.User Registered)> AnonymousOwnerAsync(bool signIn)
    {
        var rig = new Rig();
        var anon = rig.SeedAnonymous();
        var registered = rig.Server.AddRegisteredUser("elara@example.test", "a-long-password-1");
        rig.Server.SetOwner("inst-1", anon.UserId);
        await rig.Sessions.InitializeAsync();
        if (signIn)
        {
            Assert.Equal(SignInOutcome.Success, await rig.Sessions.SignInRegisteredAsync("elara@example.test", "a-long-password-1".ToCharArray()));
        }

        return (rig, anon, registered);
    }

    [Theory]
    [InlineData(false)]   // anonymous mode: the primary credential is the owner
    [InlineData(true)]    // registered mode: the preserved legacy credential is the owner
    public async Task Claim_start_uses_the_anonymous_owner_jwt_and_the_approved_request_body(bool signedIn)
    {
        var (rig, anon, registered) = await AnonymousOwnerAsync(signedIn);
        using var _ = rig;

        var result = await rig.Runtime.Claims.StartClaimAsync("inst-1", default);

        Assert.Equal(ClaimStartOutcome.Granted, result.Outcome);
        var request = Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_start"));
        var claims = JwtInspector.TryDecode(request.Bearer)!;
        Assert.Equal(anon.UserId, claims.Subject);
        Assert.True(claims.IsAnonymous);
        Assert.NotEqual(registered.Id, claims.Subject);
        Assert.Equal("{\"p_installation_id\":\"inst-1\"}", request.Body);
    }

    [Fact]
    public async Task Code_format_and_expiry_follow_the_contract()
    {
        var (rig, _, _) = await AnonymousOwnerAsync(false);
        using var _ = rig;
        var before = DateTimeOffset.UtcNow;

        var result = await rig.Runtime.Claims.StartClaimAsync("inst-1", default);
        var offer = result.Offer!;

        Assert.Matches(new Regex("^FDB(-[0-9A-F]{4}){8}$"), offer.DisplayCode);
        Assert.Equal(rig.Server.PendingClaimCode("inst-1"), Canonical(offer.DisplayCode));
        var life = offer.ExpiresAt - before;
        Assert.InRange(life, TimeSpan.FromMinutes(9), TimeSpan.FromMinutes(11));
        Assert.False(offer.IsExpired(TimeProvider.System));
        Assert.InRange(offer.Remaining(TimeProvider.System), TimeSpan.FromMinutes(9), TimeSpan.FromMinutes(10.1));
        Assert.Equal(SessionState.AnonymousClaiming, rig.Sessions.Status.State);
        Assert.Equal("ClaimOffer(redacted)", offer.ToString());
        Assert.DoesNotContain(Canonical(offer.DisplayCode), result.ToString());
    }

    [Fact]
    public async Task Claiming_state_is_entered_in_anonymous_mode_and_left_on_dismiss()
    {
        var (rig, _, _) = await AnonymousOwnerAsync(false);
        using var _ = rig;
        await rig.Runtime.Claims.StartClaimAsync("inst-1", default);
        Assert.Equal(SessionState.AnonymousClaiming, rig.Sessions.Status.State);
        Assert.True(rig.Runtime.Sync.Installations.Single().ClaimPending);

        rig.Runtime.Claims.Dismiss("inst-1");
        Assert.Equal(SessionState.Anonymous, rig.Sessions.Status.State);
        Assert.Null(rig.Runtime.Claims.OfferFor("inst-1"));
    }

    [Theory]
    [InlineData("{\"ok\":true,\"code\":\"abcdefabcdefabcdefabcdefabcdefab\",\"expires_at\":\"2030-01-01T00:00:00Z\"}")]   // lowercase
    [InlineData("{\"ok\":true,\"code\":\"ABCDEFABCDEFABCDEFABCDEFABCDEFAB\"}")]                                           // no expiry
    [InlineData("{\"ok\":true,\"code\":\"ABCDEF\",\"expires_at\":\"2030-01-01T00:00:00Z\"}")]                             // short
    [InlineData("{\"ok\":true,\"code\":\"ABCDEFABCDEFABCDEFABCDEFABCDEFAB\",\"expires_at\":\"nonsense\"}")]
    [InlineData("{\"ok\":true,\"code\":\"ABCDEFABCDEFABCDEFABCDEFABCDEFAB\",\"expires_at\":\"2030-01-01T00:00:00Z\",\"extra\":1}")]
    [InlineData("{\"ok\":false,\"error\":\"something_else\"}")]
    [InlineData("[]")]
    [InlineData("<html/>")]
    public async Task Malformed_claim_replies_are_discarded_and_nothing_is_shown(string body)
    {
        var (rig, _, _) = await AnonymousOwnerAsync(false);
        using var _ = rig;
        rig.Server.Interceptor = r => r.Path.EndsWith("fdb_account_claim_start", StringComparison.Ordinal) ? new FakeResponse(200, body) : null;

        var result = await rig.Runtime.Claims.StartClaimAsync("inst-1", default);
        Assert.Equal(ClaimStartOutcome.MalformedResponse, result.Outcome);
        Assert.Null(result.Offer);
    }

    [Fact]
    public async Task Distant_expiry_is_clamped_to_the_contractual_ten_minutes()
    {
        var (rig, _, _) = await AnonymousOwnerAsync(false);
        using var _ = rig;
        rig.Server.Interceptor = r => r.Path.EndsWith("fdb_account_claim_start", StringComparison.Ordinal)
            ? new FakeResponse(200, "{\"ok\":true,\"code\":\"ABCDEFABCDEFABCDEFABCDEFABCDEFAB\",\"expires_at\":\"" + DateTimeOffset.UtcNow.AddDays(3).ToString("o") + "\"}")
            : null;
        var result = await rig.Runtime.Claims.StartClaimAsync("inst-1", default);
        Assert.InRange(result.Offer!.ExpiresAt - DateTimeOffset.UtcNow, TimeSpan.FromMinutes(9), TimeSpan.FromMinutes(10.1));
    }

    [Fact]
    public async Task Business_rejection_is_not_available_and_not_an_error()
    {
        var (rig, _, _) = await AnonymousOwnerAsync(false);
        using var _ = rig;
        rig.Server.Interceptor = r => r.Path.EndsWith("fdb_account_claim_start", StringComparison.Ordinal)
            ? new FakeResponse(200, "{\"ok\":false,\"error\":\"not_available\"}") : null;
        var result = await rig.Runtime.Claims.StartClaimAsync("inst-1", default);
        Assert.Equal(ClaimStartOutcome.NotAvailable, result.Outcome);
        Assert.Null(result.Offer);
        Assert.Equal(SessionState.Anonymous, rig.Sessions.Status.State);
    }

    [Theory]
    [InlineData(401, ClaimStartOutcome.SessionNotAccepted)]
    [InlineData(403, ClaimStartOutcome.SessionNotAccepted)]
    [InlineData(429, ClaimStartOutcome.RateLimited)]
    [InlineData(404, ClaimStartOutcome.NotDeployed)]
    [InlineData(500, ClaimStartOutcome.OutcomeUnknown)]
    [InlineData(503, ClaimStartOutcome.OutcomeUnknown)]
    public async Task Auth_rate_limit_and_server_failures_are_handled_separately_and_never_retried(int status, ClaimStartOutcome expected)
    {
        var (rig, _, _) = await AnonymousOwnerAsync(false);
        using var _ = rig;
        rig.Server.Interceptor = r => r.Path.EndsWith("fdb_account_claim_start", StringComparison.Ordinal)
            ? new FakeResponse(status, "{\"message\":\"internal detail eyJhbGciOiJIUzI1NiJ9.e30.sig\"}") : null;

        var result = await rig.Runtime.Claims.StartClaimAsync("inst-1", default);
        Assert.Equal(expected, result.Outcome);
        Assert.Null(result.Offer);
        // Exactly one attempt: no automatic regeneration or retry loop.
        Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_start"));
        await Task.Delay(100);
        Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_start"));
    }

    [Fact]
    public async Task Network_failure_during_claim_start_is_an_unknown_outcome_without_automatic_retry()
    {
        var (rig, _, _) = await AnonymousOwnerAsync(false);
        using var _ = rig;
        rig.Handler.Before = (req, _) =>
        {
            if (req.RequestUri!.AbsolutePath.EndsWith("fdb_account_claim_start", StringComparison.Ordinal))
            {
                throw new HttpRequestException("connection reset after send");
            }

            return Task.CompletedTask;
        };

        var result = await rig.Runtime.Claims.StartClaimAsync("inst-1", default);
        Assert.Equal(ClaimStartOutcome.OutcomeUnknown, result.Outcome);
        Assert.Equal(1, rig.Handler.RequestUris.Count(u => u.AbsolutePath.EndsWith("fdb_account_claim_start", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task A_registered_only_session_can_not_start_a_claim_and_sends_nothing()
    {
        using var rig = new Rig();
        rig.SeedRegistered();
        rig.Server.SetOwner("inst-1", rig.Server.AddAnonymousUser().Id);
        await rig.Sessions.InitializeAsync();

        var result = await rig.Runtime.Claims.StartClaimAsync("inst-1", default);
        Assert.Equal(ClaimStartOutcome.NoAnonymousOwner, result.Outcome);
        Assert.Empty(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_start"));
    }

    [Fact]
    public async Task Claim_requires_the_anonymous_identity_to_actually_own_the_installation()
    {
        var (rig, _, _) = await AnonymousOwnerAsync(false);
        using var _ = rig;
        rig.Server.SetOwner("someone-elses", Guid.NewGuid().ToString());
        var result = await rig.Runtime.Claims.StartClaimAsync("someone-elses", default);
        Assert.Equal(ClaimStartOutcome.NotOwnedByAnonymousIdentity, result.Outcome);
        Assert.Empty(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_claim_start"));

        Assert.Equal(ClaimStartOutcome.InvalidInstallation, (await rig.Runtime.Claims.StartClaimAsync("bad id with spaces", default)).Outcome);
    }

    [Fact]
    public async Task Gate_closed_means_no_claim_request_at_all()
    {
        using var rig = new Rig(accountsEnabled: false);
        var anon = rig.SeedAnonymous();
        rig.Server.SetOwner("inst-1", anon.UserId);
        var result = await rig.Runtime.Claims.StartClaimAsync("inst-1", default);
        Assert.Equal(ClaimStartOutcome.FeatureDisabled, result.Outcome);
        Assert.Empty(rig.Server.Requests);
    }

    [Fact]
    public async Task A_new_claim_invalidates_the_previous_offer()
    {
        var (rig, _, _) = await AnonymousOwnerAsync(false);
        using var _ = rig;
        var first = (await rig.Runtime.Claims.StartClaimAsync("inst-1", default)).Offer!;
        var firstCode = Canonical(first.DisplayCode);
        var second = (await rig.Runtime.Claims.StartClaimAsync("inst-1", default)).Offer!;

        Assert.True(first.IsDisposed);
        Assert.Throws<ObjectDisposedException>(() => first.DisplayCode);
        Assert.NotEqual(firstCode, Canonical(second.DisplayCode));
        Assert.Equal(Canonical(second.DisplayCode), rig.Server.PendingClaimCode("inst-1"));
        Assert.False(rig.Server.Redeem(firstCode, rig.Server.AddRegisteredUser("x@y.test", "pw-pw-pw-pw-pw").Id));
    }

    [Fact]
    public async Task Transfer_is_reported_only_after_the_server_confirms_it()
    {
        var (rig, anon, registered) = await AnonymousOwnerAsync(true);
        using var _ = rig;
        var offer = (await rig.Runtime.Claims.StartClaimAsync("inst-1", default)).Offer!;

        // Claim issued but not redeemed: still owned by the anonymous identity, nothing "transferred".
        Assert.Equal(LinkCheckOutcome.StillOwnedByAnonymousIdentity, await rig.Runtime.Claims.CheckLinkStatusAsync("inst-1", default));
        Assert.Equal(InstallationOwnership.OwnedByAnonymousIdentity, rig.Runtime.Sync.Installations.Single().Ownership);
        Assert.NotNull(rig.Runtime.Claims.OfferFor("inst-1"));
        Assert.Equal(anon.UserId, rig.Server.OwnerOf("inst-1"));

        // The website redeems it: only now does the status flip, and it flips to the verified registered owner.
        Assert.True(rig.Server.Redeem(Canonical(offer.DisplayCode), registered.Id));
        Assert.Equal(LinkCheckOutcome.TransferConfirmed, await rig.Runtime.Claims.CheckLinkStatusAsync("inst-1", default));
        var record = rig.Runtime.Sync.Installations.Single();
        Assert.Equal(InstallationOwnership.OwnedByRegisteredAccount, record.Ownership);
        Assert.Equal(SlotRole.Primary, record.OwnerRole);
        Assert.False(record.ClaimPending);
        Assert.True(offer.IsDisposed);

        // The previous anonymous identity is no longer used for that installation.
        var sync = await rig.Runtime.Sync.SyncAsync("inst-1", "{\"p_snapshot\":{\"installationId\":\"inst-1\"}}", 1, false, default);
        Assert.Equal(SyncOutcome.Synced, sync.Outcome);
        Assert.Equal(registered.Id, JwtInspector.TryDecode(rig.Server.RequestsTo("/rest/v1/rpc/ingest_foreverdb_snapshot_auth").Last().Bearer)!.Subject);
    }

    [Fact]
    public async Task After_transfer_without_a_registered_session_sync_pauses_and_asks_for_sign_in_and_local_data_is_untouched()
    {
        var (rig, _, registered) = await AnonymousOwnerAsync(false);
        using var _ = rig;
        var local = Path.Combine(rig.Directory, "SavedVariables-ForeverDB.lua");
        File.WriteAllText(local, "ForeverDB_Export = \"H|9|x|inst-1|1\"");
        var localBefore = File.ReadAllBytes(local);

        var offer = (await rig.Runtime.Claims.StartClaimAsync("inst-1", default)).Offer!;
        rig.Server.Redeem(Canonical(offer.DisplayCode), registered.Id);

        Assert.Equal(LinkCheckOutcome.TransferredSignInRequired, await rig.Runtime.Claims.CheckLinkStatusAsync("inst-1", default));
        var record = rig.Runtime.Sync.Installations.Single();
        Assert.Equal(InstallationOwnership.TransferredSignInRequired, record.Ownership);
        Assert.Equal(BlockReason.TransferredSignInRequired, record.LastBlock);
        Assert.Equal(localBefore, File.ReadAllBytes(local));
        Assert.Equal(0, rig.Server.SignupCount);
        Assert.Equal(SessionState.Anonymous, rig.Sessions.Status.State);
    }

    [Fact]
    public async Task Failed_claim_does_not_delete_or_mutate_local_installation_data_or_credentials()
    {
        var (rig, _, _) = await AnonymousOwnerAsync(false);
        using var _ = rig;
        var local = Path.Combine(rig.Directory, "SavedVariables-ForeverDB.lua");
        File.WriteAllText(local, "ForeverDB_Export = \"H|9|x|inst-1|1\"");
        var before = TestEnv.ReadAllFiles(rig.Directory);
        rig.Runtime.Sync.NoteLocalInstallation("inst-1");
        var recordBefore = rig.Runtime.Sync.Installations.Single();
        rig.Server.Interceptor = r => r.Path.EndsWith("fdb_account_claim_start", StringComparison.Ordinal) ? new FakeResponse(500, "{}") : null;

        var result = await rig.Runtime.Claims.StartClaimAsync("inst-1", default);
        Assert.Equal(ClaimStartOutcome.OutcomeUnknown, result.Outcome);

        Assert.Equal(before, TestEnv.ReadAllFiles(rig.Directory));
        Assert.Equal(recordBefore.Ownership, rig.Runtime.Sync.Installations.Single().Ownership);
        Assert.False(rig.Runtime.Sync.Installations.Single().ClaimPending);
        Assert.Equal(SessionState.Anonymous, rig.Sessions.Status.State);
    }

    [Fact]
    public async Task Signing_in_while_a_code_is_displayed_wipes_the_code_with_the_identity_change()
    {
        var (rig, _, _) = await AnonymousOwnerAsync(false);
        using var _ = rig;
        var offer = (await rig.Runtime.Claims.StartClaimAsync("inst-1", default)).Offer!;
        await rig.Sessions.SignInRegisteredAsync("elara@example.test", "a-long-password-1".ToCharArray());

        Assert.True(offer.IsDisposed);
        Assert.Null(rig.Runtime.Claims.OfferFor("inst-1"));
    }

    [Fact]
    public async Task Claim_code_is_never_written_to_disk_logs_or_results()
    {
        var (rig, _, _) = await AnonymousOwnerAsync(false);
        using var _ = rig;
        var offer = (await rig.Runtime.Claims.StartClaimAsync("inst-1", default)).Offer!;
        var code = Canonical(offer.DisplayCode);

        Assert.False(TestEnv.DirectoryContains(rig.Directory, code));
        Assert.False(TestEnv.DirectoryContains(rig.Directory, offer.DisplayCode));
        Assert.DoesNotContain(code, Redaction.Scrub("code " + offer.DisplayCode + " raw " + code));
        Assert.DoesNotContain(code, System.Text.Json.JsonSerializer.Serialize(rig.Runtime.Sync.Installations));
        Assert.DoesNotContain(code, System.Text.Json.JsonSerializer.Serialize(rig.Sessions.Status));
    }
}
