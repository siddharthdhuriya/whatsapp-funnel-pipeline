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

  // Two ways in are accepted:
  //  1. The Supabase Storage webhook, authenticated with the shared secret.
  //  2. A logged-in upload-page user, authenticated with their own Supabase
  //     session token — this lets the client trigger processing directly
  //     right after an upload, since the webhook only fires on Storage
  //     INSERT and never on UPDATE (i.e. re-uploading an existing day's
  //     file), which would otherwise silently never get processed again.
  const authHeader = req.headers['authorization'] || '';
  const expectedWebhook = `Bearer ${process.env.PROCESS_WEBHOOK_SECRET}`;
  let authorized = authHeader === expectedWebhook;

  if (!authorized && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const { data, error } = await supabase.auth.getUser(token);
    authorized = !error && !!data?.user;
  }

  if (!authorized) {
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
  // raw:true + cellDates:false — without these, xlsx auto-detects textual
  // CSV dates and guesses them as US month-first (MM/DD/YYYY), silently
  // turning "02/07/2026" (2 Jul) into Feb 7 before our code ever sees it.
  // This keeps CSV date cells as their literal text and real Excel date
  // cells as their numeric serial, so toDateOnly() can parse both explicitly.
  const workbook = XLSX.read(arrayBuffer, { type: 'buffer', raw: true, cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  clipToPopulatedHeaderColumns(sheet);
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });

  // 2. Aggregate — mirrors the same GROUP BY the dashboard uses:
  //    date x Medium x Call Status x BD x Channel Id.
  const segments = new Map();

  for (const row of rows) {
    const dateCreated = row['Date Created'];
    if (!dateCreated) continue; // skip malformed rows rather than crash the whole run

    let reportDate;
    try {
      reportDate = toDateOnly(dateCreated);
    } catch {
      continue; // unparseable value (e.g. data shifted into the wrong column) — skip rather than crash the whole run
    }
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

// Exports occasionally carry a stray far-out cell (leftover formatting,
// an accidental paste) that makes SheetJS report a used range thousands
// of columns wide even though only ~40-50 columns hold real data. Since
// sheet_to_json's cost scales with rows x columns of the declared range,
// an inflated range turns a sub-second parse into a 40s+ one — long
// enough to blow past the function's execution timeout, which kills the
// process before it ever reaches the code that logs success or failure.
// Clipping to the last populated header cell keeps the parse proportional
// to the sheet's actual size.
function clipToPopulatedHeaderColumns(sheet) {
  if (!sheet['!ref']) return;
  const range = XLSX.utils.decode_range(sheet['!ref']);
  let lastCol = range.s.c;
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c })];
    if (cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '') {
      lastCol = c;
    }
  }
  sheet['!ref'] = XLSX.utils.encode_range({ s: range.s, e: { r: range.e.r, c: lastCol } });
}

function toDateOnly(value) {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
      .toISOString().slice(0, 10);
  }
  // Real Excel date cells come through (with cellDates:false) as a raw
  // serial number of days since the Excel epoch (Dec 30, 1899) — convert
  // that directly rather than via a locale-dependent string.
  if (typeof value === 'number') {
    const days = Math.floor(value);
    return new Date(Date.UTC(1899, 11, 30) + days * 86400000).toISOString().slice(0, 10);
  }
  // Plain-text cells (e.g. from a CSV export) come in as DD/MM/YYYY, not
  // MM/DD/YYYY. `new Date(string)` assumes the US month-first order, which
  // silently swaps day and month for dates like "02/07/2026" (2 July
  // becomes 7 Feb) instead of erroring — so parse the day/month order
  // explicitly rather than relying on Date's ambiguous string parsing.
  const str = String(value).trim();
  const dmy = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return new Date(str).toISOString().slice(0, 10);
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
