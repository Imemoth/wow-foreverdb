# One-installation claim pilot - existing private Supabase

Status: DRAFT / UNMERGED / NO LIVE CLAIM EXECUTED. Owner explicitly approved lifting the previous Companion claim ban on 2026-10-12. First trial is scoped to one NEW disposable installation, never one of the 7 existing ones.

## Security model
- The normal Companion remains production-anonymous. The previous private-pilot remains login-only.
- Separate process-only mode: FOREVERDB_ACCOUNT_MODE=private-claim-pilot, exact approved Supabase URL, modern sb_publishable key, matching project ref, plus FOREVERDB_ACCOUNT_CLAIM_INSTALLATION=<single preverified disposable installation ID>. Both temporary source approval flags must be reverted before any public release.
- A copy of the original anonymous owner credential is imported into the isolated test-vault legacy slot. The original LOCALAPPDATA/ForeverDB/session.dat is never modified by this import. The copied credential is NEVER refreshed/revoked, so an expired access token requires a return to normal anonymous Companion. Registered sign-in lives in the separate primary test slot.
- The selected installation is verified by backend as owned by the live anonymous token before the server creates a ten-minute, one-time linking code. In-memory only, never logged or written to a settings file. All other IDs are refused by UI and ClaimService before network access.
- The protected website requires signed-in account, fresh password, CSRF protection and explicit user confirmation for redemption. Supabase migration 0012 enforces atomic ownership transfer and restricts private Guildbook data.
- Original seven owners/rows, all other claim codes, automatic ingest, new anonymous signup, owner-selection, diagnostic upload and automatic post-login resync remain forbidden in the client. Even for the selected installation, post-claim ingest stays OFF during this first phase.

## First Windows acceptance - NOT STARTED
1. Require green CI and code review on final PR, then create and verify a disposable installation ID NOT present among the seven historical production installations. Do not use historical SavedVariables for the first claim.
2. Fully close Companion; retain local backup and AutoSync OFF. Launch the new tested pilot binary with variables scoped to that process only; never store account secrets in GitHub, chat or settings.json.
3. Confirm protected claim-pilot banner; only the selected installation may show Check / Generate claim. Sign in to the registered account, verify original anonymous owner credential is recognized; no automatic ingest.
4. Generate a one-use code only for the approved disposable installation. Redeem through the already-protected /account/link website after re-entering password; never paste code into chat.
5. Read-only verify registered owner, previous owner, private Guildbook and linked-installation counts; require unchanged seven historical installation owners and complete source/guild data.
6. Close test client, clear process vars, restart anonymous Companion and verify original anonymous authentication and manual sync work.

Stop and do not retry if any old installation is selected, credentials cannot be read, unexpected token refresh occurs, account-claim guard fails, arbitrary ID can request a code, or any auto-ingest appears. This draft has not been verified against a real Windows claim.