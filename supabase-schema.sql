-- Money Quest — Supabase schema
-- Run this once in: Supabase Dashboard > SQL Editor > New query > Paste > Run

-- 1) Goals table (one row per quest, app uses the latest one)
create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My Money Quest',
  target numeric not null check (target > 0),
  days integer not null check (days >= 1),
  start_date date not null,
  currency text not null default '₹',
  created_at timestamptz not null default now()
);

-- 2) Earnings table (each earning belongs to a goal)
create table if not exists public.earnings (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid references public.goals(id) on delete cascade,
  amount numeric not null check (amount > 0),
  date date not null,
  note text default '',
  created_at timestamptz not null default now()
);

-- Helpful index: newest earnings first per goal
create index if not exists earnings_goal_date_idx
  on public.earnings (goal_id, date desc);

-- 3) Expose via Data API + Row Level Security
-- This app is a single-user demo with no login, so we allow anon access.
-- For a multi-user app, add auth + user_id checks instead.
alter table public.goals enable row level security;
alter table public.earnings enable row level security;

-- Allow public read/write via anon key (demo mode)
-- Drop old policies first so re-running this file is safe.
drop policy if exists "demo allow all goals" on public.goals;
create policy "demo allow all goals"
  on public.goals for all
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "demo allow all earnings" on public.earnings;
create policy "demo allow all earnings"
  on public.earnings for all
  to anon, authenticated
  using (true)
  with check (true);

-- 4) Grant Data API access (needed if your project requires explicit grants)
grant select, insert, update, delete on public.goals to anon, authenticated;
grant select, insert, update, delete on public.earnings to anon, authenticated;
