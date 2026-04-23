'use strict';
// ============================================================
// AURORA APP — v3 MT5-Native
// Toutes les données de trading viennent directement de MT5
// via le polling /api/:token/mt5/live et /api/:token/mt5/history
// Le webhook PineScript → aurora.py reste pour les ordres,
// mais n'alimente plus les stats.
// ============================================================

const API      = window.location.origin;
let TOKEN      = localStorage.getItem('aurora_token') || null;
let USERNAME   = localStorage.getItem('aurora_name')  || null;
let ngrokUrl   = localStorage.getItem('aurora_mt5_url') || '';

// État MT5 (source unique de vérité)
let mt5Live    = null;   // Dernier snapshot /mt5/live
let mt5History = [];     // Historique complet des trades
let mt5Online  = false;  // aurora.py joignable ?

// État trade actif (depuis SSE webhook events)
let activeTrade = null;

// UI state
let filterActive  = 'all';
let filterSource  = 'all';   // 'aurora' | 'all'
let eventSource   = null;
let _mt5Interval  = null;
let _livePrices   = {};
let _posInterval  = null;
let _hmMode       = 'hour';

const $ = id => document.getElementById(id);

// ── Formatters ──
const fmtE  = n => n == null ? '—' : (n >= 0 ? '+€' : '-€') + Math.abs(n).toFixed(2).replace('.', ',');
const fmtEs = n => n == null ? '—' : (n >= 0 ? '+€' : '-€') + Math.abs(n).toFixed(2);
const fmtP  = (n, sym) => {
  if (n == null || n === undefined) return '—';
  const v = Number(n), s = (sym || '').toUpperCase();
  if (s.includes('JPY')) return v.toFixed(3);
  if (v >= 10000) return v.toFixed(1);
  if (v >= 1000)  return v.toFixed(2);
  if (v >= 10)    return v.toFixed(4);
  if (v >= 0.1)   return v.toFixed(5);
  return v.toFixed(6);
};
const fmtT = iso => {
  if (!iso) return '';
  const d = new Date(iso), now = new Date(), dm = Math.round((now - d) / 60000);
  if (dm < 1)  return 'À l\'instant';
  if (dm < 60) return `Il y a ${dm}m`;
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('fr', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('fr', { day: 'numeric', month: 'short' });
};

function toast(msg, ms = 2500) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), ms); }
function vib(p) { if (navigator.vibrate) navigator.vibrate(p); }

// ============================================================
// AUTH
// ============================================================
function showAuth() {
  $('auth-screen').style.display = 'flex';
  $('app-screen').style.display  = 'none';
  $('side-menu').style.display   = 'none';
  $('menu-overlay').style.display = 'none';
}
function showApp() {
  $('auth-screen').style.display  = 'none';
  $('app-screen').style.display   = 'flex';
  $('side-menu').style.display    = 'flex';
  $('menu-overlay').style.display = 'block';
  closeMenu();
}

$('btn-reg').onclick = async () => {
  const name = $('auth-name').value.trim(), pw = $('auth-pw').value, pw2 = $('auth-pw2').value;
  if (!name) { toast('Entre un pseudo'); return; }
  if (!pw || pw.length < 6) { toast('Mot de passe trop court (6 min)'); return; }
  if (pw !== pw2) { toast('Les mots de passe ne correspondent pas'); return; }
  try {
    const r = await fetch(`${API}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password: pw }) });
    const d = await r.json(); if (!r.ok) { toast(d.error || 'Erreur'); return; }
    localStorage.setItem('aurora_token', d.token); localStorage.setItem('aurora_name', d.name);
    TOKEN = d.token; USERNAME = d.name; showApp(); await bootApp();
  } catch { toast('Erreur réseau'); }
};

$('btn-login').onclick = async () => {
  const name = $('auth-login-name').value.trim(), pw = $('auth-login-pw').value;
  if (!name) { toast('Entre ton pseudo'); return; }
  if (!pw)   { toast('Entre ton mot de passe'); return; }
  try {
    const r = await fetch(`${API}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password: pw }) });
    const d = await r.json(); if (!r.ok) { toast(d.error || 'Identifiants incorrects'); return; }
    localStorage.setItem('aurora_token', d.token); localStorage.setItem('aurora_name', d.name);
    TOKEN = d.token; USERNAME = d.name; showApp(); await bootApp();
  } catch { toast('Erreur réseau'); }
};

function doLogout() {
  localStorage.removeItem('aurora_token'); localStorage.removeItem('aurora_name');
  // On garde l'URL ngrok pour ne pas avoir à la ressaisir après reconnexion
  TOKEN = null; USERNAME = null;
  if (eventSource) eventSource.close();
  stopMT5Polling();
  showAuth();
}
$('btn-logout').onclick  = doLogout;
$('btn-logout2').onclick = doLogout;
$('go-login').onclick = () => { $('reg-form').style.display = 'none';   $('login-form').style.display = 'block'; };
$('go-reg').onclick   = () => { $('login-form').style.display = 'none'; $('reg-form').style.display   = 'block'; };

// ============================================================
// PUSH / SERVICE WORKER
// ============================================================
async function regSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!TOKEN) return;
    if (!('PushManager' in window)) return;
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
    const vr  = await fetch(`${API}/api/vapid-public-key`);
    const { key } = await vr.json();
    const appKey = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    await fetch(`${API}/api/${TOKEN}/push/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-aurora-token': TOKEN }, body: JSON.stringify(sub) });
    $('push-status').textContent = '✓ Notifications activées';
  } catch(e) { console.warn('[SW/PUSH]', e); }
}
$('enable-push') && ($('enable-push').onclick = regSW);

// ============================================================
// SSE (événements webhook : entrée/annulation/sortie)
// ============================================================
function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API}/api/${TOKEN}/stream`);

  eventSource.addEventListener('entry', e => {
    activeTrade = JSON.parse(e.data);
    renderBanner(); renderActivePosition();
    toast((activeTrade.direction === 'BUY' ? '▲ LONG' : '▼ SHORT') + ' — Ordre limite posé');
    vib([100, 50, 100]);
  });

  eventSource.addEventListener('activate', e => {
    const d = JSON.parse(e.data);
    if (activeTrade) { activeTrade.status = 'active'; if (d.entry) activeTrade.entry = d.entry; }
    renderBanner(); renderActivePosition();
    toast('● Ordre activé — en position');
    vib([150, 50, 150]);
  });

  eventSource.addEventListener('cancel', () => {
    activeTrade = null;
    renderBanner(); renderActivePosition();
    toast('⚠ Ordre limite annulé'); vib([50]);
  });

  eventSource.addEventListener('close', e => {
    const { result, pnl } = JSON.parse(e.data);
    activeTrade = null;
    renderBanner(); renderActivePosition();
    // Déclencher un refresh immédiat de l'historique et des stats MT5
    fetchMT5History();
    fetchMT5Live();
    toast(result === 'TP1' ? `✔ TP Atteint ${fmtEs(pnl)}` : `✖ SL Touché ${fmtEs(pnl)}`, 3000);
    vib([200]);
  });

  eventSource.onerror = () => {
    setMT5Status(false);
    setTimeout(connectSSE, 3000);
  };
}

// ============================================================
// MT5 POLLING — source unique de vérité
// ============================================================
function setMT5Status(online) {
  mt5Online = online;
  [$('sdot'), $('sdot2')].forEach(d => {
    if (!d) return;
    d.classList.toggle('off', !online);
    d.style.background = online ? '' : '#ff5252';
  });
  const labels = online ? 'MT5: CONNECTÉ' : 'MT5: HORS LIGNE';
  [$('stext'), $('stext2')].forEach(s => { if (s) { s.textContent = labels; s.style.color = online ? '' : '#ff5252'; } });
  const badge = $('mt5-badge');
  if (badge) { badge.textContent = online ? '● MT5 Live' : '○ Offline'; badge.style.color = online ? 'var(--green)' : '#ff5252'; }
}

async function fetchMT5Live() {
  if (!TOKEN) return;
  try {
    const r = await fetch(`${API}/api/${TOKEN}/mt5/live`, {
      headers: { 'x-aurora-token': TOKEN, ...(ngrokUrl ? { 'x-mt5-url': ngrokUrl } : {}) },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) { setMT5Status(false); return; }
    const data = await r.json();
    if (data.error) { setMT5Status(false); return; }
    mt5Live = data;
    setMT5Status(true);
    renderAll();
  } catch { setMT5Status(false); }
}

async function fetchMT5History() {
  if (!TOKEN) return;
  try {
    const r = await fetch(`${API}/api/${TOKEN}/mt5/history?days=90&filter=${filterSource}`, {
      headers: { 'x-aurora-token': TOKEN, ...(ngrokUrl ? { 'x-mt5-url': ngrokUrl } : {}) },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return;
    const data = await r.json();
    mt5History = data.trades || [];
    renderHistList();
    renderStats();
    renderCharts();
  } catch {}
}

function startMT5Polling() {
  if (_mt5Interval) clearInterval(_mt5Interval);
  fetchMT5Live();
  _mt5Interval = setInterval(fetchMT5Live, 3000);
}
function stopMT5Polling() {
  if (_mt5Interval) { clearInterval(_mt5Interval); _mt5Interval = null; }
  mt5Live = null; setMT5Status(false);
}

// ============================================================
// RENDER — toutes les fonctions lisent depuis mt5Live / mt5History
// ============================================================
function renderAll() {
  renderDay();
  renderBanner();
  renderActivePosition();
  renderRecentList();
  renderSettings();
  drawEquity();
}

// ── Dashboard : stats du jour ──
function renderDay() {
  const day = mt5Live?.day || {};
  const pnl = day.pnl || 0, wr = day.wr || 0;
  $('d-pnl').textContent = fmtE(pnl); $('d-pnl').className = 'pnl-val ' + (pnl >= 0 ? 'green' : 'red');
  $('d-pct').textContent = (wr >= 0 ? '+' : '') + wr.toFixed(1) + '%'; $('d-pct').className = 'pnl-pct ' + (wr >= 0 ? 'green' : 'red');
  $('d-today').textContent = (pnl >= 0 ? '+€' : '-€') + Math.abs(pnl).toFixed(2); $('d-today').className = 's3-v ' + (pnl >= 0 ? 'green' : 'red');
  $('d-wr').textContent = wr.toFixed(0) + '%'; $('d-wr').style.color = wr >= 50 ? 'var(--green)' : 'var(--red)';
  $('d-dd').textContent = '-' + (day.sl || 0) + 'R';
}

// ── Equity curve mini (dashboard) ──
function drawEquity() {
  const c = $('eq-canvas'); if (!c) return;
  const W = c.parentElement ? c.parentElement.offsetWidth - 36 : 300;
  const H = 90, dpr = window.devicePixelRatio || 1;
  c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
  c.style.width = W + 'px'; c.style.height = H + 'px';
  const ctx = c.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);

  // Utilise l'historique MT5 du jour pour la courbe
  const todayDeals = (mt5Live?.deals || []).sort((a, b) => new Date(a.time) - new Date(b.time));
  let run = 0;
  const data = todayDeals.length >= 2
    ? todayDeals.map(d => { run += d.pnl || 0; return run; })
    : [0, 2, 1, 4, 3, 7, 5, 9, 8, 12, 10, 15, 13, 18, 16, 21, 20, 25, 23, 28, 27, 32, 30, 36];

  const mn = Math.min(...data), mx = Math.max(...data, mn + 1), range = mx - mn, pad = 4;
  const pts = data.map((v, i) => ({ x: pad + i / (data.length - 1) * (W - pad * 2), y: H - pad - ((v - mn) / range) * (H - pad * 2 - 8) }));
  ctx.beginPath(); ctx.moveTo(pts[0].x, H); ctx.lineTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) { const mx2 = (pts[i-1].x + pts[i].x) / 2; ctx.bezierCurveTo(mx2, pts[i-1].y, mx2, pts[i].y, pts[i].x, pts[i].y); }
  ctx.lineTo(pts[pts.length - 1].x, H); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, 'rgba(0,230,118,0.3)'); g.addColorStop(1, 'rgba(0,230,118,0.0)');
  ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) { const mx2 = (pts[i-1].x + pts[i].x) / 2; ctx.bezierCurveTo(mx2, pts[i-1].y, mx2, pts[i].y, pts[i].x, pts[i].y); }
  ctx.strokeStyle = '#00e676'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
}
window.addEventListener('resize', () => { if (TOKEN) drawEquity(); });

// ── Bannière trade actif ──
function renderBanner() {
  const t = activeTrade, b = $('ab');
  if (!t) { b.style.display = 'none'; return; }
  b.style.display = 'flex';
  const isPending = t.status === 'pending';
  $('ab-dir').textContent = (t.direction === 'BUY' ? '▲ LONG' : '▼ SHORT') + (isPending ? ' — LIMITE' : '');
  $('ab-dir').style.color = t.direction === 'BUY' ? 'var(--green)' : 'var(--red)';
  $('ab-lvl').innerHTML = `E <span>${fmtP(t.entry, t.symbol)}</span> · SL <span style="color:var(--red)">${fmtP(t.sl, t.symbol)}</span> · TP <span style="color:var(--green)">${fmtP(t.tp1, t.symbol)}</span>`;
  const statusLbl = $('ab-status-lbl');
  if (statusLbl) { statusLbl.textContent = isPending ? '⏳ EN ATTENTE' : '● ACTIF'; statusLbl.style.color = isPending ? 'var(--gold, #ffd600)' : 'var(--green)'; }
  $('ab-lot').textContent = t.lot ? t.lot.toFixed(3) + ' lots' : '';
}

// ── Carte position active (données MT5 temps réel) ──
async function fetchLivePrice(sym) {
  const s = (sym || '').toUpperCase().trim();
  const prev = _livePrices[s] || null;
  try {
    const r = await fetch(`${API}/api/price/${encodeURIComponent(s)}`, { signal: AbortSignal.timeout(7000) });
    if (r.ok) { const d = await r.json(); if (d.price) { _livePrices[s] = { price: parseFloat(d.price), prev }; return; } }
  } catch {}
}

function renderActivePosition() {
  const wrap = $('active-position-wrap'), noActive = $('no-active');
  if (!wrap) return;

  // Source : positions MT5 en priorité, sinon activeTrade SSE
  const positions = mt5Live?.positions || [];
  const pending   = mt5Live?.pending   || [];

  // Pas de position MT5 ni SSE → vide
  if (!positions.length && !pending.length && !activeTrade) {
    if (_posInterval) { clearInterval(_posInterval); _posInterval = null; }
    wrap.innerHTML = '';
    if (noActive) noActive.style.display = 'block';
    return;
  }
  if (noActive) noActive.style.display = 'none';

  // Construire l'objet trade unifié (MT5 prioritaire)
  let sym, entry, sl, tp, isLong, isPending, livePrice, lot, profit, ticket, openTime;

  if (positions.length > 0) {
    const pos = positions[0];
    sym      = pos.symbol;
    entry    = pos.open_price;
    sl       = pos.sl;
    tp       = pos.tp;
    isLong   = pos.type === 'BUY';
    isPending = false;
    lot      = pos.volume;
    profit   = pos.profit;
    ticket   = pos.ticket;
    openTime = pos.open_time;

    // Prix live = current_price de MT5 (mis à jour à chaque polling /mt5/live toutes les 3s)
    // Pas besoin de polling Yahoo — MT5 est la source la plus précise
    livePrice = pos.current_price;
    if (_posInterval) { clearInterval(_posInterval); _posInterval = null; }

  } else if (pending.length > 0) {
    const o  = pending[0];
    sym      = o.symbol;
    entry    = o.price;
    sl       = o.sl;
    tp       = o.tp;
    isLong   = o.type === 'BUY_LIMIT';
    isPending = true;
    lot      = o.volume;
    profit   = null;
    ticket   = o.ticket;
    openTime = null;
    // Prix marché actuel envoyé par MT5 (bid), sinon prix limite comme fallback
    livePrice = o.current_price ?? o.price;
    if (_posInterval) { clearInterval(_posInterval); _posInterval = null; }

  } else if (activeTrade) {
    // Fallback SSE (MT5 pas encore renvoyé la position)
    sym      = activeTrade.symbol || 'NAS100';
    entry    = parseFloat(activeTrade.entry) || 0;
    sl       = parseFloat(activeTrade.sl) || 0;
    tp       = parseFloat(activeTrade.tp1) || 0;
    isLong   = activeTrade.direction === 'BUY';
    isPending = activeTrade.status === 'pending';
    lot      = activeTrade.lot;
    profit   = null;
    ticket   = null;
    openTime = null;
    if (!_posInterval) {
      fetchLivePrice(sym).then(() => renderActivePosition());
      _posInterval = setInterval(() => { fetchLivePrice(sym).then(() => updateLivePriceDOM(sym)); }, 5000);
    }
    livePrice = _livePrices[sym.toUpperCase()]?.price ?? null;
    // Si MT5 live arrive, on aura current_price au prochain cycle
  } else {
    return;
  }

  // Barres TP/SL
  let tpPct = 0, slPct = 0;
  if (livePrice && entry) {
    if (isLong) {
      if (tp > entry) tpPct = Math.min(100, Math.max(0, ((livePrice - entry) / (tp - entry)) * 100));
      if (sl < entry) slPct = Math.min(100, Math.max(0, ((entry - livePrice) / (entry - sl)) * 100));
    } else {
      if (tp < entry) tpPct = Math.min(100, Math.max(0, ((entry - livePrice) / (entry - tp)) * 100));
      if (sl > entry) slPct = Math.min(100, Math.max(0, ((livePrice - entry) / (sl - entry)) * 100));
    }
  }

  const livePriceStr = livePrice ? fmtP(livePrice, sym) : '…';
  const shortClass   = isLong ? '' : 'short';
  const pnlSign      = profit != null ? (profit >= 0 ? '+' : '') : '';
  const pnlTxt       = profit != null ? `${pnlSign}${profit.toFixed(2)} $` : '—';
  const pnlClass     = profit != null ? (profit >= 0 ? 'pos' : 'neg') : '';

  wrap.innerHTML = `<div class="mk-position ${shortClass}" id="dash-pos-card">
    <div class="mk-pos-glow"></div>
    <div class="mk-pos-hdr">
      <div>
        <div class="mk-pos-sym">${sym} <span class="pill ${isLong ? 'pill-long' : 'pill-short'}">${isLong ? 'LONG' : 'SHORT'}</span></div>
        <div style="font-size:10px;color:var(--muted);margin-top:3px">${openTime ? fmtT(openTime) : (ticket ? '#' + ticket : '')}</div>
      </div>
      <div class="mk-pos-badge">
        <div class="mk-pos-dot"></div>
        <div class="mk-pos-dir">${isPending ? '⏳ EN ATTENTE' : '● ACTIF'}</div>
      </div>
    </div>
    <div class="mk-pos-live-price" id="dash-pos-live">${livePriceStr}</div>
    <div class="mk-pos-grid">
      <div class="mk-pos-cell"><div class="mk-pos-cell-lbl">Entry</div><div class="mk-pos-cell-val">${fmtP(entry, sym)}</div></div>
      <div class="mk-pos-cell tp"><div class="mk-pos-cell-lbl">TP1</div><div class="mk-pos-cell-val">${fmtP(tp, sym)}</div></div>
      <div class="mk-pos-cell sl"><div class="mk-pos-cell-lbl">SL</div><div class="mk-pos-cell-val">${fmtP(sl, sym)}</div></div>
    </div>
    <div class="mk-pos-progress">
      <div class="mk-prog-row">
        <div class="mk-prog-lbl" style="color:var(--green)">TP</div>
        <div class="mk-prog-track"><div class="mk-prog-fill" style="width:${tpPct.toFixed(1)}%;background:var(--green)"></div></div>
        <div class="mk-prog-pct" style="color:var(--green)">${tpPct.toFixed(0)}%</div>
      </div>
      <div class="mk-prog-row">
        <div class="mk-prog-lbl" style="color:var(--red)">SL</div>
        <div class="mk-prog-track"><div class="mk-prog-fill" style="width:${slPct.toFixed(1)}%;background:var(--red)"></div></div>
        <div class="mk-prog-pct" style="color:var(--red)">${slPct.toFixed(0)}%</div>
      </div>
    </div>
    <div class="mk-pos-ftr" style="display:flex;align-items:center;justify-content:space-between;padding-top:8px;border-top:.5px solid rgba(255,255,255,0.07)">
      <div class="mk-pos-pnl-lbl" style="font-size:10px;color:var(--muted)">P&L flottant</div>
      <div class="mk-pos-pnl-val ${pnlClass}" style="font-family:var(--mono);font-size:14px;font-weight:700">${pnlTxt}</div>
    </div>
    <div style="font-family:var(--mono);font-size:10px;color:#aa66ff;text-align:right;margin-top:4px">${lot ? lot.toFixed(3) + ' lots' : ''}</div>
  </div>`;
}

function updateLivePriceDOM(sym) {
  const el = $('dash-pos-live');
  if (!el) return;
  const lp = _livePrices[(sym || '').toUpperCase()]?.price;
  if (lp) el.textContent = fmtP(lp, sym);
}

// ── Derniers trades (depuis historique MT5 du jour) ──
function tiHTML(t) {
  const isTP = t.result === 'TP1';
  const dir  = t.direction === 'BUY' ? 'Achat' : 'Vente';
  const sym  = t.symbol || 'NAS100';
  const pnlC = isTP ? 'green' : 'red';
  const resultLbl = isTP ? 'TP Atteint' : 'SL Touché';
  const heartOrCheck = isTP ? '✅' : '❤️';
  const pnlTxt = t.pnl != null && t.pnl !== 0 ? fmtEs(t.pnl) : '—';
  return `<div class="trade-item">
    <div class="trade-item-inner">
      <div class="ti-row1">
        <div class="ti-icon-letter">A</div>
        <div class="ti-title">${dir} ${sym}</div>
        <div class="ti-dots">···</div>
      </div>
      <div class="ti-entry">Entrée : ${fmtP(t.entry, sym)}</div>
      <div class="ti-row2">
        <span class="ti-result-icon">${isTP ? 'ℹ️' : '⚠️'}</span>
        <span class="ti-result-txt ${pnlC}">${resultLbl} ${pnlTxt}</span>
        <span>${heartOrCheck}</span>
      </div>
    </div>
  </div>
  <div class="trade-sep"></div>`;
}

function renderRecentList() {
  const el = $('recent-list'); if (!el) return;
  // Affiche les 5 derniers deals du jour depuis mt5Live
  const todayDeals = (mt5Live?.deals || []).slice(0, 5);
  if (!todayDeals.length) { el.innerHTML = '<div class="empty">Aucun trade aujourd\'hui</div>'; return; }
  el.innerHTML = todayDeals.map(d => tiHTML({
    symbol:    d.symbol,
    direction: d.type,
    result:    d.result,
    pnl:       d.pnl,
    lot:       d.volume,
    closedAt:  d.time,
    timestamp: d.time,
  })).join('');
}

// ── Historique complet (onglet Historique) ──
function renderHistList() {
  const el = $('hist-list'); if (!el) return;
  let ts = [...mt5History];
  if (filterActive === 'TP1')   ts = ts.filter(t => t.result === 'TP1');
  else if (filterActive === 'SL')    ts = ts.filter(t => t.result === 'SL');
  else if (filterActive === 'today') { const today = new Date().toDateString(); ts = ts.filter(t => new Date(t.closedAt || t.timestamp).toDateString() === today); }
  if (!ts.length) { el.innerHTML = '<div class="empty">Aucun trade</div>'; return; }
  el.innerHTML = ts.slice(0, 50).map(t => tiHTML(t)).join('');
}

// ── Statistiques (onglet Stats) ──
function renderStats() {
  const period = document.querySelector('.per-btn.active')?.dataset?.p || 'week';
  let ts = [...mt5History];
  const now = new Date();
  if (period === 'week')  { const w = new Date(now - 7 * 86400000);  ts = ts.filter(t => new Date(t.closedAt || t.timestamp) >= w); }
  if (period === 'month') { const m = new Date(now - 30 * 86400000); ts = ts.filter(t => new Date(t.closedAt || t.timestamp) >= m); }
  if (period === 'year')  { const y = new Date(now - 365 * 86400000); ts = ts.filter(t => new Date(t.closedAt || t.timestamp) >= y); }

  const tp = ts.filter(t => t.result === 'TP1').length;
  const sl = ts.filter(t => t.result === 'SL').length;
  const total = ts.length;
  const pnl   = ts.reduce((s, t) => s + (t.pnl || 0), 0);
  const wr    = total > 0 ? tp / total * 100 : 0;

  $('s-pnl').textContent = fmtE(pnl); $('s-pnl').className = 'perf-val ' + (pnl >= 0 ? 'green' : 'red');
  $('s-sub').textContent = `Période · ${total} Trade${total > 1 ? 's' : ''}`;
  $('s-wr').textContent  = wr.toFixed(0) + '% Win'; $('s-wr').style.color = wr >= 50 ? 'var(--green)' : 'var(--red)';

  const tpP = total > 0 ? tp / total * 100 : 0, slP = total > 0 ? sl / total * 100 : 0;
  $('wbar-tp').style.width = tpP + '%'; $('wct-tp').textContent = tp;
  $('wbar-sl').style.width = slP + '%'; $('wct-sl').textContent = sl;

  renderDonut(tp, sl);
  renderBarChart(ts);
}

function renderDonut(tp, sl) {
  const svg = $('donut'), total = tp + sl;
  if (!total) { svg.innerHTML = '<circle cx="60" cy="60" r="44" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="18"/><text x="60" y="67" text-anchor="middle" font-size="13" fill="rgba(255,255,255,0.3)" font-family="Space Mono,monospace">0%</text>'; return; }
  const tpA = (tp / total) * 360, slA = tpA === 360 ? 359.9 : tpA;
  const p = (a, r) => { const rad = (a - 90) * Math.PI / 180; return { x: 60 + r * Math.cos(rad), y: 60 + r * Math.sin(rad) }; };
  const arc = (s, e, r, col) => { const lg = e - s > 180 ? 1 : 0; const sp = p(s, r); const ep = p(e, r); return `<path d="M${sp.x},${sp.y} A${r},${r} 0 ${lg},1 ${ep.x},${ep.y}" fill="none" stroke="${col}" stroke-width="18" stroke-linecap="butt"/>`; };
  const wpct = Math.round(tp / total * 100), lpct = 100 - wpct;
  svg.innerHTML = (tp > 0 ? arc(0, slA, 44, '#27ae60') : '') + (sl > 0 ? arc(slA, 360, 44, '#c0392b') : '') + `<text x="60" y="56" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" font-family="Space Mono,monospace">${wpct}%</text><text x="60" y="72" text-anchor="middle" font-size="10" fill="rgba(255,255,255,0.5)" font-family="Space Mono,monospace">${lpct}%</text>`;
}

function renderBarChart(ts) {
  const chart = $('bar-chart');
  if (!ts) ts = mt5History;
  const byDay = {};
  ts.forEach(t => {
    const d = new Date(t.closedAt || t.timestamp);
    const key = d.toDateString();
    if (!byDay[key]) byDay[key] = { pnl: 0, label: d.toLocaleDateString('fr', { weekday: 'short' }) };
    byDay[key].pnl += t.pnl || 0;
  });
  const entries = Object.values(byDay).slice(-7);
  if (!entries.length) { chart.innerHTML = '<div style="font-size:11px;color:var(--muted);margin:auto">Aucune donnée</div>'; return; }
  const maxAbs = Math.max(...entries.map(e => Math.abs(e.pnl)), 1);
  $('gvp-max').textContent = '€' + maxAbs.toFixed(2);
  chart.innerHTML = entries.map(e => {
    const pct = Math.abs(e.pnl) / maxAbs * 100, pos = e.pnl >= 0;
    return `<div class="bc-col"><div class="bc-bar" style="height:${pct}%;background:${pos ? '#27ae60' : '#c0392b'}"></div><div class="bc-day">${e.label.slice(0, 3)}</div></div>`;
  }).join('');
}

// ── Réglages ──
function renderSettings() {
  $('my-token').textContent      = TOKEN || '—';
  $('webhook-url').textContent   = `${window.location.origin}/webhook/${TOKEN}`;

  // Champ URL ngrok
  const ngrokInput = $('ngrok-url-input');
  if (ngrokInput && !ngrokInput.dataset.dirty) ngrokInput.value = ngrokUrl;

  // Compte MT5
  const acc = mt5Live?.account;
  const el  = $('mt5-account-info');
  if (!el) return;
  if (!acc) { el.innerHTML = '<div style="color:var(--muted);font-size:11px">Connexion à aurora.py en cours...</div>'; return; }
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px;margin-top:8px">
      <div style="background:rgba(255,255,255,0.04);padding:8px;border-radius:6px"><div style="color:var(--muted);font-size:10px;margin-bottom:2px">COMPTE</div><div style="font-weight:600">#${acc.login}</div></div>
      <div style="background:rgba(255,255,255,0.04);padding:8px;border-radius:6px"><div style="color:var(--muted);font-size:10px;margin-bottom:2px">MODE</div><div style="font-weight:600;color:${acc.mode === 'DEMO' ? 'var(--gold)' : 'var(--green)'}">${acc.mode}</div></div>
      <div style="background:rgba(255,255,255,0.04);padding:8px;border-radius:6px"><div style="color:var(--muted);font-size:10px;margin-bottom:2px">BALANCE</div><div style="font-weight:600;color:var(--green)">${acc.balance.toFixed(2)} ${acc.currency}</div></div>
      <div style="background:rgba(255,255,255,0.04);padding:8px;border-radius:6px"><div style="color:var(--muted);font-size:10px;margin-bottom:2px">ÉQUITÉ</div><div style="font-weight:600;color:${acc.equity >= acc.balance ? 'var(--green)' : 'var(--red)'}">${acc.equity.toFixed(2)} ${acc.currency}</div></div>
      <div style="background:rgba(255,255,255,0.04);padding:8px;border-radius:6px"><div style="color:var(--muted);font-size:10px;margin-bottom:2px">MARGE LIBRE</div><div>${acc.free_margin.toFixed(2)} ${acc.currency}</div></div>
      <div style="background:rgba(255,255,255,0.04);padding:8px;border-radius:6px"><div style="color:var(--muted);font-size:10px;margin-bottom:2px">LEVIER</div><div>1:${acc.leverage}</div></div>
    </div>
    <div style="font-size:10px;color:var(--muted);margin-top:6px;text-align:right">${acc.server} — ${acc.company}</div>`;
}

// ============================================================
// NAVIGATION
// ============================================================
function openMenu()  { $('side-menu').classList.add('open');    $('menu-overlay').classList.add('open'); }
function closeMenu() { $('side-menu').classList.remove('open'); $('menu-overlay').classList.remove('open'); }

function goTab(name) {
  document.querySelectorAll('.side-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
  const active = document.querySelector(`.side-item[data-tab="${name}"]`);
  if (active) active.classList.add('active');
  $('tab-' + name).classList.add('active');
  closeMenu();
  if (name === 'stats')   { fetchMT5History().then(() => renderStats()); }
  if (name === 'history') { fetchMT5History().then(() => renderHistList()); }
  if (name === 'charts')  { fetchMT5History().then(() => renderCharts()); }
}

$('menu-btn').onclick       = openMenu;
$('menu-overlay').onclick   = closeMenu;
document.querySelectorAll('.side-item').forEach(btn => { btn.onclick = () => goTab(btn.dataset.tab); });
document.querySelectorAll('.per-btn').forEach(b => {
  b.onclick = () => { document.querySelectorAll('.per-btn').forEach(x => x.classList.remove('active')); b.classList.add('active'); renderStats(); };
});
document.querySelectorAll('.filter-btn').forEach(b => {
  b.onclick = () => { document.querySelectorAll('.filter-btn').forEach(x => x.classList.remove('active')); b.classList.add('active'); filterActive = b.dataset.f; renderHistList(); };
});
$('back-stats').onclick  = () => goTab('dashboard');
$('back-hist').onclick   = () => goTab('dashboard');
$('back-charts').onclick = () => goTab('dashboard');
document.querySelectorAll('.hm-btn').forEach(b => {
  b.onclick = () => { document.querySelectorAll('.hm-btn').forEach(x => x.classList.remove('active')); b.classList.add('active'); renderHeatmap(b.dataset.hm); };
});

$('copy-wh') && ($('copy-wh').onclick = () => {
  navigator.clipboard.writeText(`${window.location.origin}/webhook/${TOKEN}`).then(() => toast('URL copiée !')).catch(() => toast('Copié !'));
});
$('copy-token') && ($('copy-token').onclick = () => {
  navigator.clipboard.writeText(TOKEN || '').then(() => toast('Token copié !')).catch(() => toast('Copié !'));
});

// ============================================================
// NGROK URL — sauvegarde
// ============================================================
async function saveNgrokUrl() {
  const input = $('ngrok-url-input');
  if (!input) return;
  const val = input.value.trim().replace(/\/+$/, '');
  if (val && !val.startsWith('http')) { toast('URL invalide — doit commencer par http'); return; }

  ngrokUrl = val;
  localStorage.setItem('aurora_mt5_url', val);

  // Sauvegarder aussi côté serveur (pour persistance multi-appareil)
  try {
    await fetch(`${API}/api/${TOKEN}/mt5/url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-aurora-token': TOKEN },
      body: JSON.stringify({ url: val }),
    });
  } catch {}

  input.dataset.dirty = '';
  toast(val ? '✓ URL ngrok sauvegardée' : '✓ URL effacée — mode localhost');

  // Relancer le polling avec la nouvelle URL
  startMT5Polling();
  fetchMT5History();
}

// Au login, récupérer l'URL sauvegardée côté serveur
async function loadNgrokUrl() {
  if (!TOKEN) return;
  // D'abord localStorage (plus rapide)
  if (ngrokUrl) return;
  try {
    const r = await fetch(`${API}/api/${TOKEN}/mt5/url`, { headers: { 'x-aurora-token': TOKEN } });
    if (r.ok) {
      const d = await r.json();
      if (d.url && d.url.startsWith('http') && !d.url.includes('localhost')) {
        ngrokUrl = d.url;
        localStorage.setItem('aurora_mt5_url', ngrokUrl);
      }
    }
  } catch {}
}

// ============================================================
// INIT
// ============================================================
async function bootApp() {
  await loadNgrokUrl();
  await regSW();
  connectSSE();
  startMT5Polling();
  await fetchMT5History();
}

async function init() {
  if (!TOKEN) { showAuth(); return; }
  showApp();
  await bootApp();
}
init();

// ============================================================
// GRAPHIQUES
// ============================================================
function renderCharts() {
  drawEquityFull(mt5History);
  drawDistrib(mt5History);
  drawCumulDD(mt5History);
  renderHeatmap(_hmMode);
}

function setupCanvas(id, h) {
  const c = $(id); if (!c) return null;
  const W = c.parentElement.offsetWidth - 32, dpr = window.devicePixelRatio || 1;
  c.width  = Math.round(W * dpr); c.height = Math.round(h * dpr);
  c.style.width = W + 'px'; c.style.height = h + 'px';
  const ctx = c.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, h);
  return { ctx, W, H: h };
}

function drawEquityFull(trades) {
  const cv = setupCanvas('ch-equity', 160); if (!cv) return;
  const { ctx, W, H } = cv;
  if (!trades.length) { noDataMsg(ctx, W, H); return; }
  let run = 0;
  const pts = trades.map(t => { run += t.pnl || 0; return run; });
  pts.unshift(0);
  const mn = Math.min(...pts), mx = Math.max(...pts, mn + 0.01), range = mx - mn;
  const pad = 6, bh = H - pad * 2 - 20;
  const xs = i => pad + i / (pts.length - 1) * (W - pad * 2);
  const ys = v => pad + bh - ((v - mn) / range) * bh;

  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = pad + bh / 4 * i; ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke(); }
  if (mn < 0 && mx > 0) { const y0 = ys(0); ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad, y0); ctx.lineTo(W - pad, y0); ctx.stroke(); ctx.setLineDash([]); }

  ctx.beginPath(); ctx.moveTo(xs(0), H - 20); ctx.lineTo(xs(0), ys(pts[0]));
  for (let i = 1; i < pts.length; i++) { const mx2 = (xs(i-1) + xs(i)) / 2; ctx.bezierCurveTo(mx2, ys(pts[i-1]), mx2, ys(pts[i]), xs(i), ys(pts[i])); }
  ctx.lineTo(xs(pts.length - 1), H - 20); ctx.closePath();
  const last = pts[pts.length - 1];
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, last >= 0 ? 'rgba(0,230,118,0.25)' : 'rgba(255,82,82,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); ctx.moveTo(xs(0), ys(pts[0]));
  for (let i = 1; i < pts.length; i++) { const mx2 = (xs(i-1) + xs(i)) / 2; ctx.bezierCurveTo(mx2, ys(pts[i-1]), mx2, ys(pts[i]), xs(i), ys(pts[i])); }
  ctx.strokeStyle = last >= 0 ? '#00e676' : '#ff5252'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.font = "9px 'Space Mono',monospace"; ctx.textAlign = 'right';
  ctx.fillText((mx >= 0 ? '+' : '') + mx.toFixed(0) + '€', W - pad + 18, pad + 6);
  ctx.fillText((mn >= 0 ? '+' : '') + mn.toFixed(0) + '€', W - pad + 18, pad + bh + 4);
  ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.font = "8px 'Space Mono',monospace";
  const step = Math.max(1, Math.floor(trades.length / 5));
  trades.forEach((t, i) => { if (i % step !== 0) return; const d = new Date(t.closedAt || t.timestamp); ctx.fillText(d.toLocaleDateString('fr', { day: 'numeric', month: 'short' }), xs(i + 1), H - 4); });
}

function drawDistrib(trades) {
  const cv = setupCanvas('ch-distrib', 140); if (!cv) return;
  const { ctx, W, H } = cv;
  if (!trades.length) { noDataMsg(ctx, W, H); return; }
  const pnls = trades.map(t => t.pnl || 0).filter(p => p !== 0);
  if (!pnls.length) { noDataMsg(ctx, W, H); return; }
  const mn = Math.min(...pnls), mx = Math.max(...pnls), nb = 10, bw = (mx - mn) / nb || 1;
  const buckets = Array(nb).fill(0);
  pnls.forEach(p => { let i = Math.min(nb - 1, Math.floor((p - mn) / bw)); buckets[i]++; });
  const maxB = Math.max(...buckets, 1), pad = 6, bh = H - pad * 2 - 18, cw = (W - pad * 2) / nb;
  buckets.forEach((cnt, i) => {
    const bVal = mn + bw * (i + 0.5), barH = cnt / maxB * bh, x = pad + i * cw + 1, y = pad + bh - barH;
    ctx.fillStyle = bVal >= 0 ? 'rgba(0,230,118,0.7)' : 'rgba(255,82,82,0.7)';
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, cw - 2, barH, 3) : ctx.rect(x, y, cw - 2, barH); ctx.fill();
  });
  ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.font = "8px 'Space Mono',monospace"; ctx.textAlign = 'center';
  ctx.fillText(mn.toFixed(0) + '€', pad + cw * 0.5, H - 2);
  ctx.fillText('0', pad + cw * (nb / 2), H - 2);
  ctx.fillText(mx.toFixed(0) + '€', pad + cw * (nb - 0.5), H - 2);
  ctx.textAlign = 'left'; ctx.fillText(`${pnls.length} trades`, pad, pad + 9);
}

function drawCumulDD(trades) {
  const cv = setupCanvas('ch-dd', 160); if (!cv) return;
  const { ctx, W, H } = cv;
  if (!trades.length) { noDataMsg(ctx, W, H); return; }
  let run = 0, peak = 0;
  const cumPts = [0], ddPts = [0];
  trades.forEach(t => { run += t.pnl || 0; peak = Math.max(peak, run); const dd = Math.min(0, run - peak); cumPts.push(run); ddPts.push(dd); });
  const pad = 6, bh = (H - pad * 2 - 20) / 2;
  const mnC = Math.min(...cumPts), mxC = Math.max(...cumPts, mnC + 0.01);
  const mnD = Math.min(...ddPts, -0.01), mxD = 0;
  const xs = i => pad + i / (cumPts.length - 1) * (W - pad * 2);
  const ysC = v => pad + (bh - ((v - mnC) / (mxC - mnC) * bh));
  const ysD = v => pad + bh + 4 + (mxD - v) / (mxD - mnD) * bh;
  ctx.beginPath(); ctx.moveTo(xs(0), ysC(cumPts[0]));
  for (let i = 1; i < cumPts.length; i++) { const mx2 = (xs(i-1) + xs(i)) / 2; ctx.bezierCurveTo(mx2, ysC(cumPts[i-1]), mx2, ysC(cumPts[i]), xs(i), ysC(cumPts[i])); }
  ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(xs(0), pad + bh); ctx.lineTo(xs(0), ysC(cumPts[0]));
  for (let i = 1; i < cumPts.length; i++) { const mx2 = (xs(i-1) + xs(i)) / 2; ctx.bezierCurveTo(mx2, ysC(cumPts[i-1]), mx2, ysC(cumPts[i]), xs(i), ysC(cumPts[i])); }
  ctx.lineTo(xs(cumPts.length - 1), pad + bh); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, pad + bh); g.addColorStop(0, 'rgba(0,229,255,0.2)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); ctx.moveTo(xs(0), ysD(0));
  for (let i = 1; i < ddPts.length; i++) { const mx2 = (xs(i-1) + xs(i)) / 2; ctx.bezierCurveTo(mx2, ysD(ddPts[i-1]), mx2, ysD(ddPts[i]), xs(i), ysD(ddPts[i])); }
  ctx.lineTo(xs(ddPts.length - 1), ysD(0)); ctx.closePath();
  const g2 = ctx.createLinearGradient(0, pad + bh + 4, 0, H - 20); g2.addColorStop(0, 'rgba(255,82,82,0.35)'); g2.addColorStop(1, 'rgba(255,82,82,0.05)'); ctx.fillStyle = g2; ctx.fill();
  ctx.beginPath(); ctx.moveTo(xs(0), ysD(ddPts[0]));
  for (let i = 1; i < ddPts.length; i++) { const mx2 = (xs(i-1) + xs(i)) / 2; ctx.bezierCurveTo(mx2, ysD(ddPts[i-1]), mx2, ysD(ddPts[i]), xs(i), ysD(ddPts[i])); }
  ctx.strokeStyle = '#ff5252'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.font = "9px 'Space Mono',monospace"; ctx.textAlign = 'left';
  ctx.fillStyle = '#00e5ff'; ctx.fillText('Cumulé', pad, pad + 10);
  ctx.fillStyle = '#ff5252'; ctx.fillText('Drawdown', pad, pad + bh + 14);
  ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.textAlign = 'right'; ctx.fillText('Max DD: ' + mnD.toFixed(0) + '€', W - pad, H - 4);
}

function renderHeatmap(mode) {
  _hmMode = mode;
  const wrap = $('ch-heatmap'); if (!wrap) return;
  const trades = mt5History;
  if (mode === 'hour') {
    const hours = Array(24).fill(null).map(() => ({ pnl: 0, count: 0 }));
    trades.forEach(t => { const h = new Date(t.closedAt || t.timestamp).getHours(); hours[h].pnl += t.pnl || 0; hours[h].count++; });
    wrap.innerHTML = buildHeatmapLinear(hours, i => i + 'h', 24);
  } else if (mode === 'weekday') {
    const days = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
    const slots = Array(7).fill(null).map(() => ({ pnl: 0, count: 0 }));
    trades.forEach(t => { const d = (new Date(t.closedAt || t.timestamp).getDay() + 6) % 7; slots[d].pnl += t.pnl || 0; slots[d].count++; });
    wrap.innerHTML = buildHeatmapLinear(slots, i => days[i], 7);
  } else if (mode === 'week') {
    const slots = {};
    trades.forEach(t => { const d = new Date(t.closedAt || t.timestamp); const w = getWeekNum(d); const key = d.getFullYear() + '-W' + w; if (!slots[key]) slots[key] = { pnl: 0, count: 0, label: 'S' + w }; slots[key].pnl += t.pnl || 0; slots[key].count++; });
    const arr = Object.values(slots).slice(-12);
    wrap.innerHTML = buildHeatmapLinear(arr, (_, i, a) => a[i].label, arr.length);
  } else if (mode === 'month') {
    const months = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Jun', 'Jul', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];
    const slots = Array(12).fill(null).map(() => ({ pnl: 0, count: 0 }));
    trades.forEach(t => { const m = new Date(t.closedAt || t.timestamp).getMonth(); slots[m].pnl += t.pnl || 0; slots[m].count++; });
    wrap.innerHTML = buildHeatmapLinear(slots, i => months[i], 12);
  }
}

function buildHeatmapLinear(slots, labelFn, n) {
  const maxAbs = Math.max(...slots.map(s => Math.abs(s.pnl || 0)), 0.01);
  const cells = slots.map((s, i) => {
    const pnl = s.pnl || 0, count = s.count || 0, intensity = Math.abs(pnl) / maxAbs;
    let bg;
    if (count === 0) bg = 'rgba(255,255,255,0.04)';
    else if (pnl > 0) bg = `rgba(0,230,118,${0.1 + intensity * 0.7})`;
    else bg = `rgba(255,82,82,${0.1 + intensity * 0.7})`;
    const label = labelFn(i, i, slots);
    const val   = count > 0 ? (pnl >= 0 ? '+' : '') + pnl.toFixed(0) + '€' : '';
    return `<div style="flex:1;min-width:0"><div class="hm-label" style="margin-bottom:3px">${label}</div><div class="hm-cell" style="background:${bg}">${val}</div><div class="hm-label" style="margin-top:3px;color:rgba(255,255,255,0.2)">${count > 0 ? count + 't' : ''}</div></div>`;
  });
  const chunkSize = Math.ceil(n / Math.ceil(n / 8));
  const rows = [];
  for (let i = 0; i < cells.length; i += chunkSize) rows.push(cells.slice(i, i + chunkSize));
  return rows.map(row => `<div style="display:flex;gap:3px;margin-bottom:4px">${row.join('')}</div>`).join('');
}

function getWeekNum(d) { const s = new Date(d.getFullYear(), 0, 1); return Math.ceil(((d - s) / 86400000 + s.getDay() + 1) / 7); }
function noDataMsg(ctx, W, H) { ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.font = "12px 'Space Mono',monospace"; ctx.textAlign = 'center'; ctx.fillText('Aucune donnée', W / 2, H / 2); }
