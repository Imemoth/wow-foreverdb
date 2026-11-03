begin;
do $$
begin
    if exists (select 1 from cron.job where jobname in (
        'azerdex-news-blueposts', 'azerdex-news-official', 'azerdex-news-revisions'
    )) then
        perform cron.unschedule(jobid) from cron.job where jobname in (
            'azerdex-news-blueposts', 'azerdex-news-official', 'azerdex-news-revisions'
        );
    end if;
end
$$;
drop function if exists private.azerdex_news_schedule_request(text[], text);
commit;
