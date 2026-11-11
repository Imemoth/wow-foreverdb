-- Rollback for migrations/0001_ops_bot_init.sql. Removes ONLY objects created by that migration (bot-private D1 state).
-- Not run by tooling automatically. Order: children before parents. Touches nothing outside the ops bot database.
drop table if exists rate_limits;
drop table if exists seen_interactions;
drop table if exists audit_log;
drop table if exists maintenance;
drop table if exists locks;
drop table if exists monitor_state;
drop table if exists component_state;
drop table if exists outbox;
drop table if exists incident_events;
drop table if exists incidents;
