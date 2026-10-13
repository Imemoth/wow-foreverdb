-- 0015 KILL SWITCH (fast, reversible, preserves every row). Stops intake AND dispatch immediately; account registration, verification and
-- login are unaffected. Also set AZERDEX_WELCOME_ENABLED=false on the Edge Function and run database/ops/0015_unschedule_welcome_worker.sql.
select private.azerdex_welcome_set_switch(false, false);
select enqueue_enabled, dispatch_enabled from private.azerdex_welcome_config;
