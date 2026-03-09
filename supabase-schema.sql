-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- to create the shared contacts table and allow the app to read/write.

-- Table: one row per contact (shared across all users)
create table if not exists public.contacts (
  id text primary key,
  name text not null default '',
  company text not null default '',
  job_title text not null default '',
  linkedin text not null default '',
  status text not null default 'Not Contacted',
  campaigns jsonb not null default '[]'::jsonb,
  senders jsonb not null default '[]'::jsonb
);

-- RLS: allow anonymous read/write so the app (using anon key) can sync.
-- Only use this if the app URL is private / shared only with colleagues.
alter table public.contacts enable row level security;

drop policy if exists "Allow anon read contacts" on public.contacts;
create policy "Allow anon read contacts"
  on public.contacts for select
  to anon using (true);

drop policy if exists "Allow anon insert contacts" on public.contacts;
create policy "Allow anon insert contacts"
  on public.contacts for insert
  to anon with check (true);

drop policy if exists "Allow anon update contacts" on public.contacts;
create policy "Allow anon update contacts"
  on public.contacts for update
  to anon using (true) with check (true);

drop policy if exists "Allow anon delete contacts" on public.contacts;
create policy "Allow anon delete contacts"
  on public.contacts for delete
  to anon using (true);
