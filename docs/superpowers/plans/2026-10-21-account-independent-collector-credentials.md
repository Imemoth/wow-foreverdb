# Account-independent collector credentials

## Goal

Keep public collector upload independent of the interactive account by making the existing device credential and enrollment flow installation-scoped, while retaining account-scoped Guildbook routing.

## Work items

- [ ] Add durable per-installation credential slots with legacy single-slot read/migration compatibility and focused store tests.
- [ ] Add one backward-compatible database migration that permits one anonymous collector identity to enroll multiple installations, while retaining ownership and installation-bound checks; add disposable PostgreSQL/GoTrue regressions.
- [ ] Make Companion enrollment, status, sync routing, and rotation target a specific installation; report missing collector enrollment without falling back into misleading ownership state.
- [ ] Keep Guildbook results separate from public sync completion metrics and add A→B→anonymous, stale-capture, multi-installation, and independent-outcome regressions.
- [ ] Run focused tests and exact-head CI, build the normal Windows Release artifact, update the report, push the branch, and open a PR stacked on #88.

## Constraints

Do not change installation ownership, historical observations, Guildbook ownership, PRs #81–83/#88, live Supabase state, or installer publication.
