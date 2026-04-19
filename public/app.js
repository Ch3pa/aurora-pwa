'use strict';

const API = window.location.origin;

// ── Token storage ──
let TOKEN = localStorage.getItem('aurora_token') || null;
let USERNAME = localStorage.getItem('aurora_name') || null;

// ── State ──
let state = { activeTrade: null, day: {}, all: {}, recent: [] };
let allTrades = [];
let filterActive = 'all';
let eventSource = null;

// ── Utils ──
const $ = id => document.getElementById(id);
const fmt = (n, d=2) => n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(d);
const fmtPnl = n => n == null ? '—' : (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0);
const fmtPrice = n => n == null ? '—' : Number(n).toFixed(0);
const fmtTime = iso => {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const diffMin = Math.round((now - d) / 60000);
  if (diffMin < 1) return 'À l\'instant';
  if (diffMin < 60) return `Il y a ${diffMin}m`;
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('fr', {hour:'2-digit',minute:'2-digit'});
  return d.toLocaleDateString('fr', {day:'numeric',month:'short'}) + ' ' + d.toLocaleTimeString('fr',{hour:'2-digit',minute:'2-digit'});
};

function showToast(msg, duration=2500) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}
function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p); }

// ── Auth screen ──
function showAuthScreen() {
  $('auth-screen').style.display = 'flex';
  $('app-screen').style.display = 'none';
}
function showAppScreen() {
  $('auth-screen').style.display = 'none';
  $('app-screen').style.display = 'flex';
  $('header-username').textContent = USERNAME || '';
}

// Register
$('btn-register').addEventListener('click', async () => {
  const name = $('auth-name').value.trim();
  if (!name) { showToast('Entre un pseudo'); return; }
  try {
    const res = await fetch(`${API}/api/register`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name}) });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Erreur'); return; }
    saveSession(data.token, data.name);
    showToast(`Compte créé ! Ton token : ${data.token}`);
    init();
  } catch { showToast('Erreur réseau'); }
});

// Login with token
$('btn-login').addEventListener('click', async () => {
  const token = $('auth-token').value.trim();
  if (!token) { showToast('Entre ton token'); return; }
  try {
    const res = await fetch(`${API}/api/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({token}) });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Token invalide'); return; }
    saveSession(data.token, data.name);
    init();
  } catch { showToast('Erreur réseau'); }
});

// Logout
$('btn-logout').addEventListener('click', () => {
  localStorage.removeItem('aurora_token');
  localStorage.removeItem('aurora_name');
  TOKEN = null; USERNAME = null;
  if (eventSource) eventSource.close();
  showAuthScreen();
});

// Toggle login/register forms
$('link-show-login').addEventListener('click', () => {
  $('register-form').style.display = 'none';
  $('login-form').style.display = 'block';
});
$('link-show-register').addEventListener('click', () => {
  $('login-form').style.display = 'none';
  $('register-form').style.display = 'block';
});

function saveSession(token, name) {
  TOKEN = token; USERNAME = name;
  localStorage.setItem('aurora_token', token);
  localStorage.setItem('aurora_name', name);
}

// ── Service Worker ──
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('/sw.js'); } catch(e) { console.warn('[SW]', e); }
}

// ── SSE ──
function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API}/api/${TOKEN}/stream`);
  eventSource.addEventListener('state', e => {
    const d = JSON.parse(e.data);
    state.activeTrade = d.activeTrade; state.day = d.day; state.recent = d.recent || [];
    renderAll(); setOnline(true);
  });
  eventSource.addEventListener('entry', e => {
    const trade = JSON.parse(e.data);
    state.activeTrade = trade;
    renderActiveBanner(); renderActiveCard(); renderDayStats();
    showToast((trade.direction === 'BUY' ? '▲ LONG' : '▼ SHORT') + ' — Entrée confirmée');
    vibrate([100,50,100]);
  });
  eventSource.addEventListener('close', e => {
    const { trade, day } = JSON.parse(e.data);
    state.activeTrade = null; state.day = day;
    state.recent.unshift(trade); allTrades.unshift(trade);
    renderAll();
    showToast(trade.result === 'TP1' ? `✔ TP1 — ${fmtPnl(trade.pnl)}` : `✖ SL — ${fmtPnl(trade.pnl)}`, 3000);
    vibrate([200]);
  });
  eventSource.addEventListener('manual', e => {
    const { trade, day } = JSON.parse(e.data);
    state.day = day; state.recent.unshift(trade); allTrades.unshift(trade);
    renderTradesList(); renderDayStats(); showToast('Trade ajouté');
  });
  eventSource.onerror = () => { setOnline(false); setTimeout(connectSSE, 3000); };
}

function setOnline(online) {
  $('live-dot').classList.toggle('online', online);
  $('live-label').classList.toggle('online', online);
  $('live-label').textContent = online ? 'LIVE' : 'OFFLINE';
  $('header-sub').textContent = online ? 'Connecté · SSE' : 'Reconnexion...';
}

// ── Load data ──
async function loadState() {
  try {
    const res = await fetch(`${API}/api/${TOKEN}/state`);
    if (!res.ok) { logout(); return; }
    const d = await res.json();
    state.activeTrade = d.activeTrade; state.day = d.day; state.all = d.all; state.recent = d.recent || [];
  } catch(e) { console.warn('loadState:', e); }
}

async function loadAllTrades() {
  try {
    const res = await fetch(`${API}/api/${TOKEN}/trades`);
    allTrades = await res.json();
  } catch(e) { console.warn('loadAllTrades:', e); }
}

// ── Render ──
function renderAll() {
  renderDayStats(); renderActiveBanner(); renderActiveCard();
  renderRecentList(); renderTradesList(); renderStats(); renderWebhookUrl();
}

function renderDayStats() {
  const d = state.day; const pnl = d.pnl || 0;
  const pnlEl = $('d-pnl'); pnlEl.textContent = fmtPnl(pnl); pnlEl.className = 'day-val ' + (pnl >= 0 ? 'green' : 'red');
  $('d-rr').textContent = (d.rr >= 0 ? '+' : '') + (d.rr || 0).toFixed(1) + 'R';
  const wr = d.wr || 0; const wrEl = $('d-wr');
  wrEl.textContent = wr.toFixed(1) + '%'; wrEl.className = 'day-val ' + (wr >= 50 ? 'green' : 'red');
  $('d-trades').textContent = (d.total || 0) + ' trade' + (d.total !== 1 ? 's' : '');
  $('d-tp').textContent = d.tp || 0; $('d-sl').textContent = d.sl || 0;
}

function renderActiveBanner() {
  const banner = $('active-banner'); const t = state.activeTrade;
  if (!t) { banner.style.display = 'none'; return; }
  banner.style.display = 'block';
  $('active-dir').textContent = t.direction === 'BUY' ? '▲ LONG' : '▼ SHORT';
  $('active-dir').style.color = t.direction === 'BUY' ? 'var(--green)' : 'var(--red)';
  $('active-levels').innerHTML = `E <span>${fmtPrice(t.entry)}</span> · SL <span style="color:var(--red)">${fmtPrice(t.sl)}</span> · TP <span style="color:var(--green)">${fmtPrice(t.tp1)}</span>`;
  $('active-lot').textContent = t.lot ? t.lot.toFixed(3) + ' lots' : '';
  const score = t.confirmScore || 0; const pct = score / 3 * 100;
  const col = score >= 3 ? 'var(--green)' : score >= 2 ? 'var(--gold)' : 'var(--red)';
  $('confirm-bar').innerHTML = `<div class="confirm-bar-fill" style="width:${pct}%;background:${col}"></div>`;
}

function renderActiveCard() {
  const t = state.activeTrade; const card = $('active-card'); const noActive = $('no-active');
  if (!t) { card.style.display = 'none'; noActive.style.display = 'block'; return; }
  card.style.display = 'block'; noActive.style.display = 'none';
  $('ac-symbol').innerHTML = (t.symbol||'NAS100') + ' <span class="pill '+(t.direction==='BUY'?'pill-long':'pill-short')+'">'+(t.direction==='BUY'?'LONG':'SHORT')+'</span>';
  $('ac-time').textContent = fmtTime(t.timestamp);
  $('ac-entry').textContent = fmtPrice(t.entry); $('ac-sl').textContent = fmtPrice(t.sl); $('ac-tp').textContent = fmtPrice(t.tp1);
  $('ac-lot').textContent = t.lot ? t.lot.toFixed(3) + ' lots' : '';
  const score = t.confirmScore || 0;
  $('ac-dots').innerHTML = [0,1,2].map(i => `<div class="confirm-dot ${i < score ? 'on' : ''}"></div>`).join('');
}

function renderRecentList() {
  const list = $('recent-list'); const trades = state.recent.slice(0,5);
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
      <div><div class="tc-symbol">${t.symbol||'NAS100'} <span class="pill ${dirClass}">${dir}</span></div><div class="tc-time">${fmtTime(t.timestamp)}</div></div>
      <span class="pill ${resultClass}">${t.result||'—'}</span>
    </div>
    <div class="levels-row">
      <div class="lvl"><div class="lvl-l">ENTRY</div><div class="lvl-v">${fmtPrice(t.entry)}</div></div>
      <div class="lvl"><div class="lvl-l">SL</div><div class="lvl-v red">${fmtPrice(t.sl)}</div></div>
      <div class="lvl"><div class="lvl-l">TP1</div><div class="lvl-v green">${fmtPrice(t.tp1)}</div></div>
    </div>
    <div class="tc-footer">
      <div class="tc-result ${pnlClass}">${fmtPnl(t.pnl)} · ${t.rr >= 0 ? '+' : ''}${(t.rr||0).toFixed(1)}R</div>
      <div class="tc-lot">${t.lot ? t.lot.toFixed(3)+' lots' : ''}</div>
    </div>
  </div>`;
}

function renderTradesList() {
  const list = $('trades-list');
  let trades = [...allTrades, ...state.recent.filter(t => !allTrades.find(a => a.id === t.id))];
  const seen = new Set(); trades = trades.filter(t => { if(seen.has(t.id)) return false; seen.add(t.id); return true; });
  if (filterActive === 'TP1') trades = trades.filter(t => t.result === 'TP1');
  else if (filterActive === 'SL') trades = trades.filter(t => t.result === 'SL');
  else if (filterActive === 'today') { const today = new Date().toDateString(); trades = trades.filter(t => new Date(t.timestamp).toDateString() === today); }
  if (!trades.length) { list.innerHTML = '<div class="empty-state">Aucun trade</div>'; return; }
  list.innerHTML = trades.slice(0,30).map(t => tradeCardHTML(t)).join('');
}

function renderStats() {
  const a = state.all; if (!a) return;
  $('s-total').textContent = a.total || 0;
  const wrEl = $('s-wr'); wrEl.textContent = (a.wr||0).toFixed(1)+'%'; wrEl.className = 'day-val '+((a.wr||0)>=50?'green':'red');
  const pnlEl = $('s-pnl'); pnlEl.textContent = fmtPnl(a.pnl); pnlEl.className = 'day-val '+((a.pnl||0)>=0?'green':'red');
  const rrEl = $('s-rr'); rrEl.textContent = (a.rr>=0?'+':'')+(a.rr||0).toFixed(1)+'R'; rrEl.className = 'day-val '+((a.rr||0)>=0?'green':'red');
  renderWeeklyChart(); renderDonut(a.tp||0, a.sl||0);
  $('leg-tp').textContent = a.tp||0; $('leg-sl').textContent = a.sl||0;
}

function renderWeeklyChart() {
  const chart = $('weekly-chart');
  const allT = [...allTrades, ...state.recent];
  const byDay = {};
  allT.forEach(t => { const d = new Date(t.timestamp); const key = d.toDateString(); if (!byDay[key]) byDay[key] = { pnl:0, label:d.toLocaleDateString('fr',{weekday:'short'}) }; byDay[key].pnl += t.pnl||0; });
  const entries = Object.values(byDay).slice(-5);
  if (!entries.length) { chart.innerHTML = '<div style="font-size:11px;color:var(--muted);text-align:center;padding:10px">Aucune donnée</div>'; return; }
  const maxAbs = Math.max(...entries.map(e => Math.abs(e.pnl)), 1);
  chart.innerHTML = entries.map(e => { const pct = Math.abs(e.pnl)/maxAbs*100; const pos = e.pnl>=0; return `<div class="chart-row"><div class="chart-day">${e.label.slice(0,3)}</div><div class="bar-bg"><div class="bar-fill ${pos?'bar-g':'bar-r'}" style="width:${pct}%"></div></div><div class="chart-amt ${pos?'green':'red'}">${fmtPnl(e.pnl)}</div></div>`; }).join('');
}

function renderDonut(tp, sl) {
  const svg = $('donut-svg'); const total = tp+sl;
  if (!total) { svg.innerHTML = '<circle cx="60" cy="60" r="40" fill="none" stroke="#222" stroke-width="18"/>'; return; }
  const tpAngle = (tp/total)*360;
  const p = (angle, r) => { const rad=(angle-90)*Math.PI/180; return {x:60+r*Math.cos(rad),y:60+r*Math.sin(rad)}; };
  const arc = (s,e,r,col) => { const large=e-s>180?1:0; const sp=p(s,r); const ep=p(e,r); return `<path d="M${sp.x},${sp.y} A${r},${r} 0 ${large},1 ${ep.x},${ep.y}" fill="none" stroke="${col}" stroke-width="18" stroke-linecap="round"/>`; };
  const slA = tpAngle===360?359.9:tpAngle;
  svg.innerHTML = (tp>0?arc(0,slA,40,'var(--green)'):'')+(sl>0?arc(slA,360,40,'var(--red)'):'')+`<text x="60" y="65" text-anchor="middle" font-size="14" font-weight="700" fill="var(--text)" font-family="Space Mono,monospace">${Math.round(tp/total*100)}%</text>`;
}

function renderWebhookUrl() {
  const url = `${window.location.origin}/webhook/${TOKEN}`;
  $('webhook-url').textContent = url;
  $('my-token').textContent = TOKEN;
}

// ── Manual form ──
$('submit-manual').addEventListener('click', async () => {
  const body = { symbol:$('f-symbol').value, direction:$('f-dir').value, entry:parseFloat($('f-entry').value)||null, lot:parseFloat($('f-lot').value)||null, sl:parseFloat($('f-sl').value)||null, tp1:parseFloat($('f-tp').value)||null, result:$('f-result').value, pnl:parseFloat($('f-pnl').value)||0 };
  try {
    await fetch(`${API}/api/${TOKEN}/trades`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    ['f-entry','f-lot','f-sl','f-tp','f-pnl'].forEach(id => $(id).value='');
    showToast('Trade enregistré ✓');
  } catch { showToast('Erreur réseau'); }
});

// ── Tabs ──
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
    tab.classList.add('active'); $(`tab-${name}`).classList.add('active');
    if (name === 'stats') loadAllTrades().then(() => renderStats());
    if (name === 'trades') loadAllTrades().then(() => renderTradesList());
  });
});

// ── Filters ──
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); filterActive = btn.dataset.filter; renderTradesList();
  });
});

// ── Copy ──
$('copy-webhook').addEventListener('click', () => {
  const url = `${window.location.origin}/webhook/${TOKEN}`;
  navigator.clipboard.writeText(url).then(() => showToast('URL copiée !')).catch(() => showToast(url));
});
$('copy-token').addEventListener('click', () => {
  navigator.clipboard.writeText(TOKEN).then(() => showToast('Token copié !')).catch(() => showToast(TOKEN));
});

// ── Push ──
$('enable-push').addEventListener('click', async () => {
  if (!('Notification' in window)) { showToast('Non supporté'); return; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { showToast('Permission refusée'); return; }
  $('push-status').textContent = '✓ Notifications activées'; $('push-status').style.color = 'var(--green)';
  showToast('Notifications activées !');
});

// ── Init ──
async function init() {
  if (!TOKEN) { showAuthScreen(); return; }
  showAppScreen();
  await registerSW();
  await loadState();
  await loadAllTrades();
  renderAll();
  connectSSE();
}

init();
