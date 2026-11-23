# ADM-03B/03C backend hotfix

Status: **development only, Draft.** Three confirmed defects found while running the Admin CMS against the real pinned PostgREST and the merged delivery worker. No hosted migration, no production deployment, no `release` change, no real staff activation, no publication.

PR #208 (the Admin UI) is not modified by this work. It is integrated afterwards (see "Coordination with PR #208").

## The three defects

| # | Where | Symptom | Cause | Fix |
| --- | --- | --- | --- | --- |
| 1 | ADM-03B `editorial_private.run_action` (0025) | A stale edit/submit never answers: the request holds a pooled connection until the client gives up. | Stale/uneditable revisions raised SQLSTATE `40001`. The pinned PostgREST (v12.2.12) treats `40001` as a transient serialization failure and **retries** the call; the condition is deterministic, so it never succeeds. | Raise **`PT409`** instead: PostgREST's documented way to answer HTTP 409 at once with `{"code":"PT409","message":"stale or uneditable revision"}`. Same condition, still evaluated under the article row lock, still rolls the transaction back. |
| 2 | ADM-03C `editorial_private.delivery_eligible` (0026) | Every **highlighted** publication fails before it can be claimed: `column reference "ap.approval_id" is ambiguous`. | The PL/pgSQL record variable `ap` and the table alias `ap` collide (`variable_conflict = error`). The normal-article path never evaluates that statement, so existing tests missed it. | Rename the **table alias** to `appr` in that one statement. The lookup (bound to the intent, the article, the revision and the policy) and the independence / eligibility checks are unchanged. |
| 3 | ADM-03C worker `cms-delivery/src/once.mjs` | One failing delivery aborts the whole pass, so one bad intent blocks every later delivery. | `dispatchOnce` let any error escape the per-intent loop. | Isolate recoverable errors per intent (below). |

## Migration safety and numbering

* Migrations 0025 and 0026 are merged and **are not edited**. `database/migrations/0028_editorial_hotfix_stale_and_highlighted.sql` is an additive forward repair: two `create or replace function` statements run as `admin_executor`, so owner, ACL, `SECURITY` attribute and `search_path` are preserved.
* Registry: `main` ends at 0026; **0027 is reserved by PR #208** (Admin UI read RPCs). The hotfix therefore takes **0028** and does not create a collision. It touches none of #208's objects and 0027 does not depend on the two functions replaced here, so they apply in **either order**. Verified: #208's 0027 and its full read-RPC suite pass with 0028 applied before and after it, with and without the ADM-03C ledger.
* The 0026 repair runs only when `delivery_eligible` exists, so the migration also applies to a 0025-only database (the ADM-03B suite does exactly that).
* Pre-flight: requires 0025 and the reviewed migration operator; **refuses a second apply** (and an unexpected function text). A test proves the repair changes *exactly* the intended text: the new `run_action` equals the old one with only the two SQLSTATEs replaced, and the new `delivery_eligible` equals the old one with only that alias renamed.
* No rollback file: re-installing the two defective functions has no safety value. To revert, `git revert` and ship a new forward migration. The migration is one transaction.

## Worker failure policy (`classifyFailure`)

Each candidate intent is processed on its own. After a failed intent the pass **continues** with the next one.

| Class | Examples | Effect |
| --- | --- | --- |
| Isolated to the intent | content validation (`invalid_claim`, `unsafe_markdown`, `unsafe_link`, `invalid_asset`, `missing_asset`, `asset_hash_mismatch`, …); a deterministic database error while evaluating one intent (e.g. `42702`) | Recorded with `cms_dispatch_fail` when a claim exists (state `retryable`, attempt count, `last_error_code`, a `news.delivery.failure` audit event); the intent is retried on the next pass; the pass reports it in `failures` and the process exits non-zero. |
| **Stops the pass** — security | `public_receipt_mismatch`, `public_receipt_after_revoke` | Rethrown; nothing later is touched. |
| **Stops the pass** — infrastructure | connection (`08…`), authentication (`28…`), resources (`53…`), operator intervention incl. timeouts (`57…`), system (`58…`, `XX…`), network errors, any permission error (`42501`), role mismatch | Rethrown; nothing later is touched. |
| **Stops the pass** — uncertain public outcome | any error once the public write has been started, including a pending private acknowledgement | Rethrown; the claim is kept for receipt recovery after the lease expires (unchanged behaviour). |

Compensation ordering, claims, leases, signed receipts, cancellation and the receipt-recovery path are untouched: candidates are still processed sequentially in the database's order (compensation first), and every database guard (generation ordering, supersede) still applies.

## Tests (all in this PR)

| Test | What it proves |
| --- | --- |
| `database/tests/admin_cms_repair/run.sh` (PostgreSQL 16 and 17, disposable) | Orchestrates everything below on a populated database. |
| `before.sql` | Reproduces both defects **before** the repair (`40001` on a stale edit, `42702` on highlighted qualify). |
| `after.sql` | Exact-text repair; owner/ACL/`SECURITY`/`search_path` unchanged; no API role can execute the internals; stale edit and stale submit raise `PT409`, roll back completely and write nothing to the audit chain; an uneditable state is `PT409`; an unauthorised caller still gets `42501`; the highlighted intent is eligible and a dispatch candidate; **fail-closed variants**: approver revoked, approver == requester, no bound approval, approval of another revision, approver suspended — each makes `delivery_eligible` false. |
| `cms-delivery/test/repair-postgrest.mjs` (real pinned PostgREST) | A stale edit/submit answers **HTTP 409 `PT409` in well under 2 s**; a flood of 24 stale requests is answered promptly and nothing stays active in the database; the remaining **race window**: 12 rounds of 4 concurrent edits from the same base revision → exactly one `200`, three `409`, exactly one new revision; denials remain `403`/`42501`. Negative control: without 0028 the same test fails (the request times out). |
| `cms-delivery/test/repair-worker.mjs` (real worker, real databases) | **Highlighted publication → signed receipt → pointer → public visibility**; forged private acknowledgement and forged public MAC are refused on the highlighted path; **a retryable failure followed by an unrelated successful delivery in the same pass**, with retry count, audit evidence and idempotency (no second delivery; exactly one public row). |
| `database/tests/admin_cms_repair/http.sh` (PostgreSQL 16) | The highlighted and the unrelated article are public in `/news/<slug>`, the archive, RSS and the sitemap; the failed and the forged-receipt articles are not. |
| `cms-delivery/test/worker.test.mjs` | Isolation and abort rules with fake databases, including ordering, claim tokens and "an infrastructure/security failure never continues". |
| Existing suites | `admin_cms` (ADM-03B lifecycle, rollbacks, concurrency) and `admin_cms_delivery` (SQL, two-database worker, HTTP journey) now apply 0028; the pinned real-GoTrue operator job and the real-PostgREST isolation job rehearse it as the non-superuser operator. |

## Coordination with PR #208

After this PR lands, PR #208 should (separately, not part of this change):

1. Map `PT409` (HTTP 409) to *stale* in `web/src/lib/admin/cms/rpc.ts` next to the existing `40001` mapping (keep both for databases that have not applied 0028).
2. Keep its adapter-side stale pre-check; it now only has to cover the narrow race, which the database answers promptly.
3. Replace its harness notes about the highlighted-delivery defect and the head-of-line blocking: its highlighted-delivery spec will then take the "full delivery" branch.

## Findings that are NOT fixed here

* **A qualified-but-unclaimed intent is never retried.** `cms_dispatch_qualify` moves a ledger row to `eligible`, but a later `qualify` accepts only `blocked`, `retryable` or an expired claim, while `cms_dispatch_candidates` still lists `eligible` rows. If a pass is interrupted between `qualify` and `claim`, that intent stays `eligible` and is silently skipped forever (it blocks nothing, and nothing becomes public). Not one of the three reported defects; it needs its own decision.
* **Isolated failures repeat every pass.** A permanently failing intent (for example a missing asset) is retried on every pass with no backoff or attempt ceiling, and writes one audit event per attempt. Monitoring must alert on repeated `retryable` failures (already an ADM-03C activation gate).
* Everything listed under "Remaining activation gates" in `adm-03c-delivery.md` still applies: hosted Supabase behaviour, separate worker credentials and MAC-key provisioning, durable denial audit, cross-database exposure window, Companion MFA compatibility.
