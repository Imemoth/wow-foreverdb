using System.Text.Json;
using ForeverDB.Companion.Models;
using ForeverDB.Companion.Services;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public sealed class GuildbookAccountScopeTests
{
    [Fact]
    public async Task Public_payload_contains_no_guildbook_and_no_guildbook_rpc_is_called()
    {
        using var rig = new Rig();
        rig.SeedRegistered("a@example.test", "password-a");
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        var store = new LocalGuildbookStore(Path.Combine(rig.Directory, "guildbook"), TestEnv.Protector());
        using var privateSync = new AccountGuildbookSync(rig.Sessions, store);
        rig.Runtime.Sync.SelectOwner("inst-1", OwnerChoice.RegisteredAccount);
        var service = new SyncService(rig.Runtime.Sync, guildbook: privateSync);
        var path = WriteExport(rig.Directory, Snapshot("capture-a", DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 30, "A"));

        var result = await service.SyncFileAsync(path, force: true, trigger: SyncTrigger.Manual);

        Assert.Equal(SyncOutcome.Synced, result!.Outcome);
        var request = Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/ingest_foreverdb_snapshot_auth"));
        using var body = JsonDocument.Parse(request.Body);
        Assert.False(body.RootElement.GetProperty("p_snapshot").TryGetProperty("guilds", out _));
        Assert.DoesNotContain(rig.Server.Requests, r => r.Path.Contains("guildbook", StringComparison.OrdinalIgnoreCase));
        Assert.Single(privateSync.CachedGuilds);
    }

    [Fact]
    public void Schema_9_parser_reads_optional_fresh_capture_metadata_without_breaking_old_headers()
    {
        var parser = new ForeverDbExportParser();
        var old = parser.ParseExport("H|9|0.5.0-alpha|inst-1|100");
        var fresh = parser.ParseExport("H|9|0.5.0-alpha|inst-1|100|capture-a|101|Character-A");

        Assert.Null(old.GuildbookCaptureId);
        Assert.Equal("capture-a", fresh.GuildbookCaptureId);
        Assert.Equal(101L, fresh.GuildbookCapturedAt);
        Assert.Equal("Character-A", fresh.GuildbookSourceCharacter);
    }

    [Fact]
    public async Task A_to_B_clears_memory_rejects_stale_A_and_accepts_only_a_fresh_B_capture()
    {
        using var rig = new Rig();
        var aUser = rig.SeedRegistered("a@example.test", "password-a").User;
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        var store = new LocalGuildbookStore(Path.Combine(rig.Directory, "guildbook"), TestEnv.Protector());
        using var service = new AccountGuildbookSync(rig.Sessions, store);
        var at = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 30;
        var a = Snapshot("capture-a", at, "Character-A", "A guild");

        var acceptedA = await service.SyncAsync(a);
        Assert.True(acceptedA.CaptureAccepted);
        Assert.Equal("A guild", Assert.Single(service.CachedGuilds).Name);

        Assert.Equal(SignOutOutcome.Confirmed, await rig.Sessions.SignOutRegisteredAsync());
        Assert.Empty(service.CachedGuilds);
        var b = rig.Server.AddRegisteredUser("b@example.test", "password-b");
        Assert.Equal(SignInOutcome.Success, await rig.Sessions.SignInRegisteredAsync(b.Email!, b.Password!.ToCharArray()));

        var old = await service.SyncAsync(a);
        Assert.False(old.CaptureAccepted);
        Assert.True(old.Stale);
        Assert.Empty(service.CachedGuilds);

        var acceptedB = await service.SyncAsync(Snapshot("capture-b", at + 1, "Character-B", "B guild"));
        Assert.True(acceptedB.CaptureAccepted);
        Assert.Equal("B guild", Assert.Single(service.CachedGuilds).Name);
        Assert.NotEqual(
            store.Load(aUser.Id, "inst-1").Snapshot?.Guilds.Single().Name,
            service.CachedGuilds.Single().Name);
    }

    [Fact]
    public async Task Restart_loads_encrypted_local_data_without_network_and_signout_preserves_files()
    {
        using var rig = new Rig();
        rig.SeedRegistered("a@example.test", "password-a");
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        var root = Path.Combine(rig.Directory, "guildbook");
        var store = new LocalGuildbookStore(root, TestEnv.Protector());
        using (var first = new AccountGuildbookSync(rig.Sessions, store))
            Assert.True((await first.SyncAsync(Snapshot("capture-a", DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 30, "A", "Saved"))).CaptureAccepted);

        Assert.NotEmpty(Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories));
        rig.Restart();
        await rig.Sessions.InitializeAsync();
        using var second = new AccountGuildbookSync(rig.Sessions, store);
        var loaded = await second.SyncAsync(new ForeverDbSnapshot { InstallationId = "inst-1" });
        Assert.True(loaded.Loaded);
        Assert.Equal("Saved", Assert.Single(second.CachedGuilds).Name);
        Assert.Equal(SignOutOutcome.Confirmed, await rig.Sessions.SignOutRegisteredAsync());
        Assert.NotEmpty(Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories));
    }

    [Fact]
    public void Empty_or_older_snapshot_never_replaces_the_saved_snapshot()
    {
        using var rig = new Rig();
        var store = new LocalGuildbookStore(Path.Combine(rig.Directory, "guildbook"), TestEnv.Protector());
        var newer = Snapshot("new", 200, "A", "New");
        Assert.Equal(LocalGuildbookSaveStatus.Saved, store.Save("account-a", "inst-1", newer).Status);
        Assert.Equal(LocalGuildbookSaveStatus.InvalidSnapshot, store.Save("account-a", "inst-1", new ForeverDbSnapshot { InstallationId = "inst-1" }).Status);
        Assert.Equal(LocalGuildbookSaveStatus.OlderSnapshot, store.Save("account-a", "inst-1", Snapshot("old", 100, "A", "Old")).Status);
        Assert.Equal("New", store.Load("account-a", "inst-1").Snapshot!.Guilds.Single().Name);
    }

    [Fact]
    public async Task General_export_timestamp_cannot_replace_a_fresher_guildbook_capture()
    {
        using var rig = new Rig();
        var store = new LocalGuildbookStore(Path.Combine(rig.Directory, "guildbook"), TestEnv.Protector());
        Assert.Equal(LocalGuildbookSaveStatus.Saved, store.Save("account-a", "inst-1", Snapshot("capture-a", 200, "A", "Fresh Guild")).Status);

        var staleGeneralExport = Snapshot("capture-old", 100, "A", "Old Guild");
        staleGeneralExport.UpdatedAt = 9_999;
        Assert.Equal(LocalGuildbookSaveStatus.OlderSnapshot, store.Save("account-a", "inst-1", staleGeneralExport).Status);
        Assert.Equal("Fresh Guild", store.Load("account-a", "inst-1").Snapshot!.Guilds.Single().Name);
    }

    [Fact]
    public void Corrupt_main_recovers_from_backup_and_next_save_keeps_recovery_possible()
    {
        using var rig = new Rig();
        var root = Path.Combine(rig.Directory, "guildbook");
        var store = new LocalGuildbookStore(root, TestEnv.Protector());
        Assert.Equal(LocalGuildbookSaveStatus.Saved, store.Save("account-a", "inst-1", Snapshot("capture-a", 100, "A", "A")).Status);
        Assert.Equal(LocalGuildbookSaveStatus.Saved, store.Save("account-a", "inst-1", Snapshot("capture-b", 200, "B", "B")).Status);

        var main = Directory.EnumerateFiles(root, "snapshot.dat", SearchOption.AllDirectories).Single();
        File.WriteAllText(main, "corrupt-main");
        var recovered = store.Load("account-a", "inst-1");
        Assert.True(recovered.Recovered);
        Assert.Equal("A", recovered.Snapshot!.Guilds.Single().Name);

        Assert.Equal(LocalGuildbookSaveStatus.Saved, store.Save("account-a", "inst-1", Snapshot("capture-c", 300, "C", "C")).Status);
        Assert.Equal("C", store.Load("account-a", "inst-1").Snapshot!.Guilds.Single().Name);
    }

    [Fact]
    public void Failed_save_after_recovery_does_not_turn_the_valid_backup_into_corruption()
    {
        using var rig = new Rig();
        var root = Path.Combine(rig.Directory, "guildbook");
        var io = new FaultyIo();
        var store = new LocalGuildbookStore(root, TestEnv.Protector(), io);
        Assert.Equal(LocalGuildbookSaveStatus.Saved, store.Save("account-a", "inst-1", Snapshot("capture-a", 100, "A", "A")).Status);
        Assert.Equal(LocalGuildbookSaveStatus.Saved, store.Save("account-a", "inst-1", Snapshot("capture-b", 200, "B", "B")).Status);

        var main = Directory.EnumerateFiles(root, "snapshot.dat", SearchOption.AllDirectories).Single();
        var backup = main + ".bak";
        File.WriteAllText(main, "corrupt-main");
        io.FailAt = "commit";
        Assert.Equal(LocalGuildbookSaveStatus.Failed, store.Save("account-a", "inst-1", Snapshot("capture-c", 300, "C", "C")).Status);

        File.WriteAllText(main, "corrupt-again");
        var recovered = store.Load("account-a", "inst-1");
        Assert.True(recovered.Recovered);
        Assert.Equal("A", recovered.Snapshot!.Guilds.Single().Name);
        Assert.True(File.Exists(backup));
    }

    [Fact]
    public void Corrupt_main_and_backup_fail_closed_without_overwriting_the_files()
    {
        using var rig = new Rig();
        var root = Path.Combine(rig.Directory, "guildbook");
        var store = new LocalGuildbookStore(root, TestEnv.Protector());
        Assert.Equal(LocalGuildbookSaveStatus.Saved, store.Save("account-a", "inst-1", Snapshot("capture-a", 100, "A", "A")).Status);
        Assert.Equal(LocalGuildbookSaveStatus.Saved, store.Save("account-a", "inst-1", Snapshot("capture-b", 200, "B", "B")).Status);
        foreach (var path in Directory.EnumerateFiles(root, "snapshot.dat*", SearchOption.AllDirectories)) File.WriteAllText(path, "corrupt");
        var before = Directory.EnumerateFiles(root, "snapshot.dat*", SearchOption.AllDirectories).ToDictionary(path => path, File.ReadAllBytes);

        Assert.Equal(LocalGuildbookReadStatus.Unreadable, store.Load("account-a", "inst-1").Status);
        Assert.Equal(LocalGuildbookSaveStatus.Failed, store.Save("account-a", "inst-1", Snapshot("capture-c", 300, "C", "C")).Status);
        foreach (var pair in before) Assert.Equal(pair.Value, File.ReadAllBytes(pair.Key));
    }

    [Fact]
    public async Task Local_access_requires_server_verified_registered_identity()
    {
        using var rig = new Rig();
        rig.SeedRegistered("unverified-local@example.test", "password-a");
        await rig.Sessions.InitializeAsync();
        var store = new LocalGuildbookStore(Path.Combine(rig.Directory, "guildbook"), TestEnv.Protector());
        using var service = new AccountGuildbookSync(rig.Sessions, store);
        var snapshot = Snapshot("capture-a", DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 30, "A", "A");

        Assert.False((await service.SyncAsync(snapshot)).CaptureAccepted);
        Assert.False(service.IsAvailable);
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        Assert.True((await service.SyncAsync(Snapshot("capture-b", snapshot.GuildbookCapturedAt!.Value + 1, "A", "A2"))).CaptureAccepted);
    }

    [Fact]
    public async Task Concurrent_saves_resolve_to_the_newest_capture_deterministically()
    {
        using var rig = new Rig();
        var store = new LocalGuildbookStore(Path.Combine(rig.Directory, "guildbook"), TestEnv.Protector());
        var saves = Enumerable.Range(1, 8).Select(i => Task.Run(() => store.Save(
            "account-a",
            "inst-1",
            Snapshot($"capture-{i:000}", i, "A", $"Guild {i}")))).ToArray();
        await Task.WhenAll(saves);
        Assert.Equal("Guild 8", store.Load("account-a", "inst-1").Snapshot!.Guilds.Single().Name);
    }

    private static ForeverDbSnapshot Snapshot(string captureId, long capturedAt, string source, string guildName = "Guild") => new()
    {
        InstallationId = "inst-1",
        SchemaVersion = 9,
        UpdatedAt = capturedAt,
        GuildbookCaptureId = captureId,
        GuildbookCapturedAt = capturedAt,
        GuildbookSourceCharacter = source,
        Guilds = new List<ForeverDbGuild> { new() { GuildKey = guildName, Name = guildName, CapturedAt = capturedAt } }
    };

    private static string WriteExport(string directory, ForeverDbSnapshot snapshot)
    {
        var guild = snapshot.Guilds.Single();
        var lua = $"ForeverDB_Export = \"H|9|0.5.0-alpha|{snapshot.InstallationId}|{snapshot.UpdatedAt}|{snapshot.GuildbookCaptureId}|{snapshot.GuildbookCapturedAt}|{snapshot.GuildbookSourceCharacter}\\nG|{guild.GuildKey}|{guild.Name}|Realm|{snapshot.UpdatedAt}\\nC|{guild.GuildKey}|guid|Member|Rogue|ROGUE|60|Officer|1|1|Zone|0\\nS|creature|1|1|Wolf\"";
        var path = Path.Combine(directory, "ForeverDB-inst-1.lua");
        File.WriteAllText(path, lua);
        return path;
    }
}
