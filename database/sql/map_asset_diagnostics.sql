-- Companion map-resolution diagnostics.
-- Applied directly to the active Supabase project during development.

create table if not exists public.map_asset_diagnostics (
    id bigint generated always as identity primary key,
    user_id uuid not null default auth.uid(),
    companion_version text not null default '',
    resolver_version text not null default '',
    map_id bigint not null,
    map_name text not null default '',
    map_art_id bigint not null default 0,
    layer_index integer not null default 0,
    wow_build_fingerprint text not null default '',
    success boolean not null default false,
    from_cache boolean not null default false,
    storage_label text not null default '',
    asset_mode text not null default '',
    stage text not null default '',
    duration_ms integer not null default 0,
    status text not null default '',
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

alter table public.map_asset_diagnostics
enable row level security;

revoke all on table public.map_asset_diagnostics
from public, anon, authenticated;

grant insert on table public.map_asset_diagnostics
to authenticated;

drop policy if exists "map diagnostics insert own"
on public.map_asset_diagnostics;

create policy "map diagnostics insert own"
on public.map_asset_diagnostics
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create index if not exists map_asset_diagnostics_map_created_idx
on public.map_asset_diagnostics (map_id, created_at desc);

create index if not exists map_asset_diagnostics_user_created_idx
on public.map_asset_diagnostics (user_id, created_at desc);
