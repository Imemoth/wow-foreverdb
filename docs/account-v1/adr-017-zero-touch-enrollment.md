# ADR-017 — Zero-touch enrollment and registered device synchronization

Status: **proposed, implemented on PR #56 (draft). Not applied to any live database. Not enabled in any release build.**
Supersedes nothing; extends ADR-016 (auth-only configuration boundary) and the ownership-claim protocol (migration 0012).
Companion documents: [zero-touch-enrollment-registered-sync.md](zero-touch-enrollment-registered-sync.md) (product contract),
[security.md](security.md), [ownership-claim-protocol.md](ownership-claim-protocol.md).

## 1. Context and the problem to solve

A registered website user must be able to install the Windows Companion on any number of computers and have **each installation
bound to the account without signing in again and without typing a code**, and synchronize snapshots (manual first) into data the
website's Private Guildbook can read. Anonymous installations keep working; an anonymous installation can later be transferred
with the existing one-time claim.

Facts established by reading the current code (not assumptions):

| Fact | Where | Consequence |
| --- | --- | --- |
| Ingest authorization is `installations.owner_user_id = auth.uid()` evaluated inside `private.foreverdb_ingest_snapshot_impl_v1`. The ingest takes the per-installation advisory lock `hashtextextended(installation, 0)`. | 0003, 0005, 0009 | A *device* can only write an account's installation if the caller's `auth.uid()` **is** the owner. A device identity is not the account's `auth.uid()`; we must bridge them without weakening the check for anyone else. |
| The Companion already creates an *anonymous* Supabase Auth user (a GoTrue identity whose refresh token lives in a DPAPI file). Anonymous users have role `authenticated`. | `AccountSessionManager`, 0.8.x `SupabaseAuthService` | A device can have a cryptographically strong, individually revocable Auth identity **without any new Auth feature**. |
| Account RPCs run a *live-session guard* (`private.fdb_caller` and variants): the JWT's `session_id` must exist in `auth.sessions`, be unexpired, own an unrevoked refresh token, and the user must not be banned or deleted. | 0012 | We reuse the exact guards. A device RPC is called by an **anonymous** live session; account RPCs by a **registered** live session. |
| PostgREST can only call database functions, authenticated by a Supabase JWT. There is no ECDSA/Ed25519 *verify* primitive in PostgreSQL/pgcrypto. | PostgreSQL 16, pgcrypto | Challenge/response proof of possession of a *device private key* cannot be verified inside a SQL function. See §6. |
| The website is a Next.js app with a server-side BFF that holds only the publishable key and the *user's own* access token. No service credential exists in the website, on purpose. | ADR-016, `rpc-client.ts` | Ticket issuance must run as the signed-in user (a registered-caller RPC), never through a privileged website key. |

## 2. Decision

**Use the existing Supabase Auth + PostgREST + SECURITY DEFINER RPC architecture. Do not introduce a service-role backend or an
Edge Function in V1.** Device authentication is the composition of two independent factors, both verified inside the database on
every call, bound to one installation:

1. **Device Auth identity D** — the installation's own anonymous Supabase Auth user (live session, DPAPI-held refresh token). `D`
   is *never* the account's `auth.uid()` and is never granted any account privilege; it is only a *principal key* in the device
   registry.
2. **Device credential** — a 256-bit random secret created by the server at enrollment, returned once, stored by the Companion under
   DPAPI, stored by the database only as `sha256`. Rotated on a schedule with reuse detection (§7).

Account-to-installation binding is a **row in a private device registry** (`private.devices`), created in one transaction that
consumes an enrollment ticket and that reserves (or re-binds) the installation **for the ticket's account**. `installations.owner_user_id`
becomes (or already is) the *account* UID; the device function performs ingest by running the unchanged ingest implementation with the
account identity set for that one statement (§8).

Alternatives considered:

| Option | Verdict | Reason |
| --- | --- | --- |
| A. Put a registered user's access/refresh token into the download | **Rejected** (spec) | A leaked ZIP would be a full account takeover, including password-confirmed web actions' preconditions and Guildbook read. |
| B. Edge Function / trusted backend holding `service_role`, verifying an ECDSA device signature | **Deferred, recommended upgrade** | Gives real proof of possession (§6) and a place for IP-aware abuse controls, but adds a second deployment, a privileged secret, a larger blast radius and can't be exercised here (no Deno/Supabase runtime). The V1 data model (`private.devices`) is the same table such a backend would use, so the upgrade is additive. |
| **C. Anonymous device identity + server-generated device secret verified in SECURITY DEFINER RPCs (chosen)** | **Selected** | Uses only reviewed primitives (live-session guards, hash-only secrets, advisory locks), no new privileged secret anywhere, fully testable against real PostgreSQL + real GoTrue in CI. |
| D. Make the device a registered *sub-account* | Rejected | Would need one Auth user per device with passwords/emails; creates a second human-account namespace. |

## 3. Enrollment ticket lifecycle

| Stage | Rule (all enforced in SQL, `0014`) |
| --- | --- |
| **Issue** | `fdb_account_enrollment_ticket_issue(label)` — caller must be a *registered, confirmed, live* account session (the user's own JWT forwarded by the BFF). Ticket = `fdba1_` + 32 bytes from `gen_random_bytes` (256 bit), base64url. Only `sha256(ticket)` is stored; the raw value is returned **once** in the RPC reply and is never written to a table, audit row, log or URL. |
| **Validity** | `expires_at = clock_timestamp() + interval '168 hours'` (7 days, fixed; no client input). Expiry is evaluated with `clock_timestamp()` at redemption. |
| **Caps** | ≤ 5 pending tickets per account, ≤ 10 issued per account per rolling hour, ≤ 10 active devices per account (and the existing 50-installation account cap). Exceeding returns a result, not an exception, so the counters persist. |
| **Consume** | `fdb_device_enroll(ticket, installation_id, label)` — one transaction: ticket row `FOR UPDATE`, status must be `pending` and unexpired, account re-validated *at redemption time* (registered, confirmed, not banned/deleted), per-installation advisory lock (same key as ingest and claims), installation eligibility (§5), device row inserted, ticket set `consumed` with `consumed_device_id`. **Exactly one concurrent redeemer wins**; the others block on the row lock and then see `consumed`. |
| **Revoke** | `fdb_account_enrollment_ticket_revoke(ticket_id)` by the issuing account while pending. Server-side only; the downloaded file becomes inert. Revoking a ticket never touches an already enrolled device. |
| **Expire** | Time-based, no job needed for correctness. `private.fdb_prune_enrollment()` (operator-run) deletes consumed/expired/revoked tickets older than 90 days; audit rows are retained. |
| **Replacement** | The signed-in website can always issue a new ticket (cap permitting) — "Get a new activation file" — without reinstalling the Companion. It never changes the owner of anything by itself. |

The raw ticket is bearer. It is delivered as a small activation file (`foreverdb-activation.fdbact`, JSON) via a `POST` that answers
`Content-Disposition: attachment`, `Cache-Control: private, no-store`; it never appears in a URL, a query string, a response to a
`GET`, JavaScript memory, analytics or a log line. The public binaries stay **account-neutral and reproducible**: no per-user build.

## 4. Threat: copying an unused ticket (acknowledged, not solved by single use)

Single use does **not** stop an attacker who obtains the activation file *before* the legitimate installer redeems it and redeems it
first: the attacker's Companion would be enrolled as a device of the victim's account for that installation. A client-generated key
created at redemption cannot tell the two apart; there is no secret shared between the website and the legitimate machine that the
attacker lacks. The window is up to 168 hours (until redeemed, revoked or expired). We therefore treat this as a **residual, accepted,
monitored risk** and add mitigations that bound its impact, none of which pretend to eliminate it:

| Mitigation | Status |
| --- | --- |
| Device scope: a stolen-then-redeemed ticket yields **ingest for one fresh installation only** — no Guildbook read, no account management, no other installation, no web session, no password change. The attacker can add junk observations to a *new* installation row of the victim and nothing else. | implemented |
| The enrolled device is visible immediately in Account → Devices with creation time, label and last-seen; one click revokes it; revocation takes effect on the next call (no cached-token window, §9). | RPCs + web UI implemented |
| Pending tickets are visible and individually revocable; at most 5 are pending; a user who suspects theft revokes the ticket before use. | implemented |
| Short exposure by habit: the UI tells the user to install right away and shows the expiry; the Companion deletes the activation file after redemption. | implemented |
| Per-account and per-identity budgets on redemption failures; every issue / redeem / refusal is audited with non-secret correlation ids. | implemented |
| Issue-time device binding or **exceptional re-approval** (device lands as `pending_approval` until the signed-in website approves it, optionally required by an account setting). | **not implemented**; the `devices.status` enum reserves `pending_approval`. Recommended before any public release. |
| Notification on new device (e-mail/web banner). | web "recently activated" list implemented; e-mail **not** implemented (needs a mail transport the project does not have). |
| Shorter default lifetime, or "install within N hours" after first download. | Spec fixes 168 h; reducing it is a one-constant change if the owner decides. |

If the owner requires theft resistance beyond this, the only real answers are re-approval, or a hardware-bound attestation (not
available on a generic Windows install). This ADR does not claim either exists.

## 5. Account ↔ installation ownership binding (never from an ID alone)

`fdb_device_enroll` evaluates `installation_id` against `public.installations` **under the per-installation advisory lock** and returns
one of the following; a guessed ID is never sufficient:

| State of `installation_id` | Result |
| --- | --- |
| Does not exist | **Reserved** for the ticket's account: `installations` row inserted with `owner_user_id = account`, `schema_version = 0` (no snapshot yet). A later anonymous ingest of the same ID is refused by the existing owner check. |
| Exists, `owner_user_id = account` (e.g. after the claim, or a revoked/lost device being replaced), **no active device** | Allowed: a new device is bound. No ownership change. This is how a *claimed* historical installation gets registered sync without any Companion login. |
| Exists, `owner_user_id = account`, an active device exists with the **same** Auth identity D | Allowed: the credential is replaced (lost/damaged local credential). |
| Exists, `owner_user_id = account`, an active device exists with a **different** identity | `installation_bound` (the owner must revoke the other device first — a cloned `SavedVariables` on a second PC cannot take over silently). |
| Exists, any other owner (other account, anonymous, null/legacy) | `installation_conflict`. **Never** transferred here; the anonymous path is the existing one-time claim. |

One account may own many installations; one installation has exactly one owner (existing PK/column) and at most one *active*
device (partial unique index). One Auth identity D has at most one active device (partial unique index). `private.account_installations`
(the claim link table) is not modified.

## 6. Proof of possession — what is and is not provided

* **Provided:** possession of (a) the live anonymous session of D (refresh token under DPAPI, individually revocable in Auth) **and** (b)
  the device secret (DPAPI). Both are verified server-side per call; the secret is compared as `sha256`; the call fails closed if either
  is missing, if D is not the registered principal of that device, or if the device is not active.
* **Not provided:** cryptographic proof of possession of a private key bound to the ticket redemption (the spec's "device public key"
  challenge). It is **not possible in SQL** (no signature verification), and an unverified stored public key would be security theatre,
  so none is stored. The Edge-Function upgrade (Option B) adds it: the Companion generates a DPAPI-protected ECDSA P-256 key, the ticket
  redemption signs a server nonce, and the same `private.devices` row gains a `public_key` column.
* The credential is a bearer for the authenticated D session; TLS plus DPAPI at rest plus rotation (§7) is the protection. A malware
  process running as the same Windows user can read what the Companion can read — true of every credential the Companion holds today.

## 7. Credential rotation and reuse detection

`devices` keeps `credential_hash` (current), `next_credential_hash` (issued by `fdb_device_rotate_credential`, valid alongside the current
one until first used) and `retired_hash`/`retired_at` (the previous credential after promotion). Presenting the *next* credential promotes it
and retires the old one. Presenting a *retired* credential within 120 s is refused without penalty (a racing in-flight request of the same
Companion); later it is **reuse of a superseded credential** ⇒ the device is revoked with reason `credential_reuse` and audited — a copied
credential cannot silently run in parallel. The Companion rotates when the server says `needs_rotation` (credential older than 30 days)
and persists the new secret *before* using it (current stays valid until the new one is first used, so a crash loses nothing).

## 8. RPC surface, SECURITY DEFINER and RLS boundaries

All objects are in migration `0014_zero_touch_enrollment.sql`; forward-only; no existing function, table, row or privilege is changed
(asserted by the same before/after `prosrc`+ACL fingerprint as 0012). New private tables (`devices`, `enrollment_tickets`, `device_audit`)
have RLS **enabled with no policy** and every privilege revoked from `public, anon, authenticated, service_role`; the `private` schema
stays unreachable for client roles. `search_path` is `''` on every function; each function is explicitly revoked and then granted to
`authenticated` only.

| Function | Caller guard | Purpose |
| --- | --- | --- |
| `fdb_account_enrollment_ticket_issue(text)` | registered, live | Issue ticket (raw value returned once). |
| `fdb_account_enrollment_tickets()` | registered, live | List the account's recent tickets (ids/status/expiry; never a secret). |
| `fdb_account_enrollment_ticket_revoke(uuid)` | registered, live | Revoke a pending ticket of this account. |
| `fdb_account_devices()` | registered, live | List the account's devices. |
| `fdb_account_device_revoke(uuid)` | registered, live | Revoke one device (immediate). |
| `fdb_device_enroll(text,text,text)` | **anonymous**, live | Redeem a ticket (the "exchange"). |
| `fdb_device_status(text)` | anonymous, live | Device introspection (`active`, `revoked`, `ownership_conflict`, `account_unavailable`, `unknown`; `needs_rotation`). |
| `fdb_device_ingest(text,jsonb)` | anonymous, live | Authorized snapshot ingest for the device's one installation. |
| `fdb_device_rotate_credential(text)` | anonymous, live | Credential rotation. |

`fdb_device_ingest` order: guard (live anonymous session) → shared per-uid + global **ingest budgets** charged to *D* (the existing
`foreverdb_api_gate` scope and size/shape bounds, repeated) → advisory lock on the installation → device row `FOR UPDATE` and credential
check → **re-check, under the lock, that the account is still a confirmed registered user and that `installations.owner_user_id` still
equals the device's account (stale ownership ⇒ refusal and `ownership_conflict`)** → set the account identity for exactly the ingest
statement (`set_config('request.jwt.claims', …, true)` + legacy `request.jwt.claim.sub`, restored afterwards) and call the **unchanged**
`private.foreverdb_ingest_snapshot_impl_v1` → write `last_seen_at`. The identity swap is the single piece of cleverness in the design;
it is confined to a SECURITY DEFINER function that has already proven, on this transaction, that the caller is the one active device
authorized for that installation, and the impl performs its own owner check against the account UID. If a platform change ever makes
`auth.uid()` stop reading `request.jwt.claims`, the failure mode is **closed** (the impl's owner check fails), and the integration
suite asserts the real behaviour.

Account functions never accept an installation or device id as *authority*: `fdb_account_device_revoke` revokes only a row whose
`account_uid` equals the registered caller; non-owned and non-existent ids are indistinguishable.

## 9. Race, replay and revocation

* **Concurrency:** one lock order everywhere: guard → budgets → installation advisory lock (`hashtextextended(id, 0)`, shared with
  ingest and claims) → caller session `FOR SHARE` → ticket/device rows `FOR UPDATE` → account advisory lock `fdb-account:<uid>` (cap
  accounting). Concurrent redemption of one ticket, of two tickets for one installation, ingest vs revoke, and revoke vs enroll are
  serialised by those locks; the suite runs them as real parallel transactions.
* **Replay:** a consumed/revoked/expired ticket yields a stable refusal and an audit row. Replaying a captured *request* needs the same
  ticket **and** a live D session; replaying a captured device *ingest* needs D's live token **and** the current/next secret.
* **Revocation:** revoking a device sets `status = 'revoked'` in the registry. Every device call re-reads the row under lock, so
  revocation is effective on the next call even though the D access token (≤ 1 h) is still cryptographically valid. Revoking D in Auth
  (or deleting the user) additionally fails the live-session guard. Web sign-out does **not** revoke devices (spec A3).
* **Recovery:** a revoked or lost device is replaced by issuing a new ticket on the website and activating again; because the
  installation is already owned by the account and has no active device, the installation, its history and its Guildbook are preserved.

## 10. Rate limits, abuse monitoring and audit

* Existing `foreverdb_take_budget` buckets (60/300 s windows): `enroll:uid`, `enroll:global`, `device:uid`, `ticket_issue:uid`; ingest uses the
  existing ingest buckets. Counters persist because business failures are returned, not raised; only authentication (PT401), authorization
  (PT403) and budget exhaustion (PT429) raise.
* Table-based limits for hour-scale caps (tickets per hour, pending tickets, active devices).
* `private.device_audit` (append-only by privilege, RLS on, no client privileges): `ticket_issued`, `ticket_revoked`, `enroll_succeeded`,
  `enroll_refused` (with a non-secret reason code), `device_revoked`, `credential_rotated`, `credential_reuse`, `ingest_refused`. Rows carry
  account uid, device id, ticket id, installation id and a short reason; **never** a ticket, secret, token, e-mail or IP. Operators monitor
  `enroll_refused` and `credential_reuse` rates; the owner runbook lists the queries.
* GDPR/logging: only pseudonymous UUIDs; no IPs are stored by these tables; the website never logs bodies of the issue route.

## 11. What changes for existing behaviour (and what must not)

| Concern | Guarantee | Verified by |
| --- | --- | --- |
| Anonymous ingest | `ingest_foreverdb_snapshot_auth` untouched (`prosrc` + ACL hash). | SQL suite 10 |
| Claimed installations | Unchanged; they additionally get a device through §5 row 2. Old anonymous upload for a claimed ID stays denied by the existing owner check. | suite 03/07 |
| Public/read endpoints | Unchanged. | suite 08 (existing regressions) |
| History | No UPDATE/DELETE of an existing row except `installations.last_seen_at/…` via the unchanged ingest. Enrollment only INSERTs. | suite 05 |
| Production flags | New Companion capability is behind `ZeroTouchEnrollmentApproved = false` (compile-time); only isolated local/staging endpoints can use it. No temporary pilot approval is added or flipped by this PR. | Companion tests, release gate script |

## 12. Residual risks and open decisions (owner)

1. First-redeemer theft of an unused ticket (§4). Decide whether to require re-approval before public release.
2. No proof of possession of a device private key (§6). Decide whether Option B (Edge Function) is wanted before release.
3. Anonymous sign-up abuse on the shared Auth project (existing threat A24) also applies to device identities; enrollment itself requires a
   valid ticket, so abusing it does not yield ownership, only Auth users.
4. The identity swap in `fdb_device_ingest` (§8) depends on `auth.uid()` reading `request.jwt.claims` (true for the hosted Supabase platform
   today and for the CI stack); re-verify on any platform upgrade.
5. The public download page still has no signed binary. The activation file is independent of how binaries are hosted; composing a ZIP
   (binary + activation file) is a later website change that does not alter the protocol.
