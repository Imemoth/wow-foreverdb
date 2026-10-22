-- Deprecated compatibility marker. The old script stored the collector
-- secret in private.azerdex_news_settings. Use 0017_schedule_news_collector_vault.sql,
-- which reads azerdex_news_collector_secret from Supabase Vault at execution time.
select 1;
