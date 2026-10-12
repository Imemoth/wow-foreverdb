# Companion 0.9.0-alpha — Windows acceptance checklist (owner-run, PR E)

CI proves compilation and test doubles only. **WINDOWS VERIFIED requires the owner to execute these on a real Windows machine.** Copy the "Run record" per execution; do not paste secrets, tokens, claim codes or full installation ids (redact to the first 6 characters).

Rules (from [companion.md §13](companion.md)): W1a runs with the **account gate closed**, **AutoSync OFF** and **no Sync now**, so no write reaches the production service. W1b-W9 use `FOREVERDB_ACCOUNT_MODE=staging` against the owner's isolated staging project and the separate vault `%LOCALAPPDATA%\ForeverDB\account-test\staging-<ref>\`. W10 runs gate-closed with a firewall rule blocking the production host.

## Run record (fill once per execution)

| Field | Value |
| --- | --- |
| Companion binary / version / commit (`About`, `git rev-parse`) | |
| Windows version, display scaling | |
| Environment (production vault gate closed / staging) | |
| Staging project ref (not the keys) | |
| Test installation id (redacted) | |
| Website preview URL + commit | |
| Date, tester | |

## Scenarios

W8 is now technically testable: `/account/link` exists on the preview (PR E). Flow: Companion ACCOUNT tab -> generate code -> copy -> website `/account/link` signed in as the staging account -> paste, enter password, confirm -> Companion shows *transferred*, asks to sign in, then syncs under the account.

| # | Scenario (see companion.md §13 for the full text) | Environment | Expected | Observed | Evidence (screenshot/log file names, no secrets) | Result (PASS / FAIL / BLOCKED) |
| --- | --- | --- | --- | --- | --- | --- |
| W1a | Production-vault upgrade safety: backup `session.dat`, install over 0.8.x, gate closed, AutoSync OFF; file bytes/identity unchanged, no `.lost-*`, no network write | real vault, gate closed | identical bytes; anonymous mode shown | | | |
| W1b | Staging legacy-format upgrade fixture in the staging vault | staging | identity preserved, refresh rotates and persists, test installation ingests (staging only) | | | |
| W2 | Offline start with an expired staging token; reconnect | staging | identity unchanged, no new Auth user | | | |
| W3 | First run with an empty staging vault | staging | choice shown; nothing created until chosen | | | |
| W4 | Sign in with a confirmed staging account | staging | e-mail shown; legacy identity preserved; installation still syncs | | | |
| W5 | Sign out | staging | website session unaffected; legacy still syncs | | | |
| W6 | Two Companion processes started together | staging | one identity, no re-auth | | | |
| W7 | Start a claim; code shown once; copy; expiry; hide | staging | no code in vault directory or settings | | | |
| W8 | Redeem on the website, then Companion transfer detection and account-owned sync | staging + PR E preview | *transferred*, sign-in prompt, sync under the account; website lists the installation and Guildbook | | | |
| W9 | Visual review of the ACCOUNT tab, dark theme, 100% and 150% | either | readable, no clipping | | | |
| W10 | Gate closed, production host blocked by firewall | real vault, gate closed | features off, **no** account request, Companion usable offline | | | |

Current status of every row: **PENDING (owner)**. Nothing in this repository claims otherwise.
