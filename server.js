const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory store (remplace par SQLite/Postgres en prod) ──
let trades = [];
let activeTrade = null;
let subscribers = []; // SSE clients
let pushSubscriptions = [];

const dayStats = () => {
  const today = new Date().toDateString();
  const todayTrades = trades.filter(t => new Date(t.timestamp).toDateString() === today);
  const tp = todayTrades.filter(t => t.result === 'TP1').length;
  const sl = todayTrades.filter(t => t.result === 'SL').length;
  const pnl = todayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const rr = todayTrades.reduce((s, t) => s + (t.rr || 0), 0);
  return { total: todayTrades.length, tp, sl, pnl: Math.round(pnl * 100) / 100, rr: Math.round(rr * 100) / 100, wr: todayTrades.length > 0 ? Math.round(tp / todayTrades.length * 1000) / 10 : 0 };
};

const allStats = () => {
  const tp = trades.filter(t => t.result === 'TP1').length;
  const sl = trades.filter(t => t.result === 'SL').length;
  const pnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const rr = trades.reduce((s, t) => s + (t.rr || 0), 0);
  return { total: trades.length, tp, sl, pnl: Math.round(pnl * 100) / 100, rr: Math.round(rr * 100) / 10 / 10, wr: trades.length > 0 ? Math.round(tp / trades.length * 1000) / 10 : 0 };
};

// broadcast to all SSE clients
const broadcast = (event, data) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  subscribers = subscribers.filter(res => {
    try { res.write(msg); return true; } catch { return false; }
  });
};

// ── SSE endpoint ──
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  subscribers.push(res);
  // send current state immediately
  res.write(`event: state\ndata: ${JSON.stringify({ activeTrade, day: dayStats(), recent: trades.slice(-20).reverse() })}\n\n`);
  req.on('close', () => { subscribers = subscribers.filter(r => r !== res); });
});

// ── Push subscription ──
app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (sub && sub.endpoint) {
    pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== sub.endpoint);
    pushSubscriptions.push(sub);
  }
  res.json({ ok: true });
});

// ── WEBHOOK from TradingView ──
// Expected payloads from Aurora script:
// BUY/SELL: {"action":"BUY","symbol":"NAS100","lot":0.080}
// CLOSE:    {"action":"CLOSE_TP","symbol":"NAS100"} or CLOSE_SL
app.post('/webhook', (req, res) => {
  const body = req.body;
  console.log('[WEBHOOK]', body);

  if (!body || !body.action) return res.status(400).json({ error: 'Invalid payload' });

  const now = new Date().toISOString();

  if (body.action === 'BUY' || body.action === 'SELL') {
    // New confirmed entry
    activeTrade = {
      id: crypto.randomUUID(),
      symbol: body.symbol || 'NAS100',
      direction: body.action,
      lot: body.lot || 0,
      entry: body.entry || null,
      sl: body.sl || null,
      tp1: body.tp1 || null,
      timestamp: now,
      result: null,
      pnl: null,
      rr: null,
      confirmScore: body.confirmScore || null,
    };
    broadcast('entry', activeTrade);
    sendPushToAll({ title: `${body.action === 'BUY' ? '▲ LONG' : '▼ SHORT'} — Entrée confirmée`, body: `${body.symbol} · Lot ${body.lot}`, tag: 'entry' });
  }

  if (body.action === 'CLOSE_TP' || body.action === 'CLOSE_SL') {
    const result = body.action === 'CLOSE_TP' ? 'TP1' : 'SL';
    if (activeTrade) {
      const rr = result === 'TP1' ? 1 : -1;
      const pnl = body.pnl || (result === 'TP1' ? 100 : -100); // fallback
      const closed = { ...activeTrade, result, pnl, rr, closedAt: now };
      trades.push(closed);
      activeTrade = null;
      broadcast('close', { trade: closed, day: dayStats() });
      sendPushToAll({
        title: result === 'TP1' ? `✔ TP1 touché — ${closed.symbol}` : `✖ SL touché — ${closed.symbol}`,
        body: result === 'TP1' ? `+${pnl}$ · +1R` : `-${Math.abs(pnl)}$ · -1R`,
        tag: 'close'
      });
    }
  }

  res.json({ ok: true });
});

// ── Manual trade entry ──
app.post('/api/trades', (req, res) => {
  const t = req.body;
  const trade = {
    id: crypto.randomUUID(),
    symbol: t.symbol || 'NAS100',
    direction: t.direction || 'BUY',
    lot: t.lot || 0,
    entry: t.entry,
    sl: t.sl,
    tp1: t.tp1,
    result: t.result,
    pnl: parseFloat(t.pnl) || 0,
    rr: t.result === 'TP1' ? 1 : -1,
    timestamp: t.timestamp || new Date().toISOString(),
    closedAt: t.closedAt || new Date().toISOString(),
    manual: true,
  };
  trades.push(trade);
  broadcast('manual', { trade, day: dayStats() });
  res.json({ ok: true, trade });
});

// ── GET endpoints ──
app.get('/api/state', (req, res) => {
  res.json({ activeTrade, day: dayStats(), all: allStats(), recent: trades.slice(-50).reverse() });
});

app.get('/api/trades', (req, res) => {
  const { from, to, result } = req.query;
  let list = [...trades].reverse();
  if (from) list = list.filter(t => new Date(t.timestamp) >= new Date(from));
  if (to) list = list.filter(t => new Date(t.timestamp) <= new Date(to));
  if (result) list = list.filter(t => t.result === result);
  res.json(list);
});

// Seed some demo data
const seedDemoData = () => {
  const now = Date.now();
  const demo = [
    { dir: 'SELL', result: 'TP1', pnl: 100, rr: 1, minsAgo: 240 },
    { dir: 'BUY', result: 'SL', pnl: -100, rr: -1, minsAgo: 180 },
    { dir: 'BUY', result: 'TP1', pnl: 100, rr: 1, minsAgo: 120 },
    { dir: 'SELL', result: 'TP1', pnl: 100, rr: 1, minsAgo: 60 },
  ];
  demo.forEach(d => {
    trades.push({
      id: crypto.randomUUID(), symbol: 'NAS100', direction: d.dir, lot: 0.08,
      entry: 19700, sl: d.dir === 'BUY' ? 19550 : 19850,
      tp1: d.dir === 'BUY' ? 19850 : 19550,
      result: d.result, pnl: d.pnl, rr: d.rr,
      timestamp: new Date(now - d.minsAgo * 60000).toISOString(),
      closedAt: new Date(now - (d.minsAgo - 30) * 60000).toISOString(),
    });
  });
};
seedDemoData();

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Aurora server running on :${PORT}`));

function sendPushToAll(payload) {
  // In production: use web-push library
  // pushSubscriptions.forEach(sub => webpush.sendNotification(sub, JSON.stringify(payload)));
  console.log('[PUSH]', payload);
}
