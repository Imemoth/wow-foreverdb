using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public sealed class StatsService
{
    private readonly HttpClient _httpClient;
    private readonly CompanionSettings _settings;
    private readonly Func<CancellationToken, Task<string>> _accessTokenProvider;

    public StatsService(
        HttpClient httpClient,
        CompanionSettings settings,
        Func<CancellationToken, Task<string>> accessTokenProvider)
    {
        _httpClient = httpClient;
        _settings = settings;
        _accessTokenProvider = accessTokenProvider ??
            throw new ArgumentNullException(nameof(accessTokenProvider));
    }

    public Task<JsonElement> GetItemStatsAsync(
        long itemId,
        CancellationToken cancellationToken = default)
    {
        return PostAsync(
            "get_foreverdb_item_stats",
            new { p_item_id = itemId },
            cancellationToken);
    }

    public Task<JsonElement> GetSourceStatsAsync(
        string sourceType,
        long sourceId,
        int sourceLevel,
        CancellationToken cancellationToken = default)
    {
        return PostAsync(
            "get_foreverdb_source_stats",
            new
            {
                p_source_type = sourceType,
                p_source_id = sourceId,
                p_source_level = sourceLevel
            },
            cancellationToken);
    }

    private async Task<JsonElement> PostAsync(
        string functionName,
        object body,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"{_settings.SupabaseUrl.TrimEnd('/')}/rest/v1/rpc/{functionName}");

        request.Headers.TryAddWithoutValidation(
            "apikey",
            _settings.SupabaseKey);

        var accessToken = await _accessTokenProvider(cancellationToken);
        request.Headers.Authorization =
            new AuthenticationHeaderValue(
                "Bearer",
                accessToken);

        request.Content = new StringContent(
            JsonSerializer.Serialize(body),
            Encoding.UTF8,
            "application/json");

        using var response = await _httpClient.SendAsync(
            request,
            cancellationToken);

        var json = await response.Content.ReadAsStringAsync(
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                response.StatusCode == System.Net.HttpStatusCode.TooManyRequests
                    ? "ForeverDB API limit reached; retry in a minute."
                    : $"Stats query rejected (HTTP {(int)response.StatusCode}).");
        }

        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }
}
