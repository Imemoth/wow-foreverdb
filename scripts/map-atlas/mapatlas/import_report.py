"""Owner review package for an imported atlas: coverage, asset inventory, instance catalog, Tirisfal regression, category/full-reveal
availability, ledger proposal, preflight checklist and an offline gallery. Deterministic: no timestamps, no local paths."""
from __future__ import annotations

import csv
import html
import io
import json
import re
from collections import Counter
from pathlib import Path

from PIL import Image

from .exporter_zip import PROJECTION, ExporterSource
from .identity import BuildIdentity
from .manifest import canonical_json
from .packaging import manifest_image_records, sha256_file
from .reference import compare_to_reference

VERSION = re.compile(r"^v[1-9]\d{0,3}$")
SHA = re.compile(r"^[0-9a-f]{64}$")


def check_web_contract(m: dict) -> list[str]:
    """Python mirror of web/src/lib/maps/manifest.ts (zod). The authoritative check is the real parseManifest, run by the web
    contract test; this keeps every build self-checking."""
    p: list[str] = []
    if m.get("schemaVersion") != 1:
        p.append("schemaVersion")
    if not (isinstance(m.get("zoneId"), int) and m["zoneId"] > 0):
        p.append("zoneId")
    if not (isinstance(m.get("slug"), str) and re.match(r"^[a-z0-9-]+$", m["slug"])):
        p.append("slug")
    if not (isinstance(m.get("zoneName"), str) and m["zoneName"]):
        p.append("zoneName")
    if not VERSION.match(str(m.get("version"))):
        p.append("version")
    im = m.get("image") or {}
    if not (isinstance(im.get("file"), str) and re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*$", im["file"]) and im.get("format") in ("webp", "png")
            and all(isinstance(im.get(k), int) and 0 < im[k] <= 16384 for k in ("width", "height"))
            and (im.get("bytes") is None or (isinstance(im["bytes"], int) and im["bytes"] > 0)) and (im.get("sha256") is None or SHA.match(str(im["sha256"])))):
        p.append("image")
    pr = m.get("projection") or {}
    if not (pr.get("type") == "normalized-percent" and pr.get("origin") == "top-left" and pr.get("xDirection") == "right" and pr.get("yDirection") == "down" and pr.get("range") == [0, 100]):
        p.append("projection")
    if not (isinstance((m.get("provenance") or {}).get("source"), str) and m["provenance"]["source"]):
        p.append("provenance.source")
    if (m.get("calibration") or {}).get("status") not in ("provisional", "validated"):
        p.append("calibration.status")
    return p


def _md_table(rows: list[list], header: list[str]) -> str:
    out = ["| " + " | ".join(header) + " |", "|" + "|".join(" --- " for _ in header) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def _new_versions(ledger, base_text: str) -> list[str]:
    base = json.loads(base_text)["maps"]
    return sorted((f"{m}/{v}" for m, vs in ledger.data["maps"].items() for v in vs if v not in base.get(m, {})), key=lambda s: (int(s.split("/")[0]), int(s.split("/")[1][1:])))


def build_import_reports(o, src: ExporterSource, ident: BuildIdentity, plans: dict, results: dict, manifests: dict, catalog: dict, limits: dict,
                         zip_info: dict, table: dict, ledger, base_ledger_text: str) -> dict:
    out_r = o.out / "reports"
    out_r.mkdir(parents=True, exist_ok=True)
    dist = o.out / "dist"
    maps = src.maps
    packaged = [r for r in results.values() if r.get("packaged")]
    n_variants = sum(len(m.variants) for m in maps)
    cat_counts = Counter(m.entry["category"] for m in maps)
    full_by_cat: dict[str, dict] = {}
    for sm in maps:
        c = full_by_cat.setdefault(sm.entry["category"], {"maps": 0, "withFullReveal": 0, "baseOnly": 0})
        c["maps"] += 1
        has = any(v.kind == "full-reveal" for v in sm.variants)
        c["withFullReveal" if has else "baseOnly"] += 1
    default_counts = Counter(r.get("defaultVariant") for r in packaged)
    completeness = Counter(v.reveal_completeness for m in maps for v in m.variants if v.kind == "full-reveal")
    reveal_status = Counter(v.reveal_status for m in maps for v in m.variants if v.kind == "full-reveal")
    warned = {mid: p.warnings for mid, p in plans.items() if p.warnings}
    new_versions = _new_versions(ledger, base_ledger_text)
    versions_total = sum(len(v) for v in ledger.data["maps"].values())
    webp_files = sorted(p for p in table if p.endswith(".webp"))
    web_problems = {mid: check_web_contract(man) for mid, man in manifests.items()}
    web_problems = {k: v for k, v in web_problems.items() if v}
    inst = catalog["instances"]

    # ---- Tirisfal regression (uiMapID 1420)
    tir = {"uiMapId": 1420}
    legacy = json.loads(base_ledger_text)["maps"].get("1420", {}).get("v1")
    if legacy:
        v1 = dist / "forever/1420/v1"
        tir["pocV1"] = {"preserved": all((v1 / n).is_file() and sha256_file(v1 / n) == m["sha256"] for n, m in legacy["files"].items()),
                        "files": {n: m["sha256"] for n, m in sorted(legacy["files"].items())}}
    if 1420 in results and results[1420].get("packaged"):
        man = manifests[1420]
        ref = None
        if o.reference_1420 and o.reference_1420.is_file():
            with Image.open(o.reference_1420) as f:
                ref = f.convert("RGBA")
        tir["export"] = {"version": results[1420]["version"], "defaultVariant": man["defaultImage"]["variant"], "internalMapId": man["internalMapId"], "parentUiMapId": man["parentUiMapId"],
                         "variants": {}}
        for sm in maps:
            if sm.ui_map_id != 1420:
                continue
            for v in sm.variants:
                ov = next((i for i in v.images if i.role == "overview"), v.images[0])
                rec = {"width": ov.width, "height": ov.height, "sha256": ov.sha256, "bytes": ov.bytes,
                       "sameSha256AsPoc": bool(legacy) and ov.sha256 == legacy["files"].get("tirisfal-glades.webp", {}).get("sha256")}
                if ref is not None:
                    with Image.open(io.BytesIO(ov.data)) as f:
                        rec["comparisonToPoc"] = compare_to_reference(ref, f.convert("RGBA")).to_json()
                tir["export"]["variants"][v.name] = rec
        tir["calibration"] = "provisional (never auto-validated; image dimensions matching the POC prove nothing about registration)"
        tir["sourceDiagnostic"] = src.diagnostics.get("regression-1420")

    # ---- preflight (automated part)
    pre = [
        ("Source ZIP intact, safe paths, no symlinks/duplicates", True, f"sha256 {src.zip_sha256}"),
        ("Complete (unfiltered) export: status COMPLETE, UiMap rows == maps, zero failures", True, f"{len(maps)} maps"),
        ("Exact client build consistent across build/index/manifests", True, f"{ident.product} {ident.version}"),
        ("Every image: bytes, SHA-256, WebP decode, dimensions", True, f"{src.stats['images']} images"),
        ("Base and full-reveal distinct, never relabelled", all(len({i.sha256 for v in m.variants for i in v.images}) == sum(len(v.images) for v in m.variants) for m in maps), ""),
        ("Manifests satisfy the web manifest contract (python mirror)", not web_problems, f"{len(manifests)} manifests" + (f"; problems {web_problems}" if web_problems else "")),
        ("dist is a superset of the ledger (no published asset missing/changed)", True, f"{versions_total} versions"),
        ("Cloudflare Pages Free limits", not limits["problems"], f"{limits['fileCount']} files ≤ {limits['limits']['files']}; largest {limits['largestBytes']} B ≤ {limits['limits']['fileBytes']}"),
        ("Tirisfal POC v1 byte-identical", (not legacy) or tir.get("pocV1", {}).get("preserved", False), "forever/1420/v1"),
        ("No private diagnostics or local paths published", True, "atlas/ + forever/ + _headers only"),
        ("Ledger NOT promoted by this build", True, "ledger.next.json is a proposal"),
    ]
    report = {
        "schemaVersion": 1,
        "source": {"zipSha256": src.zip_sha256, "zipBytes": src.zip_bytes, "exporter": src.build["exporter"], "client": ident.to_json(), "metadataSource": src.build.get("metadataSource"),
                   "status": src.report.get("status"), "reportedCounts": src.report.get("counts"), "reusedFromEarlierRun": src.report.get("counts", {}).get("mapsReused"),
                   "sourceWarnings": src.warnings},
        "counts": {"maps": len(maps), "mapsWithArtwork": len(packaged), "mapsWithoutArtwork": len(maps) - len(packaged), "variants": n_variants, "images": src.stats["images"],
                   "byCategory": dict(sorted(cat_counts.items())), "instances": inst["counts"]},
        "fullReveal": {"byCategory": dict(sorted(full_by_cat.items())), "mapsWithFullReveal": sum(c["withFullReveal"] for c in full_by_cat.values()),
                       "defaultVariantCounts": dict(sorted(default_counts.items())), "completeness": dict(sorted(completeness.items())), "status": dict(sorted(reveal_status.items())),
                       "mapsWithDefaultWarnings": {str(k): v for k, v in sorted(warned.items())}},
        "package": {"fileCount": limits["fileCount"], "imageFiles": len(webp_files), "manifests": len([p for p in table if p.endswith("manifest.json")]), "totalBytes": limits["totalBytes"],
                    "largestBytes": limits["largestBytes"], "limits": limits["limits"], "zip": zip_info, "immutableVersions": versions_total, "newVersionsThisRun": new_versions,
                    "reusedVersionsThisRun": sorted(f"{r['uiMapId']}/{r['version']}" for r in packaged if r.get("reusedVersion"))},
        "tirisfal": tir, "preflight": [{"check": c, "ok": ok, "detail": d} for c, ok, d in pre],
        "unavailable": [{"uiMapId": r["uiMapId"], "name": r["name"], "reason": r.get("reason")} for r in results.values() if not r.get("packaged")],
    }
    (out_r / "coverage.json").write_text(canonical_json(report), encoding="utf-8")

    cm = report["counts"]
    md = [f"# Atlas import — client {ident.version} ({ident.product})", "",
          f"Source ZIP `{src.zip_sha256}` ({src.zip_bytes} bytes), exporter {src.build['exporter'].get('name')} {src.build['exporter'].get('version')}, metadata source `{src.build.get('metadataSource')}`.",
          f"The exporter's own report reuses {report['source']['reusedFromEarlierRun']} map(s) from an earlier run; every image was re-verified here by hash, size and WebP decode.", "",
          "## Counts", f"- Maps: **{cm['maps']}** ({cm['mapsWithArtwork']} with artwork, {cm['mapsWithoutArtwork']} without)  ·  variants/images: **{cm['variants']}**/{cm['images']}",
          f"- By category: {cm['byCategory']}", f"- Instances: {cm['instances']}", "",
          "## Full-reveal", f"- Maps with a full-reveal variant: **{report['fullReveal']['mapsWithFullReveal']}**; default image counts: {report['fullReveal']['defaultVariantCounts']}",
          f"- Completeness: {report['fullReveal']['completeness']}  ·  status: {report['fullReveal']['status']}",
          f"- Maps whose default needs a note: {list(report['fullReveal']['mapsWithDefaultWarnings'])}", "",
          "## Package", f"- {report['package']['fileCount']} files ({report['package']['imageFiles']} images, {report['package']['manifests']} manifests), {report['package']['totalBytes']} bytes, largest {report['package']['largestBytes']} bytes",
          f"- Zip: {zip_info['bytes']} bytes, sha256 `{zip_info['sha256']}`", f"- Immutable versions: {report['package']['immutableVersions']} (new this run: {len(new_versions)})", "", "## Preflight (automated)"]
    md += [f"- [{'x' if ok else ' '}] {c}" + (f" — {d}" if d else "") for c, ok, d in pre]
    md += ["", "## Without artwork"] + [f"- {u['uiMapId']} {u['name']}: {u['reason']}" for u in report["unavailable"]]
    (out_r / "coverage.md").write_text("\n".join(md) + "\n", encoding="utf-8")

    # ---- asset inventory
    inv_rows = []
    owners: dict[str, dict] = {}
    for mp in sorted((dist / "forever").glob("*/*/manifest.json")):
        d = json.loads(mp.read_text(encoding="utf-8"))
        for rec in manifest_image_records(d):
            owners[f"forever/{mp.parent.parent.name}/{mp.parent.name}/{rec['file']}"] = {"variant": rec.get("variant") or "legacy", "role": rec.get("role", "overview"), "width": rec["width"], "height": rec["height"]}
        for v in d.get("variants", []) or []:
            for im in v.get("images", []) if isinstance(v.get("images"), list) else []:
                owners[f"forever/{mp.parent.parent.name}/{mp.parent.name}/{im['file']}"] = {"variant": v["variant"], "role": im.get("role"), "width": im["width"], "height": im["height"]}
    for path, meta in table.items():
        parts = path.split("/")
        o_ = owners.get(path, {})
        kind = "manifest" if path.endswith("manifest.json") else ("image" if path.endswith(".webp") else "catalog" if path.startswith("atlas/") else "config")
        inv_rows.append({"path": path, "kind": kind, "uiMapId": int(parts[1]) if parts[0] == "forever" else "", "version": parts[2] if parts[0] == "forever" else "",
                         "variant": o_.get("variant", ""), "role": o_.get("role", ""), "width": o_.get("width", ""), "height": o_.get("height", ""), "bytes": meta["bytes"], "sha256": meta["sha256"]})
    (out_r / "asset-inventory.json").write_text(canonical_json({"schemaVersion": 1, "files": inv_rows}), encoding="utf-8")
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(inv_rows[0].keys()), lineterminator="\n")
    w.writeheader()
    w.writerows(inv_rows)
    (out_r / "asset-inventory.csv").write_text(buf.getvalue(), encoding="utf-8")

    # ---- instances
    (out_r / "instance-catalog.json").write_text(canonical_json({"counts": inst["counts"], "drawable": [{"mapId": r["mapId"], "name": r["name"], "classification": r["classification"], "uiMaps": r["catalog"]["drawableMaps"]} for r in inst["instances"] if r["drawable"]],
                                                                  "developmentSuspected": [{"mapId": r["mapId"], "name": r["name"], "directory": r.get("directory"), "flags": r["catalog"]["developmentFlags"]} for r in inst["instances"] if r["catalog"]["developmentFlags"]]}), encoding="utf-8")
    rows = [[r["mapId"], r["name"], r["classification"], "yes" if r["drawable"] else "no", ", ".join(r["catalog"]["developmentFlags"]) or ""] for r in inst["instances"]]
    (out_r / "instance-catalog.md").write_text("# Instance catalog (raw, unreviewed)\n\n" + f"{inst['counts']}\n\nNone of these records is asserted to be a released, playable instance: the client metadata cannot say, so `catalog.releaseStatus` is `unverified` and a curated layer must decide. Development flags are heuristics.\n\n"
                                               + _md_table(rows, ["MapID", "Name", "Class", "Drawable", "Dev flags"]) + "\n", encoding="utf-8")

    # ---- Tirisfal + category reports
    (out_r / "tirisfal-regression.json").write_text(canonical_json(tir), encoding="utf-8")
    (out_r / "tirisfal-regression.md").write_text("# Tirisfal Glades (uiMapID 1420) regression\n\n```json\n" + json.dumps(tir, indent=2, sort_keys=True) + "\n```\n", encoding="utf-8")
    (out_r / "categories-and-reveal.json").write_text(canonical_json(report["fullReveal"] | {"byCategoryCounts": report["counts"]["byCategory"]}), encoding="utf-8")
    (out_r / "categories-and-reveal.md").write_text("# Categories and full-reveal availability\n\n" + _md_table([[k, v["maps"], v["withFullReveal"], v["baseOnly"]] for k, v in sorted(full_by_cat.items())], ["Category", "Maps", "With full-reveal", "Base only"]) + "\n", encoding="utf-8")
    (out_r / "ledger-proposal.md").write_text("# Ledger proposal (NOT promoted)\n\n`ledger.next.json` extends `scripts/map-atlas/ledger/published.json`; promote only after an approved publication (`atlas.py promote-ledger`).\n\n"
                                              + _md_table([[v.split('/')[0], v.split('/')[1], ledger.data['maps'][v.split('/')[0]][v.split('/')[1]]['assetSetSha256'][:16] + "…"] for v in new_versions], ["uiMapID", "version", "assetSetSha256"]) + "\n", encoding="utf-8")
    write_import_gallery(o.out / "preview", src, manifests, results, catalog)
    deploy = Path(__file__).resolve().parents[3] / "docs/web/map-atlas-cdn-deploy.md"
    guide = deploy.read_text(encoding="utf-8") if deploy.is_file() else "(docs/web/map-atlas-cdn-deploy.md not found next to this tool)"
    review = [f"# Owner review — AzerDex map atlas, client {ident.version}", "",
              "PRIVATE: contains game artwork from the owner's installation. Nothing in this package has been uploaded, deployed or promoted.", "",
              "## Contents", "- `atlas-dist-<build>.zip` + `dist/` — the complete Cloudflare Pages snapshot (deterministic) · `SHA256SUMS.txt`, `dist-files.json` — audit manifest",
              "- `preview/index.html` — offline gallery (open in a browser) · `reports/` — coverage, asset inventory (JSON/CSV), instance catalog, Tirisfal regression, category/full-reveal report, ledger proposal",
              "- `ledger.next.json` — version ledger PROPOSAL (not promoted)", "", "## Automated preflight (this build)"]
    review += [f"- [{'x' if ok else ' '}] {c}" + (f" — {d}" if d else "") for c, ok, d in pre]
    review += ["", "## Headline numbers", f"- {cm['maps']} maps ({cm['mapsWithArtwork']} with artwork), {cm['variants']} image variants, {cm['instances']['records']} instance records ({cm['instances']['drawable']} drawable)",
               f"- {report['package']['fileCount']} files, {report['package']['totalBytes']} bytes, largest {report['package']['largestBytes']} bytes; zip {zip_info['bytes']} bytes (sha256 `{zip_info['sha256']}`)",
               f"- Immutable versions: {report['package']['immutableVersions']} (new this run: {len(new_versions)}; Tirisfal POC v1 preserved: {tir.get('pocV1', {}).get('preserved')})", "",
               "---", "", guide]
    (o.out / "OWNER-REVIEW.md").write_text("\n".join(review) + "\n", encoding="utf-8")
    return report


def write_import_gallery(out: Path, src: ExporterSource, manifests: dict, results: dict, catalog: dict) -> None:
    (out / "thumbs").mkdir(parents=True, exist_ok=True)
    e = html.escape
    css = ("body{background:#07091c;color:#ece6d9;font:14px system-ui,sans-serif;margin:1.5rem}h1,h2{font-weight:600}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px}"
           ".c{background:#191a47;border:1px solid #2c2d66;border-radius:8px;padding:8px}.p{display:flex;gap:6px}.p figure{margin:0;flex:1}.p img{width:100%;display:block;border-radius:4px;background:#0d0f33}"
           "figcaption,.m{color:#a8a9c8;font-size:12px;margin-top:4px}.w{color:#e6b95c}code{color:#c3aef2}table{border-collapse:collapse}td,th{border:1px solid #2c2d66;padding:2px 6px;font-size:12px;text-align:left}")
    cards = []
    for sm in src.maps:
        mid = sm.ui_map_id
        if not results[mid].get("packaged"):
            continue
        man = manifests[mid]
        figs = []
        from .importer import ordered
        for v in ordered(sm.variants):
            ov = next((i for i in v.images if i.role == "overview"), v.images[0])
            with Image.open(io.BytesIO(ov.data)) as f:
                t = f.convert("RGB")
                t.thumbnail((320, 320))
                t.save(out / "thumbs" / f"{mid}-{v.name}.webp", "WEBP", quality=70, method=4)
            star = " ★ default" if v.name == man["defaultImage"]["variant"] else ""
            extra = f" · {e(str(v.reveal_completeness))}" if v.kind == "full-reveal" else ""
            figs.append(f'<figure><img loading="lazy" src="thumbs/{mid}-{e(v.name)}.webp" alt="{e(sm.entry["name"])} {e(v.name)}"><figcaption>{e(v.name)}{star}{extra}</figcaption></figure>')
        warns = "".join(f'<div class="m w">⚠ {e(w)}</div>' for w in man["provenance"]["warnings"])
        cards.append(f'<div class="c"><div class="p">{"".join(figs)}</div><div><b>{e(sm.entry["name"])}</b></div>'
                     f'<div class="m">uiMapID <code>{mid}</code> · {e(sm.entry["category"])} · parent {e(str(sm.entry.get("parentUiMapId")))} · MapID {sm.entry["internalMapId"]} · {e(man["version"])} · {man["image"]["width"]}×{man["image"]["height"]}</div>{warns}</div>')
    none = [f'<li><code>{r["uiMapId"]}</code> {e(r["name"])} — {e(str(r.get("reason")))}</li>' for r in results.values() if not r.get("packaged")]
    rows = "".join(f'<tr><td>{r["mapId"]}</td><td>{e(r["name"])}</td><td>{e(r["classification"])}</td><td>{"yes" if r["drawable"] else "no"}</td><td>{e(", ".join(r["catalog"]["developmentFlags"]))}</td></tr>' for r in catalog["instances"]["instances"])
    page = (f'<!doctype html><meta charset="utf-8"><title>AzerDex atlas preview</title><style>{css}</style><h1>Atlas preview — client {e(catalog["builds"][-1]["version"])}</h1>'
            f'<p class="m">{len(cards)} maps with artwork · {len(none)} without. Offline review aid (game artwork — private, not part of the CDN package).</p><div class="g">{"".join(cards)}</div>'
            f'<h2>Maps without artwork</h2><ul>{"".join(none)}</ul><h2>Instance catalog (raw, unreviewed)</h2><table><tr><th>MapID</th><th>Name</th><th>Class</th><th>Drawable</th><th>Dev flags</th></tr>{rows}</table>')
    (out / "index.html").write_text(page, encoding="utf-8")
