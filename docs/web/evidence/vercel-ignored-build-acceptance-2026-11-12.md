# Vercel Ignored Build Step — acceptance evidence (2026-11-12)

Related Draft PR: #198. **This is a documentation-only commit intended to exercise the Vercel SKIP path.**

## Observed baseline
- Initial PR HEAD `338f862ecc7de3cf0f0aafc8380706384b5d5902` changed `web/` build inputs.
- Initial Vercel preview `dpl_4tzcZKBErgCCuM7gPmTUWQEAQZ3r` reached READY (verified via Vercel API).
- The PR remains Draft, not merged or promoted; `release` and `main` are unchanged.

## Pending live SKIP verification
This file is deliberately added in `docs/web/evidence/` with no changes to `web/`. Query the Vercel deployment/status for this exact commit and record whether the Ignored Build Step reports skip. If another build occurs, determine whether the previous SHA or Git checkout history is unavailable before treating the feature as accepted.

An additional disposable backend-only skip and subsequent web-source BUILD validation are required before merging to `release`. Do not delete any historical deployment based only on this document.
