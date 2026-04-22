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
  TOKEN=d.token;USERNAME=d.name;showApp();await loadAll();connectSSE();regSW();}catch{toast('Erreur réseau');}
};
$('btn-login').onclick=async()=>{
  const name=$('auth-login-name').value.trim();
  const pw=$('auth-login-pw').value;
  if(!name){toast('Entre ton pseudo');return;}
  if(!pw){toast('Entre ton mot de passe');return;}
  try{const r=await fetch(`${API}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,password:pw})});
  const d=await r.json();if(!r.ok){toast(d.error||'Identifiants incorrects');return;}
  localStorage.setItem('aurora_token',d.token);localStorage.setItem('aurora_name',d.name);
  TOKEN=d.token;USERNAME=d.name;showApp();await loadAll();renderAll();connectSSE();regSW();}catch{toast('Erreur réseau');}
};
function doLogout(){localStorage.removeItem('aurora_token');localStorage.removeItem('aurora_name');TOKEN=null;USERNAME=null;if(eventSource)eventSource.close();showAuth();}
$('btn-logout').onclick=doLogout;
$('btn-logout2').onclick=doLogout;
$('go-login').onclick=()=>{$('reg-form').style.display='none';$('login-form').style.display='block';};
$('go-reg').onclick=()=>{$('login-form').style.display='none';$('reg-form').style.display='block';};

// SW + Push
async function regSW(){
  if(!('serviceWorker' in navigator))return;
  try{
    const reg=await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if(!TOKEN)return;
    if(!('PushManager' in window)){console.warn('[PUSH] PushManager non supporté');return;}
    const perm=await Notification.requestPermission();
    if(perm!=='granted'){console.warn('[PUSH] Permission refusée');return;}
    const vr=await fetch(`${API}/api/vapid-public-key`);
    const {key}=await vr.json();
    const appKey=Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
    let sub=await reg.pushManager.getSubscription();
    if(!sub){sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:appKey});}
    await fetch(`${API}/api/${TOKEN}/push/subscribe`,{method:'POST',headers:{'Content-Type':'application/json','x-aurora-token':TOKEN},body:JSON.stringify(sub)});
    console.log('[PUSH] Souscription enregistrée ✓');
    $('push-status').textContent='✓ Notifications activées';
  }catch(e){console.warn('[SW/PUSH]',e);}
}

// SSE
function connectSSE(){
  if(eventSource)eventSource.close();
  eventSource=new EventSource(`${API}/api/${TOKEN}/stream`);
  eventSource.addEventListener('state',e=>{const d=JSON.parse(e.data);state.activeTrade=d.activeTrade;state.day=d.day;state.recent=d.recent||[];setOnline(true);renderAll();});
  eventSource.addEventListener('entry',e=>{const t=JSON.parse(e.data);state.activeTrade=t;renderBanner();renderActivePosition();renderDay();toast((t.direction==='BUY'?'▲ LONG':'▼ SHORT')+' — Ordre limite posé');vib([100,50,100]);});
  eventSource.addEventListener('activate',e=>{const t=JSON.parse(e.data);state.activeTrade=t;renderBanner();renderActivePosition();toast((t.direction==='BUY'?'▲ LONG':'▼ SHORT')+' — Ordre activé');vib([150,50,150]);});
  eventSource.addEventListener('cancel',e=>{state.activeTrade=null;renderBanner();renderActivePosition();toast('⚠ Ordre limite annulé');vib([50]);});
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
function renderAll(){renderDay();renderBanner();renderActivePosition();renderRecentList();renderHistList();renderStats();renderSettings();}

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
  const W=c.parentElement?c.parentElement.offsetWidth-36:300;
  const H=90;const dpr=window.devicePixelRatio||1;
  c.width=Math.round(W*dpr);c.height=Math.round(H*dpr);
  c.style.width=W+'px';c.style.height=H+'px';
  const ctx=c.getContext('2d');
  ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,W,H);
  const data=equityData.length>=2?equityData:[0,2,1,4,3,7,5,9,8,12,10,15,13,18,16,21,20,25,23,28,27,32,30,36,34,40,38,44,42,48,50];
  const mn=Math.min(...data),mx=Math.max(...data,mn+1),range=mx-mn;
  const pad=4;
  const pts=data.map((v,i)=>({x:pad+i/(data.length-1)*(W-pad*2),y:H-pad-((v-mn)/range)*(H-pad*2-8)}));
  ctx.beginPath();ctx.moveTo(pts[0].x,H);ctx.lineTo(pts[0].x,pts[0].y);
  for(let i=1;i<pts.length;i++){const mx2=(pts[i-1].x+pts[i].x)/2;ctx.bezierCurveTo(mx2,pts[i-1].y,mx2,pts[i].y,pts[i].x,pts[i].y);}
  ctx.lineTo(pts[pts.length-1].x,H);ctx.closePath();
  const g=ctx.createLinearGradient(0,0,0,H);g.addColorStop(0,'rgba(0,230,118,0.3)');g.addColorStop(1,'rgba(0,230,118,0.0)');
  ctx.fillStyle=g;ctx.fill();
  ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);
  for(let i=1;i<pts.length;i++){const mx2=(pts[i-1].x+pts[i].x)/2;ctx.bezierCurveTo(mx2,pts[i-1].y,mx2,pts[i].y,pts[i].x,pts[i].y);}
  ctx.strokeStyle='#00e676';ctx.lineWidth=2.5;ctx.lineJoin='round';ctx.lineCap='round';ctx.stroke();
}
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

// ── CARTE POSITION (déplacée du Markets vers le Dashboard) ──
// Affiche la position active avec barres de progression TP% et SL%
// basées sur le prix live (polling léger sur le symbole actif uniquement)
let _posInterval=null;
let _livePrices={};

function mkFmtPrice(p,sym){
  if(p===null||p===undefined)return'—';
  const s=(sym||'').toUpperCase();
  if(s.includes('JPY'))return p.toFixed(3);
  if(p>=10000)return p.toFixed(1);
  if(p>=1000)return p.toFixed(2);
  if(p>=10)return p.toFixed(4);
  if(p>=0.1)return p.toFixed(5);
  return p.toFixed(6);
}

async function fetchLivePrice(sym){
  const s=(sym||'').toUpperCase().trim();
  const prev=_livePrices[s]||null;
  try{
    const r=await fetch(`${API}/api/price/${encodeURIComponent(s)}`,{signal:AbortSignal.timeout(7000)});
    if(r.ok){const d=await r.json();if(d.price){_livePrices[s]={price:parseFloat(d.price),prev};return;}}
  }catch{}
}

function renderActivePosition(){
  const wrap=$('active-position-wrap');
  const noActive=$('no-active');
  if(!wrap)return;
  const t=state.activeTrade;
  if(!t){
    wrap.innerHTML='';
    if(noActive)noActive.style.display='block';
    // Arrêter le polling live si plus de trade
    if(_posInterval){clearInterval(_posInterval);_posInterval=null;}
    return;
  }
  if(noActive)noActive.style.display='none';

  const sym=(t.symbol||'NAS100').toUpperCase();
  const d=_livePrices[sym];
  const livePrice=d?.price??null;
  const entry=parseFloat(t.entry)||0;
  const sl=parseFloat(t.sl)||0;
  const tp=parseFloat(t.tp1)||0;
  const isLong=t.direction==='BUY';
  const isPending=t.status==='pending';

  // Barres de progression
  let tpPct=0,slPct=0;
  if(livePrice&&entry){
    if(isLong){
      if(tp>entry)tpPct=Math.min(100,Math.max(0,((livePrice-entry)/(tp-entry))*100));
      if(sl<entry)slPct=Math.min(100,Math.max(0,((entry-livePrice)/(entry-sl))*100));
    }else{
      if(tp<entry)tpPct=Math.min(100,Math.max(0,((entry-livePrice)/(entry-tp))*100));
      if(sl>entry)slPct=Math.min(100,Math.max(0,((livePrice-entry)/(sl-entry))*100));
    }
  }

  const livePriceStr=livePrice?mkFmtPrice(livePrice,sym):'…';
  const shortClass=isLong?'':'short';
  const confirmScore=t.confirmScore||0;

  wrap.innerHTML=`<div class="mk-position ${shortClass}" id="dash-pos-card">
    <div class="mk-pos-glow"></div>
    <div class="mk-pos-hdr">
      <div>
        <div class="mk-pos-sym">${sym} <span class="pill ${isLong?'pill-long':'pill-short'}">${isLong?'LONG':'SHORT'}</span></div>
        <div style="font-size:10px;color:var(--muted);margin-top:3px">${fmtT(t.timestamp)}</div>
      </div>
      <div class="mk-pos-badge">
        <div class="mk-pos-dot"></div>
        <div class="mk-pos-dir">${isPending?'⏳ EN ATTENTE':'● ACTIF'}</div>
      </div>
    </div>
    <div class="mk-pos-live-price" id="dash-pos-live">${livePriceStr}</div>
    <div class="mk-pos-grid">
      <div class="mk-pos-cell"><div class="mk-pos-cell-lbl">Entry</div><div class="mk-pos-cell-val">${mkFmtPrice(entry,sym)}</div></div>
      <div class="mk-pos-cell tp"><div class="mk-pos-cell-lbl">TP1</div><div class="mk-pos-cell-val">${mkFmtPrice(tp,sym)}</div></div>
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
    <div class="mk-pos-ftr">
      <div class="cdots">${[0,1,2].map(i=>`<div class="cdot ${i<confirmScore?'on':''}"></div>`).join('')}</div>
      <div style="font-family:var(--mono);font-size:11px;color:#aa66ff">${t.lot?t.lot.toFixed(3)+' lots':''}</div>
    </div>
  </div>`;

  // Lancer le polling live prix si pas déjà actif
  if(!_posInterval){
    fetchLivePrice(sym).then(()=>updateLivePriceDOM(sym));
    _posInterval=setInterval(async()=>{
      if(!state.activeTrade){clearInterval(_posInterval);_posInterval=null;return;}
      const s2=(state.activeTrade.symbol||'').toUpperCase();
      await fetchLivePrice(s2);
      updateLivePriceDOM(s2);
    },5000);
  }
}

function updateLivePriceDOM(sym){
  const t=state.activeTrade;
  if(!t)return;
  const d=_livePrices[sym];
  if(!d)return;
  const liveEl=$('dash-pos-live');
  if(liveEl){
    const newStr=mkFmtPrice(d.price,sym);
    if(liveEl.textContent!==newStr){
      const dir=(d.prev&&d.price>d.prev.price)?'flash-up':(d.prev&&d.price<d.prev.price)?'flash-down':'';
      liveEl.textContent=newStr;
      if(dir){liveEl.classList.add(dir);setTimeout(()=>liveEl.classList.remove(dir),600);}
    }
  }
  // Recalculer et mettre à jour les barres de progression
  const entry=parseFloat(t.entry)||0;
  const sl=parseFloat(t.sl)||0;
  const tp=parseFloat(t.tp1)||0;
  const isLong=t.direction==='BUY';
  const lp=d.price;
  let tpPct=0,slPct=0;
  if(lp&&entry){
    if(isLong){if(tp>entry)tpPct=Math.min(100,Math.max(0,((lp-entry)/(tp-entry))*100));if(sl<entry)slPct=Math.min(100,Math.max(0,((entry-lp)/(entry-sl))*100));}
    else{if(tp<entry)tpPct=Math.min(100,Math.max(0,((entry-lp)/(entry-tp))*100));if(sl>entry)slPct=Math.min(100,Math.max(0,((lp-entry)/(sl-entry))*100));}
  }
  const card=$('dash-pos-card');
  if(card){
    const fills=card.querySelectorAll('.mk-prog-fill');
    const pcts=card.querySelectorAll('.mk-prog-pct');
    if(fills[0]){fills[0].style.width=tpPct.toFixed(1)+'%';}
    if(fills[1]){fills[1].style.width=slPct.toFixed(1)+'%';}
    if(pcts[0]){pcts[0].textContent=tpPct.toFixed(0)+'%';}
    if(pcts[1]){pcts[1].textContent=slPct.toFixed(0)+'%';}
  }
}

// Trade item HTML
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
  svg.innerHTML=(tp>0?arc(0,slA,44,'#27ae60'):'')+(sl>0?arc(slA,360,44,'#c0392b'):'')+
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
  $('gvp-max').textContent='€'+maxAbs.toFixed(2);
  chart.innerHTML=entries.map(e=>{
    const pct=Math.abs(e.pnl)/maxAbs*100,pos=e.pnl>=0;
    return `<div class="bc-col"><div class="bc-bar" style="height:${pct}%;background:${pos?'#27ae60':'#c0392b'}"></div><div class="bc-day">${e.label.slice(0,3)}</div></div>`;
  }).join('');
}

function renderSettings(){
  $('my-token').textContent=TOKEN||'—';
  $('webhook-url').textContent=`${window.location.origin}/webhook/${TOKEN}`;
}

// ── Side menu ──
function openMenu(){$('side-menu').classList.add('open');$('menu-overlay').classList.add('open');}
function closeMenu(){$('side-menu').classList.remove('open');$('menu-overlay').classList.remove('open');}
function goTab(name){
  document.querySelectorAll('.side-item').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.tab-section').forEach(s=>s.classList.remove('active'));
  const active=document.querySelector(`.side-item[data-tab="${name}"]`);
  if(active)active.classList.add('active');
  $('tab-'+name).classList.add('active');
  closeMenu();
  if(name==='stats')renderStats();
  if(name==='history')renderHistList();
  if(name==='charts')renderCharts();
}
$('menu-btn').onclick=openMenu;
$('menu-overlay').onclick=closeMenu;
document.querySelectorAll('.side-item').forEach(btn=>{btn.onclick=()=>goTab(btn.dataset.tab);});
document.querySelectorAll('.per-btn').forEach(b=>{b.onclick=()=>{document.querySelectorAll('.per-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');renderStats();};});
document.querySelectorAll('.filter-btn').forEach(b=>{b.onclick=()=>{document.querySelectorAll('.filter-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');filterActive=b.dataset.f;renderHistList();};});
$('back-stats').onclick=()=>goTab('dashboard');
$('back-hist').onclick=()=>goTab('dashboard');
$('back-charts').onclick=()=>goTab('dashboard');
document.querySelectorAll('.hm-btn').forEach(b=>{b.onclick=()=>{document.querySelectorAll('.hm-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');renderHeatmap(b.dataset.hm);};});

$('copy-wh').onclick=()=>{navigator.clipboard.writeText(`${window.location.origin}/webhook/${TOKEN}`).then(()=>toast('URL copiée !')).catch(()=>toast('Copié !'));};

// INIT
async function init(){if(!TOKEN){showAuth();return;}showApp();await regSW();await loadAll();renderAll();connectSSE();}
init();

// ================================================================
// === ONGLET GRAPHIQUES
// ================================================================
let _hmMode='hour';

function renderCharts(){
  const trades=[...allTrades].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  drawEquityFull(trades);
  drawDistrib(trades);
  drawCumulDD(trades);
  renderHeatmap(_hmMode);
}

// ── Helpers canvas ──
function setupCanvas(id,h){
  const c=$(id);if(!c)return null;
  const W=c.parentElement.offsetWidth-32;
  const dpr=window.devicePixelRatio||1;
  c.width=Math.round(W*dpr);c.height=Math.round(h*dpr);
  c.style.width=W+'px';c.style.height=h+'px';
  const ctx=c.getContext('2d');ctx.scale(dpr,dpr);ctx.clearRect(0,0,W,h);
  return{ctx,W,H:h};
}

// ── Equity Curve complète ──
function drawEquityFull(trades){
  const cv=setupCanvas('ch-equity',160);if(!cv)return;
  const{ctx,W,H}=cv;
  if(!trades.length){noDataMsg(ctx,W,H);return;}
  let run=0;
  const pts=trades.map(t=>{run+=t.pnl||0;return run;});
  pts.unshift(0);
  const mn=Math.min(...pts),mx=Math.max(...pts,mn+0.01),range=mx-mn;
  const pad=6,bh=H-pad*2-20;
  const xs=(i)=>pad+i/(pts.length-1)*(W-pad*2);
  const ys=(v)=>pad+bh-((v-mn)/range)*bh;

  // Grille horizontale
  ctx.strokeStyle='rgba(255,255,255,0.05)';ctx.lineWidth=1;
  for(let i=0;i<=4;i++){const y=pad+bh/4*i;ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(W-pad,y);ctx.stroke();}

  // Ligne zéro
  if(mn<0&&mx>0){
    const y0=ys(0);
    ctx.strokeStyle='rgba(255,255,255,0.15)';ctx.setLineDash([4,4]);ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(pad,y0);ctx.lineTo(W-pad,y0);ctx.stroke();ctx.setLineDash([]);
  }

  // Remplissage
  ctx.beginPath();ctx.moveTo(xs(0),H-20);ctx.lineTo(xs(0),ys(pts[0]));
  for(let i=1;i<pts.length;i++){const mx2=(xs(i-1)+xs(i))/2;ctx.bezierCurveTo(mx2,ys(pts[i-1]),mx2,ys(pts[i]),xs(i),ys(pts[i]));}
  ctx.lineTo(xs(pts.length-1),H-20);ctx.closePath();
  const last=pts[pts.length-1];
  const g=ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0,last>=0?'rgba(0,230,118,0.25)':'rgba(255,82,82,0.25)');
  g.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=g;ctx.fill();

  // Courbe
  ctx.beginPath();ctx.moveTo(xs(0),ys(pts[0]));
  for(let i=1;i<pts.length;i++){const mx2=(xs(i-1)+xs(i))/2;ctx.bezierCurveTo(mx2,ys(pts[i-1]),mx2,ys(pts[i]),xs(i),ys(pts[i]));}
  ctx.strokeStyle=last>=0?'#00e676':'#ff5252';ctx.lineWidth=2;ctx.stroke();

  // Labels axes
  ctx.fillStyle='rgba(255,255,255,0.3)';ctx.font=`9px 'Space Mono',monospace`;ctx.textAlign='right';
  ctx.fillText((mx>=0?'+':'')+mx.toFixed(0)+'€',W-pad+18,pad+6);
  ctx.fillText((mn>=0?'+':'')+mn.toFixed(0)+'€',W-pad+18,pad+bh+4);

  // Labels X (dates)
  ctx.textAlign='center';ctx.fillStyle='rgba(255,255,255,0.2)';ctx.font=`8px 'Space Mono',monospace`;
  const step=Math.max(1,Math.floor(trades.length/5));
  trades.forEach((t,i)=>{if(i%step!==0)return;const d=new Date(t.timestamp);ctx.fillText(d.toLocaleDateString('fr',{day:'numeric',month:'short'}),xs(i+1),H-4);});
}

// ── Distribution gains/pertes ──
function drawDistrib(trades){
  const cv=setupCanvas('ch-distrib',140);if(!cv)return;
  const{ctx,W,H}=cv;
  if(!trades.length){noDataMsg(ctx,W,H);return;}
  const pnls=trades.map(t=>t.pnl||0).filter(p=>p!==0);
  if(!pnls.length){noDataMsg(ctx,W,H);return;}

  // Buckets
  const mn=Math.min(...pnls),mx=Math.max(...pnls);
  const nb=10;const bw=(mx-mn)/nb||1;
  const buckets=Array(nb).fill(0);
  pnls.forEach(p=>{let i=Math.min(nb-1,Math.floor((p-mn)/bw));buckets[i]++;});
  const maxB=Math.max(...buckets,1);

  const pad=6,bh=H-pad*2-18;
  const cw=(W-pad*2)/nb;

  buckets.forEach((cnt,i)=>{
    const bVal=mn+bw*(i+0.5);
    const barH=cnt/maxB*bh;
    const x=pad+i*cw+1;
    const y=pad+bh-barH;
    ctx.fillStyle=bVal>=0?'rgba(0,230,118,0.7)':'rgba(255,82,82,0.7)';
    ctx.beginPath();
    ctx.roundRect?ctx.roundRect(x,y,cw-2,barH,3):ctx.rect(x,y,cw-2,barH);
    ctx.fill();
  });

  // Labels axes
  ctx.fillStyle='rgba(255,255,255,0.25)';ctx.font=`8px 'Space Mono',monospace`;ctx.textAlign='center';
  ctx.fillText(mn.toFixed(0)+'€',pad+cw*0.5,H-2);
  ctx.fillText('0',pad+cw*(nb/2),H-2);
  ctx.fillText(mx.toFixed(0)+'€',pad+cw*(nb-0.5),H-2);
  ctx.textAlign='left';ctx.fillText(`${pnls.length} trades`,pad,pad+9);
}

// ── Cumulé vs Drawdown ──
function drawCumulDD(trades){
  const cv=setupCanvas('ch-dd',160);if(!cv)return;
  const{ctx,W,H}=cv;
  if(!trades.length){noDataMsg(ctx,W,H);return;}

  let run=0,peak=0,dd=0;
  const cumPts=[0],ddPts=[0];
  trades.forEach(t=>{run+=t.pnl||0;peak=Math.max(peak,run);dd=Math.min(0,run-peak);cumPts.push(run);ddPts.push(dd);});

  const pad=6,bh=(H-pad*2-20)/2;
  const mnC=Math.min(...cumPts),mxC=Math.max(...cumPts,mnC+0.01);
  const mnD=Math.min(...ddPts,-0.01),mxD=0;

  const xs=i=>pad+i/(cumPts.length-1)*(W-pad*2);
  const ysC=v=>pad+(bh-((v-mnC)/(mxC-mnC)*bh));
  const ysD=v=>pad+bh+4+(mxD-v)/(mxD-mnD)*bh;

  // Courbe cumul
  ctx.beginPath();ctx.moveTo(xs(0),ysC(cumPts[0]));
  for(let i=1;i<cumPts.length;i++){const mx2=(xs(i-1)+xs(i))/2;ctx.bezierCurveTo(mx2,ysC(cumPts[i-1]),mx2,ysC(cumPts[i]),xs(i),ysC(cumPts[i]));}
  ctx.strokeStyle='#00e5ff';ctx.lineWidth=2;ctx.stroke();

  // Remplissage cumul
  ctx.beginPath();ctx.moveTo(xs(0),pad+bh);ctx.lineTo(xs(0),ysC(cumPts[0]));
  for(let i=1;i<cumPts.length;i++){const mx2=(xs(i-1)+xs(i))/2;ctx.bezierCurveTo(mx2,ysC(cumPts[i-1]),mx2,ysC(cumPts[i]),xs(i),ysC(cumPts[i]));}
  ctx.lineTo(xs(cumPts.length-1),pad+bh);ctx.closePath();
  const g=ctx.createLinearGradient(0,0,0,pad+bh);g.addColorStop(0,'rgba(0,229,255,0.2)');g.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=g;ctx.fill();

  // Zone drawdown
  ctx.beginPath();ctx.moveTo(xs(0),ysD(0));
  for(let i=1;i<ddPts.length;i++){const mx2=(xs(i-1)+xs(i))/2;ctx.bezierCurveTo(mx2,ysD(ddPts[i-1]),mx2,ysD(ddPts[i]),xs(i),ysD(ddPts[i]));}
  ctx.lineTo(xs(ddPts.length-1),ysD(0));ctx.closePath();
  const g2=ctx.createLinearGradient(0,pad+bh+4,0,H-20);g2.addColorStop(0,'rgba(255,82,82,0.35)');g2.addColorStop(1,'rgba(255,82,82,0.05)');ctx.fillStyle=g2;ctx.fill();
  ctx.beginPath();ctx.moveTo(xs(0),ysD(ddPts[0]));
  for(let i=1;i<ddPts.length;i++){const mx2=(xs(i-1)+xs(i))/2;ctx.bezierCurveTo(mx2,ysD(ddPts[i-1]),mx2,ysD(ddPts[i]),xs(i),ysD(ddPts[i]));}
  ctx.strokeStyle='#ff5252';ctx.lineWidth=1.5;ctx.stroke();

  // Légende
  ctx.font=`9px 'Space Mono',monospace`;ctx.textAlign='left';
  ctx.fillStyle='#00e5ff';ctx.fillText('Cumulé',pad,pad+10);
  ctx.fillStyle='#ff5252';ctx.fillText('Drawdown',pad,pad+bh+14);

  // Max DD
  ctx.fillStyle='rgba(255,255,255,0.3)';ctx.textAlign='right';
  ctx.fillText('Max DD: '+mnD.toFixed(0)+'€',W-pad,H-4);
}

// ── Heatmap ──
function renderHeatmap(mode){
  _hmMode=mode;
  const wrap=$('ch-heatmap');if(!wrap)return;
  const trades=[...allTrades,...state.recent];

  if(mode==='hour'){
    const hours=Array(24).fill(null).map(()=>({pnl:0,count:0}));
    trades.forEach(t=>{const h=new Date(t.timestamp).getHours();hours[h].pnl+=t.pnl||0;hours[h].count++;});
    wrap.innerHTML=buildHeatmapLinear(hours,i=>i+'h',24);
  }else if(mode==='weekday'){
    const days=['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
    const slots=Array(7).fill(null).map(()=>({pnl:0,count:0}));
    trades.forEach(t=>{const d=(new Date(t.timestamp).getDay()+6)%7;slots[d].pnl+=t.pnl||0;slots[d].count++;});
    wrap.innerHTML=buildHeatmapLinear(slots,i=>days[i],7);
  }else if(mode==='week'){
    const slots={};
    trades.forEach(t=>{const d=new Date(t.timestamp);const w=getWeekNum(d);const key=d.getFullYear()+'-W'+w;if(!slots[key])slots[key]={pnl:0,count:0,label:'S'+w};slots[key].pnl+=t.pnl||0;slots[key].count++;});
    const arr=Object.values(slots).slice(-12);
    wrap.innerHTML=buildHeatmapLinear(arr,(_,i,a)=>a[i].label,arr.length);
  }else if(mode==='month'){
    const months=['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
    const slots=Array(12).fill(null).map(()=>({pnl:0,count:0}));
    trades.forEach(t=>{const m=new Date(t.timestamp).getMonth();slots[m].pnl+=t.pnl||0;slots[m].count++;});
    wrap.innerHTML=buildHeatmapLinear(slots,i=>months[i],12);
  }
}

function buildHeatmapLinear(slots,labelFn,n){
  const maxAbs=Math.max(...slots.map(s=>Math.abs(s.pnl||0)),0.01);
  const cells=slots.map((s,i)=>{
    const pnl=s.pnl||0;const count=s.count||0;
    const intensity=Math.abs(pnl)/maxAbs;
    let bg;
    if(count===0)bg='rgba(255,255,255,0.04)';
    else if(pnl>0)bg=`rgba(0,230,118,${0.1+intensity*0.7})`;
    else bg=`rgba(255,82,82,${0.1+intensity*0.7})`;
    const label=labelFn(i,i,slots);
    const val=count>0?(pnl>=0?'+':'')+pnl.toFixed(0)+'€':'';
    return`<div style="flex:1;min-width:0">
      <div class="hm-label" style="margin-bottom:3px">${label}</div>
      <div class="hm-cell" style="background:${bg}">${val}</div>
      <div class="hm-label" style="margin-top:3px;color:rgba(255,255,255,0.2)">${count>0?count+'t':''}</div>
    </div>`;
  });
  // Grouper par lignes de max 8 pour mobile
  const chunkSize=Math.ceil(n/Math.ceil(n/8));
  const rows=[];
  for(let i=0;i<cells.length;i+=chunkSize)rows.push(cells.slice(i,i+chunkSize));
  return rows.map(row=>`<div style="display:flex;gap:3px;margin-bottom:4px">${row.join('')}</div>`).join('');
}

function getWeekNum(d){const s=new Date(d.getFullYear(),0,1);return Math.ceil(((d-s)/86400000+s.getDay()+1)/7);}

function noDataMsg(ctx,W,H){
  ctx.fillStyle='rgba(255,255,255,0.15)';ctx.font=`12px 'Space Mono',monospace`;ctx.textAlign='center';ctx.fillText('Aucune donnée',W/2,H/2);
}
