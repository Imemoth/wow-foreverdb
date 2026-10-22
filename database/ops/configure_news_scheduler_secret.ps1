$ErrorActionPreference = 'Stop'

throw 'Deprecated: configure azerdex_news_collector_secret in Supabase Vault. Apply database/ops/0017_schedule_news_collector_vault.sql through the Supabase integration; do not use this local psql helper.'
