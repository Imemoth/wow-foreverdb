using System.Reflection;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

/// <summary>The default (production, anonymous-only) mode must not change at all: no file scanning, no network, no new objects.</summary>
public class DeviceGateTests
{
    private const string Key = "sb_publishable_testkey";

    private static AccountGateDecision Eval(params (string Name, string Value)[] vars)
    {
        var map = vars.ToDictionary(v => v.Name, v => v.Value);
        // Simulates owner-approved pilot builds; the compiled login/claim approvals are OFF on the release line (asserted below).
        return AccountFeatureGate.Evaluate(n => map.TryGetValue(n, out var v) ? v : null, new AccountFeatureGate.GateApprovals(PrivatePilot: true, ClaimPilot: true));
    }

    private static AccountGateDecision PrivatePilot(bool claim)
    {
        var vars = new List<(string, string)>
        {
            (AccountFeatureGate.ModeVariable, claim ? "private-claim-pilot" : "private-pilot"),
            (AccountFeatureGate.UrlVariable, $"https://{AccountFeatureGate.ProductionProjectRef}.supabase.co"),
            (AccountFeatureGate.KeyVariable, "sb_publishable_" + new string('k', 24)),
            (AccountFeatureGate.ProjectRefVariable, AccountFeatureGate.ProductionProjectRef)
        };
        if (claim) vars.Add((AccountFeatureGate.ClaimInstallationVariable, "inst-0123456789abcdef0123"));
        return Eval(vars.ToArray());
    }

    private static AccountGateDecision Local() => Eval(
        (AccountFeatureGate.ModeVariable, "local"),
        (AccountFeatureGate.UrlVariable, "http://127.0.0.1:54321"),
        (AccountFeatureGate.KeyVariable, Key));

    [Fact]
    public void The_new_approval_and_auto_sync_flags_are_compile_time_constants_that_default_to_false()
    {
        foreach (var name in new[] { nameof(AccountFeatureGate.ZeroTouchEnrollmentApproved), nameof(AccountFeatureGate.DeviceAutoSyncApproved), nameof(AccountFeatureGate.ProductionAccountAuthApproved) })
        {
            var field = typeof(AccountFeatureGate).GetField(name, BindingFlags.Public | BindingFlags.Static)!;
            Assert.True(field.IsLiteral, $"{name} must be a const");
            Assert.Equal(false, field.GetRawConstantValue());
        }
    }

    [Fact]
    public void No_other_approval_flag_was_added_and_every_pilot_flag_is_off_on_the_release_line()
    {
        var approvals = typeof(AccountFeatureGate).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(f => f.FieldType == typeof(bool)).Select(f => f.Name).OrderBy(n => n).ToArray();
        Assert.Equal(
            new[] { "DeviceAutoSyncApproved", "PrivateProjectClaimPilotApproved", "PrivateProjectPilotApproved", "ProductionAccountAuthApproved", "ZeroTouchEnrollmentApproved" },
            approvals);
        Assert.False(AccountFeatureGate.PrivateProjectPilotApproved);
        Assert.False(AccountFeatureGate.PrivateProjectClaimPilotApproved);
    }

    [Fact]
    public void Zero_touch_is_available_for_isolated_local_and_staging_gates_only()
    {
        Assert.False(AccountFeatureGate.ZeroTouchAvailable(Eval()));
        Assert.False(AccountFeatureGate.ZeroTouchAvailable(Eval((AccountFeatureGate.ModeVariable, "production"))));
        Assert.False(AccountFeatureGate.ZeroTouchAvailable(Eval((AccountFeatureGate.ModeVariable, "bogus"))));
        Assert.True(AccountFeatureGate.ZeroTouchAvailable(Local()));
        Assert.True(AccountFeatureGate.ZeroTouchAvailable(TestEnv.StagingGate()));
        // An invalid staging endpoint is off, so zero-touch is too.
        Assert.False(AccountFeatureGate.ZeroTouchAvailable(TestEnv.StagingGate($"https://{AccountFeatureGate.ProductionProjectRef}.supabase.co")));
    }

    [Fact]
    public void Private_pilot_gates_do_not_enable_zero_touch_while_the_approval_constant_is_false()
    {
        var pilot = PrivatePilot(claim: false);
        var claim = PrivatePilot(claim: true);
        Assert.True(pilot.AccountsEnabled);
        Assert.True(claim.AccountsEnabled);
        Assert.False(AccountFeatureGate.ZeroTouchAvailable(pilot));
        Assert.False(AccountFeatureGate.ZeroTouchAvailable(claim));
    }

    [Fact]
    public async Task Default_production_mode_creates_no_device_runtime_scans_nothing_and_makes_no_request()
    {
        var server = new FakeSupabase();
        var handler = new FakeHandler(server);
        var dir = TestEnv.NewDirectory();
        var activation = Path.Combine(dir, "activation");
        Directory.CreateDirectory(activation);
        var file = Path.Combine(activation, "foreverdb-activation.fdbact");
        File.WriteAllText(file, FakeDeviceBackend.ActivationJson("fdba1_" + new string('A', 43)));
        var before = (File.ReadAllBytes(file), Directory.GetFileSystemEntries(dir, "*", SearchOption.AllDirectories));

        var runtime = AccountRuntime.Create(
            AccountFeatureGate.Evaluate(_ => null), TestEnv.ProductionEndpoint, handler, TestEnv.Protector(), dir, null, null,
            new ThrowingSource(), () => throw new InvalidOperationException("installations must not be read"));

        Assert.Null(runtime.Device);
        await runtime.Sessions.InitializeAsync();
        Assert.Empty(handler.RequestUris);
        Assert.Empty(server.Requests);
        Assert.Equal(before.Item1, File.ReadAllBytes(file));
        Assert.Equal(before.Item2, Directory.GetFileSystemEntries(dir, "*", SearchOption.AllDirectories));
        Assert.False(Directory.Exists(Path.Combine(dir, DeviceContract.DeviceSubdirectory)));
    }

    [Fact]
    public async Task Private_pilots_get_no_device_runtime_either()
    {
        foreach (var claim in new[] { false, true })
        {
            var dir = TestEnv.NewDirectory();
            var handler = new FakeHandler(new FakeSupabase());
            var runtime = AccountRuntime.Create(PrivatePilot(claim), TestEnv.ProductionEndpoint, handler, TestEnv.Protector(), dir, null, null, new ThrowingSource());
            Assert.Null(runtime.Device);
            await Task.CompletedTask;
        }
    }

    [Fact]
    public void Local_and_staging_gates_wire_a_device_runtime_in_the_device_subfolder_of_the_isolated_directory()
    {
        foreach (var gate in new[] { Local(), TestEnv.StagingGate() })
        {
            var dir = TestEnv.NewDirectory();
            var runtime = AccountRuntime.Create(gate, TestEnv.ProductionEndpoint, new FakeHandler(new FakeSupabase()), TestEnv.Protector(), dir,
                null, null, new FileActivationSource(Array.Empty<ActivationSearchLocation>()));
            Assert.NotNull(runtime.Device);
            Assert.Equal(DeviceState.Anonymous, runtime.Device!.Status.State);
            Assert.Equal(Path.Combine(dir, gate.CredentialSubdirectory, DeviceContract.DeviceSubdirectory), runtime.Device.Context.Directory);
            Assert.False(Directory.Exists(runtime.Device.Context.Directory));   // created lazily, never at startup
        }
    }

    [Fact]
    public async Task Services_built_disabled_do_nothing_at_all()
    {
        var server = new FakeSupabase();
        var handler = new FakeHandler(server);
        var dir = TestEnv.NewDirectory();
        var endpoint = TestEnv.StagingGate().Endpoint!;
        var http = new HttpClient(handler);
        var ctx = new DeviceContext(Path.Combine(dir, "device"), TestEnv.Protector(), new CrossProcessSessionGate(dir), new GoTrueClient(http, endpoint), new DeviceRpcClient(http, endpoint));
        var enrollment = new DeviceEnrollmentService(ctx, new ThrowingSource(), () => throw new InvalidOperationException(), enabled: false);
        var sync = new DeviceSyncService(ctx, enabled: false);

        Assert.Equal(DeviceState.Anonymous, enrollment.LoadLocalState().State);
        Assert.Equal(DeviceState.Anonymous, (await enrollment.InitializeAsync()).State);
        Assert.Equal(DeviceState.Anonymous, (await sync.CheckStatusAsync()).State);
        Assert.Equal(DeviceSyncOutcome.NotRegistered, (await sync.SyncNowAsync("{\"p_snapshot\":{\"installationId\":\"inst-0123456789abcdef0123\"}}")).Outcome);
        Assert.False(sync.Handles("inst-0123456789abcdef0123"));
        Assert.Empty(handler.RequestUris);
        Assert.Empty(Directory.GetFileSystemEntries(dir));
    }

    private sealed class ThrowingSource : IActivationSource
    {
        public IReadOnlyList<ActivationCandidate> Discover() => throw new InvalidOperationException("activation files must not be scanned");
        public bool Remove(string ticketHash) => throw new InvalidOperationException("activation files must not be touched");
    }
}
