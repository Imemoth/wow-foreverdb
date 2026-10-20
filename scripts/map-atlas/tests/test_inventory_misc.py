import io
import json
import tempfile
import unittest
from pathlib import Path

import common  # noqa: F401
from PIL import Image
from synth import Bundle, standard_bundle, write_csv
from mapatlas.casc import extract_blps
from mapatlas.inventory import build_inventory, check_hierarchy, children_index, MapEntry
from mapatlas.reference import compare_to_reference
from mapatlas.versioning import Ledger, LedgerError, slug


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.b = standard_bundle(Path(self.tmp.name))
        self.b.finish()
        self.inv = build_inventory(self.b.db2)

    def test_enumerates_every_uimap_and_separates_drawable_from_area_only(self):
        self.assertEqual(len(self.inv.maps), 14)
        drawable = sorted(i for i, e in self.inv.maps.items() if e.drawable)
        self.assertEqual(drawable, [947, 1414, 1420, 1501, 1502, 2022, 2023, 3000, 4000])
        for i in (946, 1500, 2024, 4001, 4002):
            self.assertTrue(self.inv.maps[i].reasons)

    def test_identifiers_are_kept_apart(self):
        e = self.inv.maps[1420]
        v = e.variants[0]
        self.assertEqual((e.ui_map_id, v.map_art_id, v.style_id), (1420, 7003, 703))
        self.assertEqual(self.inv.maps[1501].map_ids, [36])  # instance MapID, not a uiMapID
        self.assertTrue(all(fd > 900000 for fd in v.layers[0].tiles.values()))

    def test_hierarchy_parent_child_and_faults(self):
        ch = children_index(self.inv.maps)
        self.assertEqual(ch[947], [1414])
        self.assertEqual(ch[1500], [1501, 1502])
        self.assertIn("uiMap 4001: parent 99999 does not exist", self.inv.hierarchy_issues)
        a = {1: MapEntry(1, "a", 2, 3, None, None), 2: MapEntry(2, "b", 1, 3, None, None), 3: MapEntry(3, "c", 3, 3, None, None)}
        issues = check_hierarchy(a)
        self.assertTrue(any("cycle" in i for i in issues))
        self.assertIn("uiMap 3: is its own parent", issues)

    def test_variants_layers_floors_and_instance_types(self):
        k = self.inv.maps[1414]
        self.assertEqual([(v.map_art_id, v.phase_id) for v in k.variants], [(7001, 0), (7002, 5)])
        self.assertEqual([l.index for l in k.variants[0].layers], [0, 1])
        self.assertEqual(k.variants[0].primary_layer.index, 0)  # largest usable layer, as the Companion chooses
        self.assertEqual(self.inv.maps[1501].floor, {"groupId": 55, "floorIndex": 0})
        self.assertEqual(self.inv.maps[1502].floor["floorIndex"], 1)
        self.assertEqual(self.inv.maps[1501].instance_type, "dungeon")
        self.assertEqual(self.inv.maps[4002].type_name, "unknown_9")

    def test_tile_grid_sizes_and_conflicting_tiles(self):
        l = self.inv.maps[1420].variants[0].layers[0]
        self.assertEqual((l.columns, l.rows, len(l.tiles)), (4, 3, 12))
        # a conflicting duplicate tile row and an out-of-grid tile are recorded as layer issues
        rows = (self.b.db2 / "UiMapArtTile.csv").read_text().splitlines()
        rows.append("9998,0,0,0,703,111")
        rows.append("9999,9,9,0,703,222")
        (self.b.db2 / "UiMapArtTile.csv").write_text("\n".join(rows) + "\n")
        l2 = build_inventory(self.b.db2).maps[1420].variants[0].layers[0]
        self.assertTrue(any("conflicting" in i for i in l2.issues))
        self.assertTrue(any("outside" in i for i in l2.issues))

    def test_optional_tables_may_be_absent_and_are_recorded(self):
        for n in ("Map", "UiMapAssignment", "UiMapGroupMember"):
            (self.b.db2 / f"{n}.csv").unlink()
        inv = build_inventory(self.b.db2)
        self.assertEqual(sorted(inv.missing_optional_tables), ["AreaTable", "Map", "UiMapAssignment", "UiMapGroupMember", "WorldMapOverlay", "WorldMapOverlayTile"])
        self.assertIsNone(inv.maps[1501].floor)

    def test_missing_required_table_is_an_error(self):
        (self.b.db2 / "UiMapArtTile.csv").unlink()
        with self.assertRaisesRegex(Exception, "UiMapArtTile"):
            build_inventory(self.b.db2)


class VersioningTests(unittest.TestCase):
    def test_slug(self):
        self.assertEqual(slug("Shen'dralas", 1), "shendralas")
        self.assertEqual(slug("Tirisfal Glades", 1420), "tirisfal-glades")
        self.assertEqual(slug("Zéphras  Isle!", 1), "zephras-isle")
        self.assertEqual(slug("日本", 77), "map-77")

    def test_ledger_is_append_only(self):
        L = Ledger({"schemaVersion": 1, "maps": {}})
        self.assertEqual(L.next_version(5), "v1")
        L.record(5, "v1", "setA", {"a": {"sha256": "x", "bytes": 1}}, "1.0.0.1")
        self.assertEqual(L.lookup_asset_set(5, "setA"), "v1")
        self.assertIsNone(L.lookup_asset_set(5, "setB"))
        self.assertEqual(L.next_version(5), "v2")
        with self.assertRaises(LedgerError):
            L.record(5, "v1", "setC", {}, "1.0.0.2")
        L.note_seen(5, "v1", "1.0.0.2")
        self.assertEqual(L.versions(5)["v1"]["seenBuilds"], ["1.0.0.1", "1.0.0.2"])

    def test_records_without_an_asset_set_hash_are_protected_but_never_silently_reused(self):
        L = Ledger({"schemaVersion": 1, "maps": {"1420": {"v1": {"pixelSha256": "p", "layoutSha256": "l", "firstBuild": "legacy-poc", "seenBuilds": ["legacy-poc"], "files": {}}}}})
        self.assertIsNone(L.lookup_asset_set(1420, "anything"))
        self.assertEqual(L.next_version(1420), "v2")


class AssetSetTests(unittest.TestCase):
    BASE = {"version": "v1", "zoneId": 5, "image": {"file": "a.webp", "sha256": "1"}, "clientBuild": {"version": "1.0.0.1"},
            "provenance": {"source": "s", "exporterVersion": "0.2.1", "revealCompleteness": "complete"}, "source": {"assembledBy": "t 1"}}

    def test_complete_set_identity_covers_every_file_and_material_metadata_but_not_provenance_only_fields(self):
        from mapatlas.assetset import asset_set_sha256 as h
        import copy
        base = h({"a.webp": "aa", "b.webp": "bb"}, self.BASE)
        self.assertEqual(base, h({"b.webp": "bb", "a.webp": "aa"}, copy.deepcopy(self.BASE)))      # order-independent
        self.assertNotEqual(base, h({"a.webp": "aa", "b.webp": "CHANGED"}, self.BASE))              # a non-primary file changed
        self.assertNotEqual(base, h({"a.webp": "aa"}, self.BASE))                                   # a variant disappeared
        self.assertNotEqual(base, h({"a.webp": "aa", "b.webp": "bb", "c.webp": "cc"}, self.BASE))   # a variant appeared
        m = copy.deepcopy(self.BASE)
        m["provenance"]["revealCompleteness"] = "partial-overlays"
        self.assertNotEqual(base, h({"a.webp": "aa", "b.webp": "bb"}, m))                           # material metadata changed
        for volatile in (("version", "v9"), ("clientBuild", {"version": "2"})):
            m = copy.deepcopy(self.BASE)
            m[volatile[0]] = volatile[1]
            self.assertEqual(base, h({"a.webp": "aa", "b.webp": "bb"}, m))
        m = copy.deepcopy(self.BASE)
        m["provenance"]["exporterVersion"] = "9.9.9"
        m["provenance"]["source"] = "label naming another client build"
        m["source"]["assembledBy"] = "t 2"
        self.assertEqual(base, h({"a.webp": "aa", "b.webp": "bb"}, m))


class ReferenceTests(unittest.TestCase):
    @staticmethod
    def art(w=300, h=200, shift=(0, 0)):
        import math
        im = Image.new("RGB", (w + 40, h + 40))
        px = im.load()
        for x in range(im.width):
            for y in range(im.height):  # smooth "landmarks": a few broad blobs, like real map art after downscaling
                v = 128 + 70 * math.sin(x / 23.0) * math.cos(y / 31.0) + 40 * math.sin((x + y) / 57.0)
                px[x, y] = (int(v) % 256, int(255 * x / im.width), int(255 * y / im.height))
        return im.crop((20 + shift[0], 20 + shift[1], 20 + shift[0] + w, 20 + shift[1] + h))

    def test_identical_art_matches_reference(self):
        r = compare_to_reference(self.art(), self.art())
        self.assertEqual((r.verdict, r.same_dimensions), ("matches-reference", True))

    def test_a_crop_offset_is_reported_with_its_shift_and_nothing_is_corrected(self):
        r = compare_to_reference(self.art(), self.art(shift=(6, 4)), match_error=8.0)
        self.assertEqual(r.verdict, "cropped-or-shifted")
        self.assertNotEqual(r.best_shift, (0, 0))
        self.assertLess(r.mean_error_best, r.mean_error_aligned)

    def test_different_aspect_or_unrelated_art_differs(self):
        self.assertEqual(compare_to_reference(self.art(), self.art(400, 200)).verdict, "differs")
        noise = Image.effect_noise((300, 200), 90).convert("RGB")
        self.assertEqual(compare_to_reference(self.art(), noise).verdict, "differs")
        self.assertEqual(compare_to_reference(self.art(), self.art(), match_error=14.0).to_json()["sameDimensions"], True)


class FakeCasc:
    def __init__(self, files):
        self.files, self.calls = files, []

    def read(self, fd):
        self.calls.append(fd)
        return self.files.get(fd)

    def close(self):
        pass


class ExtractTests(unittest.TestCase):
    def test_writes_only_blp_files_lists_misses_and_resumes(self):
        with tempfile.TemporaryDirectory() as d:
            dest = Path(d)
            casc = FakeCasc({1: b"BLP2" + b"x" * 20, 2: b"PNG\x89" + b"x" * 20, 4: b"BLP1" + b"y" * 20})
            s = extract_blps(casc, {1, 2, 3, 4}, dest)
            self.assertEqual((s["written"], s["missingFromClient"], s["notBlp"]), (2, [3], [2]))
            self.assertEqual(sorted(p.name for p in dest.glob("*.blp")), ["1.blp", "4.blp"])
            again = FakeCasc(casc.files)
            s2 = extract_blps(again, {1, 2, 3, 4}, dest)
            self.assertEqual(s2["alreadyPresent"], 2)
            self.assertEqual(sorted(again.calls), [2, 3])  # existing valid files are not re-read
            self.assertEqual(json.loads((dest / "_extract.json").read_text())["requested"], 4)


if __name__ == "__main__":
    unittest.main()
