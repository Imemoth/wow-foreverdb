using System.Text.Json;
using ForeverDB.Companion.Models;
using ForeverDB.Companion.Services;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public sealed class GuildbookAccountScopeTests
{
    private sealed class FakeAccountGuildbookRpc : IAccountGuildbookRpc
    {
        public List<AccountGuildbookCapture> Captures { get; } = new();
        public IReadOnlyList<ForeverDbGuild> ServerGuilds { get; set; } = Array.Empty<ForeverDbGuild>();
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool HoldReads { get; set; }

        public Task<RpcResult<bool>> IngestAsync(
            string accessToken,
            AccountGuildbookCapture capture,
            CancellationToken cancellationToken)
        {
            Captures.Add(capture);
            return Task.FromResult(RpcResult<bool>.Success(true, 200));
        }

        public async Task<RpcResult<IReadOnlyList<ForeverDbGuild>>> ReadAsync(
            string accessToken,
            string installationId,
            CancellationToken cancellationToken)
        {
            if (HoldReads)
            {
                Started.TrySetResult();
                await Release.Task.WaitAsync(cancellationToken);
            }

            return RpcResult<IReadOnlyList<ForeverDbGuild>>.Success(ServerGuilds, 200);
        }
    }

    [Fact]
    public async Task Anonymous_public_sync_strips_guildbook_before_the_collector_rpc()
    {
        using var rig = new Rig(accountsEnabled: false);
        var anonymous = rig.SeedAnonymous();
        rig.Runtime.Sync.SelectOwner("inst-1", OwnerChoice.AnonymousIdentity);
        var privateRpc = new FakeAccountGuildbookRpc();
        using var privateSync = new AccountGuildbookSync(rig.Runtime.Sessions, privateRpc);

        var path = Path.Combine(rig.Directory, "ForeverDB-inst-1.lua");
        File.WriteAllText(
            path,
            "ForeverDB_Export = \"H|9|0.5.0-alpha|inst-1|100|capture-a|100|Character-A\\nG|gk|Private%20Guild|Realm|100\\nC|gk|guid|Member|Rogue|ROGUE|60|Officer|1|1|Zone|0\\nS|creature|1|1|Wolf\"");

        var service = new SyncService(rig.Runtime.Sync, guildbook: privateSync);
        AccountGuildbookSyncResult? privateOutcome = null;
        service.GuildbookSyncCompleted += (_, e) => privateOutcome = e.Result;
        var result = await service.SyncFileAsync(path, force: true, trigger: SyncTrigger.Manual);

        Assert.Equal(SyncOutcome.Synced, result!.Outcome);
        var request = Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/ingest_foreverdb_snapshot_auth"));
        using var body = JsonDocument.Parse(request.Body);
        var snapshot = body.RootElement.GetProperty("p_snapshot");

        Assert.Empty(snapshot.GetProperty("guilds").EnumerateArray());
        Assert.Equal(anonymous.UserId, rig.Server.OwnerOf("inst-1"));
        Assert.Empty(privateRpc.Captures);
        Assert.NotNull(privateOutcome);
        Assert.False(privateOutcome!.Loaded);
        Assert.False(privateOutcome.CaptureAccepted);
    }

    [Fact]
    public void Schema_9_parser_reads_optional_fresh_capture_metadata_without_breaking_old_headers()
    {
        var parser = new ForeverDbExportParser();

        var old = parser.ParseExport("H|9|0.5.0-alpha|inst-1|100");
        var fresh = parser.ParseExport("H|9|0.5.0-alpha|inst-1|100|capture-a|101|Character-A");

        Assert.Null(typeof(ForeverDbSnapshot).GetProperty("GuildbookCaptureId")?.GetValue(old));
        Assert.Equal("capture-a", typeof(ForeverDbSnapshot).GetProperty("GuildbookCaptureId")?.GetValue(fresh));
        Assert.Equal(101L, typeof(ForeverDbSnapshot).GetProperty("GuildbookCapturedAt")?.GetValue(fresh));
        Assert.Equal("Character-A", typeof(ForeverDbSnapshot).GetProperty("GuildbookSourceCharacter")?.GetValue(fresh));
    }

    [Fact]
    public async Task Switch_clears_A_cache_rejects_A_capture_and_accepts_a_fresh_B_capture()
    {
        using var rig = new Rig();
        rig.SeedRegistered("a@example.test", "password-a");
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);

        var rpc = new FakeAccountGuildbookRpc
        {
            ServerGuilds = new[] { Guild("server-a") }
        };
        using var service = new AccountGuildbookSync(rig.Sessions, rpc);
        var captureBase = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 30;
        var a = Snapshot("capture-a", captureBase, "Character-A");

        await service.SyncAsync(a);
        Assert.Single(rpc.Captures);
        Assert.Equal("server-a", Assert.Single(service.CachedGuilds).Name);

        Assert.Equal(SignOutOutcome.Confirmed, await rig.Sessions.SignOutRegisteredAsync());
        Assert.Empty(service.CachedGuilds);

        var accountB = rig.Server.AddRegisteredUser("b@example.test", "password-b");
        Assert.Equal(SignInOutcome.Success, await rig.Sessions.SignInRegisteredAsync(accountB.Email!, accountB.Password!.ToCharArray()));
        rpc.ServerGuilds = new[] { Guild("server-b") };

        var serverOnly = await service.SyncAsync(Snapshot(null, 0, ""));
        Assert.False(serverOnly.CaptureAccepted);
        Assert.Equal("server-b", Assert.Single(service.CachedGuilds).Name);

        var stale = await service.SyncAsync(a);
        Assert.False(stale.CaptureAccepted);
        Assert.Equal(1, rpc.Captures.Count);
        Assert.Equal("server-b", Assert.Single(service.CachedGuilds).Name);

        var b = Snapshot("capture-b", captureBase + 1, "Character-B");
        var fresh = await service.SyncAsync(b);
        Assert.True(fresh.CaptureAccepted);
        Assert.Equal(2, rpc.Captures.Count);
    }

    [Fact]
    public async Task Identity_switch_during_account_read_cannot_repopulate_the_old_private_cache()
    {
        using var rig = new Rig();
        rig.SeedRegistered("a@example.test", "password-a");
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);

        var rpc = new FakeAccountGuildbookRpc
        {
            HoldReads = true,
            ServerGuilds = new[] { Guild("server-a") }
        };
        using var service = new AccountGuildbookSync(rig.Sessions, rpc);
        var pending = service.SyncAsync(Snapshot(null, 0, ""));
        await rpc.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Equal(SignOutOutcome.Confirmed, await rig.Sessions.SignOutRegisteredAsync());
        rpc.Release.TrySetResult();

        var result = await pending;
        Assert.True(result.Stale);
        Assert.Empty(service.CachedGuilds);
    }

    [Fact]
    public async Task Account_rpc_adapter_keeps_ingest_on_the_private_account_rpc_family()
    {
        using var rig = new Rig();
        rig.SeedRegistered("a@example.test", "password-a");
        await rig.Sessions.InitializeAsync();
        var token = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.True(token.Ok);

        rig.Server.Interceptor = request => request.Path.EndsWith(
            "/fdb_account_guildbook_ingest",
            StringComparison.Ordinal)
            ? new FakeResponse(200, "{\"ok\":true}")
            : null;

        var result = await new AccountGuildbookRpcAdapter(rig.Runtime.Rpc).IngestAsync(
            token.AccessToken,
            new AccountGuildbookCapture(
                "inst-1",
                "capture-a",
                100,
                "Character-A",
                new[] { Guild("private") }),
            default);

        Assert.True(result.Ok);
        var request = Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/fdb_account_guildbook_ingest"));
        Assert.Contains("p_capture_id", request.Body, StringComparison.Ordinal);
        Assert.Contains("p_source_character", request.Body, StringComparison.Ordinal);
        Assert.Contains("p_guilds", request.Body, StringComparison.Ordinal);
        Assert.Contains("guildKey", request.Body, StringComparison.Ordinal);
        Assert.DoesNotContain("GuildKey", request.Body, StringComparison.Ordinal);
    }

    private static ForeverDbSnapshot Snapshot(string? captureId, long capturedAt, string sourceCharacter) => new()
    {
        InstallationId = "inst-1",
        SchemaVersion = 9,
        UpdatedAt = 100,
        GuildbookCaptureId = captureId,
        GuildbookCapturedAt = capturedAt > 0 ? capturedAt : null,
        GuildbookSourceCharacter = string.IsNullOrWhiteSpace(sourceCharacter) ? null : sourceCharacter
    };

    private static ForeverDbGuild Guild(string name) => new()
    {
        GuildKey = name,
        Name = name,
        CapturedAt = 100
    };
}
