using ForeverDB.AtlasExporter.Model;

namespace ForeverDB.AtlasExporter.Enumeration;

public static class InstanceKinds
{
    public const string Dungeon = "dungeon";
    public const string Raid = "raid";
    public const string Battleground = "battleground";
    public const string Arena = "arena";
    public const string Scenario = "scenario";
    public const string Unknown = "unknown-instance";
}

public sealed class InstanceUiMap
{
    public int UiMapId { get; init; }
    public string Name { get; init; } = "";
    public string Category { get; init; } = "";
    public string ArtStatus { get; init; } = "";
    public int ParentUiMapId { get; init; }
    public int? FloorGroupId { get; init; }
    public int? FloorIndex { get; init; }
    public int? RelativeHeightIndex { get; init; }
    public string FloorSource { get; init; } = "none";
}

public sealed class FloorMember
{
    public int UiMapId { get; init; }
    public string? Name { get; init; }
    public int FloorIndex { get; init; }
    public int RelativeHeightIndex { get; init; }
    public bool Known { get; init; }
}

public sealed class FloorGroup
{
    public int GroupId { get; init; }
    public List<FloorMember> Members { get; } = new();
}

/// <summary>
/// One instance-related internal Map. Identity is the internal MapID; UiMapIDs and MapArtIDs are
/// related, never substituted. Having a record says nothing about drawable interior artwork.
/// </summary>
public sealed class InstanceRecord
{
    public int MapId { get; init; }
    public string Name { get; set; } = "";
    public string? Directory { get; set; }
    public int? InstanceTypeRaw { get; set; }
    public int? MapTypeRaw { get; set; }
    public string Classification { get; set; } = InstanceKinds.Unknown;
    public string ClassificationSource { get; set; } = "";
    public string Confidence { get; set; } = "fallback";
    public int? ExpansionId { get; set; }
    public int? ParentMapId { get; set; }
    public int? CosmeticParentMapId { get; set; }
    public List<string> Evidence { get; } = new();
    public List<InstanceUiMap> UiMaps { get; } = new();
    public List<int> EntranceUiMapIds { get; } = new();
    public List<int> RegionUiMapIds { get; } = new();
    public List<FloorGroup> FloorGroups { get; } = new();
    public string FloorNote { get; set; } = "";
    public bool Drawable => UiMaps.Any(map => map.ArtStatus == MapStatus.Drawable);
    public int DrawableUiMaps => UiMaps.Count(map => map.ArtStatus == MapStatus.Drawable);
    public string? MissingArtworkReason { get; set; }
}

public sealed class InstanceCatalog
{
    public List<InstanceRecord> Records { get; } = new();

    /// <summary>"map-table" when Map rows enumerate instances; otherwise why discovery is limited.</summary>
    public string Coverage { get; set; } = "";
    public List<string> Notes { get; } = new();
}

public static class InstanceCatalogBuilder
{
    private static string? KindOf(int instanceType) => instanceType switch
    {
        1 => InstanceKinds.Dungeon,
        2 => InstanceKinds.Raid,
        3 => InstanceKinds.Battleground,
        4 => InstanceKinds.Arena,
        _ => null
    };

    public static InstanceCatalog Build(MapDatabase database, AtlasPlan plan)
    {
        var catalog = new InstanceCatalog();
        var records = new Dictionary<int, InstanceRecord>();
        var mapsByInternal = plan.Maps.Where(map => map.InternalMapId is not null)
            .GroupBy(map => map.InternalMapId!.Value).ToDictionary(group => group.Key, group => group.ToList());
        var mapsById = plan.Maps.ToDictionary(map => map.UiMapId);

        InstanceRecord Record(int mapId)
        {
            if (!records.TryGetValue(mapId, out var record))
            {
                record = new InstanceRecord { MapId = mapId };
                records[mapId] = record;
            }

            return record;
        }

        var mapTable = database.WorldMaps.Count > 0;

        if (mapTable)
        {
            catalog.Coverage = $"map-table ({database.TableSources.GetValueOrDefault("Map", "?")}, {database.WorldMaps.Count} Map rows)";

            // Documented: Map.InstanceType 0 none, 1 party, 2 raid, 3 pvp, 4 arena, >=5 none.
            foreach (var world in database.WorldMaps.Values.OrderBy(row => row.Id))
            {
                if (KindOf(world.InstanceType) is not { } kind)
                {
                    continue;
                }

                var record = Record(world.Id);
                record.Name = world.Name;
                record.Directory = world.Directory;
                record.InstanceTypeRaw = world.InstanceType;
                record.MapTypeRaw = world.MapType;
                record.Classification = kind;
                record.ClassificationSource = "map-instance-type";
                record.Confidence = "confirmed";
                record.ExpansionId = world.ExpansionId;
                record.ParentMapId = world.ParentMapId;
                record.CosmeticParentMapId = world.CosmeticParentMapId;
                record.Evidence.Add($"Map#{world.Id} InstanceType={world.InstanceType}");
            }
        }
        else
        {
            catalog.Coverage = "map-table-unavailable";
            catalog.Notes.Add(
                "The Map table could not be read from any source, so instance records cannot be enumerated from it. " +
                "Only instance-related maps visible through other client tables are listed. Run --diagnose-tables.");
        }

        // Dungeon finder rows corroborate instance MapIDs and name instances the Map table does not describe.
        var continentMapIds = plan.Maps.Where(map => map.InternalMapId is not null &&
                map.Category is Categories.World or Categories.Continent)
            .Select(map => map.InternalMapId!.Value).ToHashSet();

        foreach (var lfg in database.LfgDungeons.OrderBy(row => row.Id))
        {
            if (lfg.MapId <= 0 || continentMapIds.Contains(lfg.MapId))
            {
                continue;
            }

            var record = Record(lfg.MapId);

            if (string.IsNullOrEmpty(record.Name))
            {
                record.Name = lfg.Name;
            }

            record.Evidence.Add($"LFGDungeons#{lfg.Id} TypeID={lfg.TypeId}");
        }

        // Maps the exporter classified as instances from UiMap metadata alone (e.g. battlegrounds).
        foreach (var map in plan.Maps.Where(map => map.Category == Categories.Instance && map.InternalMapId is not null))
        {
            var record = Record(map.InternalMapId!.Value);

            if (string.IsNullOrEmpty(record.Name))
            {
                record.Name = map.Name;
            }

            if (record.ClassificationSource.Length == 0)
            {
                record.Classification = map.InstanceKind ?? InstanceKinds.Unknown;
                record.ClassificationSource = map.CategorySource;
                record.Confidence = map.ClassificationConfidence;
            }

            record.Evidence.Add($"UiMap#{map.UiMapId} ({map.CategorySource})");
        }

        var membersByMap = database.GroupMembers.GroupBy(member => member.UiMapId)
            .ToDictionary(group => group.Key, group => group.ToList());
        var membersByGroup = database.GroupMembers.GroupBy(member => member.GroupId)
            .ToDictionary(group => group.Key, group => group.OrderBy(m => m.FloorIndex).ThenBy(m => m.RelativeHeightIndex).ToList());

        foreach (var record in records.Values.OrderBy(record => record.MapId))
        {
            if (string.IsNullOrEmpty(record.Name))
            {
                record.Name = $"Map {record.MapId}";
            }

            if (record.ClassificationSource.Length == 0)
            {
                record.Classification = InstanceKinds.Unknown;
                record.ClassificationSource = "none";
                record.Confidence = "fallback";
            }

            if (mapsByInternal.TryGetValue(record.MapId, out var uiMaps))
            {
                foreach (var map in uiMaps.OrderBy(m => m.UiMapId))
                {
                    var member = membersByMap.GetValueOrDefault(map.UiMapId)?.FirstOrDefault();
                    record.UiMaps.Add(new InstanceUiMap
                    {
                        UiMapId = map.UiMapId,
                        Name = map.Name,
                        Category = map.Category,
                        ArtStatus = map.Status,
                        ParentUiMapId = map.ParentUiMapId,
                        FloorGroupId = member?.GroupId,
                        FloorIndex = member?.FloorIndex,
                        RelativeHeightIndex = member?.RelativeHeightIndex,
                        FloorSource = member is null ? "none" : "UiMapGroupMember"
                    });
                }
            }

            foreach (var groupId in record.UiMaps.Where(map => map.FloorGroupId is not null)
                         .Select(map => map.FloorGroupId!.Value).Distinct().OrderBy(id => id))
            {
                var group = new FloorGroup { GroupId = groupId };

                foreach (var member in membersByGroup[groupId])
                {
                    group.Members.Add(new FloorMember
                    {
                        UiMapId = member.UiMapId,
                        Name = mapsById.GetValueOrDefault(member.UiMapId)?.Name,
                        FloorIndex = member.FloorIndex,
                        RelativeHeightIndex = member.RelativeHeightIndex,
                        Known = mapsById.ContainsKey(member.UiMapId)
                    });
                }

                record.FloorGroups.Add(group);
            }

            record.FloorNote = record.UiMaps.Count switch
            {
                0 => "no interior UiMap",
                1 when record.FloorGroups.Count == 0 => "single map; no floor group",
                _ when record.FloorGroups.Count > 0 => "floors from UiMapGroupMember (verified order)",
                _ => database.GroupMembers.Count == 0
                    ? "several UiMaps share this MapID but floor order is unverified: UiMapGroupMember unavailable or empty"
                    : "several UiMaps share this MapID but none is in a UiMapGroup: floor order unverified"
            };

            record.MissingArtworkReason = record.UiMaps.Count == 0
                ? "the client defines no UiMap (UiMapAssignment) for this MapID, so there is no interior map"
                : record.Drawable
                    ? null
                    : "its UiMap(s) have no drawable artwork: " +
                      string.Join("; ", record.UiMaps.Select(m => $"{m.UiMapId}={m.ArtStatus}"));

            // Entrances and region association are reported only from data, never inferred.
            var interiorIds = record.UiMaps.Select(map => map.UiMapId).ToHashSet();

            foreach (var link in database.Links.Where(link => interiorIds.Contains(link.ChildUiMapId)))
            {
                if (!record.EntranceUiMapIds.Contains(link.ParentUiMapId))
                {
                    record.EntranceUiMapIds.Add(link.ParentUiMapId);
                }
            }

            record.EntranceUiMapIds.Sort();

            if (record.ParentMapId is { } parentMapId && mapsByInternal.TryGetValue(parentMapId, out var regionMaps))
            {
                record.RegionUiMapIds.AddRange(regionMaps
                    .Where(map => map.Category is Categories.Continent or Categories.World)
                    .Select(map => map.UiMapId).OrderBy(id => id));
            }

            catalog.Records.Add(record);
        }

        // Floor information for every map that belongs to a group, instance or not.
        foreach (var map in plan.Maps)
        {
            if (membersByMap.TryGetValue(map.UiMapId, out var memberships))
            {
                map.FloorGroupId = memberships[0].GroupId;
                map.FloorIndex = memberships[0].FloorIndex;
            }
        }

        if (mapTable && catalog.Records.Count == 0)
        {
            catalog.Notes.Add("The Map table was read and lists no instance rows (Map.InstanceType 1-4).");
        }

        return catalog;
    }
}
