using System.Text;
using ForeverDB.AtlasExporter.Model;

namespace ForeverDB.AtlasExporter.Enumeration;

/// <summary>
/// Builds the complete drawable-map plan from client metadata: every UiMap row is
/// accounted for exactly once as drawable, inherited, art-less or incomplete.
/// No record is manufactured for a map the client gives no artwork.
/// </summary>
public static class MapEnumerator
{
    public const int FlagFallbackToParentMap = 0x10;

    private static readonly string[] TypeNames =
        { "cosmic", "world", "continent", "zone", "dungeon", "micro", "orphan" };

    // English names of settlement maps. UiMap itself has no "city" type, so this is
    // the only name-based rule in the exporter; it is recorded as categorySource.
    private static readonly HashSet<string> CityNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Stormwind City", "Ironforge", "Darnassus", "Orgrimmar", "Thunder Bluff",
        "Undercity", "Silvermoon City", "The Exodar", "Shattrath City", "Dalaran"
    };

    // Battleground MapIDs. Not guessed: the exporter verified on a real 1.60.1.70450 client that
    // UiMapAssignment ties the maps named Alterac Valley, Warsong Gulch and Arathi Basin to exactly
    // these MapIDs. Used only when the Map table could not classify them.
    public static readonly IReadOnlyDictionary<int, string> CompatBattlegroundMapIds =
        new Dictionary<int, string> { [30] = "Alterac Valley", [489] = "Warsong Gulch", [529] = "Arathi Basin" };

    public const int FlagShowOverlays = 0x2;

    public static string Slugify(string name, int uiMapId)
    {
        var builder = new StringBuilder();
        var dash = false;

        foreach (var c in name.ToLowerInvariant())
        {
            if (c is >= 'a' and <= 'z' or >= '0' and <= '9')
            {
                builder.Append(c);
                dash = false;
            }
            else if (!dash && builder.Length > 0)
            {
                builder.Append('-');
                dash = true;
            }
        }

        var slug = builder.ToString().Trim('-');
        return slug.Length == 0 ? $"map-{uiMapId}" : slug;
    }

    public static AtlasPlan Enumerate(MapDatabase database)
    {
        var plan = new AtlasPlan { Hierarchy = new MapHierarchy() };

        var linksByMap = database.ArtLinks
            .GroupBy(link => link.UiMapId)
            .ToDictionary(group => group.Key,
                group => group.OrderBy(link => link.PhaseId).ThenBy(link => link.UiMapArtId).ToList());

        var layersByStyle = database.StyleLayers
            .GroupBy(layer => layer.StyleId)
            .ToDictionary(group => group.Key, group => group.OrderBy(layer => layer.LayerIndex).ToList());

        var tilesByArt = database.ArtTiles
            .GroupBy(tile => tile.UiMapArtId)
            .ToDictionary(group => group.Key, group => group.ToList());

        var overlaysByArt = database.Overlays
            .GroupBy(overlay => overlay.UiMapArtId)
            .ToDictionary(group => group.Key, group => group.OrderBy(overlay => overlay.Id).ToList());

        var overlayTiles = database.OverlayTiles
            .GroupBy(tile => tile.OverlayId)
            .ToDictionary(group => group.Key, group => group.ToList());

        var assignmentByMap = database.Assignments
            .GroupBy(assignment => assignment.UiMapId)
            .ToDictionary(group => group.Key, group => group.OrderBy(a => a.OrderIndex).First());

        var uiMapTypes = database.UiMaps.ToDictionary(map => map.Id, map => map.Type);
        var artPlans = new Dictionary<(int Art, int Phase), ArtPlan>();
        var knownMapIds = database.UiMaps.Select(map => map.Id).ToHashSet();

        foreach (var row in database.UiMaps.OrderBy(map => map.Id))
        {
            var map = new AtlasMap
            {
                UiMapId = row.Id,
                Name = row.Name,
                Slug = Slugify(row.Name, row.Id),
                ParentUiMapId = row.ParentUiMapId,
                Type = row.Type,
                TypeName = row.Type is >= 0 and < 7 ? TypeNames[row.Type] : "unknown",
                System = row.System,
                Flags = row.Flags
            };

            WorldMapRow? world = null;

            if (assignmentByMap.TryGetValue(row.Id, out var assignment))
            {
                map.InternalMapId = assignment.MapId;

                if (database.WorldMaps.TryGetValue(assignment.MapId, out world))
                {
                    map.WorldMapId = world.Id;
                    map.WorldMapDirectory = world.Directory;
                }
            }

            Classify(map, world, database, uiMapTypes);

            if (linksByMap.TryGetValue(row.Id, out var links))
            {
                foreach (var link in links)
                {
                    if (!artPlans.TryGetValue((link.UiMapArtId, link.PhaseId), out var art))
                    {
                        art = BuildArt(
                            link, database, layersByStyle, tilesByArt, overlaysByArt, overlayTiles);
                        artPlans[(link.UiMapArtId, link.PhaseId)] = art;
                    }

                    map.Arts.Add(art);
                }
            }

            if (map.PrimaryArt is not null)
            {
                map.Status = MapStatus.Drawable;
            }
            else if (map.Arts.Count > 0)
            {
                map.Status = MapStatus.ArtIncomplete;
                map.StatusDetail = string.Join("; ", map.Arts.SelectMany(art => art.Issues).Distinct());
            }
            else if ((row.Flags & FlagFallbackToParentMap) != 0 && knownMapIds.Contains(row.ParentUiMapId))
            {
                map.Status = MapStatus.InheritsParent;
                map.InheritsFromUiMapId = row.ParentUiMapId;
                map.StatusDetail = "UiMap flag FallbackToParentMap: the client draws the parent map.";
            }
            else
            {
                map.Status = MapStatus.NoOwnArt;
                map.StatusDetail = "No UiMapXMapArt row: the client defines no artwork for this map.";
            }

            plan.Maps.Add(map);
        }

        foreach (var link in database.Links.OrderBy(l => l.ParentUiMapId).ThenBy(l => l.OrderIndex)
                     .ThenBy(l => l.ChildUiMapId))
        {
            plan.Links.Add((link.ParentUiMapId, link.ChildUiMapId, link.OrderIndex));
        }

        BuildHierarchy(plan.Maps, plan.Hierarchy);
        plan.Instances = InstanceCatalogBuilder.Build(database, plan);
        return plan;
    }

    private static void Classify(
        AtlasMap map, WorldMapRow? world, MapDatabase database, IReadOnlyDictionary<int, int> uiMapTypes)
    {
        // Documented enum (WoWDBDefs): 0 none, 1 party, 2 raid, 3 pvp, 4 arena, >=5 none.
        // MapType has no documented meaning, so it is never used to classify.
        var instanceType = world?.InstanceType ?? 0;

        string? instanceKind = instanceType switch
        {
            1 => "dungeon",
            2 => "raid",
            3 => "battleground",
            4 => "arena",
            _ => null
        };

        void Set(string category, string source, string confidence, string evidence)
        {
            map.Category = category;
            map.CategorySource = source;
            map.ClassificationConfidence = confidence;
            map.ClassificationEvidence = evidence;
        }

        if (instanceKind is not null)
        {
            map.InstanceKind = instanceKind;
            Set(Categories.Instance, "map-instance-type", "confirmed",
                $"Map {world!.Id} InstanceType={world.InstanceType}, MapType={world.MapType}");
            return;
        }

        if (world is null && map.InternalMapId is { } internalId &&
            CompatBattlegroundMapIds.TryGetValue(internalId, out var bgName))
        {
            map.InstanceKind = "battleground";
            Set(Categories.Instance, "compat-mapid", "fallback",
                $"UiMapAssignment MapID {internalId} is the {bgName} battleground; Map table unavailable");
            return;
        }

        if (map.Type == 4)
        {
            map.InstanceKind = "dungeon";
            Set(Categories.Instance, "uimap-type", "derived", "UiMap.Type=4 (Dungeon)");
            return;
        }

        switch (map.Type)
        {
            case 0:
            case 1:
                Set(Categories.World, "uimap-type", "confirmed", $"UiMap.Type={map.Type}");
                break;
            case 2:
                Set(Categories.Continent, "uimap-type", "confirmed", "UiMap.Type=2 (Continent)");
                break;
            case 3:
            {
                // Settlements are the only zone-typed maps whose client flags omit ShowOverlays
                // (no exploration overlays); verified against the six capitals of a real client export.
                var parentIsContinent = uiMapTypes.TryGetValue(map.ParentUiMapId, out var parentType) && parentType == 2;
                var noOverlays = (map.Flags & FlagShowOverlays) == 0;
                var named = CityNames.Contains(map.Name);

                if (noOverlays && parentIsContinent && named)
                {
                    Set(Categories.City, "uimap-flags+name-list", "confirmed",
                        "zone-type map under a continent, UiMap.Flags without ShowOverlays, name in capital list");
                }
                else if (noOverlays && parentIsContinent)
                {
                    Set(Categories.City, "uimap-flags", "derived",
                        "zone-type map under a continent with UiMap.Flags lacking ShowOverlays (no exploration overlays)");
                }
                else if (named)
                {
                    Set(Categories.City, "name-list", "fallback", "name matches the capital-city list only");
                }
                else
                {
                    Set(Categories.Zone, "uimap-type", "confirmed", "UiMap.Type=3 (Zone)");
                }

                break;
            }
            case 5:
                Set(Categories.Special, "uimap-type", "confirmed", "UiMap.Type=5 (Micro)");
                break;
            default:
                Set(Categories.Other, "uimap-type", "confirmed",
                    $"UiMap.Type={map.Type} ({map.TypeName}); no further client metadata classifies it");
                break;
        }
    }

    private static ArtPlan BuildArt(
        UiMapArtLinkRow link,
        MapDatabase database,
        Dictionary<int, List<StyleLayerRow>> layersByStyle,
        Dictionary<int, List<ArtTileRow>> tilesByArt,
        Dictionary<int, List<OverlayRow>> overlaysByArt,
        Dictionary<int, List<OverlayTileRow>> overlayTiles)
    {
        var art = new ArtPlan
        {
            UiMapArtId = link.UiMapArtId,
            PhaseId = link.PhaseId,
            StyleId = database.ArtStyle.GetValueOrDefault(link.UiMapArtId, -1)
        };

        if (!database.ArtStyle.ContainsKey(link.UiMapArtId))
        {
            art.Issues.Add($"UiMapArt {link.UiMapArtId} does not exist.");
            return art;
        }

        if (!layersByStyle.TryGetValue(art.StyleId, out var layers))
        {
            art.Issues.Add($"UiMapArtStyle {art.StyleId} defines no layers.");
            return art;
        }

        var tiles = tilesByArt.GetValueOrDefault(link.UiMapArtId) ?? new List<ArtTileRow>();

        foreach (var layer in layers)
        {
            if (layer.LayerWidth <= 0 || layer.LayerHeight <= 0 ||
                layer.TileWidth <= 0 || layer.TileHeight <= 0)
            {
                art.Issues.Add($"Layer {layer.LayerIndex} has non-positive geometry.");
                continue;
            }

            var plan = new ArtLayerPlan
            {
                LayerIndex = layer.LayerIndex,
                LayerWidth = layer.LayerWidth,
                LayerHeight = layer.LayerHeight,
                TileWidth = layer.TileWidth,
                TileHeight = layer.TileHeight
            };

            var cells = new Dictionary<(int Row, int Col), int>();

            foreach (var tile in tiles.Where(tile => tile.LayerIndex == layer.LayerIndex))
            {
                if (tile.Row < 0 || tile.Column < 0 || tile.Row >= plan.Rows || tile.Column >= plan.Columns)
                {
                    plan.ConflictingTiles++;
                    continue;
                }

                if (cells.TryGetValue((tile.Row, tile.Column), out var existing) &&
                    existing != tile.FileDataId)
                {
                    plan.ConflictingTiles++;
                    continue;
                }

                cells[(tile.Row, tile.Column)] = tile.FileDataId;
            }

            foreach (var ((row, column), fileDataId) in cells.OrderBy(cell => cell.Key.Row).ThenBy(cell => cell.Key.Col))
            {
                if (fileDataId > 0)
                {
                    plan.Tiles.Add(new TileCell(row, column, fileDataId));
                }
            }

            plan.MissingTiles = plan.ExpectedTiles - plan.Tiles.Count;

            if (plan.Tiles.Count == 0)
            {
                art.Issues.Add($"Layer {layer.LayerIndex} has no tile records.");
                continue;
            }

            art.Layers.Add(plan);
        }

        if (overlaysByArt.TryGetValue(link.UiMapArtId, out var overlays))
        {
            foreach (var overlay in overlays)
            {
                art.Overlays.Add(AnalyseOverlay(overlay, overlayTiles.GetValueOrDefault(overlay.Id)));
            }
        }

        return art;
    }

    /// <summary>
    /// Judges one overlay from its own records. Overlays that carry no artwork are recorded as such and
    /// are not an error; only overlays whose declared artwork cannot be assembled block a full reveal.
    /// </summary>
    public static OverlayPlan AnalyseOverlay(OverlayRow overlay, List<OverlayTileRow>? tiles)
    {
        var plan = new OverlayPlan
        {
            Id = overlay.Id,
            Width = overlay.Width,
            Height = overlay.Height,
            OffsetX = overlay.OffsetX,
            OffsetY = overlay.OffsetY,
            PlayerConditionId = overlay.PlayerConditionId
        };

        var sized = overlay.Width > 0 && overlay.Height > 0;

        if (overlay.Width > 4096 || overlay.Height > 4096 ||
            Math.Abs((long)overlay.OffsetX) > 4096 || Math.Abs((long)overlay.OffsetY) > 4096)
        {
            plan.Kind = OverlayKind.UnsupportedGeometry;
            plan.KindDetail = $"{overlay.Width}x{overlay.Height} at ({overlay.OffsetX},{overlay.OffsetY}) exceeds the supported 4096 px";
            plan.TileRecordCount = tiles?.Count ?? 0;
            return plan;
        }

        var columns = sized ? (overlay.Width + 255) / 256 : 0;
        var rows = sized ? (overlay.Height + 255) / 256 : 0;
        plan.ExpectedTiles = columns * rows;
        tiles ??= new List<OverlayTileRow>();
        plan.TileRecordCount = tiles.Count;

        if (tiles.Count == 0)
        {
            plan.Kind = sized ? OverlayKind.TilelessDeclared : OverlayKind.NoArtwork;
            plan.KindDetail = sized
                ? $"declares a {overlay.Width}x{overlay.Height} texture ({columns}x{rows} grid) but has no tile records"
                : "zero-size overlay with no tile records (area/hit-rectangle row, no artwork)";
            return plan;
        }

        if (!sized)
        {
            plan.Kind = OverlayKind.GridInvalid;
            plan.KindDetail = $"{tiles.Count} tile record(s) for a {overlay.Width}x{overlay.Height} overlay";
            return plan;
        }

        // Prefer the lowest layer that forms the complete grid; otherwise report the lowest layer.
        var layers = tiles.GroupBy(tile => tile.LayerIndex).OrderBy(group => group.Key).ToList();
        Dictionary<(int Row, int Col), int>? chosen = null;
        var chosenLayer = layers[0].Key;
        var conflicts = 0;
        var outOfRange = 0;

        foreach (var layer in layers)
        {
            var cells = new Dictionary<(int Row, int Col), int>();
            var layerConflicts = 0;
            var layerOutOfRange = 0;

            foreach (var tile in layer)
            {
                if (tile.Row < 0 || tile.Column < 0 || tile.Row >= rows || tile.Column >= columns)
                {
                    layerOutOfRange++;
                }
                else if (cells.TryGetValue((tile.Row, tile.Column), out var existing) && existing != tile.FileDataId)
                {
                    layerConflicts++;
                }
                else
                {
                    cells[(tile.Row, tile.Column)] = tile.FileDataId;
                }
            }

            var complete = layerConflicts == 0 && layerOutOfRange == 0 &&
                           cells.Count == columns * rows && cells.Values.All(id => id > 0);

            if (chosen is null || complete)
            {
                chosen = cells;
                chosenLayer = layer.Key;
                conflicts = layerConflicts;
                outOfRange = layerOutOfRange;
            }

            if (complete)
            {
                break;
            }
        }

        plan.TileLayerIndex = chosenLayer;

        foreach (var ((row, column), fileDataId) in chosen!.OrderBy(cell => cell.Key.Row).ThenBy(cell => cell.Key.Col))
        {
            plan.Tiles.Add(new TileCell(row, column, fileDataId));
        }

        var present = plan.Tiles.Count(tile => tile.FileDataId > 0);

        if (conflicts > 0 || outOfRange > 0)
        {
            plan.Kind = OverlayKind.GridInvalid;
            plan.KindDetail = $"{conflicts} conflicting and {outOfRange} out-of-range tile record(s) for a {columns}x{rows} grid";
        }
        else if (present != columns * rows)
        {
            plan.Kind = OverlayKind.GridIncomplete;
            plan.KindDetail = $"{present} of {columns * rows} tiles present for a {columns}x{rows} grid";
        }
        else
        {
            plan.Kind = OverlayKind.Ok;
        }

        return plan;
    }

    private static void BuildHierarchy(List<AtlasMap> maps, MapHierarchy hierarchy)
    {
        var ids = maps.Select(map => map.UiMapId).ToHashSet();

        foreach (var map in maps)
        {
            hierarchy.Nodes[map.UiMapId] = new HierarchyNode
            {
                UiMapId = map.UiMapId,
                Name = map.Name,
                ParentUiMapId = map.ParentUiMapId
            };
        }

        foreach (var node in hierarchy.Nodes.Values)
        {
            if (node.ParentUiMapId == 0)
            {
                hierarchy.Roots.Add(node.UiMapId);
            }
            else if (ids.Contains(node.ParentUiMapId) && node.ParentUiMapId != node.UiMapId)
            {
                hierarchy.Nodes[node.ParentUiMapId].Children.Add(node.UiMapId);
            }
            else
            {
                node.ParentMissing = true;
                hierarchy.Roots.Add(node.UiMapId);
                hierarchy.OrphanedByMissingParent.Add(node.UiMapId);
            }
        }

        foreach (var node in hierarchy.Nodes.Values)
        {
            node.Children.Sort();
        }

        var visited = new HashSet<int>();
        var stack = new Stack<(int Id, int Depth)>(hierarchy.Roots.OrderByDescending(id => id).Select(id => (id, 0)));

        while (stack.Count > 0)
        {
            var (id, depth) = stack.Pop();

            if (!visited.Add(id))
            {
                continue;
            }

            hierarchy.Nodes[id].Depth = depth;

            foreach (var child in hierarchy.Nodes[id].Children.OrderByDescending(c => c))
            {
                stack.Push((child, depth + 1));
            }
        }

        // Anything not reached from a root sits on a parent cycle.
        foreach (var id in hierarchy.Nodes.Keys.Where(id => !visited.Contains(id)))
        {
            hierarchy.CycleMembers.Add(id);
        }
    }
}
