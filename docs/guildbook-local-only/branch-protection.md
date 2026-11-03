# Guildbook local-only CI enforcement

## Required check to configure

Add a repository ruleset or classic branch protection rule with this required status check:

```text
guildbook-local-only-policy
```

Target `main` and `release`. For the current stack, also protect `release-rc/azerdex-beta-20261030` (PR #142's base) and `feat/azerdex-gdpr-consent` (PR #143's base). Require pull requests and require this check before merge. Keep the check context exact; renaming the job requires changing the ruleset. The workflow is in `.github/workflows/guildbook-local-only-policy.yml`.

The draft ruleset payload is `docs/guildbook-local-only/branch-ruleset.json`. It targets `main`, `release`, and the two active stacked base branches, requires the stable check context, and has no bypass actors. Configure required pull requests in the repository's separate PR rule if using rulesets; the JSON intentionally focuses on this policy check.

**No branch is yet confirmed protected by this check.** GitHub settings are not managed by this repository, and this session's GitHub credential is invalid, so no ruleset could be read or changed here. The trusted workflow and ruleset are prepared in this branch. An owner must land the workflow on `release`, propagate it through the current stack using ordinary commits/merges, configure the ruleset, and verify it on GitHub. Add the same requirement on `main` before claiming enforcement there.

## Trust boundary and rollout

The workflow uses `pull_request_target` and loads both the workflow and scanner from the PR's trusted base commit. It checks out the proposed tree only as inert files for SQL scanning. It does not run PR scripts, actions, package hooks, or binaries, and it receives no secrets. The required check is still unavailable until this workflow exists in the target branch's base history.

The rollout must account for the stack:

- PR #141 targets `release`; require the check on `release`.
- PR #142 targets `release-rc/azerdex-beta-20261030`; require it on that branch.
- PR #143 targets `feat/azerdex-gdpr-consent`; require it on that branch.
- Propagate the trusted workflow into each stack base before requiring the check there. Do this with ordinary commits/merges; do not force-push.

Do not report the policy as globally enforced until GitHub shows the active ruleset and a required check on each actual merge target. The proposed workflow itself does not protect branch names or prevent administrators/bypass actors from overriding rules.

## Local behavior

`node scripts/check-guildbook-local-only-policy.mjs` scans SQL files in both migration trees. It evaluates SQL after removing comments, reserves every `0016*` migration filename, and permits the reviewed historical 0005, 0009, 0012, and 0014 files only at their exact content hashes. These files contain the original Guildbook storage, ingest implementation, RPCs, and entrypoint calls; edits or renames lose their exception and are scanned as new behavior. The approved 0018 file is pinned to its approved content hash; any removal or edit fails closed. The unit tests include 0016-style storage, RPC, copy, and grant SQL under both the reserved and a different filename, plus harmless documentation comments and an unrelated 0017 migration.

This is a conservative textual SQL guard, not a general SQL parser. It cannot prove arbitrary dynamic SQL or obfuscated behavior safe. The base-owned trusted workflow and human review of SQL remain necessary.
