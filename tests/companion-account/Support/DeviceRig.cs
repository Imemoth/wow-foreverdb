using System.Text;

namespace ForeverDB.Companion.Account.Tests;

/// <summary>
/// One Windows computer running the zero-touch Companion: a root directory (legacy account files at its top level, the device
/// identity in <c>device/</c>, activation files in <c>activation/</c>), the shared fake Auth + device backend, and the services.
/// Pass the same <paramref name="server"/>/<paramref name="backend"/> to a second rig for "a second computer".
/// </summary>
public sealed class DeviceRig : IDisposable
{
    private readonly bool _ownsRoot;
    public FakeSupabase Server { get; }
    public FakeDeviceBackend Backend { get; }
    public FakeHandler Handler { get; }
    public FakeSupabase.User Account { get; }
    public string Root { get; }
    public string ActivationDir => Path.Combine(Root, "activation");
    public string DeviceDir => Path.Combine(Root, DeviceContract.DeviceSubdirectory);
    public string Installation { get; set; }
    public List<string> Installations { get; }
    public ISlotIo? Io { get; set; }
    public ManualClock Clock { get; } = new();

    public DeviceContext Context { get; private set; } = null!;
    public DeviceEnrollmentService Enrollment { get; private set; } = null!;
    public DeviceSyncService Sync { get; private set; } = null!;

    public DeviceRig(FakeSupabase? server = null, FakeDeviceBackend? backend = null, FakeSupabase.User? account = null, string? installation = null, string? root = null)
    {
        _ownsRoot = root is null;
        Server = server ?? new FakeSupabase();
        Backend = backend ?? new FakeDeviceBackend(Server);
        Handler = new FakeHandler(Server);
        Account = account ?? Server.AddRegisteredUser("owner@example.test", "correct horse battery");
        Root = root ?? TestEnv.NewDirectory();
        Directory.CreateDirectory(ActivationDir);
        Installation = installation ?? "inst-" + Guid.NewGuid().ToString("N")[..20];
        Installations = new List<string> { Installation };
        Build();
    }

    /// <summary>"Closes and restarts the Companion": brand-new objects over the same files.</summary>
    public void Build()
    {
        var endpoint = TestEnv.StagingGate().Endpoint!;
        var http = new HttpClient(Handler);
        var protector = TestEnv.Protector();
        Context = new DeviceContext(
            DeviceDir, protector, new CrossProcessSessionGate(DeviceDir),
            new GoTrueClient(http, endpoint), new DeviceRpcClient(http, endpoint), Clock,
            lockTimeout: TimeSpan.FromSeconds(10), io: Io);
        Enrollment = new DeviceEnrollmentService(
            Context,
            new FileActivationSource(new[] { new ActivationSearchLocation(ActivationDir, "*.fdbact") }),
            () => Installations.ToArray());
        Sync = new DeviceSyncService(Context);
    }

    public string NewTicket(TimeSpan? ttl = null) => Backend.IssueTicket(Account.Id, ttl);

    public string WriteActivation(string ticket, string name = "foreverdb-activation.fdbact")
    {
        var path = Path.Combine(ActivationDir, name);
        File.WriteAllText(path, FakeDeviceBackend.ActivationJson(ticket));
        return path;
    }

    public string Activate()
    {
        var ticket = NewTicket();
        WriteActivation(ticket);
        return ticket;
    }

    public string Snapshot(string? installation = null, long updatedAt = 1) =>
        "{\"p_snapshot\":{\"installationId\":\"" + (installation ?? Installation) + "\",\"schemaVersion\":9,\"updatedAt\":" + updatedAt + ",\"sources\":[]}}";

    public DeviceCredential StoredCredential() => Context.Store.Read().Credential!;

    public string[] ActivationFiles() => Directory.GetFiles(ActivationDir);

    /// <summary>Seeds the legacy (0.8.x/V1) account files at the top level exactly like a Companion that has used ForeverDB before.</summary>
    public Dictionary<string, byte[]> SeedLegacyFiles(bool damaged = false)
    {
        var files = new Dictionary<string, byte[]>();
        foreach (var name in new[] { "session.dat", "session.dat.bak", "legacy-owner.dat", "pending-revoke.dat", "session.kind", "SavedVariables-keep.lua" })
        {
            var path = Path.Combine(Root, name);
            var content = damaged ? Encoding.UTF8.GetBytes("garbage-" + name) : Encoding.UTF8.GetBytes("legacy-bytes-" + name + Guid.NewGuid());
            File.WriteAllBytes(path, content);
            files[name] = content;
        }

        return files;
    }

    public byte[] TopLevelSnapshot() => TestEnv.ReadTopLevelFiles(Root);

    public void Dispose()
    {
        if (_ownsRoot)
        {
            try { Directory.Delete(Root, true); } catch { }
        }
    }
}

/// <summary>An <see cref="ISlotIo"/> whose reads can be made to fail like a locked file.</summary>
public sealed class ReadFaultIo : ISlotIo
{
    private readonly PhysicalSlotIo _inner = new();
    public bool FailReads { get; set; }
    public bool Exists(string path) => _inner.Exists(path);
    public byte[] ReadAllBytes(string path) => FailReads ? throw new IOException("sharing violation") : _inner.ReadAllBytes(path);
    public void WriteDurable(string path, byte[] content) => _inner.WriteDurable(path, content);
    public void Commit(string tempPath, string destination, string backupPath) => _inner.Commit(tempPath, destination, backupPath);
    public void Move(string source, string destination) => _inner.Move(source, destination);
    public void Delete(string path) => _inner.Delete(path);
    public IEnumerable<string> Enumerate(string directory, string pattern) => _inner.Enumerate(directory, pattern);
    public void EnsureDirectory(string directory) => _inner.EnsureDirectory(directory);
}
