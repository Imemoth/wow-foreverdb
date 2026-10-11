-- ForeverDB 0012 maintenance: prune old claim and audit rows. OPERATOR-RUN (or a scheduled job), bounded, per-installation locked.
--
-- Deletes ONLY:
--   * revoked claims, and never-redeemed expired (still `pending`) claims, older than 7 days;
--   * audit rows older than 180 days.
-- NEVER deletes a `consumed` claim or any claim a link row references (the link row references it, and the `transferred` signal is derived from the link row).
-- Every claim row is deleted while holding the installation advisory lock (the same key ingest and the account functions use);
-- locking these rows without that lock would break the concurrency guarantee. At most 500 claims per run (re-run until it returns 0).
begin;
set local lock_timeout = '5s';

do $prune$
declare
    r record;
    v_deleted integer := 0;
begin
    for r in
        select c.id, c.installation_id
        from private.installation_claims c
        where ((c.status = 'revoked' and c.created_at < now() - interval '7 days')
            or (c.status = 'pending' and c.expires_at < now() - interval '7 days'))
          and not exists (select 1 from private.account_installations l where l.claim_id = c.id)
        order by c.created_at
        limit 500
    loop
        perform pg_advisory_xact_lock(hashtextextended(r.installation_id, 0));
        delete from private.installation_claims c
        where c.id = r.id and (c.status = 'revoked' or c.status = 'pending')
          and not exists (select 1 from private.account_installations l where l.claim_id = c.id);
        v_deleted := v_deleted + 1;
    end loop;
    delete from private.account_audit where at < now() - interval '180 days';
    raise notice 'pruned % claim row(s)', v_deleted;
end $prune$;

commit;
