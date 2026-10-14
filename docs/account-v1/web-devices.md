# Website: device registry and activation file (zero-touch enrollment, website half)

Implements the website side of [ADR-017](adr-017-zero-touch-enrollment.md) / [zero-touch-rpc-contract.md](zero-touch-rpc-contract.md) on top of
migration 0014. Inert unless accounts are enabled (same `Unavailable` / 404 behaviour as every other account page). No new environment
variable, no service credential, no new dependency.

## Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/account/devices` | page (server component) | Devices, recent activation files, "Download activation file for a new computer", Revoke buttons, explanation |
| `/account/api/enrollment/download` | **POST only** (native HTML form) | `fdb_account_enrollment_ticket_issue` with the user's own token; answers the activation file |
| `/account/api/devices` | GET | `fdb_account_devices` (camelCase JSON, no secrets) |
| `/account/api/devices/revoke` | POST JSON `{deviceId: uuid}` | `fdb_account_device_revoke` |
| `/account/api/enrollment/revoke` | POST JSON `{ticketId: uuid}` | `fdb_account_enrollment_ticket_revoke` |

Only these five account functions are callable (`WEB_ENROLLMENT_RPCS`, registry `contracts-enrollment.ts`, strict input/output, an extra
output field fails closed). The registry is separate from the migration-0012-pinned `ACCOUNT_RPCS`. The `fdb_device_*` functions (Companion's
own anonymous identity) are not in any registry the website can reach and are refused by name.

## Download response

`200`, body = the activation file (`{format, v:1, ticket, expiresAt, createdAt}`, no e-mail / account id / token), with
`Content-Disposition: attachment; filename="foreverdb-activation.fdbact"`, `Content-Type: application/json`, `Cache-Control: private, no-store`,
`X-Robots-Tag: noindex` (the proxy widens it to `noindex, nofollow` on every `/account` path), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`. Failures: `409 ticket_limit` (5 pending files or 10 per hour: revoke one or wait), `401`, `403`, `429` + `Retry-After`,
`502 outcome_unknown` (lost reply: a ticket may exist whose secret is lost; the user checks the list and simply downloads another; never auto-retried).
A browser form navigation (`Accept: text/html`) gets the same failure as a `303` back to `/account/devices?notice=<code>` (closed code list, never
request data); programs get the JSON status.

The `/account/devices` HTML page uses `Referrer-Policy: strict-origin`, not `no-referrer`: Fetch/Referrer Policy rules otherwise serialize the
Origin of a native non-CORS form POST as literal `null`. `strict-origin` makes the same-origin download POST carry the exact site Origin while
Referer remains origin-only (no Account path/query). The proxy and form handler still reject literal `Origin: null`, foreign Origin,
`Sec-Fetch-Site` other than `same-origin`, wrong content type, and invalid/session-foreign/expired HMAC CSRF tokens before ticket issuance.
The activation-file response itself remains `Referrer-Policy: no-referrer` as listed above.

## Threat notes

- **CSRF on a form post.** A form cannot send the JSON content type or the custom header, so the download uses a different, equally strong proof:
  exact Origin (or `Sec-Fetch-Site: same-origin`; neither header = refused), `application/x-www-form-urlencoded`, and a body field `csrf` holding the
  signed token minted server-side into the page, HMAC-bound to the web session id (`verifyFormToken`). The session cookie is `SameSite=Lax` and not sent on
  a cross-site POST anyway. The proxy's same-origin pre-check applies before any counter is touched. Revoke buttons use the existing JSON CSRF helper.
- **The ticket** exists only in the database reply, one local variable and the single response body. Never in a URL (no GET exists), a log (`accountLog`
  has closed scalar fields; a static test checks no call mentions it), another route's JSON, page JavaScript (download is a native form: no `fetch`/Blob),
  an analytics event, a cache (`private, no-store`) or a cookie. The list page shows ticket state only, never a value.
- Ids in the revoke routes are filters, not proof: the database acts only on the caller's own rows and answers one `not_available` (409) otherwise.
- Mutating RPC = unknown outcome on a lost reply (timeout, 5xx, redirect, oversized or malformed body); redirects are never followed.

## What the page says

The file is a one-time secret valid 168 hours (7 days); install the Companion right after downloading; do not share the file; if it is lost or
expired come back and download a new one (no reinstall); at most 5 unused files; "Not you? Revoke this device". States: ticket Pending / Used / Expired /
Revoked; device Active / Revoked (owner_revoked = you revoked it, replaced = activated again with a newer file, credential_reuse = used from two places
at once) / Waiting for approval. Installation id is shortened with the full value in the tooltip.

## Not implemented

- No e-mail notification when a device is enrolled or revoked.
- No ZIP/installer packaging of Companion binaries with the file: the public download page has no signed release yet, so the user installs the Companion
  and the file separately.
- No label field for the activation file (the RPC accepts `p_label`; the website does not send one).
- No per-account website-side throttle for issuing (the database budget, 10 per 5 minutes and 10 per hour, applies).
