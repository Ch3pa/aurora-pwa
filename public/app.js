'use strict';
const API = window.location.origin;
let TOKEN = localStorage.getItem('aurora_token') || null;
let USERNAME = localStorage.getItem('aurora_name') || null;
let state = { activeTrade: null, day: {}, all: {}, recent: [] };
let allTrades = [];
let filterActive = 'all';
let eventSource = null;
let equityHistory = [];

const $ = id => document.getElementById(id);
const fmtPnl = n => n == null ? '—' : (n >= 0 ? '+€' : '-€') + Math.abs(n).toFixed(2).replace('.', ',');
const fmtPnlShort = n => n == null ? '—' : (n >= 0 ? '+€' : '-€') + Math.abs(Math.round(n));
const fmtPrice = n => n == null ? '—' : Number(n).toFixed(n > 100 ? 0 : 4);
const fmtTime = iso => {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const dm = Math.round((now - d) / 60000);
  if (dm < 1) return 'À l\'instant';
  if (dm < 60) return `Il y a ${dm}m`;
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('fr',{hour:'2-digit',minute:'2-digit'});
  return d.toLocaleDateString('fr',{day:'numeric',month:'short'});
};

function showToast(msg, duration=2500) {
  const t=$('toast'); t.textContent=msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}
function vibrate(p) { if(navigator.vibrate) navigator.vibrate(p); }

// ── Auth ──
function showAuthScreen() { $('auth-screen').style.display='flex'; $('app-screen').style.display='none'; }
function showAppScreen() { $('auth-screen').style.display='none'; $('app-screen').style.display='flex'; }

$('btn-register').addEventListener('click', async () => {
  const name = $('auth-name').value.trim();
  if (!name) { showToast('Entre un pseudo'); return; }
  try {
    const res = await fetch(`${API}/api/register`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
    const data = await res.json();
    if (!res.ok) { showToast(data.error||'Erreur'); return; }
    localStorage.setItem('aurora_token', data.token);
    localStorage.setItem('aurora_name', data.name);
    TOKEN = data.token; USERNAME = data.name;
    showToast(`Compte créé ! Note ton token.`);
    showAppScreen(); await loadAll(); connectSSE();
  } catch { showToast('Erreur réseau'); }
});

$('btn-login').addEventListener('click', async () => {
  const token = $('auth-token').value.trim();
  if (!token) { showToast('Entre ton token'); return; }
  try {
    const res = await fetch(`${API}/api/login`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
    const data = await res.json();
    if (!res.ok) { showToast(data.error||'Token invalide'); return; }
    localStorage.setItem('aurora_token', data.token);
    localStorage.setItem('aurora_name', data.name);
    TOKEN = data.token; USERNAME = data.name;
    showAppScreen(); await loadAll(); connectSSE();
  } catch { showToast('Erreur réseau'); }
});

$('btn-logout').addEventListener('click', () => {
  localStorage.removeItem('aurora_token'); localStorage.removeItem('aurora_name');
  TOKEN=null; USERNAME=null;
  if(eventSource) eventSource.close();
  showAuthScreen();
});

$('link-show-login').addEventListener('click', () => { $('register-form').style.display='none'; $('login-form').style.display='block'; });
$('link-show-register').addEventListener('click', () => { $('login-form').style.display='none'; $('register-form').style.display='block'; });

// ── SW ──
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('/sw.js'); } catch(e) { console.warn('[SW]',e); }
}

// ── SSE ──
function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API}/api/${TOKEN}/stream`);
  eventSource.addEventListener('state', e => {
    const d = JSON.parse(e.data);
    state.activeTrade=d.activeTrade; state.day=d.day; state.recent=d.recent||[];
    setOnline(true); renderAll();
  });
  eventSource.addEventListener('entry', e => {
    const t = JSON.parse(e.data); state.activeTrade=t;
    renderActiveBanner(); renderActiveCard(); renderDayStats();
    showToast((t.direction==='BUY'?'▲ LONG':'▼ SHORT')+' — Entrée confirmée');
    vibrate([100,50,100]);
  });
  eventSource.addEventListener('close', e => {
    const {trade,day}=JSON.parse(e.data); state.activeTrade=null; state.day=day;
    state.recent.unshift(trade); allTrades.unshift(trade);
    equityHistory.push(state.day.pnl||0);
    renderAll(); showToast(trade.result==='TP1'?`✔ TP Atteint ${fmtPnlShort(trade.pnl)}`:`✖ SL Touché ${fmtPnlShort(trade.pnl)}`,3000);
    vibrate([200]);
  });
  eventSource.addEventListener('manual', e => {
    const {trade,day}=JSON.parse(e.data); state.day=day;
    state.recent.unshift(trade); allTrades.unshift(trade);
    renderHistoryList(); renderDayStats(); showToast('Trade ajouté');
  });
  eventSource.onerror = () => { setOnline(false); setTimeout(connectSSE,3000); };
}

function setOnline(on) {
  ['bot-dot','dash-dot'].forEach(id => { const d=$(id); if(d){d.classList.toggle('offline',!on);} });
  $('header-sub').textContent = on ? `Bot Status: ACTIVE · ${USERNAME||''}` : 'Reconnexion...';
  $('dash-status-text').textContent = on ? 'Bot Status: ACTIVE' : 'Bot Status: OFFLINE';
}

// ── Load ──
async function loadAll() {
  try {
    const res = await fetch(`${API}/api/${TOKEN}/state`);
    if (!res.ok) return;
    const d = await res.json();
    state.activeTrade=d.activeTrade; state.day=d.day; state.all=d.all; state.recent=d.recent||[];
  } catch(e) { console.warn('loadState:',e); }
  try {
    const res = await fetch(`${API}/api/${TOKEN}/trades`);
    allTrades = await res.json();
    equityHistory = computeEquity(allTrades);
  } catch(e) { console.warn('loadTrades:',e); }
}

function computeEquity(trades) {
  const sorted = [...trades].sort((a,b) => new Date(a.timestamp)-new Date(b.timestamp));
  let running = 0;
  return sorted.map(t => { running += t.pnl||0; return running; });
}

// ── Render all ──
function renderAll() {
  renderDayStats(); renderActiveBanner(); renderActiveCard();
  renderRecentList(); renderHistoryList(); renderStats(); renderSettings();
}

function renderDayStats() {
  const d=state.day, pnl=d.pnl||0, wr=d.wr||0;
  $('d-pnl').textContent = fmtPnl(pnl);
  $('d-pnl').className = 'pnl-value '+(pnl>=0?'green':'red');
  $('d-pnl-pct').textContent = (pnl>=0?'+':'')+wr.toFixed(1)+'%';
  $('d-today').textContent = fmtPnlShort(pnl);
  $('d-today').className = 'stat-card-val '+(pnl>=0?'green':'red');
  $('d-wr').textContent = wr.toFixed(0)+'%';
  $('d-wr').style.color = wr>=50?'var(--green)':'var(--red)';
  $('d-dd').textContent = '-'+(d.sl||0)+'R';
  drawEquity();
}

function renderActiveBanner() {
  const t=state.activeTrade, b=$('active-banner');
  if(!t){b.style.display='none';return;}
  b.style.display='flex';
  $('active-dir').textContent = (t.direction==='BUY'?'▲ LONG':'▼ SHORT')+' EN COURS';
  $('active-dir').style.color = t.direction==='BUY'?'var(--green)':'var(--red)';
  $('active-levels').innerHTML = `E <span>${fmtPrice(t.entry)}</span> · SL <span style="color:var(--red)">${fmtPrice(t.sl)}</span> · TP <span style="color:var(--green)">${fmtPrice(t.tp1)}</span>`;
  $('active-lot').textContent = t.lot?t.lot.toFixed(3)+' lots':'';
}

function renderActiveCard() {
  const t=state.activeTrade;
  if(!t){$('active-card').style.display='none';$('no-active').style.display='block';return;}
  $('active-card').style.display='block';$('no-active').style.display='none';
  $('ac-symbol').innerHTML = (t.symbol||'NAS100')+' <span class="pill '+(t.direction==='BUY'?'pill-long':'pill-short')+'">'+(t.direction==='BUY'?'LONG':'SHORT')+'</span>';
  $('ac-time').textContent = fmtTime(t.timestamp);
  $('ac-entry').textContent=fmtPrice(t.entry); $('ac-sl').textContent=fmtPrice(t.sl); $('ac-tp').textContent=fmtPrice(t.tp1);
  $('ac-lot').textContent = t.lot?t.lot.toFixed(3)+' lots':'';
  const sc=t.confirmScore||0;
  $('ac-dots').innerHTML=[0,1,2].map(i=>`<div class="cdot ${i<sc?'on':''}"></div>`).join('');
}

function tradeItemHTML(t) {
  const isTP = t.result==='TP1';
  const dir = t.direction==='BUY'?'Achat':'Vente';
  const pnlClass = (t.pnl||0)>=0?'green':'red';
  const icon = isTP ? '✅' : '⚠️';
  const resultLabel = isTP ? 'TP Atteint' : 'SL Touché';
  return `<div class="trade-item">
    <div class="trade-item-icon">⚡</div>
    <div class="trade-item-body">
      <div class="trade-item-title">${dir} ${t.symbol||'NAS100'}</div>
      <div class="trade-item-sub">Entrée : ${fmtPrice(t.entry)}</div>
      <div class="trade-item-result" style="margin-top:4px">
        ${icon} <span class="${pnlClass}" style="font-size:12px;font-weight:600">${resultLabel} ${fmtPnlShort(t.pnl)}</span>
      </div>
    </div>
    <div class="trade-item-right">
      <div class="trade-item-pnl ${pnlClass}">${fmtPnl(t.pnl)}</div>
      <div style="font-size:10px;color:var(--muted)">${fmtTime(t.timestamp)}</div>
    </div>
  </div>`;
}

function renderRecentList() {
  const list=$('recent-list'), trades=state.recent.slice(0,4);
  if(!trades.length){list.innerHTML='<div class="empty-state">Aucun trade</div>';return;}
  list.innerHTML=trades.map(t=>tradeItemHTML(t)).join('');
}

function renderHistoryList() {
  const list=$('history-list');
  let trades=[...allTrades,...state.recent.filter(t=>!allTrades.find(a=>a.id===t.id))];
  const seen=new Set(); trades=trades.filter(t=>{if(seen.has(t.id))return false;seen.add(t.id);return true;});
  if(filterActive==='TP1') trades=trades.filter(t=>t.result==='TP1');
  else if(filterActive==='SL') trades=trades.filter(t=>t.result==='SL');
  else if(filterActive==='today'){const today=new Date().toDateString();trades=trades.filter(t=>new Date(t.timestamp).toDateString()===today);}
  if(!trades.length){list.innerHTML='<div class="empty-state">Aucun trade</div>';return;}
  list.innerHTML=trades.slice(0,30).map(t=>tradeItemHTML(t)).join('');
}

function renderStats() {
  const a=state.all||{}; const wr=a.wr||0; const tp=a.tp||0; const sl=a.sl||0; const total=a.total||0;
  $('s-pnl').textContent=fmtPnl(a.pnl); $('s-pnl').className='perf-val '+((a.pnl||0)>=0?'green':'red');
  $('s-sub').textContent=`${wr.toFixed(1)}% · ${total} Trades`;
  $('s-wr').textContent=wr.toFixed(0)+'%'; $('s-wr').style.color=wr>=50?'var(--green)':'var(--red)';
  const tpPct=total>0?(tp/total*100):0, slPct=total>0?(sl/total*100):0;
  $('wr-bar-tp').style.width=tpPct+'%'; $('wr-tp-count').textContent=tp;
  $('wr-bar-sl').style.width=slPct+'%'; $('wr-sl-count').textContent=sl;
  renderDonut(tp,sl);
  renderBarChart();
}

function renderDonut(tp,sl) {
  const svg=$('donut-svg'); const total=tp+sl;
  if(!total){svg.innerHTML='<circle cx="60" cy="60" r="40" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="16"/>'+`<text x="60" y="65" text-anchor="middle" font-size="13" fill="rgba(255,255,255,0.3)" font-family="Space Mono,monospace">0%</text>`;return;}
  const tpA=(tp/total)*360; const slA=tpA===360?359.9:tpA;
  const p=(a,r)=>{const rad=(a-90)*Math.PI/180;return{x:60+r*Math.cos(rad),y:60+r*Math.sin(rad)};};
  const arc=(s,e,r,col)=>{const lg=e-s>180?1:0;const sp=p(s,r);const ep=p(e,r);return`<path d="M${sp.x},${sp.y} A${r},${r} 0 ${lg},1 ${ep.x},${ep.y}" fill="none" stroke="${col}" stroke-width="16" stroke-linecap="round"/>`;};
  const winPct=Math.round(tp/total*100);
  svg.innerHTML=(tp>0?arc(0,slA,40,'var(--green)'):'')+(sl>0?arc(slA,360,40,'var(--red)'):'')+
    `<text x="60" y="56" text-anchor="middle" font-size="16" font-weight="700" fill="var(--text)" font-family="Space Mono,monospace">${winPct}%</text>`+
    `<text x="60" y="70" text-anchor="middle" font-size="9" fill="var(--muted2)" font-family="Space Mono,monospace">Win</text>`;
}

function renderBarChart() {
  const chart=$('bar-chart');
  const all=[...allTrades,...state.recent];
  const byDay={};
  all.forEach(t=>{const d=new Date(t.timestamp);const key=d.toDateString();if(!byDay[key])byDay[key]={pnl:0,label:d.toLocaleDateString('fr',{weekday:'short'})};byDay[key].pnl+=t.pnl||0;});
  const entries=Object.values(byDay).slice(-7);
  if(!entries.length){chart.innerHTML='<div style="font-size:11px;color:var(--muted);margin:auto">Aucune donnée</div>';return;}
  const maxAbs=Math.max(...entries.map(e=>Math.abs(e.pnl)),1);
  $('bar-max-label').textContent='€'+maxAbs.toFixed(2);
  chart.innerHTML=entries.map(e=>{
    const pct=Math.abs(e.pnl)/maxAbs*100;
    const pos=e.pnl>=0;
    return `<div class="bar-col">
      <div class="bar-rect" style="height:${pct}%;background:${pos?'var(--green)':'var(--red)'};opacity:0.85"></div>
      <div class="bar-day">${e.label.slice(0,3)}</div>
    </div>`;
  }).join('');
}

function drawEquity() {
  const canvas=$('equity-canvas'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  const W=canvas.offsetWidth||300, H=70;
  canvas.width=W; canvas.height=H;
  ctx.clearRect(0,0,W,H);
  const data=equityHistory.length?equityHistory:[0,0];
  const mn=Math.min(...data), mx=Math.max(...data,0.01);
  const range=mx-mn||1;
  const pts=data.map((v,i)=>({x:i/(data.length-1||1)*(W-4)+2, y:H-((v-mn)/range)*(H-8)-4}));
  const grad=ctx.createLinearGradient(0,0,0,H);
  grad.addColorStop(0,'rgba(0,230,118,0.3)');
  grad.addColorStop(1,'rgba(0,230,118,0.0)');
  ctx.beginPath(); ctx.moveTo(pts[0].x,H);
  pts.forEach(p=>ctx.lineTo(p.x,p.y));
  ctx.lineTo(pts[pts.length-1].x,H); ctx.closePath();
  ctx.fillStyle=grad; ctx.fill();
  ctx.beginPath(); ctx.moveTo(pts[0].x,pts[0].y);
  pts.forEach(p=>ctx.lineTo(p.x,p.y));
  ctx.strokeStyle='#00e676'; ctx.lineWidth=2; ctx.stroke();
}

function renderSettings() {
  $('my-token').textContent=TOKEN||'—';
  $('webhook-url').textContent=`${window.location.origin}/webhook/${TOKEN}`;
}

// ── Nav ──
document.querySelectorAll('.nav-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const name=btn.dataset.tab;
    document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-section').forEach(s=>s.classList.remove('active'));
    btn.classList.add('active'); $(`tab-${name}`).classList.add('active');
    if(name==='stats') renderStats();
    if(name==='history') renderHistoryList();
  });
});

// ── Period tabs ──
document.querySelectorAll('.period-tab').forEach(tab=>{
  tab.addEventListener('click',()=>{
    document.querySelectorAll('.period-tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active'); renderStats();
  });
});

// ── Filters ──
document.querySelectorAll('.filter-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); filterActive=btn.dataset.filter; renderHistoryList();
  });
});

// ── Copy ──
$('copy-webhook').addEventListener('click',()=>{
  navigator.clipboard.writeText(`${window.location.origin}/webhook/${TOKEN}`).then(()=>showToast('URL copiée !')).catch(()=>showToast('Copié !'));
});
$('copy-token').addEventListener('click',()=>{
  navigator.clipboard.writeText(TOKEN||'').then(()=>showToast('Token copié !')).catch(()=>showToast(TOKEN));
});

// ── Manual form ──
$('submit-manual').addEventListener('click', async ()=>{
  const body={symbol:$('f-symbol').value,direction:$('f-dir').value,entry:parseFloat($('f-entry').value)||null,lot:parseFloat($('f-lot').value)||null,sl:parseFloat($('f-sl').value)||null,tp1:parseFloat($('f-tp').value)||null,result:$('f-result').value,pnl:parseFloat($('f-pnl').value)||0};
  try{await fetch(`${API}/api/${TOKEN}/trades`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});['f-entry','f-lot','f-sl','f-tp','f-pnl'].forEach(id=>$(id).value='');showToast('Trade enregistré ✓');}catch{showToast('Erreur réseau');}
});

// ── Push ──
function urlBase64ToUint8Array(b64) {
  const pad='='.repeat((4-b64.length%4)%4);
  const b=(b64+pad).replace(/-/g,'+').replace(/_/g,'/');
  return Uint8Array.from([...atob(b)].map(c=>c.charCodeAt(0)));
}
$('enable-push').addEventListener('click', async ()=>{
  if(!('PushManager' in window)){showToast('Push non supporté');return;}
  const perm=await Notification.requestPermission();
  if(perm!=='granted'){showToast('Permission refusée');return;}
  try{
    const {key}=await(await fetch(`${API}/api/vapid-public-key`)).json();
    const reg=await navigator.serviceWorker.ready;
    const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(key)});
    await fetch(`${API}/api/${TOKEN}/push/subscribe`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub)});
    $('push-status').textContent='✓ Notifications activées'; $('push-status').style.color='var(--green)';
    showToast('Notifications activées !');
  }catch(e){showToast('Erreur: '+e.message);}
});

// ── Init ──
async function init() {
  if(!TOKEN){showAuthScreen();return;}
  showAppScreen();
  await registerSW();
  await loadAll();
  renderAll();
  connectSSE();
}
init();
