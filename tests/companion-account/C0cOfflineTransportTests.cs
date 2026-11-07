using System.Text.Json.Nodes;
using ForeverDB.Companion.Services;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

/// <summary>
/// C0c offline acceptance preflight. The real Schema 9 parser and Companion upload
/// service send a non-empty public projection only to Rig's in-process fake server.
/// No Supabase project, live account, real SavedVariables or private identity is used.
/// This does NOT substitute for later isolated SQL/PostgREST staging read-back.
/// </summary>
public sealed class C0cOfflineTransportTests
{
    private const string Installation = "inst-1";
    private const string IngestPath = "/rest/v1/rpc/ingest_foreverdb_snapshot_auth";

    [Fact]
    public async Task Nonempty_schema9_parser_to_mock_transport_preserves_observations_and_excludes_private_data()
    {
        using var rig = new Rig();
        rig.SeedRegistered("c0c-offline@example.test", "synthetic-password");
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);

        var path = WriteSyntheticNonemptyExport(rig.Directory);
        var parsed = new ForeverDbExportParser().ParseSavedVariables(path);
        Assert.Equal(9, parsed.SchemaVersion);
        Assert.Equal("0.7.1-alpha", parsed.AddonVersion);
        Assert.Equal(Installation, parsed.InstallationId);

        var source = Assert.Single(parsed.Sources);
        Assert.Equal("creature", source.SourceType);
        Assert.Equal(164662L, source.SourceId);
        var bucket = Assert.Single(source.Buckets);
        Assert.Equal(3L, bucket.Observations);
        var item = Assert.Single(bucket.Items);
        Assert.Equal(11127L, item.ItemId);
        Assert.Equal(2L, item.Drops);
        Assert.Equal(3L, item.Quantity);
        Assert.Equal(1L, item.QuestDrops);
        Assert.Empty(item.QuestIds); // Unknown quest association: never invent a quest ID.
        var location = Assert.Single(bucket.Locations);
        Assert.Equal(1L, location.MapId);
        Assert.Equal("40.25", location.X);
        Assert.Equal("53.75", location.Y);
        Assert.Single(Assert.Single(parsed.Maps).Layers);

        var guild = Assert.Single(parsed.Guilds);
        var member = Assert.Single(guild.Members);
        Assert.Single(member.Professions);

        using var guildbook = new AccountGuildbookSync(
            rig.Sessions,
            new LocalGuildbookStore(Path.Combine(rig.Directory, "local-guildbook"), TestEnv.Protector()));
        // Explicit first-import permission also covers a valid capture from before sign-in.
        var localResult = await guildbook.ImportLocalSnapshotAsync(parsed, authorizeFirstImport: true);
        Assert.True(localResult.CaptureAccepted);
        Assert.Single(guildbook.CachedGuilds);
        Assert.Empty(rig.Server.RequestsTo(IngestPath));

        rig.Runtime.Sync.SelectOwner(Installation, OwnerChoice.RegisteredAccount);
        var service = new SyncService(rig.Runtime.Sync, guildbook: guildbook);

        var first = await service.SyncFileAsync(path, force: false, trigger: SyncTrigger.Manual);
        Assert.Equal(SyncOutcome.Synced, first!.Outcome);
        Assert.Equal(1, rig.Server.IngestCount);
        var request = Assert.Single(rig.Server.RequestsTo(IngestPath));
        var body = JsonNode.Parse(request.Body)!;
        Assert.True(PublicSnapshotGuard.CheckBody(body).IsPublic);
        var observation = body["p_snapshot"]!;
        Assert.Equal(9, observation["schemaVersion"]!.GetValue<int>());
        Assert.Equal(Installation, observation["installationId"]!.GetValue<string>());
        Assert.Single(observation["sources"]!.AsArray());
        Assert.Single(observation["maps"]!.AsArray());
        var projectedItem = observation["sources"]![0]!["buckets"]![0]!["items"]![0]!;
        Assert.Equal(1L, projectedItem["questDrops"]!.GetValue<long>());
        Assert.Empty(projectedItem["questIds"]!.AsArray());
        foreach (var privateCanary in new[]
        {
            "Zzguild-Private", "Zzmember-Private", "Player-0-ZZPRIVATE",
            "PrivateCharacterCanary", "AlchemyPrivate", "PrivateRealmCanary",
            "questJournal", "guildbookCaptureId", "guildbookCapturedAt"
        })
        {
            Assert.DoesNotContain(privateCanary, request.Body, StringComparison.OrdinalIgnoreCase);
        }

        // The Companion deduplicates a normal repeat within this account generation.
        // A forced manual resend yields an identical PUBLIC payload; whether the actual
        // SQL backend replaces rather than double-counts rows is a separate server gate.
        var repeat = await service.SyncFileAsync(path, force: false, trigger: SyncTrigger.Manual);
        Assert.Equal(SyncOutcome.UpToDate, repeat!.Outcome);
        Assert.Equal(1, rig.Server.IngestCount);
        var forced = await service.SyncFileAsync(path, force: true, trigger: SyncTrigger.Manual);
        Assert.Equal(SyncOutcome.Synced, forced!.Outcome);
        Assert.Equal(2, rig.Server.IngestCount);
        Assert.Equal(request.Body, rig.Server.RequestsTo(IngestPath)[1].Body);
        Assert.Single(guildbook.CachedGuilds);
    }

    private static string WriteSyntheticNonemptyExport(string directory)
    {
        // Entirely synthetic identifiers, private canaries and game observation
        // examples. No real player's file or registered account is involved.
        const long timestamp = 1700000001;
        var export = string.Join("\n", new[]
        {
            "H|9|0.7.1-alpha|" + Installation + "|" + timestamp + "|c0c-synthetic-capture|" + timestamp + "|PrivateCharacterCanary",
            "M|1|Tirisfal%20Glades|0|111",
            "A|1|0|1024|1024|256|256|1.0|2.0|0|synthetic-tile",
            "S|creature|164662|60|Equipment%20Boxes",
            "B|creature|164662|60|loot|3",
            "L|creature|164662|60|loot|1|Tirisfal%20Glades|Brill|40.25|53.75|3",
            "I|creature|164662|60|loot|11127|Scavenged%20Goods|2|3|1|",
            "G|guild-key|Zzguild-Private|PrivateRealmCanary|" + timestamp,
            "C|guild-key|Player-0-ZZPRIVATE|Zzmember-Private|Mage|MAGE|60|Rank|1|1|PrivateZone|0",
            "P|guild-key|Player-0-ZZPRIVATE|171|AlchemyPrivate|300|300|trainer|0"
        });
        var path = Path.Combine(directory, "ForeverDB-c0c-synthetic.lua");
        File.WriteAllText(path, "ForeverDB_Export = \"" + export.Replace("\n", "\\n") + "\"");
        return path;
    }
}
