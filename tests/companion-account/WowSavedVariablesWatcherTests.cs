using ForeverDB.Companion.Services;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public sealed class WowSavedVariablesWatcherTests
{
    [Fact]
    public async Task Locked_in_progress_write_is_not_dispatched_until_the_completed_file_can_be_read()
    {
        var root = TestEnv.NewDirectory();
        var savedVariables = Path.Combine(root, "WTF", "Account", "TEST", "SavedVariables");
        Directory.CreateDirectory(savedVariables);
        var path = Path.Combine(savedVariables, "ForeverDB.lua");
        var dispatched = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);

        using var watcher = new WowSavedVariablesWatcher(
            root,
            (changed, _) =>
            {
                dispatched.TrySetResult(changed);
                return Task.CompletedTask;
            });
        watcher.Start();

        await using (var writer = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            await writer.WriteAsync("ForeverDB_Export = \"H|9|0.5.0-alpha|inst-test|100"u8.ToArray());
            await writer.FlushAsync();

            await Task.Delay(TimeSpan.FromMilliseconds(1900));
            Assert.False(dispatched.Task.IsCompleted, "an in-progress SavedVariables write must not reach the sync callback");

            await writer.WriteAsync("\\nS|creature|1|1|Wolf\""u8.ToArray());
        }

        var completedPath = await dispatched.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(path, completedPath);
    }
}
