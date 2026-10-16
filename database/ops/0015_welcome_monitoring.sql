-- OWNER/OPERATOR read-only monitoring (no addresses, no identifiers in the first query). Run as the database owner.
select * from jsonb_each(public.azerdex_welcome_stats());
-- Stale or stuck events with a redacted view (user ids shortened to 8 chars; never select email_sha256 or auth.users columns here):
select left(user_id::text, 8) as user, status, attempts, unknown_outcome, last_error_code, next_attempt_at, first_send_at, sent_at
  from private.azerdex_welcome_outbox
 where status in ('review_required', 'retry', 'leased') and updated_at < now() - interval '10 minutes'
 order by updated_at limit 50;

-- Why events ended up in review (counts by reason; no identifiers). attempts_exhausted with unknown_outcome = false = only definite non-sends
-- (bulk-requeueable, runbook §9); unknown_outcome = true needs the per-event provider check (runbook §8).
select last_error_code, unknown_outcome, count(*) as events from private.azerdex_welcome_outbox where status = 'review_required' group by 1, 2 order by 3 desc;
