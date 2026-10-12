using System.Diagnostics;
using System.Text.Json;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

/// <summary>
/// Real parallel OS processes (not Tasks) prove the machine-wide session gate: refresh-token rotation, identity
/// switching and abandoned-lock recovery across two "Companion instances".
/// </summary>
public class CrossProcessTests
{
    private static string WorkerDll()
    {
        // tests/companion-account/bin/<cfg>/<tfm>/ -> tests/companion-account/Worker/bin/<cfg>/net8.0/
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

    private static Process Start(string command, string vaultDir, string url, params string[] options)
    {
        var info = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        info.ArgumentList.Add(WorkerDll());
        info.ArgumentList.Add(command);
        info.ArgumentList.Add(vaultDir);
        info.ArgumentList.Add(url);
        foreach (var o in options)
        {
            info.ArgumentList.Add(o);
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

    private static (FakeSupabase Server, FakeSupabaseServer Http, string Dir, AuthSession Seed, FakeSupabase.User User) Arrange()
    {
        var server = new FakeSupabase { RefreshDelay = TimeSpan.FromMilliseconds(600) };
        var http = new FakeSupabaseServer(server);
        var dir = TestEnv.NewDirectory();
        var user = server.AddAnonymousUser();
        var seed = server.IssueSession(user.Id, lifetimeSeconds: 1);   // expired by the Companion's 90 s skew
        new SessionVault(dir, TestEnv.Protector()).Primary.Write(seed, SlotMarker.For(SessionKind.Anonymous));
        return (server, http, dir, seed, user);
    }

    [Fact]
    public async Task Concurrent_refresh_from_separate_processes_rotates_once_and_keeps_one_identity()
    {
        var (server, http, dir, _, user) = Arrange();
        using var httpServer = http;

        var workers = Enumerable.Range(0, 4).Select(i => Start("token", dir, http.Url)).ToArray();
        var results = await Task.WhenAll(workers.Select(Output));

        Assert.Equal(1, server.SuccessfulRefreshCount);
        Assert.Equal(0, server.AlreadyUsedRefreshCount);
        Assert.Equal(0, server.SignupCount);
        Assert.All(results, r =>
        {
            Assert.True(r.GetProperty("ok").GetBoolean());
            Assert.Equal(user.Id, r.GetProperty("user").GetString());
            Assert.Equal("Anonymous", r.GetProperty("state").GetString());
        });
        // Every process ends with the same, latest rotated refresh token on disk.
        Assert.Single(results.Select(r => r.GetProperty("refresh").GetString()).Distinct());
        var final = new SessionVault(dir, TestEnv.Protector()).Primary.Read().Session!;
        Assert.Equal(results[0].GetProperty("refresh").GetString(), final.RefreshToken);
    }

    [Fact]
    public async Task Negative_control_without_the_gate_the_same_scenario_races_on_the_refresh_token()
    {
        var (server, http, dir, _, _) = Arrange();
        using var httpServer = http;

        var workers = Enumerable.Range(0, 3).Select(i => Start("token", dir, http.Url, "--no-lock")).ToArray();
        await Task.WhenAll(workers.Select(Output));

        // Proves the harness can see the defect the gate prevents: more than one process rotated/was rejected.
        Assert.True(server.SuccessfulRefreshCount + server.AlreadyUsedRefreshCount > 1,
            $"expected a race without the gate (rotations={server.SuccessfulRefreshCount}, already-used={server.AlreadyUsedRefreshCount})");
    }

    [Fact]
    public async Task Concurrent_registered_sign_in_and_refresh_keep_a_consistent_two_slot_state()
    {
        var (server, http, dir, seed, user) = Arrange();
        using var httpServer = http;
        server.AddRegisteredUser("a@b.test", "a-long-password-1");

        var signIn = Start("signin", dir, http.Url, "a@b.test", "a-long-password-1");
        var refresh = Start("token", dir, http.Url);
        var results = await Task.WhenAll(Output(signIn), Output(refresh));

        Assert.Equal("Success", results[0].GetProperty("outcome").GetString());
        Assert.Equal(0, server.SignupCount);
        Assert.Equal(0, server.AlreadyUsedRefreshCount);

        var vault = new SessionVault(dir, TestEnv.Protector());
        var primary = vault.Primary.Read();
        var legacy = vault.LegacyOwner.Read();
        Assert.Equal(SlotReadStatus.Ok, primary.Status);
        Assert.Equal(SessionKind.Registered, primary.ProvisionalKind);
        Assert.Equal(SlotReadStatus.Ok, legacy.Status);
        Assert.Equal(user.Id, legacy.Session!.UserId);
        Assert.NotEqual(primary.Session!.UserId, legacy.Session.UserId);

        // The preserved anonymous credential is still alive and usable (its refresh token was not burnt by a race).
        var client = new GoTrueClient(new HttpClient(new FakeHandler(server)), new AccountEndpoint("https://abcdefghijklmnopqrst.supabase.co", "sb_publishable_x", "t"));
        var alive = await client.RefreshAsync(legacy.Session.RefreshToken, default);
        Assert.True(alive.Ok);
        Assert.Equal(user.Id, alive.Value!.UserId);
        _ = seed;
    }

    [Fact]
    public async Task The_gate_excludes_a_second_process_and_times_out_cleanly()
    {
        var dir = TestEnv.NewDirectory();
        var holder = Start("hold", dir, "http://127.0.0.1:1", "2500");
        Assert.Equal("HELD", (await holder.StandardOutput.ReadLineAsync())?.Trim());

        var gate = new CrossProcessSessionGate(dir);
        await Assert.ThrowsAsync<SessionLockTimeoutException>(() => gate.AcquireAsync(TimeSpan.FromMilliseconds(300), default));

        // Cancellation is honoured promptly while waiting.
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => gate.AcquireAsync(TimeSpan.FromSeconds(10), cts.Token));

        // Once the holder exits the lock is available again.
        using var lease = await gate.AcquireAsync(TimeSpan.FromSeconds(15), default);
        await holder.WaitForExitAsync();
    }

    [Fact]
    public async Task A_lock_abandoned_by_a_killed_process_is_recovered()
    {
        var dir = TestEnv.NewDirectory();
        var holder = Start("hold", dir, "http://127.0.0.1:1", "600000");
        Assert.Equal("HELD", (await holder.StandardOutput.ReadLineAsync())?.Trim());

        // A second Companion is already waiting for the lock when the holder dies (only a process that has the mutex
        // open observes it as abandoned; with no waiter the OS simply destroys the named object).
        var gate = new CrossProcessSessionGate(dir);
        var waiting = gate.AcquireAsync(TimeSpan.FromSeconds(60), default);
        await Task.Delay(500);
        Assert.False(waiting.IsCompleted);

        holder.Kill(entireProcessTree: true);
        await holder.WaitForExitAsync();

        using var lease = await waiting;
        // Windows reports the abandoned mutex; other platforms may silently recover. Either way the lock is usable.
        if (OperatingSystem.IsWindows())
        {
            Assert.True(lease.Abandoned);
        }

        // A later acquisition after a clean release is not flagged.
        lease.Dispose();
        using var again = await gate.AcquireAsync(TimeSpan.FromSeconds(5), default);
        Assert.False(again.Abandoned);
    }

    [Fact]
    public async Task A_lock_whose_holder_died_with_no_waiter_is_simply_free()
    {
        var dir = TestEnv.NewDirectory();
        var holder = Start("hold", dir, "http://127.0.0.1:1", "600000");
        Assert.Equal("HELD", (await holder.StandardOutput.ReadLineAsync())?.Trim());
        holder.Kill(entireProcessTree: true);
        await holder.WaitForExitAsync();

        using var lease = await new CrossProcessSessionGate(dir).AcquireAsync(TimeSpan.FromSeconds(15), default);
        Assert.NotNull(lease);
    }

    [Fact]
    public async Task Lease_can_be_held_across_awaits_and_released_from_another_thread()
    {
        // The Windows mutex is thread-owned; the gate must not care which thread resumes after an await.
        var gate = new CrossProcessSessionGate(TestEnv.NewDirectory());
        var lease = await gate.AcquireAsync(TimeSpan.FromSeconds(5), default);
        await Task.Delay(50);
        await Task.Run(() => lease.Dispose());

        using var next = await gate.AcquireAsync(TimeSpan.FromSeconds(5), default);
        Assert.False(next.Abandoned);
    }

    [Fact]
    public async Task In_process_contention_is_serialised_without_blocking_threads()
    {
        var gate = new CrossProcessSessionGate(TestEnv.NewDirectory());
        var inside = 0;
        var max = 0;
        await Task.WhenAll(Enumerable.Range(0, 8).Select(async _ =>
        {
            using var lease = await gate.AcquireAsync(TimeSpan.FromSeconds(20), default);
            var now = Interlocked.Increment(ref inside);
            max = Math.Max(max, now);
            await Task.Delay(20);
            Interlocked.Decrement(ref inside);
        }));
        Assert.Equal(1, max);
    }
}
