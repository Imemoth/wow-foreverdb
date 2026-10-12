# One-installation claim pilot - existing private Supabase

Status: DRAFT / UNMERGED / NO LIVE CLAIM EXECUTED. Owner explicitly approved lifting the claim ban and ACCEPTED the risk of using their own historical installation for the first controlled test (2026-10-12). The selected target is ONLY `2f8df8ba69345d0a14c8d56ac86d4b2e` (verified anonymous-owned in live Supabase). Other six historical installations are out of scope.

## Security model
- The normal Companion remains production-anonymous. The previous private-pilot remains login-only.
- Separate process-only mode: FOREVERDB_ACCOUNT_MODE=private-claim-pilot, exact approved Supabase URL, modern sb_publishable key, matching project ref, plus FOREVERDB_ACCOUNT_CLAIM_INSTALLATION=<single preverified disposable installation ID>. Both temporary source approval flags must be reverted before any public release.
- A copy of the original anonymous owner credential is imported into the isolated test-vault legacy slot. The original LOCALAPPDATA/ForeverDB/session.dat is never modified by this import. The copied credential is NEVER refreshed/revoked, so an expired access token requires a return to normal anonymous Companion. Registered sign-in lives in the separate primary test slot.
- The selected installation is verified by backend as owned by the live anonymous token before the server creates a ten-minute, one-time linking code. In-memory only, never logged or written to a settings file. All other IDs are refused by UI and ClaimService before network access.
- The protected website requires signed-in account, fresh password, CSRF protection and explicit user confirmation for redemption. Supabase migration 0012 enforces atomic ownership transfer and restricts private Guildbook data.
- The selected historical installation's owner WILL change upon web redemption. Other SIX historical installations, all other claim codes, automatic ingest, new anonymous signup, owner-selection, diagnostic upload and automatic post-login resync remain forbidden in the client. Even for the selected installation, post-claim ingest stays OFF during this first phase; therefore normal anonymous sync of that installation is expected to stop after transfer until registered ingest is implemented.

## Read-only pre-claim server baseline (2026-10-12)

- Selected: `2f8df8ba69345d0a14c8d56ac86d4b2e`; **exists**, **anonymous-owned**, not yet linked to a registered Account.
- 7 installations total, 6 unselected. **Other-six owner-fingerprint: `1bd16ed087b98f0632b5f01a39c760ba`** (MD5 of sorted `<id>:<owner_user_id>` strings; this is only a comparison/checksum, not a security signature).
- 0 rows in `private.account_installations`; 0 claim records; selected installation 140 source-stat rows and 46 Guildbook-member rows.
- All queries were SELECT/read-only. Exact final CI before the next owner build must be checked at its SHA; this note itself does not authorize redemption.
## First Windows acceptance - NOT STARTED
1. Owner explicitly selected the existing historical ID `2f8df8ba69345d0a14c8d56ac86d4b2e` and accepted that its current anonymous ingest may stop following transfer. Before issuing any code, require final CI and security review, and re-query that EXACT ID is still owned by an anonymous Auth user, has no account link/claim, and remains the only scoped selection. Baseline: 140 source-stat rows, 46 Guildbook-member rows, server last_seen_at 2026-10-12 17:39 UTC. Do not use any of the other six historical installations for this test.
2. Fully close Companion; retain local backup and AutoSync OFF. Launch the new tested pilot binary with variables scoped to that process only; never store account secrets in GitHub, chat or settings.json.
3. Confirm protected claim-pilot banner; only the selected installation may show Check / Generate claim. Sign in to the registered account, verify original anonymous owner credential is recognized; no automatic ingest.
4. Generate a one-use code only for the approved disposable installation. Redeem through the already-protected /account/link website after re-entering password; never paste code into chat.
5. Read-only verify the selected installation changed from anonymous to the intended registered owner, account-installation link count changed 0 -> 1, private Guildbook is visible only to the registered account, and the original 140 source-stat and 46 Guildbook-member rows are retained. Other SIX installation ownership rows must remain unchanged. If any protected snapshot/upload occurs, STOP.
6. Close test client, clear process vars and restart normal anonymous Companion. It must still authenticate, but this selected installation is now expected to reject anonymous writes because ownership moved. Do NOT attempt repeated writes to the transferred installation. The other six should retain their original ownership.

Stop and do not retry if any installation OTHER than the exact scoped ID is selected, credentials cannot be read, unexpected token refresh occurs, account-claim guard fails, arbitrary ID can request a code, or any auto-ingest appears. This draft has not been verified against a real Windows claim.