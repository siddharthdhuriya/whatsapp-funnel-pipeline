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

async function fetchAllSegments() {
  const pageSize = 1000;
  let from = 0;
  let all = [];
  while (true) {
    const { data, error } = await supabase
      .from('whatsapp_funnel_summary')
      .select('*')
      .range(from, from + pageSize - 1);
    if (error) throw error;
    all = all.concat(data);
    if (!data.length || data.length < pageSize) break;
    from += pageSize;
  }
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

// ---- Dashboard state (ported from the original static dashboard) ----

let RAW = [];
let minDate, maxDate, allDates;
let sortKey = 'total', sortDir = -1;
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
        set.delete(v);
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
    const v = p.dataset.value;
    const excluded = state[stateKey].has(v);
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

function setupStaticListeners(){
  if (staticListenersBound) return;
  staticListenersBound = true;

  dateFromEl.addEventListener('change', render);
  dateToEl.addEventListener('change', render);

  document.getElementById('qAll').addEventListener('click', ()=>{
    dateFromEl.value = minDate; dateToEl.value = maxDate; render();
  });
  document.getElementById('qLast3').addEventListener('click', ()=>{
    const idx = Math.max(0, allDates.length-3);
    dateFromEl.value = allDates[idx]; dateToEl.value = maxDate; render();
  });
  document.getElementById('qYesterday').addEventListener('click', ()=>{
    const idx = Math.max(0, allDates.length-2);
    dateFromEl.value = allDates[idx]; dateToEl.value = allDates[idx]; render();
  });

  document.getElementById('resetBtn').addEventListener('click', ()=>{
    state.Medium.clear(); state['Call Status'].clear(); state.BD.clear();
    dateFromEl.value = minDate; dateToEl.value = maxDate;
    updatePillStyles();
    render();
  });

  document.querySelectorAll('th.sortable').forEach(th=>{
    th.addEventListener('click', ()=>{
      const key = th.dataset.key;
      if(sortKey===key){ sortDir *= -1; } else { sortKey = key; sortDir = -1; }
      document.querySelectorAll('th.sortable .arrow').forEach(a=>a.textContent='');
      th.querySelector('.arrow').textContent = sortDir===1 ? '▴' : '▾';
      render();
    });
  });
}

function setupDateBoundsAndFilters(){
  allDates = [...new Set(RAW.map(r=>r.date))].sort();
  minDate = allDates[0]; maxDate = allDates[allDates.length-1];

  dateFromEl.min = minDate; dateFromEl.max = maxDate;
  dateToEl.min = minDate; dateToEl.max = maxDate;
  dateFromEl.value = minDate; dateToEl.value = maxDate;

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
  document.getElementById('recordSubtitle').textContent = `Filtered view: ${fmt(tot.total)} leads · ${dateFromEl.value} to ${dateToEl.value} · ${new Set(filtered.map(r=>r['Channel Id'])).size} channel(s)`;

  // KPI strip
  const kpis = [
    {label:'Total Leads', val: tot.total, sub:'in current filter', color:'#5c6479'},
    {label:'WhatsApp Sent', val: tot.sent, sub: pct(tot.sent,tot.total)+' of leads', color:'#0d9488', bar: tot.total? tot.sent/tot.total*100:0},
    {label:'Delivered', val: tot.delivered, sub: pct(tot.delivered,tot.sent)+' of sent', color:'#6d5bd0', bar: tot.sent? tot.delivered/tot.sent*100:0},
    {label:'Converted', val: tot.converted, sub: pct(tot.converted,tot.delivered)+' of delivered', color:'#c2760a', bar: tot.delivered? tot.converted/tot.delivered*100:0},
    {label:'Enriched', val: tot.enriched, sub: pct(tot.enriched,tot.total)+' of leads', color:'#6d5bd0', bar: tot.total? tot.enriched/tot.total*100:0},
    {label:'Approved', val: tot.approved, sub: pct(tot.approved,tot.total)+' of leads', color:'#d6293e', bar: tot.total? tot.approved/tot.total*100:0},
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
  const convPctOfSent = tot.sent? tot.converted/tot.sent*100 : 0;
  document.getElementById('fConvVal').textContent = `${fmt(tot.converted)} (${convPctOfSent.toFixed(1)}% of sent)`;
  document.getElementById('fConvBar').style.width = convPctOfSent+'%';

  document.getElementById('enrichedVal').textContent = fmt(tot.enriched);
  document.getElementById('enrichedPct').textContent = pct(tot.enriched, tot.total)+' of leads';
  document.getElementById('approvedVal').textContent = fmt(tot.approved);
  document.getElementById('approvedPct').textContent = pct(tot.approved, tot.total)+' of leads';

  // Cost — ₹0.107 paise per delivered WhatsApp message
  const COST_PER_DELIVERED_PAISE = 10.7;
  const totalCostRupees = tot.delivered * COST_PER_DELIVERED_PAISE / 100;
  const costPerConverted = tot.converted>0 ? totalCostRupees / tot.converted : null;
  const costPerEnriched = tot.enriched>0 ? totalCostRupees / tot.enriched : null;

  function rupee(n, decimals){ return n===null ? '–' : '₹'+n.toLocaleString('en-IN',{minimumFractionDigits:decimals, maximumFractionDigits:decimals}); }

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
    <td>${fmt(tot.total)}</td>
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
      <td>${fmt(r.total)}</td>
      <td>${fmt(r.sent)}</td>
      <td>${fmt(r.delivered)}</td>
      <td class="pct">${pct(r.delivered,r.sent)}</td>
      <td>${fmt(r.converted)}</td>
      <td class="pct${isLow ? ' low':''}">${pct(r.converted,r.delivered)}</td>
    </tr>
  `;
  }).join('');
  tbody.innerHTML = html;
}

async function loadAndRender(){
  RAW = await fetchAllSegments();
  setupDateBoundsAndFilters();
  setupStaticListeners();
  render();
}
