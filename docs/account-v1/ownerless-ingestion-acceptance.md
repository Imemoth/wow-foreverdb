# Ownerless Companion ingestion acceptance

Status: **pending Windows owner acceptance**. CI and automated tests do not establish that the Windows UI or live WoW Forever client passed.

## Corrected build

Use the `ForeverDB-Companion-0.9.12-alpha-<full-commit-sha>-win-x64` artifact from this Draft PR's successful Windows build. Verify the title bar version and short SHA match the artifact. Keep Auto Sync OFF for the first pass; no test step should enable it unless explicitly described below.

## Manual matrix

| Case | Steps | Expected result |
| --- | --- | --- |
| Fresh install, no account | Start the Companion on a clean Windows profile, detect a WoW Forever install, capture public observations, then click **Sync Now**. | A technical anonymous Auth session is created and stored with DPAPI. Upload completes without signing into a website account or choosing an installation owner. Auto Sync remains OFF. |
| Existing historical installation | Upgrade in place with an existing local installation ID and local data. Click **Sync Now**. | No reinstall, local reset, claim or owner selection is requested. Server-proven credentials continue to upload; unbackfilled identities fail closed with a clear credential error. |
| Account A → B → A | Sign in as A and sync. Sign out or sign in as B, then sync. Return to A and sync again. | Account changes do not disable public sync solely due to installation ownership. Public observations remain deduplicated. Account-specific UI and Guildbook cache never expose A's data while B is active; A's local cache returns when A signs in again. |
| Manual and automatic controls | With Auto Sync OFF, change characters or restart. Then explicitly enable Auto Sync, restart, and repeat. | OFF stays OFF across restart/account changes. ON remains the user's saved preference and only uses the existing public observation payload. |
| Bad credential / forged installation ID | Use an invalidated credential or an unrelated Companion identity with a copied installation ID in the integration harness. | Server rejects the request. No observations or private Guildbook data are changed. |
| Device activation | Complete one successful public sync first. Download the account activation file and place it in the documented activation location; let the Companion consume it. | Ticket and device limits, account status, secret rotation/revocation, and DPAPI storage remain enforced. A ticket or installation ID alone cannot enroll an unrelated identity. |
| Guildbook local-only | Capture/import Guildbook while signed into A; inspect the public upload boundary and network diagnostics. | Guildbook capture remains local and DPAPI-protected per account/installation. No Guildbook names, members, professions, or character details appear in snapshot requests. |

## Evidence to record

Record Windows version, Companion artifact name and SHA, WoW Forever build, each case result, Auto Sync state before/after restart, and sanitized screenshots/log status. Do not include passwords, bearer tokens, device secrets, guild names, member names, or profession details in the evidence. Mark each manual case pending until run on the corrected Windows build.
