#!/usr/bin/env python3
"""Release gate for the TEMPORARY Account V1 pilot approvals.

Default mode REPORTS the state of every pilot/approval flag and exits 0 (draft branches legitimately carry owner-approved pilot flags).
`--require-off` exits 1 if any temporary pilot, enrollment or web-production flag is enabled: run it on the exact commit that
is about to be merged into main/release or built as a public distributable (see docs/account-v1/integration-and-release-order.md).
The owner-approved standard Companion sign-in/direct-linking flag is reported but is not a temporary pilot. No flag value is read
from the environment.

    python3 scripts/check-pilot-flags.py [--require-off]
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FLAGS = [
    ("companion/ForeverDB.Companion.Account/AccountFeatureGate.cs", r"PrivateProjectPilotApproved\s*=\s*(true|false)", "PrivateProjectPilotApproved", True),
    ("companion/ForeverDB.Companion.Account/AccountFeatureGate.cs", r"PrivateProjectClaimPilotApproved\s*=\s*(true|false)", "PrivateProjectClaimPilotApproved", True),
    # Standard Companion sign-in/direct linking is an owner-approved MVP feature, not a temporary pilot. Report it, but do not
    # make --require-off reject the normal release package. AutoSync is likewise owner-approved; enrollment remains closed.
    ("companion/ForeverDB.Companion.Account/AccountFeatureGate.cs", r"ProductionAccountAuthApproved\s*=\s*(true|false)", "ProductionAccountAuthApproved", False),
    ("companion/ForeverDB.Companion.Account/AccountFeatureGate.cs", r"ZeroTouchEnrollmentApproved\s*=\s*(true|false)", "ZeroTouchEnrollmentApproved", True),
    ("companion/ForeverDB.Companion.Account/AccountFeatureGate.cs", r"DeviceAutoSyncApproved\s*=\s*(true|false)", "DeviceAutoSyncApproved", False),
    ("web/src/lib/account/config.ts", r"SINGLE_PROJECT_PILOT_APPROVED\s*=\s*(true|false)", "SINGLE_PROJECT_PILOT_APPROVED", True),
    ("web/src/lib/account/config.ts", r"PRODUCTION_ACCOUNT_AUTH_APPROVED\s*=\s*(true|false)", "PRODUCTION_ACCOUNT_AUTH_APPROVED", True),
]

on, missing = [], []
for rel, pattern, name, must_be_off in FLAGS:
    text = (ROOT / rel).read_text(encoding="utf-8")
    m = re.search(pattern, text)
    if not m:
        missing.append(name)
        print(f"{name:40s} NOT FOUND in {rel}")
        continue
    state = m.group(1)
    print(f"{name:40s} {state.upper():5s} ({rel})")
    if state == "true" and must_be_off:
        on.append(name)

if "--require-off" in sys.argv:
    if on or missing:
        print(f"\nFAIL: enabled approvals: {on or 'none'}; flags not found: {missing or 'none'}")
        sys.exit(1)
    print("\nOK: every temporary pilot, enrollment and web-production flag is OFF")
else:
    print(f"\nreport only: {len(on)} flag(s) enabled" + (f" ({', '.join(on)})" if on else ""))
