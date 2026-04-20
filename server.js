const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// ── VAPID keys ──
const VAPID_FILE = path.join(__dirname, '.vapid.json');
let VAPID_PUBLIC, VAPID_PRIVATE;

if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
  VAPID_PUBLIC = process.env.VAPID_PUBLIC;
  VAPID_PRIVATE = process.env.VAPID_PRIVATE;
  console.log('[VAPID] Loaded from environment');
} else if (fs.existsSync(VAPID_FILE)) {
  const v = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  VAPID_PUBLIC = v.publicKey; VAPID_PRIVATE = v.privateKey;
  console.log('[VAPID] Loaded from file');
} else {
  const keys = webpush.generateVAPIDKeys();
  VAPID_PUBLIC = keys.publicKey; VAPID_PRIVATE = keys.privateKey;
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
  console.log('[VAPID] Generated new keys:', VAPID_PUBLIC);
}
webpush.setVapidDetails('mailto:aurora@trading.app', VAPID_PUBLIC, VAPID_PRIVATE);

// ── Persistence ──
const DB_FILE = path.join(__dirname, 'db.json');
const loadDB = () => {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      Object.keys(raw).forEach(t => { raw[t].subscribers = []; });
      console.log(`[DB] Loaded ${Object.keys(raw).length} user(s)`);
      return raw;
    }
  } catch(e) { console.error('[DB] Load error:', e.message); }
  return {};
};
const saveDB = () => {
  try {
    const toSave = {};
    Object.keys(users).forEach(token => { const { subscribers, ...rest } = users[token]; toSave[token] = rest; });
    fs.writeFileSync(DB_FILE, JSON.stringify(toSave, null, 2));
  } catch(e) { console.error('[DB] Save error:', e.message); }
};

const users = loadDB();

const createUser = (name) => {
  const token = crypto.randomBytes(16).toString('hex');
  users[token] = { name, token, trades: [], activeTrade: null, subscribers: [], pushSubs: [] };
  saveDB();
  console.log(`[USER] Created "${name}" token: ${token}`);
  return users[token];
};
const getUser = (token) => users[token] || null;

// ── Stats ──
const dayStats = (trades) => {
  const today = new Date().toDateString();
  const t = trades.filter(t => new Date(t.timestamp).toDateString() === today);
  const tp = t.filter(t => t.result === 'TP1').length, sl = t.filter(t => t.result === 'SL').length;
  const pnl = t.reduce((s,t) => s+(t.pnl||0), 0), rr = t.reduce((s,t) => s+(t.rr||0), 0);
  return { total:t.length, tp, sl, pnl:Math.round(pnl*100)/100, rr:Math.round(rr*100)/100, wr:t.length>0?Math.round(tp/t.length*1000)/10:0 };
};
const allStats = (trades) => {
  const tp = trades.filter(t => t.result==='TP1').length, sl = trades.filter(t => t.result==='SL').length;
  const pnl = trades.reduce((s,t) => s+(t.pnl||0), 0), rr = trades.reduce((s,t) => s+(t.rr||0), 0);
  return { total:trades.length, tp, sl, pnl:Math.round(pnl*100)/100, rr:Math.round(rr*100)/100, wr:trades.length>0?Math.round(tp/trades.length*1000)/10:0 };
};

// ── Broadcast SSE ──
const broadcast = (user, event, data) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  user.subscribers = user.subscribers.filter(res => { try { res.write(msg); return true; } catch { return false; } });
};

// ── Send push ──
const sendPush = async (user, payload) => {
  if (!user.pushSubs || !user.pushSubs.length) return;
  const dead = [];
  for (const sub of user.pushSubs) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload)); }
    catch(e) { dead.push(sub.endpoint); }
  }
  if (dead.length) { user.pushSubs = user.pushSubs.filter(s => !dead.includes(s.endpoint)); saveDB(); }
};

// ── Auth ──
const auth = (req, res, next) => {
  const token = req.params.token || req.headers['x-aurora-token'];
  const user = getUser(token);
  if (!user) return res.status(401).json({ error: 'Token invalide' });
  req.user = user; next();
};

// ── Routes ──
app.get('/api/vapid-public-key', (req, res) => res.json({ key: VAPID_PUBLIC }));

app.post('/api/register', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  if (Object.values(users).find(u => u.name.toLowerCase() === name.toLowerCase()))
    return res.status(409).json({ error: 'Nom déjà pris' });
  const user = createUser(name);
  res.json({ token: user.token, name: user.name });
});

app.post('/api/login', (req, res) => {
  const user = getUser(req.body.token);
  if (!user) return res.status(401).json({ error: 'Token invalide' });
  res.json({ token: user.token, name: user.name });
});

app.post('/api/:token/push/subscribe', auth, (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  const user = req.user;
  user.pushSubs = (user.pushSubs || []).filter(s => s.endpoint !== sub.endpoint);
  user.pushSubs.push(sub);
  saveDB();
  console.log(`[PUSH] ${user.name} subscribed (${user.pushSubs.length} device(s))`);
  res.json({ ok: true });
});

app.post('/webhook/:token', async (req, res) => {
  const user = getUser(req.params.token);
  if (!user) return res.status(401).json({ error: 'Token invalide' });
  const body = req.body;
  if (!body || !body.action) return res.status(400).json({ error: 'Invalid payload' });
  const now = new Date().toISOString();

  if (body.action === 'BUY' || body.action === 'SELL') {
    user.activeTrade = { id:crypto.randomUUID(), symbol:body.symbol||'NAS100', direction:body.action, lot:body.lot||0, entry:body.entry||null, sl:body.sl||null, tp1:body.tp1||null, timestamp:now, result:null, pnl:null, rr:null, confirmScore:body.confirmScore||null };
    broadcast(user, 'entry', user.activeTrade);
    await sendPush(user, { title: body.action==='BUY'?'▲ LONG — Entrée confirmée':'▼ SHORT — Entrée confirmée', body:`${body.symbol||'NAS100'} · Lot ${body.lot||'—'}`, tag:'entry', icon:'/icon-192.png' });
  }
  if (body.action === 'CLOSE_TP' || body.action === 'CLOSE_SL') {
    const result = body.action==='CLOSE_TP'?'TP1':'SL';
    if (user.activeTrade) {
      const rr = result==='TP1'?1:-1;
      // Calcul du pnl réel depuis entry/sl/tp1/lot stockés à l'entrée
      let pnl;
      if (body.pnl) {
        pnl = body.pnl;
      } else {
        const t = user.activeTrade;
        const riskAmount = parseFloat(t.riskAmount);
        const rr1 = parseFloat(t.rr1) || 1.0;
        if (riskAmount && riskAmount > 0) {
          pnl = result === 'TP1'
            ? Math.round(riskAmount * rr1 * 100) / 100
            : -Math.round(riskAmount * 100) / 100;
        } else {
          pnl = result === 'TP1' ? 100 : -100;
        }
      }
      const closed = { ...user.activeTrade, result, pnl, rr, closedAt:now };
      user.trades.push(closed); user.activeTrade = null; saveDB();
      broadcast(user, 'close', { trade:closed, day:dayStats(user.trades) });
      await sendPush(user, { title:result==='TP1'?'✔ TP1 touché':'✖ SL touché', body:`${closed.symbol} · ${rr>0?'+':'-'}$${Math.abs(pnl)} · ${rr>0?'+':''}${rr}R`, tag:'close', icon:'/icon-192.png' });
    }
  }
  res.json({ ok: true });
});

app.get('/api/:token/stream', auth, (req, res) => {
  res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive'); res.flushHeaders();
  req.user.subscribers.push(res);
  res.write(`event: state\ndata: ${JSON.stringify({ activeTrade:req.user.activeTrade, day:dayStats(req.user.trades), recent:req.user.trades.slice(-20).reverse() })}\n\n`);
  req.on('close', () => { req.user.subscribers = req.user.subscribers.filter(r => r!==res); });
});

app.get('/api/:token/state', auth, (req, res) => {
  const u=req.user; res.json({ activeTrade:u.activeTrade, day:dayStats(u.trades), all:allStats(u.trades), recent:u.trades.slice(-50).reverse() });
});

app.get('/api/:token/trades', auth, (req, res) => {
  const { from, to, result } = req.query;
  let list = [...req.user.trades].reverse();
  if (from) list = list.filter(t => new Date(t.timestamp) >= new Date(from));
  if (to) list = list.filter(t => new Date(t.timestamp) <= new Date(to));
  if (result) list = list.filter(t => t.result === result);
  res.json(list);
});

app.post('/api/:token/trades', auth, (req, res) => {
  const t=req.body, u=req.user;
  const trade = { id:crypto.randomUUID(), symbol:t.symbol||'NAS100', direction:t.direction||'BUY', lot:t.lot||0, entry:t.entry, sl:t.sl, tp1:t.tp1, result:t.result, pnl:parseFloat(t.pnl)||0, rr:t.result==='TP1'?1:-1, timestamp:t.timestamp||new Date().toISOString(), closedAt:t.closedAt||new Date().toISOString(), manual:true };
  u.trades.push(trade); saveDB();
  broadcast(u, 'manual', { trade, day:dayStats(u.trades) });
  res.json({ ok:true, trade });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Aurora server :${PORT}`));
