using System.Net;
using System.Text;
using System.Text.Json;
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

var handler = new FakeSearchHandler();
using var httpClient = new HttpClient(handler);
var settings = new CompanionSettings
{
    SupabaseUrl = "https://example.supabase.co",
    SupabaseKey = "sb_publishable_test"
};
var service = new SearchService(httpClient, settings);

var zones = await service.GetAvailableZonesAsync();

Check(zones.Count == 3,
    "zone list contains All zones plus unique valid zones");
Check(zones[0].IsAllZones &&
      zones[0].DisplayText == "All zones",
    "All zones is the first explicit default");
Check(zones[1].ZoneName == "Crusader's Outpost" &&
      zones[1].MapId == 1420,
    "zones sort by display name");
Check(zones[2].ZoneName == "Tirisfal Glades" &&
      zones[2].MapId == 1420,
    "same map id can expose multiple distinct zone names");

handler.ClearRequests();

var allZoneResults =
    await service.SearchAsync(
        "123",
        SearchZoneOption.AllZones);

Check(handler.Requests.Count == 2,
    "All zones performs the existing two catalog queries");
Check(handler.Requests.All(request => request.Method == "GET"),
    "All zones does not call the zone RPC");
Check(handler.Requests.Any(
        request => request.Url.Contains("item_id.eq.123", StringComparison.Ordinal)),
    "All zones preserves numeric item ID search");
Check(handler.Requests.Any(
        request => request.Url.Contains("source_id.eq.123", StringComparison.Ordinal)),
    "All zones preserves numeric source ID search");
Check(allZoneResults.Count == 2,
    "All zones returns item and source results");
Check(allZoneResults.Any(
        result =>
            result.Kind == SearchEntityKind.Item &&
            result.ItemId == 123),
    "All zones item result is preserved");
Check(allZoneResults.Any(
        result =>
            result.Kind == SearchEntityKind.Source &&
            result.SourceId == 123 &&
            result.SourceLevel == 7),
    "All zones source result is preserved");

handler.ClearRequests();

var tirisfal =
    new SearchZoneOption
    {
        MapId = 1420,
        ZoneName = "Tirisfal Glades"
    };

var scopedResults =
    await service.SearchAsync(
        "Cadet",
        tirisfal);

Check(handler.Requests.Count == 1,
    "specific zone uses one scoped RPC request");
Check(handler.Requests[0].Method == "POST" &&
      handler.Requests[0].Url.EndsWith(
          "/rest/v1/rpc/get_foreverdb_search_in_zone",
          StringComparison.Ordinal),
    "specific zone calls the scoped search RPC");
Check(handler.Requests[0].Body.Contains(
        "\"p_query\":\"Cadet\"",
        StringComparison.Ordinal),
    "specific zone forwards the name query");
Check(handler.Requests[0].Body.Contains(
        "\"p_map_id\":1420",
        StringComparison.Ordinal),
    "specific zone forwards map id");
Check(handler.Requests[0].Body.Contains(
        "\"p_zone_name\":\"Tirisfal Glades\"",
        StringComparison.Ordinal),
    "specific zone forwards zone name");
Check(scopedResults.Count == 2 &&
      scopedResults.All(
          result =>
              result.Name.Contains(
                  "Cadet",
                  StringComparison.OrdinalIgnoreCase)),
    "specific zone returns only RPC-scoped matches");

handler.ClearRequests();

var crusadersOutpost =
    new SearchZoneOption
    {
        MapId = 1420,
        ZoneName = "Crusader's Outpost"
    };

await service.SearchAsync(
    "Cadet",
    crusadersOutpost);

using (var requestBody =
       JsonDocument.Parse(handler.Requests[0].Body))
{
    Check(
        requestBody.RootElement
            .GetProperty("p_zone_name")
            .GetString() == "Crusader's Outpost",
        "zone name disambiguates zones that share the same map id");
}

if (failures.Count > 0)
{
    Console.Error.WriteLine(
        $"Companion search-zone checks FAILED ({failures.Count}):");

    foreach (var failure in failures)
    {
        Console.Error.WriteLine($" - {failure}");
    }

    return 1;
}

Console.WriteLine(
    $"Companion search-zone checks PASS ({assertionCount} assertions).");
return 0;

sealed record CapturedRequest(
    string Method,
    string Url,
    string Body);

sealed class FakeSearchHandler : HttpMessageHandler
{
    public List<CapturedRequest> Requests { get; } = new();

    public void ClearRequests() => Requests.Clear();

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        var body =
            request.Content is null
                ? ""
                : await request.Content.ReadAsStringAsync(
                    cancellationToken);

        Requests.Add(
            new CapturedRequest(
                request.Method.Method,
                request.RequestUri?.ToString() ?? "",
                body));

        var path =
            request.RequestUri?.AbsolutePath ?? "";

        var json =
            path.EndsWith(
                "/rest/v1/rpc/get_foreverdb_search_zones",
                StringComparison.Ordinal)
                ? """
                  [
                    {"map_id":1420,"zone_name":"Tirisfal Glades"},
                    {"map_id":1420,"zone_name":"Tirisfal Glades"},
                    {"map_id":1420,"zone_name":"Crusader's Outpost"},
                    {"map_id":0,"zone_name":"Invalid"},
                    {"map_id":1412,"zone_name":""}
                  ]
                  """
                : path.EndsWith(
                    "/rest/v1/rpc/get_foreverdb_search_in_zone",
                    StringComparison.Ordinal)
                    ? IsCrusadersOutpost(body)
                        ? "[]"
                        : """
                          [
                            {"entity_kind":"item","item_id":9762,"source_type":null,"source_id":null,"source_level":null,"name":"Cadet Gauntlets"},
                            {"entity_kind":"item","item_id":8179,"source_type":null,"source_id":null,"source_level":null,"name":"Cadet's Bow"}
                          ]
                          """
                    : path.EndsWith(
                        "/rest/v1/items",
                        StringComparison.Ordinal)
                        ? """[{"item_id":123,"name":"Test Item"}]"""
                        : path.EndsWith(
                            "/rest/v1/sources",
                            StringComparison.Ordinal)
                            ? """[{"source_type":"creature","source_id":123,"source_level":7,"name":"Test Source"}]"""
                            : "[]";

        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                json,
                Encoding.UTF8,
                "application/json")
        };
    }

    private static bool IsCrusadersOutpost(string body)
    {
        using var document = JsonDocument.Parse(body);

        return document.RootElement
            .TryGetProperty("p_zone_name", out var zoneName) &&
            zoneName.GetString() == "Crusader's Outpost";
    }
}
