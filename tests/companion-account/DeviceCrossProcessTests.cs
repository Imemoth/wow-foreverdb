using System.Diagnostics;
using System.Text.Json;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

/// <summary>Real parallel OS processes: two Companions started together must enroll one device, once.</summary>
public class DeviceCrossProcessTests
{
    private static string WorkerDll()
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !Directory.Exists(Path.Combine(root.FullName, "Worker")))
        {
            root = root.Parent;
        }

        Assert.NotNull(root);
        var candidates = Directory.GetFiles(Path.Combine(root!.FullName, "Worker", "bin"), "Companion.Account.Worker.dll", SearchOption.AllDirectories)
            .OrderByDescending(File.GetLastWriteTimeUtc).ToArray();
        Assert.NotEmpty(candidates);
        return candidates[0];
    }

    private static Process Start(string root, string url, string activationDir, string installation)
    {
        var info = new ProcessStartInfo("dotnet") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var a in new[] { WorkerDll(), "enroll", root, url, activationDir, installation })
        {
            info.ArgumentList.Add(a);
        }

        return Process.Start(info)!;
    }

    private static async Task<JsonElement> Output(Process p)
    {
        var text = await p.StandardOutput.ReadToEndAsync();
        var err = await p.StandardError.ReadToEndAsync();
        await p.WaitForExitAsync();
        Assert.True(p.ExitCode == 0, $"worker failed: {err}");
        return JsonDocument.Parse(text.Trim().Split('\n').Last()).RootElement.Clone();
    }

    [Fact]
    public async Task Concurrent_enrollment_from_separate_processes_creates_exactly_one_device_and_one_identity()
    {
        var server = new FakeSupabase();
        var backend = new FakeDeviceBackend(server);
        backend.OnCall = (rpc, _) =>
        {
            if (rpc == "fdb_device_enroll") Thread.Sleep(800);   // keep the first redemption in flight while the others wait on the gate
        };
        using var http = new FakeSupabaseServer(server);
        var account = server.AddRegisteredUser("owner@example.test", "correct horse battery");
        var root = TestEnv.NewDirectory();
        var activation = Path.Combine(root, "activation");
        Directory.CreateDirectory(activation);
        var file = Path.Combine(activation, "foreverdb-activation.fdbact");
        File.WriteAllText(file, FakeDeviceBackend.ActivationJson(backend.IssueTicket(account.Id)));
        var installation = "inst-" + Guid.NewGuid().ToString("N")[..20];

        var workers = Enumerable.Range(0, 3).Select(_ => Start(root, http.Url, activation, installation)).ToArray();
        var results = await Task.WhenAll(workers.Select(Output));

        Assert.All(results, r => Assert.Equal("Registered", r.GetProperty("state").GetString()));
        Assert.Equal(1, backend.Count("fdb_device_enroll"));
        Assert.Single(backend.Devices);
        Assert.Equal(1, server.SignupCount);
        Assert.Equal(account.Id, server.OwnerOf(installation));
        Assert.False(File.Exists(file));
        var credential = new DeviceCredentialStore(Path.Combine(root, DeviceContract.DeviceSubdirectory), TestEnv.Protector()).Read();
        Assert.Equal(DeviceCredentialStatus.Ok, credential.Status);
        Assert.Equal(backend.Devices.Single().Current, credential.Credential!.DeviceSecret);
    }
}
