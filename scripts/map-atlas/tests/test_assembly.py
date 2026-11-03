import io
import tempfile
import unittest
from pathlib import Path

import common  # noqa: F401
from PIL import Image
from synth import TILE, Bundle, blp2_dxt1, blp2_dxt5_solid, expected_rgb, standard_bundle
from mapatlas.assemble import assemble_layer, decode_blp
from mapatlas.inventory import build_inventory
from mapatlas.validate import check_image, pixel_sha256, seam_ratio, verify_webp


def layer_of(b: Bundle, art_id: int, layer_index: int = 0):
    inv = build_inventory(b.db2)
    e = next(m for m in inv.maps.values() for v in m.variants if v.map_art_id == art_id)
    v = next(v for v in e.variants if v.map_art_id == art_id)
    return next(l for l in v.layers if l.index == layer_index)


def source_for(b: Bundle):
    return lambda fd: (b.blp / f"{fd}.blp").read_bytes() if (b.blp / f"{fd}.blp").is_file() else None


class BlpTests(unittest.TestCase):
    def test_decodes_wow_style_blp2_dxt1_and_dxt5_with_alpha(self):
        blocks = b"".join(__import__("struct").pack("<HHI", c, c, 0) for c in (0xF800, 0x07E0, 0x001F, 0xFFE0))
        im = decode_blp(blp2_dxt1(8, 8, blocks))
        self.assertEqual(im.mode, "RGBA")
        self.assertEqual([im.getpixel(p)[:3] for p in [(1, 1), (5, 1), (1, 5), (5, 5)]], [(248, 0, 0), (0, 252, 0), (0, 0, 248), (248, 252, 0)])
        a = decode_blp(blp2_dxt5_solid(8, 8, (255, 0, 0), 128))
        self.assertEqual(a.getpixel((2, 2))[3], 128)

    def test_non_blp_and_truncated_data_are_rejected(self):
        buf = io.BytesIO()
        Image.new("RGB", (4, 4)).save(buf, "PNG")
        with self.assertRaises(ValueError):
            decode_blp(buf.getvalue())
        with self.assertRaises(Exception):
            decode_blp(b"BLP2" + b"\xff" * 40)


class AssemblyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.b = standard_bundle(Path(self.tmp.name))
        self.b.finish()

    def test_tiles_are_placed_by_row_col_and_cropped_to_the_layer_like_the_companion(self):
        layer = layer_of(self.b, 7003)  # 1002x668 from 4x3 tiles of 256
        self.assertEqual((layer.columns, layer.rows, layer.expected_tiles), (4, 3, 12))
        res = assemble_layer(layer, source_for(self.b))
        self.assertTrue(res.complete)
        self.assertEqual(res.image.size, (1002, 668))  # 1024x768 of tile area cropped to the layer, not stretched
        self.assertEqual(res.placed, 12)
        # global gradient continuity proves each tile sits at (col*256, row*256)
        for x, y in ((10, 10), (300, 20), (700, 300), (1000, 660), (520, 400), (130, 600)):
            r, g, bl, a = res.image.getpixel((x, y))
            er, eg, eb = expected_rgb(x, y, 1002, 668, 90)
            self.assertLess(abs(r - er), 12, (x, y))
            self.assertLess(abs(g - eg), 12, (x, y))
            self.assertLess(abs(bl - eb), 12, (x, y))
            self.assertEqual(a, 255)

    def test_swapped_tiles_are_detected_as_seams(self):
        d = Path(self.tmp.name) / "sw"
        sw = Bundle(d)
        sw.add_art(1, 1, 1, [(0, 1002, 668)], swap=((0, 1), (1, 2)))
        sw.add_map(1, "Swapped", 0, 3)
        sw.finish()
        layer = layer_of(sw, 1)
        res = assemble_layer(layer, source_for(sw))
        good = assemble_layer(layer_of(self.b, 7003), source_for(self.b))
        self.assertLess(seam_ratio(good.image, TILE, TILE), 2.0)
        self.assertGreater(seam_ratio(res.image, TILE, TILE), 4.0)
        chk = check_image(res.image, 1002, 668, TILE, TILE, True)
        self.assertTrue(any("seams" in w for w in chk.warnings))

    def test_missing_tile_is_reported_and_never_painted_over(self):
        layer = layer_of(self.b, 7004)
        res = assemble_layer(layer, source_for(self.b))
        self.assertFalse(res.complete)
        self.assertEqual(len(res.missing_files), 1)
        # tile (1,1) of a 520x390 layer: x 256..519, y 256..389 stays fully transparent
        self.assertEqual(res.image.getpixel((400, 300))[3], 0)
        self.assertEqual(res.image.getpixel((100, 100))[3], 255)
        chk = check_image(res.image, 520, 390, TILE, TILE, res.complete)
        self.assertIn("incomplete tile coverage", chk.errors)

    def test_corrupt_tile_is_a_recorded_decode_failure(self):
        c = Bundle(Path(self.tmp.name) / "c")
        c.add_map(1, "Corrupt", 0, 3)
        c.add_art(1, 1, 1, [(0, 512, 256)], corrupt={(0, 1)})
        c.finish()
        res = assemble_layer(layer_of(c, 1), source_for(c))
        self.assertEqual(len(res.decode_failures), 1)
        self.assertFalse(res.complete)
        self.assertEqual(res.placed, 1)

    def test_alpha_is_copied_verbatim_not_blended(self):
        from mapatlas.inventory import Layer
        layer = Layer(0, 8, 8, 8, 8, {(0, 0): 5})
        res = assemble_layer(layer, lambda fd: blp2_dxt5_solid(8, 8, (0, 255, 0), 100))
        self.assertEqual(res.image.getpixel((3, 3))[3], 100)

    def test_blank_and_transparent_images_are_rejected(self):
        layer = layer_of(self.b, 7008)
        res = assemble_layer(layer, source_for(self.b))
        self.assertIn("image is blank (no tonal variation)", check_image(res.image, 256, 256, TILE, TILE, True).errors)
        self.assertIn("image is entirely transparent", check_image(Image.new("RGBA", (64, 64)), 64, 64, TILE, TILE, True).errors)

    def test_dimension_and_aspect_mismatch_are_errors(self):
        img = Image.effect_noise((100, 50), 80).convert("RGBA")
        errs = check_image(img, 100, 100, TILE, TILE, True).errors
        self.assertTrue(any("dimensions" in e for e in errs) and any("aspect" in e for e in errs))
        self.assertTrue(any("unexpected aspect" in w for w in check_image(Image.effect_noise((1000, 100), 80).convert("RGBA"), 1000, 100, TILE, TILE, True).warnings))

    def test_webp_verification_catches_corruption_size_and_lost_alpha(self):
        img = Image.effect_noise((64, 64), 60).convert("RGBA")
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=90)
        self.assertEqual(verify_webp(buf.getvalue(), img), [])
        self.assertTrue(verify_webp(buf.getvalue()[:40], img))
        self.assertTrue(any("size" in p for p in verify_webp(buf.getvalue(), Image.new("RGBA", (32, 32)))))
        a = Image.new("RGBA", (64, 64), (200, 10, 10, 90))
        b = io.BytesIO()
        a.convert("RGB").save(b, "WEBP", quality=90)
        self.assertTrue(any("transparency" in p for p in verify_webp(b.getvalue(), a)))

    def test_pixel_hash_depends_on_pixels_and_size_only(self):
        a = Image.new("RGBA", (4, 4), (1, 2, 3, 255))
        self.assertEqual(pixel_sha256(a), pixel_sha256(a.copy()))
        self.assertNotEqual(pixel_sha256(a), pixel_sha256(Image.new("RGBA", (2, 8), (1, 2, 3, 255))))


if __name__ == "__main__":
    unittest.main()
