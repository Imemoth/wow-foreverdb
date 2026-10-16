using ForeverDB.Companion.Account;

// Out-of-process "Companion instance" used by the cross-process tests.
// args: <command> <vaultDir> <url> [options]. Prints one JSON line to stdout.
var command = args[0];
var dir = args[1];
var url = args.Length > 2 ? args[2] : "http://127.0.0.1:1";
var options = args.Skip(3).ToArray();

ICredentialProtector protector = OperatingSystem.IsWindows() ? CreateDpapi() : new XorProtector();
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
static ICredentialProtector CreateDpapi() => new DpapiCredentialProtector();

var endpoint = new AccountEndpoint(url, "sb_publishable_testkey", "worker");
var vault = new SessionVault(dir, protector);
var gate = new CrossProcessSessionGate(dir);
var http = new HttpClient();

switch (command)
{
    case "token":
    {
        var useLock = !options.Contains("--no-lock");
        var manager = new AccountSessionManager(
            vault,
            useLock ? gate : new NoGate(),
            new GoTrueClient(http, endpoint),
            accountsEnabled: true);
        var result = await manager.GetAccessTokenAsync(SlotRole.Primary);
        var status = manager.Status;
        var read = vault.Primary.Read();
        Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new
        {
            ok = result.Ok,
            user = result.UserId,
            state = status.State.ToString(),
            fault = result.Fault.ToString(),
            refresh = read.Session?.RefreshToken
        }));
        break;
    }
    case "signin":
    {
        var manager = new AccountSessionManager(vault, gate, new GoTrueClient(http, endpoint), accountsEnabled: true);
        var outcome = await manager.SignInRegisteredAsync(options[0], options[1].ToCharArray());
        Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { outcome = outcome.ToString(), state = manager.Status.State.ToString() }));
        break;
    }
    case "enroll":
    {
        // Zero-touch enrollment from a separate process. options: <activationDir> <installationId>
        var deviceDir = Path.Combine(dir, DeviceContract.DeviceSubdirectory);
        var context = new DeviceContext(
            deviceDir, protector, new CrossProcessSessionGate(deviceDir),
            new GoTrueClient(http, endpoint), new DeviceRpcClient(http, endpoint));
        var service = new DeviceEnrollmentService(
            context,
            new FileActivationSource(new[] { new ActivationSearchLocation(options[0], "*.fdbact") }),
            () => new[] { options[1] });
        var status = await service.InitializeAsync();
        Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { state = status.State.ToString(), detail = status.Detail.ToString() }));
        break;
    }
    case "hold":
    {
        // Take the gate, announce it, hold for N ms (or forever with --die to be killed while holding).
        using var lease = await gate.AcquireAsync(TimeSpan.FromSeconds(30), CancellationToken.None);
        Console.WriteLine("HELD");
        Console.Out.Flush();
        await Task.Delay(int.Parse(options[0]));
        break;
    }
    default:
        Console.Error.WriteLine("unknown command");
        return 2;
}

return 0;

sealed class NoGate : ISessionGate
{
    public async Task<SessionLease> AcquireAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        // Deliberately unsafe negative control: proves the race exists without the gate.
        var gate = new CrossProcessSessionGate(Path.Combine(Path.GetTempPath(), "fdb-nogate-" + Guid.NewGuid().ToString("N")));
        return await gate.AcquireAsync(timeout, cancellationToken);
    }
}

sealed class XorProtector : ICredentialProtector
{
    private static readonly byte[] Magic = "FAKEDPAPI1"u8.ToArray();
    public byte[] Protect(byte[] plain) => Magic.Concat(plain.Select(b => (byte)(b ^ 0x5A))).ToArray();
    public byte[] Unprotect(byte[] protectedBytes)
    {
        if (protectedBytes.Length < Magic.Length || !protectedBytes.AsSpan(0, Magic.Length).SequenceEqual(Magic))
        {
            throw new System.Security.Cryptography.CryptographicException("not a protected blob");
        }

        return protectedBytes.Skip(Magic.Length).Select(b => (byte)(b ^ 0x5A)).ToArray();
    }
}
