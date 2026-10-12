using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

/// <summary>Reversible, NON-plaintext protector for non-Windows sandboxes. Windows runs always use real DPAPI.</summary>
public sealed class FakeProtector : ICredentialProtector
{
    private static readonly byte[] Magic = "FAKEDPAPI1"u8.ToArray();

    public byte[] Protect(byte[] plain) => Magic.Concat(plain.Select(b => (byte)(b ^ 0x5A))).ToArray();

    public byte[] Unprotect(byte[] protectedBytes)
    {
        if (protectedBytes.Length < Magic.Length || !protectedBytes.AsSpan(0, Magic.Length).SequenceEqual(Magic))
        {
            throw new CryptographicException("not a protected blob");
        }

        return protectedBytes.Skip(Magic.Length).Select(b => (byte)(b ^ 0x5A)).ToArray();
    }
}

public static class TestEnv
{
    public const string ProductionHost = "klxhikdlfwgxurdyexdi.supabase.co";
    public const string StagingUrl = "https://abcdefghijklmnopqrst.supabase.co";

    public static ICredentialProtector Protector() =>
        OperatingSystem.IsWindows() ? CreateDpapi() : new FakeProtector();

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static ICredentialProtector CreateDpapi() => new DpapiCredentialProtector();

    public static string NewDirectory()
    {
        var dir = Path.Combine(Path.GetTempPath(), "fdb-account-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    public static AccountGateDecision StagingGate(string url = StagingUrl) =>
        AccountFeatureGate.Evaluate(name => name switch
        {
            AccountFeatureGate.ModeVariable => "staging",
            AccountFeatureGate.UrlVariable => url,
            AccountFeatureGate.KeyVariable => "sb_publishable_testkey",
            AccountFeatureGate.ProjectRefVariable => new Uri(url).Host.Split('.')[0],
            _ => null
        });

    public static readonly AccountEndpoint ProductionEndpoint =
        new("https://" + ProductionHost, "sb_publishable_prodkey", "production");

    public static byte[] ReadAllFiles(string directory)
    {
        var bytes = new List<byte>();
        foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.Ordinal))
        {
            bytes.AddRange(Encoding.UTF8.GetBytes(Path.GetFileName(file) + "\n"));
            bytes.AddRange(File.ReadAllBytes(file));
        }

        return bytes.ToArray();
    }

    public static byte[] ReadTopLevelFiles(string directory)
    {
        var bytes = new List<byte>();
        foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.TopDirectoryOnly).OrderBy(f => f, StringComparer.Ordinal))
        {
            bytes.AddRange(Encoding.UTF8.GetBytes(Path.GetFileName(file) + "\n"));
            bytes.AddRange(File.ReadAllBytes(file));
        }

        return bytes.ToArray();
    }

    public static bool DirectoryContains(string directory, string needle)
    {
        var plain = Encoding.UTF8.GetBytes(needle);
        var utf16 = Encoding.Unicode.GetBytes(needle);
        var b64 = Encoding.ASCII.GetBytes(Convert.ToBase64String(plain));
        foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
        {
            var data = File.ReadAllBytes(file);
            if (data.AsSpan().IndexOf(plain) >= 0 || data.AsSpan().IndexOf(utf16) >= 0 || data.AsSpan().IndexOf(b64) >= 0)
            {
                return true;
            }
        }

        return false;
    }
}

public sealed class ManualClock : TimeProvider
{
    private DateTimeOffset _now;
    public ManualClock(DateTimeOffset? start = null) => _now = start ?? DateTimeOffset.UtcNow;
    public override DateTimeOffset GetUtcNow() => _now;
    public void Advance(TimeSpan by) => _now += by;
}

/// <summary>Runs only on Windows (real DPAPI acceptance); reported as skipped elsewhere.</summary>
public sealed class WindowsFactAttribute : FactAttribute
{
    public WindowsFactAttribute()
    {
        if (!OperatingSystem.IsWindows())
        {
            Skip = "Requires Windows DPAPI.";
        }
    }
}

/// <summary>One Companion "installation": a vault directory, a fake Supabase and a wired runtime.</summary>
public sealed class Rig : IDisposable
{
    public FakeSupabase Server { get; }
    public FakeHandler Handler { get; }
    public string Directory { get; }
    public ManualClock? Clock { get; }
    public AccountRuntime Runtime { get; private set; }
    private readonly TimeSpan? _timeout;
    private readonly bool _enabled;

    public Rig(bool accountsEnabled = true, FakeSupabase? server = null, string? directory = null, ManualClock? clock = null, TimeSpan? requestTimeout = null)
    {
        Server = server ?? new FakeSupabase();
        Handler = new FakeHandler(Server);
        Directory = directory ?? TestEnv.NewDirectory();
        Clock = clock;
        _timeout = requestTimeout;
        _enabled = accountsEnabled;
        Runtime = Build();
    }

    private AccountRuntime Build() =>
        AccountRuntime.Create(
            _enabled ? TestEnv.StagingGate() : AccountFeatureGate.Evaluate(_ => null),
            TestEnv.ProductionEndpoint,
            Handler,
            TestEnv.Protector(),
            // Gate open => runtime appends its own isolated subdirectory; keep both views of the vault consistent.
            Directory,
            Clock,
            _timeout);

    /// <summary>The directory the vault really uses (an account-test subfolder when the gate is open).</summary>
    public string VaultDirectory =>
        _enabled ? Path.Combine(Directory, Runtime.Gate.CredentialSubdirectory) : Directory;

    public SessionVault Vault() => new(VaultDirectory, TestEnv.Protector());

    /// <summary>Simulates closing and restarting the Companion: new objects over the same files.</summary>
    public AccountRuntime Restart()
    {
        Runtime = Build();
        return Runtime;
    }

    public AccountSessionManager Sessions => Runtime.Sessions;

    /// <summary>Stores a session exactly as Companion 0.8.2-alpha did (no marker, bare DPAPI blob).</summary>
    public void SeedLegacy082Session(AuthSession session, bool production = true)
    {
        var dir = production ? Directory : VaultDirectory;
        System.IO.Directory.CreateDirectory(dir);
        var plain = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { session.AccessToken, session.RefreshToken, session.ExpiresAt, session.UserId }));
        File.WriteAllText(Path.Combine(dir, "session.dat"), Convert.ToBase64String(TestEnv.Protector().Protect(plain)));
    }

    public AuthSession SeedAnonymous(bool expired = false)
    {
        var user = Server.AddAnonymousUser();
        var session = Server.IssueSession(user.Id, expired ? 1 : null);
        Vault().Primary.Write(session, SlotMarker.For(SessionKind.Anonymous));
        return session;
    }

    public (FakeSupabase.User User, AuthSession Session) SeedRegistered(string email = "elara@example.test", string password = "correct horse battery")
    {
        var user = Server.AddRegisteredUser(email, password);
        var session = Server.IssueSession(user.Id);
        Vault().Primary.Write(session, SlotMarker.For(SessionKind.Registered));
        return (user, session);
    }

    public void Dispose()
    {
        try { System.IO.Directory.Delete(Directory, true); } catch { }
    }
}
