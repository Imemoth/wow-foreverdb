# Branch policy: `release`, `main` and Dependabot

Status: **proposed documentation of the current practice, 2026-11-11.** It changes no rule, ruleset or workflow. It records decisions already taken and the owner's instruction that production stays on `release` and `main` stays the integration and admin branch.

## 1. Roles

| Branch | Role | Notes |
| --- | --- | --- |
| `release` | **Production.** Recent Vercel production deployment records show `release` (the project's Production Branch setting itself is still to be confirmed, see `release-gates.md`); Supabase and Edge Function releases are made from it. | Protected. Everything that must reach production is merged here by a reviewed PR. |
| `main` | **Default, integration and admin branch.** Dependabot target, home of the admin (ADM) work and governance docs. | Protected. Nothing on `main` reaches production until it is promoted to `release` by a reviewed PR. |

There is no automatic synchronisation in either direction. As of 2026-11-11 the branches have diverged on purpose: `main` has the admin documents and the ADM-01B-1 migration (PR #191); `release` has the Ops Bot, the Supabase health report and Option G, and the 2026-11 dependency refreshes.

## 2. Protection (single ruleset)

One repository ruleset (`main release gates`) targets the default branch and `refs/heads/release`: pull request required, review threads resolved, no bypass actors, no deletion or force push, and **strict required status checks** (the PR must be up to date with its base). The live ruleset requires **ten** checks; the copy of the ruleset JSON and of `release-gates.md` currently on `release` still describe six and an older state, and `main`'s copies are the current ones. Aligning them is part of the first synchronisation PR, not a separate change to the ruleset.

Consequence of strictness: **merges to one branch are serial.** After a merge, every other open PR to that branch is "behind" and needs a refresh (merge the base in) and a fresh CI run before its own merge.

## 3. How changes move

1. A change goes to the branch where it belongs. Production-bound work targets `release`. Admin and documentation-governance work targets `main`.
2. **`release` to `main`:** a dedicated, reviewed synchronisation PR (merge commit, never squash, never automatic), after a batch of production merges. Resolve conflicts in that PR.
3. **`main` to `release`:** only through a reviewed release-candidate or hotfix PR that lists exactly what is promoted. Admin work in particular stays on `main` until such a PR.
4. A change to a **policy guard** (for example `scripts/check-guildbook-local-only-policy.mjs`) is its own PR to the branch it protects, never bundled with the feature that needs it: the guard workflow runs the base branch's script, so a PR cannot loosen the guard it is judged by.
5. Hosted database changes are never implied by a merge. Each hosted migration needs its own explicit owner approval, its registry row (`database/MIGRATIONS.md`) and its evidence. The `Migration registry` workflow (informational, not a required check) runs `scripts/check-migration-registry.mjs` when a migration directory or the registry changes, and fails on duplicate registry IDs or ledger aliases, unregistered or doubly claimed migration files, and unexplained number differences.

## 4. Dependabot

- `.github/dependabot.yml` on `main` records the decision: **`main` is the target for version and security updates, and `target-branch: release` must not be added**, because Dependabot security updates always target the default branch. (An earlier suggestion to point Dependabot at `release` is withdrawn for that reason.)
- Dependabot PRs on `main` are signals and candidates, not the production path.
- **Production dependency updates ship as focused release-based PRs** built from the exact `release` lockfile (precedent: #150 publisher, #151 web, both merged 2026-11-11), with a clean `npm ci`, `npm audit`, the full required CI on the final head, and only the intended lockfile and manifest changes in the diff. They merge serially because of strict checks.
- A Dependabot PR is closed only when its intended updates are **fully covered** by what is on the branch or **explicitly superseded**; a newer version in the Dependabot PR is not covered by an older pin. Open today: #158 (publisher, rollup 4.67.x) and #185 (web, newer Next, Playwright, rollup, Tailwind and axe-core 4.14.0).
- **`axe-core` and `@axe-core/playwright` 4.14.0 stay blocked** until issue #152 (the talent-control accessible names) is resolved and verified.
- After production dependency merges, include them in the next release-to-main synchronisation so Dependabot rebases against the real baseline.

## 5. Open items this policy leaves for the owner

- Approve and perform the first release-to-main synchronisation (not automatic).
- Align the stale ruleset JSON and `release-gates.md` on `release` (ride on that synchronisation).
- Name the target Supabase project in PR #191 before any hosted migration.
