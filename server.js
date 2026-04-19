const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ── Multi-user store ──
// users[token] = { name, token, trades[], activeTrade, subscribers[], pushSubs[] }
const users = {};

const createUser = (name) => {
  const token = crypto.randomBytes(16).toString('hex');
  users[token] = { name, token, trades: [], activeTrade: null, subscribers: [], pushSubs: [] };
  seedDemoData(token);
  console.log(`[USER] Created "${name}" → token: ${token}`);
  return users[token];
};

const getUser = (token) => users[token] || null;

// ── Stats helpers ──
const dayStats = (trades) => {
  const today = new Date().toDateString();
  const t = trades.filter(t => new Date(t.timestamp).toDateString() === today);
  const tp = t.filter(t => t.result === 'TP1').length;
  const sl = t.filter(t => t.result === 'SL').length;
  const pnl = t.reduce((s, t) => s + (t.pnl || 0), 0);
  const rr = t.reduce((s, t) => s + (t.rr || 0), 0);
  return { total: t.length, tp, sl, pnl: Math.round(pnl * 100) / 100, rr: Math.round(rr * 100) / 100, wr: t.length > 0 ? Math.round(tp / t.length * 1000) / 10 : 0 };
};

const allStats = (trades) => {
  const tp = trades.filter(t => t.result === 'TP1').length;
  const sl = trades.filter(t => t.result === 'SL').length;
  const pnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const rr = trades.reduce((s, t) => s + (t.rr || 0), 0);
  return { total: trades.length, tp, sl, pnl: Math.round(pnl * 100) / 100, rr: Math.round(rr * 100) / 100, wr: trades.length > 0 ? Math.round(tp / trades.length * 1000) / 10 : 0 };
};

// ── Broadcast to user's SSE clients ──
const broadcast = (user, event, data) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  user.subscribers = user.subscribers.filter(res => {
    try { res.write(msg); return true; } catch { return false; }
  });
};

// ── Seed demo data ──
function seedDemoData(token) {
  const u = users[token];
  const now = Date.now();
  const demo = [
    { dir: 'SELL', result: 'TP1', pnl: 100, rr: 1, minsAgo: 240 },
    { dir: 'BUY',  result: 'SL',  pnl: -100, rr: -1, minsAgo: 180 },
    { dir: 'BUY',  result: 'TP1', pnl: 100, rr: 1, minsAgo: 120 },
    { dir: 'SELL', result: 'TP1', pnl: 100, rr: 1, minsAgo: 60 },
  ];
  demo.forEach(d => {
    u.trades.push({
      id: crypto.randomUUID(), symbol: 'NAS100', direction: d.dir, lot: 0.08,
      entry: 19700, sl: d.dir === 'BUY' ? 19550 : 19850,
      tp1: d.dir === 'BUY' ? 19850 : 19550,
      result: d.result, pnl: d.pnl, rr: d.rr,
      timestamp: new Date(now - d.minsAgo * 60000).toISOString(),
      closedAt: new Date(now - (d.minsAgo - 30) * 60000).toISOString(),
    });
  });
}

// ── Auth middleware for API routes ──
const authMiddleware = (req, res, next) => {
  const token = req.params.token || req.headers['x-aurora-token'];
  const user = getUser(token);
  if (!user) return res.status(401).json({ error: 'Token invalide' });
  req.user = user;
  next();
};

// ── REGISTER — create a new account ──
app.post('/api/register', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const existing = Object.values(users).find(u => u.name.toLowerCase() === name.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Nom déjà pris' });
  const user = createUser(name);
  res.json({ token: user.token, name: user.name, webhookUrl: `/webhook/${user.token}` });
});

// ── LOGIN — get token by name (simple, no password — add one if needed) ──
app.post('/api/login', (req, res) => {
  const { token } = req.body;
  const user = getUser(token);
  if (!user) return res.status(401).json({ error: 'Token invalide' });
  res.json({ token: user.token, name: user.name, webhookUrl: `/webhook/${user.token}` });
});

// ── WEBHOOK from TradingView (per user) ──
app.post('/webhook/:token', (req, res) => {
  const user = getUser(req.params.token);
  if (!user) return res.status(401).json({ error: 'Token invalide' });

  const body = req.body;
  console.log(`[WEBHOOK] ${user.name}:`, body);
  if (!body || !body.action) return res.status(400).json({ error: 'Invalid payload' });

  const now = new Date().toISOString();

  if (body.action === 'BUY' || body.action === 'SELL') {
    user.activeTrade = {
      id: crypto.randomUUID(),
      symbol: body.symbol || 'NAS100',
      direction: body.action,
      lot: body.lot || 0,
      entry: body.entry || null,
      sl: body.sl || null,
      tp1: body.tp1 || null,
      timestamp: now,
      result: null, pnl: null, rr: null,
      confirmScore: body.confirmScore || null,
    };
    broadcast(user, 'entry', user.activeTrade);
  }

  if (body.action === 'CLOSE_TP' || body.action === 'CLOSE_SL') {
    const result = body.action === 'CLOSE_TP' ? 'TP1' : 'SL';
    if (user.activeTrade) {
      const rr = result === 'TP1' ? 1 : -1;
      const pnl = body.pnl || (result === 'TP1' ? 100 : -100);
      const closed = { ...user.activeTrade, result, pnl, rr, closedAt: now };
      user.trades.push(closed);
      user.activeTrade = null;
      broadcast(user, 'close', { trade: closed, day: dayStats(user.trades) });
    }
  }

  res.json({ ok: true });
});

// ── SSE stream (per user) ──
app.get('/api/:token/stream', authMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const user = req.user;
  user.subscribers.push(res);
  res.write(`event: state\ndata: ${JSON.stringify({ activeTrade: user.activeTrade, day: dayStats(user.trades), recent: user.trades.slice(-20).reverse() })}\n\n`);
  req.on('close', () => { user.subscribers = user.subscribers.filter(r => r !== res); });
});

// ── State ──
app.get('/api/:token/state', authMiddleware, (req, res) => {
  const u = req.user;
  res.json({ activeTrade: u.activeTrade, day: dayStats(u.trades), all: allStats(u.trades), recent: u.trades.slice(-50).reverse() });
});

// ── Trades list ──
app.get('/api/:token/trades', authMiddleware, (req, res) => {
  const { from, to, result } = req.query;
  let list = [...req.user.trades].reverse();
  if (from) list = list.filter(t => new Date(t.timestamp) >= new Date(from));
  if (to) list = list.filter(t => new Date(t.timestamp) <= new Date(to));
  if (result) list = list.filter(t => t.result === result);
  res.json(list);
});

// ── Manual trade ──
app.post('/api/:token/trades', authMiddleware, (req, res) => {
  const t = req.body;
  const u = req.user;
  const trade = {
    id: crypto.randomUUID(),
    symbol: t.symbol || 'NAS100',
    direction: t.direction || 'BUY',
    lot: t.lot || 0,
    entry: t.entry, sl: t.sl, tp1: t.tp1,
    result: t.result,
    pnl: parseFloat(t.pnl) || 0,
    rr: t.result === 'TP1' ? 1 : -1,
    timestamp: t.timestamp || new Date().toISOString(),
    closedAt: t.closedAt || new Date().toISOString(),
    manual: true,
  };
  u.trades.push(trade);
  broadcast(u, 'manual', { trade, day: dayStats(u.trades) });
  res.json({ ok: true, trade });
});

// ── Serve PWA (SPA fallback) ──
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Aurora multi-user server running on :${PORT}`));
