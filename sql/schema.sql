-- ============================================================
-- WhatsApp Funnel Dashboard — Supabase schema
-- Run this once in the Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- 1. The ONLY table the live dashboard ever reads from.
--    Stays tiny forever: ~20-90 rows added per day, never raw leads.
create table if not exists whatsapp_funnel_summary (
  id            bigint generated always as identity primary key,
  report_date   date        not null,
  medium        text        not null,
  call_status   text        not null,
  bd            smallint    not null,
  channel_id    smallint    not null,
  total         integer     not null default 0,
  sent          integer     not null default 0,
  delivered     integer     not null default 0,
  converted     integer     not null default 0,
  enriched      integer     not null default 0,
  approved      integer     not null default 0,
  updated_at    timestamptz not null default now(),

  -- This is what makes re-processing a file safe: re-uploading the
  -- same day's export overwrites that day's numbers instead of
  -- double-counting them.
  constraint whatsapp_funnel_summary_unique_segment
    unique (report_date, medium, call_status, bd, channel_id)
);

create index if not exists idx_whatsapp_funnel_summary_date
  on whatsapp_funnel_summary (report_date);

-- 2. Observability — every processing run gets logged here so a
--    silent failure is never actually silent. Check this table (or
--    build a tiny status widget) to see when the pipeline last ran.
create table if not exists daily_upload_log (
  id             bigint generated always as identity primary key,
  file_name      text        not null,
  bucket_path    text        not null,
  status         text        not null check (status in ('success','failed')),
  rows_parsed    integer,
  segments_upserted integer,
  error_message  text,
  processed_at   timestamptz not null default now()
);

-- 3. Storage bucket for the raw daily exports.
--    Private — only the service role (used by the processing
--    function) and authenticated users (via the upload page) can
--    touch it.
insert into storage.buckets (id, name, public)
values ('daily-exports', 'daily-exports', false)
on conflict (id) do nothing;

-- Only logged-in users can upload to this bucket. Pair this with
-- Supabase Auth (email/password or magic link) on the upload page
-- so a random visitor with the anon key can't drop files in.
create policy "authenticated users can upload daily exports"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'daily-exports');

create policy "authenticated users can view daily exports"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'daily-exports');

-- ============================================================
-- Option A (recommended): create the webhook in the Dashboard UI
-- Database > Webhooks > Create a new webhook
--   Table: storage.objects
--   Events: Insert
--   Type: HTTP Request
--   URL: https://<your-vercel-app>.vercel.app/api/process-upload
--   Header: Authorization: Bearer <the same secret you set as
--            PROCESS_WEBHOOK_SECRET in Vercel>
-- This is simpler to manage than raw SQL and shows up in the
-- Dashboard's webhook logs when something fails.
-- ============================================================

-- Option B: the SQL equivalent, if you'd rather keep this in
-- version control instead of clicking through the Dashboard.
-- Requires the pg_net extension (enabled by default on Supabase).
--
-- create or replace function notify_new_export()
-- returns trigger as $$
-- begin
--   perform net.http_post(
--     url := 'https://<your-vercel-app>.vercel.app/api/process-upload',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <PROCESS_WEBHOOK_SECRET>'
--     ),
--     body := jsonb_build_object(
--       'bucket_id', new.bucket_id,
--       'name', new.name
--     )
--   );
--   return new;
-- end;
-- $$ language plpgsql security definer;
--
-- create trigger on_new_export
--   after insert on storage.objects
--   for each row
--   when (new.bucket_id = 'daily-exports')
--   execute function notify_new_export();
