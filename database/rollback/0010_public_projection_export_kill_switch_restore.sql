-- Restores export access after 0010_public_projection_export_kill_switch.sql. The existing password stays valid.
alter role foreverdb_projection_reader login;
