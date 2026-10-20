using ForeverDB.AtlasExporter.Model;

namespace ForeverDB.AtlasExporter.Metadata;

public sealed class MetadataException : Exception
{
    public MetadataException(string message) : base(message) { }
}

public sealed record LoadAttempt(string Source, bool Succeeded, string Detail);

public sealed record MapDatabaseLoad(
    MapDatabase? Database, IReadOnlyList<LoadAttempt> Attempts);

/// <summary>Turns generic tables into the typed model, rejecting structurally wrong data.</summary>
public static class MapDatabaseBuilder
{
    public static readonly IReadOnlyList<string> RequiredTables = new[]
    {
        "UiMap", "UiMapXMapArt", "UiMapArt", "UiMapArtStyleLayer", "UiMapArtTile"
    };

    public static readonly IReadOnlyList<string> OptionalTables = new[]
    {
        "UiMapAssignment", "UiMapLink", "Map", "WorldMapOverlay", "WorldMapOverlayTile",
        "UiMapGroupMember", "LFGDungeons"
    };

    private static readonly Dictionary<string, string[]> RequiredColumns = new()
    {
        ["UiMap"] = new[] { "ID", "Name_lang", "ParentUiMapID", "Flags", "System", "Type" },
        ["UiMapXMapArt"] = new[] { "UiMapID", "UiMapArtID", "PhaseID" },
        ["UiMapArt"] = new[] { "ID", "UiMapArtStyleID" },
        ["UiMapArtStyleLayer"] = new[]
        {
            "UiMapArtStyleID", "LayerIndex", "LayerWidth", "LayerHeight", "TileWidth", "TileHeight"
        },
        ["UiMapArtTile"] = new[] { "UiMapArtID", "LayerIndex", "RowIndex", "ColIndex", "FileDataID" },
        ["UiMapAssignment"] = new[] { "UiMapID", "MapID" },
        ["UiMapLink"] = new[] { "ParentUiMapID", "ChildUiMapID" },
        ["Map"] = new[] { "ID", "InstanceType" },
        ["UiMapGroupMember"] = new[] { "UiMapGroupID", "UiMapID", "FloorIndex" },
        ["LFGDungeons"] = new[] { "ID", "TypeID", "MapID" },
        ["WorldMapOverlay"] = new[]
        {
            "ID", "UiMapArtID", "TextureWidth", "TextureHeight", "OffsetX", "OffsetY"
        },
        ["WorldMapOverlayTile"] = new[]
        {
            "WorldMapOverlayID", "LayerIndex", "RowIndex", "ColIndex", "FileDataID"
        }
    };

    public static void CheckColumns(TableData table)
    {
        if (!RequiredColumns.TryGetValue(table.Name, out var columns))
        {
            return;
        }

        var missing = columns.Where(column => !table.HasColumn(column)).ToArray();

        if (missing.Length > 0)
        {
            throw new MetadataException(
                $"{table.Name} has no column(s): {string.Join(", ", missing)}.");
        }
    }

    public static MapDatabase Build(
        IReadOnlyDictionary<string, TableData> tables,
        IReadOnlyDictionary<string, string> missingOptional)
    {
        foreach (var name in RequiredTables)
        {
            if (!tables.TryGetValue(name, out var table) || table.Rows.Count == 0)
            {
                throw new MetadataException($"Required table {name} is missing or empty.");
            }
        }

        foreach (var table in tables.Values)
        {
            CheckColumns(table);
        }

        var database = new MapDatabase();

        foreach (var row in tables["UiMap"].Rows)
        {
            database.UiMaps.Add(new UiMapRow(
                (int)row.Int("ID"), row.Str("Name_lang"), (int)row.Int("ParentUiMapID"),
                (int)row.Int("Flags"), (int)row.Int("System"), (int)row.Int("Type")));
        }

        if (database.UiMaps.Select(map => map.Id).Distinct().Count() != database.UiMaps.Count)
        {
            throw new MetadataException("UiMap contains duplicate IDs; the table was misread.");
        }

        if (database.UiMaps.Any(map => map.Type is < 0 or > 6))
        {
            throw new MetadataException(
                "UiMap.Type holds values outside 0-6; the column layout does not match.");
        }

        foreach (var row in tables["UiMapXMapArt"].Rows)
        {
            database.ArtLinks.Add(new UiMapArtLinkRow(
                (int)row.Int("UiMapID"), (int)row.Int("UiMapArtID"), (int)row.Int("PhaseID")));
        }

        foreach (var row in tables["UiMapArt"].Rows)
        {
            database.ArtStyle[(int)row.Int("ID")] = (int)row.Int("UiMapArtStyleID");
        }

        foreach (var row in tables["UiMapArtStyleLayer"].Rows)
        {
            database.StyleLayers.Add(new StyleLayerRow(
                (int)row.Int("UiMapArtStyleID"), (int)row.Int("LayerIndex"),
                (int)row.Int("LayerWidth"), (int)row.Int("LayerHeight"),
                (int)row.Int("TileWidth"), (int)row.Int("TileHeight")));
        }

        if (database.StyleLayers.Any(layer => layer.LayerWidth < 0 || layer.TileWidth < 0 ||
                                              layer.LayerWidth > 65535 || layer.LayerHeight > 65535))
        {
            throw new MetadataException(
                "UiMapArtStyleLayer geometry is implausible; the column layout does not match.");
        }

        foreach (var row in tables["UiMapArtTile"].Rows)
        {
            database.ArtTiles.Add(new ArtTileRow(
                (int)row.Int("UiMapArtID"), (int)row.Int("LayerIndex"),
                (int)row.Int("RowIndex"), (int)row.Int("ColIndex"), (int)row.Int("FileDataID")));
        }

        if (tables.TryGetValue("UiMapAssignment", out var assignments))
        {
            foreach (var row in assignments.Rows)
            {
                database.Assignments.Add(new AssignmentRow(
                    (int)row.Int("UiMapID"), (int)row.Int("OrderIndex"),
                    (int)row.Int("MapID"), (int)row.Int("AreaID"),
                    new[] { row.FloatAt("UiMin", 0), row.FloatAt("UiMin", 1) },
                    new[] { row.FloatAt("UiMax", 0), row.FloatAt("UiMax", 1) },
                    Enumerable.Range(0, 6).Select(i => row.FloatAt("Region", i)).ToArray()));
            }
        }

        if (tables.TryGetValue("UiMapLink", out var links))
        {
            foreach (var row in links.Rows)
            {
                database.Links.Add(new UiMapLinkRow(
                    (int)row.Int("ParentUiMapID"), (int)row.Int("ChildUiMapID"),
                    (int)row.Int("OrderIndex")));
            }
        }

        if (tables.TryGetValue("Map", out var maps))
        {
            foreach (var row in maps.Rows)
            {
                var id = (int)row.Int("ID");
                database.WorldMaps[id] = new WorldMapRow(
                    id, row.Str("Directory"), row.Str("MapName_lang"),
                    (int)row.Int("MapType"), (int)row.Int("InstanceType"),
                    (int)row.Int("ParentMapID"), (int)row.Int("ExpansionID"),
                    (int)row.Int("CosmeticParentMapID"));
            }
        }

        if (tables.TryGetValue("WorldMapOverlay", out var overlays))
        {
            foreach (var row in overlays.Rows)
            {
                database.Overlays.Add(new OverlayRow(
                    (int)row.Int("ID"), (int)row.Int("UiMapArtID"),
                    (int)row.Int("TextureWidth"), (int)row.Int("TextureHeight"),
                    (int)row.Int("OffsetX"), (int)row.Int("OffsetY"),
                    (int)row.Int("PlayerConditionID")));
            }
        }

        if (tables.TryGetValue("WorldMapOverlayTile", out var overlayTiles))
        {
            foreach (var row in overlayTiles.Rows)
            {
                database.OverlayTiles.Add(new OverlayTileRow(
                    (int)row.Int("WorldMapOverlayID"), (int)row.Int("LayerIndex"),
                    (int)row.Int("RowIndex"), (int)row.Int("ColIndex"), (int)row.Int("FileDataID")));
            }
        }

        if (tables.TryGetValue("UiMapGroupMember", out var members))
        {
            foreach (var row in members.Rows)
            {
                database.GroupMembers.Add(new GroupMemberRow(
                    (int)row.Int("UiMapGroupID"), (int)row.Int("UiMapID"),
                    (int)row.Int("FloorIndex"), (int)row.Int("RelativeHeightIndex")));
            }
        }

        if (tables.TryGetValue("LFGDungeons", out var lfg))
        {
            foreach (var row in lfg.Rows)
            {
                database.LfgDungeons.Add(new LfgDungeonRow(
                    (int)row.Int("ID"), row.Str("Name_lang"), (int)row.Int("TypeID"),
                    (int)row.Int("MapID"), (int)row.Int("ExpansionLevel")));
            }
        }

        foreach (var (name, table) in tables)
        {
            database.TableRowCounts[name] = table.Rows.Count;
        }

        foreach (var (name, reason) in missingOptional)
        {
            database.MissingOptionalTables[name] = reason;
        }

        return database;
    }

    /// <summary>
    /// Tries each source in order until one yields a complete, structurally valid
    /// database. Every attempt (including why it failed) is returned for diagnostics.
    /// </summary>
    public static async Task<MapDatabaseLoad> LoadAsync(
        IReadOnlyList<IMapTableSource> sources,
        CancellationToken cancellationToken)
    {
        var attempts = new List<LoadAttempt>();

        foreach (var source in sources)
        {
            var tables = new Dictionary<string, TableData>(StringComparer.Ordinal);
            var requiredWarnings = new List<string>();
            string? failure = null;

            foreach (var name in RequiredTables)
            {
                var result = await source.ReadAsync(name, cancellationToken);

                if (result.Data is null)
                {
                    failure = result.Error;
                    break;
                }

                tables[name] = result.Data;
                requiredWarnings.AddRange((result.Warnings ?? Array.Empty<string>()).Select(w => $"[{source.Label}] {w}"));
            }

            var missingOptional = new Dictionary<string, string>(StringComparer.Ordinal);
            var tableSources = new Dictionary<string, string>(StringComparer.Ordinal);
            var warnings = new List<string>();

            if (failure is null)
            {
                foreach (var name in RequiredTables)
                {
                    tableSources[name] = source.Label;
                }

                // Optional tables fall back per table: a missing Map.db2 in the client must not
                // leave instances undiscoverable when another source (same build) has it.
                foreach (var name in OptionalTables)
                {
                    var reasons = new List<string>();
                    var found = false;

                    foreach (var candidate in new[] { source }.Concat(sources.Where(other => !ReferenceEquals(other, source))))
                    {
                        var result = await candidate.ReadAsync(name, cancellationToken);

                        if (result.Data is not null)
                        {
                            try
                            {
                                CheckColumns(result.Data);
                            }
                            catch (MetadataException ex)
                            {
                                reasons.Add($"{candidate.Label}: {ex.Message}");
                                continue;
                            }

                            tables[name] = result.Data;
                            tableSources[name] = candidate.Label;

                            foreach (var warning in result.Warnings ?? Array.Empty<string>())
                            {
                                warnings.Add($"[{candidate.Label}] {warning}");
                            }

                            found = true;
                            break;
                        }

                        reasons.Add($"{candidate.Label}: {result.Error ?? "unavailable"}");
                    }

                    if (!found)
                    {
                        missingOptional[name] = string.Join(" | ", reasons);
                    }
                }

                try
                {
                    var database = Build(tables, missingOptional);
                    database.MetadataSource = source.Label;

                    foreach (var (name, label) in tableSources)
                    {
                        database.TableSources[name] = label;
                    }

                    database.TableWarnings.AddRange(requiredWarnings);
                    database.TableWarnings.AddRange(warnings);
                    attempts.Add(new LoadAttempt(source.Label, true, "ok"));
                    return new MapDatabaseLoad(database, attempts);
                }
                catch (MetadataException ex)
                {
                    failure = ex.Message;
                }
            }

            attempts.Add(new LoadAttempt(source.Label, false, failure ?? "unknown"));
        }

        return new MapDatabaseLoad(null, attempts);
    }
}
