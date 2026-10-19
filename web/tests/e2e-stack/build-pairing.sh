#!/usr/bin/env bash
# Build the disposable integrated-test website with the reviewed pairing source gate
# temporarily open. The checked-in source is restored before this command returns;
# the resulting .next tree is local test evidence and must never be deployed.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB="$(cd "$HERE/../.." && pwd)"
GATE="$WEB/src/lib/account/pairing-gate.ts"
BACKUP="$(mktemp)"
cp "$GATE" "$BACKUP"
restore() { cp "$BACKUP" "$GATE"; rm -f "$BACKUP"; }
trap restore EXIT
python3 - "$GATE" <<'PY_GATE'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
needle = "export const BROWSER_PAIRING_WEB_APPROVED = false;"
if s.count(needle) != 1:
    raise SystemExit("pairing source gate is not the one reviewed literal-false declaration")
p.write_text(s.replace(needle, "export const BROWSER_PAIRING_WEB_APPROVED = true;"))
PY_GATE
(
  cd "$WEB"
  npm run build
)
restore
trap - EXIT
python3 "$WEB/../scripts/check-pilot-flags.py" --require-off
