'use strict';

// ── Config ──
const API = window.location.origin;

// ── State ──
let state = { activeTrade: null, day: {}, all: {}, recent: [] };
let allTrades = [];
let filterActive = 'all';
let eventSource = null;

// ── Utils ──
const $ = id => document.getElementById(id);
const fmt = (n, digits=2) => n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(digits);
const fmtPnl = n => n == null ? '—' : (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0);
const fmtPrice = n => n == null ? '—' : Number(n).toFixed(0);
const fmtTime = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffMin = Math.round((now - d) / 60000);
  if (diffMin < 1) return 'À l\'instant';
  if (diffMin < 60) return `Il y a ${diffMin}m`;
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('fr', {hour:'2-digit',minute:'2-digit'});
  return d.toLocaleDateString('fr', {day:'numeric',month:'short'}) + ' ' + d.toLocaleTimeString('fr',{hour:'2-digit',minute:'2-digit'});
};

function showToast(msg, duration=2500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

// ── Service Worker + Push ──
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
    console.log('[SW] registered');
  } catch(e) { console.warn('[SW]', e); }
}

async function enablePush() {
  if (!('Notification' in window)) { showToast('Notifications non supportées'); return; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { showToast('Permission refusée'); return; }
  $('push-status').textContent = '✓ Notifications activées';
  $('push-status').style.color = 'var(--green)';
  showToast('Notifications activées !');
  // In production: get VAPID public key, create push subscription, POST to /api/push/subscribe
}

// ── SSE ──
function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API}/api/stream`);

  eventSource.addEventListener('state', e => {
    const d = JSON.parse(e.data);
    state.activeTrade = d.activeTrade;
    state.day = d.day;
    state.recent = d.recent || [];
    renderAll();
    setOnline(true);
  });

  eventSource.addEventListener('entry', e => {
    const trade = JSON.parse(e.data);
    state.activeTrade = trade;
    renderActiveBanner();
    renderActiveCard();
    renderDayStats();
    showToast((trade.direction === 'BUY' ? '▲ LONG' : '▼ SHORT') + ' — Entrée confirmée');
    vibrate([100, 50, 100]);
  });

  eventSource.addEventListener('close', e => {
    const { trade, day } = JSON.parse(e.data);
    state.activeTrade = null;
    state.day = day;
    state.recent.unshift(trade);
    allTrades.unshift(trade);
    renderAll();
    const msg = trade.result === 'TP1' ? `✔ TP1 — ${fmtPnl(trade.pnl)}` : `✖ SL — ${fmtPnl(trade.pnl)}`;
    showToast(msg, 3000);
    vibrate([200]);
  });

  eventSource.addEventListener('manual', e => {
    const { trade, day } = JSON.parse(e.data);
    state.day = day;
    state.recent.unshift(trade);
    allTrades.unshift(trade);
    renderTradesList();
    renderDayStats();
    showToast('Trade ajouté');
  });

  eventSource.onerror = () => { setOnline(false); setTimeout(connectSSE, 3000); };
}

function setOnline(online) {
  $('live-dot').classList.toggle('online', online);
  $('live-label').classList.toggle('online', online);
  $('live-label').textContent = online ? 'LIVE' : 'OFFLINE';
  $('header-sub').textContent = online ? 'Connecté · SSE' : 'Reconnexion...';
}

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// ── Load initial state ──
async function loadState() {
  try {
    const res = await fetch(`${API}/api/state`);
    const d = await res.json();
    state.activeTrade = d.activeTrade;
    state.day = d.day;
    state.all = d.all;
    state.recent = d.recent || [];
  } catch(e) { console.warn('loadState:', e); }
}

async function loadAllTrades() {
  try {
    const res = await fetch(`${API}/api/trades`);
    allTrades = await res.json();
  } catch(e) { console.warn('loadAllTrades:', e); }
}

// ── Render ──
function renderAll() {
  renderDayStats();
  renderActiveBanner();
  renderActiveCard();
  renderRecentList();
  renderTradesList();
  renderStats();
  renderWebhookUrl();
}

function renderDayStats() {
  const d = state.day;
  const pnl = d.pnl || 0;
  const pnlEl = $('d-pnl');
  pnlEl.textContent = fmtPnl(pnl);
  pnlEl.className = 'day-val ' + (pnl >= 0 ? 'green' : 'red');
  $('d-rr').textContent = (d.rr >= 0 ? '+' : '') + (d.rr || 0).toFixed(1) + 'R';
  const wr = d.wr || 0;
  const wrEl = $('d-wr');
  wrEl.textContent = wr.toFixed(1) + '%';
  wrEl.className = 'day-val ' + (wr >= 50 ? 'green' : 'red');
  $('d-trades').textContent = (d.total || 0) + ' trade' + (d.total !== 1 ? 's' : '');
  $('d-tp').textContent = d.tp || 0;
  $('d-sl').textContent = d.sl || 0;
}

function renderActiveBanner() {
  const banner = $('active-banner');
  const t = state.activeTrade;
  if (!t) { banner.style.display = 'none'; return; }
  banner.style.display = 'block';
  $('active-dir').textContent = t.direction === 'BUY' ? '▲ LONG' : '▼ SHORT';
  $('active-dir').style.color = t.direction === 'BUY' ? 'var(--green)' : 'var(--red)';
  $('active-levels').innerHTML = `E <span>${fmtPrice(t.entry)}</span> · SL <span style="color:var(--red)">${fmtPrice(t.sl)}</span> · TP <span style="color:var(--green)">${fmtPrice(t.tp1)}</span>`;
  $('active-lot').textContent = t.lot ? t.lot.toFixed(3) + ' lots' : '';
  // confirm bar
  const score = t.confirmScore || 0;
  const pct = score / 3 * 100;
  const col = score >= 3 ? 'var(--green)' : score >= 2 ? 'var(--gold)' : 'var(--red)';
  $('confirm-bar').innerHTML = `<div class="confirm-bar-fill" style="width:${pct}%;background:${col}"></div>`;
}

function renderActiveCard() {
  const t = state.activeTrade;
  const card = $('active-card');
  const noActive = $('no-active');
  if (!t) { card.style.display = 'none'; noActive.style.display = 'block'; return; }
  card.style.display = 'block';
  noActive.style.display = 'none';
  $('ac-symbol').textContent = t.symbol || 'NAS100';
  $('ac-symbol').innerHTML = (t.symbol || 'NAS100') + ' <span class="pill ' + (t.direction === 'BUY' ? 'pill-long' : 'pill-short') + '">' + (t.direction === 'BUY' ? 'LONG' : 'SHORT') + '</span>';
  $('ac-time').textContent = fmtTime(t.timestamp);
  $('ac-entry').textContent = fmtPrice(t.entry);
  $('ac-sl').textContent = fmtPrice(t.sl);
  $('ac-tp').textContent = fmtPrice(t.tp1);
  $('ac-lot').textContent = t.lot ? t.lot.toFixed(3) + ' lots' : '';
  const score = t.confirmScore || 0;
  $('ac-dots').innerHTML = [0,1,2].map(i => `<div class="confirm-dot ${i < score ? 'on' : ''}"></div>`).join('');
}

function renderRecentList() {
  const list = $('recent-list');
  const trades = state.recent.slice(0, 5);
  if (!trades.length) { list.innerHTML = '<div class="empty-state">Aucun trade</div>'; return; }
  list.innerHTML = trades.map(t => tradeCardHTML(t)).join('');
}

function tradeCardHTML(t) {
  const dir = t.direction === 'BUY' ? 'LONG' : 'SHORT';
  const dirClass = t.direction === 'BUY' ? 'pill-long' : 'pill-short';
  const resultClass = t.result === 'TP1' ? 'pill-tp' : 'pill-sl';
  const pnlClass = (t.pnl || 0) >= 0 ? 'green' : 'red';
  return `<div class="trade-card">
    <div class="tc-header">
      <div>
        <div class="tc-symbol">${t.symbol || 'NAS100'} <span class="pill ${dirClass}">${dir}</span></div>
        <div class="tc-time">${fmtTime(t.timestamp)}</div>
      </div>
      <span class="pill ${resultClass}">${t.result || '—'}</span>
    </div>
    <div class="levels-row">
      <div class="lvl"><div class="lvl-l">ENTRY</div><div class="lvl-v">${fmtPrice(t.entry)}</div></div>
      <div class="lvl"><div class="lvl-l">SL</div><div class="lvl-v red">${fmtPrice(t.sl)}</div></div>
      <div class="lvl"><div class="lvl-l">TP1</div><div class="lvl-v green">${fmtPrice(t.tp1)}</div></div>
    </div>
    <div class="tc-footer">
      <div class="tc-result ${pnlClass}">${fmtPnl(t.pnl)} · ${t.rr >= 0 ? '+' : ''}${(t.rr||0).toFixed(1)}R</div>
      <div class="tc-lot">${t.lot ? t.lot.toFixed(3) + ' lots' : ''}</div>
    </div>
  </div>`;
}

function renderTradesList() {
  const list = $('trades-list');
  let trades = [...allTrades, ...state.recent.filter(t => !allTrades.find(a => a.id === t.id))];
  // deduplicate
  const seen = new Set();
  trades = trades.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });

  if (filterActive === 'TP1') trades = trades.filter(t => t.result === 'TP1');
  else if (filterActive === 'SL') trades = trades.filter(t => t.result === 'SL');
  else if (filterActive === 'today') {
    const today = new Date().toDateString();
    trades = trades.filter(t => new Date(t.timestamp).toDateString() === today);
  }

  if (!trades.length) { list.innerHTML = '<div class="empty-state">Aucun trade</div>'; return; }
  list.innerHTML = trades.slice(0, 30).map(t => tradeCardHTML(t)).join('');
}

function renderStats() {
  const a = state.all;
  if (!a) return;
  $('s-total').textContent = a.total || 0;
  const wrEl = $('s-wr');
  wrEl.textContent = (a.wr || 0).toFixed(1) + '%';
  wrEl.className = 'day-val ' + ((a.wr || 0) >= 50 ? 'green' : 'red');
  const pnlEl = $('s-pnl');
  pnlEl.textContent = fmtPnl(a.pnl);
  pnlEl.className = 'day-val ' + ((a.pnl || 0) >= 0 ? 'green' : 'red');
  const rrEl = $('s-rr');
  rrEl.textContent = (a.rr >= 0 ? '+' : '') + (a.rr || 0).toFixed(1) + 'R';
  rrEl.className = 'day-val ' + ((a.rr || 0) >= 0 ? 'green' : 'red');

  renderWeeklyChart();
  renderDonut(a.tp || 0, a.sl || 0);
  $('leg-tp').textContent = a.tp || 0;
  $('leg-sl').textContent = a.sl || 0;
}

function renderWeeklyChart() {
  const chart = $('weekly-chart');
  const days = ['Lun','Mar','Mer','Jeu','Ven'];
  // group trades by day of week (last 5 trading days)
  const now = new Date();
  const byDay = {};
  const allT = [...allTrades, ...state.recent];
  allT.forEach(t => {
    const d = new Date(t.timestamp);
    const key = d.toDateString();
    if (!byDay[key]) byDay[key] = { pnl: 0, label: d.toLocaleDateString('fr',{weekday:'short'}) };
    byDay[key].pnl += t.pnl || 0;
  });

  const entries = Object.values(byDay).slice(-5);
  if (!entries.length) { chart.innerHTML = '<div style="font-size:11px;color:var(--muted);text-align:center;padding:10px">Aucune donnée</div>'; return; }
  const maxAbs = Math.max(...entries.map(e => Math.abs(e.pnl)), 1);
  chart.innerHTML = entries.map(e => {
    const pct = Math.abs(e.pnl) / maxAbs * 100;
    const pos = e.pnl >= 0;
    return `<div class="chart-row">
      <div class="chart-day">${e.label.slice(0,3)}</div>
      <div class="bar-bg"><div class="bar-fill ${pos?'bar-g':'bar-r'}" style="width:${pct}%"></div></div>
      <div class="chart-amt ${pos?'green':'red'}">${fmtPnl(e.pnl)}</div>
    </div>`;
  }).join('');
}

function renderDonut(tp, sl) {
  const svg = $('donut-svg');
  const total = tp + sl;
  if (!total) { svg.innerHTML = '<circle cx="60" cy="60" r="40" fill="none" stroke="#222" stroke-width="18"/>'; return; }
  const tpAngle = (tp / total) * 360;
  const polarToCart = (angle, r) => {
    const rad = (angle - 90) * Math.PI / 180;
    return { x: 60 + r * Math.cos(rad), y: 60 + r * Math.sin(rad) };
  };
  const arc = (startAngle, endAngle, r, color) => {
    const large = endAngle - startAngle > 180 ? 1 : 0;
    const s = polarToCart(startAngle, r);
    const e = polarToCart(endAngle, r);
    return `<path d="M${s.x},${s.y} A${r},${r} 0 ${large},1 ${e.x},${e.y}" fill="none" stroke="${color}" stroke-width="18" stroke-linecap="round"/>`;
  };
  const slAngle = tpAngle === 360 ? 359.9 : tpAngle;
  svg.innerHTML = (tp > 0 ? arc(0, slAngle, 40, 'var(--green)') : '') +
                  (sl > 0 ? arc(slAngle, 360, 40, 'var(--red)') : '') +
                  `<text x="60" y="65" text-anchor="middle" font-size="14" font-weight="700" fill="var(--text)" font-family="Space Mono,monospace">${Math.round(tp/total*100)}%</text>`;
}

function renderWebhookUrl() {
  $('webhook-url').textContent = `${window.location.origin}/webhook`;
}

// ── Manual form ──
$('submit-manual').addEventListener('click', async () => {
  const body = {
    symbol: $('f-symbol').value,
    direction: $('f-dir').value,
    entry: parseFloat($('f-entry').value) || null,
    lot: parseFloat($('f-lot').value) || null,
    sl: parseFloat($('f-sl').value) || null,
    tp1: parseFloat($('f-tp').value) || null,
    result: $('f-result').value,
    pnl: parseFloat($('f-pnl').value) || 0,
  };
  try {
    await fetch(`${API}/api/trades`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    ['f-entry','f-lot','f-sl','f-tp','f-pnl'].forEach(id => $(id).value = '');
    showToast('Trade enregistré ✓');
  } catch(e) { showToast('Erreur réseau'); }
});

// ── Tabs ──
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${name}`).classList.add('active');
    if (name === 'stats') { loadAllTrades().then(() => renderStats()); }
    if (name === 'trades') { loadAllTrades().then(() => renderTradesList()); }
  });
});

// ── Filters ──
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filterActive = btn.dataset.filter;
    renderTradesList();
  });
});

// ── Copy webhook ──
$('copy-webhook').addEventListener('click', () => {
  const url = `${window.location.origin}/webhook`;
  navigator.clipboard.writeText(url).then(() => showToast('URL copiée !')).catch(() => showToast(url));
});

// ── Push ──
$('enable-push').addEventListener('click', enablePush);

// ── Init ──
async function init() {
  await registerSW();
  await loadState();
  await loadAllTrades();
  renderAll();
  connectSSE();
}

init();
