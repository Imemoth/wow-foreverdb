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

            if (assignmentByMap.TryGetValue(row.Id, out var assignment) &&
                database.WorldMaps.TryGetValue(assignment.MapId, out var world))
            {
                map.WorldMapId = world.Id;
                map.WorldMapDirectory = world.Directory;
                Classify(map, world);
            }
            else
            {
                Classify(map, null);
            }

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
        return plan;
    }

    private static void Classify(AtlasMap map, WorldMapRow? world)
    {
        var instanceType = world is null
            ? 0
            : world.InstanceType != 0 ? world.InstanceType : world.MapType;

        string? instanceKind = instanceType switch
        {
            1 => "dungeon",
            2 => "raid",
            3 => "battleground",
            4 => "arena",
            5 => "scenario",
            _ => null
        };

        if (map.Type == 4 || instanceKind is not null)
        {
            map.Category = Categories.Instance;
            map.InstanceKind = instanceKind ?? "dungeon";
            map.CategorySource = instanceKind is not null ? "map-instance-type" : "uimap-type";
            return;
        }

        switch (map.Type)
        {
            case 0:
            case 1:
                map.Category = Categories.World;
                map.CategorySource = "uimap-type";
                break;
            case 2:
                map.Category = Categories.Continent;
                map.CategorySource = "uimap-type";
                break;
            case 3 when CityNames.Contains(map.Name):
                map.Category = Categories.City;
                map.CategorySource = "name-list";
                break;
            case 3:
                map.Category = Categories.Zone;
                map.CategorySource = "uimap-type";
                break;
            case 5:
                map.Category = Categories.Special;
                map.CategorySource = "uimap-type";
                break;
            default:
                map.Category = Categories.Other;
                map.CategorySource = "uimap-type";
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
                var overlayPlan = new OverlayPlan
                {
                    Id = overlay.Id,
                    Width = overlay.Width,
                    Height = overlay.Height,
                    OffsetX = overlay.OffsetX,
                    OffsetY = overlay.OffsetY,
                    PlayerConditionId = overlay.PlayerConditionId
                };

                var rows = overlayTiles.GetValueOrDefault(overlay.Id) ?? new List<OverlayTileRow>();
                var lowest = rows.Count == 0 ? 0 : rows.Min(tile => tile.LayerIndex);

                foreach (var tile in rows.Where(tile => tile.LayerIndex == lowest)
                             .OrderBy(tile => tile.Row).ThenBy(tile => tile.Column))
                {
                    overlayPlan.Tiles.Add(new TileCell(tile.Row, tile.Column, tile.FileDataId));
                }

                art.Overlays.Add(overlayPlan);
            }
        }

        return art;
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
