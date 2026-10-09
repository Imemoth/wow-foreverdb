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
var service = new SearchService(
    httpClient,
    settings,
    _ => Task.FromResult("test-auth-token"));

var zones = await service.GetAvailableZonesAsync();

Check(handler.Requests.Count == 1 &&
      handler.Requests[0].Bearer == "test-auth-token",
    "zone discovery requires a signed-in session token");
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

Check(handler.Requests.Count == 1,
    "All zones sends one bounded server-side global search RPC");
Check(handler.Requests[0].Method == "POST" &&
      handler.Requests[0].Url.EndsWith(
          "/rest/v1/rpc/get_foreverdb_search_global",
          StringComparison.Ordinal),
    "All zones has no direct PostgREST items/sources reads");
Check(handler.Requests[0].Body.Contains(
        "\"p_query\":\"123\"", StringComparison.Ordinal),
    "All zones preserves numeric ID query in bounded RPC");
Check(handler.Requests[0].Bearer == "test-auth-token",
    "All zones uses the signed-in Supabase JWT, never anon bearer");
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
var rejectedWildcard = await service.SearchAsync(
    "%", SearchZoneOption.AllZones);
var rejectedLong = await service.SearchAsync(
    new string('a', 120), SearchZoneOption.AllZones);
Check(rejectedWildcard.Count == 0 &&
      rejectedLong.Count == 0 &&
      handler.Requests.Count == 0,
    "malformed or expensive wildcard searches fail without any HTTP request");
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
Check(handler.Requests[0].Bearer == "test-auth-token",
    "scoped search carries authenticated JWT");
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

// Empty query + one known zone browses all observed items/sources in
// bounded pages; never silently truncates the zone to the old 20+20 RPC.
handler.ClearRequests();
var browseFirst = await service.BrowseZoneAsync(tirisfal);
Check(browseFirst.TotalCount == 63 &&
      browseFirst.Results.Count == 50,
    "first zone browse page returns 50/63 known entities");
Check(browseFirst.Results[0].ItemId == 5001 &&
      browseFirst.Results[49].ItemId == 5050,
    "zone catalog keeps server's deterministic result order");
Check(handler.Requests.Count == 1 &&
      handler.Requests[0].Method == "POST" &&
      handler.Requests[0].Url.EndsWith(
          "/rest/v1/rpc/get_foreverdb_zone_catalog",
          StringComparison.Ordinal),
    "zone browse calls dedicated catalog RPC once");
Check(handler.Requests[0].Bearer == "test-auth-token",
    "zone catalog requires the authenticated access token, not anon key");
using (var browseArgs = JsonDocument.Parse(handler.Requests[0].Body))
{
    Check(
        browseArgs.RootElement.GetProperty("p_map_id").GetInt64() == 1420 &&
        browseArgs.RootElement.GetProperty("p_zone_name").GetString() ==
            "Tirisfal Glades" &&
        browseArgs.RootElement.GetProperty("p_limit").GetInt32() == 50 &&
        browseArgs.RootElement.GetProperty("p_offset").GetInt32() == 0,
        "catalog RPC enforces zone identity and first-page limit/offset");
    Check(
        !browseArgs.RootElement.TryGetProperty("p_query", out _),
        "catalog browse never fakes an arbitrary wildcard query");
}

var browseSecond = await service.BrowseZoneAsync(tirisfal, offset: 50);
Check(browseSecond.TotalCount == 63 &&
      browseSecond.Results.Count == 13,
    "second zone browse page covers all remaining entities");
Check(browseSecond.Results[0].ItemId == 5051 &&
      browseSecond.Results[12].Kind == SearchEntityKind.Source &&
      browseSecond.Results[12].SourceId == 8000,
    "page boundary preserves both item and creature source identities");
Check(browseFirst.Results.Concat(browseSecond.Results)
    .Select(result =>
        result.Kind == SearchEntityKind.Item
            ? $"I:{result.ItemId}"
            : $"S:{result.SourceType}:{result.SourceId}:{result.SourceLevel}")
    .Distinct()
    .Count() == 63,
    "paginated browse has neither missing nor duplicate entities");
Check(handler.Requests[1].Bearer == "test-auth-token" &&
      handler.Requests[1].Body.Contains(
          "\"p_offset\":50", StringComparison.Ordinal),
    "next page authenticates and continues at the expected offset");

handler.ClearRequests();
var emptyBrowse = await service.BrowseZoneAsync(crusadersOutpost);
Check(emptyBrowse.TotalCount == 0 && emptyBrowse.Results.Count == 0,
    "zone with no observed entities safely returns empty page");
Check(handler.Requests.Count == 1,
    "empty-zone browse remains one bounded RPC call");

handler.ClearRequests();
var emptyGlobal = await service.SearchAsync(
    "", SearchZoneOption.AllZones);
Check(emptyGlobal.Count == 0 && handler.Requests.Count == 0,
    "All zones with empty query never downloads entire global catalog");
var emptyLegacy = await service.SearchAsync("", tirisfal);
Check(emptyLegacy.Count == 0 && handler.Requests.Count == 0,
    "legacy named search never silently performs a zone catalog scan");

var rejectsAllZones = false;
var rejectsNegativeOffset = false;

try
{
    await service.BrowseZoneAsync(SearchZoneOption.AllZones);
}
catch (ArgumentException)
{
    rejectsAllZones = true;
}

try
{
    await service.BrowseZoneAsync(tirisfal, -1);
}
catch (ArgumentException)
{
    rejectsNegativeOffset = true;
}

Check(rejectsAllZones && rejectsNegativeOffset &&
      handler.Requests.Count == 0,
    "invalid browse scopes/offsets fail before database access");

// A zone change refreshes the left-hand result objects, NOT the current
// item/source detail or the Back/Forward chain. The WPF handler suppresses
// selection events during this remapping.
var selectedItem = new SearchResultItem
{
    Kind = SearchEntityKind.Item,
    ItemId = 4758,
    Name = "Prairie Wolf Paw",
    DisplayText = "Prairie Wolf Paw"
};
var matchedItem = new SearchResultItem
{
    Kind = SearchEntityKind.Item,
    ItemId = 4758,
    Name = "Prairie Wolf Paw (updated)",
    DisplayText = "Prairie Wolf Paw (updated)"
};
var otherItem = new SearchResultItem
{
    Kind = SearchEntityKind.Item,
    ItemId = 2672,
    Name = "Stringy Wolf Meat",
    DisplayText = "Stringy Wolf Meat"
};

Check(
    ReferenceEquals(
        SearchResultSelection.FindMatching(
            new[] { otherItem, matchedItem },
            selectedItem),
        matchedItem),
    "zone refresh reselects matching item ID using new result instance");
Check(
    SearchResultSelection.FindMatching(
        new[] { otherItem }, selectedItem) is null,
    "an out-of-zone item is not incorrectly highlighted in filtered results");
Check(
    ReferenceEquals(
        SearchResultSelection.FindMatching(
            new[] { matchedItem }, selectedItem),
        matchedItem),
    "returning to a matching zone can restore the persistent root selection");
Check(
    SearchResultSelection.FindMatching(
        new[] { matchedItem }, null) is null,
    "a search without a selection does not auto-select any result");

var selectedCreature = new SearchResultItem
{
    Kind = SearchEntityKind.Source,
    SourceType = "creature",
    SourceId = 2959,
    SourceLevel = 8,
    Name = "Prairie Stalker"
};
var sameCreature = new SearchResultItem
{
    Kind = SearchEntityKind.Source,
    SourceType = "creature",
    SourceId = 2959,
    SourceLevel = 8,
    Name = "Prairie Stalker (refreshed)"
};
var differentLevel = new SearchResultItem
{
    Kind = SearchEntityKind.Source,
    SourceType = "creature",
    SourceId = 2959,
    SourceLevel = 6
};
var differentType = new SearchResultItem
{
    Kind = SearchEntityKind.Source,
    SourceType = "gameobject",
    SourceId = 2959,
    SourceLevel = 8
};

Check(
    ReferenceEquals(
        SearchResultSelection.FindMatching(
            new[] { differentLevel, differentType, sameCreature },
            selectedCreature),
        sameCreature),
    "source identity rebind preserves source type, ID and level");
Check(
    SearchResultSelection.FindMatching(
        new[] { differentLevel, differentType }, selectedCreature) is null,
    "other source levels/types cannot steal selected row on zone change");
Check(
    !SearchResultSelection.SameEntity(
        selectedItem, selectedCreature),
    "items and sources remain distinct entities in history and selection");
Check(
    SearchResultSelection.SameEntity(
        selectedItem, matchedItem),
    "display-name changes do not create a different navigation entity");
Check(
    SearchResultSelection.FindMatching(
        Array.Empty<SearchResultItem>(),
        selectedCreature) is null,
    "an empty zone result preserves detail outside the list without selection");

// Item ↔ source drilldown must navigate existing history instead of
// growing Copper Ore → Copper Vein → Copper Ore → ... forever.
var historyBack = new Stack<SearchResultItem>();
var historyForward = new Stack<SearchResultItem>();
SearchResultItem? historyCurrent = null;
var copperOre = new SearchResultItem
{
    Kind = SearchEntityKind.Item,
    ItemId = 2770,
    Name = "Copper Ore"
};
var shadowgem = new SearchResultItem
{
    Kind = SearchEntityKind.Item,
    ItemId = 1210,
    Name = "Shadowgem"
};
var copperVein = new SearchResultItem
{
    Kind = SearchEntityKind.Source,
    SourceType = "gameobject",
    SourceId = 1731,
    SourceLevel = 0,
    Name = "Copper Vein"
};
var copperOreRebound = new SearchResultItem
{
    Kind = SearchEntityKind.Item,
    ItemId = 2770,
    Name = "Copper Ore (fresh detail row)"
};

Check(SearchDetailHistory.FollowLink(
        copperOre, ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 0 && historyForward.Count == 0,
    "first detail opens with empty navigation history");

Check(SearchDetailHistory.FollowLink(
        copperVein, ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 1 && historyForward.Count == 0,
    "mined-from link records one parent for Copper Ore to Copper Vein");

Check(SearchDetailHistory.FollowLink(
        shadowgem, ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 2 && historyForward.Count == 0,
    "source-to-item link records a new Shadowgem detail");

Check(SearchDetailHistory.FollowLink(
        copperVein, ref historyCurrent, historyBack, historyForward) &&
      SearchResultSelection.SameEntity(historyCurrent!, copperVein) &&
      historyBack.Count == 1 &&
      historyForward.Count == 1 &&
      SearchResultSelection.SameEntity(historyForward.Peek(), shadowgem),
    "returning to already-seen Copper Vein behaves like Back, not a deeper breadcrumb");

Check(SearchDetailHistory.FollowLink(
        copperOreRebound, ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 0 && historyForward.Count == 2 &&
      SearchResultSelection.SameEntity(historyCurrent!, copperOre),
    "returning to Copper Ore uses stable ID, retains undo history via Forward");

Check(SearchDetailHistory.FollowLink(
        copperVein, ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 1 && historyForward.Count == 1,
    "re-following an undone source link behaves like Forward, not a duplicate");

Check(SearchDetailHistory.FollowLink(
        shadowgem, ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 2 && historyForward.Count == 0,
    "forward-history item can be opened via its source detail link");

Check(!SearchDetailHistory.FollowLink(
        shadowgem, ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 2 && historyForward.Count == 0,
    "clicking the same item/source does not add a breadcrumb or re-fetch");

Check(SearchDetailHistory.StepBack(
        ref historyCurrent, historyBack, historyForward) &&
      SearchResultSelection.SameEntity(historyCurrent!, copperVein) &&
      historyBack.Count == 1 && historyForward.Count == 1,
    "Back button remains consistent after a cyclic drilldown");
Check(SearchDetailHistory.StepForward(
        ref historyCurrent, historyBack, historyForward) &&
      SearchResultSelection.SameEntity(historyCurrent!, shadowgem) &&
      historyBack.Count == 2 && historyForward.Count == 0,
    "Forward button returns to the undone item after cyclic drilldown");

// Jump to an older non-adjacent ancestor: A -> B -> C -> A.
// It should be A (Back empty, Forward B then C), not A -> B -> C -> A.
Check(SearchDetailHistory.FollowLink(
        copperOre, ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 0 && historyForward.Count == 2 &&
      SearchResultSelection.SameEntity(historyForward.Peek(), copperVein),
    "jumping to a non-adjacent ancestor collapses all visited crumbs");

Check(SearchDetailHistory.FollowLink(
        shadowgem, ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 2 && historyForward.Count == 0,
    "a link to a deeper Forward entry restores both intervening pages");

Check(SearchDetailHistory.FollowLink(
        selectedItem, ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 3 && historyForward.Count == 0,
    "following a brand new entity adds exactly one breadcrumb");

// Same display name but a different entity KIND must not be folded away.
// Peacebloom item 2447 and its gameobject source 1618 are distinct pages.
var peaceItem = new SearchResultItem
{
    Kind = SearchEntityKind.Item,
    ItemId = 2447,
    Name = "Peacebloom"
};
var peaceNode = new SearchResultItem
{
    Kind = SearchEntityKind.Source,
    SourceType = "gameobject",
    SourceId = 1618,
    Name = "Peacebloom"
};

historyBack.Clear();
historyForward.Clear();
historyCurrent = peaceItem;

Check(SearchDetailHistory.FollowLink(
        peaceNode, ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 1,
    "Peacebloom item and same-name herb node remain separate entities");
Check(SearchDetailHistory.FollowLink(
        peaceItem, ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 0 && historyForward.Count == 1 &&
      SearchResultSelection.SameEntity(historyForward.Peek(), peaceNode),
    "Peacebloom Object to Peacebloom item returns Back rather than nesting");

historyBack.Clear();
historyForward.Clear();
historyCurrent = selectedCreature;

Check(SearchDetailHistory.FollowLink(
        differentLevel, ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 1,
    "equal source ID at another level is a distinct navigation target");
Check(SearchDetailHistory.FollowLink(
        differentType, ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 2,
    "equal source ID with another source type is a distinct navigation target");
Check(SearchDetailHistory.FollowLink(
        sameCreature, ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 0 && historyForward.Count == 2,
    "source identity folds the history despite renamed detail rows");

Check(!SearchDetailHistory.StepBack(
        ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 0 && historyForward.Count == 2,
    "Back at the first entry is a safe no-op");
Check(SearchDetailHistory.StepForward(
        ref historyCurrent, historyBack, historyForward) &&
      historyBack.Count == 1 && historyForward.Count == 1,
    "Forward still works for distinct source levels");
Check(SearchDetailHistory.FollowLink(
        otherItem, ref historyCurrent, historyBack, historyForward) &&
      historyForward.Count == 0 && historyBack.Count == 2,
    "new branch after stepping back clears stale Forward history");

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
    string Body,
    string Bearer);

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
                body,
                request.Headers.Authorization?.Parameter ?? ""));

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
                        "/rest/v1/rpc/get_foreverdb_zone_catalog",
                        StringComparison.Ordinal)
                    ? BuildZoneCatalog(body)
                : path.EndsWith(
                        "/rest/v1/rpc/get_foreverdb_search_global",
                        StringComparison.Ordinal)
                    ? """
                      [
                        {"entity_kind":"item","item_id":123,"source_type":null,"source_id":null,"source_level":null,"name":"Test Item"},
                        {"entity_kind":"source","item_id":null,"source_type":"creature","source_id":123,"source_level":7,"name":"Test Source"}
                      ]
                      """
                    : "[]";

        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                json,
                Encoding.UTF8,
                "application/json")
        };
    }

    private static string BuildZoneCatalog(string body)
    {
        if (IsCrusadersOutpost(body))
        {
            return "[]";
        }

        using var document = JsonDocument.Parse(body);
        var limit = document.RootElement.GetProperty("p_limit").GetInt32();
        var offset = document.RootElement.GetProperty("p_offset").GetInt32();
        var all = new List<object>();

        for (var i = 1; i <= 62; i++)
        {
            all.Add(new
            {
                entity_kind = "item",
                item_id = (long?)(5000 + i),
                source_type = (string?)null,
                source_id = (long?)null,
                source_level = (int?)null,
                name = $"Zone Item {i:000}",
                total_count = 63L
            });
        }

        all.Add(new
        {
            entity_kind = "source",
            item_id = (long?)null,
            source_type = "creature",
            source_id = (long?)8000,
            source_level = (int?)8,
            name = "Zone Wolf",
            total_count = 63L
        });

        return JsonSerializer.Serialize(
            all.Skip(offset).Take(limit));
    }

    private static bool IsCrusadersOutpost(string body)
    {
        using var document = JsonDocument.Parse(body);

        return document.RootElement
            .TryGetProperty("p_zone_name", out var zoneName) &&
            zoneName.GetString() == "Crusader's Outpost";
    }
}
