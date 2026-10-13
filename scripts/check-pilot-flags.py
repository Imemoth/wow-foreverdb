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
    ("web/src/lib/account/config.ts", r"PRODUCTION_ACCOUNT_AUTH_APPROVED\s*=\s*(true|false)", "PRODUCTION_ACCOUNT_AUTH_APPROVED"),
]

on, missing = [], []
for rel, pattern, name in FLAGS:
    text = (ROOT / rel).read_text(encoding="utf-8")
    m = re.search(pattern, text)
    if not m:
        missing.append(name)
        print(f"{name:40s} NOT FOUND in {rel}")
        continue
    state = m.group(1)
    print(f"{name:40s} {state.upper():5s} ({rel})")
    if state == "true":
        on.append(name)

if "--require-off" in sys.argv:
    if on or missing:
        print(f"\nFAIL: enabled approvals: {on or 'none'}; flags not found: {missing or 'none'}")
        sys.exit(1)
    print("\nOK: every pilot/approval flag is OFF")
else:
    print(f"\nreport only: {len(on)} flag(s) enabled" + (f" ({', '.join(on)})" if on else ""))
