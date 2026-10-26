"""Global catalog for an imported atlas: atlas/index.json, hierarchy.json, instances.json, builds.json and _headers.
All derived from the exporter's own metadata and the manifests actually present in dist/ — nothing is invented."""
from __future__ import annotations

import json
from pathlib import Path

import PIL
from PIL import features

from . import TOOL_VERSION
from .exporter_zip import ExporterSource
from .identity import BuildIdentity
from .manifest import canonical_json
from .packaging import HEADERS
from .versioning import Ledger

# availability vocabulary (documented in docs/web/map-atlas.md):
#   available          drawable map with artwork packaged from this source
#   no-artwork         the client defines the map but gives it no artwork of its own (listed, never synthesised)
#   published-earlier  only present in an older published version (not in this source)
# Instance records without any interior UiMap live ONLY in instances.json; invalid assets cannot occur in an accepted (complete) import.


def _vnum(v: str) -> int:
    return int(v[1:])


def _variant_files(man: dict, mid: int, ver: str) -> list[dict]:
    out = []
    for v in man.get("variants", []) or []:
        imgs = v.get("images")
        if not isinstance(imgs, list):
            continue
        ov = next((i for i in imgs if i.get("role") == "overview"), imgs[0] if imgs else None)
        if ov is None:
            continue
        rec = {"variant": v["variant"], "kind": v.get("kind"), "path": f"forever/{mid}/{ver}/{ov['file']}", "width": ov["width"], "height": ov["height"],
               "bytes": ov["bytes"], "sha256": ov["sha256"], "isDefault": bool(v.get("isDefault"))}
        if v.get("reveal"):
            rec["revealCompleteness"] = v["reveal"].get("completeness")
            rec["revealStatus"] = v["reveal"].get("status")
        out.append(rec)
    return out


def write_catalog(o, dist: Path, src: ExporterSource, ident: BuildIdentity, results: dict[int, dict], ledger: Ledger) -> dict:
    atlas = dist / "atlas"
    atlas.mkdir(exist_ok=True)
    (dist / "_headers").write_text(HEADERS, encoding="utf-8")
    on_disk: dict[int, dict[str, dict]] = {}
    for mp in sorted((dist / "forever").glob("*/*/manifest.json")):
        on_disk.setdefault(int(mp.parent.parent.name), {})[mp.parent.name] = json.loads(mp.read_text(encoding="utf-8"))
    by_id = {m.ui_map_id: m for m in src.maps}

    entries = []
    for mid in sorted(set(by_id) | set(on_disk)):
        sm = by_id.get(mid)
        versions = sorted(on_disk.get(mid, {}), key=_vnum)
        packaged = results.get(mid, {}).get("packaged")
        if packaged:
            availability = "available"
        elif versions:
            availability = "published-earlier"
        else:
            availability = "no-artwork"
        ent: dict = {"uiMapId": mid, "availability": availability, "versions": versions}
        latest = on_disk[mid][versions[-1]] if versions else None
        if sm is not None:
            e = sm.entry
            ent |= {"name": e["name"], "slug": e["slug"], "category": e["category"], "classificationConfidence": e["classificationConfidence"],
                    "typeName": e.get("typeName"), "parentUiMapId": e.get("parentUiMapId") or None, "internalMapId": e["internalMapId"], "system": e.get("system")}
            if not sm.variants:
                ent["statusDetail"] = e.get("statusDetail") or e["status"]
        elif latest is not None:
            ent |= {"name": latest["zoneName"], "slug": latest["slug"], "category": latest.get("category"), "typeName": latest.get("typeName") or (latest.get("mapType") or {}).get("name"),
                    "parentUiMapId": latest.get("parentUiMapId"), "internalMapId": latest.get("internalMapId")}
        if latest is not None:
            ver = versions[-1]
            img = latest["image"]
            ent |= {"latestVersion": ver, "manifest": f"forever/{mid}/{ver}/manifest.json",
                    "image": {"path": f"forever/{mid}/{ver}/{img['file']}", "width": img["width"], "height": img["height"], "bytes": img["bytes"], "sha256": img["sha256"],
                              "variant": img.get("variant")},
                    "defaultVariant": (latest.get("defaultImage") or {}).get("variant"),
                    "variants": _variant_files(latest, mid, ver),
                    "hasFullReveal": any(v.get("kind") == "full-reveal" for v in latest.get("variants", []) if isinstance(v, dict)),
                    "clientBuild": (latest.get("clientBuild") or {}).get("version", "legacy-poc")}
        entries.append(ent)

    def group(key) -> dict:
        out: dict[str, list[int]] = {}
        for en in entries:
            k = key(en)
            for kk in (k if isinstance(k, list) else [k]):
                if kk is not None:
                    out.setdefault(str(kk), []).append(en["uiMapId"])
        return {k: sorted(v) for k, v in sorted(out.items())}

    def builds_of(en) -> list[str]:
        return sorted({(m.get("clientBuild") or {}).get("version", "legacy-poc") for m in on_disk.get(en["uiMapId"], {}).values()})

    index = {
        "schemaVersion": 1, "kind": "azerdex-atlas-index", "currentBuild": ident.to_json(),
        "counts": {"maps": len(entries), **{k: len(v) for k, v in group(lambda x: x["availability"]).items()}},
        "notes": ["This index lists maps, not observations: a drawable map says nothing about whether any observation exists on it.",
                  "Slugs are labels, not identifiers: several maps can share one (use uiMapId)."],
        "maps": entries,
        "lookup": {
            "byParent": group(lambda x: x.get("parentUiMapId") or 0), "byType": group(lambda x: x.get("typeName")), "byCategory": group(lambda x: x.get("category")),
            "byAvailability": group(lambda x: x["availability"]), "byBuild": group(builds_of),
            "byName": group(lambda x: x.get("slug")), "byFullReveal": group(lambda x: "full-reveal" if x.get("hasFullReveal") else "base-only"),
        },
    }
    (atlas / "index.json").write_text(canonical_json(index), encoding="utf-8")

    avail = {e["uiMapId"]: e for e in entries}
    h = src.hierarchy
    nodes = []
    for n in sorted(h["nodes"], key=lambda x: x["uiMapId"]):
        a = avail[n["uiMapId"]]
        nodes.append({"uiMapId": n["uiMapId"], "name": n["name"], "parentUiMapId": n["parentUiMapId"] or None, "depth": n["depth"], "children": sorted(n["children"]),
                      "parentMissing": n["parentMissing"], "category": a.get("category"), "availability": a["availability"], "latestVersion": a.get("latestVersion")})
    hier = {"schemaVersion": 1, "kind": "azerdex-atlas-hierarchy", "build": ident.version, "roots": sorted(h["roots"]),
            "orphanedByMissingParent": h.get("orphanedByMissingParent", []), "cycleMembers": h.get("cycleMembers", []), "nodes": nodes,
            "links": h.get("links", []), "instances": h.get("instances", []), "note": h.get("note", "")}
    (atlas / "hierarchy.json").write_text(canonical_json(hier), encoding="utf-8")

    recs, dev, cls, dcls, drawable = [], 0, {}, {}, 0
    from .importer import development_flags
    for r in src.instances["instances"]:
        flags = development_flags(r)
        dev += bool(flags)
        cls[r["classification"]] = cls.get(r["classification"], 0) + 1
        maps_ = []
        for u in r.get("uiMaps") or []:
            a = avail.get(u["uiMapId"], {})
            maps_.append({"uiMapId": u["uiMapId"], "availability": a.get("availability"), "manifest": a.get("manifest"), "latestVersion": a.get("latestVersion")})
        if r.get("drawable"):
            drawable += 1
            dcls[r["classification"]] = dcls.get(r["classification"], 0) + 1
        verified_floors = any(u.get("floorSource") == "UiMapGroupMember" for u in r.get("uiMaps") or [])
        recs.append(dict(sorted(r.items())) | {"catalog": {
            "visibility": "unreviewed", "releaseStatus": "unverified",
            "releaseNote": "The client metadata does not say whether this record is a released, playable instance; a curated visibility layer must decide.",
            "developmentFlags": flags, "drawableMaps": maps_, "floorsVerified": verified_floors}})
    inst = {
        "schemaVersion": 1, "kind": "azerdex-atlas-instances", "client": ident.to_json(),
        "source": {"kind": "exporter-zip", "exporter": src.build["exporter"], "coverage": src.instances.get("coverage"), "identity": src.instances.get("identity"),
                   "notes": src.instances.get("notes", []), "sourceCounts": src.instances.get("counts")},
        "counts": {"records": len(recs), "drawable": drawable, "withoutInteriorMap": len(recs) - drawable, "byClassification": dict(sorted(cls.items())),
                   "drawableByClassification": dict(sorted(dcls.items())), "developmentSuspected": dev},
        "policy": ["Raw catalog: every record the client's Map table defines, including development/test entries (flagged by transparent heuristics, never removed).",
                   "mapId is the internal Map ID. uiMapId and mapArtId are different identifiers and are never substituted for it.",
                   "Records without an interior UiMap have no artwork and none is invented; floor order and entrances stay unverified unless floorsVerified is true."],
        "instances": recs,
    }
    (atlas / "instances.json").write_text(canonical_json(inst), encoding="utf-8")

    prev = []
    if o.previous_dist and (o.previous_dist / "atlas/builds.json").is_file():
        prev = json.loads((o.previous_dist / "atlas/builds.json").read_text(encoding="utf-8"))["builds"]
    n_var = sum(len(m.variants) for m in src.maps)
    this = ident.to_json() | {
        "import": {"kind": "exporter-zip", "exporter": src.build["exporter"], "zipSha256": src.zip_sha256, "zipBytes": src.zip_bytes, "metadataSource": src.build.get("metadataSource"),
                   "tableRowCounts": src.build.get("tableRowCounts"), "tableSources": src.build.get("tableSources")},
        "counts": {"maps": len(src.maps), "variants": n_var, "images": src.stats["images"], "instances": len(recs)},
        "tool": {"name": "azerdex-map-atlas", "version": TOOL_VERSION, "pillow": PIL.__version__, "libwebp": features.version("webp")},
    }
    builds = [b for b in prev if b["version"] != ident.version] + [this]
    builds.sort(key=lambda b: (b["buildNumber"], b["version"]))
    (atlas / "builds.json").write_text(canonical_json({"schemaVersion": 1, "builds": builds, "latest": builds[-1]["version"]}), encoding="utf-8")
    return {"index": index, "hierarchy": hier, "instances": inst, "builds": builds}
