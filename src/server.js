// Zero-dependency HTTP server: static pages, a JSON command API, and an
// SSE stream that pushes the world to every open page.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as sim from './sim.js';
import { SERIES_COLORS, formatClock, minutesPerDay, sessionView } from './sim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
// DATA_DIR lets a deployment point state at a mounted volume; without one the
// container filesystem is ephemeral and the game resets on every redeploy.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';

// One shared password guards everything except the board. The cookie is a hash
// of the password, so it needs no session store and survives a restart — the
// whole scheme is worth exactly as much as the one password it wraps, which is
// the right size for a game prop on a local network.
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'jenneissexy';
const AUTH_COOKIE = 'jhm_auth';
const AUTH_TOKEN = crypto.createHash('sha256').update(`jh-market::${AUTH_PASSWORD}`).digest('hex');
const AUTH_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// The board is meant to hang on a wall with nobody logged in.
const PUBLIC_PAGES = new Set(['/market', '/login']);
const TICK_MS = 50; // real-time loop resolution
const BROADCAST_MS = 100; // how often pages are pushed an update
const MAX_STEPS_PER_LOOP = 400; // guard against runaway catch-up after a stall

// --- state load / save -----------------------------------------------------

let state;
try {
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  state = sim.normalizeState(raw);
  console.log(`[market] resumed day ${state.clock.day} at ${formatClock(state)}`);
} catch {
  state = sim.createState();
  console.log('[market] fresh market created');
}

let saveTimer = null;
let saving = false;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (saving) return;
    saving = true;
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${STATE_FILE}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(state));
      await fsp.rename(tmp, STATE_FILE);
    } catch (err) {
      console.error('[market] save failed:', err.message);
    } finally {
      saving = false;
    }
  }, 2000);
}

// --- SSE clients -----------------------------------------------------------

/** @type {Set<{res: http.ServerResponse, rev: number, day: number, len: number, authed: boolean}>} */
const clients = new Set();

function businessMeta(b, authed) {
  const pos = authed ? state.portfolio.positions[b.id] : null;
  return {
    id: b.id,
    name: b.name,
    symbol: b.symbol,
    market: b.market,
    color: SERIES_COLORS[b.colorIndex % SERIES_COLORS.length],
    colorIndex: b.colorIndex,
    price: b.price,
    anchor: b.anchor,
    volatility: b.volatility,
    drift: b.drift,
    meanReversion: b.meanReversion,
    dayOpen: b.dayOpen,
    prevClose: b.prevClose,
    dayHigh: b.dayHigh,
    dayLow: b.dayLow,
    pump: b.pump ? { percent: b.pump.percent, remaining: b.pump.remaining, totalMinutes: b.pump.totalMinutes } : null,
    position: pos ? { qty: pos.qty, avgCost: pos.avgCost } : null,
  };
}

function clockView() {
  const c = state.clock;
  const perDay = minutesPerDay(state);
  return {
    day: c.day,
    minuteOfDay: c.minuteOfDay,
    running: c.running,
    speed: c.speed,
    time: formatClock(state),
    minutesPerDay: perDay,
    schedule: state.schedule,
    sessions: sessionView(state),
    realSecondsPerDay: perDay / c.speed,
    realSecondsPerGameHour: 60 / c.speed,
    remainingRealSeconds: (perDay - c.minuteOfDay) / c.speed,
  };
}

function portfolioView() {
  const p = state.portfolio;
  const positions = state.businesses
    .filter((b) => p.positions[b.id]?.qty > 0)
    .map((b) => {
      const pos = p.positions[b.id];
      const value = pos.qty * b.price;
      const cost = pos.qty * pos.avgCost;
      return {
        id: b.id, symbol: b.symbol, name: b.name, market: b.market,
        color: SERIES_COLORS[b.colorIndex % SERIES_COLORS.length],
        qty: pos.qty, avgCost: pos.avgCost, price: b.price,
        value, cost, unrealized: value - cost,
        unrealizedPct: cost > 0 ? ((value - cost) / cost) * 100 : 0,
      };
    });
  const invested = positions.reduce((s, x) => s + x.value, 0);
  const equity = p.cash + invested;
  return {
    cash: p.cash,
    invested,
    equity,
    startingCash: p.startingCash,
    realized: p.realized,
    unrealized: positions.reduce((s, x) => s + x.unrealized, 0),
    totalPct: p.startingCash > 0 ? ((equity - p.startingCash) / p.startingCash) * 100 : 0,
    positions,
    trades: p.trades.slice(0, 40),
  };
}

/**
 * Without a session a viewer sees the public board and nothing else: no private
 * listings, no positions, no book. The board page only ever reads those public
 * fields, so it renders identically either way.
 */
function visibleBusinesses(authed) {
  return authed ? state.businesses : state.businesses.filter((b) => b.market === 'public');
}

function initPayload(authed) {
  return {
    type: 'init',
    authed,
    rev: state.rev,
    clock: clockView(),
    settings: state.settings,
    palette: SERIES_COLORS,
    businesses: visibleBusinesses(authed).map((b) => ({ ...businessMeta(b, authed), history: b.history })),
    equityHistory: authed ? state.portfolio.equityHistory : [],
    portfolio: authed ? portfolioView() : null,
  };
}

function deltaPayload(from, authed) {
  return {
    type: 'delta',
    authed,
    rev: state.rev,
    clock: clockView(),
    from,
    businesses: visibleBusinesses(authed).map((b) => ({
      ...businessMeta(b, authed),
      points: b.history.slice(from),
    })),
    equityPoints: authed ? state.portfolio.equityHistory.slice(from) : [],
    portfolio: authed ? portfolioView() : null,
  };
}

function sendTo(client, payload) {
  try {
    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function pushClient(client) {
  // Every history is the same length, so one cursor works for any audience.
  const len = state.businesses[0] ? state.businesses[0].history.length : state.clock.minuteOfDay + 1;
  const stale = client.rev !== state.rev || client.day !== state.clock.day || client.len > len;
  const payload = stale ? initPayload(client.authed) : deltaPayload(client.len, client.authed);
  if (!sendTo(client, payload)) {
    clients.delete(client);
    return;
  }
  client.rev = state.rev;
  client.day = state.clock.day;
  client.len = len;
}

function broadcast() {
  for (const client of clients) pushClient(client);
}

// --- simulation loop -------------------------------------------------------

let lastTick = Date.now();
let carry = 0; // fractional simulated minutes not yet applied
let lastBroadcast = 0;

setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 2); // ignore huge gaps (laptop sleep)
  lastTick = now;

  if (state.clock.running) {
    carry += dt * state.clock.speed;
    let steps = 0;
    while (carry >= 1 && steps < MAX_STEPS_PER_LOOP) {
      carry -= 1;
      sim.step(state);
      steps += 1;
    }
    if (steps >= MAX_STEPS_PER_LOOP) carry = 0;
    if (steps > 0) scheduleSave();
  } else {
    carry = 0;
  }

  if (now - lastBroadcast >= BROADCAST_MS) {
    lastBroadcast = now;
    broadcast();
  }
}, TICK_MS);

// --- HTTP plumbing ---------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const PAGES = {
  '/': 'index.html',
  '/login': 'login.html',
  '/clock': 'clock.html',
  '/market': 'market.html',
  '/desk': 'desk.html',
  '/private': 'private.html',
  '/admin': 'admin.html',
};

// --- authentication --------------------------------------------------------

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const token = parseCookies(req)[AUTH_COOKIE];
  if (typeof token !== 'string' || token.length !== AUTH_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(AUTH_TOKEN));
}

/** Behind a TLS-terminating proxy the cookie should still be marked Secure. */
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

function authCookie(req, token) {
  const parts = [
    `${AUTH_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    token ? `Max-Age=${AUTH_MAX_AGE}` : 'Max-Age=0',
  ];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON body');
  }
}

async function serveStatic(res, urlPath) {
  const rel = PAGES[urlPath] || urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

// --- API -------------------------------------------------------------------

async function handleApi(req, res, urlPath, query) {
  if (urlPath === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1000\n\n');
    const client = { res, rev: -1, day: -1, len: 0, authed: isAuthed(req) };
    clients.add(client);
    pushClient(client);
    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 20000);
    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(client);
    });
    return;
  }

  if (urlPath === '/api/login' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
    const given = String(body.password ?? '');
    const supplied = crypto.createHash('sha256').update(`jh-market::${given}`).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(AUTH_TOKEN))) {
      // A small delay takes the sting out of scripted guessing.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return sendJson(res, 401, { ok: false, error: 'Verkeerd wachtwoord' });
    }
    res.setHeader('Set-Cookie', authCookie(req, AUTH_TOKEN));
    return sendJson(res, 200, { ok: true });
  }

  if (urlPath === '/api/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', authCookie(req, ''));
    return sendJson(res, 200, { ok: true });
  }

  if (urlPath === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      day: state.clock.day,
      time: formatClock(state),
      running: state.clock.running,
      businesses: state.businesses.length,
      uptimeSeconds: Math.round(process.uptime()),
    });
  }

  if (urlPath === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, initPayload(isAuthed(req)));
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  // Everything past this point changes the world, so it needs the password.
  if (!isAuthed(req)) {
    return sendJson(res, 401, { ok: false, error: 'Log eerst in' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }

  switch (urlPath) {
    case '/api/clock': {
      sim.setClock(state, body);
      break;
    }
    case '/api/clock/skip-day': {
      sim.skipToNextDay(state);
      break;
    }
    case '/api/business/create': {
      const b = sim.addBusiness(state, body);
      scheduleSave();
      broadcast();
      return sendJson(res, 200, { ok: true, id: b.id });
    }
    case '/api/business/update': {
      if (!sim.updateBusiness(state, body.id, body)) {
        return sendJson(res, 404, { ok: false, error: 'Business not found' });
      }
      break;
    }
    case '/api/business/delete': {
      if (!sim.removeBusiness(state, body.id)) {
        return sendJson(res, 404, { ok: false, error: 'Business not found' });
      }
      break;
    }
    case '/api/pump': {
      const b = sim.pump(state, body.id, body.percent, body.minutes, body.permanent !== false);
      if (!b) return sendJson(res, 400, { ok: false, error: 'Could not apply that move' });
      break;
    }
    case '/api/pump/clear': {
      sim.clearPump(state, body.id);
      break;
    }
    case '/api/trade': {
      const result = sim.trade(state, body.id, body.side, body.qty);
      if (!result.ok) return sendJson(res, 400, result);
      scheduleSave();
      broadcast();
      return sendJson(res, 200, { ok: true, portfolio: portfolioView() });
    }
    case '/api/portfolio/reset': {
      sim.resetPortfolio(state, body.cash);
      break;
    }
    case '/api/schedule': {
      const result = sim.setSchedule(state, body);
      if (!result.ok) return sendJson(res, 400, result);
      break;
    }
    case '/api/settings': {
      if (body.feePct !== undefined) {
        const fee = Number.parseFloat(body.feePct);
        if (Number.isFinite(fee)) state.settings.feePct = Math.min(5, Math.max(0, fee));
      }
      if (body.enforceExchangeHours !== undefined) {
        state.settings.enforceExchangeHours = Boolean(body.enforceExchangeHours);
      }
      state.rev += 1;
      break;
    }
    case '/api/market/reset': {
      state = sim.createState();
      break;
    }
    default:
      return sendJson(res, 404, { ok: false, error: `Unknown endpoint ${urlPath}` });
  }

  void query;
  scheduleSave();
  broadcast();
  return sendJson(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const urlPath = url.pathname;
  try {
    if (urlPath.startsWith('/api/')) {
      await handleApi(req, res, urlPath, url.searchParams);
      return;
    }
    // Static assets stay open — the secrets live in the data, not the markup.
    // Pages that show more than the board need a session.
    if (PAGES[urlPath] && !PUBLIC_PAGES.has(urlPath) && !isAuthed(req)) {
      res.writeHead(302, {
        Location: `/login?next=${encodeURIComponent(urlPath)}`,
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }
    await serveStatic(res, urlPath);
  } catch (err) {
    console.error('[market] request failed:', err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal error' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Market simulation running on ${HOST}:${PORT}`);
  console.log(`  State file: ${STATE_FILE}\n`);
  console.log(`  Hub      http://localhost:${PORT}/`);
  console.log(`  Clock    http://localhost:${PORT}/clock      (project this)`);
  console.log(`  Board    http://localhost:${PORT}/market     (project this)`);
  console.log(`  Desk     http://localhost:${PORT}/desk       (dealer only)`);
  console.log(`  Private  http://localhost:${PORT}/private    (businessman only)`);
  console.log(`  Admin    http://localhost:${PORT}/admin      (game master only)\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch { /* best effort */ }
    process.exit(0);
  });
}
