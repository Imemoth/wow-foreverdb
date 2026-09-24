using System.Net.Http.Headers;
using System.Text.Json;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public sealed class SearchService
{
    private readonly HttpClient _httpClient;
    private readonly CompanionSettings _settings;

    public SearchService(
        HttpClient httpClient,
        CompanionSettings settings)
    {
        _httpClient = httpClient;
        _settings = settings;
    }

    public async Task<IReadOnlyList<string>> SearchAsync(
        string query,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            return Array.Empty<string>();
        }

        var encoded = Uri.EscapeDataString($"*{query.Trim()}*");

        var items = await GetAsync(
            $"/rest/v1/items?select=item_id,name&name=ilike.{encoded}&limit=20",
            cancellationToken);

        var sources = await GetAsync(
            $"/rest/v1/sources?select=source_type,source_id,source_level,name&name=ilike.{encoded}&limit=20",
            cancellationToken);

        var results = new List<string>();

        foreach (var item in items.EnumerateArray())
        {
            results.Add(
                $"Item #{item.GetProperty("item_id").GetInt64()} — {item.GetProperty("name").GetString()}");
        }

        foreach (var source in sources.EnumerateArray())
        {
            var level = source.GetProperty("source_level").GetInt32();
            var suffix = level > 0 ? $" (Lvl {level})" : "";

            results.Add(
                $"{source.GetProperty("name").GetString()}{suffix} [{source.GetProperty("source_type").GetString()}]");
        }

        return results;
    }

    private async Task<JsonElement> GetAsync(
        string path,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            $"{_settings.SupabaseUrl.TrimEnd('/')}{path}");

        request.Headers.TryAddWithoutValidation(
            "apikey",
            _settings.SupabaseKey);

        request.Headers.Authorization =
            new AuthenticationHeaderValue(
                "Bearer",
                _settings.SupabaseKey);

        using var response = await _httpClient.SendAsync(
            request,
            cancellationToken);

        var body = await response.Content.ReadAsStringAsync(
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"Search failed: {(int)response.StatusCode} {body}");
        }

        using var document = JsonDocument.Parse(body);
        return document.RootElement.Clone();
    }
}
