# Companion C0 Windows acceptance checklist

**Owner-run only.** Build and synthetic tests do not prove Windows folder-picker behavior, a real Forever installation, or live account isolation. Leave every row pending until the owner records the observed result on a real Windows machine. Do not paste SavedVariables, credentials, full account IDs, or full installation IDs into the run record.

## Safety rules

- Use Companion **0.9.0-alpha** from Draft PR #176.
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
| W1 — Forever installation | Start with one installed `_forever_` client and open Settings. Select it, inspect status, Save, then use Sync Now only if separately authorized. | The Forever path is selected; validation reports install and SavedVariables availability separately. No request starts from discovery itself. | **PENDING — owner** |
| W2 — Multiple clients | Install or expose `_forever_` and `_classic_beta_` side by side. Open the detected list and inspect the selected path. Try saving the beta root. | Forever is the default when it is the only Forever client. Beta remains identifiable for diagnostics and is rejected as the Forever data source. | **PENDING — owner** |
| W3 — Persistence and picker cancellation | Select a custom valid path, save, restart Companion. Reopen Browse and cancel; then edit another path and press Cancel. | The saved custom path persists across restart. Native picker cancellation and Settings Cancel leave the saved selection unchanged. | **PENDING — owner** |
| W4 — Account switching | In isolated staging, use Account A with its installation, switch to verified Account B, then switch back to A. Test a device linked to A while B is selected. | A's and B's ownership remain separate. The A device upload is blocked under B. Switching back to A restores A's local view. No credential is deleted or substituted. | **PENDING — owner** |
| W5 — Guildbook local-only | With verified staging accounts, load Guildbook for A, switch to B and back to A, restart Companion, and change the selected installation. Inspect outbound requests. | Only the verified account/installation's encrypted local Guildbook is displayed. No roster, member, profession, or Guildbook RPC/payload is sent. | **PENDING — owner** |
| W6 — Sync safety | Confirm registered-device AutoSync is off. Trigger a SavedVariables change and restart. Use Sync Now to inspect availability without uploading staging data unless the separate C0c gate is approved. | Automatic registered-device triggers make no upload. Manual Sync Now remains available and requires the selected signed-in account to own the installation. | **PENDING — owner** |

## Remaining implementation phases

- **C0c:** owner-approved, isolated staging-only Schema 9 manual upload, public payload inspection, replay/idempotency, and read-back.
- **C0d:** separate per-installation registered-device AutoSync opt-in. Existing `AutoSync=true` is not migration consent; new and upgraded installations default to registered-device AutoSync off.
- **C1:** separately reviewed versioned anonymous quest-evidence model. Do not transport the private per-character quest journal or infer selected reward choices.
