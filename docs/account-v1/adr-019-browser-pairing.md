# ADR-019 — Database-authoritative one-click browser pairing

**Status:** Accepted for Stage A on 2026-10-16; implementation and production activation remain unapproved.
**Extends:** the Account V1 ownership protocol (migration 0012) and device registry (migration 0014).
**Migration:** 0016. PR #58 reserves 0015 for `azerdex_welcome_outbox`.

## Context

Account V1 currently supports a downloaded `.fdbact` bearer ticket. That path proved device registration and registered-device ingest,
but it does not provide the intended public journey. The user must be able to click **Connect Account** in the Companion, approve the
named computer in the system browser, and have the Companion finish automatically while keeping anonymous use and the original
installation history intact.

The current system already has two useful identities. The Companion owns an anonymous Supabase Auth session protected by DPAPI, and a
registered user owns a separate web Auth session held behind the Account BFF. `public.installations.owner_user_id` is authoritative,
and `private.devices` bridges an installation-scoped anonymous device principal to the registered owner for ingestion.

## Decision

Add a database-authoritative, RFC 8628-inspired pairing session which coordinates those existing identities. The initiating Companion
uses its exact anonymous UID and GoTrue session. The browser uses the existing registered Account session. They never exchange Auth
tokens. The database serializes approval and redemption using the same installation advisory lock used by ingest, claim transfer and
ticket enrollment.

The Companion generates and DPAPI-protects the pairing locator, polling secret and proposed device credential before start. Only
verifiers for the two secrets are committed to the pairing row. Start is idempotent by locator. Approval chooses a registered account
but has no ownership side effect. A poll carrying the polling secret and the exact initiating session performs ownership transfer and
device registration atomically. The device credential never travels through the browser or pairing poll response.

The Next.js application remains an unprivileged BFF. Its five pairing API handlers are fixed adapters to allow-listed RPCs using the
publishable key and the caller's own token. No service role, database password or generic RPC forwarding is added.

## Alternatives

### Service-role web or Edge backend

Rejected for V1. It could generate or escrow a recoverable server secret, but it creates a new high-privilege boundary and would need
new operational controls. The client-precommitted credential avoids the lost-response problem without that privilege.

### Put the existing activation ticket in the browser flow

Rejected. A ticket is an account-bound enrollment bearer and is not bound to the initiating Companion session. Passing it through the
browser would increase URL, history and logging exposure and retain the first-redeemer risk which pairing is intended to remove.

### Browser directly returns a device credential to the Companion

Rejected. It would make the browser an unnecessary secret courier, complicate account switching and crash recovery, and expose the
credential to web JavaScript or response handling.

## Consequences

- Pairing introduces one private table, one private config row, narrow helpers and six public RPCs in migration 0016.
- Migration 0014 device provenance must accept exactly one of an enrollment ticket or pairing session; existing rows are unchanged.
- Migration 0012 transfer provenance must accept exactly one of a claim or pairing when an existing anonymous installation is moved.
- The Companion needs a DPAPI-protected pending-pairing record and an atomic promotion path into the existing device store.
- A locator remains visible in the initial browser URL. It is deliberately a short-lived selector, not a polling/redemption secret.
- For an anonymous installation the server cannot know which registered account the human intended. The explicit confirmation page
  names the current account; that user decision establishes the account. Existing registered ownership never follows this rule and
  cannot be switched.
- Public functionality remains disabled by database and source gates. Migration application and activation are separate operations.

## Required evidence

Acceptance requires the concurrency and security matrix in
[browser-pairing-test-and-acceptance.md](browser-pairing-test-and-acceptance.md), including lost replies, exact-session refresh,
locator replay, account switching, two-account approval, approval/poll races, revoked-device re-enrollment and existing `.fdbact`
compatibility.
