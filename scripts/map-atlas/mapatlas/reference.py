"""Compare an exported map with an existing accepted reference image (the user-supplied Tirisfal 1002x668 art).
Only EVIDENCE is produced (dimensions, aspect, best alignment shift, error); calibration is never promoted to 'validated' here."""
from __future__ import annotations

from dataclasses import asdict, dataclass

from PIL import Image, ImageChops, ImageStat

SHIFT = 6
SIZE = 256


@dataclass
class ReferenceComparison:
    reference_size: tuple[int, int]
    exported_size: tuple[int, int]
    same_dimensions: bool
    aspect_delta: float
    mean_error_aligned: float          # at zero shift, 0-255
    best_shift: tuple[int, int]        # at 256px width; (0,0) = edges line up
    mean_error_best: float
    verdict: str                       # matches-reference | cropped-or-shifted | differs

    def to_json(self) -> dict:
        d = asdict(self)
        d["reference_size"], d["exported_size"], d["best_shift"] = list(self.reference_size), list(self.exported_size), list(self.best_shift)
        return {"referenceSize": d["reference_size"], "exportedSize": d["exported_size"], "sameDimensions": d["same_dimensions"],
                "aspectDelta": round(d["aspect_delta"], 5), "meanErrorAligned": round(d["mean_error_aligned"], 2),
                "bestShift": d["best_shift"], "meanErrorBest": round(d["mean_error_best"], 2), "verdict": d["verdict"]}


def _prep(img: Image.Image) -> Image.Image:
    img = img.convert("RGB")
    h = max(1, round(SIZE * img.height / img.width))
    return img.resize((SIZE, h), Image.LANCZOS)


def _err(a: Image.Image, b: Image.Image, dx: int, dy: int) -> float:
    w, h = a.size
    box_a = (max(dx, 0), max(dy, 0), w + min(dx, 0), h + min(dy, 0))
    box_b = (max(-dx, 0), max(-dy, 0), w + min(-dx, 0), h + min(-dy, 0))
    d = ImageChops.difference(a.crop(box_a), b.crop(box_b))
    return sum(ImageStat.Stat(d).mean) / 3


def compare_to_reference(reference: Image.Image, exported: Image.Image, match_error: float = 14.0) -> ReferenceComparison:
    ra, ea = reference.width / reference.height, exported.width / exported.height
    r, e = _prep(reference), _prep(exported)
    if r.size != e.size:  # aspect differs: compare on the reference grid, fit-stretched, only to quantify how different it is
        e = e.resize(r.size, Image.LANCZOS)
    aligned = _err(r, e, 0, 0)
    best, best_err = (0, 0), aligned
    for dy in range(-SHIFT, SHIFT + 1):
        for dx in range(-SHIFT, SHIFT + 1):
            er = _err(r, e, dx, dy)
            if er < best_err - 1e-9:
                best, best_err = (dx, dy), er
    same_dims = reference.size == exported.size
    aspect_delta = abs(ra - ea) / ra
    if same_dims and aligned <= match_error and best_err > aligned - 1.0:  # close AND no offset aligns it noticeably better
        verdict = "matches-reference"
    elif (aspect_delta < 0.02 and best_err <= match_error and best_err < aligned - 2.0
          and max(abs(best[0]), abs(best[1])) < SHIFT):  # a real offset improves a lot and sits inside the search window
        verdict = "cropped-or-shifted"
    else:
        verdict = "differs"
    return ReferenceComparison(reference.size, exported.size, same_dims, aspect_delta, aligned, best, best_err, verdict)
