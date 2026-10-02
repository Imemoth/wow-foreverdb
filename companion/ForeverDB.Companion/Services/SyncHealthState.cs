using System.Text.RegularExpressions;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public enum SyncTrigger
{
    Startup,
    Auto,
    Manual
}

public sealed class SyncHealthState
{
    private const int MaxErrorLength = 180;

    private static readonly Regex SecretPattern = new(
        @"(?i)\b(?:bearer|apikey|access_token|refresh_token|token)\b\s*[:=]?\s*[^\s,;]+",
        RegexOptions.Compiled);

    private static readonly Regex SupabaseKeyPattern = new(
        @"\bsb_[A-Za-z0-9._-]+\b",
        RegexOptions.Compiled);

    private static readonly Regex JwtPattern = new(
        @"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b",
        RegexOptions.Compiled);

    private static readonly Regex WindowsPathPattern = new(
        @"(?i)(?:[A-Z]:\\|\\\\)[^""'\r\n]+",
        RegexOptions.Compiled);

    private static readonly Regex WhitespacePattern = new(
        @"\s+",
        RegexOptions.Compiled);

    public bool AutoSyncEnabled { get; private set; }
    public bool ConfigurationReady { get; private set; }
    public bool WatcherReady { get; private set; }
    public bool SupabaseReady { get; private set; }
    public bool AuthReady { get; private set; }
    public DateTimeOffset? LastSuccessfulSyncAt { get; private set; }
    public int LastSourceCount { get; private set; }
    public int LastGuildMemberCount { get; private set; }
    public SyncTrigger? LastTrigger { get; private set; }
    public string LastError { get; private set; } = "";

    public void Configure(CompanionSettings settings)
    {
        AutoSyncEnabled = settings.AutoSync;

        var wowConfigured =
            !string.IsNullOrWhiteSpace(settings.WowRoot);

        var supabaseUrlConfigured =
            Uri.TryCreate(
                settings.SupabaseUrl,
                UriKind.Absolute,
                out var supabaseUri) &&
            (supabaseUri.Scheme == Uri.UriSchemeHttps ||
             supabaseUri.IsLoopback);

        SupabaseReady =
            supabaseUrlConfigured &&
            !string.IsNullOrWhiteSpace(settings.SupabaseKey);

        ConfigurationReady =
            wowConfigured &&
            SupabaseReady;

        WatcherReady = false;
        AuthReady = false;
        LastError = "";
    }

    public void SetWatcherReady(bool ready)
    {
        WatcherReady =
            AutoSyncEnabled &&
            ConfigurationReady &&
            ready;
    }

    public void SetAuthReady(bool ready)
    {
        AuthReady =
            SupabaseReady &&
            ready;
    }

    public void MarkSyncSuccess(
        DateTimeOffset completedAt,
        int sourceCount,
        int guildMemberCount,
        SyncTrigger trigger)
    {
        LastSuccessfulSyncAt = completedAt;
        LastSourceCount = Math.Max(0, sourceCount);
        LastGuildMemberCount = Math.Max(0, guildMemberCount);
        LastTrigger = trigger;
        AuthReady = SupabaseReady;
        LastError = "";
    }

    public string MarkError(
        string? message,
        CompanionSettings settings)
    {
        LastError = SanitizeError(
            message,
            settings);

        return LastError;
    }

    public static string SanitizeError(
        string? message,
        CompanionSettings settings)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            return "Unknown sync error.";
        }

        var sanitized = message;

        if (!string.IsNullOrWhiteSpace(settings.SupabaseKey))
        {
            sanitized = sanitized.Replace(
                settings.SupabaseKey,
                "[key redacted]",
                StringComparison.Ordinal);
        }

        if (!string.IsNullOrWhiteSpace(settings.WowRoot))
        {
            sanitized = sanitized.Replace(
                settings.WowRoot.TrimEnd(
                    Path.DirectorySeparatorChar,
                    Path.AltDirectorySeparatorChar),
                "[path redacted]",
                StringComparison.OrdinalIgnoreCase);
        }

        sanitized = SecretPattern.Replace(
            sanitized,
            match =>
                $"{match.Value.Split(new[] { ' ', ':', '=' }, StringSplitOptions.RemoveEmptyEntries)[0]} [redacted]");

        sanitized = SupabaseKeyPattern.Replace(
            sanitized,
            "[key redacted]");

        sanitized = JwtPattern.Replace(
            sanitized,
            "[token redacted]");

        sanitized = WindowsPathPattern.Replace(
            sanitized,
            "[path redacted]");

        sanitized = WhitespacePattern.Replace(
            sanitized,
            " ").Trim();

        if (sanitized.Length > MaxErrorLength)
        {
            sanitized =
                sanitized[..(MaxErrorLength - 1)] +
                "…";
        }

        return sanitized;
    }
}
