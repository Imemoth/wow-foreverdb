using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public sealed class SyncService
{
    private readonly HttpClient _httpClient;
    private readonly CompanionSettings _settings;
    private readonly SupabaseAuthService _authService;
    private readonly ForeverDbExportParser _parser = new();

    private readonly Dictionary<string, long> _lastSyncedSnapshot =
        new(StringComparer.OrdinalIgnoreCase);

    public event EventHandler<string>? StatusChanged;

    public SyncService(
        HttpClient httpClient,
        CompanionSettings settings,
        SupabaseAuthService authService)
    {
        _httpClient = httpClient;
        _settings = settings;
        _authService = authService;
    }

    public async Task SyncFileAsync(
        string path,
        CancellationToken cancellationToken = default)
    {
        if (!File.Exists(path))
        {
            return;
        }

        var snapshot = _parser.ParseSavedVariables(path);

        if (_lastSyncedSnapshot.TryGetValue(
                snapshot.InstallationId,
                out var lastTimestamp) &&
            snapshot.UpdatedAt <= lastTimestamp)
        {
            return;
        }

        var accessToken = await _authService.GetAccessTokenAsync(
            cancellationToken);

        var url =
            $"{_settings.SupabaseUrl.TrimEnd('/')}/rest/v1/rpc/ingest_foreverdb_snapshot_auth";

        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            url);

        request.Headers.TryAddWithoutValidation(
            "apikey",
            _settings.SupabaseKey);

        request.Headers.Authorization =
            new AuthenticationHeaderValue(
                "Bearer",
                accessToken);

        request.Content = new StringContent(
            JsonSerializer.Serialize(
                new
                {
                    p_snapshot = snapshot
                },
                new JsonSerializerOptions
                {
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
                }),
            Encoding.UTF8,
            "application/json");

        using var response = await _httpClient.SendAsync(
            request,
            cancellationToken);

        var body = await response.Content.ReadAsStringAsync(
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"ForeverDB sync failed: {(int)response.StatusCode} {body}");
        }

        _lastSyncedSnapshot[snapshot.InstallationId] =
            snapshot.UpdatedAt;

        StatusChanged?.Invoke(
            this,
            $"Synced {snapshot.Sources.Count} sources at {DateTime.Now:T}");
    }
}
