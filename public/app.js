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
const fmtEs=n=>n==null?'—':(n>=0?'+€':'-€')+Math.abs(Math.round(n));
const fmtP=n=>n==null?'—':(n>100?Number(n).toFixed(0):Number(n).toFixed(4));
const fmtT=iso=>{if(!iso)return'';const d=new Date(iso),now=new Date(),dm=Math.round((now-d)/60000);if(dm<1)return'À l\'instant';if(dm<60)return`Il y a ${dm}m`;if(d.toDateString()===now.toDateString())return d.toLocaleTimeString('fr',{hour:'2-digit',minute:'2-digit'});return d.toLocaleDateString('fr',{day:'numeric',month:'short'});};

function toast(msg,ms=2500){const t=$('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),ms);}
function vib(p){if(navigator.vibrate)navigator.vibrate(p);}

// ── AUTH ──
function showAuth(){$('auth-screen').style.display='flex';$('app-screen').style.display='none';}
function showApp(){$('auth-screen').style.display='none';$('app-screen').style.display='flex';}

$('btn-reg').onclick=async()=>{
  const name=$('auth-name').value.trim();
  if(!name){toast('Entre un pseudo');return;}
  try{const r=await fetch(`${API}/api/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
  const d=await r.json();if(!r.ok){toast(d.error||'Erreur');return;}
  localStorage.setItem('aurora_token',d.token);localStorage.setItem('aurora_name',d.name);
  TOKEN=d.token;USERNAME=d.name;showApp();await loadAll();connectSSE();}catch{toast('Erreur réseau');}
};

$('btn-login').onclick=async()=>{
  const tok=$('auth-tok').value.trim();
  if(!tok){toast('Entre ton token');return;}
  try{const r=await fetch(`${API}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:tok})});
  const d=await r.json();if(!r.ok){toast(d.error||'Token invalide');return;}
  localStorage.setItem('aurora_token',d.token);localStorage.setItem('aurora_name',d.name);
  TOKEN=d.token;USERNAME=d.name;showApp();await loadAll();connectSSE();}catch{toast('Erreur réseau');}
};

$('btn-logout').onclick=()=>{localStorage.removeItem('aurora_token');localStorage.removeItem('aurora_name');TOKEN=null;USERNAME=null;if(eventSource)eventSource.close();showAuth();};
$('go-login').onclick=()=>{$('reg-form').style.display='none';$('login-form').style.display='block';};
$('go-reg').onclick=()=>{$('login-form').style.display='none';$('reg-form').style.display='block';};

// ── SW ──
async function regSW(){if(!('serviceWorker'in navigator))return;try{await navigator.serviceWorker.register('/sw.js');}catch(e){console.warn('[SW]',e);}}

// ── SSE ──
function connectSSE(){
  if(eventSource)eventSource.close();
  eventSource=new EventSource(`${API}/api/${TOKEN}/stream`);
  eventSource.addEventListener('state',e=>{const d=JSON.parse(e.data);state.activeTrade=d.activeTrade;state.day=d.day;state.recent=d.recent||[];setOnline(true);renderAll();});
  eventSource.addEventListener('entry',e=>{const t=JSON.parse(e.data);state.activeTrade=t;renderBanner();renderActiveCard();renderDay();toast((t.direction==='BUY'?'▲ LONG':'▼ SHORT')+' — Entrée confirmée');vib([100,50,100]);});
  eventSource.addEventListener('close',e=>{const{trade,day}=JSON.parse(e.data);state.activeTrade=null;state.day=day;state.recent.unshift(trade);allTrades.unshift(trade);equityData=computeEquity(allTrades);renderAll();toast(trade.result==='TP1'?`✔ TP Atteint ${fmtEs(trade.pnl)}`:`✖ SL Touché ${fmtEs(trade.pnl)}`,3000);vib([200]);});
  eventSource.addEventListener('manual',e=>{const{trade,day}=JSON.parse(e.data);state.day=day;state.recent.unshift(trade);allTrades.unshift(trade);renderHistList();renderDay();toast('Trade ajouté');});
  eventSource.onerror=()=>{setOnline(false);setTimeout(connectSSE,3000);};
}

function setOnline(on){
  const d=$('sdot');if(d)d.classList.toggle('off',!on);
  const s=$('stext');if(s)s.textContent=on?`Bot Status: ACTIVE`:'Bot Status: OFFLINE';
}

// ── LOAD ──
async function loadAll(){
  try{const r=await fetch(`${API}/api/${TOKEN}/state`);if(!r.ok)return;const d=await r.json();state.activeTrade=d.activeTrade;state.day=d.day;state.all=d.all;state.recent=d.recent||[];}catch{}
  try{const r=await fetch(`${API}/api/${TOKEN}/trades`);allTrades=await r.json();equityData=computeEquity(allTrades);}catch{}
}

function computeEquity(trades){
  const s=[...trades].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  let run=0;return s.map(t=>{run+=t.pnl||0;return run;});
}

// ── RENDER ──
function renderAll(){renderDay();renderBanner();renderActiveCard();renderRecentList();renderHistList();renderStats();renderSettings();}

function renderDay(){
  const d=state.day,pnl=d.pnl||0,wr=d.wr||0;
  $('d-pnl').textContent=fmtE(pnl);$('d-pnl').className='green'+(pnl<0?' red':'');
  $('d-pct').textContent=(wr>=0?'+':'')+wr.toFixed(1)+'%';$('d-pct').className='pnl-pct '+(wr>=0?'green':'red');
  $('d-today').textContent=fmtEs(pnl);$('d-today').className='s3-val '+(pnl>=0?'green':'red');
  $('d-wr').textContent=wr.toFixed(0)+'%';$('d-wr').style.color=wr>=50?'var(--green)':'var(--red)';
  $('d-dd').textContent='-'+(d.sl||0)+'R';
  drawEquity();
}

function drawEquity(){
  const c=$('eq-canvas');if(!c)return;
  const ctx=c.getContext('2d'),W=c.offsetWidth||300,H=80;
  c.width=W;c.height=H;ctx.clearRect(0,0,W,H);
  const data=equityData.length>=2?equityData:[0,10,8,15,12,20,25,22,30];
  const mn=Math.min(...data),mx=Math.max(...data,mn+1),range=mx-mn;
  const pts=data.map((v,i)=>({x:i/(data.length-1)*(W-4)+2,y:H-4-((v-mn)/range)*(H-12)}));
  const g=ctx.createLinearGradient(0,0,0,H);g.addColorStop(0,'rgba(0,230,118,0.28)');g.addColorStop(1,'rgba(0,230,118,0)');
  ctx.beginPath();ctx.moveTo(pts[0].x,H);pts.forEach(p=>ctx.lineTo(p.x,p.y));ctx.lineTo(pts[pts.length-1].x,H);ctx.closePath();ctx.fillStyle=g;ctx.fill();
  ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);pts.forEach(p=>ctx.lineTo(p.x,p.y));
  ctx.strokeStyle='#00e676';ctx.lineWidth=2;ctx.lineJoin='round';ctx.stroke();
}

function renderBanner(){
  const t=state.activeTrade,b=$('ab');
  if(!t){b.style.display='none';return;}
  b.style.display='flex';
  $('ab-dir').textContent=(t.direction==='BUY'?'▲ LONG':'▼ SHORT')+' EN COURS';
  $('ab-dir').style.color=t.direction==='BUY'?'var(--green)':'var(--red)';
  $('ab-lvl').innerHTML=`E <span>${fmtP(t.entry)}</span> · SL <span style="color:var(--red)">${fmtP(t.sl)}</span> · TP <span style="color:var(--green)">${fmtP(t.tp1)}</span>`;
  $('ab-lot').textContent=t.lot?t.lot.toFixed(3)+' lots':'';
}

function renderActiveCard(){
  const t=state.activeTrade;
  if(!t){$('active-card').style.display='none';$('no-active').style.display='block';return;}
  $('active-card').style.display='block';$('no-active').style.display='none';
  $('ac-sym').innerHTML=(t.symbol||'NAS100')+' <span class="pill '+(t.direction==='BUY'?'pill-long':'pill-short')+'">'+(t.direction==='BUY'?'LONG':'SHORT')+'</span>';
  $('ac-time').textContent=fmtT(t.timestamp);
  $('ac-e').textContent=fmtP(t.entry);$('ac-sl').textContent=fmtP(t.sl);$('ac-tp').textContent=fmtP(t.tp1);
  $('ac-lot').textContent=t.lot?t.lot.toFixed(3)+' lots':'';
  const sc=t.confirmScore||0;$('ac-dots').innerHTML=[0,1,2].map(i=>`<div class="cdot ${i<sc?'on':''}"></div>`).join('');
}

function tiHTML(t){
  const isTP=t.result==='TP1';
  const dir=t.direction==='BUY'?'Achat':'Vente';
  const pnlC=(t.pnl||0)>=0?'green':'red';
  return `<div class="trade-item">
    <div class="ti-icon">⚡</div>
    <div class="ti-body">
      <div class="ti-title">${dir} ${t.symbol||'NAS100'}</div>
      <div class="ti-entry">Entrée : ${fmtP(t.entry)}</div>
      <div class="ti-result">
        ${isTP?'✅':'⚠️'}
        <span class="${pnlC}">${isTP?'TP Atteint':'SL Touché'} ${fmtEs(t.pnl)}</span>
      </div>
    </div>
    <div class="ti-right">
      <div class="ti-pnl ${pnlC}">${fmtE(t.pnl)}</div>
      <div class="ti-time">${fmtT(t.timestamp)}</div>
      <div class="ti-dots">···</div>
    </div>
  </div>`;
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
  $('s-wr').textContent=wr.toFixed(0)+'%';$('s-wr').style.color=wr>=50?'var(--green)':'var(--red)';
  const tpP=total>0?tp/total*100:0,slP=total>0?sl/total*100:0;
  $('wbar-tp').style.width=tpP+'%';$('wct-tp').textContent=tp;
  $('wbar-sl').style.width=slP+'%';$('wct-sl').textContent=sl;
  renderDonut(tp,sl);renderBarChart();
}

function renderDonut(tp,sl){
  const svg=$('donut'),total=tp+sl;
  if(!total){svg.innerHTML='<circle cx="60" cy="60" r="42" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="16"/>';return;}
  const tpA=(tp/total)*360,slA=tpA===360?359.9:tpA;
  const p=(a,r)=>{const rad=(a-90)*Math.PI/180;return{x:60+r*Math.cos(rad),y:60+r*Math.sin(rad)};};
  const arc=(s,e,r,col)=>{const lg=e-s>180?1:0;const sp=p(s,r);const ep=p(e,r);return`<path d="M${sp.x},${sp.y} A${r},${r} 0 ${lg},1 ${ep.x},${ep.y}" fill="none" stroke="${col}" stroke-width="16" stroke-linecap="butt"/>`;};
  const wpct=Math.round(tp/total*100),lpct=100-wpct;
  svg.innerHTML=
    (tp>0?arc(0,slA,42,'#2ecc71'):'')+(sl>0?arc(slA,360,42,'#e74c3c'):'')+
    `<text x="60" y="54" text-anchor="middle" font-size="14" font-weight="700" fill="#fff" font-family="Space Mono,monospace">${wpct}%</text>`+
    `<text x="60" y="70" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.5)" font-family="Space Mono,monospace">${lpct}%</text>`;
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
    return `<div class="bc-col"><div class="bc-bar" style="height:${pct}%;background:${pos?'#2ecc71':'#e74c3c'};opacity:0.9"></div><div class="bc-day">${e.label.slice(0,3)}</div></div>`;
  }).join('');
}

function renderSettings(){$('my-token').textContent=TOKEN||'—';$('webhook-url').textContent=`${window.location.origin}/webhook/${TOKEN}`;}

// ── NAV ──
document.querySelectorAll('.nav-btn').forEach(btn=>{
  btn.onclick=()=>{
    const name=btn.dataset.tab;
    document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-section').forEach(s=>s.classList.remove('active'));
    btn.classList.add('active');$(`tab-${name}`).classList.add('active');
    if(name==='stats')renderStats();
    if(name==='history')renderHistList();
  };
});

document.querySelectorAll('.per-btn').forEach(b=>{b.onclick=()=>{document.querySelectorAll('.per-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');renderStats();};});
document.querySelectorAll('.filter-btn').forEach(b=>{b.onclick=()=>{document.querySelectorAll('.filter-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');filterActive=b.dataset.f;renderHistList();};});
document.querySelectorAll('.back-btn').forEach(b=>{b.onclick=()=>{document.querySelectorAll('.nav-btn').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.tab-section').forEach(s=>s.classList.remove('active'));document.querySelector('[data-tab="dashboard"]').classList.add('active');$('tab-dashboard').classList.add('active');};});

$('copy-wh').onclick=()=>{navigator.clipboard.writeText(`${window.location.origin}/webhook/${TOKEN}`).then(()=>toast('URL copiée !')).catch(()=>toast('Copié !'));};
$('copy-token').onclick=()=>{navigator.clipboard.writeText(TOKEN||'').then(()=>toast('Token copié !')).catch(()=>toast(TOKEN));};

$('submit-manual').onclick=async()=>{
  const body={symbol:$('f-sym').value,direction:$('f-dir').value,entry:parseFloat($('f-entry').value)||null,lot:parseFloat($('f-lot').value)||null,sl:parseFloat($('f-sl').value)||null,tp1:parseFloat($('f-tp').value)||null,result:$('f-res').value,pnl:parseFloat($('f-pnl').value)||0};
  try{await fetch(`${API}/api/${TOKEN}/trades`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});['f-entry','f-lot','f-sl','f-tp','f-pnl'].forEach(id=>$(id).value='');toast('Trade enregistré ✓');}catch{toast('Erreur réseau');}
};

// ── PUSH ──
function b64ToU8(b64){const pad='='.repeat((4-b64.length%4)%4);const b=(b64+pad).replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from([...atob(b)].map(c=>c.charCodeAt(0)));}
$('enable-push').onclick=async()=>{
  if(!('PushManager'in window)){toast('Push non supporté');return;}
  const perm=await Notification.requestPermission();
  if(perm!=='granted'){toast('Permission refusée');return;}
  try{
    const{key}=await(await fetch(`${API}/api/vapid-public-key`)).json();
    const reg=await navigator.serviceWorker.ready;
    const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64ToU8(key)});
    await fetch(`${API}/api/${TOKEN}/push/subscribe`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub)});
    $('push-status').textContent='✓ Notifications activées';$('push-status').style.color='var(--green)';toast('Notifications activées !');
  }catch(e){toast('Erreur: '+e.message);}
};

// ── INIT ──
async function init(){
  if(!TOKEN){showAuth();return;}
  showApp();await regSW();await loadAll();renderAll();connectSSE();
}
init();
