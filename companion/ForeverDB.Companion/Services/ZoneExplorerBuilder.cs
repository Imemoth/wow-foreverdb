using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

/// <summary>
/// Builds navigable geography only from the addon's exported UiMapID and
/// parentMapID metadata. Missing parent links remain explicit instead of
/// being inferred from localized/display names.
/// </summary>
public static class ZoneExplorerBuilder
{
    public static IReadOnlyList<ZoneExplorerNode> Build(
        IEnumerable<SearchZoneOption> observedScopes,
        IEnumerable<ForeverDbMap> mapMetadata)
    {
        var maps = mapMetadata
            .Where(map => map.MapId > 0)
            .GroupBy(map => map.MapId)
            .ToDictionary(group => group.Key, group => group.Last());
        var options = observedScopes
            .Where(scope => !scope.IsAllZones && scope.MapId is > 0)
            .GroupBy(scope => (scope.MapId!.Value, scope.ZoneName),
                new ScopeIdentityComparer())
            .Select(group => group.First())
            .ToArray();

        var byMap = options.GroupBy(option => option.MapId!.Value)
            .ToDictionary(group => group.Key, group => group.ToArray());
        var mapNodes = new Dictionary<long, ZoneExplorerNode>();

        ZoneExplorerNode GetMapNode(long mapId)
        {
            if (mapNodes.TryGetValue(mapId, out var existing))
            {
                return existing;
            }

            var metadata = maps.GetValueOrDefault(mapId);
            var candidates = byMap.GetValueOrDefault(mapId) ?? Array.Empty<SearchZoneOption>();
            var mapName = !string.IsNullOrWhiteSpace(metadata?.Name)
                ? metadata.Name
                : candidates.FirstOrDefault()?.ZoneName ?? $"Map {mapId}";
            var node = new ZoneExplorerNode
            {
                Id = $"map:{mapId}",
                Name = mapName,
                Scope = candidates.FirstOrDefault(),
                IsUnknownMapping = metadata is null
            };
            mapNodes[mapId] = node;

            // Distinct database labels on one map ID cannot safely be called
            // child zones. Keep them under an explicit ambiguity group.
            if (candidates.Length > 1)
            {
                var aliases = new ZoneExplorerNode
                {
                    Id = $"labels:{mapId}",
                    Name = "Observed labels on this map",
                    IsUnknownMapping = true
                };
                foreach (var alias in candidates.Skip(1))
                {
                    aliases.Children.Add(new ZoneExplorerNode
                    {
                        Id = $"scope:{mapId}:{alias.ZoneName}",
                        Name = alias.ZoneName,
                        Scope = alias,
                        IsUnknownMapping = true
                    });
                }
                node.Children.Add(aliases);
            }

            return node;
        }

        var roots = new List<ZoneExplorerNode>
        {
            new() { Id = "all", Name = "All zones", Scope = SearchZoneOption.AllZones }
        };
        var unknown = new ZoneExplorerNode
        {
            Id = "unknown",
            Name = "Unknown mapping",
            IsUnknownMapping = true
        };

        foreach (var option in options)
        {
            var mapId = option.MapId!.Value;
            var node = GetMapNode(mapId);
            var path = new List<long>();
            var current = mapId;
            var visited = new HashSet<long>();
            var hasMissingParent = false;

            while (current > 0 && visited.Add(current))
            {
                path.Add(current);
                if (!maps.TryGetValue(current, out var metadata))
                {
                    hasMissingParent = true;
                    break;
                }
                current = metadata.ParentMapId;
                if (current > 0 && !maps.ContainsKey(current))
                {
                    hasMissingParent = true;
                    break;
                }
            }

            if (current > 0 && !visited.Add(current))
            {
                hasMissingParent = true; // malformed metadata cycle
            }

            if (hasMissingParent)
            {
                if (!unknown.Children.Contains(node))
                {
                    unknown.Children.Add(node);
                }
                continue;
            }

            // Parent nodes are created only when supported metadata identifies
            // their exact IDs. They need not have observations to be expanded.
            for (var index = path.Count - 1; index >= 1; index--)
            {
                var parent = GetMapNode(path[index]);
                var child = GetMapNode(path[index - 1]);
                if (!parent.Children.Contains(child))
                {
                    parent.Children.Add(child);
                }
            }

            if (!roots.Contains(node) && !IsAttachedToAnyRoot(node, roots))
            {
                // The top of an acyclic, complete parent chain is a verified
                // root map. Its WoW-provided name is the continent label.
                var top = GetMapNode(path[^1]);
                if (!roots.Contains(top))
                {
                    roots.Add(top);
                }
            }
        }

        if (unknown.Children.Count > 0)
        {
            roots.Add(unknown);
        }

        foreach (var root in roots)
        {
            SetAggregateScopes(root, byMap);
        }

        Sort(roots);
        return roots;
    }

    public static IReadOnlyList<ZoneExplorerNode> Filter(
        IEnumerable<ZoneExplorerNode> roots,
        string query)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            return roots.ToArray();
        }

        var term = query.Trim();
        var filtered = new List<ZoneExplorerNode>();
        foreach (var node in roots)
        {
            var children = Filter(node.Children, term);
            if (node.Name.Contains(term, StringComparison.OrdinalIgnoreCase) ||
                children.Count > 0)
            {
                var copy = new ZoneExplorerNode
                {
                    Id = node.Id,
                    Name = node.Name,
                    Scope = node.Scope,
                    IsUnknownMapping = node.IsUnknownMapping,
                    IsExpanded = children.Count > 0
                };
                copy.Children.AddRange(children);
                filtered.Add(copy);
            }
        }
        return filtered;
    }

    public static IReadOnlyList<DetailLocation> FilterLocations(
        IEnumerable<DetailLocation> locations,
        SearchZoneOption? scope)
    {
        if (scope is null || scope.IsAllZones)
        {
            return locations.ToArray();
        }

        var exactScopes = scope.IsAggregate
            ? scope.IncludedScopes
            : new[] { scope };
        return locations.Where(location => exactScopes.Any(candidate =>
                candidate.MapId == location.MapId &&
                string.Equals(candidate.ZoneName, location.ZoneName,
                    StringComparison.OrdinalIgnoreCase)))
            .ToArray();
    }

    private static bool IsAttachedToAnyRoot(
        ZoneExplorerNode node,
        IEnumerable<ZoneExplorerNode> roots) =>
        roots.Any(root => Contains(root, node));

    private static bool Contains(ZoneExplorerNode root, ZoneExplorerNode target) =>
        ReferenceEquals(root, target) || root.Children.Any(child => Contains(child, target));

    private static IReadOnlyList<SearchZoneOption> SetAggregateScopes(
        ZoneExplorerNode node,
        IReadOnlyDictionary<long, SearchZoneOption[]> byMap)
    {
        var scopes = new List<SearchZoneOption>();
        if (node.Id.StartsWith("map:", StringComparison.Ordinal) &&
            long.TryParse(node.Id.AsSpan(4), out var mapId) &&
            byMap.TryGetValue(mapId, out var exact))
        {
            scopes.AddRange(exact);
        }
        else if (node.Id.StartsWith("scope:", StringComparison.Ordinal) && node.Scope is not null)
        {
            scopes.Add(node.Scope);
        }

        foreach (var child in node.Children)
        {
            scopes.AddRange(SetAggregateScopes(child, byMap));
        }

        scopes = scopes
            .GroupBy(scope => (scope.MapId, scope.ZoneName))
            .Select(group => group.First())
            .ToList();

        if (node.Id != "all" && node.Children.Count > 0 && scopes.Count > 0)
        {
            node.Scope = new SearchZoneOption
            {
                IsAggregate = true,
                MapDisplayName = node.Name,
                IncludedScopes = scopes,
                IsUnknownMapping = node.IsUnknownMapping
            };
        }
        else if (node.Id == "all")
        {
            node.Scope = SearchZoneOption.AllZones;
        }

        return scopes;
    }

    private static void Sort(IEnumerable<ZoneExplorerNode> nodes)
    {
        foreach (var node in nodes)
        {
            node.Children.Sort((left, right) =>
                StringComparer.OrdinalIgnoreCase.Compare(left.Name, right.Name));
            Sort(node.Children);
        }
    }

    private sealed class ScopeIdentityComparer : IEqualityComparer<(long, string)>
    {
        public bool Equals((long, string) x, (long, string) y) =>
            x.Item1 == y.Item1 && StringComparer.OrdinalIgnoreCase.Equals(x.Item2, y.Item2);

        public int GetHashCode((long, string) value) =>
            HashCode.Combine(value.Item1, StringComparer.OrdinalIgnoreCase.GetHashCode(value.Item2));
    }
}
