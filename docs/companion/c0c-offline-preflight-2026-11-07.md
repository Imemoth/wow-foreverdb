# C0c offline Schema 9 transport preflight (2026-11-07)

## Scope and immutable baseline

- Review-only source: \`release\` after merged PR #176, commit \`8f3a960a92cef1d942493791fa97d4b7b3b1884e\`.
- Companion currently accepted by owner: \`0.9.11-alpha · 3619eda\`; addon \`0.7.1-alpha\`; export Schema 9.
- Owner W4 account switching, W5 Guildbook A→B→A including full process restarts, and W6 **AutoSync OFF / no automatic upload** are accepted. These do **not** authorize a manual public snapshot upload.
- This PR adds only a synthetic offline regression test, no software feature, version bump, production configuration or schema change.

## Read-only security and routing review

1. \`SyncService.SyncFileAsync\` parses the local \`ForeverDB_Export\`, creates an explicit \`PublicObservationSnapshot\`, and stores the authenticated Guildbook locally **before** routing any public request.
2. \`PublicSnapshotGuard\` is called inside both network clients: \`OwnershipRpcClient.IngestAsync\` and \`DeviceRpcClient.IngestAsync\`. Allowed public fields cover Schema 9 sources, buckets, item \`questDrops\` / explicit \`questIds\`, positions and map art. Guildbook rosters, characters and \`questJournal\` are outside the allowlist.
3. For a device-bound installation, \`SyncService.SyncRegisteredDeviceAsync\` rejects non-manual triggers. A manual attempt requires a live verified registered account, fresh server \`fdb_installation_link_status\` ownership proof and matching account ID/session generation; identity switching cancels in-flight work. The device's independent credential reaches \`fdb_device_ingest\` only after these checks.
4. Other installations follow \`InstallationSyncCoordinator\`: resolved registered or historical anonymous owner, explicit owner selection if unknown, no silent credential fallback, and no cross-identity retries. **This is a distinct path** and should remain in negative test coverage.
5. The backend \`fdb_device_ingest\` revalidates active device, installed secret, account status, installation ID and current installation owner under a transaction lock; wrong-owner and revoked-device cases fail closed. The ordinary \`ingest_foreverdb_snapshot_auth\` also enforces owner, authenticates the caller and uses a per-installation transaction lock.

These conclusions are based on source and the existing test suite, not a live production upload.

## Read-only production SQL preflight

At **2026-11-07 20:36 UTC**, production counts remained: 9 installations, 167 source-stat rows, 395 item-stat rows, 615 location rows, 2 account links, 2 active devices; the three legacy Guildbook cloud tables were each empty. The latest public installation ingest timestamp remained **2026-10-21 16:13:16 UTC**.

The read-only \`pg_proc\` privilege check verified that the account-auth ingest, device ingest and link-status functions are deployed; \`authenticated\` has execute rights, while \`anon\` and \`PUBLIC\` do not. The private ingest implementation, device authorization and live-session caller helpers are not executable by \`authenticated\`, \`anon\` or \`PUBLIC\`. This check does not prove that the installed function bodies exactly match any one migration text.

No secret, account ID, installation ID, roster, raw SavedVariables or personal quest journal was recorded.

## Synthetic test scope

\`tests/companion-account/C0cOfflineTransportTests.cs\` uses the real Schema 9 parser and uploader against the existing **in-process FakeSupabase**, with an entirely synthetic, nonempty \`H/M/A/S/B/L/I/G/C/P\` export:

- Item 11127 is observed from synthetic source 164662; drops, quantity, \`questDrops\`, quantized location and map art are asserted.
- A blank quest-ID CSV stays empty/unknown; it does not imply a canonical quest relationship.
- A pre-login Guildbook capture is explicitly authorized, persists locally and remains absent from \`p_snapshot\`.
- The outbound body contains only allowlisted public data, no synthetic private canary.
- The Companion avoids an unnecessary same-session resend; an explicitly forced re-send serializes the same public payload.

**Important boundary:** the mock backend does not persist or read back SQL tables, so the test is *not* proof of server-side replay or idempotency. A successful HTTP response alone is insufficient.

## Existing separate server evidence

GitHub Actions already runs disposable PostgreSQL + real GoTrue + PostgREST integration suites and SQL ownership tests. Existing tests cover two devices/two accounts, revoked and wrong-device access, stale snapshots, concurrent revoke/ingest, claim transfer, and table-row preservation. In particular, the ingestion implementation replaces per-installation source/item/location rows on each accepted snapshot rather than incrementally adding counters; a repeated equal-timestamp request is still processed and can update timestamps. The acceptance rule is **no duplicate counts**, not literally zero database writes on a manual retry.

## Remaining C0c gate — DO NOT call it PASS

A full end-to-end **nonempty** real SQL/PostgREST staging acceptance still needs:

1. A verified isolated, non-production destination. An ephemeral local Postgres/GoTrue/PostgREST environment is preferable over paying for a second hosted Supabase project.
2. The identical public request, including explicit test account and installation ownership, fed through the transport and read back from the receiver. Verify source, item, \`questDrops\`, explicit/blank \`questIds\`, map and location mapping, and privacy fields.
3. Same-snapshot retry plus interrupted retry with before/after aggregate and row-count comparisons. Verify stale, wrong-account, revoked-device and malformed-body cases reject without extra writes.
4. A sanitized result report. Any real Windows owner step must be separately approved **after** the receiver is proved not to be the production Supabase project.

Do not click STATUS **Sync Now** or **Check status**, create a claim/transfer, turn on AutoSync, create a paid staging project, change the production DB or merge this test-only PR without the normal CI gate.
