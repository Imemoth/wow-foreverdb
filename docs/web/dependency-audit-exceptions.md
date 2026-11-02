# Dependency audit exceptions

The `Dependency audit (web|publisher)` job fails on every advisory of severity moderate or above (full tree) and high or above (production
tree). An exception is the **only** way a moderate advisory may pass, and it is deliberately narrow, time-limited and self-expiring. It is
not an ignore list, not a lowered threshold and not suppressed output: the full `npm audit` still runs and its structured JSON is
parsed by `web/scripts/audit-gate.mjs` (rules in `web/scripts/lib/audit-policy.mjs`, record in `.github/audit-exceptions.json`).

## Current exception: GHSA-g3hv-75wg-m249 (`minimatch`), expires 2026-12-15

| | |
| --- | --- |
| Advisory | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249): `minimatch` potential denial of service via globparts amplification (CWE-405), vulnerable `<11.0.1`, severity **moderate** |
| Project | `web/` only (`publisher/` has no exception) |
| Owner risk acceptance | Repository owner, recorded **2026-11-02**. Approved approach: a narrowly scoped exception expiring 2026-12-15. Not approval to disable or bypass any security check. |
| Hard expiry | Last valid day **2026-12-15 (UTC)**. The gate **fails closed from 2026-12-16 00:00 UTC**; there is no flag to set the clock and no automatic renewal |
| Owner of the removal | The repository owner; re-check upstream before the deadline |

### Why there is no fix (verified 2026-11-02)

- The only patched line is `minimatch >= 11.0.1`. There is no backport: 3.x ends at 3.1.5, 9.x at 9.0.9, 10.x at 10.2.6.
- The **latest** release of every consumer still pins an older line, and no published version of any of them (about 8,800 versions incl. pre-releases and canaries, read from the registry metadata) admits `minimatch >= 11`:
  `eslint@10.14.0` and `@eslint/config-array@0.23.5` → `^10`, `@eslint/eslintrc@3.3.7`, `eslint-plugin-import@2.32.0`, `eslint-plugin-jsx-a11y@6.10.2`, `eslint-plugin-react@7.37.5` → `^3.1.x`, `@typescript-eslint/typescript-estree@8.72.1` → `^10`.
- A global `overrides` entry is **not** a compatible fix: `minimatch@11` no longer exports a callable default. In an isolated copy, forcing 11.0.4 made `npm audit` report 0 vulnerabilities but `eslint-plugin-import`'s `import/order` crashed (`TypeError: ... is not a function`); the same sample on the unmodified lockfile ran normally. Our own lint would pass (the repo does not enable the affected rules), which is exactly why a green lint would not have proven compatibility. `npm audit fix --force` proposes downgrading `eslint` to 4.0.0 and is unusable.
- Partially overriding only the `Minimatch`-class consumers (ESLint core, `config-array`, `eslintrc`, typescript-estree) would be API-safe but cannot clear the audit while the three plugins stay on 3.1.5.

### Residual risk (accepted)

- **Scope:** development tooling only. `ESLint` is a devDependency and never ships; the production audit (`npm audit --omit=dev`) reports **0** vulnerabilities and is unchanged and mandatory.
- **Impact:** a crafted glob can exhaust CPU/memory in the process that evaluates it. Here the globs are repository-authored configuration and repository file paths. The realistic worst case is a malicious pull request slowing its own CI run, which a pull request author can already do by running arbitrary code there.
- **Not covered:** any other advisory, any other severity, any other package, any new path. All of those still fail.

### Affected dependency paths (the verified graph)

`minimatch@3.1.5`, six deduplicated paths (`node_modules/minimatch`) and `minimatch@10.2.6` (`node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch`):

```
eslint > @eslint/config-array > minimatch@3.1.5
eslint > @eslint/eslintrc > minimatch@3.1.5
eslint-config-next > eslint-plugin-import > minimatch@3.1.5
eslint-config-next > eslint-plugin-jsx-a11y > minimatch@3.1.5
eslint-config-next > eslint-plugin-react > minimatch@3.1.5
eslint-config-next > typescript-eslint > @typescript-eslint/typescript-estree > minimatch@10.2.6
```

The 16 packages npm reports as affected (the advisory's package and everything that inherits it) are listed in `allowedPackages`; direct dependencies are `eslint` and `eslint-config-next`, both `devDependencies`.

### Removal criteria

Remove the entry (and this section) as soon as the audit no longer reports the advisory for `web/`; the gate fails an **obsolete** entry on its own, so a fix cannot be forgotten. That needs releases of `@eslint/config-array`, `@eslint/eslintrc`, `@typescript-eslint/typescript-estree` and `eslint-plugin-react` / `-import` / `-jsx-a11y` (or an `eslint-config-next` that drops them) that accept `minimatch >= 11.0.1`. If still unresolved on 2026-12-15, the owner must either renew it in a reviewed change (new `expires`, new recorded decision) or let it expire, at which point `Dependency audit (web)` and the `Web release gate` go red.

## What the gate enforces

1. The full audit JSON is parsed; a missing, errored or non-v2 report **fails** (fail closed). So does a missing production-audit report.
2. Every advisory at or above the threshold (moderate) and every affected package must be covered by an in-force exception, otherwise it is **blocked**. An additional advisory, including another one on `minimatch`, is blocked.
3. An exception applies only if it matches **exactly**: same GHSA id, package, vulnerable range and severity; every vulnerable package is in `allowedPackages`; `minimatch` appears only at the listed paths; every directly-declared vulnerable package is in `directRoots` and is a `devDependency` only (not in `dependencies`, `optionalDependencies` or `peerDependencies`).
4. **Dev-only is re-proved on every run:** the production audit must not report the advisory or any listed package.
5. A moderate exception only: `high` and `critical` can never be excepted. The entry must also carry the recorded owner acceptance (`approvedBy`, `approvedOn`, `rationale`, `removalCriteria`) and the verified graph, or it is invalid.
6. **Expired** (from 00:00 UTC the day after `expires`), **obsolete** (advisory gone) and **mismatching** entries all fail the gate by themselves, and an expired entry no longer excepts anything.
7. No override, no `npm audit fix --force`, no `continue-on-error`, no lowered threshold; `web/tests/unit/audit-policy.test.ts` pins all of this (positive cases on the real `release` audit output, negative cases for each rule above, the exact deadline boundary, the CLI exit codes and the workflow wiring).

To add a future exception: only with the owner's recorded decision in the pull request, an exact advisory, a real dependency-graph verification like the one above, and an expiry. Do not widen an existing entry.
