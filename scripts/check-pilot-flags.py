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

def source_code(text):
    # Mask comments AND quoted text so neither can impersonate an exported declaration.
    return re.sub(r'''//[^\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`''',
                  lambda match: " " * len(match.group()), text)


def sql_code(text):
    # Tokenize comments/quotes before inspecting writes. Dollar-quoted function/DO bodies
    # are scanned recursively: a write in a procedural body is still a migration write.
    tokens = []
    pattern = r"--[^\n]*|/\*[\s\S]*?\*/|'(?:''|[^'])*'|\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$|\"(?:\"\"|[^\"])*\"|[A-Za-z_][A-Za-z_0-9]*|[^\s]"
    position = 0
    while position < len(text):
        match = re.match(pattern, text[position:])
        if not match:
            position += 1
            continue
        token = match.group()
        position += len(token)
        if token.startswith(("--", "/*")):
            continue
        if token.startswith("$") and len(token) > 1:
            end = text.find(token, position)
            if end < 0:
                tokens.append("unsupported_sql")
                break
            tokens.append(sql_code(text[position:end]))
            position = end + len(token)
        elif token.startswith("'"):
            tokens.append("sql_literal")
        elif token.startswith('"'):
            tokens.append(token[1:-1].replace('""', '"').lower())
        else:
            tokens.append(token.lower())
    return " ".join(tokens)


on, missing = [], []
for rel, pattern, name in FLAGS:
    path = ROOT / rel
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    if name == "BROWSER_PAIRING_WEB_APPROVED":
        code = source_code(text)
        declarations = re.findall(r"\bexport\s+(?:const|let|var)\s+BROWSER_PAIRING_WEB_APPROVED\b", code)
        literal = re.findall(r"\bexport\s+const\s+BROWSER_PAIRING_WEB_APPROVED\s*=\s*false\s*;", code)
        if len(declarations) != 1 or len(literal) != 1:
            on.append(name)
            print(f"{name:40s} UNSAFE (requires one exported literal false declaration in {rel})")
            continue
        text = code
    m = re.search(pattern, text)
    if not m:
        missing.append(name)
        print(f"{name:40s} NOT FOUND in {rel}")
        continue
    state = m.group(1)
    print(f"{name:40s} {state.upper():5s} ({rel})")
    if state == "true":
        on.append(name)

# Migration 0016 is mandatory. Validate complete declarations/seeds and every later
# write to this gate, including procedural bodies and quoted identifiers.
migration = ROOT / "database/migrations/0016_browser_pairing.sql"
sql = sql_code(migration.read_text(encoding="utf-8")) if migration.is_file() else ""
target = r"private\s*\.\s*device_pairing_config\b"
create = rf"create\s+table\s+{target}\s*\((.*)\)"
seed = rf"insert\s+into\s+{target}\s*\(\s*singleton\s*,\s*enabled\s*\)\s*values\s*\(\s*true\s*,\s*false\s*\)"
write_target = r"(?:private\s*\.\s*)?device_pairing_config\b"
write = rf"\b(?:create\s+table|insert\s+into|update|delete\s+from|merge\s+into|alter\s+table|truncate(?:\s+table)?|copy|drop\s+table)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:only\s+)?{write_target}"
# Dynamic EXECUTE targets cannot be proven safe statically. GRANT/REVOKE EXECUTE ON
# names a function privilege, not an executable SQL statement.
tables, seeds = [], []
# SQL trigger clauses use the fixed grammar `EXECUTE FUNCTION <name>` (or the
# legacy `EXECUTE PROCEDURE`) and do not execute caller-built SQL. PL/pgSQL's
# standalone `EXECUTE <expression>` remains unprovable and fails closed.
unsupported = bool(re.search(r"\bexecute\s+(?!on\b|function\b|procedure\b)", sql))
for statement in sql.split(";"):
    # UPDATE/DELETE permit ONLY (relation) as well as ONLY relation. These writes
    # are never approved, so recognize their target before the closed statement
    # matcher: an unsupported relation suffix must not make a gate write disappear.
    if re.search(rf"\b(?:update|delete\s+from)\s+(?:only\s+)?(?:\(\s*)*{write_target}", statement):
        unsupported = True
        continue
    match = re.search(write, statement)
    if not match:
        # Multi-table TRUNCATE/DROP can name the gate after another target.
        if re.search(r"\b(?:truncate|drop\s+table)\b", statement) and re.search(target, statement):
            unsupported = True
        continue
    statement = statement[match.start():].strip()
    table = re.fullmatch(create, statement)
    if table:
        tables.append(table.group(1))
    elif re.fullmatch(seed, statement):
        seeds.append(statement)
    elif not re.fullmatch(rf"alter\s+table\s+{target}\s+(?:enable|force)\s+row\s+level\s+security", statement):
        unsupported = True

default_off = len(tables) == 1 and bool(re.search(r"(?:^|,)\s*enabled\s+boolean\s+not\s+null\s+default\s+false\s*(?:,|$)", tables[0]))
for name, is_off in [("BROWSER_PAIRING_DB_DEFAULT", default_off), ("BROWSER_PAIRING_DB_SEED", len(seeds) == 1), ("BROWSER_PAIRING_DB_WRITES", not unsupported)]:
    if not migration.is_file():
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
