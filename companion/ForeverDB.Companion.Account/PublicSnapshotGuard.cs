using System.Text.Json.Nodes;

namespace ForeverDB.Companion.Account;

/// <summary>
/// Fail-closed allowlist for the public observation payload, enforced at the transport boundary (immediately before any
/// <c>ingest_foreverdb_snapshot_auth</c> or <c>fdb_device_ingest</c> request leaves the process). It is independent of how the payload was
/// built: even a future property added to a snapshot model, or a serializer that emits the complete snapshot again, cannot put
/// Guildbook or any other private data on the wire, because every object, at every level, may contain only the keys listed here.
///
/// Guildbook (guild names and rosters, member names and GUIDs, professions, ranks, online activity, capture metadata) is Companion-local
/// only. A rejected payload is never sent; the verdict carries only the offending property path, never a value.
/// </summary>
public static class PublicSnapshotGuard
{
    private static readonly string[] Root = { "schemaVersion", "addonVersion", "installationId", "updatedAt", "sources", "maps" };
    private static readonly string[] Source = { "sourceType", "sourceId", "sourceLevel", "name", "buckets" };
    private static readonly string[] Bucket = { "kind", "observations", "items", "locations" };
    private static readonly string[] Item = { "itemId", "name", "drops", "quantity", "questDrops", "questIds" };
    private static readonly string[] Location = { "mapId", "zoneName", "subZoneName", "x", "y", "observations" };
    private static readonly string[] Map = { "mapId", "name", "parentMapId", "mapArtId", "layers" };
    private static readonly string[] Layer =
    {
        "layerIndex", "layerWidth", "layerHeight", "tileWidth", "tileHeight", "minScale", "maxScale", "additionalZoomSteps", "textureRefs"
    };

    public readonly record struct Verdict(bool IsPublic, string? OffendingPath)
    {
        public static Verdict Ok { get; } = new(true, null);
    }

    /// <summary>Validates the <c>p_snapshot</c> object itself.</summary>
    public static Verdict Check(JsonNode? snapshot)
    {
        if (snapshot is not JsonObject root) return new(false, "$");
        return Object(root, Root, "$", static (key, value, path) => key switch
        {
            "sources" => Array(value, path, Source, static (k, v, p) => k == "buckets" ? Array(v, p, Bucket, Bucketed) : Verdict.Ok),
            "maps" => Array(value, path, Map, static (k, v, p) => k == "layers" ? Array(v, p, Layer, null) : Verdict.Ok),
            _ => Verdict.Ok,
        });
    }

    /// <summary>
    /// Validates a complete request body: exactly <c>{"p_snapshot": {...}}</c> (anonymous / registered-session ingest) or
    /// <c>{"p_device_secret": "...", "p_snapshot": {...}}</c> (device ingest, built by the transport itself).
    /// </summary>
    public static Verdict CheckBody(JsonNode? body)
    {
        if (body is not JsonObject obj) return new(false, "$");
        foreach (var pair in obj)
        {
            if (pair.Key is not ("p_snapshot" or "p_device_secret")) return new(false, "$." + pair.Key);
        }

        return Check(obj["p_snapshot"]);
    }

    private static Verdict Bucketed(string key, JsonNode? value, string path) => key switch
    {
        "items" => Array(value, path, Item, null),
        "locations" => Array(value, path, Location, null),
        _ => Verdict.Ok,
    };

    private delegate Verdict Descend(string key, JsonNode? value, string path);

    private static Verdict Array(JsonNode? node, string path, string[] allowed, Descend? descend)
    {
        if (node is null) return Verdict.Ok;
        if (node is not JsonArray array) return new(false, path);
        for (var i = 0; i < array.Count; i++)
        {
            if (array[i] is null) continue;
            if (array[i] is not JsonObject child) return new(false, $"{path}[{i}]");
            var verdict = Object(child, allowed, $"{path}[{i}]", descend);
            if (!verdict.IsPublic) return verdict;
        }

        return Verdict.Ok;
    }

    private static Verdict Object(JsonObject obj, string[] allowed, string path, Descend? descend)
    {
        foreach (var pair in obj)
        {
            // Exact (ordinal) match: the serializer always emits camelCase, and a differently-cased key must not slip past the
            // exact-case descent below, so it is rejected like any other unknown key.
            if (System.Array.IndexOf(allowed, pair.Key) < 0)
            {
                return new(false, path + "." + pair.Key);
            }

            if (descend is not null)
            {
                var verdict = descend(pair.Key, pair.Value, path + "." + pair.Key);
                if (!verdict.IsPublic) return verdict;
            }
        }

        return Verdict.Ok;
    }
}
