"""Structural and visual-sanity checks on assembled images. Everything here only FLAGS; nothing is repaired."""
from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass, field

from PIL import Image, ImageChops, ImageStat

BLANK_STDDEV = 1.5
TRANSPARENT_WARN = 0.5


@dataclass
class ImageChecks:
    errors: list[str] = field(default_factory=list)    # exclude the image from packaging
    warnings: list[str] = field(default_factory=list)  # kept, but flagged for visual review

    @property
    def ok(self) -> bool:
        return not self.errors


def pixel_sha256(img: Image.Image) -> str:
    rgba = img.convert("RGBA")
    return hashlib.sha256(f"{rgba.width}x{rgba.height}:".encode() + rgba.tobytes()).hexdigest()


def _mean(img: Image.Image) -> float:
    s = ImageStat.Stat(img.convert("RGB")).mean
    return sum(s) / len(s)


def seam_ratio(img: Image.Image, tile_w: int, tile_h: int) -> float:
    """How much stronger tile-boundary discontinuities are than ordinary pixel-to-pixel change inside tiles (1.0 = no seams)."""
    rgb = img.convert("RGB")
    w, h = rgb.size

    def diff(a: tuple, b: tuple) -> float:
        return _mean(ImageChops.difference(rgb.crop(a), rgb.crop(b)))

    inside, boundary = [], []
    for x in range(tile_w, w, tile_w):
        boundary.append(diff((x - 1, 0, x, h), (x, 0, x + 1, h)))
        for off in (tile_w // 4, tile_w // 2, 3 * tile_w // 4):
            if x - tile_w + off + 1 < w:
                inside.append(diff((x - tile_w + off, 0, x - tile_w + off + 1, h), (x - tile_w + off + 1, 0, x - tile_w + off + 2, h)))
    for y in range(tile_h, h, tile_h):
        boundary.append(diff((0, y - 1, w, y), (0, y, w, y + 1)))
        for off in (tile_h // 4, tile_h // 2, 3 * tile_h // 4):
            if y - tile_h + off + 1 < h:
                inside.append(diff((0, y - tile_h + off, w, y - tile_h + off + 1), (0, y - tile_h + off + 1, w, y - tile_h + off + 2)))
    if not boundary or not inside:
        return 1.0
    base = max(sum(inside) / len(inside), 1.0)
    return (sum(boundary) / len(boundary)) / base


def check_image(img: Image.Image, layer_w: int, layer_h: int, tile_w: int, tile_h: int, complete: bool) -> ImageChecks:
    c = ImageChecks()
    if img.size != (layer_w, layer_h):
        c.errors.append(f"dimensions {img.size} != layer {(layer_w, layer_h)}")
    ar, lr = img.width / max(img.height, 1), layer_w / max(layer_h, 1)
    if abs(ar - lr) > 0.005:
        c.errors.append(f"aspect ratio {ar:.4f} differs from layer {lr:.4f}")
    if ar > 4 or ar < 0.25:
        c.warnings.append(f"unexpected aspect ratio {ar:.3f}")
    rgba = img.convert("RGBA")
    alpha_max = rgba.getchannel("A").getextrema()[1]
    if alpha_max == 0:
        c.errors.append("image is entirely transparent")
    else:
        stat = ImageStat.Stat(rgba)
        if max(stat.stddev[:3]) < BLANK_STDDEV:
            c.errors.append("image is blank (no tonal variation)")
        transparent = 1 - ImageStat.Stat(rgba.getchannel("A")).mean[0] / 255
        if transparent > TRANSPARENT_WARN:
            c.warnings.append(f"{transparent:.0%} of pixels are transparent")
    if not complete:
        c.errors.append("incomplete tile coverage")
    elif tile_w > 8 and tile_h > 8 and (img.width > tile_w or img.height > tile_h):
        r = seam_ratio(img, tile_w, tile_h)
        if r > 4.0:
            c.warnings.append(f"possible tile seams or misordered tiles (boundary/interior change ratio {r:.1f})")
    return c


def verify_webp(data: bytes, original: Image.Image, max_mean_error: float = 6.0) -> list[str]:
    """Re-decode the encoded file and make sure it is a valid WebP of the same size, with alpha kept, and close to the source."""
    problems = []
    try:
        back = Image.open(io.BytesIO(data))
        back.load()
    except Exception as e:  # noqa: BLE001 - any decode failure means a corrupt output
        return [f"WebP does not decode: {type(e).__name__}"]
    if back.format != "WEBP":
        problems.append(f"output is {back.format}, not WEBP")
    if back.size != original.size:
        problems.append(f"WebP size {back.size} != {original.size}")
        return problems
    a, b = original.convert("RGBA"), back.convert("RGBA")
    if a.getchannel("A").getextrema()[0] < 255 and b.getchannel("A").getextrema()[0] == 255:
        problems.append("transparency lost in WebP")
    err = _mean(ImageChops.difference(a.convert("RGB"), b.convert("RGB")))
    if err > max_mean_error:
        problems.append(f"WebP deviates from source (mean error {err:.1f})")
    return problems
