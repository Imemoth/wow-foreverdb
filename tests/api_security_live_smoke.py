#!/usr/bin/env python3
"""Low-volume, read-only ForeverDB production HTTP authorization smoke.

Uses ONLY the already-public publishable key from Companion SettingsService.
Creates one temporary-purpose Supabase anonymous Auth session; does not send
installation data, run ingest, hammer rate limits, or print credentials/JWTs.
Manual/admin cleanup of the empty auth identity can be done afterwards.
"""
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

settings = pathlib.Path(
    "companion/ForeverDB.Companion/Services/SettingsService.cs"
).read_text(encoding="utf-8")
match_url = re.search(r"https://[a-z0-9]+\.supabase\.co", settings)
match_key = re.search(r"sb_publishable_[A-Za-z0-9_-]+", settings)
if not match_url or not match_key:
    sys.exit("Public Companion endpoint settings not found")
base, publishable = match_url.group(), match_key.group()
if base != "https://klxhikdlfwgxurdyexdi.supabase.co":
    sys.exit("Refusing to test an unrecognized Supabase project")

def request(method, path, payload=None, access_token=None):
    headers = {
        "apikey": publishable,
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "ForeverDB-API-Authorization-Smoke",
    }
    if access_token:
        headers["Authorization"] = "Bearer " + access_token
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        base + path, data=data, method=method, headers=headers
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status, response.read(2_000_000)
    except urllib.error.HTTPError as err:
        return err.code, err.read(3000)

def must(name, code, allowed):
    if code not in allowed:
        raise AssertionError(f"{name}: HTTP {code} (expected {allowed})")
    print(f"PASS {name}: HTTP {code}")

zone = {
    "p_map_id": 1420,
    "p_zone_name": "Tirisfal Glades",
    "p_limit": 3,
    "p_offset": 0,
}

status, _ = request("POST", "/rest/v1/rpc/get_foreverdb_zone_catalog", zone)
must("publishable-key-only catalog denied", status, (401, 403))

status, auth_json = request("POST", "/auth/v1/signup", {})
must("one isolated anonymous Auth session created", status, (200, 201))
session = json.loads(auth_json)
token = session.get("access_token")
if not isinstance(token, str) or len(token) < 100:
    raise AssertionError("Supabase Auth did not return a valid session")

status, items = request(
    "POST", "/rest/v1/rpc/get_foreverdb_zone_catalog", zone, token
)
must("signed-in user may read bounded known zone", status, (200,))
records = json.loads(items)
if not isinstance(records, list) or len(records) < 1 or len(records) > 3:
    raise AssertionError("Invalid catalog response page")
print(f"PASS bounded catalog returned {len(records)} observed entities")

status, _ = request(
    "GET",
    "/rest/v1/installation_location_stats?select=installation_id&limit=1",
    access_token=token,
)
must("authenticated session denied raw installation observations",
     status, (401, 403))

status, _ = request(
    "POST", "/rest/v1/rpc/get_foreverdb_search_global",
    {"p_query": "Copper"}, token
)
must("new authenticated global search works", status, (200,))

if len(sys.argv) > 1 and sys.argv[1] == "--post-lockdown":
    for rpc, payload in (
        ("get_foreverdb_search_in_zone",
         {"p_query": "Copper", "p_map_id": 1420,
          "p_zone_name": "Tirisfal Glades"}),
        ("get_foreverdb_item_stats", {"p_item_id": 2770}),
        ("get_foreverdb_item_locations", {"p_item_id": 2770}),
    ):
        status, _ = request("POST", "/rest/v1/rpc/" + rpc, payload)
        must(f"anon denied {rpc} after lockdown", status, (401, 403))
    for table in ("items", "sources"):
        status, _ = request(
            "GET", f"/rest/v1/{table}?select=*&limit=1", access_token=token
        )
        must(f"direct authenticated {table} SELECT denied", status, (401, 403))

print("Production HTTP authorization smoke PASS; no secrets displayed.")
