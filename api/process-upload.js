// api/process-upload.js
//
// Triggered by a Supabase Database Webhook the moment a new file
// lands in the `daily-exports` Storage bucket. Downloads the file,
// parses it, aggregates it the same way the dashboard's GROUP BY
// does, and upserts the result into whatsapp_funnel_summary.
//
// The raw file itself is never copied anywhere else — it stays in
// Storage as its own archive. Nothing here writes raw rows to the
// database.

import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // service role — bypasses RLS, needed to read the private bucket
);

const BUCKET = 'daily-exports';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify the request actually came from your Supabase webhook,
  // not from someone who found this URL.
  const authHeader = req.headers['authorization'] || '';
  const expected = `Bearer ${process.env.PROCESS_WEBHOOK_SECRET}`;
  if (authHeader !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};
  const bucketId = body.bucket_id || body.record?.bucket_id;
  const path = body.name || body.record?.name;

  if (bucketId !== BUCKET || !path) {
    // Not an event we care about (e.g. a delete, or a different bucket).
    return res.status(200).json({ skipped: true });
  }

  try {
    const result = await processFile(path);
    await logRun(path, 'success', result.rowsParsed, result.segmentsUpserted, null);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('process-upload failed', err);
    await logRun(path, 'failed', null, null, String(err.message || err));
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

async function processFile(path) {
  // 1. Download the raw file from Storage.
  const { data: fileBlob, error: downloadError } = await supabase
    .storage
    .from(BUCKET)
    .download(path);

  if (downloadError) throw new Error(`Download failed: ${downloadError.message}`);

  const arrayBuffer = await fileBlob.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  // 2. Aggregate — mirrors the same GROUP BY the dashboard uses:
  //    date x Medium x Call Status x BD x Channel Id.
  const segments = new Map();

  for (const row of rows) {
    const dateCreated = row['Date Created'];
    if (!dateCreated) continue; // skip malformed rows rather than crash the whole run

    const reportDate = toDateOnly(dateCreated);
    const medium = String(row['Medium'] ?? '-');
    const callStatus = String(row['Call Status'] ?? '-');
    const bd = Number(row['BD'] ?? -1);
    const channelId = Number(row['Channel Id'] ?? -1);

    const key = [reportDate, medium, callStatus, bd, channelId].join('|');
    if (!segments.has(key)) {
      segments.set(key, {
        report_date: reportDate,
        medium,
        call_status: callStatus,
        bd,
        channel_id: channelId,
        total: 0, sent: 0, delivered: 0, converted: 0, enriched: 0, approved: 0,
      });
    }
    const seg = segments.get(key);

    const firstAns = row['1st Ans Date'];
    const secondAns = row['2nd Ans Date'];
    const thirdAns = row['3rd Ans Date'];
    const hasDate = (v) => v !== null && v !== undefined && v !== '-' && v !== '';

    seg.total += 1;
    if (row['WhatsApp Sent'] === 'Yes') seg.sent += 1;
    if (row['WhatsApp Delivered'] === 'Yes') seg.delivered += 1;
    if (row['Converted on WhatsApp'] === 'Yes') seg.converted += 1;
    if (hasDate(firstAns)) seg.enriched += 1;
    if (hasDate(firstAns) && hasDate(secondAns) && hasDate(thirdAns)) seg.approved += 1;
  }

  const segmentRows = Array.from(segments.values());

  // 3. Upsert. The unique constraint on
  //    (report_date, medium, call_status, bd, channel_id) means
  //    re-uploading the same day's file overwrites that day's
  //    numbers rather than adding duplicates on top.
  if (segmentRows.length > 0) {
    const { error: upsertError } = await supabase
      .from('whatsapp_funnel_summary')
      .upsert(segmentRows, {
        onConflict: 'report_date,medium,call_status,bd,channel_id',
      });
    if (upsertError) throw new Error(`Upsert failed: ${upsertError.message}`);
  }

  return { rowsParsed: rows.length, segmentsUpserted: segmentRows.length };
}

function toDateOnly(value) {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function logRun(path, status, rowsParsed, segmentsUpserted, errorMessage) {
  await supabase.from('daily_upload_log').insert({
    file_name: path.split('/').pop(),
    bucket_path: path,
    status,
    rows_parsed: rowsParsed,
    segments_upserted: segmentsUpserted,
    error_message: errorMessage,
  });
}
