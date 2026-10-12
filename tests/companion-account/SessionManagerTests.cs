using System.Net;
using System.Text;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public class SessionManagerTests
{
    // ---------------------------------------------------------------- upgrade from 0.8.x ----

    [Fact]
    public async Task Upgrade_from_082_keeps_the_anonymous_identity_without_any_network_call()
    {
        using var rig = new Rig(accountsEnabled: false);
        var user = rig.Server.AddAnonymousUser();
        var session = rig.Server.IssueSession(user.Id);
        rig.SeedLegacy082Session(session);

        var status = await rig.Sessions.InitializeAsync();
        Assert.Equal(SessionState.Anonymous, status.State);

        var token = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.True(token.Ok);
        Assert.Equal(user.Id, token.UserId);
        Assert.Equal(session.AccessToken, token.AccessToken);
        Assert.Empty(rig.Server.Requests);
        Assert.Equal(0, rig.Server.SignupCount);
    }

    [Fact]
    public async Task Upgrade_from_082_with_expired_token_refreshes_the_same_identity_and_persists_rotation()
    {
        using var rig = new Rig(accountsEnabled: false);
        var user = rig.Server.AddAnonymousUser();
        var session = rig.Server.IssueSession(user.Id, lifetimeSeconds: 1);
        rig.SeedLegacy082Session(session);

        var token = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.True(token.Ok);
        Assert.Equal(user.Id, token.UserId);
        Assert.NotEqual(session.AccessToken, token.AccessToken);
        Assert.Equal(0, rig.Server.SignupCount);

        // Rotation persisted: a restarted Companion holds the NEW refresh token and the marker now exists.
        var after = new SessionVault(rig.Directory, TestEnv.Protector()).Primary.Read();
        Assert.NotEqual(session.RefreshToken, after.Session!.RefreshToken);
        Assert.Equal(SessionKind.Anonymous, after.Marker!.KindValue);

        rig.Restart();
        var again = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.True(again.Ok);
        Assert.Equal(user.Id, again.UserId);
    }

    [Fact]
    public async Task Legacy_session_that_looks_registered_is_not_trusted_without_server_confirmation()
    {
        // A modified 0.8.x file claiming a permanent user: provisional kind registered, but gate closed in production.
        using var rig = new Rig(accountsEnabled: false);
        var user = rig.Server.AddRegisteredUser("x@example.test", "pw-pw-pw-pw-pw");
        rig.SeedLegacy082Session(rig.Server.IssueSession(user.Id));

        var status = await rig.Sessions.InitializeAsync();
        Assert.Equal(SessionState.ReauthRequired, status.State);
        Assert.Equal(SessionFault.FeatureDisabled, status.Fault);
        Assert.Empty(rig.Server.Requests);
    }

    [Fact]
    public async Task Registered_looking_stored_session_is_only_accepted_after_the_server_confirmed_the_account()
    {
        using var rig = new Rig();
        var (user, _) = rig.SeedRegistered();
        await rig.Sessions.InitializeAsync();
        Assert.False(rig.Sessions.Status.IdentityVerified);

        var token = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.True(token.Ok);
        Assert.Equal(SessionKind.Registered, token.Kind);
        Assert.True(rig.Sessions.Status.IdentityVerified);
        Assert.Equal(user.Email, rig.Sessions.Status.VerifiedEmail);
        Assert.Single(rig.Server.RequestsTo("/auth/v1/user"));
    }

    [Fact]
    public async Task Stored_registered_session_that_the_server_says_is_anonymous_becomes_reauth_not_anonymous()
    {
        using var rig = new Rig();
        // A permanent-looking JWT claim but the server user is anonymous.
        var anon = rig.Server.AddAnonymousUser();
        var s = rig.Server.IssueSession(anon.Id);
        var forged = new AuthSession
        {
            AccessToken = FakeSupabase.MakeJwt(new FakeSupabase.User { Id = anon.Id, Anonymous = false }, Guid.NewGuid().ToString(), s.ExpiresAt),
            RefreshToken = s.RefreshToken, ExpiresAt = s.ExpiresAt, UserId = anon.Id
        };
        rig.Vault().Primary.Write(forged, SlotMarker.For(SessionKind.Registered));

        var token = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.False(token.Ok);
        Assert.Equal(SessionState.ReauthRequired, rig.Sessions.Status.State);
        Assert.Equal(0, rig.Server.SignupCount);
    }

    // ---------------------------------------------------------------- identity loss defect ----

    [Fact]
    public async Task Offline_startup_never_replaces_the_original_anonymous_owner()
    {
        using var rig = new Rig();
        var seeded = rig.SeedAnonymous(expired: true);
        var before = TestEnv.ReadAllFiles(rig.VaultDirectory);
        rig.Handler.Offline = true;

        rig.Restart();
        await rig.Sessions.InitializeAsync();
        var token = await rig.Sessions.GetReadTokenAsync();
        Assert.False(token.Ok);
        Assert.Equal(SessionFault.NetworkUnavailable, token.Fault);
        Assert.Equal(SessionState.Anonymous, rig.Sessions.Status.State);
        Assert.Equal(SessionFault.NetworkUnavailable, rig.Sessions.Status.Fault);

        Assert.Equal(before, TestEnv.ReadAllFiles(rig.VaultDirectory));
        Assert.Equal(0, rig.Server.SignupCount);

        // Back online: the SAME identity continues.
        rig.Handler.Offline = false;
        var back = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.True(back.Ok);
        Assert.Equal(seeded.UserId, back.UserId);
        Assert.Equal(0, rig.Server.SignupCount);
    }

    [Theory]
    [InlineData(500)]
    [InlineData(502)]
    [InlineData(503)]
    [InlineData(429)]
    [InlineData(400)]   // 400 WITHOUT a GoTrue session-gone code is ambiguous, not definitive
    [InlineData(401)]
    [InlineData(403)]
    [InlineData(404)]
    public async Task Server_errors_and_ambiguous_rejections_preserve_the_credential(int status)
    {
        using var rig = new Rig();
        rig.SeedAnonymous(expired: true);
        var before = TestEnv.ReadAllFiles(rig.VaultDirectory);
        rig.Server.Interceptor = r => r.Path == "/auth/v1/token"
            ? new FakeResponse(status, "{\"error\":\"unexpected\",\"error_description\":\"something\"}")
            : null;

        var token = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.False(token.Ok);
        Assert.Equal(SessionState.Anonymous, rig.Sessions.Status.State);
        Assert.NotEqual(SessionFault.AuthRejected, token.Fault);
        Assert.Equal(before, TestEnv.ReadAllFiles(rig.VaultDirectory));
        Assert.Equal(0, rig.Server.SignupCount);
    }

    [Fact]
    public async Task Request_timeout_preserves_the_credential()
    {
        using var rig = new Rig(requestTimeout: TimeSpan.FromMilliseconds(150));
        rig.SeedAnonymous(expired: true);
        var before = TestEnv.ReadAllFiles(rig.VaultDirectory);
        rig.Handler.Before = async (_, ct) => await Task.Delay(TimeSpan.FromSeconds(5), ct);

        var token = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.False(token.Ok);
        Assert.Equal(SessionFault.NetworkUnavailable, token.Fault);
        Assert.Equal(before, TestEnv.ReadAllFiles(rig.VaultDirectory));
        Assert.Equal(0, rig.Server.SignupCount);
    }

    [Fact]
    public async Task Unparsable_success_reply_is_ambiguous_and_keeps_the_credential()
    {
        using var rig = new Rig();
        rig.SeedAnonymous(expired: true);
        var before = TestEnv.ReadAllFiles(rig.VaultDirectory);
        rig.Server.Interceptor = r => r.Path == "/auth/v1/token" ? new FakeResponse(200, "<html>captive portal</html>") : null;

        var token = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.False(token.Ok);
        Assert.Equal(before, TestEnv.ReadAllFiles(rig.VaultDirectory));
        Assert.Equal(SessionState.Anonymous, rig.Sessions.Status.State);
    }

    [Fact]
    public async Task Failed_persistence_after_remote_rotation_does_not_lose_the_identity()
    {
        var dir = TestEnv.NewDirectory();
        var server = new FakeSupabase();
        var io = new FaultyIo();
        var gate = TestEnv.StagingGate();
        var vaultDir = Path.Combine(dir, gate.CredentialSubdirectory);
        var vault = new SessionVault(vaultDir, TestEnv.Protector(), io);
        var user = server.AddAnonymousUser();
        var original = server.IssueSession(user.Id, 1);
        vault.Primary.Write(original, SlotMarker.For(SessionKind.Anonymous));

        var http = new HttpClient(new FakeHandler(server));
        var sessions = new AccountSessionManager(vault, new CrossProcessSessionGate(vaultDir), new GoTrueClient(http, gate.Endpoint!), true);

        io.FailAt = "commit";
        io.FailPathContains = "session.dat";
        var token = await sessions.GetAccessTokenAsync(SlotRole.Primary);

        // The server already rotated: we keep using the new session in memory and the old file is intact.
        Assert.True(token.Ok);
        Assert.Equal(user.Id, token.UserId);
        Assert.Equal(SessionFault.StorageFailure, sessions.Status.Fault);
        Assert.Equal(original.RefreshToken, vault.Primary.Read().Session!.RefreshToken);
        Assert.Equal(0, server.SignupCount);

        // Storage heals: the in-memory rotated session is persisted on the next call.
        io.FailAt = null;
        var next = await sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.True(next.Ok);
        Assert.NotEqual(original.RefreshToken, vault.Primary.Read().Session!.RefreshToken);
        Assert.Equal(SessionFault.None, sessions.Status.Fault);
    }

    [Fact]
    public async Task Corrupt_registered_credential_requires_reauth_and_never_creates_an_anonymous_user()
    {
        using var rig = new Rig();
        rig.SeedRegistered();
        var slot = rig.Vault().Primary;
        File.WriteAllText(slot.BlobPath, "garbage");
        File.Delete(slot.BlobPath + ".bak");

        rig.Restart();
        var status = await rig.Sessions.InitializeAsync();
        Assert.Equal(SessionState.ReauthRequired, status.State);
        Assert.Equal(SessionFault.LocalCredentialCorrupt, status.Fault);

        var token = await rig.Sessions.GetReadTokenAsync();
        Assert.False(token.Ok);
        Assert.Equal(0, rig.Server.SignupCount);
        Assert.Empty(rig.Server.Requests);

        // Explicit anonymous mode must NOT be able to replace a registered identity.
        Assert.Equal(StartAnonymousOutcome.AlreadySignedIn, await rig.Sessions.StartAnonymousAsync(confirmReplaceLostIdentity: true));
        Assert.Equal(0, rig.Server.SignupCount);
    }

    [Fact]
    public async Task Definitive_registered_refresh_rejection_is_reauth_and_never_signs_up_anonymously()
    {
        using var rig = new Rig();
        var (user, session) = rig.SeedRegistered();
        var expired = new AuthSession { AccessToken = session.AccessToken, RefreshToken = "r-revoked", ExpiresAt = 1, UserId = user.Id, Email = user.Email };
        rig.Vault().Primary.Write(expired, SlotMarker.For(SessionKind.Registered));

        var token = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.False(token.Ok);
        Assert.Equal(SessionFault.AuthRejected, token.Fault);
        Assert.Equal(SessionState.ReauthRequired, rig.Sessions.Status.State);
        Assert.Equal(0, rig.Server.SignupCount);
        // The (dead) credential is retained, flagged, not deleted.
        Assert.True(rig.Vault().Primary.Read().Marker!.Rejected);
        Assert.Equal(StartAnonymousOutcome.AlreadySignedIn, await rig.Sessions.StartAnonymousAsync(true));
    }

    [Theory]
    [InlineData("refresh_token_not_found")]
    [InlineData("refresh_token_already_used")]
    [InlineData("session_not_found")]
    [InlineData("session_expired")]
    public async Task Definitive_anonymous_rejection_is_identity_lost_and_requires_explicit_confirmation_to_replace(string code)
    {
        using var rig = new Rig();
        var seeded = rig.SeedAnonymous(expired: true);
        rig.Server.Interceptor = r => r.Path == "/auth/v1/token"
            ? new FakeResponse(400, $"{{\"code\":400,\"error_code\":\"{code}\",\"msg\":\"Invalid Refresh Token\"}}")
            : null;

        var token = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.False(token.Ok);
        Assert.Equal(SessionState.AnonymousIdentityLost, rig.Sessions.Status.State);
        Assert.Equal(0, rig.Server.SignupCount);

        // No implicit sign-up on any later call either.
        Assert.False((await rig.Sessions.GetReadTokenAsync()).Ok);
        Assert.Equal(0, rig.Server.SignupCount);

        // Explicit, confirmed replacement only; the lost credential is set aside, not deleted.
        Assert.Equal(StartAnonymousOutcome.ConfirmationRequired, await rig.Sessions.StartAnonymousAsync(false));
        Assert.Equal(0, rig.Server.SignupCount);
        rig.Server.Interceptor = null;
        Assert.Equal(StartAnonymousOutcome.Created, await rig.Sessions.StartAnonymousAsync(true));
        Assert.Equal(1, rig.Server.SignupCount);
        Assert.Equal(SessionState.Anonymous, rig.Sessions.Status.State);
        Assert.NotEqual(seeded.UserId, rig.Vault().Primary.Read().Session!.UserId);
        Assert.Single(Directory.GetFiles(rig.VaultDirectory, "session.dat.lost-*"));
    }

    [Fact]
    public async Task Legacy_invalid_grant_shape_is_definitive_only_with_the_invalid_refresh_token_description()
    {
        Assert.Equal(AuthFailureKind.SessionRejected,
            GoTrueClient.ClassifyRefreshFailure(400, "{\"error\":\"invalid_grant\",\"error_description\":\"Invalid Refresh Token: Already Used\"}").Kind);
        Assert.Equal(AuthFailureKind.Ambiguous,
            GoTrueClient.ClassifyRefreshFailure(400, "{\"error\":\"invalid_grant\",\"error_description\":\"Invalid login credentials\"}").Kind);
        Assert.Equal(AuthFailureKind.Ambiguous, GoTrueClient.ClassifyRefreshFailure(400, "").Kind);
        Assert.Equal(AuthFailureKind.Ambiguous, GoTrueClient.ClassifyRefreshFailure(401, "{\"msg\":\"no\"}").Kind);
        Assert.Equal(AuthFailureKind.Ambiguous, GoTrueClient.ClassifyRefreshFailure(400, "{\"error_code\":\"validation_failed\"}").Kind);
        Assert.Equal(AuthFailureKind.Transient, GoTrueClient.ClassifyRefreshFailure(503, "{\"error_code\":\"refresh_token_not_found\"}").Kind);
        Assert.Equal(AuthFailureKind.RateLimited, GoTrueClient.ClassifyRefreshFailure(429, "").Kind);
        // A definitive code only counts on 400/401/403.
        Assert.Equal(AuthFailureKind.Ambiguous, GoTrueClient.ClassifyRefreshFailure(418, "{\"error_code\":\"refresh_token_not_found\"}").Kind);
        await Task.CompletedTask;
    }

    [Fact]
    public async Task Already_used_after_another_process_rotated_adopts_the_new_token_instead_of_declaring_loss()
    {
        using var rig = new Rig();
        var user = rig.Server.AddAnonymousUser();
        var s1 = rig.Server.IssueSession(user.Id, 1);
        rig.Vault().Primary.Write(s1, SlotMarker.For(SessionKind.Anonymous));
        var rotatedElsewhere = (AuthSession?)null;

        // Simulate "another process rotated and persisted while we were mid-refresh": the first refresh response is
        // already-used, and storage meanwhile holds the newer rotation.
        var first = true;
        rig.Server.Interceptor = r =>
        {
            if (r.Path == "/auth/v1/token" && first)
            {
                first = false;
                var http = new HttpClient(new FakeHandler(rig.Server));
                var other = new GoTrueClient(http, rig.Runtime.Endpoint).RefreshAsync(s1.RefreshToken, CancellationToken.None).GetAwaiter().GetResult();
                rotatedElsewhere = other.Value;
                rig.Vault().Primary.Write(rotatedElsewhere!, SlotMarker.For(SessionKind.Anonymous));
                return new FakeResponse(400, "{\"error_code\":\"refresh_token_already_used\",\"msg\":\"Invalid Refresh Token: Already Used\"}");
            }

            return null;
        };

        var token = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.True(token.Ok);
        Assert.Equal(user.Id, token.UserId);
        Assert.Equal(SessionState.Anonymous, rig.Sessions.Status.State);
        Assert.Equal(0, rig.Server.SignupCount);
    }

    // ---------------------------------------------------------------- first use ----

    [Fact]
    public async Task First_use_without_a_session_creates_nothing_until_the_user_chooses()
    {
        using var rig = new Rig();
        var status = await rig.Sessions.InitializeAsync();
        Assert.Equal(SessionState.LoggedOut, status.State);

        var token = await rig.Sessions.GetReadTokenAsync();
        Assert.False(token.Ok);
        Assert.Empty(rig.Server.Requests);

        Assert.Equal(StartAnonymousOutcome.Created, await rig.Sessions.StartAnonymousAsync(false));
        Assert.Equal(SessionState.Anonymous, rig.Sessions.Status.State);
        Assert.Equal(1, rig.Server.SignupCount);
        Assert.Equal(StartAnonymousOutcome.AlreadyAnonymous, await rig.Sessions.StartAnonymousAsync(false));
        Assert.Equal(1, rig.Server.SignupCount);
    }

    [Fact]
    public async Task Missing_credential_file_after_use_never_triggers_silent_anonymous_signup()
    {
        using var rig = new Rig();
        rig.SeedAnonymous();
        File.Delete(Path.Combine(rig.VaultDirectory, "session.dat"));
        File.Delete(Path.Combine(rig.VaultDirectory, "session.dat.bak"));

        rig.Restart();
        await rig.Sessions.InitializeAsync();
        Assert.False((await rig.Sessions.GetReadTokenAsync()).Ok);
        Assert.Equal(0, rig.Server.SignupCount);
    }

    [Fact]
    public async Task Corrupt_anonymous_credential_is_identity_lost_and_is_not_replaced_silently()
    {
        using var rig = new Rig();
        rig.SeedAnonymous();
        var slot = rig.Vault().Primary;
        File.WriteAllText(slot.BlobPath, "garbage");
        File.Delete(slot.BlobPath + ".bak");

        rig.Restart();
        var status = await rig.Sessions.InitializeAsync();
        Assert.Equal(SessionState.AnonymousIdentityLost, status.State);
        Assert.Equal(SessionFault.LocalCredentialCorrupt, status.Fault);
        Assert.False((await rig.Sessions.GetReadTokenAsync()).Ok);
        Assert.Equal(0, rig.Server.SignupCount);
        Assert.Equal(StartAnonymousOutcome.ConfirmationRequired, await rig.Sessions.StartAnonymousAsync(false));
    }

    [Fact]
    public async Task Feature_gate_closed_means_no_registered_operation_reaches_the_network()
    {
        using var rig = new Rig(accountsEnabled: false);
        var outcome = await rig.Sessions.SignInRegisteredAsync("a@b.test", "pw".ToCharArray());
        Assert.Equal(SignInOutcome.FeatureDisabled, outcome);
        Assert.Equal(SignOutOutcome.FeatureDisabled, await rig.Sessions.SignOutRegisteredAsync());
        Assert.Empty(rig.Server.Requests);
    }

    // ---------------------------------------------------------------- registered sign-in ----

    [Fact]
    public async Task Registered_login_preserves_the_original_anonymous_credentials_in_the_legacy_slot()
    {
        using var rig = new Rig();
        var anon = rig.SeedAnonymous();
        var user = rig.Server.AddRegisteredUser("elara@example.test", "correct horse battery");

        var outcome = await rig.Sessions.SignInRegisteredAsync("elara@example.test", "correct horse battery".ToCharArray());
        Assert.Equal(SignInOutcome.Success, outcome);

        var status = rig.Sessions.Status;
        Assert.Equal(SessionState.Registered, status.State);
        Assert.True(status.IdentityVerified);
        Assert.Equal("elara@example.test", status.VerifiedEmail);
        Assert.True(status.HasLegacyOwner);

        var vault = rig.Vault();
        Assert.Equal(user.Id, vault.Primary.Read().Session!.UserId);
        var legacy = vault.LegacyOwner.Read();
        Assert.Equal(anon.UserId, legacy.Session!.UserId);
        Assert.Equal(anon.RefreshToken, legacy.Session.RefreshToken);
        Assert.Equal(SessionKind.Anonymous, legacy.Marker!.KindValue);
        // Identities were never merged; the anonymous session was not revoked or recreated.
        Assert.True(rig.Server.SessionAlive(anon.AccessToken));
        Assert.Equal(0, rig.Server.SignupCount);
        Assert.Single(rig.Server.RequestsTo("/auth/v1/user"));
    }

    [Fact]
    public async Task Sign_in_without_prior_session_has_no_legacy_slot()
    {
        using var rig = new Rig();
        rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        Assert.Equal(SignInOutcome.Success, await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray()));
        Assert.False(rig.Sessions.Status.HasLegacyOwner);
        Assert.Equal(0, rig.Server.SignupCount);
    }

    [Fact]
    public async Task Sign_in_uses_the_approved_password_grant_and_wipes_the_password()
    {
        using var rig = new Rig();
        rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        var pw = "a-long-password-1".ToCharArray();
        await rig.Sessions.SignInRegisteredAsync("a@b.test", pw);

        Assert.All(pw, c => Assert.Equal('\0', c));
        var grant = Assert.Single(rig.Server.RequestsTo("/auth/v1/token"));
        Assert.Equal("grant_type=password", grant.Query);
        Assert.False(TestEnv.DirectoryContains(rig.Directory, "a-long-password-1"));
    }

    [Theory]
    [InlineData(true, false, SignInOutcome.InvalidCredentials)]
    [InlineData(false, true, SignInOutcome.EmailNotConfirmed)]
    public async Task Sign_in_failures_change_nothing(bool wrongPassword, bool unconfirmed, SignInOutcome expected)
    {
        using var rig = new Rig();
        var anon = rig.SeedAnonymous();
        rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1", confirmed: !unconfirmed);
        var before = TestEnv.ReadAllFiles(rig.VaultDirectory);
        await rig.Sessions.InitializeAsync();

        var outcome = await rig.Sessions.SignInRegisteredAsync("a@b.test", (wrongPassword ? "wrong-password-xx" : "a-long-password-1").ToCharArray());
        Assert.Equal(expected, outcome);
        Assert.Equal(before, TestEnv.ReadAllFiles(rig.VaultDirectory));
        Assert.Equal(SessionState.Anonymous, rig.Sessions.Status.State);
        Assert.Equal(anon.UserId, rig.Vault().Primary.Read().Session!.UserId);
    }

    [Fact]
    public async Task Sign_in_is_rejected_when_the_server_does_not_prove_a_confirmed_non_anonymous_user()
    {
        using var rig = new Rig();
        var anon = rig.SeedAnonymous();
        var user = rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        var before = TestEnv.ReadAllFiles(rig.VaultDirectory);
        await rig.Sessions.InitializeAsync();

        // The user endpoint reports an unconfirmed email even though the grant succeeded.
        rig.Server.Interceptor = r => r.Path == "/auth/v1/user"
            ? new FakeResponse(200, $"{{\"id\":\"{user.Id}\",\"email\":\"a@b.test\",\"is_anonymous\":false}}")
            : null;
        Assert.Equal(SignInOutcome.VerificationFailed, await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray()));

        // ... or a different user id than the session's.
        rig.Server.Interceptor = r => r.Path == "/auth/v1/user"
            ? new FakeResponse(200, $"{{\"id\":\"{Guid.NewGuid()}\",\"email\":\"a@b.test\",\"is_anonymous\":false,\"email_confirmed_at\":\"2026-01-01T00:00:00Z\"}}")
            : null;
        Assert.Equal(SignInOutcome.VerificationFailed, await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray()));

        // ... or an anonymous user.
        rig.Server.Interceptor = r => r.Path == "/auth/v1/user"
            ? new FakeResponse(200, $"{{\"id\":\"{user.Id}\",\"email\":\"a@b.test\",\"is_anonymous\":true,\"email_confirmed_at\":\"2026-01-01T00:00:00Z\"}}")
            : null;
        Assert.Equal(SignInOutcome.VerificationFailed, await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray()));

        Assert.Equal(before, TestEnv.ReadAllFiles(rig.VaultDirectory));
        Assert.Equal(SessionState.Anonymous, rig.Sessions.Status.State);
        // The unaccepted sessions were revoked (scope=local) rather than left alive.
        Assert.All(rig.Server.RequestsTo("/auth/v1/logout"), r => Assert.Equal("scope=local", r.Query));
    }

    [Fact]
    public async Task Sign_in_while_registered_is_refused()
    {
        using var rig = new Rig();
        rig.SeedRegistered("a@b.test", "a-long-password-1");
        await rig.Sessions.InitializeAsync();
        Assert.Equal(SignInOutcome.AlreadySignedIn, await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray()));
    }

    [Fact]
    public async Task A_dead_registered_credential_is_replaced_by_signing_in_again_and_set_aside_not_deleted()
    {
        using var rig = new Rig();
        var anon = rig.SeedAnonymous();
        var user = rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray());

        // The registered session dies server-side and its refresh is definitively rejected.
        var vault = rig.Vault();
        var current = vault.Primary.Read().Session!;
        vault.Primary.Write(new AuthSession { AccessToken = current.AccessToken, RefreshToken = "dead", ExpiresAt = 1, UserId = current.UserId, Email = current.Email }, SlotMarker.For(SessionKind.Registered));
        Assert.False((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        Assert.Equal(SessionState.ReauthRequired, rig.Sessions.Status.State);
        Assert.Equal(anon.UserId, vault.LegacyOwner.Read().Session!.UserId);

        Assert.Equal(SignInOutcome.Success, await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray()));
        Assert.Equal(SessionState.Registered, rig.Sessions.Status.State);
        Assert.Equal(user.Id, vault.Primary.Read().Session!.UserId);
        Assert.Single(Directory.GetFiles(rig.VaultDirectory, "session.dat.lost-*"));
        // The preserved anonymous owner is still the original one.
        Assert.Equal(anon.UserId, vault.LegacyOwner.Read().Session!.UserId);
        Assert.Equal(0, rig.Server.SignupCount);
    }

    [Fact]
    public async Task Sign_in_storage_failure_keeps_the_anonymous_session_and_revokes_the_new_one()
    {
        var dir = TestEnv.NewDirectory();
        var server = new FakeSupabase();
        var gate = TestEnv.StagingGate();
        var vaultDir = Path.Combine(dir, gate.CredentialSubdirectory);
        var io = new FaultyIo();
        var vault = new SessionVault(vaultDir, TestEnv.Protector(), io);
        var anonUser = server.AddAnonymousUser();
        var anon = server.IssueSession(anonUser.Id);
        vault.Primary.Write(anon, SlotMarker.For(SessionKind.Anonymous));
        server.AddRegisteredUser("a@b.test", "a-long-password-1");
        var http = new HttpClient(new FakeHandler(server));
        var sessions = new AccountSessionManager(vault, new CrossProcessSessionGate(vaultDir), new GoTrueClient(http, gate.Endpoint!), true);

        io.FailAt = "commit";
        io.FailPathContains = "legacy-owner.dat";
        Assert.Equal(SignInOutcome.StorageFailure, await sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray()));
        Assert.Equal(anon.UserId, vault.Primary.Read().Session!.UserId);
        Assert.Equal(SlotReadStatus.Missing, vault.LegacyOwner.Read().Status);

        // Failure while writing the registered primary after the legacy copy: still recoverable.
        io.FailPathContains = "session.dat";
        Assert.Equal(SignInOutcome.StorageFailure, await sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray()));
        Assert.Equal(anon.UserId, vault.Primary.Read().Session!.UserId);

        io.FailAt = null;
        await sessions.InitializeAsync();   // heals the redundant legacy copy of the same identity
        Assert.Equal(SessionState.Anonymous, sessions.Status.State);
        Assert.Equal(SlotReadStatus.Missing, vault.LegacyOwner.Read().Status);
        Assert.Equal(0, server.SignupCount);
    }

    // ---------------------------------------------------------------- logout ----

    [Fact]
    public async Task Registered_logout_uses_scope_local_only_and_leaves_the_legacy_credential_and_website_session_intact()
    {
        using var rig = new Rig();
        var anon = rig.SeedAnonymous();
        var user = rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        var website = rig.Server.IssueSession(user.Id);   // an independent website session of the same account
        await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray());

        var outcome = await rig.Sessions.SignOutRegisteredAsync();
        Assert.Equal(SignOutOutcome.Confirmed, outcome);

        var logouts = rig.Server.RequestsTo("/auth/v1/logout");
        Assert.Single(logouts);
        Assert.Equal("scope=local", logouts[0].Query);
        Assert.True(rig.Server.SessionAlive(website.AccessToken));
        Assert.Equal(SessionState.LoggedOut, rig.Sessions.Status.State);
        Assert.False(rig.Sessions.Status.PendingRevocation);

        var legacy = rig.Vault().LegacyOwner.Read();
        Assert.Equal(anon.UserId, legacy.Session!.UserId);
        Assert.True(rig.Server.SessionAlive(anon.AccessToken));
        Assert.Equal(SlotReadStatus.Missing, rig.Vault().Primary.Read().Status);
        // Signing out never recreates an anonymous identity; explicit anonymous mode restores the ORIGINAL one.
        Assert.Equal(0, rig.Server.SignupCount);
        Assert.Equal(StartAnonymousOutcome.RestoredLegacyIdentity, await rig.Sessions.StartAnonymousAsync(false));
        Assert.Equal(anon.UserId, rig.Vault().Primary.Read().Session!.UserId);
        Assert.Equal(0, rig.Server.SignupCount);
    }

    [Fact]
    public async Task Failed_server_revocation_is_not_reported_as_confirmed_and_is_retained_for_retry()
    {
        using var rig = new Rig();
        rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray());
        var token = (await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).AccessToken;

        rig.Server.Interceptor = r => r.Path == "/auth/v1/logout" ? new FakeResponse(503, "{}") : null;
        Assert.Equal(SignOutOutcome.LocalOnlyRevocationPending, await rig.Sessions.SignOutRegisteredAsync());
        Assert.True(rig.Sessions.Status.PendingRevocation);
        Assert.Equal(SessionState.LoggedOut, rig.Sessions.Status.State);
        Assert.True(rig.Server.SessionAlive(token));   // residual remote session, honestly reported

        Assert.Equal(SignOutOutcome.LocalOnlyRevocationPending, await rig.Sessions.RetryPendingRevocationAsync());
        rig.Server.Interceptor = null;
        Assert.Equal(SignOutOutcome.Confirmed, await rig.Sessions.RetryPendingRevocationAsync());
        Assert.False(rig.Sessions.Status.PendingRevocation);
        Assert.False(rig.Server.SessionAlive(token));
        Assert.All(rig.Server.RequestsTo("/auth/v1/logout"), r => Assert.Equal("scope=local", r.Query));
    }

    [Fact]
    public async Task Logout_of_an_already_revoked_session_counts_as_confirmed()
    {
        using var rig = new Rig();
        rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray());
        var token = (await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).AccessToken;
        await new GoTrueClient(new HttpClient(new FakeHandler(rig.Server)), rig.Runtime.Endpoint).LogoutLocalAsync(token, default);

        Assert.Equal(SignOutOutcome.Confirmed, await rig.Sessions.SignOutRegisteredAsync());
    }

    // ---------------------------------------------------------------- forget legacy ----

    [Fact]
    public async Task Forgetting_the_legacy_identity_needs_explicit_confirmation_and_revokes_with_scope_local()
    {
        using var rig = new Rig();
        var anon = rig.SeedAnonymous();
        rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray());

        // Signing in never forgets it implicitly.
        Assert.True(rig.Sessions.Status.HasLegacyOwner);
        Assert.Equal(ForgetOutcome.ConfirmationRequired, await rig.Sessions.ForgetLegacyOwnerAsync(false, false));
        Assert.True(rig.Sessions.Status.HasLegacyOwner);
        Assert.True(rig.Server.SessionAlive(anon.AccessToken));

        Assert.Equal(ForgetOutcome.Revoked, await rig.Sessions.ForgetLegacyOwnerAsync(true, false));
        Assert.False(rig.Sessions.Status.HasLegacyOwner);
        Assert.False(rig.Server.SessionAlive(anon.AccessToken));
        Assert.All(rig.Server.RequestsTo("/auth/v1/logout"), r => Assert.Equal("scope=local", r.Query));
        // The registered session is untouched.
        Assert.Equal(SessionState.Registered, rig.Sessions.Status.State);
    }

    [Fact]
    public async Task Failed_revocation_of_the_legacy_identity_keeps_the_credential_unless_explicitly_discarded()
    {
        using var rig = new Rig();
        var anon = rig.SeedAnonymous();
        rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray());

        rig.Server.Interceptor = r => r.Path == "/auth/v1/logout" ? new FakeResponse(500, "{}") : null;
        Assert.Equal(ForgetOutcome.RevocationFailedKept, await rig.Sessions.ForgetLegacyOwnerAsync(true, false));
        Assert.True(rig.Sessions.Status.HasLegacyOwner);
        Assert.Equal(anon.UserId, rig.Vault().LegacyOwner.Read().Session!.UserId);

        Assert.Equal(ForgetOutcome.DiscardedUnrevoked, await rig.Sessions.ForgetLegacyOwnerAsync(true, true));
        Assert.False(rig.Sessions.Status.HasLegacyOwner);
    }

    // ---------------------------------------------------------------- identity switching ----

    [Fact]
    public async Task Identity_switches_raise_a_new_generation_and_the_event_for_cache_invalidation()
    {
        using var rig = new Rig();
        rig.SeedAnonymous();
        rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        await rig.Sessions.InitializeAsync();
        var seen = new List<long>();
        rig.Sessions.IdentityChanged += g => seen.Add(g);
        var g0 = rig.Sessions.Generation;

        await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray());
        var g1 = rig.Sessions.Generation;
        Assert.True(g1 > g0);

        await rig.Sessions.SignOutRegisteredAsync();
        Assert.True(rig.Sessions.Generation > g1);
        Assert.NotEmpty(seen);

        // A plain token refresh is NOT an identity change.
        await rig.Sessions.StartAnonymousAsync(false);
        var g2 = rig.Sessions.Generation;
        await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.Equal(g2, rig.Sessions.Generation);
    }

    [Fact]
    public async Task Lock_timeout_is_reported_without_touching_credentials()
    {
        using var rig = new Rig();
        rig.SeedAnonymous(expired: true);
        var before = TestEnv.ReadAllFiles(rig.VaultDirectory);
        var gate = new CrossProcessSessionGate(rig.VaultDirectory);
        using var held = await gate.AcquireAsync(TimeSpan.FromSeconds(5), default);
        var sessions = new AccountSessionManager(
            rig.Vault(), gate, new GoTrueClient(new HttpClient(rig.Handler), rig.Runtime.Endpoint), true, lockTimeout: TimeSpan.FromMilliseconds(200));

        var token = await sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.False(token.Ok);
        Assert.Equal(SessionFault.LockTimeout, token.Fault);
        Assert.Equal(before, TestEnv.ReadAllFiles(rig.VaultDirectory));
        Assert.Equal(0, rig.Server.SignupCount);
    }
}
