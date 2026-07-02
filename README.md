# WhatsApp Funnel — Daily Pipeline

Upload today's export once; parsing, aggregation, and updating the
dashboard's data source all happen automatically after that.

```
whatsapp-pipeline/
├── sql/schema.sql          Run once in Supabase's SQL Editor
├── api/process-upload.js   Vercel function — called by the webhook
├── src/UploadPage.jsx      The drag-and-drop upload page
├── src/main.jsx            React entry point
├── index.html              Vite entry HTML
├── vite.config.js
├── package.json            Frontend + API dependencies, one project
└── .env.example            All env vars, template only
```

One Vercel project builds both the upload page (static frontend) and
the `/api/process-upload` serverless function together — you deploy
this once, as a whole.

## What happens end to end

1. You drag today's file into the upload page and it lands in the
   private `daily-exports` Storage bucket.
2. A Supabase Database Webhook fires the instant the file appears and
   calls `/api/process-upload`.
3. That function downloads the file, computes sent / delivered /
   converted / enriched / approved counts grouped by date × Medium ×
   Call Status × BD × Channel ID — the same grouping your dashboard
   already uses — and upserts the result into `whatsapp_funnel_summary`.
4. The raw file stays in Storage as its own archive; nothing raw ever
   touches the database. Every run is logged in `daily_upload_log`.

---

## Deploy — step by step

### 1. Get the code into a GitHub repo

Vercel deploys from a Git repo, so this needs to live in one first.

```bash
cd whatsapp-pipeline
git init
git add .
git commit -m "Initial pipeline"
```

Create an empty repo on GitHub (e.g. `whatsapp-funnel-pipeline`), then:

```bash
git remote add origin https://github.com/<you>/whatsapp-funnel-pipeline.git
git branch -M main
git push -u origin main
```

*(If you'd rather skip GitHub and deploy straight from your machine,
you can run `npx vercel` from inside the folder instead — Vercel's CLI
will walk you through the same setup without needing a repo. GitHub is
still worth doing eventually so future changes auto-deploy on push.)*

### 2. Set up Supabase

You likely already have a Supabase project from your other tools — you
can reuse it, or create a fresh one for this pipeline at
[supabase.com](https://supabase.com).

1. **SQL Editor** → paste in all of `sql/schema.sql` → Run.
   This creates `whatsapp_funnel_summary`, `daily_upload_log`, the
   private `daily-exports` bucket, and the upload policies.
2. **Authentication → Providers** → make sure Email is enabled.
3. **Authentication → Users** → add yourself (and anyone else who'll
   upload) so the upload page can require login. Magic link is the
   lowest-friction option for a daily habit.
4. Note down, from **Project Settings → API**:
   - Project URL
   - `anon` public key
   - `service_role` key (keep this one private)

### 3. Deploy to Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import the
   GitHub repo you just pushed.
2. Vercel will auto-detect Vite for the frontend and pick up
   `api/process-upload.js` as a serverless function automatically —
   no extra configuration needed.
3. Before the first deploy, add these under
   **Project Settings → Environment Variables** (values from step 2):

   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | your project URL |
   | `VITE_SUPABASE_ANON_KEY` | your anon key |
   | `SUPABASE_URL` | your project URL (same as above) |
   | `SUPABASE_SERVICE_ROLE_KEY` | your service role key |
   | `PROCESS_WEBHOOK_SECRET` | make up any long random string |

4. Deploy. Note the resulting URL, e.g. `https://your-app.vercel.app`.

### 4. Wire up the webhook

Back in Supabase: **Database → Webhooks → Create a new webhook**

| Field | Value |
|---|---|
| Table | `storage.objects` |
| Events | Insert |
| Type | HTTP Request |
| URL | `https://your-app.vercel.app/api/process-upload` |
| HTTP Header | `Authorization: Bearer <same string as PROCESS_WEBHOOK_SECRET>` |

(The SQL equivalent, if you'd rather manage this as code instead of
clicking through the dashboard, is commented at the bottom of
`sql/schema.sql`.)

### 5. Test it end to end

1. Visit `https://your-app.vercel.app`, log in, drag in `Report.xlsx`.
2. **Database → Webhooks** in Supabase → confirm the call fired and
   returned a 200.
3. In the SQL Editor:
   ```sql
   select * from daily_upload_log order by processed_at desc limit 5;
   ```
   You should see a `success` row with a row count matching your file.
4. ```sql
   select * from whatsapp_funnel_summary order by report_date desc limit 20;
   ```
   The aggregated segments should be there.

If step 2 shows a failed call, check the Vercel function logs
(**Vercel → your project → Deployments → Functions**) for the actual
error — most first-run issues are a mismatched `PROCESS_WEBHOOK_SECRET`
or a missing env var.

---

## Next step (not built yet)

The dashboard you already have reads from a static snapshot baked into
the HTML file, so it won't pick up new data by itself yet. Once this
pipeline's been running for a few days and you trust it, the natural
next step is pointing the dashboard at a live API route that queries
`whatsapp_funnel_summary` directly, with your existing filters
translated into a SQL `WHERE` clause — so it always reflects today's
data. Happy to build that when you're ready.
