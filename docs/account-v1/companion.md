# Account System V1 — Windows Companion (PR D, Companion 0.9.0-alpha)

Status: **IMPLEMENTED in PR D; CI verified when `Companion account auth (Windows)` passes on the final head; real-Windows UI acceptance PENDING; website redemption and end-to-end acceptance BLOCKED on PR E.** Account features are **off by default and refuse the private production project.** Nothing in this PR was applied to, or sent to, production.

Binding inputs: [architecture.md](architecture.md), [ownership-claim-protocol.md](ownership-claim-protocol.md) (§2 state machine, §4 contracts), [security.md](security.md), `web/src/lib/account/contracts.ts`, migration `0012` (PR C, unchanged).

## 1. What is implemented, tested, verified, blocked

| Capability | Implemented | CI (Windows) | Windows-verified by a human | Blocked on |
| --- | --- | --- | --- | --- |
| Fix of the anonymous identity-loss defect (classified failures, no implicit sign-up) | yes | yes | pending | — |
| Six-state session machine with explicit fault reasons | yes | yes | pending | — |
| `session.dat` / `legacy-owner.dat` DPAPI slots, atomic writes, crash recovery, kind marker | yes | yes (real DPAPI) | pending | — |
| Machine-wide session lock (named Mutex), real multi-process tests | yes | yes | pending | — |
| Registered sign-in (password grant + `GET /auth/v1/user` proof) | yes | yes (fake GoTrue) | pending | PR E: real GoTrue / staging |
| Registered sign-out (`scope=local`), pending-revocation retry | yes | yes | pending | PR E |
| Forget anonymous identity (confirmation, revocation) | yes | yes | pending | — |
| Ownership-aware per-installation routing, race protection, scoped caches | yes | yes | pending | PR E: real PostgREST/0012 |
| Claim **initiation**, display, copy, expiry, status checks | yes | yes | pending | PR E: redemption on the website |
| Feature gate (production OFF, local/staging only) | yes | yes | pending | owner staging project |
| ACCOUNT tab (WPF) | yes | compiled only | **pending** | — |
| Website `/account/link` redemption, pre-hijack protection UI | **no (PR E)** | — | — | PR E |
| Production activation | **no** | — | — | owner approval (`ProductionAccountAuthApproved` is a `const false`) |

Installation linking is **not** end-to-end complete in this PR: a displayed code cannot be redeemed until PR E ships the website step (destination account e-mail shown + fresh password confirmation, or an independently reviewed equivalent). Do not describe linking as complete before that.

## 2. Layout

| Path | Role |
| --- | --- |
| `companion/ForeverDB.Companion.Account/` | UI-free core: gate, vault, lock, GoTrue/RPC clients, session manager, router, sync coordinator, claim service, messages |
| `companion/ForeverDB.Companion/MainWindow.Account.cs`, `MainWindow.xaml` (ACCOUNT tab) | presentation only |
| `companion/ForeverDB.Companion/Services/SyncService.cs` | parses SavedVariables, always feeds the local Guildbook/map metadata, then calls the coordinator |
| `tests/companion-account/` (+ `Worker/`) | Windows regression suite; the worker is a second "Companion instance" process |
| `.github/workflows/companion-account-auth.yml`, `scripts/check-companion-account.py` | CI |

Removed: `SupabaseAuthService` and `SessionStore` (the unsafe broad `catch { Clear(); signUp(); }` and the non-atomic writer).

## 3. The identity-loss defect and its fix

0.8.x `GetAccessTokenAsync` wrapped refresh **and** `SessionStore.Save` in one bare `catch` that cleared the session and signed in as a **new** anonymous user, orphaning every installation (the ingest owner check rejects the new UID). Triggers: offline at token expiry, HTTP 5xx, timeout, antivirus `IOException` on save, unparsable data, rotation that succeeded remotely but failed to persist.

Now every outcome is classified (`GoTrueClient`, `AuthFailureKind`):

| Outcome | Classification | Credential | State |
| --- | --- | --- | --- |
| network failure, timeout, cancelled-by-timeout, HTTP 5xx/408 | `Transient` | untouched | unchanged, fault `NetworkUnavailable` |
| HTTP 429 | `RateLimited` | untouched | unchanged, fault `RateLimited` |
| 200 with an unparsable body, any other 4xx, any 400/401/403 without a GoTrue session-gone code | `Ambiguous` | untouched (fail closed) | unchanged |
| 400/401/403 with `error_code` ∈ {`refresh_token_not_found`, `refresh_token_already_used`, `session_not_found`, `session_expired`, `user_not_found`} or legacy `error=invalid_grant` + description `Invalid Refresh Token…` | `SessionRejected` (definitive) | kept, marker `rejected` | registered → `ReauthRequired`; anonymous → `AnonymousIdentityLost` |
| refresh OK but the file cannot be written | n/a | old file intact; new session kept **in memory** and persisted on the next call | fault `StorageFailure`, identity kept |
| definitive `already_used` but storage holds a different (newer) refresh token | re-read under the lock, retry once | adopted | unchanged |

`user_banned` is deliberately **not** definitive. The only place an anonymous account can be created is `AccountSessionManager.StartAnonymousAsync` (explicit user action; the repository check `scripts/check-companion-account.py` fails if another caller appears). A missing, corrupt or unreadable credential file never triggers sign-up.

## 4. State machine as implemented

States: `LoggedOut`, `Anonymous`, `AnonymousClaiming`, `Registered`, `ReauthRequired`, `AnonymousIdentityLost`. Reasons (`SessionFault`): `NetworkUnavailable`, `RateLimited`, `AuthRejected`, `LocalCredentialCorrupt`, `StorageFailure`, `LockTimeout`, `RegisteredVerificationFailed`, `FeatureDisabled`. Ownership outcomes (`InstallationOwnership`) cover *transferred* (`TransferredSignInRequired`) and *owned by a different account* (`OwnedByDifferentAccount`).

| Primary slot | Result |
| --- | --- |
| missing | `LoggedOut` (first use: the user must choose sign-in or anonymous; nothing is created) |
| readable, kind anonymous, active | `Anonymous` (`AnonymousClaiming` while a code is shown) |
| readable, anonymous, marked rejected | `AnonymousIdentityLost` |
| readable, kind registered, verified/unverified | `Registered` (the e-mail is shown only after the server confirmed it) |
| readable, registered, marked rejected / gate closed / server says not a confirmed account | `ReauthRequired` |
| unreadable, marker `registered` | `ReauthRequired` + `LocalCredentialCorrupt` |
| unreadable, marker `anonymous` | `AnonymousIdentityLost` + `LocalCredentialCorrupt` |
| unreadable, no marker | `LoggedOut` + `LocalCredentialCorrupt` (replacing it needs confirmation; the file is quarantined, never deleted) |
| I/O error (sharing violation) | previous state + `StorageFailure` (never evidence of corruption) |

A registered session never becomes an anonymous one: `StartAnonymousAsync` refuses with `AlreadySignedIn` for a registered credential, readable or not. Local SavedVariables parsing, local Guildbook and map metadata run **before** and independently of authentication.

## 5. Credential storage

* `%LOCALAPPDATA%\ForeverDB\session.dat` (primary) and `legacy-owner.dat` (preserved original anonymous owner), each base64 of a DPAPI `CurrentUser` blob — the 0.8.x format, so an existing session is read unchanged. `AuthSession` keeps the 0.8.x property names; the only addition is an optional `Email` display hint (ignored by 0.8.x).
* Marker `{name}.kind` (JSON, plaintext): `kind` (`anonymous`/`registered`) and `status` (`active`/`rejected`). It is a recovery **hint**, never identity: classification uses the JWT's `is_anonymous` claim when the blob is readable, and **registered wins every conflict** (a tampered marker or a stripped claim can never downgrade). 0.8.x sessions have no marker: the claim gives a provisional kind and a registered-looking one is only accepted after `GET /auth/v1/user` (and is refused outright while the feature gate is closed).
* Atomic write: protect → write a private `{name}.dat.{guid}.tmp` (`WriteThrough`, flushed) → `File.Replace` (previous credential kept as `.bak`) or `Move`. Plaintext is never written. On read: the main file is authoritative; a leftover complete temp of the **same user** with a later expiry is adopted (interrupted write); `.bak` is used only when the main file is unreadable; a stray file of another identity is never adopted. `Repair()` (under the lock) promotes and cleans up.
* Anonymous → registered sign-in (two ordered, individually atomic steps, each recoverable): (1) copy the anonymous credential to `legacy-owner.dat`; (2) write the registered session as `session.dat`. A crash between them leaves the same identity in both slots, which the next start recognises and cleans. Nothing is merged and the anonymous session is not revoked.
* Third slot `pending-revoke.dat` (an addition to the two slots of the brief): a registered session whose server-side sign-out could not be confirmed. It exists so the revocation can be retried instead of silently abandoning a live remote session. It is never used for anything else.
* `settings.json` never holds credentials, tokens, a claim code or any account switch; a test and a repository check enforce it.

## 6. Cross-process lock

`CrossProcessSessionGate`: an in-process `SemaphoreSlim` (async) in front of a named `Mutex` (`Global\ForeverDB.Account.Session.<hash of the vault directory>`). A Windows mutex is thread-owned and `await` hops threads, so each lease uses a **dedicated owner thread** that acquires, blocks on an event and releases the mutex; the caller only awaits. The wait polls in 50 ms slices (the multi-handle wait Windows offers is unsupported on Unix) so cancellation and the deadline are honoured promptly and no UI thread ever blocks. `AbandonedMutexException` is treated as "acquired, previous owner died" (callers always re-read and repair). Held for every creation, refresh, sign-in/out, forget and token acquisition; storage is re-read after the lock is taken.

## 7. Registered sign-in and sign-out

* Sign-in: `POST /auth/v1/token?grant_type=password` → `GET /auth/v1/user` with the returned token. Accepted only if the verified user is non-anonymous, has a valid id equal to the session's user id **and** to the token's `sub`, has an e-mail and a confirmed e-mail. Otherwise the new session is revoked (`scope=local`) and nothing is stored. The password is passed as a `char[]` encoded straight into a wiped buffer; the WPF `PasswordBox` is read through `SecurePassword`; nothing persists a password.
* Sign-out: `POST /auth/v1/logout?scope=local` only (the website session is unaffected; the legacy anonymous credential is never touched). Confirmed only on 200/204 or a definitive "session already gone". On failure the credential moves to `pending-revoke.dat`, the UI says the server could not confirm, and the retry is automatic/at the user's request; "stop retrying" needs a confirmation and documents the residual active-session risk.
* Forget anonymous identity: explicit confirmation, warning about permanent loss of sync for unclaimed installations, `scope=local` revocation; if revocation fails the credential is **kept** unless the user chooses a second, explicit "discard anyway". Never triggered by sign-in.

## 8. Ownership-aware synchronisation

`OwnershipRouter` asks the server (`fdb_installation_link_status`) in this order and picks exactly one credential: (1) the verified registered session (`owned` → use it); (2) the anonymous owner credential (primary in anonymous mode, otherwise the preserved legacy slot: `owned` → use it, `transferred` → pause and ask for registered sign-in, or *different account* if the registered session answered `unknown`); (3) `unknown` everywhere → `OwnerSelectionRequired` (no ingest). Network/5xx/429/malformed answers → `OwnershipUnavailable` (no ingest). A registered session in `ReauthRequired` pauses the account's installations while installations still owned by the legacy credential keep syncing. Only an explicit per-installation user choice (memory only) may establish ownership by a first ingest; if the server refuses (`OwnerMismatch`) the choice is dropped and nothing is retried with another credential.

`InstallationSyncCoordinator`: per-installation serialisation; snapshot cache keyed by `(installation, owner user id, identity generation)` (the old per-installation-only cache is gone); an identity change bumps the generation, clears the cache and the ownership cache, cancels in-flight work, and a result produced under an older generation is discarded (`StaleDiscarded`: no completion event, no UI update, nothing marked synced). If the identity moves while ownership is still being resolved (nothing uploaded yet) the sync is re-evaluated once under the new identity. 401/403/429/5xx/404/lock-timeout/`OwnerMismatch` are typed (`BlockReason`) and never retried automatically.

Production behaviour with the gate closed is the 0.8.x protocol exactly: the anonymous primary credential, no ownership RPC (it is not deployed there).

## 9. Claim initiation and status (PR D scope)

`ClaimService.StartClaimAsync` finds the anonymous owner credential (primary in anonymous mode, else legacy), refuses a registered token for `claim_start`, proves ownership with `fdb_installation_link_status`, then calls `fdb_account_claim_start` with exactly `{"p_installation_id":"…"}`. Replies are parsed against the approved contract (`ok:true` + uppercase 32-hex `code` + `expires_at`, or `ok:false` + `not_available`; extra or missing fields are discarded). The backend generates the code; the Companion never does. The code lives in a `ClaimOffer` in memory only (wiped on dismiss/expiry/identity change, redacted `ToString`), is shown as `FDB-XXXX-…` with a copy button (the clipboard is cleared after two minutes if it still holds the code), a 10-minute countdown, a single-use and privacy warning. Never logged, never in `settings.json`, never written to disk. No retry loop: an ambiguous network outcome is `OutcomeUnknown` and a new explicit request revokes any earlier code server-side. "Transferred" is reported only when `fdb_installation_link_status` says so; afterwards the previous anonymous identity is no longer used for that installation, the verified registered owner is used if signed in, otherwise sync pauses with a sign-in prompt, local data is untouched and ownership is never restored automatically.

Redemption (`/account/link`) and the pre-hijack protections are **PR E** and are not implemented here; there is no generic RPC proxy and no new endpoint.

## 10. Feature gate, environments, production separation

Account System V1 is enabled only by process environment variables read by `AccountFeatureGate` (never `settings.json`):

| Variable | Meaning |
| --- | --- |
| `FOREVERDB_ACCOUNT_MODE` | `local` or `staging`; empty/`disabled` (default), `production` and anything else keep the features **off** |
| `FOREVERDB_ACCOUNT_SUPABASE_URL` / `_KEY` | bare origin and publishable/anon key of the isolated project (secret and `service_role` keys refused) |
| `FOREVERDB_ACCOUNT_PROJECT_REF` | staging only: must equal the `<ref>` of `https://<ref>.supabase.co` (confirmed twice) |
| `FOREVERDB_ACCOUNT_WEB_URL` | optional; enables the "Create an account"/"Forgot password" buttons (fixed pages `/account/register`, `/account/forgot-password` on a validated https or loopback origin) |

`local` needs a loopback endpoint; `staging` an https `<ref>.supabase.co` that is **not** `klxhikdlfwgxurdyexdi` (the production reference is also refused anywhere in the URL or key). `ProductionAccountAuthApproved` is a `const false`: flipping it is a reviewed code change after owner approval. With the gate open, Auth, RPC **and** data traffic (Search, diagnostics) use the one validated project, credentials live in `%LOCALAPPDATA%\ForeverDB\account-test\<mode>-<ref|port>\` (never mixed with production files), and a `ProductionHostGuardHandler` refuses any request mentioning the production reference even if configuration were wrong. With the gate closed, registered sign-in, sign-out, claims and link-status are unreachable (`FeatureDisabled`, no request is made) and a registered-looking credential is `ReauthRequired` without a network call. The production anonymous protocol and stored credentials are not changed; no service-role or admin secret exists in the Companion.

## 11. Mapping of the 30 mandatory scenarios to tests

Suite: `tests/companion-account` (xUnit; real DPAPI on Windows, a non-plaintext fake protector elsewhere so the logic can be reviewed on any OS).

| # | Scenario | Tests |
| --- | --- | --- |
| 1 | upgrade an existing 0.8.2 anonymous session | `Upgrade_from_082_keeps_the_anonymous_identity_without_any_network_call`, `Upgrade_from_082_with_expired_token_refreshes_the_same_identity_and_persists_rotation`, `Real_DPAPI_082_blob_format_is_read_by_the_new_slot` |
| 2 | legacy format without marker | `Legacy_session_without_marker_is_classified_from_the_jwt_claim`, `Legacy_session_that_looks_registered_is_not_trusted_without_server_confirmation`, `Tampered_marker_cannot_downgrade_a_registered_identity` |
| 3 | offline refresh preserves identity | `Offline_startup_never_replaces_the_original_anonymous_owner` |
| 4 | 5xx and timeout preserve the credential | `Server_errors_and_ambiguous_rejections_preserve_the_credential` (8 statuses), `Request_timeout_preserves_the_credential`, `Unparsable_success_reply_…` |
| 5 | write failure keeps the previous credential | `File_write_failure_keeps_previous_credential_…`, `Failed_persistence_after_remote_rotation_does_not_lose_the_identity` |
| 6 | corrupt registered credential → `ReauthRequired` | `Corrupt_registered_credential_requires_reauth_and_never_creates_an_anonymous_user` |
| 7 | definitive registered rejection never signs up | `Definitive_registered_refresh_rejection_is_reauth_and_never_signs_up_anonymously` |
| 8 | definitive anonymous rejection → `AnonymousIdentityLost` | `Definitive_anonymous_rejection_is_identity_lost_…` (4 codes), `Corrupt_anonymous_credential_is_identity_lost_…` |
| 9 | concurrent refresh from two processes | `CrossProcessTests.Concurrent_refresh_from_separate_processes_rotates_once_and_keeps_one_identity` (4 real processes), negative control without the gate, `Concurrent_registered_sign_in_and_refresh_…`, abandoned-lock and exclusion tests |
| 10 | rotation persisted | `Upgrade_…persists_rotation`, process test (final disk token == every worker's) |
| 11 | login preserves legacy credentials | `Registered_login_preserves_the_original_anonymous_credentials_in_the_legacy_slot` |
| 12 | logout leaves the legacy credential | `Registered_logout_uses_scope_local_only_and_leaves_the_legacy_credential_and_website_session_intact` |
| 13 | logout uses only `scope=local` | same + `Failed_server_revocation_…` + `Forgetting_the_legacy_identity_…` (every logout request asserted) |
| 14 | switching invalidates caches | `Identity_switches_raise_a_new_generation_…`, `Snapshot_cache_is_scoped_by_owner_and_identity_generation` |
| 15 | stale in-flight response cannot repopulate | `Logout_during_an_active_sync_…`, `Login_during_an_active_sync_…`, `Stale_sync_result_does_not_raise_completion_…` |
| 16 | anonymous-owned installation uses only the anonymous token | `Anonymous_owned_installation_syncs_only_with_the_anonymous_token` |
| 17 | registered-owned installation uses only the registered token | `Registered_owned_installation_syncs_only_with_the_registered_token` |
| 18 | unknown ownership: no adoption, no fallback | `Unknown_ownership_never_triggers_…`, `Explicit_owner_choice_…`, `Ownership_lookup_failure_fails_closed_…`, `Different_registered_account_is_reported_not_adopted` |
| 19 | claim uses the anonymous owner JWT and approved body | `Claim_start_uses_the_anonymous_owner_jwt_and_the_approved_request_body`, `A_registered_only_session_can_not_start_a_claim_…` |
| 20 | code format and expiry | `Code_format_and_expiry_follow_the_contract`, `Distant_expiry_is_clamped_…`, `Malformed_claim_replies_…` (8 shapes) |
| 21 | transferred only after server confirmation | `Transfer_is_reported_only_after_the_server_confirms_it` |
| 22 | sync pauses during ownership transition | `Transferred_installation_pauses_sync_when_no_registered_session_is_available`, `After_transfer_without_a_registered_session_…` |
| 23 | failed claim does not mutate local data | `Failed_claim_does_not_delete_or_mutate_local_installation_data_or_credentials` |
| 24 | legacy removal needs confirmation, revocation handled | `Forgetting_the_legacy_identity_needs_explicit_confirmation_…`, `Failed_revocation_of_the_legacy_identity_keeps_…` |
| 25 | no secrets/plaintext codes in settings or logs | `SecretHygieneTests` (6), `Claim_code_is_never_written_to_disk_logs_or_results`, repository check |
| 26 | manual Sync / AutoSync | `CompanionRegressionTests.Manual_sync_…`, `Startup_sync_…`, plus the existing health tests in the workflow |
| 27 | Search / Guildbook / cache | `Local_guildbook_and_map_metadata_work_…`, `Search_style_read_tokens_…`, `Search_request_epoch_…`, existing Guildbook/Search/Map suites in the workflow |
| 28 | multiple installations, different ownership | `Multiple_installations_with_different_ownership_each_use_their_own_credential` |
| 29 | recovery after a crash during atomic replacement | `Crash_during_replacement_recovers_a_valid_credential_for_every_phase`, `Newer_leftover_temp_…` |
| 30 | no account request reaches the production project | `Full_staging_flow_never_sends_a_request_to_the_production_project`, `Guard_handler_blocks_the_production_host_when_enforced`, gate matrix (≈35 cases), `Staging_credentials_live_in_an_isolated_directory_…` |

## 12. Migration from Companion 0.8.x and recovery

Upgrade: install 0.9.0-alpha over 0.8.x. `session.dat` is read as is; the anonymous identity, its installations and its Guildbook data are untouched; no sign-up, no prompt, no network call is needed to keep working. A marker is written on the next credential write. Sign-in and claim features stay hidden/disabled until the owner enables a test project.

**If the local anonymous credential is damaged or the server no longer accepts it** (Account tab shows *Anonymous identity lost*):

1. Nothing was replaced, deleted or signed up automatically. Local collection, Search through another identity and the Guildbook still work; installations owned by the lost identity cannot upload from this computer.
2. If a copy of `%LOCALAPPDATA%\ForeverDB\session.dat` (and `session.dat.bak`, `legacy-owner.dat`) from before the problem exists (backup/previous Windows profile for the *same* Windows user), restore it with the Companion closed; DPAPI blobs only open for the same Windows user.
3. Otherwise choose **Start a new anonymous identity…** and confirm. The damaged file is kept next to it as `session.dat.lost-<time>`. Installations owned by the lost identity remain readable by their old owner only; to re-attach history to an account, use the owner-approved operator procedure from the [0012 recovery document](0012-deployment-and-recovery.md) (an audited restore, not a client feature).
4. If the lost identity belonged to an account, sign in again instead (*Sign-in required again*): no anonymous identity is created.

## 13. Pending real-Windows acceptance (owner)

Not claimed as passed by CI. Run on a Windows machine against the owner's isolated staging project (see `acceptance-and-owner-actions.md`), with `FOREVERDB_ACCOUNT_MODE=staging` and the URL/key/ref variables set:

| # | Scenario | Result |
| --- | --- | --- |
| W1 | Upgrade a real 0.8.2 install over itself: starts, syncs, same identity, no prompt | pending |
| W2 | Start offline with an expired token; reconnect; identity unchanged, no new user in Auth | pending |
| W3 | First run without a session: the choice is shown, nothing is created until chosen | pending |
| W4 | Sign in with a confirmed website account; e-mail shown; legacy identity preserved; installation still syncs under it | pending |
| W5 | Sign out; website session still signed in; legacy still syncs | pending |
| W6 | Two Companion windows/processes started together; one identity, no re-auth | pending |
| W7 | Start a claim; code shown once; copy; expiry; hide; no code in `%LOCALAPPDATA%\ForeverDB` | pending |
| W8 | (needs PR E) redeem on the website; Companion shows *transferred*, asks to sign in, then syncs with the account | blocked |
| W9 | Visual review of the ACCOUNT tab in the dark theme at 100/150 % scaling | pending |
| W10 | Gate closed (no variables): ACCOUNT tab shows features off; anonymous sync unchanged; no Auth request except the 0.8.x ones | pending |

## 14. Owner actions and PR E dependencies

* Provide the isolated staging Supabase project, apply `0010`/`0012`/`0013` **there only**, and the Windows acceptance session (see [acceptance-and-owner-actions.md](acceptance-and-owner-actions.md)).
* Auth settings that would break the Companion must stay off (project-wide CAPTCHA, single session per user, session time-box, short inactivity timeout); staging acceptance AT-4 runs the Companion under the final settings.
* PR E: `/account/link` redemption with the pre-hijack protection, the cross-component run, the Windows evidence, and the decision whether account features may ever be enabled for production (flipping `ProductionAccountAuthApproved`).

## 15. Residual risks and deliberate deviations

* The third `pending-revoke.dat` slot is an addition to the two slots in the brief (justified in §5).
* After a remote rotation whose local write keeps failing **and** the process then dies, the stored refresh token is spent; GoTrue's reuse handling decides the outcome (usually `AnonymousIdentityLost`/`ReauthRequired`, never a silent new identity). Mitigations: three bounded write retries, in-memory continuation, retry on the next call.
* An active stolen anonymous bearer can still start a claim (residual risk already accepted in the protocol §6).
* `AnonymousIdentityLost` after a rejection discovered at an unusual moment bumps the identity generation, which cancels in-flight work; this is intentional.
* The clipboard cannot be guaranteed clear if another program overwrote or monitors it.
* WPF visuals are verified for compilation by CI only until W9.
