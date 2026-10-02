using ForeverDB.Companion.Models;
using ForeverDB.Companion.Services;

var failures = new List<string>();
var assertionCount = 0;

void Check(bool condition, string name)
{
    assertionCount++;

    if (!condition)
    {
        failures.Add(name);
    }
}

var settings = new CompanionSettings
{
    WowRoot = @"C:\Games\World of Warcraft\_classic_",
    SupabaseUrl = "https://example.supabase.co",
    SupabaseKey = "sb_publishable_test-secret",
    AutoSync = true
};

var health = new SyncHealthState();
health.Configure(settings);

Check(health.AutoSyncEnabled, "auto sync reflects settings");
Check(health.ConfigurationReady, "valid configuration is ready");
Check(health.SupabaseReady, "Supabase configuration is ready");
Check(!health.WatcherReady, "watcher is not ready before start");
Check(!health.AuthReady, "auth is pending before successful sync");

health.SetWatcherReady(true);
Check(health.WatcherReady, "watcher readiness can be reported");

health.MarkError(
    "Bearer abc.def C:\\Users\\Peter\\SavedVariables sb_publishable_test-secret\nrequest failed",
    settings);

Check(!health.LastError.Contains("abc.def", StringComparison.Ordinal),
    "bearer token is redacted");
Check(!health.LastError.Contains("sb_publishable_test-secret", StringComparison.Ordinal),
    "Supabase key is redacted");
Check(!health.LastError.Contains(@"C:\Users\Peter", StringComparison.OrdinalIgnoreCase),
    "filesystem path is redacted");
Check(!health.LastError.Contains('\n'),
    "error is collapsed to one line");
Check(health.LastError.Length <= 180,
    "error is bounded");

var completedAt = new DateTimeOffset(
    2026, 10, 1, 9, 30, 0, TimeSpan.FromHours(2));

health.MarkSyncSuccess(
    completedAt,
    sourceCount: 123,
    guildMemberCount: 45,
    SyncTrigger.Manual);

Check(health.LastSuccessfulSyncAt == completedAt,
    "last successful sync timestamp is tracked");
Check(health.LastSourceCount == 123,
    "source count is tracked");
Check(health.LastGuildMemberCount == 45,
    "guild member count is tracked");
Check(health.LastTrigger == SyncTrigger.Manual,
    "last successful sync trigger is tracked");
Check(health.AuthReady,
    "successful sync marks auth ready");
Check(string.IsNullOrEmpty(health.LastError),
    "successful sync clears previous error");

settings.AutoSync = false;
health.Configure(settings);
health.SetWatcherReady(true);

Check(!health.AutoSyncEnabled,
    "disabled auto sync reflects settings");
Check(!health.WatcherReady,
    "watcher cannot report ready when auto sync is disabled");

if (failures.Count > 0)
{
    Console.Error.WriteLine(
        $"Companion sync-health checks FAILED ({failures.Count}):");

    foreach (var failure in failures)
    {
        Console.Error.WriteLine($" - {failure}");
    }

    return 1;
}

Console.WriteLine($"Companion sync-health checks PASS ({assertionCount} assertions).");
return 0;
