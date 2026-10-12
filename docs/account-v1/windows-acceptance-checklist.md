# Companion 0.9.0-alpha — Windows acceptance checklist (owner-run, PR E)

CI proves compilation and test doubles only. **WINDOWS VERIFIED requires the owner to execute these on a real Windows machine.** Copy the "Run record" per execution; do not paste secrets, tokens, claim codes or full installation ids (redact to the first 6 characters).

Rules (from [companion.md §13](companion.md)): W1a runs with the **account gate closed**, **AutoSync OFF** and **no Sync now**, so no write reaches the production service. W1b-W8 use `FOREVERDB_ACCOUNT_MODE=staging` against the owner's isolated staging project and the separate vault `%LOCALAPPDATA%\ForeverDB\account-test\staging-<ref>\`. W10 runs gate-closed with a firewall rule blocking the production host.

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
| W9 | Visual review of the ACCOUNT tab, dark theme, 100% and 150% | either; gate closed | readable, no clipping | Anonymous account state, local installation and account-disabled notice visible; narrow/wide window and owner-reported Windows display scaling changes: no clipped or overlapping controls | 2026-10-12 owner screenshots: `image(20261012-121733).png`, `image(20261012-121740).png`, `image(20261012-121835).png`; STATUS evidence `image(20261012-121709).png` | **PASS — WINDOWS VERIFIED (owner, visual only)** |
| W10 | Gate closed, production host blocked by firewall | real vault, gate closed | features off, **no** account request, Companion usable offline | | | |

## W9 evidence record — 2026-10-12

- **Companion:** 0.9.0-alpha, real owner Windows runtime; exact binary commit and Windows version not supplied.
- **Owner actions:** ACCOUNT tab at different window sizes and Windows display scales (100% and 150% as requested). Visuals show correct responsive spacing, text readability, dark-theme contrast and no overlapping or clipped controls.
- **Account features:** Disabled by design; existing anonymous identity shown, installation list visible. No claim, registered login, identity recreation or ownership transfer was attempted.
- **STATUS:** AutoSync changed from Enabled in the earlier screenshot to **Disabled** in the latest evidence. Last sync remains a prior successful startup sync; Central DB says `Auth pending`, Last error `None`. This is not proof of token/refresh correctness and not a W1a result.
- **Result:** W9 **PASS (visual-only owner acceptance)**. W1a remains **PENDING** because no before/after credential-byte comparison, backup, or migration safety proof was provided. W1b–W8 and W10 remain PENDING.
- **Privacy:** Screenshot evidence filenames only; no raw account tokens, claim codes, full installation IDs or password information are recorded.

All other Windows acceptance rows remain **PENDING (owner)**. CI success is not a substitute for the remaining owner-run scenarios.
