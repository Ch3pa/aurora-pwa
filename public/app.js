'use strict';
const API=window.location.origin;
let TOKEN=localStorage.getItem('aurora_token')||null;
let USERNAME=localStorage.getItem('aurora_name')||null;
let state={activeTrade:null,day:{},all:{},recent:[]};
let allTrades=[];
let filterActive='all';
let eventSource=null;
let equityData=[];

const $=id=>document.getElementById(id);
const fmtE=n=>n==null?'—':(n>=0?'+€':'-€')+Math.abs(n).toFixed(2).replace('.',',');
const fmtEs=n=>n==null?'—':(n>=0?'+€':'-€')+Math.abs(n).toFixed(2);
const fmtP=n=>{if(n==null)return'—';const v=Number(n);return v>100?v.toFixed(0):v.toFixed(4);};
const fmtT=iso=>{if(!iso)return'';const d=new Date(iso),now=new Date(),dm=Math.round((now-d)/60000);if(dm<1)return'À l\'instant';if(dm<60)return`Il y a ${dm}m`;if(d.toDateString()===now.toDateString())return d.toLocaleTimeString('fr',{hour:'2-digit',minute:'2-digit'});return d.toLocaleDateString('fr',{day:'numeric',month:'short'});};

function toast(msg,ms=2500){const t=$('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),ms);}
function vib(p){if(navigator.vibrate)navigator.vibrate(p);}

// AUTH
function showAuth(){
  $('auth-screen').style.display='flex';
  $('app-screen').style.display='none';
  $('side-menu').style.display='none';
  $('menu-overlay').style.display='none';
}
function showApp(){
  $('auth-screen').style.display='none';
  $('app-screen').style.display='flex';
  $('side-menu').style.display='flex';
  $('menu-overlay').style.display='block';
  closeMenu();
}
$('btn-reg').onclick=async()=>{
  const name=$('auth-name').value.trim();
  const pw=$('auth-pw').value;
  const pw2=$('auth-pw2').value;
  if(!name){toast('Entre un pseudo');return;}
  if(!pw||pw.length<6){toast('Mot de passe trop court (6 min)');return;}
  if(pw!==pw2){toast('Les mots de passe ne correspondent pas');return;}
  try{const r=await fetch(`${API}/api/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,password:pw})});
  const d=await r.json();if(!r.ok){toast(d.error||'Erreur');return;}
  localStorage.setItem('aurora_token',d.token);localStorage.setItem('aurora_name',d.name);
  TOKEN=d.token;USERNAME=d.name;showApp();await loadAll();connectSSE();}catch{toast('Erreur réseau');}
};
$('btn-login').onclick=async()=>{
  const name=$('auth-login-name').value.trim();
  const pw=$('auth-login-pw').value;
  if(!name){toast('Entre ton pseudo');return;}
  if(!pw){toast('Entre ton mot de passe');return;}
  try{const r=await fetch(`${API}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,password:pw})});
  const d=await r.json();if(!r.ok){toast(d.error||'Identifiants incorrects');return;}
  localStorage.setItem('aurora_token',d.token);localStorage.setItem('aurora_name',d.name);
  TOKEN=d.token;USERNAME=d.name;showApp();await loadAll();connectSSE();}catch{toast('Erreur réseau');}
};
function doLogout(){localStorage.removeItem('aurora_token');localStorage.removeItem('aurora_name');TOKEN=null;USERNAME=null;if(eventSource)eventSource.close();showAuth();}
$('btn-logout').onclick=doLogout;
$('btn-logout2').onclick=doLogout;
$('go-login').onclick=()=>{$('reg-form').style.display='none';$('login-form').style.display='block';};
$('go-reg').onclick=()=>{$('login-form').style.display='none';$('reg-form').style.display='block';};

// SW
async function regSW(){if(!('serviceWorker'in navigator))return;try{await navigator.serviceWorker.register('/sw.js');}catch(e){console.warn(e);}}

// SSE
function connectSSE(){
  if(eventSource)eventSource.close();
  eventSource=new EventSource(`${API}/api/${TOKEN}/stream`);
  eventSource.addEventListener('state',e=>{const d=JSON.parse(e.data);state.activeTrade=d.activeTrade;state.day=d.day;state.recent=d.recent||[];setOnline(true);renderAll();});
  eventSource.addEventListener('entry',e=>{const t=JSON.parse(e.data);state.activeTrade=t;renderBanner();renderActiveCard();renderDay();toast((t.direction==='BUY'?'▲ LONG':'▼ SHORT')+' — Ordre limite posé');vib([100,50,100]);});
  eventSource.addEventListener('cancel',e=>{state.activeTrade=null;renderBanner();renderActiveCard();toast('⚠ Ordre limite annulé');vib([50]);});
  eventSource.addEventListener('close',e=>{const{trade,day}=JSON.parse(e.data);state.activeTrade=null;state.day=day;state.recent.unshift(trade);allTrades.unshift(trade);equityData=computeEquity(allTrades);renderAll();toast(trade.result==='TP1'?`✔ TP Atteint ${fmtEs(trade.pnl)}`:`✖ SL Touché ${fmtEs(trade.pnl)}`,3000);vib([200]);});
  eventSource.addEventListener('manual',e=>{const{trade,day}=JSON.parse(e.data);state.day=day;state.recent.unshift(trade);allTrades.unshift(trade);renderHistList();renderDay();toast('Trade ajouté');});
  eventSource.onerror=()=>{setOnline(false);setTimeout(connectSSE,3000);};
}
function setOnline(on){
  [$('sdot'),$('sdot2')].forEach(d=>{if(d)d.classList.toggle('off',!on);});
  [$('stext'),$('stext2')].forEach(s=>{if(s)s.textContent=on?'Bot Status: ACTIVE':'Bot Status: OFFLINE';});
}

// LOAD
async function loadAll(){
  try{const r=await fetch(`${API}/api/${TOKEN}/state`);if(!r.ok)return;const d=await r.json();state.activeTrade=d.activeTrade;state.day=d.day;state.all=d.all;state.recent=d.recent||[];}catch{}
  try{const r=await fetch(`${API}/api/${TOKEN}/trades`);allTrades=await r.json();equityData=computeEquity(allTrades);}catch{}
}
function computeEquity(trades){const s=[...trades].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));let run=0;return s.map(t=>{run+=t.pnl||0;return run;});}

// RENDER
function renderAll(){renderDay();renderBanner();renderActiveCard();renderRecentList();renderHistList();renderStats();renderSettings();}

function renderDay(){
  const d=state.day,pnl=d.pnl||0,wr=d.wr||0;
  $('d-pnl').textContent=fmtE(pnl);$('d-pnl').className='pnl-val '+(pnl>=0?'green':'red');
  $('d-pct').textContent=(wr>=0?'+':'')+wr.toFixed(1)+'%';$('d-pct').className='pnl-pct '+(wr>=0?'green':'red');
  $('d-today').textContent=(pnl>=0?'+€':'-€')+Math.abs(pnl).toFixed(2);$('d-today').className='s3-v '+(pnl>=0?'green':'red');
  $('d-wr').textContent=wr.toFixed(0)+'%';$('d-wr').style.color=wr>=50?'var(--green)':'var(--red)';
  $('d-dd').textContent='-'+(d.sl||0)+'R';
  requestAnimationFrame(drawEquity);
}

function drawEquity(){
  const c=$('eq-canvas');if(!c)return;
  // Wait for layout if width not ready
  const W=c.parentElement?c.parentElement.offsetWidth-36:300;
  const H=90;const dpr=window.devicePixelRatio||1;
  c.width=Math.round(W*dpr);c.height=Math.round(H*dpr);
  c.style.width=W+'px';c.style.height=H+'px';
  const ctx=c.getContext('2d');
  ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,W,H);
  // Use real equity data or demo rising curve
  const data=equityData.length>=2?equityData:[0,2,1,4,3,7,5,9,8,12,10,15,13,18,16,21,20,25,23,28,27,32,30,36,34,40,38,44,42,48,50];
  const mn=Math.min(...data),mx=Math.max(...data,mn+1),range=mx-mn;
  const pad=4;
  const pts=data.map((v,i)=>({
    x:pad+i/(data.length-1)*(W-pad*2),
    y:H-pad-((v-mn)/range)*(H-pad*2-8)
  }));
  // Smooth curve using bezier
  ctx.beginPath();
  ctx.moveTo(pts[0].x,H);
  ctx.lineTo(pts[0].x,pts[0].y);
  for(let i=1;i<pts.length;i++){
    const mx2=(pts[i-1].x+pts[i].x)/2;
    ctx.bezierCurveTo(mx2,pts[i-1].y,mx2,pts[i].y,pts[i].x,pts[i].y);
  }
  ctx.lineTo(pts[pts.length-1].x,H);
  ctx.closePath();
  const g=ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0,'rgba(0,230,118,0.3)');
  g.addColorStop(1,'rgba(0,230,118,0.0)');
  ctx.fillStyle=g;ctx.fill();
  // Line
  ctx.beginPath();
  ctx.moveTo(pts[0].x,pts[0].y);
  for(let i=1;i<pts.length;i++){
    const mx2=(pts[i-1].x+pts[i].x)/2;
    ctx.bezierCurveTo(mx2,pts[i-1].y,mx2,pts[i].y,pts[i].x,pts[i].y);
  }
  ctx.strokeStyle='#00e676';ctx.lineWidth=2.5;ctx.lineJoin='round';ctx.lineCap='round';ctx.stroke();
}
// Redraw on resize
window.addEventListener('resize',()=>{if(TOKEN)drawEquity();});

function renderBanner(){
  const t=state.activeTrade,b=$('ab');
  if(!t){b.style.display='none';return;}
  b.style.display='flex';
  const isPending=t.status==='pending';
  $('ab-dir').textContent=(t.direction==='BUY'?'▲ LONG':'▼ SHORT')+(isPending?' — LIMITE':'');
  $('ab-dir').style.color=t.direction==='BUY'?'var(--green)':'var(--red)';
  $('ab-lvl').innerHTML=`E <span>${fmtP(t.entry)}</span> · SL <span style="color:var(--red)">${fmtP(t.sl)}</span> · TP <span style="color:var(--green)">${fmtP(t.tp1)}</span>`;
  const statusLbl=$('ab-status-lbl');
  if(statusLbl){statusLbl.textContent=isPending?'⏳ EN ATTENTE':'● ACTIF';statusLbl.style.color=isPending?'var(--gold, #ffd600)':'var(--green)';}
  $('ab-lot').textContent=t.lot?t.lot.toFixed(3)+' lots':'';
}

function renderActiveCard(){
  const t=state.activeTrade;
  if(!t){$('active-card').style.display='none';$('no-active').style.display='block';return;}
  $('active-card').style.display='block';$('no-active').style.display='none';
  const isPending=t.status==='pending';
  $('ac-sym').innerHTML=(t.symbol||'NAS100')+' <span class="pill '+(t.direction==='BUY'?'pill-long':'pill-short')+'">'+(t.direction==='BUY'?'LONG':'SHORT')+'</span>';
  $('ac-time').textContent=fmtT(t.timestamp);
  $('ac-e').textContent=fmtP(t.entry);$('ac-sl').textContent=fmtP(t.sl);$('ac-tp').textContent=fmtP(t.tp1);
  $('ac-lot').textContent=t.lot?t.lot.toFixed(3)+' lots':'';
  const sc=t.confirmScore||0;$('ac-dots').innerHTML=[0,1,2].map(i=>`<div class="cdot ${i<sc?'on':''}"></div>`).join('');
  const pill=$('ac-status-pill');
  if(pill){
    if(isPending){pill.textContent='⏳ LIMITE PLACÉE';pill.className='pill pill-pending';}
    else{pill.textContent='EN COURS';pill.className='pill pill-active';}
  }
}

// Trade item HTML — exactly like mockup
function tiHTML(t){
  const isTP=t.result==='TP1';
  const dir=t.direction==='BUY'?'Achat':'Vente';
  const sym=t.symbol||'NAS100';
  const pnlC=isTP?'green':'red';
  const resultLbl=isTP?'TP Atteint':'SL Touché';
  const heartOrCheck=isTP?'✅':'❤️';
  const pnlTxt=t.pnl!=null&&t.pnl!==0?fmtEs(t.pnl):'—';
  return `<div class="trade-item">
    <div class="trade-item-inner">
      <div class="ti-row1">
        <div class="ti-icon-letter">A</div>
        <div class="ti-title">${dir} ${sym}</div>
        <div class="ti-dots">···</div>
      </div>
      <div class="ti-entry">Entrée : ${fmtP(t.entry)}</div>
      <div class="ti-row2">
        <span class="ti-result-icon">${isTP?'ℹ️':'⚠️'}</span>
        <span class="ti-result-txt ${pnlC}">${resultLbl} ${pnlTxt}</span>
        <span>${heartOrCheck}</span>
      </div>
    </div>
  </div>
  <div class="trade-sep"></div>`;
}

function renderRecentList(){const l=$('recent-list'),ts=state.recent.slice(0,4);if(!ts.length){l.innerHTML='<div class="empty">Aucun trade</div>';return;}l.innerHTML=ts.map(t=>tiHTML(t)).join('');}

function renderHistList(){
  const l=$('hist-list');
  let ts=[...allTrades,...state.recent.filter(t=>!allTrades.find(a=>a.id===t.id))];
  const seen=new Set();ts=ts.filter(t=>{if(seen.has(t.id))return false;seen.add(t.id);return true;});
  if(filterActive==='TP1')ts=ts.filter(t=>t.result==='TP1');
  else if(filterActive==='SL')ts=ts.filter(t=>t.result==='SL');
  else if(filterActive==='today'){const today=new Date().toDateString();ts=ts.filter(t=>new Date(t.timestamp).toDateString()===today);}
  if(!ts.length){l.innerHTML='<div class="empty">Aucun trade</div>';return;}
  l.innerHTML=ts.slice(0,30).map(t=>tiHTML(t)).join('');
}

function renderStats(){
  const a=state.all||{},wr=a.wr||0,tp=a.tp||0,sl=a.sl||0,total=a.total||0;
  $('s-pnl').textContent=fmtE(a.pnl);$('s-pnl').className='perf-val '+((a.pnl||0)>=0?'green':'red');
  $('s-sub').textContent=`Ce mois-ci · ${total} Trades`;
  $('s-wr').textContent=wr.toFixed(0)+'% Win';$('s-wr').style.color=wr>=50?'var(--green)':'var(--red)';
  const tpP=total>0?tp/total*100:0,slP=total>0?sl/total*100:0;
  $('wbar-tp').style.width=tpP+'%';$('wct-tp').textContent=tp;
  $('wbar-sl').style.width=slP+'%';$('wct-sl').textContent=sl;
  renderDonut(tp,sl);renderBarChart();
}

function renderDonut(tp,sl){
  const svg=$('donut'),total=tp+sl;
  if(!total){svg.innerHTML='<circle cx="60" cy="60" r="44" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="18"/>'+`<text x="60" y="67" text-anchor="middle" font-size="13" fill="rgba(255,255,255,0.3)" font-family="Space Mono,monospace">0%</text>`;return;}
  const tpA=(tp/total)*360,slA=tpA===360?359.9:tpA;
  const p=(a,r)=>{const rad=(a-90)*Math.PI/180;return{x:60+r*Math.cos(rad),y:60+r*Math.sin(rad)};};
  const arc=(s,e,r,col)=>{const lg=e-s>180?1:0;const sp=p(s,r);const ep=p(e,r);return`<path d="M${sp.x},${sp.y} A${r},${r} 0 ${lg},1 ${ep.x},${ep.y}" fill="none" stroke="${col}" stroke-width="18" stroke-linecap="butt"/>`;};
  const wpct=Math.round(tp/total*100),lpct=100-wpct;
  svg.innerHTML=
    (tp>0?arc(0,slA,44,'#27ae60'):'')+(sl>0?arc(slA,360,44,'#c0392b'):'')+
    `<text x="60" y="56" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" font-family="Space Mono,monospace">${wpct}%</text>`+
    `<text x="60" y="72" text-anchor="middle" font-size="10" fill="rgba(255,255,255,0.5)" font-family="Space Mono,monospace">${lpct}%</text>`;
}

function renderBarChart(){
  const chart=$('bar-chart');
  const all=[...allTrades,...state.recent];
  const byDay={};
  all.forEach(t=>{const d=new Date(t.timestamp);const key=d.toDateString();if(!byDay[key])byDay[key]={pnl:0,label:d.toLocaleDateString('fr',{weekday:'short'})};byDay[key].pnl+=t.pnl||0;});
  const entries=Object.values(byDay).slice(-7);
  if(!entries.length){chart.innerHTML='<div style="font-size:11px;color:var(--muted);margin:auto">Aucune donnée</div>';return;}
  const maxAbs=Math.max(...entries.map(e=>Math.abs(e.pnl)),1);
  $('gvp-max').textContent='€'+maxAbs.toFixed(4);
  chart.innerHTML=entries.map(e=>{
    const pct=Math.abs(e.pnl)/maxAbs*100,pos=e.pnl>=0;
    return `<div class="bc-col"><div class="bc-bar" style="height:${pct}%;background:${pos?'#27ae60':'#c0392b'}"></div><div class="bc-day">${e.label.slice(0,3)}</div></div>`;
  }).join('');
}

function renderSettings(){$('my-token').textContent=TOKEN||'—';$('webhook-url').textContent=`${window.location.origin}/webhook/${TOKEN}`;}

// ── Side menu ──
function openMenu(){$('side-menu').classList.add('open');$('menu-overlay').classList.add('open');}
function closeMenu(){$('side-menu').classList.remove('open');$('menu-overlay').classList.remove('open');}
function goTab(name){
  document.querySelectorAll('.side-item').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.tab-section').forEach(s=>s.classList.remove('active'));
  const active=document.querySelector('.side-item[data-tab="'+name+'"]');
  if(active)active.classList.add('active');
  $('tab-'+name).classList.add('active');
  closeMenu();
  if(name==='stats')renderStats();
  if(name==='history')renderHistList();
  if(name==='markets'){mkRenderPosition();mkRenderList();mkStartPolling();}
  else{mkStopPolling();}
}
$('menu-btn').onclick=openMenu;
$('menu-overlay').onclick=closeMenu;
document.querySelectorAll('.side-item').forEach(btn=>{btn.onclick=()=>goTab(btn.dataset.tab);});
document.querySelectorAll('.per-btn').forEach(b=>{b.onclick=()=>{document.querySelectorAll('.per-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');renderStats();};});
document.querySelectorAll('.filter-btn').forEach(b=>{b.onclick=()=>{document.querySelectorAll('.filter-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');filterActive=b.dataset.f;renderHistList();};});
$('back-stats').onclick=()=>goTab('dashboard');
$('back-hist').onclick=()=>goTab('dashboard');

$('copy-wh').onclick=()=>{navigator.clipboard.writeText(`${window.location.origin}/webhook/${TOKEN}`).then(()=>toast('URL copiée !')).catch(()=>toast('Copié !'));};

// PUSH
function b64ToU8(b64){const pad='='.repeat((4-b64.length%4)%4);const b=(b64+pad).replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from([...atob(b)].map(c=>c.charCodeAt(0)));}

// INIT
async function init(){if(!TOKEN){showAuth();return;}showApp();await regSW();await loadAll();renderAll();connectSSE();}
init();

/* ════════════════════════════════════
   MARKETS TAB
════════════════════════════════════ */
// Default watchlist
const MK_STORAGE_KEY = 'aurora_watchlist';
const MK_DEFAULTS = ['BTCUSD','ETHUSD','XAUUSD','EURUSD','NAS100'];
let mkWatchlist = JSON.parse(localStorage.getItem(MK_STORAGE_KEY)||'null') || [...MK_DEFAULTS];
let mkPrices = {}; // sym → {price, prev, change, changePct, desc}
let mkInterval = null;

// ── Classify symbol type ──
function mkSymType(sym){
  const s = sym.toUpperCase();
  const cryptos = ['BTC','ETH','BNB','SOL','XRP','LTC','ADA','DOT','LINK','AVAX','DOGE','MATIC','UNI','ATOM','FTM','NEAR','APT','ARB','OP','INJ','TIA','SEI','SUI'];
  const base = s.replace('USD','').replace('USDT','');
  if(cryptos.includes(base)) return 'crypto';
  if(['XAUUSD','XAGUSD','XPTUSD','XPDUSD'].includes(s)) return 'metal';
  if(['NAS100','SPX500','US30','GER40','UK100','JPN225','AUS200','USTEC'].includes(s)) return 'index';
  if(['USOIL','UKOIL','NGAS'].includes(s)) return 'commodity';
  if(s.length===6 && !s.includes('XA')) return 'forex';
  return 'other';
}

// ── Fetch price for one symbol ──
async function mkFetchPrice(sym){
  const s = sym.toUpperCase().trim();
  const prev = mkPrices[s]?.price || null;
  const type = mkSymType(s);

  // ── 1. BINANCE — crypto ──
  if(type === 'crypto'){
    const binanceSym = s.endsWith('USDT') ? s : s.replace('USD','USDT');
    try {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSym}`,{signal:AbortSignal.timeout(4000)});
      if(r.ok){
        const d = await r.json();
        if(d.lastPrice && !d.code){
          const price = parseFloat(d.lastPrice);
          mkPrices[s] = {price, prev:prev||price, change:parseFloat(d.priceChange), changePct:parseFloat(d.priceChangePercent), desc:'Binance', src:'binance'};
          return;
        }
      }
    } catch {}
    // Fallback: CoinGecko for crypto
    try {
      const cgId = mkCoinGeckoId(s);
      if(cgId){
        const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd&include_24hr_change=true`,{signal:AbortSignal.timeout(5000)});
        if(r.ok){
          const d = await r.json();
          if(d[cgId]?.usd){
            const price = d[cgId].usd;
            const changePct = d[cgId].usd_24h_change || 0;
            mkPrices[s] = {price, prev:prev||price, change:price*changePct/100, changePct, desc:'CoinGecko', src:'coingecko'};
            return;
          }
        }
      }
    } catch {}
  }

  // ── 2. METALS — or, argent ──
  if(type === 'metal'){
    // metals-api via allorigins CORS proxy
    try {
      const metalSym = s === 'XAUUSD' ? 'XAU' : s === 'XAGUSD' ? 'XAG' : s.slice(0,3);
      const url = `https://api.metals.live/v1/spot/${metalSym.toLowerCase()}`;
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,{signal:AbortSignal.timeout(6000)});
      if(r.ok){
        const wrapper = await r.json();
        const data = JSON.parse(wrapper.contents);
        if(Array.isArray(data) && data[0]?.price){
          const price = parseFloat(data[0].price);
          const prevClose = mkPrices[s]?.price || price;
          const change = price - prevClose;
          const changePct = prevClose ? (change/prevClose)*100 : 0;
          mkPrices[s] = {price, prev:prev||price, change, changePct, desc:'Metals.live', src:'metals'};
          return;
        }
      }
    } catch {}
    // Fallback: Yahoo Finance v7 (sometimes works with no cookie needed)
    try {
      const r = await fetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=GC%3DF&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent`,{signal:AbortSignal.timeout(5000),headers:{'User-Agent':'Mozilla/5.0'}});
      if(r.ok){
        const d = await r.json();
        const q = d?.quoteResponse?.result?.[0];
        if(q?.regularMarketPrice){
          const price = q.regularMarketPrice;
          mkPrices[s] = {price, prev:prev||price, change:q.regularMarketChange||0, changePct:q.regularMarketChangePercent||0, desc:'Yahoo Finance', src:'yahoo'};
          return;
        }
      }
    } catch {}
  }

  // ── 3. FOREX — paires de devises ──
  if(type === 'forex'){
    try {
      // ExchangeRate-API (gratuit, pas de clé requise pour les majeurs)
      const base = s.slice(0,3);
      const quote = s.slice(3,6);
      const r = await fetch(`https://open.er-api.com/v6/latest/${base}`,{signal:AbortSignal.timeout(5000)});
      if(r.ok){
        const d = await r.json();
        if(d.rates?.[quote]){
          const price = d.rates[quote];
          const prevClose = prev || price;
          const change = price - prevClose;
          const changePct = prevClose ? (change/prevClose)*100 : 0;
          mkPrices[s] = {price, prev:prev||price, change, changePct, desc:'ExchangeRate-API', src:'er-api'};
          return;
        }
      }
    } catch {}
    // Fallback Frankfurter (ECB data)
    try {
      const base = s.slice(0,3);
      const quote = s.slice(3,6);
      const r = await fetch(`https://api.frankfurter.app/latest?from=${base}&to=${quote}`,{signal:AbortSignal.timeout(5000)});
      if(r.ok){
        const d = await r.json();
        if(d.rates?.[quote]){
          const price = d.rates[quote];
          const prevClose = prev || price;
          const change = price - prevClose;
          const changePct = prevClose ? (change/prevClose)*100 : 0;
          mkPrices[s] = {price, prev:prev||price, change, changePct, desc:'Frankfurter · BCE', src:'frankfurter'};
          return;
        }
      }
    } catch {}
  }

  // ── 4. INDICES & COMMODITIES — Yahoo Finance v7 (meilleure version) ──
  const yTicker = mkYahooTicker(s);
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yTicker)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,shortName`,{signal:AbortSignal.timeout(6000)});
    if(r.ok){
      const d = await r.json();
      const q = d?.quoteResponse?.result?.[0];
      if(q?.regularMarketPrice){
        const price = q.regularMarketPrice;
        mkPrices[s] = {price, prev:prev||price, change:q.regularMarketChange||0, changePct:q.regularMarketChangePercent||0, desc:q.shortName||'Yahoo Finance', src:'yahoo'};
        return;
      }
    }
  } catch {}

  // Keep last known or mark error
  if(!mkPrices[s]) mkPrices[s] = {price:null, prev:null, change:0, changePct:0, desc:'Indisponible', src:'err'};
}

function mkCoinGeckoId(sym){
  const map = {'BTCUSD':'bitcoin','ETHUSD':'ethereum','BNBUSD':'binancecoin','SOLUSD':'solana',
    'XRPUSD':'ripple','LTCUSD':'litecoin','ADAUSD':'cardano','DOTUSD':'polkadot',
    'DOGEUSD':'dogecoin','AVAXUSD':'avalanche-2','LINKUSD':'chainlink','UNIUSD':'uniswap',
    'MATICUSD':'matic-network','ATOMUSD':'cosmos','NEARUSD':'near'};
  return map[sym] || null;
}

function mkYahooTicker(sym){
  const map = {
    'EURUSD':'EURUSD=X','GBPUSD':'GBPUSD=X','USDJPY':'USDJPY=X','AUDUSD':'AUDUSD=X','USDCHF':'USDCHF=X',
    'USDCAD':'USDCAD=X','NZDUSD':'NZDUSD=X','EURGBP':'EURGBP=X','EURJPY':'EURJPY=X','GBPJPY':'GBPJPY=X',
    'XAUUSD':'GC=F','XAGUSD':'SI=F','USOIL':'CL=F','UKOIL':'BZ=F','NGAS':'NG=F',
    'NAS100':'^NDX','USTEC':'^NDX','SPX500':'^GSPC','US30':'^DJI','GER40':'^GDAXI','UK100':'^FTSE',
    'JPN225':'^N225','AUS200':'^AXJO',
    'GUUSD':'GBPUSD=X'
  };
  return map[sym] || sym+'=X';
}

function mkFmtPrice(p,sym){
  if(p===null||p===undefined) return '—';
  const s=sym.toUpperCase();
  if(s==='USDJPY'||s.includes('JPY')) return p.toFixed(3);
  if(p>=10000) return p.toFixed(1);
  if(p>=1000) return p.toFixed(2);
  if(p>=10) return p.toFixed(4);
  if(p>=0.1) return p.toFixed(5);
  return p.toFixed(6);
}

// ── Render list of watched symbols ──
function mkRenderList(){
  const list = $('mk-list');
  if(!mkWatchlist.length){list.innerHTML='<div class="empty">Aucun actif surveillé</div>';return;}
  list.innerHTML = mkWatchlist.map(sym=>{
    const d = mkPrices[sym];
    const priceStr = d ? mkFmtPrice(d.price, sym) : '…';
    const isUp = d && d.change >= 0;
    const changeStr = d ? (isUp?'+':'')+d.changePct.toFixed(2)+'%' : '';
    const descStr = d ? d.desc : '';
    const flashClass = '';
    return `<div class="mk-row" id="mk-row-${sym}">
      <div class="mk-row-left">
        <div class="mk-sym">${sym}</div>
        <div class="mk-desc">${descStr}</div>
      </div>
      <div class="mk-price-block">
        <div class="mk-price" id="mk-price-${sym}">${priceStr}</div>
        <div class="mk-change ${isUp?'up':'dn'}" id="mk-change-${sym}">${changeStr}</div>
      </div>
      <button class="mk-del" onclick="mkRemove('${sym}')" title="Retirer">🗑</button>
    </div>`;
  }).join('');
}

// ── Update prices in DOM (smooth flash) ──
function mkUpdateDOM(){
  mkWatchlist.forEach(sym=>{
    const d = mkPrices[sym];
    if(!d) return;
    const priceEl = $('mk-price-'+sym);
    const changeEl = $('mk-change-'+sym);
    const rowEl = $('mk-row-'+sym);
    if(!priceEl) return;
    const newStr = mkFmtPrice(d.price, sym);
    if(priceEl.textContent !== newStr && newStr !== '—'){
      const dir = d.price > (d.prev||d.price) ? 'flash-up' : d.price < (d.prev||d.price) ? 'flash-down' : '';
      priceEl.textContent = newStr;
      if(dir){priceEl.classList.add(dir);setTimeout(()=>priceEl.classList.remove(dir),600);}
    }
    if(changeEl){
      const isUp = d.change >= 0;
      changeEl.textContent = (isUp?'+':'')+d.changePct.toFixed(2)+'%';
      changeEl.className = 'mk-change '+(isUp?'up':'dn');
    }
  });
  // Also update position card live price
  mkRenderPosition();
}

// ── Position card (MT5 style) ──
function mkRenderPosition(){
  const wrap = $('mk-position-wrap');
  if(!wrap) return;
  const t = state.activeTrade;
  if(!t || !t.symbol){wrap.innerHTML='';return;}
  const sym = t.symbol.toUpperCase();
  const d = mkPrices[sym];
  const livePrice = d?.price ?? null;
  const entry = parseFloat(t.entry)||0;
  const sl = parseFloat(t.sl)||0;
  const tp = parseFloat(t.tp1)||0;
  const isLong = t.direction === 'BUY';
  const isPending = t.status === 'pending';
  // Progress toward TP and SL
  let tpPct = 0, slPct = 0;
  if(livePrice && entry){
    if(isLong){
      if(tp>entry) tpPct = Math.min(100,Math.max(0,((livePrice-entry)/(tp-entry))*100));
      if(sl<entry) slPct = Math.min(100,Math.max(0,((entry-livePrice)/(entry-sl))*100));
    } else {
      if(tp<entry) tpPct = Math.min(100,Math.max(0,((entry-livePrice)/(entry-tp))*100));
      if(sl>entry) slPct = Math.min(100,Math.max(0,((livePrice-entry)/(sl-entry))*100));
    }
  }
  // Floating PnL estimate (pips * lot * pip value ≈ rough)
  let pnlStr = '—';
  if(livePrice && entry && t.lot){
    const diff = isLong ? (livePrice-entry) : (entry-livePrice);
    const pipVal = sym.includes('JPY') ? 0.01 : (livePrice>500?0.1:0.0001);
    const pips = diff/pipVal;
    const est = pips * t.lot * (sym.includes('JPY')?1000:10);
    pnlStr = (est>=0?'+€':'-€')+Math.abs(est).toFixed(2);
  }
  const livePriceStr = livePrice ? mkFmtPrice(livePrice, sym) : '…';
  const shortClass = isLong ? '' : ' short';
  wrap.innerHTML = `<div class="mk-position${shortClass}" id="mk-pos-card">
    <div class="mk-pos-glow"></div>
    <div class="mk-pos-hdr">
      <div class="mk-pos-sym">${sym} <span style="font-size:10px;color:var(--muted);font-weight:400">${isPending?'· EN ATTENTE':''}</span></div>
      <div class="mk-pos-badge">
        <div class="mk-pos-dot"></div>
        <div class="mk-pos-dir">${isLong?'▲ LONG':'▼ SHORT'}</div>
      </div>
    </div>
    <div class="mk-pos-live-price" id="mk-pos-live">${livePriceStr}</div>
    <div class="mk-pos-grid">
      <div class="mk-pos-cell"><div class="mk-pos-cell-lbl">Entry</div><div class="mk-pos-cell-val">${mkFmtPrice(entry,sym)}</div></div>
      <div class="mk-pos-cell tp"><div class="mk-pos-cell-lbl">TP</div><div class="mk-pos-cell-val">${mkFmtPrice(tp,sym)}</div></div>
      <div class="mk-pos-cell sl"><div class="mk-pos-cell-lbl">SL</div><div class="mk-pos-cell-val">${mkFmtPrice(sl,sym)}</div></div>
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
    <div class="mk-pos-pnl">
      <div class="mk-pos-pnl-lbl">PnL flottant estimé${t.lot?' · '+t.lot.toFixed(3)+' lots':''}</div>
      <div class="mk-pos-pnl-val ${pnlStr.startsWith('+')?'pos':'neg'}">${pnlStr}</div>
    </div>
  </div>`;
  // Add the trade symbol to watchlist if not already there
  if(!mkWatchlist.includes(sym)){mkWatchlist.unshift(sym);mkSave();mkRenderList();}
}

function mkRemove(sym){
  mkWatchlist = mkWatchlist.filter(s=>s!==sym);
  mkSave();
  mkRenderList();
}

function mkSave(){localStorage.setItem(MK_STORAGE_KEY, JSON.stringify(mkWatchlist));}

async function mkRefreshAll(){
  await Promise.allSettled(mkWatchlist.map(s=>mkFetchPrice(s)));
  mkUpdateDOM();
}

function mkStartPolling(){
  if(mkInterval) clearInterval(mkInterval);
  mkRefreshAll();
  mkInterval = setInterval(mkRefreshAll, 5000);
}

function mkStopPolling(){
  if(mkInterval){clearInterval(mkInterval);mkInterval=null;}
}

// ── Add symbol handler ──
$('mk-add-btn').onclick = async()=>{
  const inp = $('mk-search-inp');
  const sym = inp.value.trim().toUpperCase().replace(/\s+/g,'');
  if(!sym){toast('Entre un symbole');return;}
  if(mkWatchlist.includes(sym)){toast('Déjà dans la liste');inp.value='';return;}
  if(mkWatchlist.length>=20){toast('Max 20 actifs');return;}
  inp.value='';
  mkWatchlist.push(sym);
  mkSave();
  mkRenderList();
  await mkFetchPrice(sym);
  mkUpdateDOM();
};
$('mk-search-inp').addEventListener('keydown',e=>{if(e.key==='Enter'){$('mk-add-btn').click();}});
$('back-markets').onclick = ()=>goTab('dashboard');



