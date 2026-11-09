# ADR-018 — Ownerless public observation ingestion

- Status: implemented in draft change; production migration and Windows acceptance pending
- Date: 2026-11-09
- Supersedes: the user-facing installation-owner requirement in ADR-017 for public observation writes
- Does not supersede: authenticated personal account features, account device revocation, DPAPI, rate limits, or the Guildbook local-only boundary

## Context

The Companion's ownership router called `fdb_installation_link_status` before every public upload. Unknown, transferred, unavailable, or conflicting ownership blocked collection even though the payload contains public WoW observations. Account switching could also strand an installation behind a human owner choice. The website exposed installation lists, claim redemption, and owner-oriented Account UI for that same upload path.

## Decision

A Companion installation does not need a website account owner, claim, transfer, or reassertion to upload public observations. A stable technical Auth identity remains and is stored with DPAPI on Windows. The Companion creates an anonymous technical session when needed, independently of user sign-in. Auto Sync remains OFF unless the user enabled it and that choice remains persisted.

Migration `0019_technical_installation_ingest.sql` adds the private server-owned `installation_upload_identities` mapping. The server validates a live GoTrue session and maps `(installation_id, Auth UID)` to the legacy row key needed by the unchanged observation writer. A genuinely new installation can be bound only by a live anonymous Auth identity while no server installation row exists. Existing rows can never be claimed from their ID alone.

The migration carries forward authenticated credentials already proven by existing server data: the current historical installation identity, the original anonymous identity recorded by a completed claim, and active enrolled-device identities. It preserves installations, observations and Guildbook rows. A trigger updates only the internal legacy writer key after an old client completes a claim; it does not grant any new Auth identity.

The device enrollment RPC keeps ticket validation, live-session validation, secret hashing, account standing checks, device limits, replacement, audit, rotation and revocation. For an existing installation it now additionally requires the same anonymous technical identity to have a server-created upload mapping. Installation owner metadata is not used to authorize that enrollment.

The website removes owner selection/list and claim routes and UI. Login/logout, private account authentication and the account device management page remain. Historical database claim RPCs remain during the compatibility window because deployed legacy clients and existing recovery procedures may still call them; the website no longer exposes them.

## Data and privacy boundaries

- Public ingestion still uses the explicit `fdb_public_snapshot` projection from migration 0018. Guild names, rosters, professions, and private character details are neither sent by the current Companion nor stored through the migrated ingestion path.
- The caller's Auth UID and client-supplied installation ID are not sufficient by themselves: the server requires a valid live session and an installation-scoped mapping, except for the narrowly defined first upload of a fresh anonymous identity.
- Supabase service-role credentials are not present in Companion or browser code.
- DPAPI-protected local credentials, account-scoped Guildbook cache isolation, A→B→A restoration and the 0018 Guildbook server kill switch are unchanged.

## Compatibility and limitations

Existing owner and claim records are retained. Anonymous credentials from completed claims and live device credentials are backfilled. A historical installation with no server-proven credential fails closed and needs an operator-reviewed recovery path; no first-claimer fallback is introduced. The migration does not delete history or apply itself to production.

A new device activation ticket is accepted only after the Companion has made its first authenticated public sync for that installation. This gives the server an installation-specific credential proof before issuing a revocable device credential.

The migration preserves old claim RPCs as a compatibility measure. Removing them requires a separate audit of deployed client versions, rollback/recovery tooling and production function grants.

## Verification and deferred acceptance

Automated regression coverage includes fresh anonymous ingestion, migrated anonymous and device identities, invalid Auth identities, forged installation IDs, Guildbook non-persistence, device activation proof, website route retirement and Companion routing/session behavior. The database suite uses disposable PostgreSQL + GoTrue fixtures; CI is the source of truth when local GoTrue/PostgreSQL are unavailable.

Windows W5/W6 acceptance is deferred. No manual WoW/Windows result is implied by automated tests. The precise owner matrix is in [ownerless-ingestion-acceptance.md](ownerless-ingestion-acceptance.md).
