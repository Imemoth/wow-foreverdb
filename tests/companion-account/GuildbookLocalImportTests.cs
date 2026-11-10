using System.Text;
using System.Runtime.Versioning;
using ForeverDB.Companion.Services;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public sealed class GuildbookLocalImportTests
{
    private const long HistoricalCapture = 1_793_994_914;

    [WindowsFact]
    [SupportedOSPlatform("windows")]
    public void Real_DPAPI_protects_installation_binding_and_cache_from_plaintext()
    {
        var root = TestEnv.NewDirectory();
        var store = new LocalGuildbookStore(Path.Combine(root, "guildbook"), new DpapiCredentialProtector());
        var fixtureDirectory = Path.Combine(root, "fixture");
        Directory.CreateDirectory(fixtureDirectory);
        var path = WriteSnapshot(fixtureDirectory, "install-private-id", HistoricalCapture, "capture-private-id");
        var snapshot = new ForeverDbExportParser().ParseSavedVariables(path);

        Assert.Equal(LocalGuildbookBindingStatus.CurrentAccount, store.TryBindToAccount("account-private-id", "install-private-id"));
        Assert.Equal(LocalGuildbookSaveStatus.Saved, store.Save("account-private-id", "install-private-id", snapshot).Status);
        Assert.False(TestEnv.DirectoryContains(store.RootDirectory, "account-private-id"));
        Assert.False(TestEnv.DirectoryContains(store.RootDirectory, "Synthetic Guild"));
        Assert.Equal(LocalGuildbookBindingStatus.BoundToAnotherAccount, new LocalGuildbookStore(store.RootDirectory, new DpapiCredentialProtector())
            .GetBindingStatus("different-account", "install-private-id"));
    }

    [Fact]
    public void Parser_preserves_one_guild_22_members_30_professions_and_member_associations()
    {
        using var rig = new Rig();
        var path = WriteSnapshot(rig.Directory, "inst-1", HistoricalCapture, "historical-a");

        var snapshot = new ForeverDbExportParser().ParseSavedVariables(path);

        Assert.Equal(9, snapshot.SchemaVersion);
        Assert.Equal("0.7.1-alpha", snapshot.AddonVersion);
        var guild = Assert.Single(snapshot.Guilds);
        Assert.Equal(22, guild.Members.Count);
        Assert.Equal(30, guild.Members.Sum(member => member.Professions.Count));
        Assert.Equal(2, guild.Members[0].Professions.Count);
        Assert.Single(guild.Members[8].Professions);
        Assert.Contains(guild.Members[0].Professions, p => p.Name == "Blacksmithing" && p.Skill == 225);
        Assert.Contains(guild.Members[0].Professions, p => p.Name == "Alchemy" && p.Skill == 171);
        Assert.Equal(HistoricalCapture, snapshot.GuildbookCapturedAt);
    }

    [Fact]
    public async Task Historical_first_import_requires_explicit_authorization_then_binds_and_saves_for_A()
    {
        using var rig = new Rig();
        var userA = rig.SeedRegistered("a@example.test", "password-a").User;
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        var store = new LocalGuildbookStore(Path.Combine(rig.Directory, "guildbook"), TestEnv.Protector());
        using var accountCache = new AccountGuildbookSync(rig.Sessions, store);
        var service = new GuildbookLocalRefreshService(accountCache);
        var path = WriteSnapshot(rig.Directory, "inst-1", HistoricalCapture, "historical-a");

        var declined = await service.RefreshAsync(new[] { path }, (_, _) => Task.FromResult(false));
        Assert.Equal(1, declined.FilesParsed);
        Assert.Equal(1, declined.ValidCaptures);
        Assert.Equal(1, declined.GuildCount);
        Assert.Equal(22, declined.MemberCount);
        Assert.Equal(30, declined.ProfessionCount);
        Assert.Equal(1, declined.RejectedByReason[GuildbookImportRejectionReason.FirstImportAuthorizationDeclined]);
        Assert.Equal(LocalGuildbookBindingStatus.Unbound, store.GetBindingStatus(userA.Id, "inst-1"));
        Assert.Empty(accountCache.CachedGuilds);

        var accepted = await service.RefreshAsync(new[] { path }, (_, _) => Task.FromResult(true));
        Assert.Equal(1, accepted.CapturesAccepted);
        Assert.Equal(1, accepted.EncryptedCachesLoaded);
        Assert.Equal(GuildbookDataSource.SavedVariables, accepted.DataSource);
        Assert.Equal(LocalGuildbookBindingStatus.CurrentAccount, store.GetBindingStatus(userA.Id, "inst-1"));
        var cachedGuild = Assert.Single(accountCache.CachedGuilds);
        Assert.Equal(22, cachedGuild.Members.Count);
        Assert.Equal(30, cachedGuild.Members.Sum(member => member.Professions.Count));
    }

    [Fact]
    public async Task Bound_A_snapshot_is_hidden_from_B_and_restored_for_A_after_restart()
    {
        using var rig = new Rig();
        var a = rig.SeedRegistered("a@example.test", "password-a").User;
        var b = rig.Server.AddRegisteredUser("b@example.test", "password-b");
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        var root = Path.Combine(rig.Directory, "guildbook");
        var store = new LocalGuildbookStore(root, TestEnv.Protector());
        using var cache = new AccountGuildbookSync(rig.Sessions, store);
        var service = new GuildbookLocalRefreshService(cache);
        var path = WriteSnapshot(rig.Directory, "inst-1", HistoricalCapture, "capture-a");
        Assert.Equal(1, (await service.RefreshAsync(new[] { path }, (_, _) => Task.FromResult(true))).CapturesAccepted);

        Assert.Equal(SignOutOutcome.Confirmed, await rig.Sessions.SignOutRegisteredAsync());
        Assert.Equal(SignInOutcome.Success, await rig.Sessions.SignInRegisteredAsync(b.Email!, b.Password!.ToCharArray()));
        var requestsBefore = rig.Server.Requests.Count;
        var prompts = 0;
        var underB = await service.RefreshAsync(new[] { path }, (_, _) => { prompts++; return Task.FromResult(true); });
        Assert.Equal(0, prompts);
        Assert.Equal(1, underB.RejectedByReason[GuildbookImportRejectionReason.BoundToAnotherAccount]);
        Assert.Equal(GuildbookDataSource.None, underB.DataSource);
        Assert.Empty(cache.CachedGuilds);
        Assert.Equal(requestsBefore, rig.Server.Requests.Count);

        rig.Restart();
        await rig.Sessions.InitializeAsync();
        using var underBRestart = new AccountGuildbookSync(rig.Sessions, store);
        await underBRestart.RestoreLocalAsync(new[] { "inst-1" });
        Assert.Empty(underBRestart.CachedGuilds);

        Assert.Equal(SignOutOutcome.Confirmed, await rig.Sessions.SignOutRegisteredAsync());
        Assert.Equal(SignInOutcome.Success, await rig.Sessions.SignInRegisteredAsync(a.Email!, "password-a".ToCharArray()));
        using var underA = new AccountGuildbookSync(rig.Sessions, store);
        var restored = await underA.RestoreLocalAsync(new[] { "inst-1" });
        Assert.Equal(new[] { "inst-1" }, restored.LoadedInstallationIds);
        Assert.Equal(22, Assert.Single(underA.CachedGuilds).Members.Count);
        Assert.Equal(30, underA.CachedGuilds.Single().Members.Sum(member => member.Professions.Count));

        rig.Restart();
        await rig.Sessions.InitializeAsync();
        using var afterARestart = new AccountGuildbookSync(rig.Sessions, store);
        var restoredAgain = await afterARestart.RestoreLocalAsync(new[] { "inst-1" });
        Assert.Equal(new[] { "inst-1" }, restoredAgain.LoadedInstallationIds);
        Assert.Equal(22, Assert.Single(afterARestart.CachedGuilds).Members.Count);
        Assert.Equal(30, afterARestart.CachedGuilds.Single().Members.Sum(member => member.Professions.Count));
    }

    [Fact]
    public async Task Repeated_refresh_is_idempotent_and_older_capture_never_replaces_newer_encrypted_snapshot()
    {
        using var rig = new Rig();
        rig.SeedRegistered("a@example.test", "password-a");
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        var cacheRoot = Path.Combine(rig.Directory, "guildbook");
        var store = new LocalGuildbookStore(cacheRoot, TestEnv.Protector());
        using var cache = new AccountGuildbookSync(rig.Sessions, store);
        var service = new GuildbookLocalRefreshService(cache);
        var newer = WriteSnapshot(rig.Directory, "inst-1", HistoricalCapture + 20, "capture-new");
        var older = WriteSnapshot(rig.Directory, "inst-1", HistoricalCapture, "capture-old");

        var first = await service.RefreshAsync(new[] { newer }, (_, _) => Task.FromResult(true));
        var repeated = await service.RefreshAsync(new[] { newer }, (_, _) => throw new Xunit.Sdk.XunitException("bound import must not prompt"));
        var stale = await service.RefreshAsync(new[] { older }, (_, _) => throw new Xunit.Sdk.XunitException("bound import must not prompt"));

        Assert.Equal(1, first.CapturesAccepted);
        Assert.Equal(0, repeated.CapturesAccepted);
        Assert.Equal(1, repeated.EncryptedCachesLoaded);
        Assert.Equal(1, stale.RejectedByReason[GuildbookImportRejectionReason.OlderThanLocalSnapshot]);
        Assert.Equal("capture-new", store.Load(rig.Sessions.Status.AccountId!, "inst-1").Snapshot!.GuildbookCaptureId);
    }

    [Fact]
    public async Task Multiple_files_for_same_installation_choose_newest_capture_deterministically()
    {
        using var rig = new Rig();
        rig.SeedRegistered("a@example.test", "password-a");
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        var store = new LocalGuildbookStore(Path.Combine(rig.Directory, "guildbook"), TestEnv.Protector());
        using var cache = new AccountGuildbookSync(rig.Sessions, store);
        var service = new GuildbookLocalRefreshService(cache);
        var older = WriteSnapshot(rig.Directory, "inst-1", HistoricalCapture, "capture-old");
        var newer = WriteSnapshot(rig.Directory, "inst-1", HistoricalCapture + 10, "capture-new");

        var result = await service.RefreshAsync(new[] { older, newer }, (_, _) => Task.FromResult(true));

        Assert.Equal(2, result.FilesParsed);
        Assert.Equal(2, result.ValidCaptures);
        Assert.Equal(1, result.CapturesAccepted);
        Assert.Equal(1, result.RejectedByReason[GuildbookImportRejectionReason.SupersededByNewerFile]);
        Assert.Equal("capture-new", store.Load(rig.Sessions.Status.AccountId!, "inst-1").Snapshot!.GuildbookCaptureId);
    }

    [Fact]
    public async Task Concurrent_refreshes_are_serialized_around_first_import_authorization()
    {
        using var rig = new Rig();
        rig.SeedRegistered("a@example.test", "password-a");
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        using var cache = new AccountGuildbookSync(rig.Sessions,
            new LocalGuildbookStore(Path.Combine(rig.Directory, "guildbook"), TestEnv.Protector()));
        var service = new GuildbookLocalRefreshService(cache);
        var path = WriteSnapshot(rig.Directory, "inst-1", HistoricalCapture, "concurrent-capture");
        var promptStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var allowImport = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var promptCount = 0;
        var first = service.RefreshAsync(new[] { path }, async (_, cancellationToken) =>
        {
            Interlocked.Increment(ref promptCount);
            promptStarted.SetResult();
            await allowImport.Task.WaitAsync(cancellationToken);
            return true;
        });
        await promptStarted.Task;
        var second = service.RefreshAsync(new[] { path }, (_, _) =>
        {
            Interlocked.Increment(ref promptCount);
            return Task.FromResult(true);
        });
        allowImport.SetResult();

        var results = await Task.WhenAll(first, second);

        Assert.Equal(1, promptCount);
        Assert.Equal(1, results.Sum(result => result.CapturesAccepted));
        Assert.Equal(22, Assert.Single(cache.CachedGuilds).Members.Count);
    }

    [Fact]
    public async Task Corrupt_missing_incomplete_and_unverified_refreshes_fail_safely_without_network()
    {
        using var rig = new Rig();
        var a = rig.SeedRegistered("a@example.test", "password-a");
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        var root = Path.Combine(rig.Directory, "guildbook");
        using var cache = new AccountGuildbookSync(rig.Sessions, new LocalGuildbookStore(root, TestEnv.Protector()));
        var service = new GuildbookLocalRefreshService(cache);
        var malformed = Path.Combine(rig.Directory, "malformed.lua");
        File.WriteAllText(malformed, "ForeverDB_Export = \"H|9|0.7.1-alpha|inst-1|broken\"");
        var incomplete = Path.Combine(rig.Directory, "incomplete.lua");
        File.WriteAllText(incomplete, "ForeverDB_Export = \"H|9|0.7.1-alpha|inst-1|1793994914\"");
        var missing = Path.Combine(rig.Directory, "missing.lua");
        var requestsBefore = rig.Server.Requests.Count;

        var failed = await service.RefreshAsync(new[] { missing, malformed, incomplete }, (_, _) => throw new Xunit.Sdk.XunitException("invalid data must never request first-import confirmation"));

        Assert.Equal(3, failed.FilesDiscovered);
        Assert.Equal(1, failed.RejectedByReason[GuildbookImportRejectionReason.MissingFile]);
        Assert.Equal(1, failed.RejectedByReason[GuildbookImportRejectionReason.MalformedOrPartialExport]);
        Assert.Equal(1, failed.RejectedByReason[GuildbookImportRejectionReason.NoGuildbookCapture]);
        Assert.Equal(requestsBefore, rig.Server.Requests.Count);
        Assert.Empty(cache.CachedGuilds);

        Assert.Equal(SignOutOutcome.Confirmed, await rig.Sessions.SignOutRegisteredAsync());
        var requestsAfterSignOut = rig.Server.Requests.Count;
        using var loggedOutCache = new AccountGuildbookSync(rig.Sessions, new LocalGuildbookStore(root, TestEnv.Protector()));
        var valid = WriteSnapshot(rig.Directory, "inst-1", HistoricalCapture, "unverified-capture");
        var noAccount = await new GuildbookLocalRefreshService(loggedOutCache).RefreshAsync(new[] { valid });
        Assert.Equal(1, noAccount.RejectedByReason[GuildbookImportRejectionReason.AccountVerificationRequired]);
        Assert.Equal(requestsAfterSignOut, rig.Server.Requests.Count);
        Assert.NotNull(a.User);
    }

    [Fact]
    public async Task Identity_change_inside_first_import_confirmation_does_not_transfer_authorization_or_publish_data()
    {
        using var rig = new Rig();
        var a = rig.SeedRegistered("a@example.test", "password-a").User;
        var b = rig.Server.AddRegisteredUser("b@example.test", "password-b");
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        var store = new LocalGuildbookStore(Path.Combine(rig.Directory, "guildbook"), TestEnv.Protector());
        using var cache = new AccountGuildbookSync(rig.Sessions, store);
        var service = new GuildbookLocalRefreshService(cache);
        var path = WriteSnapshot(rig.Directory, "inst-1", HistoricalCapture, "race-capture");

        var result = await service.RefreshAsync(new[] { path }, async (_, _) =>
        {
            Assert.Equal(SignOutOutcome.Confirmed, await rig.Sessions.SignOutRegisteredAsync());
            Assert.Equal(SignInOutcome.Success, await rig.Sessions.SignInRegisteredAsync(b.Email!, b.Password!.ToCharArray()));
            return true;
        });

        Assert.Equal(0, result.CapturesAccepted);
        Assert.Equal(1, result.RejectedByReason[GuildbookImportRejectionReason.IdentityChanged]);
        Assert.Equal(LocalGuildbookBindingStatus.Unbound, store.GetBindingStatus(a.Id, "inst-1"));
        Assert.Empty(cache.CachedGuilds);
    }

    [Fact]
    public async Task Local_refresh_has_zero_http_requests_for_authorization_rejection_and_cross_account_rejection()
    {
        using var rig = new Rig();
        var a = rig.SeedRegistered("a@example.test", "password-a").User;
        var b = rig.Server.AddRegisteredUser("b@example.test", "password-b");
        await rig.Sessions.InitializeAsync();
        Assert.True((await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary)).Ok);
        var store = new LocalGuildbookStore(Path.Combine(rig.Directory, "guildbook"), TestEnv.Protector());
        using var cache = new AccountGuildbookSync(rig.Sessions, store);
        var service = new GuildbookLocalRefreshService(cache);
        var path = WriteSnapshot(rig.Directory, "inst-1", HistoricalCapture, "capture-a");
        var requestsBefore = rig.Server.Requests.Count;

        await service.RefreshAsync(new[] { path }, (_, _) => Task.FromResult(false));
        Assert.Equal(requestsBefore, rig.Server.Requests.Count);
        await service.RefreshAsync(new[] { path }, (_, _) => Task.FromResult(true));
        Assert.Equal(SignOutOutcome.Confirmed, await rig.Sessions.SignOutRegisteredAsync());
        Assert.Equal(SignInOutcome.Success, await rig.Sessions.SignInRegisteredAsync(b.Email!, b.Password!.ToCharArray()));
        var beforeBoundRefresh = rig.Server.Requests.Count;
        await service.RefreshAsync(new[] { path }, (_, _) => throw new Xunit.Sdk.XunitException("bound A data must not prompt under B"));

        Assert.Equal(beforeBoundRefresh, rig.Server.Requests.Count);
        Assert.Equal(LocalGuildbookBindingStatus.BoundToAnotherAccount, store.GetBindingStatus(b.Id, "inst-1"));
        Assert.NotNull(a.Id);
    }

    private static string WriteSnapshot(string directory, string installationId, long capturedAt, string captureId)
    {
        var lines = new List<string>
        {
            $"H|9|0.7.1-alpha|{installationId}|{capturedAt}|{captureId}|{capturedAt}|GuildLeader",
            $"G|guild-key|Synthetic Guild|SyntheticRealm|{capturedAt}"
        };
        for (var i = 0; i < 22; i++)
            lines.Add($"C|guild-key|guid-{i:00}|Member-{i:00}|Mage|MAGE|60|Officer|1|1|Stormwind|0");
        for (var i = 0; i < 22; i++)
        {
            lines.Add($"P|guild-key|guid-{i:00}|171|Alchemy|171|300|guild|0");
            if (i < 8)
                lines.Add($"P|guild-key|guid-{i:00}|164|Blacksmithing|225|300|guild|0");
        }

        var export = string.Join("\\n", lines);
        var path = Path.Combine(directory, $"ForeverDB-{installationId}-{captureId}.lua");
        File.WriteAllText(path, $"ForeverDB_Export = \"{export}\"");
        return path;
    }
}
