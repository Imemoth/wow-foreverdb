using System.Reflection;
using System.Text;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public class FeatureGateTests
{
    private static AccountGateDecision Eval(params (string Name, string Value)[] vars)
    {
        var map = vars.ToDictionary(v => v.Name, v => v.Value);
        return AccountFeatureGate.Evaluate(n => map.TryGetValue(n, out var v) ? v : null);
    }

    private const string Key = "sb_publishable_testkey";
    private const string Ref = "abcdefghijklmnopqrst";

    private static (string, string)[] Staging(string url = $"https://{Ref}.supabase.co", string key = Key, string? projectRef = Ref) =>
        new[]
        {
            (AccountFeatureGate.ModeVariable, "staging"),
            (AccountFeatureGate.UrlVariable, url),
            (AccountFeatureGate.KeyVariable, key),
            (AccountFeatureGate.ProjectRefVariable, projectRef ?? "")
        };

    [Fact]
    public void Default_configuration_keeps_account_features_off()
    {
        var d = Eval();
        Assert.False(d.AccountsEnabled);
        Assert.Equal(AccountEnvironment.ProductionAnonymousOnly, d.Environment);
        Assert.Null(d.Endpoint);
        Assert.Equal(AccountFeatureGate.ProductionAccountAuthApproved, false);
    }

    [Theory]
    [InlineData("production")]
    [InlineData("PRODUCTION")]
    [InlineData("prod")]
    [InlineData("true")]
    [InlineData("1")]
    [InlineData("enabled")]
    [InlineData("")]
    public void Production_and_unknown_modes_never_enable_accounts_whatever_else_is_set(string mode)
    {
        var d = Eval(
            (AccountFeatureGate.ModeVariable, mode),
            (AccountFeatureGate.UrlVariable, $"https://{Ref}.supabase.co"),
            (AccountFeatureGate.KeyVariable, Key),
            (AccountFeatureGate.ProjectRefVariable, Ref));
        Assert.False(d.AccountsEnabled);
    }

    [Fact]
    public void Valid_staging_configuration_enables_accounts_with_an_isolated_credential_directory()
    {
        var d = Eval(Staging());
        Assert.True(d.AccountsEnabled);
        Assert.Equal(AccountEnvironment.Staging, d.Environment);
        Assert.Equal($"https://{Ref}.supabase.co", d.Endpoint!.BaseUrl);
        Assert.Contains(Ref, d.CredentialSubdirectory);
        Assert.StartsWith("account-test", d.CredentialSubdirectory);
    }

    [Theory]
    [InlineData("https://klxhikdlfwgxurdyexdi.supabase.co", "klxhikdlfwgxurdyexdi")]   // the production project
    [InlineData("https://KLXHIKDLFWGXURDYEXDI.supabase.co", "klxhikdlfwgxurdyexdi")]
    [InlineData("http://abcdefghijklmnopqrst.supabase.co", "abcdefghijklmnopqrst")]     // not https
    [InlineData("https://abcdefghijklmnopqrst.example.com", "abcdefghijklmnopqrst")]    // not supabase.co
    [InlineData("https://abcdefghijklmnopqrst.supabase.co/rest/v1", "abcdefghijklmnopqrst")]
    [InlineData("https://user:pw@abcdefghijklmnopqrst.supabase.co", "abcdefghijklmnopqrst")]
    [InlineData("https://abcdefghijklmnopqrst.supabase.co", "otherrefotherrefotherr")]  // ref not confirmed twice
    [InlineData("https://abcdefghijklmnopqrst.supabase.co", "")]
    [InlineData("https://short.supabase.co", "short")]
    [InlineData("https://abcdefghijklmnopqrst.supabase.co?x=klxhikdlfwgxurdyexdi", "abcdefghijklmnopqrst")]
    public void Staging_rejects_production_and_malformed_endpoints(string url, string projectRef)
    {
        Assert.False(Eval(Staging(url, projectRef: projectRef)).AccountsEnabled);
    }

    [Theory]
    [InlineData("sb_secret_abcdefghijk")]
    [InlineData("not-a-key")]
    [InlineData("sb_publishable_klxhikdlfwgxurdyexdi")]
    public void Staging_rejects_secret_unknown_and_production_keys(string key)
    {
        Assert.False(Eval(Staging(key: key)).AccountsEnabled);
    }

    [Fact]
    public void Jwt_keys_must_be_the_anon_role_and_never_service_role()
    {
        static string Jwt(string role) =>
            "h." + Convert.ToBase64String(Encoding.UTF8.GetBytes($"{{\"role\":\"{role}\"}}")).TrimEnd('=').Replace('+', '-').Replace('/', '_') + ".s";
        Assert.True(Eval(Staging(key: Jwt("anon"))).AccountsEnabled);
        Assert.False(Eval(Staging(key: Jwt("service_role"))).AccountsEnabled);
    }

    [Theory]
    [InlineData("http://127.0.0.1:54321", true)]
    [InlineData("http://localhost:54321", true)]
    [InlineData("http://192.168.1.5:54321", false)]
    [InlineData("https://abcdefghijklmnopqrst.supabase.co", false)]
    [InlineData("http://klxhikdlfwgxurdyexdi.localhost:54321", false)]
    public void Local_mode_requires_a_loopback_endpoint(string url, bool expected)
    {
        var d = Eval(
            (AccountFeatureGate.ModeVariable, "local"),
            (AccountFeatureGate.UrlVariable, url),
            (AccountFeatureGate.KeyVariable, Key));
        Assert.Equal(expected, d.AccountsEnabled);
    }

    // ---------- owner-approved private project pilot (never the default) ----------

    private const string PrivateUrl = "https://klxhikdlfwgxurdyexdi.supabase.co";
    private const string PrivateKey = "sb_publishable_abcdefghijklmnopqrstuvwxyz123456";

    private static (string, string)[] PrivatePilot(string url = PrivateUrl, string key = PrivateKey, string projectRef = AccountFeatureGate.ProductionProjectRef) =>
        new[]
        {
            (AccountFeatureGate.ModeVariable, "private-pilot"),
            (AccountFeatureGate.UrlVariable, url),
            (AccountFeatureGate.KeyVariable, key),
            (AccountFeatureGate.ProjectRefVariable, projectRef)
        };

    [Fact]
    public void Owner_private_pilot_allows_only_exact_project_and_isolates_credential_vault()
    {
        Assert.True(AccountFeatureGate.PrivateProjectPilotApproved); // TEMPORARY on this DRAFT branch
        var d = Eval(PrivatePilot());
        Assert.True(d.AccountsEnabled);
        Assert.Equal(AccountEnvironment.PrivatePilot, d.Environment);
        Assert.Equal(PrivateUrl, d.Endpoint!.BaseUrl);
        Assert.Contains("account-test", d.CredentialSubdirectory);
        Assert.Contains("private-pilot", d.CredentialSubdirectory);
        Assert.False(Eval((AccountFeatureGate.ModeVariable, "production"),
            (AccountFeatureGate.UrlVariable, PrivateUrl),
            (AccountFeatureGate.KeyVariable, PrivateKey),
            (AccountFeatureGate.ProjectRefVariable, AccountFeatureGate.ProductionProjectRef)).AccountsEnabled);
        Assert.False(Eval().AccountsEnabled);
    }

    [Theory]
    [InlineData("http://klxhikdlfwgxurdyexdi.supabase.co")]
    [InlineData("https://abcdefghijklmnopqrst.supabase.co")]
    [InlineData("https://klxhikdlfwgxurdyexdi.supabase.co.evil.example")]
    [InlineData("https://klxhikdlfwgxurdyexdi.supabase.co:444")]
    [InlineData("https://klxhikdlfwgxurdyexdi.supabase.co/rest/v1")]
    [InlineData("https://klxhikdlfwgxurdyexdi.supabase.co?red=1")]
    [InlineData("https://user@klxhikdlfwgxurdyexdi.supabase.co")]
    public void Private_pilot_rejects_any_alternate_origin_path_or_scheme(string url)
    {
        Assert.False(Eval(PrivatePilot(url: url)).AccountsEnabled);
    }

    [Fact]
    public void Private_pilot_rejects_wrong_ref_or_legacy_secret_keys()
    {
        Assert.False(Eval(PrivatePilot(projectRef: Ref)).AccountsEnabled);
        Assert.False(Eval(PrivatePilot(key: "sb_secret_abcdefghijklmnopqrstuvwxyz123456")).AccountsEnabled);
        Assert.False(Eval(PrivatePilot(key: "sb_publishable_short")).AccountsEnabled);
        Assert.False(Eval(PrivatePilot(key: "eyJhbGciOiJIUzI1NiJ9.test.signature")).AccountsEnabled);
    }

    [Fact]
    public async Task Private_pilot_network_guard_allows_only_approved_https_origin()
    {
        var handler = new FakeHandler(new FakeSupabase());
        using var client = new HttpClient(new ProductionHostGuardHandler(
            handler, enforce: true, privatePilotOrigin: new Uri(PrivateUrl)));
        var ok = await client.PostAsync(PrivateUrl + "/auth/v1/token?grant_type=password", new StringContent("{}"));
        Assert.NotNull(ok);
        Assert.Single(handler.RequestUris);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            client.PostAsync("https://abcdefghijklmnopqrst.supabase.co/auth/v1/signup", new StringContent("{}")));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            client.PostAsync("http://klxhikdlfwgxurdyexdi.supabase.co/auth/v1/signup", new StringContent("{}")));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            client.PostAsync("https://klxhikdlfwgxurdyexdi.supabase.co:444/auth/v1/signup", new StringContent("{}")));
        Assert.Single(handler.RequestUris);
    }

    [Fact]
    public async Task Private_pilot_sign_in_only_has_no_ingest_claim_or_anonymous_creation()
    {
        var server = new FakeSupabase();
        server.AddRegisteredUser("owner@example.test", "new-password-with-12-chars");
        var handler = new FakeHandler(server);
        var dir = TestEnv.NewDirectory();
        var productionVault = new SessionVault(dir, TestEnv.Protector());
        var existing = server.AddAnonymousUser();
        productionVault.Primary.Write(server.IssueSession(existing.Id), SlotMarker.For(SessionKind.Anonymous));
        var originalFiles = TestEnv.ReadTopLevelFiles(dir);

        var gate = Eval(PrivatePilot());
        var runtime = AccountRuntime.Create(gate,
            new AccountEndpoint(PrivateUrl, PrivateKey, "production"),
            handler: handler, protector: TestEnv.Protector(), productionDirectory: dir);
        await runtime.Sessions.InitializeAsync();
        Assert.Equal(SessionState.LoggedOut, runtime.Sessions.Status.State);
        Assert.Equal(StartAnonymousOutcome.FeatureDisabled, await runtime.Sessions.StartAnonymousAsync(false));
        Assert.Equal(SignInOutcome.Success, await runtime.Sessions.SignInRegisteredAsync(
            "owner@example.test", "new-password-with-12-chars".ToCharArray()));

        Assert.Equal(ClaimStartOutcome.FeatureDisabled, (await runtime.Claims.StartClaimAsync("installation", default)).Outcome);
        Assert.False((await runtime.Rpc.ClaimStartAsync("not-a-token", "installation", default)).Ok);
        Assert.False((await runtime.Rpc.IngestAsync("not-a-token", "{}", default)).Ok);
        var blocked = await runtime.Sync.SyncAsync("installation", "{}", 1, true, default);
        Assert.Equal(SyncOutcome.Blocked, blocked.Outcome);
        Assert.Equal(BlockReason.FeatureDisabled, blocked.Block);

        // No Account client mutation call made by this login-only pilot.
        Assert.NotEmpty(handler.RequestUris); // only password grant and user verification
        Assert.DoesNotContain(handler.RequestUris, u =>
            u.AbsolutePath.Contains("rpc/", StringComparison.OrdinalIgnoreCase) ||
            u.AbsolutePath.Contains("signup", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(originalFiles, TestEnv.ReadTopLevelFiles(dir));
    }

    [Fact]
    public void The_gate_is_not_controllable_from_settings_json()
    {
        // settings.json (CompanionSettings) must not carry any switch, credential or session data.
        var names = typeof(CompanionSettingsMarker).Assembly.GetTypes()
            .Where(t => t.FullName == "ForeverDB.Companion.Models.CompanionSettings")
            .SelectMany(t => t.GetProperties())
            .Select(p => p.Name)
            .ToArray();
        Assert.NotEmpty(names);
        Assert.DoesNotContain(names, n => System.Text.RegularExpressions.Regex.IsMatch(n,
            "(?i)account|token|password|secret|session|refresh|claim|staging|enable.*auth"));

        var json = System.Text.Json.JsonSerializer.Serialize(new ForeverDB.Companion.Models.CompanionSettings());
        Assert.DoesNotContain("token", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("password", json, StringComparison.OrdinalIgnoreCase);

        // Only process environment variables are read; there is no file or setting input to Evaluate.
        Assert.Equal(typeof(Func<string, string?>), typeof(AccountFeatureGate).GetMethod("Evaluate")!.GetParameters().Single().ParameterType);
    }

    // ---------------------------------------------------------------- traffic separation ----

    [Fact]
    public async Task Full_staging_flow_never_sends_a_request_to_the_production_project()
    {
        using var rig = new Rig();
        var anon = rig.SeedAnonymous();
        var registered = rig.Server.AddRegisteredUser("a@b.test", "a-long-password-1");
        rig.Server.SetOwner("inst", anon.UserId);
        await rig.Sessions.InitializeAsync();

        await rig.Sessions.SignInRegisteredAsync("a@b.test", "a-long-password-1".ToCharArray());
        var offer = (await rig.Runtime.Claims.StartClaimAsync("inst", default)).Offer!;
        rig.Server.Redeem(offer.DisplayCode.Replace("FDB-", "").Replace("-", ""), registered.Id);
        await rig.Runtime.Claims.CheckLinkStatusAsync("inst", default);
        await rig.Runtime.Sync.SyncAsync("inst", "{\"p_snapshot\":{\"installationId\":\"inst\"}}", 1, true, default);
        await rig.Sessions.SignOutRegisteredAsync();
        await rig.Sessions.ForgetLegacyOwnerAsync(true, false);

        Assert.NotEmpty(rig.Handler.RequestUris);
        Assert.All(rig.Handler.RequestUris, u =>
        {
            Assert.Equal(new Uri(TestEnv.StagingUrl).Host, u.Host);
            Assert.DoesNotContain(AccountFeatureGate.ProductionProjectRef, u.ToString(), StringComparison.OrdinalIgnoreCase);
        });
    }

    [Fact]
    public async Task Guard_handler_blocks_the_production_host_when_enforced()
    {
        var inner = new FakeHandler(new FakeSupabase());
        using var enforced = new HttpClient(new ProductionHostGuardHandler(inner, enforce: true));
        await Assert.ThrowsAsync<InvalidOperationException>(() => enforced.PostAsync($"https://{TestEnv.ProductionHost}/auth/v1/signup", new StringContent("{}")));
        Assert.Empty(inner.RequestUris);

        // Production anonymous-only mode (gate closed) keeps talking to its own project, as in 0.8.x.
        using var production = new HttpClient(new ProductionHostGuardHandler(inner, enforce: false));
        var ok = await production.PostAsync($"https://{TestEnv.ProductionHost}/auth/v1/signup", new StringContent("{}"));
        Assert.True((int)ok.StatusCode > 0);
    }

    [Fact]
    public async Task Staging_credentials_live_in_an_isolated_directory_and_never_touch_production_files()
    {
        var production = TestEnv.NewDirectory();
        var prodVault = new SessionVault(production, TestEnv.Protector());
        var server = new FakeSupabase();
        var prodUser = server.AddAnonymousUser();
        prodVault.Primary.Write(server.IssueSession(prodUser.Id), SlotMarker.For(SessionKind.Anonymous));
        var before = TestEnv.ReadTopLevelFiles(production);

        using var rig = new Rig(server: server, directory: production);
        // The staging gate relocates credentials below account-test/..., so the production directory is untouched...
        Assert.NotEqual(production, rig.VaultDirectory);
        await rig.Sessions.InitializeAsync();
        Assert.Equal(SessionState.LoggedOut, rig.Sessions.Status.State);   // staging identity is separate from production's
        await rig.Sessions.StartAnonymousAsync(false);
        await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);

        Assert.Equal(before, TestEnv.ReadTopLevelFiles(production));
        Assert.Equal(1, new SessionVault(production, TestEnv.Protector()).Primary.Read().Session is null ? 0 : 1);
    }
}

internal sealed class CompanionSettingsMarker { }
