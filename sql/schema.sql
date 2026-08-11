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

-- Lock this table down: only logged-in users (the report's password
-- gate) can read it. The processing function uses the service_role
-- key, which bypasses RLS entirely, so it can keep upserting either way.
alter table whatsapp_funnel_summary enable row level security;

create policy "authenticated users can view funnel summary"
  on whatsapp_funnel_summary for select
  to authenticated
  using (true);

-- 1b. Category (Search Keyword) breakdown — aggregated independently of
--     the main summary table above, by report_date x search_keyword only.
--     Kept separate rather than folding search_keyword into
--     whatsapp_funnel_summary's grouping key, since doing that would
--     require reprocessing every historical upload to avoid
--     double-counting already-processed dates.
create table if not exists whatsapp_funnel_by_category (
  id              bigint generated always as identity primary key,
  report_date     date        not null,
  search_keyword  text        not null,
  total           integer     not null default 0,
  sent            integer     not null default 0,
  delivered       integer     not null default 0,
  converted       integer     not null default 0,
  enriched        integer     not null default 0,
  approved        integer     not null default 0,
  updated_at      timestamptz not null default now(),

  constraint whatsapp_funnel_by_category_unique_segment
    unique (report_date, search_keyword)
);

create index if not exists idx_whatsapp_funnel_by_category_date
  on whatsapp_funnel_by_category (report_date);

alter table whatsapp_funnel_by_category enable row level security;

create policy "authenticated users can view category breakdown"
  on whatsapp_funnel_by_category for select
  to authenticated
  using (true);

-- The dashboard's Category Breakdown tab only ever needs totals grouped
-- by search_keyword for the selected date range — it never needs the
-- individual report_date x search_keyword rows. With this table having
-- grown to 200k+ rows (high-cardinality search keywords x many days),
-- pulling every row to the browser just to sum it in JS was the reason
-- that tab was so much slower than the rest of the dashboard. Doing the
-- SUM/GROUP BY in Postgres instead means only one row per distinct
-- keyword ever crosses the network. Runs as SECURITY INVOKER (the
-- default) so the caller's own RLS policy above still applies.
create or replace function whatsapp_category_breakdown(date_from date, date_to date)
returns table (
  search_keyword text,
  total     bigint,
  sent      bigint,
  delivered bigint,
  converted bigint,
  enriched  bigint,
  approved  bigint
)
language sql
stable
as $$
  select
    search_keyword,
    sum(total)::bigint,
    sum(sent)::bigint,
    sum(delivered)::bigint,
    sum(converted)::bigint,
    sum(enriched)::bigint,
    sum(approved)::bigint
  from whatsapp_funnel_by_category
  where report_date between date_from and date_to
  group by search_keyword;
$$;

grant execute on function whatsapp_category_breakdown(date, date) to authenticated;

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

-- Lets the upload page poll this table (via the anon key + logged-in
-- session) to detect when its own file has finished processing, so it
-- can show a "processing complete" status instead of a blind guess.
alter table daily_upload_log enable row level security;

create policy "authenticated users can view upload log"
  on daily_upload_log for select
  to authenticated
  using (true);

-- 3. Storage bucket for the raw daily exports.
--    Private — only the service role (used by the processing
--    function) and authenticated users (via the upload page) can
--    touch it.
-- file_size_limit is in bytes. 100 MB gives headroom above the ~80 MB
-- daily files. Note: this only takes effect if it's <= the project-wide
-- global upload limit (Project Settings > Storage) — free-tier projects
-- are hard-capped at 50 MB there regardless of this setting, so files
-- over 50 MB will still be rejected until the project is on a paid plan
-- with that global limit raised to at least 100 MB.
insert into storage.buckets (id, name, public, file_size_limit)
values ('daily-exports', 'daily-exports', false, 104857600)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

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

-- Re-uploading the same day's file (upsert:true in UploadPage.jsx)
-- overwrites the existing storage object, which is an UPDATE, not an
-- INSERT — without this policy that overwrite is blocked by RLS.
create policy "authenticated users can overwrite daily exports"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'daily-exports')
  with check (bucket_id = 'daily-exports');

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
