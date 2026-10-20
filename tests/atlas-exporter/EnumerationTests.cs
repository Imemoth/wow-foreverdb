using ForeverDB.AtlasExporter.Enumeration;
using ForeverDB.AtlasExporter.Model;

namespace Atlas.Exporter.Tests;

internal static class EnumerationTests
{
    public static void Register()
    {
        Harness.Add("enumeration: every UiMap row is accounted for exactly once", () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Path);
            var plan = world.Plan();
            Assert.Equal(world.Db.UiMaps.Count, plan.Maps.Count, "maps");
            Assert.Equal(plan.Maps.Count, plan.Maps.Select(m => m.UiMapId).Distinct().Count(), "unique");
            Assert.Equal(7, plan.Maps.Count(m => m.Status == MapStatus.Drawable), "drawable");
            Assert.Equal(MapStatus.InheritsParent, plan.Maps.Single(m => m.UiMapId == 1601).Status);
            Assert.Equal(1420, plan.Maps.Single(m => m.UiMapId == 1601).InheritsFromUiMapId);
            Assert.Equal(MapStatus.NoOwnArt, plan.Maps.Single(m => m.UiMapId == 1800).Status);
            Assert.Equal(MapStatus.NoOwnArt, plan.Maps.Single(m => m.UiMapId == 946).Status);
        });

        Harness.Add("enumeration: categories come from client metadata (type, instance type, city list)", () =>
        {
            using var dir = new TempDir();
            var plan = World.Standard(dir.Path).Plan();
            string Category(int id) => plan.Maps.Single(m => m.UiMapId == id).Category;
            Assert.Equal(Categories.World, Category(946));
            Assert.Equal(Categories.World, Category(947));
            Assert.Equal(Categories.Continent, Category(1415));
            Assert.Equal(Categories.Zone, Category(1420));
            Assert.Equal(Categories.City, Category(1453));
            Assert.Equal(Categories.Instance, Category(1600));
            Assert.Equal(Categories.Special, Category(1601));
            var raid = plan.Maps.Single(m => m.UiMapId == 1610);
            Assert.Equal(Categories.Instance, raid.Category, "zone-typed map on an instance Map is an instance");
            Assert.Equal("raid", raid.InstanceKind);
            Assert.Equal("map-instance-type", raid.CategorySource);
            Assert.Equal("uimap-flags+name-list", plan.Maps.Single(m => m.UiMapId == 1453).CategorySource);
        });

        Harness.Add("enumeration: tiles resolve by row/column to FileDataIDs regardless of record order", () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Path);
            world.Db.ArtTiles.Reverse();
            var layer = world.Plan().Maps.Single(m => m.UiMapId == 1420).PrimaryArt!.Layers.First();
            Assert.Equal(12, layer.Tiles.Count, "4x3 grid");
            Assert.Equal(0, layer.MissingTiles);

            foreach (var cell in layer.Tiles)
            {
                Assert.Equal(world.TileId(102, 0, cell.Row, cell.Column), cell.FileDataId, $"r{cell.Row}c{cell.Column}");
            }

            Assert.True(layer.Tiles.Zip(layer.Tiles.Skip(1)).All(p => (p.First.Row, p.First.Column).CompareTo((p.Second.Row, p.Second.Column)) < 0),
                "cells are emitted in row-major order");
        });

        Harness.Add("enumeration: missing and conflicting tile records are counted, never invented", () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Path);
            var removed = world.Db.ArtTiles.First(t => t.UiMapArtId == 100 && t.Column == 1);
            world.Db.ArtTiles.Remove(removed);
            world.Db.ArtTiles.Add(world.Db.ArtTiles.First(t => t.UiMapArtId == 100) with { FileDataId = 424242 });
            var layer = world.Plan().Maps.Single(m => m.UiMapId == 947).PrimaryArt!.Layers[0];
            Assert.Equal(1, layer.MissingTiles, "missing");
            Assert.Equal(1, layer.ConflictingTiles, "conflict");
            Assert.Equal(1, layer.Tiles.Count);
            Assert.False(layer.IsComplete);
        });

        Harness.Add("enumeration: art without layers or tiles marks the map art-incomplete", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Path).Map(1, "A", 3, 0).Link(1, 77);
            Assert.Equal(MapStatus.ArtIncomplete, world.Plan().Maps[0].Status, "UiMapArt row missing");
            world.Db.ArtStyle[77] = 7700;
            Assert.Equal(MapStatus.ArtIncomplete, world.Plan().Maps[0].Status, "no style layers");
            world.Db.StyleLayers.Add(new StyleLayerRow(7700, 0, 256, 256, 256, 256));
            var plan = world.Plan();
            Assert.Equal(MapStatus.ArtIncomplete, plan.Maps[0].Status, "no tiles");
            Assert.True(plan.Maps[0].StatusDetail.Contains("no tile"), plan.Maps[0].StatusDetail);
        });

        Harness.Add("enumeration: alternate art (phases) are kept; primary is the lowest phase", () =>
        {
            using var dir = new TempDir();
            var world = new World(dir.Path).Map(5, "Phased", 3, 0)
                .Art(10, (0, 256, 256)).Art(11, (0, 256, 256)).Link(5, 11, phase: 7).Link(5, 10, phase: 0);
            var map = world.Plan().Maps[0];
            Assert.Equal(2, map.Arts.Count);
            Assert.Equal(10, map.PrimaryArt!.UiMapArtId);
            Assert.Equal(7, map.Arts[1].PhaseId);
        });

        Harness.Add("hierarchy: roots, depth, missing parents and cycles are reported", () =>
        {
            using var dir = new TempDir();
            var world = World.Standard(dir.Path)
                .Map(1604, "Orphan", 3, 99999)
                .Map(1700, "CycleA", 6, 1701)
                .Map(1701, "CycleB", 6, 1700);
            var h = world.Plan().Hierarchy;
            Assert.True(h.Roots.Contains(946), "cosmic root");
            Assert.Equal(0, h.Nodes[946].Depth);
            Assert.Equal(2, h.Nodes[1415].Depth);
            Assert.Equal(3, h.Nodes[1420].Depth);
            Assert.Equal(4, h.Nodes[1601].Depth);
            Assert.True(h.Nodes[1420].Children.Contains(1601));
            Assert.True(h.OrphanedByMissingParent.Contains(1604) && h.Nodes[1604].ParentMissing);
            Assert.True(h.CycleMembers.Contains(1700) && h.CycleMembers.Contains(1701), "cycle detected");
            Assert.False(h.CycleMembers.Contains(1420));
        });

        Harness.Add("enumeration: slugs are stable ASCII and unique per fallback id", () =>
        {
            Assert.Equal("tirisfal-glades", MapEnumerator.Slugify("Tirisfal Glades", 1));
            Assert.Equal("map-7", MapEnumerator.Slugify("  ", 7));
            Assert.Equal("the-deadmines-1", MapEnumerator.Slugify("The Deadmines (1)", 2));
            Assert.Equal("n-c-d", MapEnumerator.Slugify("Ünïcödé", 9));
        });
    }
}
