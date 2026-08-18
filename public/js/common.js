// Shared client runtime: SSE subscription, state assembly, formatting, toasts.

export const store = {
  clock: null,
  settings: { feePct: 0 },
  palette: [],
  businesses: [], // { ...meta, history: number[] }
  equityHistory: [],
  portfolio: null,
  connected: false,
};

const listeners = new Set();

/** Subscribe to every state push. Returns an unsubscribe function. */
export function onState(fn) {
  listeners.add(fn);
  if (store.clock) fn(store);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try { fn(store); } catch (err) { console.error(err); }
  }
}

function applyInit(msg) {
  store.clock = msg.clock;
  store.settings = msg.settings;
  store.palette = msg.palette;
  store.businesses = msg.businesses;
  store.equityHistory = msg.equityHistory;
  store.portfolio = msg.portfolio;
}

function applyDelta(msg) {
  store.clock = msg.clock;
  store.portfolio = msg.portfolio;
  const byId = new Map(store.businesses.map((b) => [b.id, b]));
  store.businesses = msg.businesses.map((incoming) => {
    const prev = byId.get(incoming.id);
    const history = prev ? prev.history : [];
    if (incoming.points.length) {
      // `from` is the cursor the server sliced at; overwrite from there so a
      // corrected last point (an instant pump) replaces the stale one.
      history.length = Math.min(history.length, msg.from);
      for (const p of incoming.points) history.push(p);
    }
    const { points, ...meta } = incoming;
    void points;
    return { ...meta, history };
  });
  if (msg.equityPoints.length) {
    store.equityHistory.length = Math.min(store.equityHistory.length, msg.from);
    for (const p of msg.equityPoints) store.equityHistory.push(p);
  }
}

let source = null;

export function connect() {
  if (source) return;
  source = new EventSource('/api/stream');

  source.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'init') applyInit(msg);
    else if (msg.type === 'delta') applyDelta(msg);
    else return;
    if (!store.connected) {
      store.connected = true;
      updateConnBadge();
    }
    emit();
  };

  source.onerror = () => {
    if (store.connected) {
      store.connected = false;
      updateConnBadge();
      emit();
    }
  };
}

function updateConnBadge() {
  const el = document.getElementById('conn');
  if (!el) return;
  el.textContent = store.connected ? 'live' : 'reconnecting';
  el.classList.toggle('conn-bad', !store.connected);
}

/** POST JSON to the API; surfaces server-side errors as toasts. */
export async function api(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok || data.ok === false) {
    const message = data.error || `Request failed (${res.status})`;
    toast(message, 'error');
    throw new Error(message);
  }
  return data;
}

// --- formatting ------------------------------------------------------------

// The in-game currency is muntjes, so amounts are bare numbers and the
// surrounding label says what they are.
export const money = (n, digits = 2) =>
  (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

export const compactMoney = (n) => {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${n < 0 ? '-' : ''}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 100000) return `${n < 0 ? '-' : ''}${(abs / 1e3).toFixed(1)}K`;
  return money(n);
};

export const pct = (n, digits = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;

export const signClass = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');

export const arrow = (n) => (n > 0 ? '▲' : n < 0 ? '▼' : '–');

export function durationText(seconds) {
  if (!Number.isFinite(seconds)) return '–';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m}m ${String(rest).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function formatMinute(absMinutes) {
  const h = Math.floor(absMinutes / 60) % 24;
  const m = Math.round(absMinutes) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Simulated minute index -> wall-clock label, relative to the day's start. */
export function minuteLabel(index) {
  const start = store.clock?.schedule?.dayStart ?? 9;
  return formatMinute(start * 60 + index);
}

/** Simulated minutes -> a short human duration ("2h 15m"). */
export function gameDuration(minutes) {
  if (minutes === null || minutes === undefined) return null;
  const m = Math.max(0, Math.round(minutes));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// --- chrome ----------------------------------------------------------------

export function toast(message, kind = 'info') {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.kind = kind;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/** Wires the shared top bar: nav highlight plus the live clock read-out. */
export function mountChrome(active) {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const link = (href, key, label) =>
    `<a href="${href}" ${active === key ? 'aria-current="page"' : ''}>${label}</a>`;

  bar.innerHTML = `
    <div class="brand"><span class="brand-dot" id="brand-dot"></span> Beurs</div>
    <nav class="nav">
      ${link('/', 'home', 'Hub')}
      ${link('/clock', 'clock', 'Klok')}
      ${link('/market', 'market', 'Beursbord')}
      ${link('/desk', 'desk', 'Dealer')}
      ${link('/private', 'private', 'Privé')}
      ${link('/admin', 'admin', 'Admin')}
    </nav>
    <div class="topbar-clock">
      <span class="pill" id="bar-exchange">beurs</span>
      <span class="pill" id="bar-casino">casino</span>
      <span class="pill" id="bar-day">Dag –</span>
      <span class="time num" id="bar-time">--:--</span>
      <span class="pill" id="conn">connecting</span>
    </div>`;

  onState((s) => {
    document.getElementById('bar-day').textContent = `Dag ${s.clock.day}`;
    document.getElementById('bar-time').textContent = s.clock.time;
    document.getElementById('brand-dot').dataset.running = String(s.clock.running);
    setSessionPill(document.getElementById('bar-exchange'), 'Beurs', s.clock.sessions.exchangeOpen);
    setSessionPill(document.getElementById('bar-casino'), 'Casino', s.clock.sessions.casinoOpen);
  });
  updateConnBadge();
}

/** Open/closed state is carried by the word as well as the colour. */
export function setSessionPill(node, label, open) {
  if (!node) return;
  const text = `${label} ${open ? 'open' : 'dicht'}`;
  if (node.textContent !== text) node.textContent = text;
  node.dataset.open = String(open);
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}
