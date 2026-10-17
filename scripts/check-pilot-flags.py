#!/usr/bin/env python3
"""Release gate for the TEMPORARY Account V1 pilot approvals.

Default mode REPORTS the state of every pilot/approval flag and exits 0 (draft branches legitimately carry owner-approved pilot flags).
`--require-off` exits 1 if ANY flag is enabled: run it on the exact commit that is about to be merged into main/release or built as a public
distributable (see docs/account-v1/integration-and-release-order.md). No flag value is ever read from the environment.

    python3 scripts/check-pilot-flags.py [--require-off]
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FLAGS = [
    ("companion/ForeverDB.Companion.Account/AccountFeatureGate.cs", r"PrivateProjectPilotApproved\s*=\s*(true|false)", "PrivateProjectPilotApproved"),
    ("companion/ForeverDB.Companion.Account/AccountFeatureGate.cs", r"PrivateProjectClaimPilotApproved\s*=\s*(true|false)", "PrivateProjectClaimPilotApproved"),
    ("companion/ForeverDB.Companion.Account/AccountFeatureGate.cs", r"ProductionAccountAuthApproved\s*=\s*(true|false)", "ProductionAccountAuthApproved"),
    ("companion/ForeverDB.Companion.Account/AccountFeatureGate.cs", r"ZeroTouchEnrollmentApproved\s*=\s*(true|false)", "ZeroTouchEnrollmentApproved"),
    ("companion/ForeverDB.Companion.Account/AccountFeatureGate.cs", r"DeviceAutoSyncApproved\s*=\s*(true|false)", "DeviceAutoSyncApproved"),
    ("web/src/lib/account/config.ts", r"SINGLE_PROJECT_PILOT_APPROVED\s*=\s*(true|false)", "SINGLE_PROJECT_PILOT_APPROVED"),
    ("web/src/lib/account/pairing-gate.ts", r"BROWSER_PAIRING_WEB_APPROVED\s*=\s*(true|false)", "BROWSER_PAIRING_WEB_APPROVED"),
    ("web/src/lib/account/config.ts", r"PRODUCTION_ACCOUNT_AUTH_APPROVED\s*=\s*(true|false)", "PRODUCTION_ACCOUNT_AUTH_APPROVED"),
]

on, missing = [], []
for rel, pattern, name in FLAGS:
    path = ROOT / rel
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    m = re.search(pattern, text)
    if not m:
        missing.append(name)
        print(f"{name:40s} NOT FOUND in {rel}")
        continue
    state = m.group(1)
    print(f"{name:40s} {state.upper():5s} ({rel})")
    if state == "true":
        on.append(name)

# Migration 0016 is mandatory for release checks, including in detached integration worktrees.
# Inspect the named table and its seed, never an unrelated `enabled` column or a comment.
migration = ROOT / "database/migrations/0016_browser_pairing.sql"
sql = migration.read_text(encoding="utf-8") if migration.is_file() else ""
sql = re.sub(r"--[^\n]*|/\*[\s\S]*?\*/", "", sql)
table = re.search(r"create\s+table\s+(?:if\s+not\s+exists\s+)?private\.device_pairing_config\s*\((.*?)\)\s*;", sql, re.I | re.S)
default_off = table and re.search(r"\benabled\s+boolean\s+not\s+null\s+default\s+false\b", table.group(1), re.I)
seed = re.search(r"insert\s+into\s+private\.device_pairing_config\s*\(\s*singleton\s*,\s*enabled\s*\)\s*values\s*\(\s*true\s*,\s*(true|false)\s*\)", sql, re.I)
for name, is_off in [("BROWSER_PAIRING_DB_DEFAULT", bool(default_off)), ("BROWSER_PAIRING_DB_SEED", bool(seed and seed.group(1).lower() == "false"))]:
    if not migration.is_file() or (name.endswith("SEED") and not seed) or (name.endswith("DEFAULT") and not table):
        missing.append(name)
        print(f"{name:40s} NOT FOUND in database/migrations/0016_browser_pairing.sql")
    else:
        print(f"{name:40s} {'FALSE' if is_off else 'UNSAFE':5s} (database/migrations/0016_browser_pairing.sql)")
        if not is_off:
            on.append(name)

if "--require-off" in sys.argv:
    if on or missing:
        print(f"\nFAIL: enabled approvals: {on or 'none'}; flags not found: {missing or 'none'}")
        sys.exit(1)
    print("\nOK: every pilot/approval flag is OFF")
else:
    print(f"\nreport only: {len(on)} flag(s) enabled" + (f" ({', '.join(on)})" if on else ""))
