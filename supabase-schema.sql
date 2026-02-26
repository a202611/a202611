-- Run this in your Supabase project → SQL Editor

-- ── USERS TABLE ──────────────────────────────────────────────
create table if not exists users (
  id               uuid primary key default gen_random_uuid(),
  platform_id      text not null,          -- Steam ID / Epic account ID / etc
  platform         text not null,          -- 'steam' | 'epic' | 'xbox' | 'playstation'
  display_name     text,
  embark_id        text,                   -- parsed from Pioneer JWT sub claim
  pioneer_token    text,                   -- the Bearer JWT for es-pio.net
  token_expires_at timestamptz,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),

  unique (platform_id, platform)           -- one row per platform account
);

-- ── ROW LEVEL SECURITY ───────────────────────────────────────
-- We use service_role key on the backend, so RLS can be restrictive
alter table users enable row level security;

-- No direct browser access allowed (backend only via service key)
create policy "No public access" on users for all using (false);

-- ── INDEX ────────────────────────────────────────────────────
create index if not exists idx_users_platform on users(platform_id, platform);
create index if not exists idx_users_embark_id on users(embark_id);
