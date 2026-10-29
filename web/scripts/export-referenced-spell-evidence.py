#!/usr/bin/env python3
"""Read-only, version-locked export of linked spell rows from an Everloot client SQLite snapshot.

The output is evidence for review, NOT renderer-ready verified spell values.
Run locally after producing a build-specific client-extract snapshot.
"""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path

TABLES = ("Spell", "SpellName", "SpellEffect", "SpellMisc", "SpellDuration", "SpellAuraOptions", "SpellRadius")


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def raw_rows(db, table):
    return [(ident, json.loads(raw)) for ident, raw in db.execute(
        "SELECT id, raw FROM client_rows WHERE tbl = ? ORDER BY id", (table,)
    )]


def spell_id(row):
    try:
        return int(row.get("SpellID"))
    except (TypeError, ValueError):
        return -1


def collect(snapshot, coverage, expected_build):
    if coverage.get("build") != expected_build:
        raise ValueError("coverage build does not match the requested build")
    refs = coverage.get("spellReferences")
    if not isinstance(refs, list) or not refs:
        raise ValueError("coverage lacks spellReferences")
    url = snapshot.resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(url, uri=True) as db:
        meta = dict(db.execute("SELECT key, value FROM meta"))
        if meta.get("version") != expected_build or meta.get("product") != "wowf":
            raise ValueError(f"snapshot is {meta.get('product')} {meta.get('version')}, expected wowf {expected_build}")
        tables = {table: raw_rows(db, table) for table in TABLES}
    ids = sorted({int(ref["spellId"]) for ref in refs})
    output = {}
    for ident in ids:
        related = {table: [dict(raw, _rowId=rid) for rid, raw in rows
                            if (rid == ident if table in ("Spell", "SpellName", "SpellDuration", "SpellRadius")
                                else spell_id(raw) == ident)]
                   for table, rows in tables.items()}
        # Duration rows are indexed by SpellMisc.DurationIndex, NOT by spell ID.
        duration_ids = set()
        for misc in related["SpellMisc"]:
            try:
                duration_ids.add(int(misc["DurationIndex"]))
            except (KeyError, TypeError, ValueError):
                pass
        related["SpellDuration"] = [dict(raw, _rowId=rid) for rid, raw in tables["SpellDuration"]
                                    if rid in duration_ids]
        # Radius rows are indexed by each SpellEffect.EffectRadiusIndex entry.
        radius_ids = set()
        for effect in related["SpellEffect"]:
            indexes = effect.get("EffectRadiusIndex", [])
            if not isinstance(indexes, list):
                indexes = [indexes]
            for value in indexes:
                try:
                    radius_ids.add(int(value))
                except (TypeError, ValueError):
                    pass
        related["SpellRadius"] = [dict(raw, _rowId=rid) for rid, raw in tables["SpellRadius"]
                                  if rid in radius_ids]
        ref = next(ref for ref in refs if int(ref["spellId"]) == ident)
        output[str(ident)] = {"tokens": ref["kinds"], "talentIds": ref["talentIds"],
                              "raw": related,
                              "missing": [table for table in ("Spell", "SpellEffect", "SpellMisc")
                                          if not related[table]]}
    return {
        "schema": "azerdex.referenced-spell-evidence/1",
        "status": "raw-review-required",
        "build": expected_build,
        "source": {"kind": "Everloot client-extract SQLite", "product": meta.get("product"),
                   "buildId": meta.get("buildId"), "buildConfig": meta.get("buildConfig"),
                   "definitions": meta.get("definitions"), "snapshotSha256": digest(snapshot),
                   "coverageSha256": hashlib.sha256(json.dumps(coverage, sort_keys=True).encode()).hexdigest()},
        "summary": {"referenceIds": len(ids), "tablesPresent": {name: len(rows) for name, rows in tables.items()}},
        "spells": output,
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--snapshot", required=True, type=Path)
    p.add_argument("--coverage", required=True, type=Path)
    p.add_argument("--expected-build", default="1.60.1.70634")
    p.add_argument("--output", required=True, type=Path)
    args = p.parse_args()
    if args.snapshot.resolve() == args.output.resolve():
        p.error("output must not overwrite source SQLite")
    cov = json.loads(args.coverage.read_text(encoding="utf-8"))
    result = collect(args.snapshot, cov, args.expected_build)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Exported {result['summary']['referenceIds']} referenced spell IDs: {args.output}")
    print("Evidence only. Audit build, table rows, effect display semantics and unresolved gaps before import.")


if __name__ == "__main__":
    main()
