-- Re-enable AFTER the cause is understood and the owner has re-approved sending. Dispatch first (drains the preserved queue), intake second.
-- This never re-enables the worker flag: that is a separate Edge Function secret.
select private.azerdex_welcome_set_switch(null, true);
-- select private.azerdex_welcome_set_switch(true, null);   -- intake: uncomment deliberately
select enqueue_enabled, dispatch_enabled, activation_at from private.azerdex_welcome_config;
