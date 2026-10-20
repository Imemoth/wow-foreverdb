using ForeverDB.AtlasExporter.Client;
using ForeverDB.AtlasExporter.Enumeration;
using ForeverDB.AtlasExporter.Export;
using ForeverDB.AtlasExporter.Imaging;
using ForeverDB.AtlasExporter.Model;
using ForeverDB.Companion.Services;

namespace ForeverDB.AtlasExporter.Diagnostics;

public static class MapDiagnostics
{
    /// <summary>The per-map reveal verdict, using the project's outcome vocabulary.</summary>
    public static class RevealVerdict
    {
        public const string Ready = "READY_TO_EXPORT";
        public const string MetadataIncomplete = "METADATA_INCOMPLETE";
        public const string ClientArtUnavailable = "CLIENT_ART_UNAVAILABLE";
        public const string OverlayUnsupported = "OVERLAY_UNSUPPORTED";
        public const string NoRevealArtwork = "NO_REVEAL_ARTWORK";
        public const string NeedsClientDiagnostics = "NEEDS_REAL_CLIENT_DIAGNOSTICS";
    }

    public static IEnumerable<AtlasMap> Select(AtlasPlan plan, int? uiMapId, int? internalMapId = null) =>
        plan.Maps.Where(map => (uiMapId is null || map.UiMapId == uiMapId) &&
                               (internalMapId is null || map.InternalMapId == internalMapId));

    // ---------------------------------------------------------------- overlays

    public static DiagnosticsDocument Overlays(
        MapDatabase database, AtlasPlan plan, IAssetSource assets, IAssetProbe? probe,
        Sanitizer sanitizer, int? uiMapId, CancellationToken token)
    {
        var doc = new DiagnosticsDocument("ForeverDB Atlas Exporter - full-reveal overlay diagnostics", sanitizer);
        var textures = new TextureCache(assets, 64L * 1024 * 1024);
        var atlas = FullRevealMapArt.GetEmbeddedAtlas();
        var report = new List<object>();
        var verdicts = new Dictionary<string, int>(StringComparer.Ordinal);

        foreach (var map in Select(plan, uiMapId).Where(m => m.Status == MapStatus.Drawable))
        {
            foreach (var art in map.Arts.Where(a => a.IsDrawable))
            {
                token.ThrowIfCancellationRequested();

                if (art.Overlays.Count == 0)
                {
                    continue;
                }

                var overview = art.Layers.OrderBy(l => l.LayerIndex).First();
                var rows = new List<object>();
                var missingTiles = new List<string>();
                var undecodable = 0;
                var unsupported = art.Overlays.Any(o => o.Kind == OverlayKind.UnsupportedGeometry);

                foreach (var overlay in art.Overlays)
                {
                    var resolved = 0;
                    var absent = 0;

                    if (overlay.Kind == OverlayKind.Ok)
                    {
                        foreach (var tile in overlay.Tiles)
                        {
                            if (textures.Get(tile.FileDataId, out var failure) is not null)
                            {
                                resolved++;
                                continue;
                            }

                            if (failure?.Contains("undecodable", StringComparison.Ordinal) == true)
                            {
                                undecodable++;
                            }
                            else
                            {
                                absent++;
                            }

                            if (missingTiles.Count < 6)
                            {
                                var p = probe?.ProbeFileDataId(tile.FileDataId);
                                missingTiles.Add($"overlay {overlay.Id} r{tile.Row}c{tile.Column} FileDataID {tile.FileDataId}: " +
                                                 (p is null ? failure : $"{p.ErrorMeaning} (error {p.ErrorCode})"));
                            }
                        }
                    }

                    var outside = overlay.Width > 0 && overlay.Height > 0 &&
                                  (overlay.OffsetX < 0 || overlay.OffsetY < 0 ||
                                   overlay.OffsetX + overlay.Width > overview.LayerWidth ||
                                   overlay.OffsetY + overlay.Height > overview.LayerHeight);

                    rows.Add(new
                    {
                        overlay.Id, overlay.Kind, overlay.KindDetail, overlay.Width, overlay.Height,
                        overlay.OffsetX, overlay.OffsetY, overlay.PlayerConditionId,
                        overlay.ExpectedTiles, overlay.TileRecordCount, overlay.TileLayerIndex,
                        TilesResolved = resolved, TilesUnavailable = absent, ExtendsOutsideCanvas = outside
                    });
                }

                var usable = art.UsableOverlays.ToList();
                var regions = TileCompositor.ToRegions(usable, out _);
                bool? matches = regions is null ? null : TileCompositor.MatchesEmbeddedAtlas(art.UiMapArtId, regions);
                var atlasEntry = atlas.TryGetValue(art.UiMapArtId, out var reference) ? reference : null;

                string verdict;

                if (!art.HasRevealArtwork)
                {
                    verdict = RevealVerdict.NoRevealArtwork;
                }
                else if (unsupported)
                {
                    verdict = RevealVerdict.OverlayUnsupported;
                }
                else if (art.BlockingOverlays.Any())
                {
                    verdict = RevealVerdict.MetadataIncomplete;
                }
                else if (missingTiles.Count > 0 || undecodable > 0)
                {
                    verdict = RevealVerdict.ClientArtUnavailable;
                }
                else
                {
                    verdict = RevealVerdict.Ready;
                }

                verdicts[verdict] = verdicts.GetValueOrDefault(verdict) + 1;

                doc.Heading($"{map.UiMapId} {map.Name} (MapArtID {art.UiMapArtId}, canvas {overview.LayerWidth}x{overview.LayerHeight})");
                doc.Line($"  overlays: {art.Overlays.Count} rows - {usable.Count} with artwork, " +
                         $"{art.SkippedOverlays.Count()} without artwork (ignored), {art.BlockingOverlays.Count()} blocking");
                var beyondCanvas = rows.Count(row => (bool)row.GetType().GetProperty("ExtendsOutsideCanvas")!.GetValue(row)!);

                if (beyondCanvas > 0)
                {
                    doc.Line($"  geometry: {beyondCanvas} overlay(s) extend beyond the {overview.LayerWidth}x{overview.LayerHeight} base canvas (clipped when composed)");
                }

                foreach (var overlay in art.Overlays.Where(o => o.Kind != OverlayKind.Ok))
                {
                    doc.Line($"    overlay {overlay.Id}: {overlay.Kind} - {overlay.KindDetail}");
                }

                foreach (var line in missingTiles)
                {
                    doc.Line("    unavailable tile: " + line);
                }

                doc.Line(atlasEntry is null
                    ? "  reviewed atlas: art not covered"
                    : $"  reviewed atlas: {atlasEntry.Count} regions / {atlasEntry.Sum(r => r.FileDataIds.Count)} tiles; " +
                      $"client usable overlays {(matches == true ? "MATCH it exactly" : matches == false ? "DIFFER from it" : "could not be compared")}");
                doc.Line($"  verdict: {verdict}");

                report.Add(new
                {
                    map.UiMapId, map.Name, MapArtId = art.UiMapArtId, art.PhaseId,
                    Canvas = new { overview.LayerWidth, overview.LayerHeight },
                    Overlays = rows,
                    UsableOverlays = usable.Count,
                    SkippedWithoutArtwork = art.SkippedOverlays.Count(),
                    Blocking = art.BlockingOverlays.Count(),
                    ReviewedAtlas = atlasEntry is null ? null : new
                    {
                        Regions = atlasEntry.Count,
                        Tiles = atlasEntry.Sum(r => r.FileDataIds.Count),
                        ClientMatches = matches
                    },
                    UnavailableTiles = missingTiles,
                    Verdict = verdict
                });
            }
        }

        doc.Heading("Summary");

        if (assets is FallbackAssetSource fallback)
        {
            doc.Line("  tile sources used: " + (fallback.ServedBy.Count == 0
                ? "none"
                : string.Join(", ", fallback.ServedBy.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => $"{p.Key} x{p.Value}"))) +
                "  (a 'cdn:' entry means tiles missing from the local install were resolved from the exact-build CDN)");
            doc.Data("tileSources", fallback.ServedBy.OrderBy(p => p.Key, StringComparer.Ordinal).ToDictionary(p => p.Key, p => p.Value));
        }

        foreach (var (verdict, count) in verdicts.OrderBy(p => p.Key, StringComparer.Ordinal))
        {
            doc.Line($"  {verdict}: {count}");
        }

        doc.Data("verdicts", verdicts);
        doc.Data("maps", report);
        return doc;
    }

    // ---------------------------------------------------------------- one map

    public static DiagnosticsDocument Map(
        MapDatabase database, AtlasPlan plan, IAssetSource assets, IAssetProbe? probe,
        Sanitizer sanitizer, int? uiMapId, int? internalMapId, CancellationToken token)
    {
        var title = uiMapId is not null ? $"uiMapID {uiMapId}" : $"internal MapID {internalMapId}";
        var doc = new DiagnosticsDocument($"ForeverDB Atlas Exporter - map diagnostics ({title})", sanitizer);
        var maps = Select(plan, uiMapId, internalMapId).ToList();
        var items = new List<object>();

        if (maps.Count == 0)
        {
            doc.Line($"No UiMap matches {title}.");

            if (internalMapId is not null)
            {
                var instance = plan.Instances.Records.FirstOrDefault(r => r.MapId == internalMapId);
                doc.Line(instance is null
                    ? "No instance record for this MapID either. Identifiers are never substituted: an internal MapID, a UiMapID and a MapArtID are different numbers."
                    : $"Instance record found: {instance.Name} ({instance.Classification}); it has no UiMap, so no map artwork. See --diagnose-instances.");
            }
        }

        foreach (var map in maps)
        {
            token.ThrowIfCancellationRequested();
            doc.Heading($"UiMap {map.UiMapId}: {map.Name}");
            doc.Line($"  identifiers: uiMapID {map.UiMapId}, internal MapID {(map.InternalMapId?.ToString() ?? "unknown (no UiMapAssignment)")}, " +
                     $"MapArtID {string.Join(", ", map.Arts.Select(a => a.UiMapArtId).Distinct().DefaultIfEmpty(0))}");
            doc.Line($"  UiMap.Type={map.Type} ({map.TypeName}), System={map.System}, Flags=0x{map.Flags:X}, parent {map.ParentUiMapId}");
            doc.Line($"  category: {map.Category} (source {map.CategorySource}, confidence {map.ClassificationConfidence})");
            doc.Line($"  why: {map.ClassificationEvidence}");
            doc.Line($"  artwork status: {map.Status} {map.StatusDetail}");

            if (map.FloorGroupId is not null)
            {
                doc.Line($"  floor: group {map.FloorGroupId}, index {map.FloorIndex}");
            }

            var arts = new List<object>();

            foreach (var art in map.Arts)
            {
                doc.Line($"  art {art.UiMapArtId} (phase {art.PhaseId}, style {art.StyleId}): {art.Layers.Count} usable layer(s)");

                foreach (var issue in art.Issues)
                {
                    doc.Line("    issue: " + issue);
                }

                foreach (var layer in art.Layers)
                {
                    var found = layer.Tiles.Count(tile => assets.ReadByFileDataId(tile.FileDataId) is not null);
                    doc.Line($"    layer {layer.LayerIndex}: {layer.LayerWidth}x{layer.LayerHeight}, tiles {layer.Tiles.Count}/{layer.ExpectedTiles} " +
                             $"in the metadata, {found} readable in storage");
                }

                arts.Add(new
                {
                    art.UiMapArtId, art.PhaseId, art.StyleId, art.Issues,
                    Layers = art.Layers.Select(l => new { l.LayerIndex, l.LayerWidth, l.LayerHeight, l.TileWidth, l.TileHeight, Tiles = l.Tiles.Count, l.ExpectedTiles, l.MissingTiles }),
                    Overlays = art.Overlays.Select(o => new { o.Id, o.Kind, o.KindDetail, o.Width, o.Height, o.OffsetX, o.OffsetY })
                });
            }

            var record = plan.Instances.Records.FirstOrDefault(r => r.MapId == map.InternalMapId);

            if (record is not null)
            {
                doc.Line($"  instance: MapID {record.MapId} {record.Name} - {record.Classification} ({record.ClassificationSource}, {record.Confidence}); {record.FloorNote}");
            }

            items.Add(new
            {
                map.UiMapId, map.InternalMapId, map.Name, map.Type, map.TypeName, map.System, map.Flags, map.ParentUiMapId,
                map.Category, map.CategorySource, map.ClassificationConfidence, map.ClassificationEvidence,
                map.Status, map.StatusDetail, map.FloorGroupId, map.FloorIndex, Arts = arts,
                Instance = record is null ? null : new { record.MapId, record.Name, record.Classification, record.FloorNote }
            });
        }

        doc.Data("maps", items);

        if (uiMapId is not null)
        {
            var overlays = Overlays(database, plan, assets, probe, sanitizer, uiMapId, token);
            doc.Heading("Full-reveal overlays");
            doc.Line(overlays.ToText().Replace("\n\n", "\n"));
            doc.Data("overlays", "see the overlays section of the text report");
        }

        return doc;
    }

    // ---------------------------------------------------------------- instances

    public static DiagnosticsDocument Instances(MapDatabase database, AtlasPlan plan, Sanitizer sanitizer)
    {
        var doc = new DiagnosticsDocument("ForeverDB Atlas Exporter - instance diagnostics", sanitizer);
        var catalog = plan.Instances;
        doc.Line($"Coverage: {catalog.Coverage}");

        foreach (var note in catalog.Notes)
        {
            doc.Line("Note: " + note);
        }

        doc.Heading("Sources consulted");
        doc.Line($"  UiMap rows: {database.UiMaps.Count} (by type: " +
                 string.Join(", ", database.UiMaps.GroupBy(m => m.Type).OrderBy(g => g.Key).Select(g => $"{g.Key}={g.Count()}")) + ")");
        doc.Line($"  UiMapAssignment rows: {database.Assignments.Count}; distinct internal MapIDs: " +
                 string.Join(", ", database.Assignments.Select(a => a.MapId).Distinct().OrderBy(i => i)));
        doc.Line($"  Map rows: {database.WorldMaps.Count} (source {database.TableSources.GetValueOrDefault("Map", "none")}); " +
                 "InstanceType counts: " + (database.WorldMaps.Count == 0 ? "n/a" :
                 string.Join(", ", database.WorldMaps.Values.GroupBy(m => m.InstanceType).OrderBy(g => g.Key).Select(g => $"{g.Key}={g.Count()}"))));
        doc.Line($"  LFGDungeons rows: {database.LfgDungeons.Count}; UiMapGroupMember rows: {database.GroupMembers.Count}; UiMapLink rows: {database.Links.Count}");

        foreach (var (table, reason) in database.MissingOptionalTables)
        {
            doc.Line($"  unavailable: {table} - {reason}");
        }

        foreach (var warning in database.TableWarnings)
        {
            doc.Line("  warning: " + warning);
        }

        doc.Heading($"Instance records: {catalog.Records.Count}");

        foreach (var record in catalog.Records)
        {
            doc.Line($"  MapID {record.MapId} {record.Name} - {record.Classification} " +
                     $"[{record.ClassificationSource}, {record.Confidence}]; evidence: {string.Join("; ", record.Evidence)}");
            doc.Line($"      interior UiMaps: {(record.UiMaps.Count == 0 ? "none" : string.Join(", ", record.UiMaps.Select(m => $"{m.UiMapId} {m.Name} ({m.ArtStatus})")))}");

            if (record.MissingArtworkReason is not null)
            {
                doc.Line("      no drawable map: " + record.MissingArtworkReason);
            }

            doc.Line("      floors: " + record.FloorNote);
        }

        doc.Heading("Reading this");
        doc.Line(catalog.Records.Count == 0
            ? "  No instance rows were found. If 'Map rows' is 0 the Map table was unavailable (run --diagnose-tables to see why); " +
              "if it is non-zero the client lists no dungeon/raid/arena rows."
            : "  An instance record does not imply a drawable interior map; an instance without a UiMap has none in this client.");

        doc.Data("coverage", catalog.Coverage);
        doc.Data("uiMapTypeCounts", database.UiMaps.GroupBy(m => m.Type).OrderBy(g => g.Key).ToDictionary(g => g.Key.ToString(), g => g.Count()));
        doc.Data("assignmentMapIds", database.Assignments.Select(a => a.MapId).Distinct().OrderBy(i => i).ToArray());
        doc.Data("mapRows", database.WorldMaps.Count);
        doc.Data("tableWarnings", database.TableWarnings);
        doc.Data("unavailableTables", database.MissingOptionalTables);
        doc.Data("instances", catalog.Records.Select(r => new
        {
            r.MapId, r.Name, r.Classification, r.ClassificationSource, r.Confidence, r.Evidence, r.Drawable,
            r.MissingArtworkReason, r.FloorNote,
            UiMaps = r.UiMaps.Select(m => new { m.UiMapId, m.Name, m.ArtStatus, m.FloorGroupId, m.FloorIndex })
        }));
        return doc;
    }
}
