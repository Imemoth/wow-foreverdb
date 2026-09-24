using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public sealed class LocationService
{
    private readonly HttpClient _httpClient;
    private readonly CompanionSettings _settings;

    public LocationService(
        HttpClient httpClient,
        CompanionSettings settings)
    {
        _httpClient = httpClient;
        _settings = settings;
    }

    public Task<IReadOnlyList<DetailLocation>> GetItemLocationsAsync(
        long itemId,
        CancellationToken cancellationToken = default)
    {
        return PostAsync(
            "get_foreverdb_item_locations",
            new { p_item_id = itemId },
            cancellationToken);
    }

    public Task<IReadOnlyList<DetailLocation>> GetSourceLocationsAsync(
        string sourceType,
        long sourceId,
        int sourceLevel,
        CancellationToken cancellationToken = default)
    {
        return PostAsync(
            "get_foreverdb_source_locations",
            new
            {
                p_source_type = sourceType,
                p_source_id = sourceId,
                p_source_level = sourceLevel
            },
            cancellationToken);
    }

    private async Task<IReadOnlyList<DetailLocation>> PostAsync(
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

        request.Headers.Authorization =
            new AuthenticationHeaderValue(
                "Bearer",
                _settings.SupabaseKey);

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
                $"Location query failed: {(int)response.StatusCode} {json}");
        }

        using var document = JsonDocument.Parse(json);
        var locations = new List<DetailLocation>();

        foreach (var element in document.RootElement.EnumerateArray())
        {
            locations.Add(
                new DetailLocation
                {
                    SourceType = GetString(element, "source_type"),
                    SourceId = GetInt64(element, "source_id"),
                    SourceLevel = GetInt32(element, "source_level"),
                    LootKind = GetString(element, "loot_kind"),
                    MapId = GetInt64(element, "map_id"),
                    ZoneName = GetString(element, "zone_name", "Unknown zone"),
                    SubZoneName = GetString(element, "subzone_name"),
                    X = GetDouble(element, "x"),
                    Y = GetDouble(element, "y"),
                    Observations = GetInt64(element, "observations")
                });
        }

        return locations
            .OrderBy(location => location.ZoneName)
            .ThenBy(location => location.SubZoneName)
            .ThenByDescending(location => location.Observations)
            .ThenBy(location => location.X)
            .ThenBy(location => location.Y)
            .ToArray();
    }

    private static string GetString(
        JsonElement element,
        string property,
        string fallback = "")
    {
        if (!element.TryGetProperty(property, out var value) ||
            value.ValueKind == JsonValueKind.Null)
        {
            return fallback;
        }

        return value.GetString() ?? fallback;
    }

    private static long GetInt64(
        JsonElement element,
        string property)
    {
        return element.TryGetProperty(property, out var value) &&
               value.ValueKind != JsonValueKind.Null
            ? value.GetInt64()
            : 0;
    }

    private static int GetInt32(
        JsonElement element,
        string property)
    {
        return element.TryGetProperty(property, out var value) &&
               value.ValueKind != JsonValueKind.Null
            ? value.GetInt32()
            : 0;
    }

    private static double GetDouble(
        JsonElement element,
        string property)
    {
        if (!element.TryGetProperty(property, out var value) ||
            value.ValueKind == JsonValueKind.Null)
        {
            return 0d;
        }

        if (value.ValueKind == JsonValueKind.Number &&
            value.TryGetDouble(out var number))
        {
            return number;
        }

        if (value.ValueKind == JsonValueKind.String &&
            double.TryParse(
                value.GetString(),
                System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture,
                out number))
        {
            return number;
        }

        return 0d;
    }
}
