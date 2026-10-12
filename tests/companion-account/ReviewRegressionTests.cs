using Xunit;

namespace ForeverDB.Companion.Account.Tests;

/// <summary>Regressions for the independent security review findings (F1..F10).</summary>
public class ReviewRegressionTests
{
    private static (AccountSessionManager Sessions, SessionVault Vault, FakeSupabase Server, FaultyIo Io, string Dir) Faulty()
    {
        var dir = TestEnv.NewDirectory();
        var server = new FakeSupabase();
        var gate = TestEnv.StagingGate();
        var vaultDir = Path.Combine(dir, gate.CredentialSubdirectory);
        var io = new FaultyIo();
        var vault = new SessionVault(vaultDir, TestEnv.Protector(), io);
        var http = new HttpClient(new FakeHandler(server));
        return (new AccountSessionManager(vault, new CrossProcessSessionGate(vaultDir), new GoTrueClient(http, gate.Endpoint!), true), vault, server, io, dir);
    }

    [Fact]
    public async Task F1_a_pending_unpersisted_rotation_never_overwrites_a_later_registered_sign_in()
    {
        var (sessions, vault, server, io, _) = Faulty();
        var anon = server.AddAnonymousUser();
        var original = server.IssueSession(anon.Id, 1);
        vault.Primary.Write(original, SlotMarker.For(SessionKind.Anonymous));
        server.AddRegisteredUser("a@b.test", "a-long-password-1");

        io.FailAt = "commit";
        io.FailPathContains = "session.dat";
        Assert.True((await sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);   // rotated remotely, held in memory only
        io.FailAt = null;

        Assert.Equal(SignInOutcome.Success, await sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray()));

        // The legacy copy is the NEWER (rotated) anonymous session, still refreshable.
        var legacy = vault.LegacyOwner.Read().Session!;
        Assert.NotEqual(original.RefreshToken, legacy.RefreshToken);
        var client = new GoTrueClient(new HttpClient(new FakeHandler(server)), TestEnv.StagingGate().Endpoint!);
        Assert.True((await client.RefreshAsync(legacy.RefreshToken, default)).Ok);

        // And the registered session is not downgraded by the stale pending session.
        var token = await sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.True(token.Ok);
        Assert.Equal(SessionKind.Registered, token.Kind);
        Assert.Equal(SessionKind.Registered, vault.Primary.Read().ProvisionalKind);
    }

    [Fact]
    public async Task F1_a_pending_session_made_stale_by_another_process_is_dropped()
    {
        var (sessions, vault, server, io, _) = Faulty();
        var anon = server.AddAnonymousUser();
        vault.Primary.Write(server.IssueSession(anon.Id, 1), SlotMarker.For(SessionKind.Anonymous));
        io.FailAt = "commit";
        io.FailPathContains = "session.dat";
        await sessions.GetAccessTokenAsync(SlotRole.Primary);
        io.FailAt = null;

        // "Another process" stores a different identity.
        var reg = server.AddRegisteredUser("a@b.test", "a-long-password-1");
        var regSession = server.IssueSession(reg.Id);
        vault.Primary.Write(regSession, SlotMarker.For(SessionKind.Registered));

        var token = await sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.True(token.Ok);
        Assert.Equal(reg.Id, token.UserId);
        Assert.Equal(reg.Id, vault.Primary.Read().Session!.UserId);
    }

    [Fact]
    public async Task F2_bad_jwt_from_clock_skew_does_not_mark_a_live_session_rejected_or_confirm_a_logout()
    {
        using var rig = new Rig();
        rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray());
        var token = (await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).AccessToken;

        // The server says bad_jwt for the first calls with this token (our clock thinks it is valid).
        rig.Restart();
        var calls = 0;
        rig.Server.Interceptor = r =>
            (r.Path == "/auth/v1/user" || r.Path == "/auth/v1/logout") && r.Bearer == token && calls++ < 1
                ? new FakeResponse(401, "{\"error_code\":\"bad_jwt\"}") : null;
        var verify = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.False(verify.Ok);
        Assert.NotEqual(SessionState.ReauthRequired, rig.Sessions.Status.State);
        Assert.False(rig.Vault().Primary.Read().Marker!.Rejected);

        // Logout with a persistent bad_jwt is never "Confirmed".
        rig.Server.Interceptor = r => r.Path == "/auth/v1/logout" ? new FakeResponse(401, "{\"error_code\":\"bad_jwt\"}") : null;
        rig.Restart();
        rig.Server.Interceptor = null;
        await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        rig.Server.Interceptor = r => r.Path == "/auth/v1/logout" ? new FakeResponse(401, "{\"error_code\":\"bad_jwt\"}") : null;
        Assert.Equal(SignOutOutcome.LocalOnlyRevocationPending, await rig.Sessions.SignOutRegisteredAsync());
        Assert.True(rig.Server.SessionAlive(token));
    }

    [Fact]
    public void F3_a_busy_main_file_never_falls_back_to_the_previous_backup()
    {
        var dir = TestEnv.NewDirectory();
        var io = new BusyIo();
        var slot = new CredentialSlot(dir, "session", TestEnv.Protector(), io);
        var uid = Guid.NewGuid().ToString();
        var user = new FakeSupabase.User { Id = uid, Anonymous = true };
        AuthSession S(string r, long e) => new() { AccessToken = FakeSupabase.MakeJwt(user, "s", e), RefreshToken = r, ExpiresAt = e, UserId = uid };
        slot.Write(S("old", 2_000_000_100), SlotMarker.For(SessionKind.Anonymous));
        slot.Write(S("new", 2_000_000_200), SlotMarker.For(SessionKind.Anonymous));   // "old" is now the backup

        io.BusyPath = slot.BlobPath;
        var read = slot.Read();
        Assert.Equal(SlotReadStatus.IoError, read.Status);
        Assert.False(slot.Repair());
        io.BusyPath = null;
        Assert.Equal("new", slot.Read().Session!.RefreshToken);
    }

    private sealed class BusyIo : ISlotIo
    {
        private readonly PhysicalSlotIo _inner = new();
        public string? BusyPath { get; set; }
        public bool Exists(string path) => _inner.Exists(path);
        public byte[] ReadAllBytes(string path) => path == BusyPath ? throw new IOException("sharing violation") : _inner.ReadAllBytes(path);
        public void WriteDurable(string path, byte[] content) => _inner.WriteDurable(path, content);
        public void Commit(string t, string d, string b) => _inner.Commit(t, d, b);
        public void Move(string s, string d) => _inner.Move(s, d);
        public void Delete(string path) => _inner.Delete(path);
        public IEnumerable<string> Enumerate(string d, string p) => _inner.Enumerate(d, p);
        public void EnsureDirectory(string d) => _inner.EnsureDirectory(d);
    }

    [Fact]
    public async Task F4_a_stale_registered_marker_next_to_an_anonymous_blob_does_not_block_or_revoke()
    {
        using var rig = new Rig();
        var anon = rig.SeedAnonymous();
        rig.Vault().Primary.WriteMarker(SlotMarker.For(SessionKind.Registered));
        rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");

        await rig.Sessions.InitializeAsync();
        Assert.Equal(SessionState.Anonymous, rig.Sessions.Status.State);
        // Not a registered session: sign-out does nothing to the anonymous identity.
        Assert.Equal(SignOutOutcome.NotSignedIn, await rig.Sessions.SignOutRegisteredAsync());
        Assert.True(rig.Server.SessionAlive(anon.AccessToken));
        Assert.Equal(SignInOutcome.Success, await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray()));
    }

    [Fact]
    public async Task F4_a_registered_credential_that_fails_verification_can_be_replaced_by_signing_in_again()
    {
        using var rig = new Rig();
        var unconfirmed = rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1", confirmed: true);
        rig.Vault().Primary.Write(rig.Server.IssueSession(unconfirmed.Id), SlotMarker.For(SessionKind.Registered));
        rig.Server.Interceptor = r => r.Path == "/auth/v1/user" && r.Bearer is { } b && JwtInspector.TryDecode(b)!.SessionId is { } sid && rig.Server.RequestsTo("/auth/v1/token").Count == 0
            ? new FakeResponse(200, $"{{\"id\":\"{unconfirmed.Id}\",\"email\":\"a@b.test\",\"is_anonymous\":false}}") : null;
        Assert.False((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        Assert.Equal(SessionState.ReauthRequired, rig.Sessions.Status.State);

        Assert.Equal(SignInOutcome.Success, await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray()));
        Assert.Equal(SessionState.Registered, rig.Sessions.Status.State);
    }

    [Fact]
    public async Task F5_a_busy_slot_read_does_not_raise_an_identity_change()
    {
        var dir = TestEnv.NewDirectory();
        var gate = TestEnv.StagingGate();
        var vaultDir = Path.Combine(dir, gate.CredentialSubdirectory);
        var io = new BusyIo();
        var server = new FakeSupabase();
        var vault = new SessionVault(vaultDir, TestEnv.Protector(), io);
        vault.Primary.Write(server.IssueSession(server.AddAnonymousUser().Id), SlotMarker.For(SessionKind.Anonymous));
        var sessions = new AccountSessionManager(vault, new CrossProcessSessionGate(vaultDir), new GoTrueClient(new HttpClient(new FakeHandler(server)), gate.Endpoint!), true);
        await sessions.InitializeAsync();
        var g = sessions.Generation;

        io.BusyPath = vault.Primary.BlobPath;
        sessions.SetClaimPending(true);
        sessions.SetClaimPending(false);
        io.BusyPath = null;
        sessions.SetClaimPending(false);
        Assert.Equal(g, sessions.Generation);
    }

    [Fact]
    public async Task F6_logout_failure_after_a_rotating_refresh_keeps_the_rotated_session_for_the_retry()
    {
        using var rig = new Rig();
        rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray());
        var vault = rig.Vault();
        var s = vault.Primary.Read().Session!;
        vault.Primary.Write(new AuthSession { AccessToken = s.AccessToken, RefreshToken = s.RefreshToken, ExpiresAt = 1, UserId = s.UserId, Email = s.Email }, SlotMarker.For(SessionKind.Registered));

        rig.Server.Interceptor = r => r.Path == "/auth/v1/logout" ? new FakeResponse(503, "{}") : null;
        Assert.Equal(SignOutOutcome.LocalOnlyRevocationPending, await rig.Sessions.SignOutRegisteredAsync());
        rig.Server.Interceptor = null;
        Assert.Equal(SignOutOutcome.Confirmed, await rig.Sessions.RetryPendingRevocationAsync());
        Assert.False(rig.Server.SessionAlive(s.AccessToken));
    }

    [Fact]
    public async Task F8_forget_retry_and_discard_do_nothing_and_send_nothing_with_the_gate_closed()
    {
        using var rig = new Rig(accountsEnabled: false);
        var anon = rig.SeedAnonymous();
        var legacy = new SessionVault(rig.Directory, TestEnv.Protector()).LegacyOwner;
        legacy.Write(anon, SlotMarker.For(SessionKind.Anonymous));

        await rig.Sessions.ForgetLegacyOwnerAsync(true, true);
        await rig.Sessions.RetryPendingRevocationAsync();
        Assert.False(await rig.Sessions.DiscardPendingRevocationAsync(true));
        Assert.Empty(rig.Server.Requests);
        Assert.Equal(SlotReadStatus.Ok, legacy.Read().Status);
    }

    [Fact]
    public async Task F9_a_401_from_ingest_refreshes_the_same_credential_once_and_retries_once()
    {
        using var rig = new Rig();
        var anon = rig.SeedAnonymous();
        rig.Server.SetOwner("inst", anon.UserId);
        await rig.Sessions.InitializeAsync();
        var first = true;
        rig.Server.Interceptor = r =>
        {
            if (r.Path.EndsWith("ingest_foreverdb_snapshot_auth", StringComparison.Ordinal) && first)
            {
                first = false;
                return new FakeResponse(401, "{}");
            }

            return null;
        };

        var result = await rig.Runtime.Sync.SyncAsync("inst", "{\"p_snapshot\":{\"installationId\":\"inst\"}}", 1, false, default);
        Assert.Equal(SyncOutcome.Synced, result.Outcome);
        Assert.Equal(1, rig.Server.SuccessfulRefreshCount);
        Assert.Equal(0, rig.Server.SignupCount);
    }

    [Fact]
    public async Task F10_a_failing_mutex_layer_surfaces_as_a_lock_failure_not_a_crash()
    {
        var gate = new ThrowingGate();
        var vault = new SessionVault(TestEnv.NewDirectory(), TestEnv.Protector());
        var sessions = new AccountSessionManager(vault, gate, new GoTrueClient(new HttpClient(new FakeHandler(new FakeSupabase())), TestEnv.StagingGate().Endpoint!), true);
        // The real gate converts mutex failures into SessionLockTimeoutException, which every entry point handles.
        var status = await sessions.InitializeAsync();
        Assert.Equal(SessionFault.LockTimeout, status.Fault);
    }

    private sealed class ThrowingGate : ISessionGate
    {
        public Task<SessionLease> AcquireAsync(TimeSpan timeout, CancellationToken cancellationToken) => throw new SessionLockTimeoutException();
    }
}
