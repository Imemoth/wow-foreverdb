# Migration 0016 branch audit

Audit performed against the public `Imemoth/wow-foreverdb` GitHub repository on 2026-10-30. The scan examined all 80 advertised remote branches and all 18 open pull-request heads returned by GitHub's open-PR page.

## Target branches and open PRs

| Target | Result |
| --- | --- |
| `main` | No `database/migrations/0016_account_scoped_guildbook.sql` |
| `release` | No 0016 file |
| PR #141 (`release-rc/azerdex-beta-20261030`) | No 0016 file |
| PR #142 (`feat/azerdex-gdpr-consent`) | No 0016 file |
| PR #143 (`fix/guildbook-local-only-rc`) | No 0016 file |

Open PR heads #88 and #91 contain 0016. PR #91 (`feature/account-independent-collector-credentials`) is based on PR #88's `feature/account-scoped-guildbook-integration`, so #91 inherits the file from #88; it does not independently need a copy of the migration. The other open Guildbook security PR, #121, contains 0018 but no 0016.

## Remote branches where 0016 remains

The all-branch scan found the file on these four branch tips:

- `feature/account-scoped-guildbook-integration` (PR #88)
- `feature/account-independent-collector-credentials` (PR #91, stacked on #88)
- `feature/guildbook-local-only`
- `test/guildbook-local-only-windows-acceptance`

No branch was deleted, rewritten, or force-pushed. GitHub rejected the current CLI credential as invalid, so no remote branch edits were made.

## Safe retirement scope

- The 0016 migration itself is obsolete and must be removed from the current tree of any branch proposed for release.
- On PR #88, cloud Guildbook SQL/API behavior and tests that specifically require account-scoped cloud Guildbook must be retired together. The local Companion Guildbook collector/UI and unrelated account/collector functionality should be preserved. Deleting only the SQL file would leave dependent integration tests and routes inconsistent, so treat #88 as a code retirement change, not a file-only deletion.
- PR #91 inherits #88's migration through its base. Retiring #88's Guildbook cloud code first avoids carrying the migration through the stack; keep #91's unrelated collector enrollment changes.
- `feature/guildbook-local-only` and `test/guildbook-local-only-windows-acceptance` are not open PR heads. Before updating them, remove only their obsolete cloud-migration-dependent tests/docs and retain their local-only Companion acceptance code. Do not delete either branch.
- References in docs, review records, and this audit are historical references and are safe to retain. They do not apply SQL or reintroduce the migration. Migration number 0016 remains reserved permanently.

This audit is a point-in-time inventory. A newly pushed branch or PR after this scan is not covered until re-scanned.
