#!/usr/bin/env python3
"""Companion Account System V1 repository checks (version consistency, secrets, logging, production separation).

Run from the repository root:  python3 scripts/check-companion-account.py
Exit code 0 = all checks passed. Every failure is printed; no secret value is ever printed.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
failures: list[str] = []


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def fail(message: str) -> None:
    failures.append(message)


def check(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


# ---------------------------------------------------------------------------------------------
# 1. Version consistency (Companion/Installer/UI/docs move together; addon and schema are NOT touched here)
# ---------------------------------------------------------------------------------------------
csproj = read("companion/ForeverDB.Companion/ForeverDB.Companion.csproj")
match = re.search(r"<Version>([^<]+)</Version>", csproj)
check(match is not None, "Companion csproj has no <Version>")
version = match.group(1) if match else "?"

account_csproj = read("companion/ForeverDB.Companion.Account/ForeverDB.Companion.Account.csproj")
m = re.search(r"<Version>([^<]+)</Version>", account_csproj)
check(m is not None and m.group(1) == version, f"Account library version != Companion version ({version})")

iss = re.search(r'#define MyAppVersion "([^"]+)"', read("installer/ForeverDB.iss"))
check(iss is not None and iss.group(1) == version, f"installer MyAppVersion != {version}")

xaml = read("companion/ForeverDB.Companion/MainWindow.xaml")
check(f'Title="ForeverDB Companion {version}"' in xaml, "MainWindow.xaml window title version mismatch")
check(re.search(rf"•\s+{re.escape(version)}", xaml) is not None, "MainWindow.xaml title bar version mismatch")
check(not re.search(r"0\.8\.\d-alpha", xaml), "stale 0.8.x version string in MainWindow.xaml")

versioning = read("docs/VERSIONING.md")
check(re.search(rf"\| Companion \| \*\*{re.escape(version)}\*\*", versioning) is not None, "docs/VERSIONING.md Companion row mismatch")
check(re.search(rf"\| Installer \| \*\*{re.escape(version)}\*\*", versioning) is not None, "docs/VERSIONING.md Installer row mismatch")

check(f"- Companion: **{version}**" in read("CHANGELOG.md"), "CHANGELOG.md current Companion version mismatch")
check(re.search(rf"## {re.escape(version)} — ", read("CHANGELOG.md")) is not None, "CHANGELOG.md has no section for the current Companion version")
check(f"| Companion | **{version}** |" in read("README.md"), "README.md Companion version mismatch")
check(f"ForeverDB Companion **{version}**" in read("companion/README.md"), "companion/README.md version mismatch")
check(f"- Version: **{version}**" in read("docs/ROADMAP.md"), "docs/ROADMAP.md Companion version mismatch")

# The addon version and the export schema must not move in this change.
core = read("addon/ForeverDB/Core.lua")
toc = read("addon/ForeverDB/ForeverDB.toc")
core_version = re.search(r'FDB\.VERSION\s*=\s*"([^"]+)"', core)
toc_version = re.search(r"##\s*Version:\s*(\S+)", toc)
check(core_version is not None and toc_version is not None and core_version.group(1) == toc_version.group(1), "addon Core.lua / TOC versions differ")
check("| Addon | **0.5.0-alpha** |" in versioning, "addon version in VERSIONING.md changed unexpectedly")
check("| Export schema | **9** |" in versioning, "export schema in VERSIONING.md changed unexpectedly")

# ---------------------------------------------------------------------------------------------
# 2. Secrets and logging
# ---------------------------------------------------------------------------------------------
companion_files = [
    p for p in (ROOT / "companion").rglob("*.cs")
    if "/obj/" not in p.as_posix() and "/bin/" not in p.as_posix()
]
account_files = [p for p in companion_files if "ForeverDB.Companion.Account/" in p.as_posix()]

for p in companion_files:
    text = p.read_text(encoding="utf-8")
    rel = p.relative_to(ROOT).as_posix()
    check("sb_secret_" not in text and "service_role" not in text.lower().replace("service-role", "service_role")
          or rel.endswith("AccountFeatureGate.cs"),
          f"{rel}: service-role / secret key reference outside the gate")

for p in account_files:
    text = p.read_text(encoding="utf-8")
    rel = p.relative_to(ROOT).as_posix()
    check(re.search(r"\bConsole\.|\bDebug\.(Write|Print)|\bTrace\.|ILogger|EventLog", text) is None, f"{rel}: logging/console output in the account library")

# No credential field in the persisted settings model.
settings = read("companion/ForeverDB.Companion/Models/CompanionSettings.cs")
check(re.search(r"(?i)token|password|session|refresh|claim|secret", settings) is None, "CompanionSettings carries a credential-like field")

# The removed unsafe components must not come back.
for name in ("SupabaseAuthService", "SessionStore"):
    for p in companion_files:
        check(name not in p.read_text(encoding="utf-8"), f"{p.relative_to(ROOT).as_posix()}: references removed {name}")

# No implicit anonymous sign-up: the only caller of SignUpAnonymouslyAsync is the explicit StartAnonymousAsync.
callers = [p.relative_to(ROOT).as_posix() for p in companion_files if "SignUpAnonymouslyAsync" in p.read_text(encoding="utf-8")]
# Zero-touch (ADR-017) adds the device's own anonymous identity: created only by DeviceSessionProvider.CreateAsync, which the
# enrollment flow alone may reach with allowCreate = true.
check(sorted(callers) == [
    "companion/ForeverDB.Companion.Account/AccountSessionManager.cs",
    "companion/ForeverDB.Companion.Account/DeviceContext.cs",
    "companion/ForeverDB.Companion.Account/GoTrueClient.cs",
], f"unexpected SignUpAnonymouslyAsync callers: {callers}")
device_ctx = read("companion/ForeverDB.Companion.Account/DeviceContext.cs")
check(device_ctx.count("SignUpAnonymouslyAsync") == 1, "DeviceContext must sign up anonymously in exactly one place")
check("allowCreate: true" not in read("companion/ForeverDB.Companion.Account/DeviceSyncService.cs"),
      "DeviceSyncService must never create a device identity")
manager = read("companion/ForeverDB.Companion.Account/AccountSessionManager.cs")
check(manager.count("SignUpAnonymouslyAsync") == 1, "AccountSessionManager must sign up anonymously in exactly one (explicit) place")

# ---------------------------------------------------------------------------------------------
# 3. Production separation
# ---------------------------------------------------------------------------------------------
PRODUCTION_REF = "klxhikdlfwgxurdyexdi"
allowed_ref_files = {
    "companion/ForeverDB.Companion/Models/CompanionSettings.cs",           # the existing anonymous 0.8.x default
    "companion/ForeverDB.Companion/Services/SettingsService.cs",           # existing default repair
    "companion/ForeverDB.Companion.Account/AccountFeatureGate.cs",         # the deny-list constant
}
for p in companion_files:
    rel = p.relative_to(ROOT).as_posix()
    if PRODUCTION_REF in p.read_text(encoding="utf-8"):
        check(rel in allowed_ref_files, f"{rel}: mentions the production project reference")
gate = read("companion/ForeverDB.Companion.Account/AccountFeatureGate.cs")
check("public static readonly bool ProductionAccountAuthApproved = true;" in gate, "standard Account Linking approval must stay enabled")
check("public const bool ZeroTouchEnrollmentApproved = false;" in gate, "ZeroTouchEnrollmentApproved must stay false")
check("public const bool DeviceAutoSyncApproved = true;" in gate, "owner-approved DeviceAutoSync must stay enabled")

# Owner acceptance uses the repository's normal self-contained package, never an account-linking-only build.
account_workflow = read(".github/workflows/companion-account-auth.yml")
normal_build_workflow = read(".github/workflows/companion-build.yml")
check("account-linking-mvp-win-x64" not in account_workflow, "account CI must not publish a special Account Linking build")
check("name: ForeverDB-Companion-win-x64" in normal_build_workflow, "normal Companion artifact name changed")
check("--self-contained true" in normal_build_workflow, "normal Companion build must stay self-contained")
check("-p:PublishSingleFile=true" in normal_build_workflow, "normal Companion build must stay single-file")

# Tests may only use the production host as a deny-list fixture.
for p in (ROOT / "tests" / "companion-account").rglob("*.cs"):
    rel = p.relative_to(ROOT).as_posix()
    if "/obj/" in rel or "/bin/" in rel:
        continue
    text = p.read_text(encoding="utf-8")
    if PRODUCTION_REF in text:
        check(rel.endswith(("Support/TestEnv.cs", "FeatureGateTests.cs", "MessagesAndLinksTests.cs")), f"{rel}: references the production project outside the deny-list fixtures")

# ---------------------------------------------------------------------------------------------
if failures:
    print("Companion account checks FAILED:")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print(f"Companion account checks passed (Companion {version}).")
