using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Text;
using System.Text.Json;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public sealed class MapAssetDiagnosticEvent
{
    public string ResolverVersion { get; init; } = "";
    public long MapId { get; init; }
    public string MapName { get; init; } = "";
    public long MapArtId { get; init; }
    public int LayerIndex { get; init; }
    public string WowBuildFingerprint { get; init; } = "";
    public bool Success { get; init; }
    public bool FromCache { get; init; }
    public string StorageLabel { get; init; } = "";
    public string AssetMode { get; init; } = "";
    public string Stage { get; init; } = "";
    public int DurationMs { get; init; }
    public string Status { get; init; } = "";
    public object Details { get; init; } = new { };
}

public static class MapAssetDiagnosticUploader
{
    private static readonly HttpClient HttpClient = new()
    {
        Timeout = TimeSpan.FromSeconds(12)
    };

    public static async Task TryUploadAsync(
        CompanionSettings settings,
        MapAssetDiagnosticEvent diagnostic,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(settings.SupabaseUrl) ||
            string.IsNullOrWhiteSpace(settings.SupabaseKey))
        {
            return;
        }

        try
        {
            var auth =
                new SupabaseAuthService(
                    HttpClient,
                    settings);

            var accessToken =
                await auth.GetAccessTokenAsync(
                    cancellationToken);

            using var request =
                new HttpRequestMessage(
                    HttpMethod.Post,
                    $"{settings.SupabaseUrl.TrimEnd('/')}/rest/v1/map_asset_diagnostics");

            request.Headers.TryAddWithoutValidation(
                "apikey",
                settings.SupabaseKey);

            request.Headers.Authorization =
                new AuthenticationHeaderValue(
                    "Bearer",
                    accessToken);

            request.Headers.TryAddWithoutValidation(
                "Prefer",
                "return=minimal");

            request.Content =
                new StringContent(
                    JsonSerializer.Serialize(
                        new
                        {
                            companion_version =
                                GetCompanionVersion(),
                            resolver_version =
                                diagnostic.ResolverVersion,
                            map_id =
                                diagnostic.MapId,
                            map_name =
                                diagnostic.MapName,
                            map_art_id =
                                diagnostic.MapArtId,
                            layer_index =
                                diagnostic.LayerIndex,
                            wow_build_fingerprint =
                                diagnostic.WowBuildFingerprint,
                            success =
                                diagnostic.Success,
                            from_cache =
                                diagnostic.FromCache,
                            storage_label =
                                diagnostic.StorageLabel,
                            asset_mode =
                                diagnostic.AssetMode,
                            stage =
                                diagnostic.Stage,
                            duration_ms =
                                diagnostic.DurationMs,
                            status =
                                diagnostic.Status,
                            details =
                                diagnostic.Details
                        }),
                    Encoding.UTF8,
                    "application/json");

            using var response =
                await HttpClient.SendAsync(
                    request,
                    cancellationToken);

            // Diagnostics must never break normal Companion behavior.
            _ = response.IsSuccessStatusCode;
        }
        catch
        {
        }
    }

    private static string GetCompanionVersion()
    {
        try
        {
            var assembly =
                Assembly.GetExecutingAssembly();

            var info =
                assembly.GetCustomAttribute<
                    AssemblyInformationalVersionAttribute>();

            if (!string.IsNullOrWhiteSpace(
                    info?.InformationalVersion))
            {
                return info.InformationalVersion;
            }

            return
                assembly.GetName().Version?.ToString()
                ?? "";
        }
        catch
        {
            return "";
        }
    }
}
