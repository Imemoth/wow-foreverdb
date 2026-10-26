using System.Text;
using System.Text.RegularExpressions;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public class SecretHygieneTests
{
    [Fact]
    public void Redaction_removes_every_secret_shape()
    {
        const string jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl";
        var text = Redaction.Scrub(
            $"Bearer {jwt} apikey=sb_publishable_abcDEF123 refresh_token: r-1-abcdef password=hunter22 " +
            "code FDB-0123-4567-89AB-CDEF-0123-4567-89AB-CDEF raw 0123456789ABCDEF0123456789ABCDEF " +
            @"mail elara@example.test path C:\Users\Elara\AppData\Local\ForeverDB\session.dat", maxLength: 1000);

        foreach (var secret in new[] { jwt, "sb_publishable_abcDEF123", "r-1-abcdef", "hunter22", "FDB-0123", "0123456789ABCDEF0123456789ABCDEF", "elara@example.test", @"C:\Users" })
        {
            Assert.DoesNotContain(secret, text);
        }
    }

    [Fact]
    public async Task No_secret_appears_in_credential_files_settings_status_results_or_the_directory_after_a_full_flow()
    {
        using var rig = new Rig();
        var anon = rig.SeedAnonymous();
        var registered = rig.Server.AddRegisteredUser("elara@example.test", "S3cret-passphrase-!");
        rig.Server.SetOwner("inst", anon.UserId);
        await rig.Sessions.InitializeAsync();

        var password = "S3cret-passphrase-!";
        await rig.Sessions.SignInRegisteredAsync("elara@example.test", password.ToCharArray());
        var offer = (await rig.Runtime.Claims.StartClaimAsync("inst", default)).Offer!;
        var code = offer.DisplayCode.Replace("FDB-", "").Replace("-", "");

        // The Companion's settings.json is a separate, plain file; it must contain nothing of the above.
        var settingsJson = System.Text.Json.JsonSerializer.Serialize(new ForeverDB.Companion.Models.CompanionSettings());
        File.WriteAllText(Path.Combine(rig.Directory, "settings.json"), settingsJson);

        var token = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        var legacy = await rig.Sessions.GetAccessTokenAsync(SlotRole.LegacyOwner);
        var secrets = new[] { password, code, offer.DisplayCode, token.AccessToken, legacy.AccessToken, anon.RefreshToken };

        foreach (var secret in secrets)
        {
            Assert.False(TestEnv.DirectoryContains(rig.Directory, secret), "secret found on disk");
        }

        var visible = new[]
        {
            System.Text.Json.JsonSerializer.Serialize(rig.Sessions.Status),
            System.Text.Json.JsonSerializer.Serialize(rig.Runtime.Sync.Installations),
            token.ToString(), legacy.ToString(), offer.ToString(), rig.Runtime.Endpoint.ToString(), new AuthSession { AccessToken = token.AccessToken }.ToString()
        };
        foreach (var text in visible)
        {
            foreach (var secret in secrets.Where(s => s.Length > 0))
            {
                Assert.DoesNotContain(secret, text);
            }
        }

        _ = registered;
    }

    [Fact]
    public async Task Failures_expose_only_typed_values_never_server_bodies()
    {
        using var rig = new Rig();
        rig.SeedAnonymous(expired: true);
        const string leak = "internal-stack eyJhbGciOiJIUzI1NiJ9.e30.sig db-password-hunter2";
        rig.Server.Interceptor = r => new FakeResponse(500, "{\"message\":\"" + leak + "\"}");

        var token = await rig.Sessions.GetAccessTokenAsync(SlotRole.Primary);
        Assert.DoesNotContain("hunter2", token.ToString());
        Assert.DoesNotContain("hunter2", System.Text.Json.JsonSerializer.Serialize(rig.Sessions.Status));

        var ingest = await rig.Runtime.Rpc.IngestAsync("t", "{}", default);
        Assert.DoesNotContain("hunter2", ingest.ToString());
        var gotrue = await new GoTrueClient(new HttpClient(rig.Handler), rig.Runtime.Endpoint).RefreshAsync("r", default);
        Assert.DoesNotContain("hunter2", gotrue.ToString());
        Assert.Null(gotrue.ErrorCode);
    }

    [Fact]
    public void Error_codes_from_the_server_are_sanitised_before_being_kept()
    {
        var (_, code) = GoTrueClient.ClassifyRefreshFailure(400, "{\"error_code\":\"eyJhbGciOiJIUzI1NiJ9.leak\",\"msg\":\"x\"}");
        Assert.Null(code);
        var (_, ok) = GoTrueClient.ClassifyRefreshFailure(400, "{\"error_code\":\"refresh_token_not_found\"}");
        Assert.Equal("refresh_token_not_found", ok);
    }

    [Fact]
    public void Library_and_app_sources_contain_no_logging_or_console_output_of_any_kind()
    {
        var root = RepoRoot();
        var files = Directory.GetFiles(Path.Combine(root, "companion", "ForeverDB.Companion.Account"), "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}") && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"))
            .Concat(new[]
            {
                Path.Combine(root, "companion", "ForeverDB.Companion", "Services", "SyncService.cs"),
                Path.Combine(root, "companion", "ForeverDB.Companion", "MainWindow.Account.cs")
            }.Where(File.Exists))
            .ToArray();
        Assert.NotEmpty(files);

        var forbidden = new Regex(@"\b(Console\.(Write|Error|Out)|Debug\.(Write|Print)|Trace\.(Write|TraceError|TraceWarning)|ILogger|EventLog|Clipboard\.SetText\((?!offer))", RegexOptions.Compiled);
        foreach (var file in files)
        {
            var text = File.ReadAllText(file);
            Assert.False(forbidden.IsMatch(text), $"{Path.GetFileName(file)} writes diagnostics");
        }
    }

    [Fact]
    public void Persisted_session_shape_never_includes_a_password_field()
    {
        var names = typeof(AuthSession).GetProperties().Select(p => p.Name.ToLowerInvariant()).ToArray();
        Assert.DoesNotContain(names, n => n.Contains("password"));
        var marker = System.Text.Json.JsonSerializer.Serialize(SlotMarker.For(SessionKind.Registered), SlotMarker.Json);
        Assert.DoesNotContain("token", marker, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("email", marker, StringComparison.OrdinalIgnoreCase);
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "companion")))
        {
            dir = dir.Parent;
        }

        Assert.NotNull(dir);
        return dir!.FullName;
    }
}
