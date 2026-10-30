using System.Text.Json;
using System.Text.Json.Nodes;
using ForeverDB.Companion.Models;
using ForeverDB.Companion.Services;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

/// <summary>
/// Guildbook is Companion-local only. These tests fail if ANY guild, member, profession, rank, activity or capture metadata value reaches a
/// public upload, at the serializer (explicit public DTO) AND at the transport boundary (PublicSnapshotGuard, enforced inside RpcClient and
/// DeviceRpcClient immediately before a request would be sent). Synthetic names only; they are never printed by an assertion message.
/// </summary>
public sealed class PublicPayloadBoundaryTests
{
    private const string GuildName = "Zzguild-Canary";
    private const string MemberName = "Zzmember-Canary";
    private const string MemberGuid = "Player-0-ZZCANARY";
    private const string SourceCharacter = "Zzsource-Canary";
    private static readonly string[] Canaries = { GuildName, MemberName, MemberGuid, SourceCharacter, "Zzprofession-Canary", "Zzrank-Canary", "Zzzone-Canary" };

    // ---- the guard itself ------------------------------------------------------------------------------------------------------

    private static JsonNode Node(string json) => JsonNode.Parse(json)!;

    [Fact]
    public void Guard_accepts_the_complete_public_observation_shape()
    {
        var snapshot = new ForeverDbSnapshot
        {
            SchemaVersion = 9, AddonVersion = "0.5.0-alpha", InstallationId = "inst-1", UpdatedAt = 5,
            Sources =
            {
                new ForeverDbSource
                {
                    SourceType = "creature", SourceId = 1, SourceLevel = 1, Name = "Wolf",
                    Buckets =
                    {
                        new ForeverDbBucket
                        {
                            Kind = "loot", Observations = 3,
                            Items = { new ForeverDbItem { ItemId = 2, Name = "Pelt", Drops = 1, Quantity = 1, QuestDrops = 0, QuestIds = { 7 } } },
                            Locations = { new ForeverDbLocation { MapId = 1, ZoneName = "Z", SubZoneName = "S", X = "1.0", Y = "2.0", Observations = 1 } },
                        },
                    },
                },
            },
            Maps = { new ForeverDbMap { MapId = 1, Name = "Map", ParentMapId = 0, MapArtId = 3, Layers = { new ForeverDbMapLayer { LayerIndex = 0, TextureRefs = { "t" } } } } },
        };
        var json = JsonSerializer.Serialize(new { p_snapshot = PublicObservationSnapshot.From(snapshot) }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        Assert.True(PublicSnapshotGuard.CheckBody(Node(json)).IsPublic, "a full public snapshot (every public model property populated) must pass the allowlist");
    }

    [Theory]
    [InlineData("{\"installationId\":\"i\",\"guilds\":[]}", "$.guilds")]
    [InlineData("{\"installationId\":\"i\",\"Guilds\":[]}", "$.Guilds")]
    [InlineData("{\"installationId\":\"i\",\"guildbook\":{}}", "$.guildbook")]
    [InlineData("{\"installationId\":\"i\",\"guildbookCaptureId\":\"c\"}", "$.guildbookCaptureId")]
    [InlineData("{\"installationId\":\"i\",\"guildbookCapturedAt\":1}", "$.guildbookCapturedAt")]
    [InlineData("{\"installationId\":\"i\",\"guildbookSourceCharacter\":\"x\"}", "$.guildbookSourceCharacter")]
    [InlineData("{\"installationId\":\"i\",\"sources\":[{\"name\":\"n\",\"members\":[]}]}", "$.sources[0].members")]
    [InlineData("{\"installationId\":\"i\",\"sources\":[{\"buckets\":[{\"items\":[{\"itemId\":1,\"memberName\":\"x\"}]}]}]}", "$.sources[0].buckets[0].items[0].memberName")]
    [InlineData("{\"installationId\":\"i\",\"sources\":[{\"buckets\":[{\"locations\":[{\"mapId\":1,\"professions\":[]}]}]}]}", "$.sources[0].buckets[0].locations[0].professions")]
    [InlineData("{\"installationId\":\"i\",\"maps\":[{\"mapId\":1,\"layers\":[{\"rankName\":\"x\"}]}]}", "$.maps[0].layers[0].rankName")]
    [InlineData("{\"installationId\":\"i\",\"someFutureField\":1}", "$.someFutureField")]
    public void Guard_rejects_any_key_outside_the_allowlist_at_any_depth_and_reports_only_the_path(string snapshotJson, string expectedPath)
    {
        var verdict = PublicSnapshotGuard.Check(Node(snapshotJson));
        Assert.False(verdict.IsPublic);
        Assert.Equal(expectedPath, verdict.OffendingPath);
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{\"p_snapshot\":[]}")]
    [InlineData("{\"p_snapshot\":{\"installationId\":\"i\"},\"p_extra\":1}")]
    [InlineData("{\"p_guilds\":[],\"p_snapshot\":{\"installationId\":\"i\"}}")]
    public void Guard_rejects_malformed_or_extended_bodies(string body) => Assert.False(PublicSnapshotGuard.CheckBody(Node(body)).IsPublic);

    // ---- the serializer: an explicit public projection, never the parsed snapshot ----------------------------------------------

    [Fact]
    public void Public_projection_has_exactly_the_observation_members_and_no_guildbook_member()
    {
        var names = typeof(PublicObservationSnapshot).GetProperties().Select(p => p.Name).Where(n => n != "EqualityContract").OrderBy(n => n).ToArray();
        Assert.Equal(new[] { "AddonVersion", "InstallationId", "Maps", "SchemaVersion", "Sources", "UpdatedAt" }, names);
    }

    [Fact]
    public void SyncService_never_serializes_the_parsed_snapshot_directly_and_no_source_calls_a_guildbook_rpc()
    {
        var root = RepoRoot();
        var sync = File.ReadAllText(Path.Combine(root, "companion/ForeverDB.Companion/Services/SyncService.cs"));
        Assert.DoesNotContain("p_snapshot = snapshot", sync);
        Assert.Contains("PublicObservationSnapshot.From(snapshot)", sync);
        foreach (var file in Directory.EnumerateFiles(Path.Combine(root, "companion"), "*.cs", SearchOption.AllDirectories).Where(f => !f.Contains("/obj/") && !f.Contains("\\obj\\")))
        {
            var text = File.ReadAllText(file);
            Assert.DoesNotContain("fdb_account_guildbook", text);
            Assert.DoesNotContain("installation_guild", text);
        }
    }

    // ---- real requests: anonymous / registered session path -------------------------------------------------------------------

    [Fact]
    public async Task Registered_session_upload_carries_every_observation_but_no_guildbook_value_and_stays_inside_the_allowlist()
    {
        using var rig = new Rig();
        rig.SeedRegistered("payload@example.test", "password-a");
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        var store = new LocalGuildbookStore(Path.Combine(rig.Directory, "guildbook"), TestEnv.Protector());
        using var local = new AccountGuildbookSync(rig.Sessions, store);
        rig.Runtime.Sync.SelectOwner("inst-1", OwnerChoice.RegisteredAccount);
        var service = new SyncService(rig.Runtime.Sync, guildbook: local);

        var result = await service.SyncFileAsync(WriteExport(rig.Directory), force: true, trigger: SyncTrigger.Manual);

        Assert.Equal(SyncOutcome.Synced, result!.Outcome);
        var body = Assert.Single(rig.Server.RequestsTo("/rest/v1/rpc/ingest_foreverdb_snapshot_auth")).Body;
        foreach (var canary in Canaries) Assert.DoesNotContain(canary, body, StringComparison.OrdinalIgnoreCase);
        Assert.True(PublicSnapshotGuard.CheckBody(Node(body)).IsPublic);
        Assert.Contains("Wolf", body);                                                // regular observations still upload
        Assert.Contains("\"maps\"", body);
        Assert.DoesNotContain(rig.Server.Requests, r => r.Path.Contains("guild", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(GuildName, Assert.Single(local.CachedGuilds).Name);              // ...and the Guildbook is still available locally
    }

    [Fact]
    public async Task The_transport_refuses_a_payload_with_guildbook_data_and_sends_nothing()
    {
        using var rig = new Rig();
        rig.SeedRegistered("transport@example.test", "password-a");
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        rig.Runtime.Sync.SelectOwner("inst-1", OwnerChoice.RegisteredAccount);
        var before = rig.Server.RequestsTo("/rest/v1/rpc/ingest_foreverdb_snapshot_auth").Count;

        // What the pre-fix Companion sent: the complete parsed snapshot, guilds included.
        var legacy = "{\"p_snapshot\":{\"schemaVersion\":9,\"installationId\":\"inst-1\",\"updatedAt\":5,\"sources\":[],\"maps\":[],\"guilds\":[{\"name\":\"" + GuildName + "\",\"members\":[{\"name\":\"" + MemberName + "\"}]}]}}";
        var attempt = await rig.Runtime.Sync.SyncAsync("inst-1", legacy, 5, true, default);

        Assert.NotEqual(SyncOutcome.Synced, attempt.Outcome);
        Assert.Equal(before, rig.Server.RequestsTo("/rest/v1/rpc/ingest_foreverdb_snapshot_auth").Count);
        Assert.DoesNotContain(rig.Server.Requests, r => r.Body.Contains(GuildName, StringComparison.Ordinal) || r.Body.Contains(MemberName, StringComparison.Ordinal));
    }

    // ---- Guildbook availability, outage and gating --------------------------------------------------------------------------------

    [Fact]
    public async Task A_supabase_outage_never_loses_or_blocks_the_local_guildbook()
    {
        using var rig = new Rig();
        var user = rig.SeedRegistered("outage@example.test", "password-a").User;
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        var store = new LocalGuildbookStore(Path.Combine(rig.Directory, "guildbook"), TestEnv.Protector());
        using var local = new AccountGuildbookSync(rig.Sessions, store);
        rig.Runtime.Sync.SelectOwner("inst-1", OwnerChoice.RegisteredAccount);
        var service = new SyncService(rig.Runtime.Sync, guildbook: local);

        rig.Handler.Offline = true;
        var result = await service.SyncFileAsync(WriteExport(rig.Directory), force: true, trigger: SyncTrigger.Manual);

        Assert.NotEqual(SyncOutcome.Synced, result!.Outcome);                         // the public upload failed...
        var saved = store.Load(user.Id, "inst-1").Snapshot;                           // ...the Guildbook was persisted locally anyway
        Assert.Equal(GuildName, Assert.Single(saved!.Guilds).Name);
        Assert.Equal(GuildName, Assert.Single(local.CachedGuilds).Name);
    }

    [Fact]
    public async Task Anonymous_installations_never_store_or_show_a_guildbook()
    {
        using var rig = new Rig();
        rig.SeedAnonymous();
        await rig.Sessions.InitializeAsync();
        var root = Path.Combine(rig.Directory, "guildbook");
        using var local = new AccountGuildbookSync(rig.Sessions, new LocalGuildbookStore(root, TestEnv.Protector()));
        var shown = new List<int>();
        var service = new SyncService(rig.Runtime.Sync, guildbook: local);
        service.GuildbookChanged += g => shown.Add(g.Count);

        await service.SyncFileAsync(WriteExport(rig.Directory), force: true, trigger: SyncTrigger.Manual);

        Assert.False(local.IsAvailable);
        Assert.False(Directory.Exists(root) && Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).Any());
        Assert.DoesNotContain(shown, n => n > 0);
    }

    // ---- helpers ------------------------------------------------------------------------------------------------------------------

    private static string WriteExport(string directory)
    {
        var at = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 30;
        var lua = $"ForeverDB_Export = \"H|9|0.5.0-alpha|inst-1|{at}|capture-canary|{at}|{SourceCharacter}\\n" +
                  $"M|1|Eastern%20Kingdoms|0|1\\n" +
                  $"G|gk|{GuildName}|Realm|{at}\\n" +
                  $"C|gk|{MemberGuid}|{MemberName}|Rogue|ROGUE|60|Zzrank-Canary|1|1|Zzzone-Canary|0\\n" +
                  $"P|gk|{MemberGuid}|164|Zzprofession-Canary|300|300|trainer|0\\n" +
                  $"S|creature|1|1|Wolf\"";
        var path = Path.Combine(directory, "ForeverDB-inst-1.lua");
        File.WriteAllText(path, lua);
        return path;
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "companion", "ForeverDB.Companion"))) dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("repository root not found");
    }
}
