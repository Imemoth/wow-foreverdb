# Repository development policy

## Pull request hygiene

- Reuse an existing open PR whenever technically reasonable. Before opening a PR, inspect open PRs for overlapping files, behavior, dependencies, and owner decisions; prefer updating the relevant Draft PR.
- Do not create a new PR by default. A separate PR needs a clear reason, such as an independent review boundary or an unavoidable dependency phase. Keep the dependency chain explicit and avoid unnecessary stacking.
- For related open PRs, record which work is active, completed, superseded, redundant, or temporary. Compare the actual diffs and dependency graph; titles or descriptions alone are not enough.
- Close an obsolete PR only after verifying that it has no unresolved dependent PRs and contains no unique work that would be lost. If a dependent PR needs its commits, consolidate or rebase that work first and verify the resulting diff. Keep temporary acceptance PRs open while their acceptance evidence or downstream dependencies still rely on them.
- Before consolidating or retargeting, compare heads and bases, preserve unique commits, and rerun the affected checks. Do not merge, deploy, run migrations, or modify live data without explicit owner authorization.

## Local-only WoW acceptance

- Prefer diagnostic commands that report aggregate evidence-class counts and revisions without changing SavedVariables or exports.
- Never automatically reset, fork, or upload gameplay acceptance observations. Keep Companion closed and Auto Sync disabled during local attribution testing unless the owner explicitly authorizes a different test setup.
