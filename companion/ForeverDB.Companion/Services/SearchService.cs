using System.Net.Http;
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

    public async Task<IReadOnlyList<SearchResultItem>> SearchAsync(
        string query,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            return Array.Empty<SearchResultItem>();
        }

        var trimmed = query.Trim();
        var encoded = Uri.EscapeDataString($"*{trimmed}*");

        var itemPath =
            $"/rest/v1/items?select=item_id,name&name=ilike.{encoded}&limit=20";

        var sourcePath =
            $"/rest/v1/sources?select=source_type,source_id,source_level,name&name=ilike.{encoded}&limit=20";

        if (long.TryParse(trimmed, out var numericId))
        {
            itemPath =
                $"/rest/v1/items?select=item_id,name&or=(item_id.eq.{numericId},name.ilike.{encoded})&limit=20";

            sourcePath =
                $"/rest/v1/sources?select=source_type,source_id,source_level,name&or=(source_id.eq.{numericId},name.ilike.{encoded})&limit=20";
        }

        var itemsTask = GetAsync(itemPath, cancellationToken);
        var sourcesTask = GetAsync(sourcePath, cancellationToken);

        await Task.WhenAll(itemsTask, sourcesTask);

        var items = await itemsTask;
        var sources = await sourcesTask;

        var results = new List<SearchResultItem>();

        foreach (var item in items.EnumerateArray())
        {
            var itemId = item.GetProperty("item_id").GetInt64();
            var name = GetString(item, "name", $"Item #{itemId}");

            results.Add(
                new SearchResultItem
                {
                    Kind = SearchEntityKind.Item,
                    ItemId = itemId,
                    Name = name,
                    DisplayText = $"Item #{itemId} — {name}"
                });
        }

        foreach (var source in sources.EnumerateArray())
        {
            var type = GetString(source, "source_type", "source");
            var id = source.GetProperty("source_id").GetInt64();
            var level = source.GetProperty("source_level").GetInt32();
            var name = GetString(source, "name", $"{type} #{id}");
            var levelText = level > 0 ? $" (Lvl {level})" : "";

            results.Add(
                new SearchResultItem
                {
                    Kind = SearchEntityKind.Source,
                    SourceType = type,
                    SourceId = id,
                    SourceLevel = level,
                    Name = name,
                    DisplayText =
                        $"{name}{levelText} [{FormatSourceType(type)}]"
                });
        }

        return results
            .OrderBy(
                result => string.Equals(
                    result.Name,
                    trimmed,
                    StringComparison.OrdinalIgnoreCase)
                    ? 0
                    : 1)
            .ThenBy(result => result.Kind)
            .ThenBy(result => result.Name)
            .ThenBy(result => result.SourceLevel)
            .ToArray();
    }

    public async Task<EntityDetail> GetDetailAsync(
        SearchResultItem result,
        CancellationToken cancellationToken = default)
    {
        return result.Kind == SearchEntityKind.Item
            ? await GetItemDetailAsync(result, cancellationToken)
            : await GetSourceDetailAsync(result, cancellationToken);
    }

    private async Task<EntityDetail> GetItemDetailAsync(
        SearchResultItem result,
        CancellationToken cancellationToken)
    {
        var data = await GetAsync(
            "/rest/v1/observed_loot_stats" +
            "?select=source_type,source_id,source_level,source_name,loot_kind,item_id,item_name,observations,drop_count,quantity,quest_drop_count,observed_drop_rate" +
            $"&item_id=eq.{result.ItemId}",
            cancellationToken);

        var rows = ParseObservedRows(data);

        rows = HideHistoricalRowsWhenExactLevelExists(rows);

        var groups = rows
            .GroupBy(row => row.LootKind)
            .OrderBy(group => LootKindOrder(group.Key))
            .Select(
                group => new DetailGroup
                {
                    Key = group.Key,
                    Title = ItemGroupTitle(group.Key),
                    Rows = group
                        .OrderByDescending(row => row.ConfidenceScore)
                        .ThenByDescending(row => row.Observations)
                        .ThenBy(row => row.Name)
                        .Select(ToDetailRow)
                        .ToArray()
                })
            .ToArray();

        var sourceCount = rows.Count;

        return new EntityDetail
        {
            Title = $"{result.Name}",
            Subtitle =
                $"Item #{result.ItemId} · {sourceCount} observed source row(s)",
            Groups = groups
        };
    }

    private async Task<EntityDetail> GetSourceDetailAsync(
        SearchResultItem result,
        CancellationToken cancellationToken)
    {
        var type = Uri.EscapeDataString(result.SourceType);

        var data = await GetAsync(
            "/rest/v1/observed_loot_stats" +
            "?select=source_type,source_id,source_level,source_name,loot_kind,item_id,item_name,observations,drop_count,quantity,quest_drop_count,observed_drop_rate" +
            $"&source_type=eq.{type}" +
            $"&source_id=eq.{result.SourceId}" +
            $"&source_level=eq.{result.SourceLevel}",
            cancellationToken);

        var rows = ParseObservedRows(data);

        var groups = rows
            .GroupBy(row => row.LootKind)
            .OrderBy(group => LootKindOrder(group.Key))
            .Select(
                group => new DetailGroup
                {
                    Key = group.Key,
                    Title = SourceGroupTitle(group.Key),
                    Rows = group
                        .OrderByDescending(row => row.ConfidenceScore)
                        .ThenByDescending(row => row.Observations)
                        .ThenBy(row => row.Name)
                        .Select(ToDetailRow)
                        .ToArray()
                })
            .ToArray();

        var level =
            result.SourceLevel > 0
                ? $"Level {result.SourceLevel}"
                : "Historical / level unknown";

        return new EntityDetail
        {
            Title = result.Name,
            Subtitle =
                $"{FormatSourceType(result.SourceType)} #{result.SourceId} · {level}",
            Groups = groups
        };
    }

    private static List<ObservedRow> ParseObservedRows(JsonElement data)
    {
        var rows = new List<ObservedRow>();

        foreach (var element in data.EnumerateArray())
        {
            var observations = GetInt64(element, "observations");
            var drops = GetInt64(element, "drop_count");
            var rate =
                observations > 0
                    ? (double)drops / observations
                    : 0d;

            rows.Add(
                new ObservedRow
                {
                    SourceType =
                        GetString(element, "source_type", "source"),
                    SourceId =
                        GetInt64(element, "source_id"),
                    SourceLevel =
                        GetInt32(element, "source_level"),
                    SourceName =
                        GetString(
                            element,
                            "source_name",
                            "Unknown source"),
                    LootKind =
                        GetString(element, "loot_kind", "other"),
                    ItemId =
                        GetInt64(element, "item_id"),
                    ItemName =
                        GetString(element, "item_name", "Unknown item"),
                    Observations = observations,
                    Drops = drops,
                    Quantity = GetInt64(element, "quantity"),
                    QuestDrops =
                        GetInt64(element, "quest_drop_count"),
                    RatePercent = rate * 100d,
                    ConfidenceScore =
                        WilsonLowerBound(drops, observations)
                });
        }

        return rows;
    }

    private static List<ObservedRow> HideHistoricalRowsWhenExactLevelExists(
        List<ObservedRow> rows)
    {
        var exactKeys = rows
            .Where(row => row.SourceLevel > 0)
            .Select(
                row =>
                    $"{row.SourceType}|{row.SourceId}|{row.LootKind}|{row.ItemId}")
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        return rows
            .Where(
                row =>
                    row.SourceLevel > 0 ||
                    !exactKeys.Contains(
                        $"{row.SourceType}|{row.SourceId}|{row.LootKind}|{row.ItemId}"))
            .ToList();
    }

    private static DetailRow ToDetailRow(ObservedRow row)
    {
        var isSourceRow =
            !string.IsNullOrWhiteSpace(row.SourceName);

        return new DetailRow
        {
            Name =
                isSourceRow
                    ? row.SourceName
                    : row.ItemName,
            Level =
                row.SourceLevel > 0
                    ? row.SourceLevel.ToString()
                    : "—",
            SourceType = row.SourceType,
            Drops = row.Drops,
            Observations = row.Observations,
            Quantity = row.Quantity,
            QuestDrops = row.QuestDrops,
            RatePercent = row.RatePercent,
            ConfidenceScore = row.ConfidenceScore
        };
    }

    private static double WilsonLowerBound(
        long successes,
        long observations)
    {
        if (observations <= 0)
        {
            return 0d;
        }

        const double z = 1.96d;
        var n = (double)observations;
        var p = Math.Clamp(successes / n, 0d, 1d);
        var z2 = z * z;
        var denominator = 1d + z2 / n;
        var center = p + z2 / (2d * n);
        var margin =
            z *
            Math.Sqrt(
                (p * (1d - p) + z2 / (4d * n)) / n);

        return (center - margin) / denominator;
    }

    private static int LootKindOrder(string kind)
    {
        return kind.ToLowerInvariant() switch
        {
            "mob" => 10,
            "skinning" => 20,
            "gameobject" => 30,
            "chest" => 30,
            "fishing" => 40,
            "mining" => 50,
            "herbalism" => 60,
            _ => 100
        };
    }

    private static string ItemGroupTitle(string kind)
    {
        return kind.ToLowerInvariant() switch
        {
            "mob" => "Dropped by",
            "skinning" => "Skinned from",
            "gameobject" => "Contained in",
            "chest" => "Contained in",
            "fishing" => "Fished in",
            "mining" => "Mined from",
            "herbalism" => "Gathered from",
            _ => "Sources"
        };
    }

    private static string SourceGroupTitle(string kind)
    {
        return kind.ToLowerInvariant() switch
        {
            "mob" => "Drops",
            "skinning" => "Skinning",
            "gameobject" => "Contains",
            "chest" => "Contains",
            "fishing" => "Fishing",
            "mining" => "Mining",
            "herbalism" => "Herbalism",
            _ => "Observed items"
        };
    }

    private static string FormatSourceType(string type)
    {
        return type.ToLowerInvariant() switch
        {
            "creature" => "Creature",
            "gameobject" => "Object",
            "fishing" => "Fishing",
            _ => type
        };
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

    private static string GetString(
        JsonElement element,
        string property,
        string fallback)
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
        if (!element.TryGetProperty(property, out var value) ||
            value.ValueKind == JsonValueKind.Null)
        {
            return 0;
        }

        return value.GetInt64();
    }

    private static int GetInt32(
        JsonElement element,
        string property)
    {
        if (!element.TryGetProperty(property, out var value) ||
            value.ValueKind == JsonValueKind.Null)
        {
            return 0;
        }

        return value.GetInt32();
    }

    private sealed class ObservedRow
    {
        public string SourceType { get; init; } = "";
        public long SourceId { get; init; }
        public int SourceLevel { get; init; }
        public string SourceName { get; init; } = "";
        public string LootKind { get; init; } = "";
        public long ItemId { get; init; }
        public string ItemName { get; init; } = "";
        public long Observations { get; init; }
        public long Drops { get; init; }
        public long Quantity { get; init; }
        public long QuestDrops { get; init; }
        public double RatePercent { get; init; }
        public double ConfidenceScore { get; init; }
    }
}
