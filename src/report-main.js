// src/report-main.js
//
// Drives index.html — the WhatsApp Funnel Control Room report.
// Gated behind a single shared password (not a per-user login) — the
// password field signs in to one fixed internal Supabase Auth account
// behind the scenes so the existing RLS policies (which require an
// `authenticated` session) keep protecting the data without needing a
// full multi-user login system.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// Fixed account behind the shared password gate — not a real mailbox,
// just an identity for Supabase Auth/RLS to attach the session to.
const SHARED_EMAIL = 'access@whatsapp-funnel.internal';

const authGate = document.getElementById('authGate');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('loginForm');
const loginBtn = document.getElementById('loginBtn');
const loginError = document.getElementById('loginError');
const logoutBtn = document.getElementById('logoutBtn');
const refreshBtn = document.getElementById('refreshBtn');

// ---- Auth gate ----

async function init() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    await showDashboard();
  } else {
    showLogin();
  }
}

function showLogin() {
  authGate.classList.remove('hidden');
  dashboard.classList.add('hidden');
}

async function showDashboard() {
  authGate.classList.add('hidden');
  dashboard.classList.remove('hidden');
  await loadAndRender();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.classList.add('hidden');
  loginBtn.disabled = true;
  loginBtn.textContent = 'Logging in…';

  const password = document.getElementById('loginPassword').value;
  const { error } = await supabase.auth.signInWithPassword({ email: SHARED_EMAIL, password });

  loginBtn.disabled = false;
  loginBtn.textContent = 'Log in';

  if (error) {
    loginError.textContent = error.message;
    loginError.classList.remove('hidden');
    return;
  }
  await showDashboard();
});

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  showLogin();
});

refreshBtn.addEventListener('click', () => {
  refreshBtn.textContent = 'Refreshing…';
  loadAndRender().finally(() => { refreshBtn.textContent = '⟳ Refresh'; });
});

supabase.auth.onAuthStateChange((_event, session) => {
  if (!session) showLogin();
});

init();

// ---- Data loading ----

// Pages through a table's full contents. Rather than awaiting each page
// before requesting the next (which turns into hundreds of sequential
// round trips on large tables), it first asks Postgres for the row count
// then fires every page request in parallel, a batch of `concurrency` at
// a time.
async function fetchAllPaginated(queryFactory) {
  const pageSize = 1000;
  const concurrency = 8;

  const { count, error: countError } = await queryFactory({ count: 'exact', head: true });
  if (countError) throw countError;

  const pageStarts = [];
  for (let from = 0; from < (count || 0); from += pageSize) pageStarts.push(from);
  if (!pageStarts.length) return [];

  const pages = new Array(pageStarts.length);
  for (let i = 0; i < pageStarts.length; i += concurrency) {
    const batch = pageStarts.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(from =>
      queryFactory().range(from, from + pageSize - 1)
    ));
    results.forEach((r, j) => {
      if (r.error) throw r.error;
      pages[i + j] = r.data;
    });
  }
  return pages.flat();
}

async function fetchAllSegments() {
  const all = await fetchAllPaginated(opts =>
    supabase.from('whatsapp_funnel_summary').select('*', opts)
  );
  // Map DB column names onto the field names the render logic below expects.
  return all.map(r => ({
    date: r.report_date,
    Medium: r.medium,
    'Call Status': r.call_status,
    BD: r.bd,
    'Channel Id': r.channel_id,
    total: r.total,
    sent: r.sent,
    delivered: r.delivered,
    converted: r.converted,
    enriched: r.enriched,
    approved: r.approved,
  }));
}

// whatsapp_funnel_by_category has grown to 200k+ rows (report_date x
// search_keyword, and search_keyword is high-cardinality), so unlike
// fetchAllSegments this does NOT pull every row to the client -- it asks
// Postgres to sum by search_keyword for the given date range and only
// ships back one row per distinct keyword. See whatsapp_category_breakdown
// in sql/schema.sql.
async function fetchCategoryBreakdown(dateFrom, dateTo) {
  const params = { date_from: dateFrom, date_to: dateTo };
  const data = await fetchAllPaginated(opts =>
    supabase.rpc('whatsapp_category_breakdown', params, opts)
  );
  return data.map(r => ({
    searchKeyword: r.search_keyword,
    total: r.total,
    sent: r.sent,
    delivered: r.delivered,
    converted: r.converted,
    enriched: r.enriched,
    approved: r.approved,
  }));
}

// ---- Date-wise notes ----

const noteModalOverlay = document.getElementById('noteModalOverlay');
const noteModalDate = document.getElementById('noteModalDate');
const noteListEl = document.getElementById('noteList');
const noteForm = document.getElementById('noteForm');
const noteInput = document.getElementById('noteInput');
const noteModalClose = document.getElementById('noteModalClose');

async function fetchNotes(){
  const { data, error } = await supabase
    .from('dashboard_notes')
    .select('*')
    .order('note_date', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) throw error;
  const byDate = {};
  (data || []).forEach(n => {
    if (!byDate[n.note_date]) byDate[n.note_date] = [];
    byDate[n.note_date].push(n);
  });
  return byDate;
}

function renderNoteList(date){
  const notes = NOTES_BY_DATE[date] || [];
  noteListEl.innerHTML = notes.length
    ? notes.map(n => `
      <div class="note-item" data-id="${n.id}">
        <div class="note-item-body"></div>
        <div class="note-item-meta">
          <span class="note-item-time">${new Date(n.created_at).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</span>
          <button type="button" class="note-item-del" data-id="${n.id}">Delete</button>
        </div>
      </div>
    `).join('')
    : `<div class="note-empty">No notes for this date yet.</div>`;
  // Set body text via textContent (not templated into the HTML above) so
  // note text can never be interpreted as markup.
  notes.forEach(n => {
    const el = noteListEl.querySelector(`.note-item[data-id="${n.id}"] .note-item-body`);
    if (el) el.textContent = n.body;
  });
}

function openNoteModal(date){
  currentNoteDate = date;
  noteModalDate.textContent = formatDMY(date);
  renderNoteList(date);
  noteInput.value = '';
  noteModalOverlay.classList.remove('hidden');
  noteInput.focus();
}
function closeNoteModal(){
  noteModalOverlay.classList.add('hidden');
  currentNoteDate = null;
}
noteModalClose.addEventListener('click', closeNoteModal);
noteModalOverlay.addEventListener('click', (e) => { if (e.target === noteModalOverlay) closeNoteModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !noteModalOverlay.classList.contains('hidden')) closeNoteModal();
});

noteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = noteInput.value.trim();
  if (!body || !currentNoteDate) return;
  const submitBtn = noteForm.querySelector('button');
  submitBtn.disabled = true;
  const { error } = await supabase.from('dashboard_notes').insert({ note_date: currentNoteDate, body });
  submitBtn.disabled = false;
  if (error) { alert('Could not save note: ' + error.message); return; }
  NOTES_BY_DATE = await fetchNotes();
  noteInput.value = '';
  renderNoteList(currentNoteDate);
  renderDayWiseNoteBadges();
  renderNotesTab();
});

noteListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('.note-item-del');
  if (!btn) return;
  if (!confirm('Delete this note?')) return;
  const { error } = await supabase.from('dashboard_notes').delete().eq('id', btn.dataset.id);
  if (error) { alert('Could not delete note: ' + error.message); return; }
  NOTES_BY_DATE = await fetchNotes();
  renderNoteList(currentNoteDate);
  renderDayWiseNoteBadges();
  renderNotesTab();
});

// Re-stamps the Notes column's badges in place from NOTES_BY_DATE, without
// re-rendering the whole Daily table (which would be redundant — nothing
// else about the rows changed).
function renderDayWiseNoteBadges(){
  document.querySelectorAll('#dayWiseTableBody .note-badge[data-date]').forEach(btn => {
    const date = btn.dataset.date;
    const count = (NOTES_BY_DATE[date] || []).length;
    btn.classList.toggle('has-note', count > 0);
    btn.textContent = count > 0 ? `📝 ${count}` : '+📋';
  });
}

// ---- Dashboard state (ported from the original static dashboard) ----

let RAW = [];
let RAW_CATEGORY = [];
let NOTES_BY_DATE = {};
let currentNoteDate = null;
let minDate, maxDate, allDates;
let sortKey = 'total', sortDir = -1;
let categorySortKey = 'sent', categorySortDir = -1;
let staticListenersBound = false;

const CHANNEL_NAMES = {
  1:'RFQ - Category', 2:'Advanced Best Deal', 3:'Best Deal', 4:'VN Call', 5:'DVN Click',
  6:'Target - Corejd', 7:'Whatsapp Lead', 8:'Banner Website', 9:'RFQ - Company', 10:'IRO',
  11:'SMS/EMAIL From Website Detail Page', 12:'Buy Online', 13:'Online Consultation',
  14:'Order Shopfront', 15:'Virtual Number Click', 16:'VN Click', 17:'Sms Search',
  18:'Premium Target', 21:'Brand Connect', 25:'SMS Search', 26:'Premium Target Leads',
  27:'Send Enquiry by Email', 28:'Complete Booking', 29:'Incomplete Booking',
  30:'Target - JDMart', 31:'Open ABD', 32:'DVN Call', 33:'Map', 34:'Banner',
  35:'Bestdeal via Whatsapp', 36:'AN Click Paid', 37:'AN Click NonPaid', 38:'WhatsApp Retarget',
  40:'Retarget for Target Leads (DND)', 41:'AI Call intent', 42:'Tender-Leads',
  43:'DVN Missed Call', 44:'DVN Dialing', 79:'Test Platform'
};
function channelName(id){ return CHANNEL_NAMES[id] || ('Channel '+id); }

const dateFromEl = document.getElementById('dateFrom');
const dateToEl = document.getElementById('dateTo');
const dateFromLabelEl = document.getElementById('dateFromLabel');
const dateToLabelEl = document.getElementById('dateToLabel');

// The native <input type=date> always stores/reads its .value as ISO
// (YYYY-MM-DD) regardless of display locale — only the on-screen text
// (which we hide via CSS and replace with these labels) varies by browser.
function formatDMY(iso){
  if(!iso) return '';
  const [y,m,d] = iso.split('-');
  return `${d}-${m}-${y}`;
}
function updateDateLabels(){
  dateFromLabelEl.textContent = formatDMY(dateFromEl.value);
  dateToLabelEl.textContent = formatDMY(dateToEl.value);
}

const state = {
  Medium: new Set(),       // empty set = all selected
  'Call Status': new Set(),
  BD: new Set()
};

function uniqueSorted(key){
  return [...new Set(RAW.map(r=>r[key]))].sort((a,b)=> (typeof a==='number'&&typeof b==='number') ? a-b : String(a).localeCompare(String(b)));
}

function renderPills(containerId, values, stateKey, labelFn){
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  values.forEach(v=>{
    const p = document.createElement('div');
    p.className = 'pill active';
    p.textContent = labelFn ? labelFn(v) : v;
    p.dataset.value = v;
    p.addEventListener('click', ()=>{
      const set = state[stateKey];
      if(set.size===0){
        values.forEach(x=>{ if(x!==v) set.add(x); });
      } else if(set.has(v)){
        set.delete(v);
      } else {
        set.add(v);
      }
      updatePillStyles();
      render();
    });
    el.appendChild(p);
  });
  updatePillStylesFor(containerId, stateKey);
}

function updatePillStylesFor(containerId, stateKey){
  const el = document.getElementById(containerId);
  [...el.children].forEach(p=>{
    // p.dataset.value is always a string (HTML dataset attributes), but
    // the excluded set can hold numbers (e.g. BD is a smallint column) —
    // compare by string form so numeric filters highlight correctly too.
    const excluded = [...state[stateKey]].some(x => String(x) === p.dataset.value);
    p.classList.toggle('active', !excluded);
  });
}
function updatePillStyles(){
  updatePillStylesFor('mediumPills','Medium');
  updatePillStylesFor('callStatusPills','Call Status');
  updatePillStylesFor('bdPills','BD');
}

function passesFilter(row){
  if(row.date < dateFromEl.value || row.date > dateToEl.value) return false;
  if(state.Medium.size && state.Medium.has(row.Medium)) return false;
  if(state['Call Status'].size && state['Call Status'].has(row['Call Status'])) return false;
  if(state.BD.size && state.BD.has(row.BD)) return false;
  return true;
}

function fmt(n){ return n.toLocaleString('en-IN'); }
function pct(n,d){ return d>0 ? ((n/d)*100).toFixed(1)+'%' : '–'; }
function pctVal(n,d){ return d>0 ? (n/d)*100 : -1; }

// Cost — ₹0.107 paise per delivered WhatsApp message
const COST_PER_DELIVERED_PAISE = 10.7;
function rupee(n, decimals){ return n===null ? '–' : '₹'+n.toLocaleString('en-IN',{minimumFractionDigits:decimals, maximumFractionDigits:decimals}); }

const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function dayAbbrev(iso){
  const [y,m,d] = iso.split('-').map(Number);
  return DAY_NAMES[new Date(Date.UTC(y, m-1, d)).getUTCDay()];
}

// "Yesterday" / "Last 7 days" are relative to the real current date (not
// the latest date present in the uploaded data), so they keep working
// correctly even on days when a fresh export hasn't been uploaded yet.
function todayIso(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function addDaysIso(iso, delta){
  const [y,m,d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, d));
  dt.setUTCDate(dt.getUTCDate()+delta);
  return dt.toISOString().slice(0,10);
}

const DATE_QUICK_PILL_IDS = ['qAll','qLast15','qLast7','qYesterday','qThisMonth'];
function setActiveDateQuickPill(activeId){
  DATE_QUICK_PILL_IDS.forEach(id=>{
    document.getElementById(id).classList.toggle('active', id===activeId);
  });
}

// Weeks run Monday–Sunday, identified by their Monday's ISO date.
function weekStartIso(iso){
  const [y,m,d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, d));
  const day = dt.getUTCDay(); // 0=Sun..6=Sat
  const diffFromMonday = day===0 ? 6 : day-1;
  dt.setUTCDate(dt.getUTCDate()-diffFromMonday);
  return dt.toISOString().slice(0,10);
}
function weekLabel(weekStart){
  return `${formatDMY(weekStart)} – ${formatDMY(addDaysIso(weekStart,6))}`;
}

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function monthKeyIso(iso){ return iso.slice(0,7); } // YYYY-MM
function monthLabel(monthKey){
  const parts = monthKey.split("-").map(Number);
  return MONTH_NAMES[parts[1]-1] + " " + parts[0];
}

function setupStaticListeners(){
  if (staticListenersBound) return;
  staticListenersBound = true;

  dateFromEl.addEventListener('change', ()=>{ updateDateLabels(); onDateRangeChanged(); });
  dateToEl.addEventListener('change', ()=>{ updateDateLabels(); onDateRangeChanged(); });

  document.getElementById('qAll').addEventListener('click', ()=>{
    dateFromEl.value = minDate; dateToEl.value = maxDate; updateDateLabels(); onDateRangeChanged();
    setActiveDateQuickPill('qAll');
  });
  document.getElementById('qLast15').addEventListener('click', ()=>{
    // Anchored to the latest date with uploaded data (maxDate), not real
    // "yesterday" — if today's (or yesterday's) export hasn't been
    // uploaded yet, the window ends at the most recent available day
    // instead of showing a trailing gap.
    dateFromEl.value = addDaysIso(maxDate, -14); dateToEl.value = maxDate; updateDateLabels(); onDateRangeChanged();
    setActiveDateQuickPill('qLast15');
  });
  document.getElementById('qLast7').addEventListener('click', ()=>{
    // Excludes today — a 7-day window ending yesterday, since today's data
    // is likely still incomplete.
    const yesterday = addDaysIso(todayIso(), -1);
    dateFromEl.value = addDaysIso(yesterday, -6); dateToEl.value = yesterday; updateDateLabels(); onDateRangeChanged();
    setActiveDateQuickPill('qLast7');
  });
  document.getElementById('qYesterday').addEventListener('click', ()=>{
    const yesterday = addDaysIso(todayIso(), -1);
    dateFromEl.value = yesterday; dateToEl.value = yesterday; updateDateLabels(); onDateRangeChanged();
    setActiveDateQuickPill('qYesterday');
  });
  document.getElementById('qThisMonth').addEventListener('click', ()=>{
    const today = todayIso();
    const [y,m] = today.split('-');
    const monthStart = `${y}-${m}-01`;
    // "Current month till current date minus 1" — i.e. up to yesterday,
    // not including today's (likely still-incomplete) data.
    dateFromEl.value = monthStart; dateToEl.value = addDaysIso(today, -1); updateDateLabels(); onDateRangeChanged();
    setActiveDateQuickPill('qThisMonth');
  });

  document.getElementById('resetBtn').addEventListener('click', ()=>{
    state.Medium.clear(); state['Call Status'].clear(); state.BD.clear();
    dateFromEl.value = addDaysIso(maxDate, -14); dateToEl.value = maxDate;
    updateDateLabels();
    updatePillStyles();
    setActiveDateQuickPill('qLast15');
    onDateRangeChanged();
  });

  const tabs = [
    { btn: document.getElementById('tabBtnDayWise'), panel: document.getElementById('dayWiseTab') },
    { btn: document.getElementById('tabBtnWeekly'), panel: document.getElementById('weeklyTab') },
    { btn: document.getElementById('tabBtnMonthly'), panel: document.getElementById('monthlyTab') },
    { btn: document.getElementById('tabBtnChannel'), panel: document.getElementById('channelTab') },
    { btn: document.getElementById('tabBtnCategory'), panel: document.getElementById('categoryTab') },
    { btn: document.getElementById('tabBtnTrends'), panel: document.getElementById('trendsTab') },
    { btn: document.getElementById('tabBtnNotes'), panel: document.getElementById('notesTab') },
  ];
  tabs.forEach(({ btn, panel }) => {
    btn.addEventListener('click', () => {
      tabs.forEach(t=>{
        t.btn.classList.toggle('active', t.btn===btn);
        t.panel.classList.toggle('hidden', t.panel!==panel);
      });
    });
  });

  document.getElementById('dayWiseTableBody').addEventListener('click', (e) => {
    const btn = e.target.closest('.note-badge');
    if (btn) openNoteModal(btn.dataset.date);
  });

  document.querySelectorAll('th.sortable').forEach(th=>{
    th.addEventListener('click', ()=>{
      const key = th.dataset.key;
      const isCategory = th.dataset.group === 'category';
      if(isCategory){
        if(categorySortKey===key){ categorySortDir *= -1; } else { categorySortKey = key; categorySortDir = -1; }
      } else {
        if(sortKey===key){ sortDir *= -1; } else { sortKey = key; sortDir = -1; }
      }
      const groupSelector = isCategory ? 'th.sortable[data-group="category"] .arrow' : 'th.sortable:not([data-group="category"]) .arrow';
      document.querySelectorAll(groupSelector).forEach(a=>a.textContent='');
      th.querySelector('.arrow').textContent = (isCategory ? categorySortDir : sortDir)===1 ? '▴' : '▾';
      render();
    });
  });
}

function setupDateBoundsAndFilters(){
  allDates = [...new Set(RAW.map(r=>r.date))].sort();
  minDate = allDates[0]; maxDate = allDates[allDates.length-1];

  dateFromEl.min = minDate; dateFromEl.max = maxDate;
  dateToEl.min = minDate; dateToEl.max = maxDate;
  // Default to the last 15 days ending at the latest date with uploaded
  // data (maxDate), not real "yesterday" — so the report opens on a
  // complete recent window even if today's export isn't in yet.
  dateFromEl.value = addDaysIso(maxDate, -14); dateToEl.value = maxDate;
  updateDateLabels();
  setActiveDateQuickPill('qLast15');

  const mediums = uniqueSorted('Medium');
  const callStatuses = uniqueSorted('Call Status');
  const bds = uniqueSorted('BD');

  state.Medium.clear(); state['Call Status'].clear(); state.BD.clear();

  renderPills('mediumPills', mediums, 'Medium');
  renderPills('callStatusPills', callStatuses, 'Call Status');
  renderPills('bdPills', bds, 'BD', v => 'BD '+v);
}

function render(){
  const filtered = RAW.filter(passesFilter);

  // Overall totals
  const tot = filtered.reduce((acc,r)=>{
    acc.total+=r.total; acc.sent+=r.sent; acc.delivered+=r.delivered;
    acc.converted+=r.converted; acc.enriched+=r.enriched; acc.approved+=r.approved;
    return acc;
  }, {total:0,sent:0,delivered:0,converted:0,enriched:0,approved:0});

  document.getElementById('resultCount').textContent = `${fmt(filtered.length)} segment rows → ${fmt(tot.total)} leads`;
  document.getElementById('totalRowsStamp').textContent = fmt(RAW.reduce((a,r)=>a+r.total,0));
  document.getElementById('recordSubtitle').textContent = `Filtered view: ${fmt(tot.total)} leads · ${formatDMY(dateFromEl.value)} to ${formatDMY(dateToEl.value)} · ${new Set(filtered.map(r=>r['Channel Id'])).size} channel(s)`;

  // KPI strip
  const kpis = [
    {label:'Total Leads', val: tot.total, sub:'in current filter', color:'#5c6479'},
    {label:'WhatsApp Sent', val: tot.sent, sub: pct(tot.sent,tot.total)+' of leads', color:'#0d9488', bar: tot.total? tot.sent/tot.total*100:0},
    {label:'Delivered', val: tot.delivered, sub: pct(tot.delivered,tot.sent)+' of sent', color:'#6d5bd0', bar: tot.sent? tot.delivered/tot.sent*100:0},
    {label:'Converted', val: tot.converted, sub: pct(tot.converted,tot.delivered)+' of delivered', color:'#c2760a', bar: tot.delivered? tot.converted/tot.delivered*100:0},
    {label:'Enriched', val: tot.enriched, sub: pct(tot.enriched,tot.delivered)+' of delivered', color:'#6d5bd0', bar: tot.delivered? tot.enriched/tot.delivered*100:0},
    {label:'Approved', val: tot.approved, sub: pct(tot.approved,tot.delivered)+' of delivered', color:'#d6293e', bar: tot.delivered? tot.approved/tot.delivered*100:0},
  ];
  const strip = document.getElementById('kpiStrip');
  strip.innerHTML = kpis.map(k=>`
    <div class="kpi" style="--kcolor:${k.color}">
      <div class="klabel">${k.label}</div>
      <div class="kvalue">${fmt(k.val)}</div>
      <div class="ksub">${k.sub}</div>
      ${k.bar!==undefined ? `<div class="kbar"><div class="kbar-fill" style="width:${k.bar}%"></div></div>` : ''}
    </div>
  `).join('');

  // Funnel shape panel
  document.getElementById('fSentVal').textContent = fmt(tot.sent)+' (100%)';
  document.getElementById('fSentBar').style.width = '100%';
  const delPctOfSent = tot.sent? tot.delivered/tot.sent*100 : 0;
  document.getElementById('fDelVal').textContent = `${fmt(tot.delivered)} (${delPctOfSent.toFixed(1)}%)`;
  document.getElementById('fDelBar').style.width = delPctOfSent+'%';
  const convPctOfDelivered = tot.delivered? tot.converted/tot.delivered*100 : 0;
  document.getElementById('fConvVal').textContent = `${fmt(tot.converted)} (${convPctOfDelivered.toFixed(1)}% of delivered)`;
  document.getElementById('fConvBar').style.width = convPctOfDelivered+'%';

  document.getElementById('enrichedVal').textContent = fmt(tot.enriched);
  document.getElementById('enrichedPct').textContent = pct(tot.enriched, tot.delivered)+' of delivered';
  document.getElementById('approvedVal').textContent = fmt(tot.approved);
  document.getElementById('approvedPct').textContent = pct(tot.approved, tot.delivered)+' of delivered';

  const totalCostRupees = tot.delivered * COST_PER_DELIVERED_PAISE / 100;
  const costPerConverted = tot.converted>0 ? totalCostRupees / tot.converted : null;
  const costPerEnriched = tot.enriched>0 ? totalCostRupees / tot.enriched : null;

  document.getElementById('totalCostVal').textContent = rupee(totalCostRupees, 2);
  document.getElementById('totalCostSub').textContent = `${fmt(tot.delivered)} delivered × 10.7 paise`;
  document.getElementById('costPerConvVal').textContent = rupee(costPerConverted, 2);
  document.getElementById('costPerEnrichVal').textContent = rupee(costPerEnriched, 2);

  // Channel breakdown table
  const byChannel = {};
  filtered.forEach(r=>{
    const c = r['Channel Id'];
    const bd = r.BD;
    const key = c+'|'+bd;
    if(!byChannel[key]) byChannel[key] = {channel:c,bd:bd,total:0,sent:0,delivered:0,converted:0,enriched:0,approved:0};
    byChannel[key].total+=r.total; byChannel[key].sent+=r.sent; byChannel[key].delivered+=r.delivered;
    byChannel[key].converted+=r.converted; byChannel[key].enriched+=r.enriched; byChannel[key].approved+=r.approved;
  });
  let rows = Object.values(byChannel);
  rows.forEach(r=> r.convPct = r.delivered>0 ? (r.converted/r.delivered)*100 : -1 );
  rows.sort((a,b)=> (a[sortKey]-b[sortKey])*sortDir || (a.channel-b.channel) || (a.bd-b.bd) );

  document.getElementById('channelCount').textContent = rows.length + ' channels';

  const overallConvPct = pctVal(tot.converted, tot.delivered);
  const tbody = document.getElementById('channelTableBody');
  let html = `<tr class="overall-row">
    <td>OVERALL</td>
    <td>–</td>
    <td>${fmt(tot.sent)}</td>
    <td>${fmt(tot.delivered)}</td>
    <td class="pct">${pct(tot.delivered,tot.sent)}</td>
    <td>${fmt(tot.converted)}</td>
    <td class="pct${overallConvPct>=0 && overallConvPct<10 ? ' low':''}">${pct(tot.converted,tot.delivered)}</td>
  </tr>`;
  html += rows.map(r=>{
    const isLow = r.convPct>=0 && r.convPct<10;
    return `
    <tr>
      <td>${channelName(r.channel)}</td>
      <td>${r.bd}</td>
      <td>${fmt(r.sent)}</td>
      <td>${fmt(r.delivered)}</td>
      <td class="pct">${pct(r.delivered,r.sent)}</td>
      <td>${fmt(r.converted)}</td>
      <td class="pct${isLow ? ' low':''}">${pct(r.converted,r.delivered)}</td>
    </tr>
  `;
  }).join('');
  tbody.innerHTML = html;

  renderDayWise(filtered, tot);
  renderCategoryBreakdown();
  renderTrends(filtered);
  renderWeeklyAll();
  renderMonthlyAll();
  renderNotesTab();
}

// Category Breakdown is fetched pre-aggregated (grouped by search_keyword
// in Postgres, see whatsapp_category_breakdown in sql/schema.sql) for the
// current date range -- it respects the date range filter but not the
// Medium / Call Status / BD pills, which aren't tracked at this
// granularity. RAW_CATEGORY already has one row per keyword, so no
// client-side grouping is needed here.
function renderCategoryBreakdown(){
  const rows = RAW_CATEGORY.map(r => ({ ...r }));
  rows.forEach(r=> r.convPct = r.delivered>0 ? (r.converted/r.delivered)*100 : -1 );
  rows.sort((a,b)=> {
    const av = a[categorySortKey], bv = b[categorySortKey];
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : (av-bv);
    return cmp*categorySortDir || a.searchKeyword.localeCompare(b.searchKeyword);
  });

  document.getElementById('categoryCount').textContent = rows.length + ' categor' + (rows.length===1?'y':'ies');

  const tot = RAW_CATEGORY.reduce((acc,r)=>{
    acc.total+=r.total; acc.sent+=r.sent; acc.delivered+=r.delivered; acc.converted+=r.converted;
    return acc;
  }, {total:0,sent:0,delivered:0,converted:0});
  const overallConvPct = pctVal(tot.converted, tot.delivered);

  let html = `<tr class="overall-row">
    <td>OVERALL</td>
    <td>${fmt(tot.sent)}</td>
    <td>${fmt(tot.delivered)}</td>
    <td class="pct">${pct(tot.delivered,tot.sent)}</td>
    <td>${fmt(tot.converted)}</td>
    <td class="pct${overallConvPct>=0 && overallConvPct<10 ? ' low':''}">${pct(tot.converted,tot.delivered)}</td>
  </tr>`;
  html += rows.map(r=>{
    const convPct = pctVal(r.converted, r.delivered);
    const isLow = convPct>=0 && convPct<10;
    return `
    <tr>
      <td>${r.searchKeyword}</td>
      <td>${fmt(r.sent)}</td>
      <td>${fmt(r.delivered)}</td>
      <td class="pct">${pct(r.delivered,r.sent)}</td>
      <td>${fmt(r.converted)}</td>
      <td class="pct${isLow ? ' low':''}">${pct(r.converted,r.delivered)}</td>
    </tr>
  `;
  }).join('');
  document.getElementById('categoryTableBody').innerHTML = html;
}

function renderDayWise(filtered, tot){
  const byDate = {};
  filtered.forEach(r=>{
    if(!byDate[r.date]) byDate[r.date] = {date:r.date,total:0,sent:0,delivered:0,converted:0,enriched:0,approved:0};
    const d = byDate[r.date];
    d.total+=r.total; d.sent+=r.sent; d.delivered+=r.delivered;
    d.converted+=r.converted; d.enriched+=r.enriched; d.approved+=r.approved;
  });
  const days = Object.values(byDate).sort((a,b)=> b.date.localeCompare(a.date));

  document.getElementById('dayWiseCount').textContent = days.length + ' day' + (days.length===1?'':'s');

  function costCells(delivered, converted, enriched){
    const totalCost = delivered * COST_PER_DELIVERED_PAISE / 100;
    const perConv = converted>0 ? totalCost/converted : null;
    const perEnrich = enriched>0 ? totalCost/enriched : null;
    return `<td>${rupee(totalCost,2)}</td><td>${rupee(perConv,2)}</td><td>${rupee(perEnrich,2)}</td>`;
  }

  const overallConvPct = pctVal(tot.converted, tot.delivered);
  let html = `<tr class="overall-row">
    <td>OVERALL</td>
    <td>–</td>
    <td>–</td>
    <td>${fmt(tot.sent)}</td>
    <td>${fmt(tot.delivered)}</td>
    <td class="pct">${pct(tot.delivered,tot.sent)}</td>
    <td>${fmt(tot.converted)}</td>
    <td class="pct${overallConvPct>=0 && overallConvPct<10 ? ' low':''}">${pct(tot.converted,tot.delivered)}</td>
    <td>${fmt(tot.enriched)}</td>
    <td class="pct">${pct(tot.enriched,tot.delivered)}</td>
    <td>${fmt(tot.approved)}</td>
    <td class="pct">${pct(tot.approved,tot.delivered)}</td>
    ${costCells(tot.delivered, tot.converted, tot.enriched)}
  </tr>`;

  html += days.map(d=>{
    const convPct = pctVal(d.converted, d.delivered);
    const isLow = convPct>=0 && convPct<10;
    const noteCount = (NOTES_BY_DATE[d.date] || []).length;
    const noteCell = `<button type="button" class="note-badge${noteCount>0?' has-note':''}" data-date="${d.date}">${noteCount>0 ? `📝 ${noteCount}` : '+📋'}</button>`;
    return `
    <tr>
      <td>${formatDMY(d.date)}</td>
      <td>${dayAbbrev(d.date)}</td>
      <td>${noteCell}</td>
      <td>${fmt(d.sent)}</td>
      <td>${fmt(d.delivered)}</td>
      <td class="pct">${pct(d.delivered,d.sent)}</td>
      <td>${fmt(d.converted)}</td>
      <td class="pct${isLow ? ' low':''}">${pct(d.converted,d.delivered)}</td>
      <td>${fmt(d.enriched)}</td>
      <td class="pct">${pct(d.enriched,d.delivered)}</td>
      <td>${fmt(d.approved)}</td>
      <td class="pct">${pct(d.approved,d.delivered)}</td>
      ${costCells(d.delivered, d.converted, d.enriched)}
    </tr>
  `;
  }).join('');

  document.getElementById('dayWiseTableBody').innerHTML = html;
}

// Weekly / Monthly tabs aggregate across the FULL dataset (RAW), ignoring
// the date range and Medium/Call Status/BD pill filters entirely — these
// tabs are meant to show a complete, filter-independent rollup.
function costCells(delivered, converted, enriched){
  const totalCost = delivered * COST_PER_DELIVERED_PAISE / 100;
  const perConv = converted>0 ? totalCost/converted : null;
  const perEnrich = enriched>0 ? totalCost/enriched : null;
  return `<td>${rupee(totalCost,2)}</td><td>${rupee(perConv,2)}</td><td>${rupee(perEnrich,2)}</td>`;
}

function renderPeriodTable(groups, tot, tbodyId, countElId, unitLabel, labelFn){
  const overallConvPct = pctVal(tot.converted, tot.delivered);
  let html = `<tr class="overall-row">
    <td>OVERALL</td>
    <td>${fmt(tot.sent)}</td>
    <td>${fmt(tot.delivered)}</td>
    <td class="pct">${pct(tot.delivered,tot.sent)}</td>
    <td>${fmt(tot.converted)}</td>
    <td class="pct${overallConvPct>=0 && overallConvPct<10 ? ' low':''}">${pct(tot.converted,tot.delivered)}</td>
    <td>${fmt(tot.enriched)}</td>
    <td class="pct">${pct(tot.enriched,tot.delivered)}</td>
    <td>${fmt(tot.approved)}</td>
    <td class="pct">${pct(tot.approved,tot.delivered)}</td>
    ${costCells(tot.delivered, tot.converted, tot.enriched)}
  </tr>`;

  html += groups.map(g=>{
    const convPct = pctVal(g.converted, g.delivered);
    const isLow = convPct>=0 && convPct<10;
    return `
    <tr>
      <td>${labelFn(g.key)}</td>
      <td>${fmt(g.sent)}</td>
      <td>${fmt(g.delivered)}</td>
      <td class="pct">${pct(g.delivered,g.sent)}</td>
      <td>${fmt(g.converted)}</td>
      <td class="pct${isLow ? ' low':''}">${pct(g.converted,g.delivered)}</td>
      <td>${fmt(g.enriched)}</td>
      <td class="pct">${pct(g.enriched,g.delivered)}</td>
      <td>${fmt(g.approved)}</td>
      <td class="pct">${pct(g.approved,g.delivered)}</td>
      ${costCells(g.delivered, g.converted, g.enriched)}
    </tr>
  `;
  }).join('');

  document.getElementById(tbodyId).innerHTML = html;
  document.getElementById(countElId).textContent = groups.length + ' ' + unitLabel + (groups.length===1?'':'s');
}

function groupAllBy(keyFn){
  const byKey = {};
  const tot = {total:0,sent:0,delivered:0,converted:0,enriched:0,approved:0};
  RAW.forEach(r=>{
    const key = keyFn(r.date);
    if(!byKey[key]) byKey[key] = {key,total:0,sent:0,delivered:0,converted:0,enriched:0,approved:0};
    const g = byKey[key];
    g.total+=r.total; g.sent+=r.sent; g.delivered+=r.delivered;
    g.converted+=r.converted; g.enriched+=r.enriched; g.approved+=r.approved;
    tot.total+=r.total; tot.sent+=r.sent; tot.delivered+=r.delivered;
    tot.converted+=r.converted; tot.enriched+=r.enriched; tot.approved+=r.approved;
  });
  const groups = Object.values(byKey).sort((a,b)=> b.key.localeCompare(a.key));
  return {groups, tot};
}

// Weekly / Monthly tabs show ALL data regardless of the filter bar above —
// they intentionally read from RAW, not the filtered rows passed into render().
function renderWeeklyAll(){
  const {groups, tot} = groupAllBy(weekStartIso);
  renderPeriodTable(groups, tot, 'weeklyAllTableBody', 'weeklyCount', 'week', weekLabel);
}

function renderMonthlyAll(){
  const {groups, tot} = groupAllBy(monthKeyIso);
  renderPeriodTable(groups, tot, 'monthlyAllTableBody', 'monthlyCount', 'month', monthLabel);
}

// Notes tab -- a flat, filter-independent list of every date-wise note,
// most recent note_date first (fetchNotes already returns them in that
// order). Note bodies are written via textContent, never templated into
// the HTML, so free text can't be interpreted as markup.
function renderNotesTab(){
  const tbody = document.getElementById('notesTableBody');
  if(!tbody) return;
  const dates = Object.keys(NOTES_BY_DATE).sort((a,b)=> b.localeCompare(a));
  const flat = [];
  dates.forEach(d=> (NOTES_BY_DATE[d] || []).forEach(n=> flat.push(n)));

  document.getElementById('notesCount').textContent = flat.length + ' note' + (flat.length===1?'':'s');

  if(!flat.length){
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-faint);">No notes yet -- add them from the Notes column of the Daily tab.</td></tr>`;
    return;
  }

  tbody.innerHTML = flat.map(n=>`
    <tr data-id="${n.id}">
      <td>${formatDMY(n.note_date)}</td>
      <td>${dayAbbrev(n.note_date)}</td>
      <td class="note-cell"></td>
      <td>${new Date(n.created_at).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}</td>
    </tr>
  `).join('');
  flat.forEach(n=>{
    const el = tbody.querySelector(`tr[data-id="${n.id}"] .note-cell`);
    if(el) el.textContent = n.body;
  });
}

// Percentage-point movement in Converted % / Enriched % at or above this
// is treated as a deviation worth flagging (rather than normal noise).
const DEVIATION_THRESHOLD_PTS = 2;
// Ignore channel/BD combinations too small to compare meaningfully.
const MOVERS_MIN_VOLUME = 20;

function deltaCell(delta, threshold){
  if(delta===null || delta===undefined) return `<span class="trend-flat">–</span>`;
  const sign = delta>0 ? '+' : '';
  const arrow = delta>0 ? '▲' : delta<0 ? '▼' : '';
  const isDeviation = Math.abs(delta) >= threshold;
  const cls = !isDeviation ? 'trend-flat' : (delta>0 ? 'trend-up' : 'trend-down');
  const devCls = isDeviation ? (delta>0 ? ' dev-cell dev-up' : ' dev-cell dev-down') : '';
  return `<span class="${cls}${devCls}">${arrow} ${sign}${delta.toFixed(1)}pts</span>`;
}

function wowCard(label, cur, prev, formatter){
  let delta = '';
  if(typeof prev === 'number' && prev>0){
    const diff = cur - prev;
    const pctChange = (diff/prev)*100;
    const cls = pctChange>0 ? 'trend-up' : pctChange<0 ? 'trend-down' : 'trend-flat';
    const arrow = pctChange>0 ? '▲' : pctChange<0 ? '▼' : '';
    delta = `<div class="wc-delta ${cls}">${arrow} ${pctChange>0?'+':''}${pctChange.toFixed(1)}% vs last wk</div>`;
  }
  return `<div class="wow-card"><div class="wc-label">${label}</div><div class="wc-val">${formatter(cur)}</div>${delta}</div>`;
}

function wowPctCard(label, cur, prev){
  const curTxt = cur>=0 ? cur.toFixed(1)+'%' : '–';
  let delta = '';
  if(typeof prev === 'number' && prev>=0 && cur>=0){
    const diff = cur - prev;
    const isDeviation = Math.abs(diff) >= DEVIATION_THRESHOLD_PTS;
    const cls = !isDeviation ? 'trend-flat' : (diff>0 ? 'trend-up' : 'trend-down');
    const arrow = diff>0 ? '▲' : diff<0 ? '▼' : '';
    delta = `<div class="wc-delta ${cls}">${arrow} ${diff>0?'+':''}${diff.toFixed(1)}pts vs last wk</div>`;
  }
  return `<div class="wow-card"><div class="wc-label">${label}</div><div class="wc-val">${curTxt}</div>${delta}</div>`;
}

function renderTrends(filtered){
  // 1. Bucket into Monday-Sunday weeks and aggregate.
  const byWeek = {};
  filtered.forEach(r=>{
    const wk = weekStartIso(r.date);
    if(!byWeek[wk]) byWeek[wk] = {week:wk, total:0, sent:0, delivered:0, converted:0, enriched:0, approved:0};
    const w = byWeek[wk];
    w.total+=r.total; w.sent+=r.sent; w.delivered+=r.delivered;
    w.converted+=r.converted; w.enriched+=r.enriched; w.approved+=r.approved;
  });
  const weeks = Object.values(byWeek).sort((a,b)=>a.week.localeCompare(b.week));
  weeks.forEach(w=>{
    w.convPct = pctVal(w.converted, w.delivered);
    w.enrichPct = pctVal(w.enriched, w.delivered);
  });

  document.getElementById('trendsWeekCount').textContent = weeks.length + ' week' + (weeks.length===1?'':'s');

  // 2. Weekly trend table, most recent week first — each row's Δ columns
  // compare it to the chronologically-preceding week.
  const weeklyBody = document.getElementById('weeklyTrendTableBody');
  const weeksDesc = [...weeks].reverse();
  weeklyBody.innerHTML = weeksDesc.map(w=>{
    const idx = weeks.indexOf(w);
    const prev = idx>0 ? weeks[idx-1] : null;
    const deltaConv = prev && prev.convPct>=0 && w.convPct>=0 ? w.convPct-prev.convPct : null;
    const deltaEnrich = prev && prev.enrichPct>=0 && w.enrichPct>=0 ? w.enrichPct-prev.enrichPct : null;
    return `
    <tr>
      <td>${weekLabel(w.week)}</td>
      <td>${fmt(w.sent)}</td>
      <td>${fmt(w.delivered)}</td>
      <td class="pct">${pct(w.delivered,w.sent)}</td>
      <td>${fmt(w.converted)}</td>
      <td class="pct">${pct(w.converted,w.delivered)}</td>
      <td>${deltaCell(deltaConv, DEVIATION_THRESHOLD_PTS)}</td>
      <td>${fmt(w.enriched)}</td>
      <td class="pct">${pct(w.enriched,w.delivered)}</td>
      <td>${deltaCell(deltaEnrich, DEVIATION_THRESHOLD_PTS)}</td>
      <td>${fmt(w.approved)}</td>
      <td class="pct">${pct(w.approved,w.delivered)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="12" style="text-align:center; color:var(--text-faint);">No data in range</td></tr>`;

  // 3. This-week-vs-last-week summary cards.
  const thisWeek = weeks.length ? weeks[weeks.length-1] : null;
  const lastWeek = weeks.length>1 ? weeks[weeks.length-2] : null;

  document.getElementById('trendsWeekRange').textContent = thisWeek ? weekLabel(thisWeek.week) : '–';

  const wowStrip = document.getElementById('wowStrip');
  wowStrip.innerHTML = !thisWeek ? '' : [
    wowCard('Sent', thisWeek.sent, lastWeek && lastWeek.sent, fmt),
    wowCard('Delivered', thisWeek.delivered, lastWeek && lastWeek.delivered, fmt),
    wowCard('Converted', thisWeek.converted, lastWeek && lastWeek.converted, fmt),
    wowPctCard('Converted %', thisWeek.convPct, lastWeek ? lastWeek.convPct : null),
    wowCard('Enriched', thisWeek.enriched, lastWeek && lastWeek.enriched, fmt),
    wowPctCard('Enriched %', thisWeek.enrichPct, lastWeek ? lastWeek.enrichPct : null),
    wowCard('Approved', thisWeek.approved, lastWeek && lastWeek.approved, fmt),
  ].join('');

  // 4. Channel x BD movers — which specific combinations drove the
  // Converted %/Enriched % deviation between this week and last week.
  const moversNote = document.getElementById('moversNote');
  const moversBody = document.getElementById('moversTableBody');

  if(!thisWeek || !lastWeek){
    moversNote.textContent = 'Need at least two weeks of data in the current filter to compare movers.';
    moversBody.innerHTML = '';
    return;
  }

  const thisMap = {}, lastMap = {};
  filtered.forEach(r=>{
    const wk = weekStartIso(r.date);
    const target = wk===thisWeek.week ? thisMap : wk===lastWeek.week ? lastMap : null;
    if(!target) return;
    const key = r['Channel Id']+'|'+r.BD;
    if(!target[key]) target[key] = {channel:r['Channel Id'], bd:r.BD, total:0, delivered:0, converted:0, enriched:0};
    const t = target[key];
    t.total+=r.total; t.delivered+=r.delivered; t.converted+=r.converted; t.enriched+=r.enriched;
  });

  const keys = new Set([...Object.keys(thisMap), ...Object.keys(lastMap)]);
  let movers = [];
  keys.forEach(key=>{
    const t = thisMap[key];
    const l = lastMap[key];
    const volume = (t?t.delivered:0) + (l?l.delivered:0);
    if(volume < MOVERS_MIN_VOLUME) return; // too small a sample to compare meaningfully

    const convThis = t ? pctVal(t.converted, t.delivered) : -1;
    const convLast = l ? pctVal(l.converted, l.delivered) : -1;
    const enrichThis = t ? pctVal(t.enriched, t.delivered) : -1;
    const enrichLast = l ? pctVal(l.enriched, l.delivered) : -1;
    const deltaConv = (convThis>=0 && convLast>=0) ? convThis-convLast : null;
    const deltaEnrich = (enrichThis>=0 && enrichLast>=0) ? enrichThis-enrichLast : null;

    if(!((deltaConv!==null && Math.abs(deltaConv)>=DEVIATION_THRESHOLD_PTS) ||
         (deltaEnrich!==null && Math.abs(deltaEnrich)>=DEVIATION_THRESHOLD_PTS))) return;

    movers.push({
      channel: t?t.channel:l.channel, bd: t?t.bd:l.bd,
      deliveredThis: t?t.delivered:0,
      convThis, convLast, deltaConv,
      enrichThis, enrichLast, deltaEnrich,
      maxAbsDelta: Math.max(Math.abs(deltaConv ?? 0), Math.abs(deltaEnrich ?? 0)),
    });
  });

  movers.sort((a,b)=> b.maxAbsDelta - a.maxAbsDelta);
  const topMovers = movers.slice(0, 20);

  moversNote.textContent = movers.length
    ? `${movers.length} channel/BD combination(s) moved ${DEVIATION_THRESHOLD_PTS}+ points on Converted % or Enriched % vs last week (min ${MOVERS_MIN_VOLUME} combined delivered messages). Showing top ${topMovers.length} by largest movement.`
    : `No channel/BD combination moved ${DEVIATION_THRESHOLD_PTS}+ points on Converted % or Enriched % vs last week (min ${MOVERS_MIN_VOLUME} combined delivered messages).`;

  moversBody.innerHTML = topMovers.map(m=>`
    <tr>
      <td>${channelName(m.channel)}</td>
      <td>${m.bd}</td>
      <td>${fmt(m.deliveredThis)}</td>
      <td class="pct">${m.convLast>=0 ? m.convLast.toFixed(1)+'%' : '–'}</td>
      <td class="pct">${m.convThis>=0 ? m.convThis.toFixed(1)+'%' : '–'}</td>
      <td>${deltaCell(m.deltaConv, DEVIATION_THRESHOLD_PTS)}</td>
      <td class="pct">${m.enrichLast>=0 ? m.enrichLast.toFixed(1)+'%' : '–'}</td>
      <td class="pct">${m.enrichThis>=0 ? m.enrichThis.toFixed(1)+'%' : '–'}</td>
      <td>${deltaCell(m.deltaEnrich, DEVIATION_THRESHOLD_PTS)}</td>
    </tr>
  `).join('') || `<tr><td colspan="9" style="text-align:center; color:var(--text-faint);">No significant movers</td></tr>`;
}

async function onDateRangeChanged(){
  RAW_CATEGORY = await fetchCategoryBreakdown(dateFromEl.value, dateToEl.value);
  render();
}

async function loadAndRender(){
  RAW = await fetchAllSegments();
  try {
    NOTES_BY_DATE = await fetchNotes();
  } catch (err) {
    // Don't let a missing dashboard_notes table (e.g. the SQL migration in
    // sql/schema.sql hasn't been run yet) take down the whole dashboard.
    console.error('Failed to load notes:', err);
    NOTES_BY_DATE = {};
  }
  setupDateBoundsAndFilters();
  RAW_CATEGORY = await fetchCategoryBreakdown(dateFromEl.value, dateToEl.value);
  setupStaticListeners();
  render();
}
