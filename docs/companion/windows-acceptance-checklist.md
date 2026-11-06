# Companion C0 Windows acceptance checklist

**Owner-run only.** Build and synthetic tests do not prove Windows folder-picker behavior, a real Forever installation, or live account isolation. The owner reported W1-W3 complete on the preceding Windows build; W4-W6 remain pending. Do not paste SavedVariables, credentials, full account IDs, or full installation IDs into the run record.

## Safety rules

- Use the exact Companion **0.9.11-alpha** artifact linked from Draft PR #176's latest successful Windows build. Confirm the title bar shows `0.9.11-alpha` and the seven-character Git SHA matches the artifact filename.
- Use a local/synthetic fixture for W1-W3. Do not sync during discovery or picker checks.
- For W4, use only two owner-controlled accounts in an isolated staging project, never production.
- Guildbook stays local-only. Inspect sanitized request paths/bodies if network inspection is needed; do not capture tokens or raw SavedVariables.
- Keep registered-device AutoSync disabled. C0c staging write/read-back is a separate owner acceptance step.
- A pending or failed check is not a PASS based on CI output.

## Run record

| Field | Value |
| --- | --- |
| Companion version / commit | |
| Windows version | |
| Forever client build / root redacted | |
| Staging project ref (W4 only) | |
| Date / tester | |

## Scenarios

| # | Procedure | Expected result | Result / evidence |
| --- | --- | --- | --- |
| W1 — Forever installation | Start with one installed `_forever_` client and open Settings. Select it, inspect status, Save, then use Sync Now only if separately authorized. | The Forever path is selected; validation reports install and SavedVariables availability separately. No request starts from discovery itself. | **PASS — owner-reported on preceding build** |
| W2 — Multiple clients | Install or expose `_forever_` and `_classic_beta_` side by side. Open the detected list and inspect the selected path. Try saving the beta root. | Forever is the default when it is the only Forever client. Beta remains identifiable for diagnostics and is rejected as the Forever data source. | **PASS — owner-reported on preceding build** |
| W3 — Persistence and picker cancellation | Select a custom valid path, save, restart Companion. Reopen Browse and cancel; then edit another path and press Cancel. | The saved custom path persists across restart. Native picker cancellation and Settings Cancel leave the saved selection unchanged. | **PASS — owner-reported on preceding build** |
| W4 — Account switching | In isolated staging, use Account A with its installation, switch to verified Account B, then switch back to A. Test a device linked to A while B is selected. | A's and B's ownership remain separate. The A device upload is blocked under B. Switching back to A restores A's local view. No credential is deleted or substituted. | **PENDING — owner; next test** |
| W5 — Guildbook local import and A/B/A restore | 1. Install the exact `0.9.11-alpha` artifact and record the displayed short Git SHA. 2. Sign in as verified Account A and confirm AutoSync is OFF. 3. Use the existing saved capture; only if needed in WoW run `/fdb guildbook refresh`, wait at least four seconds, then `/reload`. 4. Click Guildbook **Refresh data**. 5. If asked, authorize first import for the currently signed-in A account. 6. Verify 1 guild, 22 members and approximately 30 profession records; verify diagnostics say SavedVariables imported and local-only. 7. Switch to Account B (`test@test.com`). 8. Verify A's guild, members and professions are hidden; diagnostics should report installation bound to another account. 9. Restart Companion under B and verify A's data remain hidden. 10. Switch back to A and verify the same roster and professions return automatically from the encrypted local cache. 11. Restart Companion under A and verify they remain present. 12. Confirm no Guildbook data was sent to Supabase. | Addon action is exactly `/fdb guildbook refresh`; wait at least four seconds and `/reload` so WoW's `PLAYER_LOGOUT`/SavedVariables lifecycle persists the capture. Companion **Refresh data** parses local `ForeverDB.lua`, shows an explicit first-import authorization, writes the account/install-bound DPAPI cache and restores it only for A. B cannot import the same SavedVariables or read A's cache. The button makes no Auth, claim, RPC or snapshot-ingest request. **Do not click STATUS Sync Now, Check status, ownership claim, or any other production-write action during W5.** | **PENDING — owner; required on actual Windows/Forever build** |
| W6 — Sync safety | Confirm registered-device AutoSync is off. Trigger a SavedVariables change and restart. Use Sync Now to inspect availability without uploading staging data unless the separate C0c gate is approved. | Automatic registered-device triggers make no upload. Manual Sync Now remains available and requires the selected signed-in account to own the installation. | **PENDING — owner** |

## Remaining implementation phases

- **C0c:** owner-approved, isolated staging-only Schema 9 manual upload, public payload inspection, replay/idempotency, and read-back.
- **C0d:** separate per-installation registered-device AutoSync opt-in. Existing `AutoSync=true` is not migration consent; new and upgraded installations default to registered-device AutoSync off.
- **C1:** separately reviewed versioned anonymous quest-evidence model. Do not transport the private per-character quest journal or infer selected reward choices.

For W5, use a guilded character and a verified registered Companion account. Do not use STATUS **Sync Now**, **Check status**, ownership claim or other production-write actions; the Guildbook tab's **Refresh data** button is the local-only operation. Record only PASS/FAIL and redacted client/build details, not guild/member names or raw SavedVariables.
