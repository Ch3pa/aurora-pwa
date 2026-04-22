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

const hashPassword = (pw) => crypto.createHash('sha256').update(pw + 'aurora_salt_v1').digest('hex');

const createUser = (name, passwordHash) => {
  const token = crypto.randomBytes(16).toString('hex');
  users[token] = { name, token, passwordHash, trades: [], activeTrade: null, subscribers: [], pushSubs: [] };
  saveDB();
  console.log(`[USER] Created "${name}" token: ${token}`);
  return users[token];
};
const getUser = (token) => users[token] || null;
const getUserByName = (name) => Object.values(users).find(u => u.name.toLowerCase() === name.toLowerCase()) || null;

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

// ── Phrases aléatoires (identiques à Pushover dans aurora.py) ──
const PHRASES_TP = [
  "encore un génie du capital", "argent qui arrive par hasard évidemment",
  "tu maîtrises totalement (non)", "jackpot totalement mérité (ou pas)",
  "le marché t'a choisi", "miracle financier quotidien",
  "ça tombe bien t'étais pauvre", "stratégie évidemment volontaire",
  "argent généré par pure chance", "tu appelles ça du skill",
  "impressionnant… ou pas", "profit totalement prévu (mensonge)",
  "le hasard travaille bien", "bravo le casino t'aime",
  "tu savais exactement ce que tu faisais (lol)", "gain validé par l'univers",
  "encore un coup de génie", "ça paye étonnamment",
  "même toi t'y crois pas", "bénéfice calculé",
  "marché trop gentil avec toi", "argent arrivé sans raison",
  "tu fais semblant de contrôler", "stratégie miraculeuse aka chance",
  "profit obtenu par magie", "Wall Street tremble (non)",
  "encore une masterclass imaginaire", "tu vas prétendre que c'était prévu",
  "argent tombé du ciel", "performance totalement suspecte",
];
const PHRASES_SL = [
  "masterclass de génie inversé", "tu maîtrises parfaitement la perte",
  "stratégie du don volontaire", "argent offert avec amour",
  "encore choix audacieux", "tu nourris le marché",
  "performance impressionnante négativement", "t'as fait un don au hasard",
  "perte totalement prévue (non)", "bravo tu finances les autres",
  "tu vas dire que c'était le plan", "marché content de toi",
  "argent parti en vacances", "décision financière douteuse",
  "encore masterclass à l'envers", "tu confonds gain et crash",
  "stratégie de destruction de capital", "tu nourris la liquidité",
  "perte contrôlée selon toi", "bravo sponsor du marché",
  "argent disparu avec élégance", "tu fais semblant que c'est ok",
  "le marché t'a remercié", "don involontaire réussi",
  "encore brillante catastrophe", "capital en disparition volontaire",
  "tu appelles ça risk management", "perte artistique",
  "argent parti sans toi", "tu regardes sans comprendre",
];
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

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
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Pseudo et mot de passe requis' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min)' });
  if (getUserByName(name)) return res.status(409).json({ error: 'Ce pseudo est déjà pris' });
  const user = createUser(name, hashPassword(password));
  res.json({ token: user.token, name: user.name });
});

app.post('/api/login', (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Pseudo et mot de passe requis' });
  const user = getUserByName(name);
  if (!user) return res.status(401).json({ error: 'Pseudo introuvable' });
  if (!user.passwordHash) {
    user.passwordHash = hashPassword(password);
    saveDB();
    return res.json({ token: user.token, name: user.name });
  }
  if (user.passwordHash !== hashPassword(password)) return res.status(401).json({ error: 'Mot de passe incorrect' });
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

  // ── BUY_LIMIT / SELL_LIMIT ──
  if (body.action === 'BUY_LIMIT' || body.action === 'SELL_LIMIT') {
    const direction = body.action === 'BUY_LIMIT' ? 'BUY' : 'SELL';
    const dirEmoji = direction === 'BUY' ? '▲ LONG' : '▼ SHORT';
    const sym = body.symbol || 'NAS100';
    const lot = parseFloat(body.lot) || 0;
    user.activeTrade = {
      id: crypto.randomUUID(), symbol: sym, direction, lot,
      entry: body.entry || null, sl: body.sl || null, tp1: body.tp1 || null,
      riskAmount: parseFloat(body.riskAmount) || null, rr1: parseFloat(body.rr1) || 1,
      timestamp: now, result: null, pnl: null, rr: null, status: 'pending'
    };
    broadcast(user, 'entry', user.activeTrade);
    // Pas de push ici — la notification est envoyée à l'activation réelle de l'ordre
  }

  // ── ACTIVATE (ordre limite exécuté → passage pending → active) ──
  if (body.action === 'ACTIVATE') {
    if (user.activeTrade) {
      const sym = body.symbol || user.activeTrade.symbol || 'NAS100';
      const lot = user.activeTrade.lot || 0;
      const dir = user.activeTrade.direction;
      user.activeTrade.status = 'active';
      if (body.entry) user.activeTrade.entry = body.entry;
      broadcast(user, 'activate', user.activeTrade);
      const dirLabel = dir === 'BUY' ? '▲ LONG' : '▼ SHORT';
      await sendPush(user, {
        title: `${dirLabel} — ${sym}`,
        body: `Entrée confirmée · ${lot.toFixed(3)} lots`,
        tag: 'aurora-activate'
      });
    }
  }

  // ── CANCEL_LIMIT ──
  if (body.action === 'CANCEL_LIMIT') {
    user.activeTrade = null;
    broadcast(user, 'cancel', {});
    // Pas de push — annulation silencieuse
  }

  // ── CLOSE_TP / CLOSE_SL ──
  if (body.action === 'CLOSE_TP' || body.action === 'CLOSE_SL') {
    const isTP = body.action === 'CLOSE_TP';
    const result = isTP ? 'TP1' : 'SL';

    if (user.activeTrade) {
      const sym = user.activeTrade.symbol || body.symbol || 'NAS100';
      const lot = user.activeTrade.lot || 0;
      const rr = isTP ? (user.activeTrade.rr1 || 1) : -1;

      // ── PnL RÉEL : priorité absolue au pnl envoyé par MT5 via le webhook ──
      // aurora.py envoie déjà le vrai PnL MT5 dans body.pnl pour CLOSE_TP/CLOSE_SL
      // (calculé depuis mt5.history_deals_get). On l'utilise directement.
      let pnl;
      if (body.pnl != null && body.pnl !== '' && !isNaN(parseFloat(body.pnl))) {
        // PnL réel MT5 reçu depuis aurora.py
        pnl = parseFloat(body.pnl);
        console.log(`[PNL] PnL réel MT5 reçu : ${pnl} $ (${result})`);
      } else if (user.activeTrade.riskAmount) {
        // Fallback estimé si MT5 n'a pas envoyé le PnL
        pnl = isTP ? user.activeTrade.riskAmount * (user.activeTrade.rr1 || 1) : -user.activeTrade.riskAmount;
        console.log(`[PNL] PnL estimé (fallback) : ${pnl} $`);
      } else {
        pnl = isTP ? 100 : -100;
        console.log(`[PNL] PnL par défaut : ${pnl} $`);
      }

      const closed = { ...user.activeTrade, result, pnl: Math.round(pnl * 100) / 100, rr, closedAt: now };
      user.trades.push(closed);
      user.activeTrade = null;
      saveDB();
      broadcast(user, 'close', { trade: closed, day: dayStats(user.trades) });

      // Push : résultat, symbole, PNL et phrase
      const exitEmoji = isTP ? '🚀' : '❌';
      const exitLabel = isTP ? 'TP1' : 'SL';
      const pnlSign = pnl >= 0 ? '+' : '';
      const pnlTxt = `${pnlSign}${Math.round(pnl * 100) / 100} $`;
      const phrase = pick(isTP ? PHRASES_TP : PHRASES_SL);

      await sendPush(user, {
        title: `${exitLabel} ${exitEmoji} — ${sym}`,
        body: `PNL : ${pnlTxt}\n${phrase}`,
        tag: 'aurora-close'
      });
    }
  }

  res.json({ ok: true });
});

app.get('/api/:token/stream', auth, (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders();
  req.user.subscribers.push(res);
  res.write(`event: state\ndata: ${JSON.stringify({ activeTrade:req.user.activeTrade, day:dayStats(req.user.trades), recent:req.user.trades.slice(-20).reverse() })}\n\n`);
  req.on('close', () => { req.user.subscribers = req.user.subscribers.filter(r => r!==res); });
});

app.get('/api/:token/state', auth, (req, res) => {
  const u=req.user;
  res.json({ activeTrade:u.activeTrade, day:dayStats(u.trades), all:allStats(u.trades), recent:u.trades.slice(-50).reverse() });
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
  const trade = {
    id: crypto.randomUUID(), symbol: t.symbol||'NAS100', direction: t.direction||'BUY',
    lot: t.lot||0, entry: t.entry, sl: t.sl, tp1: t.tp1,
    result: t.result, pnl: parseFloat(t.pnl)||0, rr: t.result==='TP1'?1:-1,
    timestamp: t.timestamp||new Date().toISOString(),
    closedAt: t.closedAt||new Date().toISOString(), manual: true
  };
  u.trades.push(trade); saveDB();
  broadcast(u, 'manual', { trade, day: dayStats(u.trades) });
  res.json({ ok:true, trade });
});

// ── Prix live — proxy serveur (évite CORS côté navigateur) ──
app.get('/api/price/:symbol', async (req, res) => {
  const s = req.params.symbol.toUpperCase().trim();
  const cryptoBases = new Set(['BTC','ETH','BNB','SOL','XRP','LTC','ADA','DOT','LINK','AVAX','DOGE','MATIC']);
  const base = s.replace(/USDT?$/, '');

  // Crypto → Binance
  if (cryptoBases.has(base)) {
    try {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${s.replace(/USD$/, 'USDT')}`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) { const d = await r.json(); if (d.price) return res.json({ price: parseFloat(d.price) }); }
    } catch {}
  }

  // Métaux → metals.live (priorité)
  if (['XAUUSD','XAGUSD'].includes(s)) {
    try {
      const name = s === 'XAUUSD' ? 'gold' : 'silver';
      const r = await fetch(`https://api.metals.live/v1/spot/${name}`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) { const d = await r.json(); const raw = Array.isArray(d) ? d[0] : d; if (raw?.price) return res.json({ price: parseFloat(raw.price) }); }
    } catch {}
  }

  // Yahoo Finance — indices, forex, matières premières + fallback XAUUSD/XAGUSD
  const yMap = { 'NAS100':'^NDX','USTEC':'^NDX','SPX500':'^GSPC','US30':'^DJI','GER40':'^GDAXI','UK100':'^FTSE','JPN225':'^N225','USOIL':'CL=F','UKOIL':'BZ=F','XAUUSD':'GC=F','XAGUSD':'SI=F' };
  const yTicker = yMap[s] || (s.length === 6 && !cryptoBases.has(base) ? s + '=X' : null);
  if (yTicker) {
    try {
      const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yTicker)}?interval=1d&range=1d`, { signal: AbortSignal.timeout(6000) });
      if (r.ok) { const d = await r.json(); const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (price) return res.json({ price }); }
    } catch {}
  }

  res.status(404).json({ error: 'Prix indisponible' });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Aurora server :${PORT}`));
