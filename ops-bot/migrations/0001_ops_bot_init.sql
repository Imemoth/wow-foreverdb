-- AzerDex Operations Bot V1: D1 schema (bot-private operational state ONLY).
-- Independent of every News/publication table. Stores no player, Guildbook or account data.
-- All timestamps are integer epoch milliseconds (UTC). NOT applied to any environment by this repository change:
-- apply per docs/ops-bot/staging-runbook.md (staging) or docs/ops-bot/production-release-checklist.md (production, owner approval).

create table incidents (
    id               text primary key,
    component        text not null,
    status           text not null check (status in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
    severity         text not null check (severity in ('CRITICAL')),
    reason_code      text not null,
    summary          text not null,
    context          text not null default '{}',
    first_seen_at    integer not null,
    last_seen_at     integer not null,
    occurrences      integer not null default 1,
    healthy_streak   integer not null default 0,
    update_count     integer not null default 0,
    last_notified_at integer,            -- time a notification was last ENQUEUED (not delivered)
    reminder_count   integer not null default 0,
    ack_by           text,
    ack_at           integer,
    ack_note         text,
    resolved_at      integer,
    alert_message_id text,
    alert_channel_id text,
    updated_at       integer not null
);
-- Atomic de-duplication: at most ONE unresolved incident per component, enforced by the database.
create unique index incidents_one_active_per_component on incidents (component) where status <> 'RESOLVED';
create index incidents_status_first_seen on incidents (status, first_seen_at);
create index incidents_resolved_at on incidents (resolved_at) where resolved_at is not null;

create table incident_events (
    id          integer primary key autoincrement,
    incident_id text not null references incidents (id) on delete cascade,
    at          integer not null,
    kind        text not null,           -- OPENED UPDATED REMINDER ACK RECOVERED NOTIFIED NOTIFY_SUPPRESSED NOTIFY_DEAD ...
    actor       text not null,           -- 'system' or an operator's Discord user id (audit; never logged in clear)
    detail      text not null default ''
);
create index incident_events_incident on incident_events (incident_id, id);

-- Durable delivery outbox. id is a deterministic idempotency key, e.g. '<incident>:OPEN:0'.
create table outbox (
    id                 text primary key,
    incident_id        text not null references incidents (id) on delete cascade,
    kind               text not null check (kind in ('OPEN', 'UPDATE', 'REMINDER', 'RECOVERED', 'EDIT_ALERT')),
    status             text not null check (status in ('PENDING', 'SENDING', 'SENT', 'DEAD')),
    attempts           integer not null default 0,
    next_attempt_at    integer not null,
    lease_until        integer,
    discord_message_id text,
    last_error_class   text,
    fallback_sent_at   integer,
    created_at         integer not null,
    sent_at            integer
);
create index outbox_due on outbox (status, next_attempt_at);
create index outbox_incident on outbox (incident_id);

create table component_state (
    component   text primary key,
    state       text not null check (state in ('HEALTHY', 'WARNING', 'CRITICAL', 'UNKNOWN')),
    reason_code text not null,
    since       integer not null,
    updated_at  integer not null
);

create table monitor_state (
    key        text primary key,
    value      text not null,
    updated_at integer not null
);

create table locks (
    name        text primary key,
    holder      text not null,
    lease_until integer not null
);

create table maintenance (
    id         integer primary key autoincrement,
    component  text not null,            -- a component id or '*'
    starts_at  integer not null,
    ends_at    integer not null,
    created_by text not null,
    reason     text not null,
    ended_at   integer,
    ended_by   text
);
create index maintenance_active on maintenance (ends_at) where ended_at is null;

create table audit_log (
    id     integer primary key autoincrement,
    at     integer not null,
    actor  text not null,
    action text not null,
    target text not null,
    detail text not null default ''
);

-- Interaction replay protection (Discord interaction ids are unique snowflakes) and per-operator rate limiting.
create table seen_interactions (
    id      text primary key,
    seen_at integer not null
);
create index seen_interactions_seen_at on seen_interactions (seen_at);

create table rate_limits (
    key          text primary key,
    window_start integer not null,
    count        integer not null
);
