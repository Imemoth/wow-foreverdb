using ForeverDB.Companion.Models;
using ForeverDB.Companion.Services;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

/// <summary>
/// Regression for the existing Companion behaviour through the real (linked) SyncService, SavedVariables parser,
/// SyncHealthState and SearchRequestEpoch: manual Sync, AutoSync, startup sync, local Guildbook and Search epoch
/// semantics must not change with Account System V1.
/// </summary>
public class CompanionRegressionTests
{
    private static string WriteSavedVariables(string directory, string installationId, long updatedAt, int members = 1)
    {
        var memberLines = string.Concat(Enumerable.Range(0, members).Select(i =>
            $"\\nC|gk|guid{i}|Member{i}|Rogue|ROGUE|60|Officer|1|1|Tirisfal%20Glades|0"));
        var lua = $"ForeverDB_Export = \"H|9|0.5.0-alpha|{installationId}|{updatedAt}\\nM|1|Eastern%20Kingdoms|0|1\\nG|gk|Guild|Realm|50{memberLines}\\nS|creature|1|1|Wolf\"";
        var path = Path.Combine(directory, $"ForeverDB-{installationId}.lua");
        File.WriteAllText(path, lua);
        return path;
    }

    private static (SyncService Service, List<string> Events, List<IReadOnlyList<ForeverDbGuild>> Guilds, List<BlockReason> Blocks, List<int> Maps)
        Wire(Rig rig)
    {
        var events = new List<string>();
        var guilds = new List<IReadOnlyList<ForeverDbGuild>>();
        var blocks = new List<BlockReason>();
        var maps = new List<int>();
        var service = new SyncService(rig.Runtime.Sync, mapSink: m => maps.Add(m.Count()));
        service.Authenticated += () => events.Add("auth");
        service.SyncCompleted += (_, e) => events.Add($"synced:{e.Trigger}:{e.SourceCount}:{e.GuildMemberCount}");
        service.GuildbookChanged += g => guilds.Add(g);
        service.SyncBlocked += (_, e) => blocks.Add(e.Reason);
        return (service, events, guilds, blocks, maps);
    }

    [Fact]
    public async Task Manual_sync_uploads_forced_and_reports_counts_with_the_manual_trigger()
    {
        using var rig = new Rig(accountsEnabled: false);   // production behaviour: anonymous primary only
        var anon = rig.SeedAnonymous();
        var (service, events, _, _, _) = Wire(rig);
        var path = WriteSavedVariables(rig.Directory, "inst-1", 100, members: 3);

        var first = await service.SyncFileAsync(path, force: true, trigger: SyncTrigger.Manual);
        var second = await service.SyncFileAsync(path, force: true, trigger: SyncTrigger.Manual);

        Assert.Equal(SyncOutcome.Synced, first!.Outcome);
        Assert.Equal(SyncOutcome.Synced, second!.Outcome);      // manual Sync always uploads
        Assert.Equal(2, rig.Server.IngestCount);
        Assert.Contains("synced:Manual:1:0", events);
        Assert.Equal(anon.UserId, rig.Server.OwnerOf("inst-1"));
    }

    [Fact]
    public async Task Startup_sync_skips_an_unchanged_snapshot_and_auto_sync_reuploads_after_a_reload()
    {
        using var rig = new Rig(accountsEnabled: false);
        rig.SeedAnonymous();
        var (service, events, _, _, _) = Wire(rig);
        var path = WriteSavedVariables(rig.Directory, "inst-1", 100);

        Assert.Equal(SyncOutcome.Synced, (await service.SyncFileAsync(path, trigger: SyncTrigger.Startup))!.Outcome);
        Assert.Equal(SyncOutcome.UpToDate, (await service.SyncFileAsync(path, trigger: SyncTrigger.Startup))!.Outcome);
        Assert.Equal(1, rig.Server.IngestCount);

        // The watcher (AutoSync) passes force:true after /reload, logout or exit.
        Assert.Equal(SyncOutcome.Synced, (await service.SyncFileAsync(path, force: true, trigger: SyncTrigger.Auto))!.Outcome);
        Assert.Contains(events, e => e.StartsWith("synced:Auto", StringComparison.Ordinal));

        WriteSavedVariables(rig.Directory, "inst-1", 101);
        Assert.Equal(SyncOutcome.Synced, (await service.SyncFileAsync(path, trigger: SyncTrigger.Startup))!.Outcome);
        Assert.Equal(3, rig.Server.IngestCount);
    }

    [Fact]
    public async Task Missing_file_is_ignored_and_malformed_files_still_throw_like_before()
    {
        using var rig = new Rig(accountsEnabled: false);
        var (service, _, _, _, _) = Wire(rig);

        Assert.Null(await service.SyncFileAsync(Path.Combine(rig.Directory, "nope.lua")));
        var bad = Path.Combine(rig.Directory, "bad.lua");
        File.WriteAllText(bad, "-- no export here");
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.SyncFileAsync(bad));
    }

    [Fact]
    public async Task Local_guildbook_and_map_metadata_work_when_remote_authentication_is_unavailable()
    {
        using var rig = new Rig();                         // nothing signed in: LoggedOut
        var (service, events, guilds, blocks, maps) = Wire(rig);
        var path = WriteSavedVariables(rig.Directory, "inst-1", 100, members: 2);
        rig.Handler.Offline = true;

        var attempt = await service.SyncFileAsync(path, force: true, trigger: SyncTrigger.Manual);

        Assert.Equal(SyncOutcome.Blocked, attempt!.Outcome);
        Assert.Equal(BlockReason.NoCredential, attempt.Reason);
        Assert.Empty(guilds);                               // the private Guildbook is unavailable anonymously/offline: local-only and account-gated
        Assert.Equal(new[] { 1 }, maps);                    // map metadata merged
        Assert.Empty(events);                               // no "synced"/"auth" claims
        Assert.Equal(new[] { BlockReason.NoCredential }, blocks);
        Assert.Empty(rig.Server.Requests);
        Assert.Equal(0, rig.Server.SignupCount);
    }

    [Fact]
    public async Task Offline_with_a_signed_in_anonymous_session_still_parses_locally_and_never_signs_up()
    {
        using var rig = new Rig(accountsEnabled: false);
        rig.SeedAnonymous(expired: true);
        rig.Handler.Offline = true;
        var (service, events, guilds, blocks, _) = Wire(rig);
        var path = WriteSavedVariables(rig.Directory, "inst-1", 100);

        var attempt = await service.SyncFileAsync(path, force: true);
        Assert.Equal(SyncOutcome.Blocked, attempt!.Outcome);
        Assert.Empty(guilds);
        Assert.Empty(events);
        Assert.Single(blocks);
        Assert.Equal(0, rig.Server.SignupCount);
    }

    [Fact]
    public async Task Stale_sync_result_does_not_raise_completion_or_repopulate_account_ui_after_switching()
    {
        using var rig = new Rig();
        var anon = rig.SeedAnonymous();
        rig.Server.SetOwner("inst-1", anon.UserId);
        rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        await rig.Sessions.InitializeAsync();
        var (service, events, _, blocks, _) = Wire(rig);
        var path = WriteSavedVariables(rig.Directory, "inst-1", 100);
        var hold = rig.Server.Hold = new FakeSupabase.IngestHold();

        var inFlight = service.SyncFileAsync(path, force: true, trigger: SyncTrigger.Manual);
        await hold.Entered;
        await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray());
        hold.Release();
        var attempt = await inFlight;

        Assert.Equal(SyncOutcome.StaleDiscarded, attempt!.Outcome);
        Assert.DoesNotContain(events, e => e.StartsWith("synced", StringComparison.Ordinal));
        Assert.Empty(blocks);
    }

    [Fact]
    public async Task Search_style_read_tokens_follow_the_identity_and_fall_back_to_the_legacy_owner_never_to_a_new_identity()
    {
        using var rig = new Rig();
        var anon = rig.SeedAnonymous();
        var registered = rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        await rig.Sessions.InitializeAsync();

        var asAnonymous = await rig.Sessions.GetReadTokenAsync();
        Assert.Equal(anon.UserId, asAnonymous.UserId);

        await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray());
        var asRegistered = await rig.Sessions.GetReadTokenAsync();
        Assert.Equal(registered.Id, asRegistered.UserId);
        Assert.NotEqual(asAnonymous.Generation, asRegistered.Generation);   // consumers can discard results of the old generation

        // Registered session becomes unusable: Search keeps working through the preserved legacy credential.
        var vault = rig.Vault();
        var primary = vault.Primary.Read().Session!;
        vault.Primary.Write(new AuthSession { AccessToken = primary.AccessToken, RefreshToken = "dead", ExpiresAt = 1, UserId = primary.UserId }, SlotMarker.For(SessionKind.Registered));
        rig.Restart();
        await rig.Sessions.InitializeAsync();
        var fallback = await rig.Sessions.GetReadTokenAsync();
        Assert.True(fallback.Ok);
        Assert.Equal(anon.UserId, fallback.UserId);
        Assert.Equal(0, rig.Server.SignupCount);
    }

    [Fact]
    public void Search_request_epoch_still_cancels_superseded_requests()
    {
        using var epoch = new SearchRequestEpoch();
        var (v1, t1) = epoch.Advance();
        var (v2, _) = epoch.Advance();
        Assert.True(t1.IsCancellationRequested);
        Assert.False(epoch.IsCurrent(v1));
        Assert.True(epoch.IsCurrent(v2));
    }

    [Fact]
    public void Sync_health_still_sanitises_secrets_and_tracks_success()
    {
        var settings = new CompanionSettings { WowRoot = @"C:\Games\WoW", SupabaseKey = "sb_publishable_abc123" };
        var health = new SyncHealthState();
        health.Configure(settings);
        Assert.True(health.ConfigurationReady);

        var msg = health.MarkError("failed Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig at C:\\Games\\WoW\\x key sb_publishable_abc123", settings);
        Assert.DoesNotContain("eyJ", msg);
        Assert.DoesNotContain("sb_publishable_abc123", msg);
        Assert.DoesNotContain(@"C:\Games", msg);

        health.MarkSyncSuccess(DateTimeOffset.Now, 3, 4, SyncTrigger.Manual);
        Assert.Equal("", health.LastError);
        Assert.Equal(SyncTrigger.Manual, health.LastTrigger);
    }
}
