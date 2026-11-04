# Dependency audit exceptions

The `Dependency audit (web|publisher)` job fails on every advisory of severity moderate or above (full tree) and high or above (production
tree). An exception is the **only** way a moderate advisory may pass, and it is deliberately narrow, time-limited and self-expiring. It is
not an ignore list, not a lowered threshold and not suppressed output: the full `npm audit` still runs and its structured JSON is
parsed by `web/scripts/audit-gate.mjs` (rules in `web/scripts/lib/audit-policy.mjs`, record in `.github/audit-exceptions.json`).

## Current state: no exception in force; one scoped dependency override (owner decision required to merge)

`.github/audit-exceptions.json` ships **no exception**. GHSA-g3hv-75wg-m249 is fixed in the dependency graph, not excused.

### What changed (2026-11-04) and why

| | |
| --- | --- |
| Advisory | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249): `minimatch` potential denial of service via globparts amplification (CWE-405), severity **moderate** |
| Advisory data change | The advisory's vulnerable range was **narrowed** by GitHub from `<11.0.1` to `>=7.0.0 <11.0.1`. The exception recorded on 2026-11-02 matched the old string exactly, so the gate failed closed ("exception no longer matches the verified dependency graph"). That is the intended behaviour of the gate, not a regression of the project |
| Real exposure now | One installed copy only: `minimatch@10.2.6` at `node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch`, path `eslint-config-next > typescript-eslint > @typescript-eslint/typescript-estree > minimatch@10.2.6`. The six `minimatch@3.1.5` paths of the old record are **no longer in the vulnerable range** |
| Scope | `web/` development tooling only. The production audit (`npm audit --omit=dev`) reports **0** vulnerabilities before and after |

### The fix: a scoped override (a deliberate, documented exception to the "no overrides" rule)

`web/package.json` gains exactly one override: `"overrides": { "@typescript-eslint/typescript-estree": { "minimatch": "^11.0.4" } }`. It applies only to the one consumer that is still affected, resolves to `minimatch@11.0.4` (the patched line is `>= 11.0.1`), and changes nothing else.

Why this is compatible (the earlier 2026-11-02 analysis rejected a *global* override):
- `@typescript-eslint/typescript-estree` (installed 8.71.1, latest 8.72.1, both pin `minimatch ^10.2.2`) calls minimatch in **one place**: `useProgramFromProjectService.js` — `require("minimatch").minimatch(filePath, pattern, { dot: true })`. The **named** export is unchanged in minimatch 11, so this consumer is API-safe. The crash that the old analysis found was `eslint-plugin-import`/`-react`/`-jsx-a11y` calling the *callable default* of minimatch; those plugins keep `minimatch@3.1.5` (a copy that is no longer vulnerable) and are untouched. The lockfile test pins exactly two minimatch copies: `3.1.x` at the root and `11.x` under typescript-estree.
- `minimatch@11` needs Node `20 || >=22`; the project's engine is Node `24.x`.
- npm resolves one new transitive dev package for minimatch 11: `@isaacs/nonrecursive-glob-match@1.0.3` (same maintainer as minimatch; development tooling only; not in the production tree).
- With the override: `npm audit` reports **0** vulnerabilities (full tree and production tree); lint, type check and the unit suite pass.
- No compatible upstream release exists: `@typescript-eslint/typescript-estree@8.72.1` (latest) and its canary still pin `^10.2.2`; `npm audit fix` proposes a breaking *downgrade* of `eslint-config-next` and was not used.

This is the **first** `overrides` entry in the manifest and `docs/web/release-gates.md` section 5 says overrides are not to be used to get a green check, so merging this change requires the repository owner's explicit decision (recorded in the pull request). Alternative if the owner prefers to keep the "no overrides" rule: the narrowed-exception pull request, which keeps an exception limited to the single path above.

### Removal criteria for the override

Remove the override as soon as `@typescript-eslint/typescript-estree` (via `typescript-eslint` / `eslint-config-next`) ships a release that depends on `minimatch >= 11.0.1`; `npm ls minimatch` then shows a single, patched copy. Re-check upstream before 2026-12-15 (the date the old exception would have expired).

### History

The exception recorded on 2026-11-02 (owner-approved, expiring 2026-12-15) is preserved as a test fixture (`web/tests/fixtures/audit/exception-g3hv-75wg-m249-2026-11-02.json`) so that the policy library keeps its positive and negative coverage. Its original rationale (dev-only exposure, no upstream fix at that time, global override incompatible with the ESLint plugins) is unchanged and still accurate for a global override.

## What the gate enforces

1. The full audit JSON is parsed; a missing, errored or non-v2 report **fails** (fail closed). So does a missing production-audit report.
2. Every advisory at or above the threshold (moderate) and every affected package must be covered by an in-force exception, otherwise it is **blocked**. An additional advisory, including another one on `minimatch`, is blocked.
3. An exception applies only if it matches **exactly**: same GHSA id, package, vulnerable range and severity; every vulnerable package is in `allowedPackages`; `minimatch` appears only at the listed paths; every directly-declared vulnerable package is in `directRoots` and is a `devDependency` only (not in `dependencies`, `optionalDependencies` or `peerDependencies`).
4. **Dev-only is re-proved on every run:** the production audit must not report the advisory or any listed package.
5. A moderate exception only: `high` and `critical` can never be excepted. The entry must also carry the recorded owner acceptance (`approvedBy`, `approvedOn`, `rationale`, `removalCriteria`) and the verified graph, or it is invalid.
6. **Expired** (from 00:00 UTC the day after `expires`), **obsolete** (advisory gone) and **mismatching** entries all fail the gate by themselves, and an expired entry no longer excepts anything.
7. No override **other than the single scoped one recorded above**, no `npm audit fix --force`, no `continue-on-error`, no lowered threshold; `web/tests/unit/audit-policy.test.ts` pins all of this (positive cases on the real `release` audit output, negative cases for each rule above, the exact deadline boundary, the CLI exit codes and the workflow wiring).

To add a future exception: only with the owner's recorded decision in the pull request, an exact advisory, a real dependency-graph verification like the one above, and an expiry. Do not widen an existing entry.
