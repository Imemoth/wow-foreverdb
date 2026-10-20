"""Offline preview gallery (contact sheet). Static HTML + small thumbnails; no network requests; every value HTML-escaped."""
from __future__ import annotations

import html
from pathlib import Path

from PIL import Image

from .identity import BuildIdentity

CSS = ("body{background:#07091c;color:#ece6d9;font:14px system-ui,sans-serif;margin:1.5rem}h1,h2{font-weight:600}"
       ".g{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}"
       ".c{background:#191a47;border:1px solid #2c2d66;border-radius:8px;padding:8px}.c img{width:100%;display:block;border-radius:4px;background:#0d0f33}"
       ".m{color:#a8a9c8;font-size:12px;margin-top:6px}.bad{color:#f08a7e}.warn{color:#e6b95c}code{color:#c3aef2}")


def write_gallery(out: Path, dist: Path, per_map: dict[int, dict], ident: BuildIdentity, thumbs: dict[int, Image.Image], index: dict) -> None:
    (out / "thumbs").mkdir(parents=True, exist_ok=True)
    e = html.escape
    cards, missing = [], []
    for ent in index["maps"]:
        mid = ent["uiMapId"]
        rec = per_map.get(mid, {})
        if mid in thumbs:
            thumbs[mid].convert("RGB").save(out / "thumbs" / f"{mid}.webp", "WEBP", quality=70, method=4)
            warns = sorted({w for im in rec.get("images", []) for w in im["warnings"]})
            dims = f"{ent['image']['width']}×{ent['image']['height']}" if ent.get("image") else ""
            cards.append(f'<div class="c"><img loading="lazy" src="thumbs/{mid}.webp" alt="{e(str(ent.get("name", "")))}">'
                         f'<div><b>{e(str(ent.get("name", "")))}</b></div>'
                         f'<div class="m">uiMapID <code>{mid}</code> · {e(str(ent.get("type", "")))} · parent {e(str(ent.get("parentUiMapId")))} · {dims} · {e(str(ent.get("latestVersion", "")))}</div>'
                         + "".join(f'<div class="m warn">⚠ {e(w)}</div>' for w in warns) + "</div>")
        else:
            missing.append(f'<li><code>{mid}</code> {e(str(ent.get("name", "?")))} — {e(ent["availability"])}'
                           f'{(": " + e("; ".join(rec.get("reasons", [])[:2]))) if rec.get("reasons") else ""}</li>')
    page = (f'<!doctype html><meta charset="utf-8"><title>AzerDex map atlas preview</title><style>{CSS}</style>'
            f'<h1>Map atlas preview — client {e(ident.version)} ({e(ident.product)})</h1>'
            f'<p class="m">{len(cards)} exported this run · {len(missing)} without an exported image. Review aid only; not part of the CDN package.</p>'
            f'<div class="g">{"".join(cards)}</div><h2>No image</h2><ul>{"".join(missing)}</ul>')
    (out / "index.html").write_text(page, encoding="utf-8")
