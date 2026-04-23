// ============================================================
// AURORA SERVER — v3 MT5-Native
//
// Architecture :
//   PineScript → POST /webhook/:token → aurora.py (MT5)
//   App → GET  /api/:token/mt5/live   → aurora.py → MT5
//
// Ce serveur gère uniquement :
//   - Auth (register / login / token)
//   - Push notifications (VAPID)
//   - Proxy vers aurora.py (stats MT5, positions, historique)
//   - Forward webhook PineScript → aurora.py
//   - SSE pour les événements trade en temps réel
//
// db.json ne stocke PLUS de trades — les trades viennent de MT5.
// ============================================================

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');
const webpush = require('web-push');
const fs      = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// URL du pont MT5 (aurora.py Flask)
const AURORA_MT5_URL = process.env.AURORA_MT5_URL || 'http://localhost:5000';

// VAPID keys
const VAPID_FILE = path.join(__dirname, '.vapid.json');
let VAPID_PUBLIC, VAPID_PRIVATE;
if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
  VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
  VAPID_PRIVATE = process.env.VAPID_PRIVATE;
} else if (fs.existsSync(VAPID_FILE)) {
  const v = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  VAPID_PUBLIC = v.publicKey; VAPID_PRIVATE = v.privateKey;
} else {
  const keys = webpush.generateVAPIDKeys();
  VAPID_PUBLIC = keys.publicKey; VAPID_PRIVATE = keys.privateKey;
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
}
webpush.setVapidDetails('mailto:aurora@trading.app', VAPID_PUBLIC, VAPID_PRIVATE);

// Persistence (auth uniquement — plus de trades stockés localement)
const DB_FILE = path.join(__dirname, 'db.json');
const loadDB  = () => {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      Object.keys(raw).forEach(t => {
        raw[t].subscribers = [];
        raw[t].trades      = [];
      });
      return raw;
    }
  } catch(e) { console.error('[DB] Load error:', e.message); }
  return {};
};
const saveDB  = () => {
  try {
    const toSave = {};
    Object.keys(users).forEach(token => {
      const { subscribers, trades, ...rest } = users[token];
      toSave[token] = rest;
    });
    fs.writeFileSync(DB_FILE, JSON.stringify(toSave, null, 2));
  } catch(e) { console.error('[DB] Save error:', e.message); }
};

const users = loadDB();
const hashPassword  = pw => require('crypto').createHash('sha256').update(pw + 'aurora_salt_v1').digest('hex');
const createUser    = (name, passwordHash) => {
  const token = crypto.randomBytes(16).toString('hex');
  users[token] = { name, token, passwordHash, subscribers: [], pushSubs: [] };
  saveDB();
  return users[token];
};
const getUser       = token => users[token] || null;
const getUserByName = name  => Object.values(users).find(u => u.name.toLowerCase() === name.toLowerCase()) || null;

const broadcast = (user, event, data) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  user.subscribers = user.subscribers.filter(res => {
    try { res.write(msg); return true; } catch { return false; }
  });
};

const sendPush = async (user, payload) => {
  if (!user.pushSubs || !user.pushSubs.length) return;
  const dead = [];
  for (const sub of user.pushSubs) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload)); }
    catch { dead.push(sub.endpoint); }
  }
  if (dead.length) { user.pushSubs = user.pushSubs.filter(s => !dead.includes(s.endpoint)); saveDB(); }
};

const auth = (req, res, next) => {
  const token = req.params.token || req.headers['x-aurora-token'];
  const user  = getUser(token);
  if (!user) return res.status(401).json({ error: 'Token invalide' });
  req.user = user; next();
};

// ============================================================
// AUTH
// ============================================================
app.get('/api/vapid-public-key', (req, res) => res.json({ key: VAPID_PUBLIC }));

app.post('/api/register', (req, res) => {
  const { name, password } = req.body;
  if (!name || !password)  return res.status(400).json({ error: 'Pseudo et mot de passe requis' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 min)' });
  if (getUserByName(name)) return res.status(409).json({ error: 'Ce pseudo est deja pris' });
  const user = createUser(name, hashPassword(password));
  res.json({ token: user.token, name: user.name });
});

app.post('/api/login', (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Pseudo et mot de passe requis' });
  const user = getUserByName(name);
  if (!user) return res.status(401).json({ error: 'Pseudo introuvable' });
  if (!user.passwordHash) { user.passwordHash = hashPassword(password); saveDB(); return res.json({ token: user.token, name: user.name }); }
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
  res.json({ ok: true });
});

// ============================================================
// NGROK URL — sauvegarde par utilisateur (persiste en db.json)
// ============================================================

app.post('/api/:token/mt5/url', auth, (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'URL invalide' });
  req.user.mt5Url = url.replace(/\/+$/, '');
  saveDB();
  console.log(`[MT5URL] ${req.user.name} → ${req.user.mt5Url}`);
  res.json({ ok: true, url: req.user.mt5Url });
});

app.get('/api/:token/mt5/url', auth, (req, res) => {
  res.json({ url: req.user.mt5Url || DEFAULT_MT5_URL });
});

// ============================================================
// PROXY MT5 — source unique de verite pour toutes les donnees
// ============================================================

// Stats live : compte + jour + positions + pending
app.get('/api/:token/mt5/live', auth, async (req, res) => {
  try {
    const r = await fetch(`${getMT5Url(req)}/mt5/live`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return res.status(r.status).json({ error: `aurora.py HTTP ${r.status}` });
    res.json(await r.json());
  } catch(e) { res.status(503).json({ error: 'aurora.py indisponible', detail: e.message }); }
});

// Historique complet des deals (tous les trades, pas seulement aujourd'hui)
app.get('/api/:token/mt5/history', auth, async (req, res) => {
  try {
    const qs  = new URLSearchParams(req.query).toString();
    const r   = await fetch(`${getMT5Url(req)}/mt5/history${qs ? '?' + qs : ''}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.status(r.status).json({ error: `aurora.py HTTP ${r.status}` });
    res.json(await r.json());
  } catch(e) { res.status(503).json({ error: 'aurora.py indisponible', detail: e.message }); }
});

// SSE stream MT5 temps reel
app.get('/api/:token/mt5/stream', auth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  try {
    const upstream = await fetch(`${getMT5Url(req)}/mt5/stream`, { signal: req.signal });
    if (!upstream.ok || !upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();
    req.on('close', () => reader.cancel());
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      try { res.write(value); } catch {}
    }
  } catch {}
  res.end();
});

// ============================================================
// WEBHOOK PineScript → forward vers aurora.py + SSE broadcast
// ============================================================
const PHRASES_TP = ["encore un genie du capital","argent qui arrive par hasard evidemment","tu maitrises totalement (non)","jackpot totalement merite (ou pas)","le marche t a choisi","miracle financier quotidien","ca tombe bien t etais pauvre","strategie evidemment volontaire","argent genere par pure chance","tu appelles ca du skill","impressionnant ou pas","profit totalement prevu (mensonge)","le hasard travaille bien","bravo le casino t aime","gain valide par l univers","encore un coup de genie","meme toi t y crois pas","marche trop gentil avec toi","tu fais semblant de controler","Wall Street tremble (non)"];
const PHRASES_SL = ["masterclass de genie inverse","tu maitrises parfaitement la perte","strategie du don volontaire","argent offert avec amour","encore choix audacieux","tu nourris le marche","performance impressionnante negativement","t as fait un don au hasard","perte totalement prevue (non)","bravo tu finances les autres","tu vas dire que c etait le plan","marche content de toi","argent parti en vacances","decision financiere douteuse","encore masterclass a l envers","tu confonds gain et crash","tu nourris la liquidite","perte controlee selon toi","don involontaire reussi","argent parti sans toi"];
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

app.post('/webhook/:token', async (req, res) => {
  const user = getUser(req.params.token);
  if (!user) return res.status(401).json({ error: 'Token invalide' });
  const body = req.body;
  if (!body || !body.action) return res.status(400).json({ error: 'Invalid payload' });

  // Forward vers aurora.py (execution MT5)
  let auroraResp = null;
  try {
    const r = await fetch(`${getMT5Url(req)}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    auroraResp = await r.json();
  } catch(e) { console.error('[WEBHOOK] forward error:', e.message); }

  const action = body.action;
  const sym    = body.symbol || 'NAS100';

  // Broadcast SSE → l app rafraichit les donnees MT5
  if (action === 'BUY_LIMIT' || action === 'SELL_LIMIT') {
    broadcast(user, 'entry', { direction: action === 'BUY_LIMIT' ? 'BUY' : 'SELL', symbol: sym, lot: parseFloat(body.lot) || 0, entry: body.entry, sl: body.sl, tp1: body.tp1, status: 'pending' });
  }
  if (action === 'ACTIVATE') {
    broadcast(user, 'activate', { symbol: sym, entry: body.entry });
    await sendPush(user, { title: `ENTREE — ${sym}`, body: `Ordre confirme · ${parseFloat(body.lot || 0).toFixed(3)} lots`, tag: 'aurora-activate' });
  }
  if (action === 'CANCEL_LIMIT') {
    broadcast(user, 'cancel', { symbol: sym });
  }
  if (action === 'CLOSE_TP' || action === 'CLOSE_SL') {
    const isTP = action === 'CLOSE_TP';
    const pnl  = parseFloat(body.pnl) || 0;
    broadcast(user, 'close', { result: isTP ? 'TP1' : 'SL', symbol: sym, pnl });
    await sendPush(user, {
      title: `${isTP ? 'TP1' : 'SL'} ${isTP ? '🚀' : '❌'} — ${sym}`,
      body:  `PNL : ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} $\n${pick(isTP ? PHRASES_TP : PHRASES_SL)}`,
      tag:   'aurora-close',
    });
  }

  res.json({ ok: true, aurora: auroraResp });
});

// SSE interne (pour les events trade instantanes)
app.get('/api/:token/stream', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  req.user.subscribers.push(res);
  res.write('event: connected\ndata: {"ok":true}\n\n');
  req.on('close', () => { req.user.subscribers = req.user.subscribers.filter(r => r !== res); });
});

// ============================================================
// PRIX LIVE (proxy CORS)
// ============================================================
app.get('/api/price/:symbol', async (req, res) => {
  const s = req.params.symbol.toUpperCase().trim();
  const cryptoBases = new Set(['BTC','ETH','BNB','SOL','XRP','LTC','ADA','DOT','LINK','AVAX','DOGE','MATIC']);
  const base = s.replace(/USDT?$/, '');
  if (cryptoBases.has(base)) {
    try { const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${s.replace(/USD$/, 'USDT')}`, { signal: AbortSignal.timeout(4000) }); if (r.ok) { const d = await r.json(); if (d.price) return res.json({ price: parseFloat(d.price) }); } } catch {}
  }
  if (['XAUUSD','XAGUSD'].includes(s)) {
    try { const name = s === 'XAUUSD' ? 'gold' : 'silver'; const r = await fetch(`https://api.metals.live/v1/spot/${name}`, { signal: AbortSignal.timeout(5000) }); if (r.ok) { const d = await r.json(); const raw = Array.isArray(d) ? d[0] : d; if (raw?.price) return res.json({ price: parseFloat(raw.price) }); } } catch {}
  }
  const yMap = { 'NAS100':'^NDX','USTEC':'^NDX','SPX500':'^GSPC','US30':'^DJI','GER40':'^GDAXI','UK100':'^FTSE','JPN225':'^N225','USOIL':'CL=F','UKOIL':'BZ=F','XAUUSD':'GC=F','XAGUSD':'SI=F' };
  const yTicker = yMap[s] || (s.length === 6 && !cryptoBases.has(base) ? s + '=X' : null);
  if (yTicker) {
    try { const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yTicker)}?interval=1d&range=1d`, { signal: AbortSignal.timeout(6000) }); if (r.ok) { const d = await r.json(); const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice; if (price) return res.json({ price }); } } catch {}
  }
  res.status(404).json({ error: 'Prix indisponible' });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Aurora server :${PORT} | MT5 default: ${DEFAULT_MT5_URL}`));
