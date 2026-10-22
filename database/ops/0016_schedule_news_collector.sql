-- AzerDex News V1 scheduling. Apply only after the Edge Function is deployed and
-- private.azerdex_news_settings contains news_collector_url and news_collector_secret.
-- Secrets stay in the existing private database settings table; they are never
-- sent to the browser or committed to the repository.

begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists private.azerdex_news_settings (
    key text primary key check (key in ('news_collector_url', 'news_collector_secret')),
    value text not null,
    updated_at timestamptz not null default now()
);

revoke all on private.azerdex_news_settings from public, anon, authenticated;

create or replace function private.azerdex_news_schedule_request(p_source_keys text[], p_mode text default 'normal')
returns bigint
language plpgsql
security definer
set search_path = private, public, pg_catalog
as $$
declare
    v_url text;
    v_secret text;
    v_request_id bigint;
begin
    select value into v_url from private.azerdex_news_settings where key = 'news_collector_url';
    select value into v_secret from private.azerdex_news_settings where key = 'news_collector_secret';
    if v_url is null or v_url !~ '^https://' or v_secret is null or length(v_secret) < 24 then
        raise exception 'News collector scheduler is not configured';
    end if;
    select net.http_post(
        url := v_url,
        headers := jsonb_build_object('content-type', 'application/json', 'x-azerdex-news-secret', v_secret),
        body := jsonb_build_object('sourceKeys', p_source_keys, 'mode', p_mode),
        timeout_milliseconds := 15000
    ) into v_request_id;
    return v_request_id;
end;
$$;

revoke all on function private.azerdex_news_schedule_request(text[], text) from public, anon, authenticated;
grant execute on function private.azerdex_news_schedule_request(text[], text) to postgres;

do $schedule$
begin
    if exists (select 1 from cron.job where jobname in (
        'azerdex-news-blueposts', 'azerdex-news-official', 'azerdex-news-revisions'
    )) then
        perform cron.unschedule(jobid) from cron.job where jobname in (
            'azerdex-news-blueposts', 'azerdex-news-official', 'azerdex-news-revisions'
        );
    end if;

    perform cron.schedule(
        'azerdex-news-blueposts', '*/10 * * * *',
        $$select private.azerdex_news_schedule_request(
            ARRAY['blizzard-bluepost-us', 'blizzard-bluepost-eu']::text[], 'normal'
        )$$
    );
    perform cron.schedule(
        'azerdex-news-official', '*/30 * * * *',
        $$select private.azerdex_news_schedule_request(
            ARRAY['blizzard-news-us']::text[], 'normal'
        )$$
    );
    perform cron.schedule(
        'azerdex-news-revisions', '0 */6 * * *',
        $$select private.azerdex_news_schedule_request(
            ARRAY['blizzard-bluepost-us', 'blizzard-bluepost-eu', 'blizzard-news-us']::text[], 'revision'
        )$$
    );
end
$schedule$;

commit;
