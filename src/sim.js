// Market simulation engine — authoritative state lives here.
// The server owns the clock and the prices; every page is just a view.
//
// A game day is a cycle from `dayStart` to `dayEnd` (default 09:00 -> 19:00).
// Inside it two windows matter:
//   - the exchange (beurs) is open 09:00-17:00; prices only move while it is
//   - the casino is open 15:00-19:00; purely a status the room needs to see
// At `dayEnd` the clock rolls straight back to `dayStart` and the day counter
// ticks over.

import { randomUUID } from 'node:crypto';

export const DEFAULT_SCHEDULE = {
  dayStart: 9,
  dayEnd: 19,
  exchangeOpen: 9,
  exchangeClose: 17,
  casinoOpen: 15,
  casinoClose: 19,
};

// Categorical series palette, dark-surface steps, assigned in fixed slot order.
export const SERIES_COLORS = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#008300', // green
  '#9085e9', // violet
  '#e66767', // red
];

const MIN_PRICE = 1;
const MAX_PRICE = 1_000_000;

// --- helpers ---------------------------------------------------------------

let spare = null;
function gauss() {
  if (spare !== null) {
    const v = spare;
    spare = null;
    return v;
  }
  let u = 0;
  let v = 0;
  let s = 0;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s === 0 || s >= 1);
  const mul = Math.sqrt((-2 * Math.log(s)) / s);
  spare = v * mul;
  return u * mul;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round2 = (n) => Math.round(n * 100) / 100;
// Business prices are rounded to whole euros: the dealer only has €1 muntjes
// and briefjes, so nothing on the board can cost cents.
const roundPrice = (n) => Math.round(n);

function num(value, fallback, lo, hi) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, lo, hi);
}

// --- schedule --------------------------------------------------------------

export const minutesPerDay = (state) =>
  (state.schedule.dayEnd - state.schedule.dayStart) * 60;

/** Minutes since midnight for a given minute-of-day offset. */
export const absoluteMinute = (state, minuteOfDay = state.clock.minuteOfDay) =>
  state.schedule.dayStart * 60 + minuteOfDay;

export function formatMinute(absMinutes) {
  const h = Math.floor(absMinutes / 60) % 24;
  const m = Math.round(absMinutes) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export const formatClock = (state, minuteOfDay = state.clock.minuteOfDay) =>
  formatMinute(absoluteMinute(state, minuteOfDay));

function windowOpen(state, openHour, closeHour, minuteOfDay) {
  const abs = absoluteMinute(state, minuteOfDay);
  return abs >= openHour * 60 && abs < closeHour * 60;
}

export const isExchangeOpen = (state, minuteOfDay) =>
  windowOpen(state, state.schedule.exchangeOpen, state.schedule.exchangeClose, minuteOfDay);

export const isCasinoOpen = (state, minuteOfDay) =>
  windowOpen(state, state.schedule.casinoOpen, state.schedule.casinoClose, minuteOfDay);

/** Simulated minutes until a window boundary, or null when it never comes today. */
function minutesUntil(state, hour) {
  const target = hour * 60 - absoluteMinute(state);
  return target > 0 ? target : null;
}

export function sessionView(state) {
  const exchange = isExchangeOpen(state);
  const casino = isCasinoOpen(state);
  return {
    exchangeOpen: exchange,
    casinoOpen: casino,
    exchangeLabel: `${formatMinute(state.schedule.exchangeOpen * 60)} – ${formatMinute(state.schedule.exchangeClose * 60)}`,
    casinoLabel: `${formatMinute(state.schedule.casinoOpen * 60)} – ${formatMinute(state.schedule.casinoClose * 60)}`,
    exchangeChangesIn: minutesUntil(state, exchange ? state.schedule.exchangeClose : state.schedule.exchangeOpen),
    casinoChangesIn: minutesUntil(state, casino ? state.schedule.casinoClose : state.schedule.casinoOpen),
  };
}

// --- state -----------------------------------------------------------------

function seedBusinesses() {
  const seeds = [
    // Publicly traded — these are what the kids see on the board. Prices are
    // kept in muntjes, so a handful of coins buys a real number of shares.
    { name: 'Casino Fortuna', symbol: 'CAS', market: 'public', price: 24, volatility: 0.004, drift: 0.0001, meanReversion: 0.0006 },
    { name: 'Boomhut Bouwers', symbol: 'BHB', market: 'public', price: 12, volatility: 0.0025, drift: 0.00008, meanReversion: 0.0009 },
    { name: 'Guru Global', symbol: 'GUR', market: 'public', price: 7, volatility: 0.009, drift: -0.0004, meanReversion: 0.0004 },
    { name: 'Muntjesbank', symbol: 'MNT', market: 'public', price: 18, volatility: 0.0015, drift: 0.00003, meanReversion: 0.0016 },
    { name: 'Sikje Cosmetics', symbol: 'SIK', market: 'public', price: 5.5, volatility: 0.005, drift: 0.00012, meanReversion: 0.0008 },
    // The businessman's private book — no chart, higher return, read out by hand.
    { name: 'Villa Vastgoed', symbol: 'VIL', market: 'private', price: 45, volatility: 0.003, drift: 0.0006, meanReversion: 0.0003 },
    { name: 'Zwarte Kat Import', symbol: 'ZKI', market: 'private', price: 30, volatility: 0.006, drift: 0.0008, meanReversion: 0.0002 },
    { name: 'Gouden Handdruk NV', symbol: 'GHN', market: 'private', price: 60, volatility: 0.0035, drift: 0.0005, meanReversion: 0.0004 },
  ];
  return seeds.map((s, i) => makeBusiness(s, i));
}

export function makeBusiness(input, slot) {
  // `truePrice` is the continuous value the random walk actually runs on;
  // `price` is truePrice rounded to a whole euro — the only number the board,
  // the dealer and the kids ever see or trade at. Running the walk itself on
  // whole euros kills it stone dead for anything with modest volatility: a
  // typical tick moves the price by well under €0.50, which rounds straight
  // back to the same integer forever, so the price never budges.
  const truePrice = num(input.truePrice ?? input.price, 100, MIN_PRICE, MAX_PRICE);
  const price = roundPrice(truePrice);
  return {
    id: randomUUID().slice(0, 8),
    name: String(input.name || 'Unnamed Co.').slice(0, 48),
    symbol: String(input.symbol || 'NEW').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'NEW',
    market: input.market === 'private' ? 'private' : 'public',
    colorIndex: Number.isInteger(slot) ? slot : 0,
    truePrice,
    price,
    anchor: truePrice, // fair value the price is pulled toward
    volatility: num(input.volatility, 0.003, 0, 0.2), // per sim-minute sigma
    drift: num(input.drift, 0, -0.01, 0.01), // per sim-minute mu
    meanReversion: num(input.meanReversion, 0.0008, 0, 0.2),
    dayOpen: price,
    prevClose: price,
    dayHigh: price,
    dayLow: price,
    history: [price],
    pump: null, // { target, remaining, totalMinutes, percent }
  };
}

export function createState() {
  const businesses = seedBusinesses();
  return {
    schema: 2,
    schedule: { ...DEFAULT_SCHEDULE },
    clock: {
      day: 1,
      minuteOfDay: 0,
      running: true,
      // speed = simulated minutes elapsed per real-world second.
      // 0.2 => one game hour takes 5 real minutes, a 09:00-19:00 day 50 minutes.
      speed: 0.2,
    },
    businesses,
    portfolio: {
      startingCash: 500,
      cash: 500,
      realized: 0,
      positions: {}, // id -> { qty, avgCost }
      trades: [],
      equityHistory: [500],
    },
    settings: {
      feePct: 0,
      // When true the desk refuses trades outside exchange hours.
      enforceExchangeHours: true,
    },
    rev: 1,
  };
}

// Older saved states get missing fields filled in rather than thrown away.
export function normalizeState(raw) {
  const fresh = createState();
  if (!raw || typeof raw !== 'object') return fresh;
  const s = { ...fresh, ...raw };
  s.schedule = { ...fresh.schedule, ...(raw.schedule || {}) };
  s.clock = { ...fresh.clock, ...(raw.clock || {}) };
  s.settings = { ...fresh.settings, ...(raw.settings || {}) };
  s.portfolio = { ...fresh.portfolio, ...(raw.portfolio || {}) };
  s.portfolio.positions = raw.portfolio?.positions || {};
  s.portfolio.trades = raw.portfolio?.trades || [];
  s.businesses = Array.isArray(raw.businesses) && raw.businesses.length
    ? raw.businesses.map((b, i) => {
      const merged = { ...makeBusiness(b, i), ...b, id: b.id || randomUUID().slice(0, 8) };
      // A save from before truePrice existed carries only the old (possibly
      // fractional, possibly already-rounded) price — resync the whole-euro
      // display price to whatever truePrice makeBusiness derived it from.
      merged.price = roundPrice(merged.truePrice);
      return merged;
    })
    : fresh.businesses;
  s.clock.minuteOfDay = clamp(Math.round(s.clock.minuteOfDay) || 0, 0, minutesPerDay(s));
  alignHistories(s);
  s.rev = (raw.rev || 1) + 1;
  return s;
}

// Every business history is kept the same length (minuteOfDay + 1) so a single
// cursor can drive incremental updates for all series at once.
export function alignHistories(state) {
  const want = state.clock.minuteOfDay + 1;
  for (const b of state.businesses) {
    if (!Array.isArray(b.history) || b.history.length === 0) b.history = [b.price];
    while (b.history.length > want) b.history.pop();
    while (b.history.length < want) b.history.push(b.price);
  }
  if (!Array.isArray(state.portfolio.equityHistory)) state.portfolio.equityHistory = [];
  const eq = state.portfolio.equityHistory;
  while (eq.length > want) eq.pop();
  while (eq.length < want) eq.push(round2(netWorth(state)));
}

export function nextColorSlot(state) {
  const used = new Set(state.businesses.filter((b) => b.market === 'public').map((b) => b.colorIndex));
  for (let i = 0; i < SERIES_COLORS.length; i++) if (!used.has(i)) return i;
  return state.businesses.length % SERIES_COLORS.length;
}

// --- valuation -------------------------------------------------------------

export function positionValue(state) {
  let v = 0;
  for (const b of state.businesses) {
    const pos = state.portfolio.positions[b.id];
    if (pos && pos.qty > 0) v += pos.qty * b.price;
  }
  return v;
}

export function netWorth(state) {
  return state.portfolio.cash + positionValue(state);
}

// --- the tick --------------------------------------------------------------

// A campaign wobbles harder than ordinary day-to-day noise — even a sleepy
// listing should visibly swing while it's being pushed — but still always
// lands exactly on target.
const PUMP_WOBBLE_MULT = 1.8;
const PUMP_WOBBLE_FLOOR = 0.004;

function advancePrices(state, exchangeOpen) {
  for (const b of state.businesses) {
    // The private book is never listed, so it keeps moving after the bell.
    if (exchangeOpen || b.market === 'private') {
      if (b.pump && b.pump.remaining > 0) {
        const remaining = b.pump.remaining;
        if (remaining === 1) {
          // Land exactly on target — no rate-based approximation, so
          // accumulated float/rounding drift from earlier ticks can't leave
          // it short.
          b.truePrice = clamp(b.pump.target, MIN_PRICE, MAX_PRICE);
        } else {
          // The rate needed to reach the target is recalculated fresh every
          // tick from wherever the price actually is, so the wobble below
          // (or ordinary gravity, if this business still has some) can shove
          // it around along the way without ever stopping it from arriving
          // on schedule.
          const needed = Math.log(b.pump.target / b.truePrice) / remaining;
          const wobble = Math.max(b.volatility, PUMP_WOBBLE_FLOOR) * PUMP_WOBBLE_MULT;
          const r = needed + gauss() * wobble;
          b.truePrice = round2(clamp(b.truePrice * Math.exp(r), MIN_PRICE, MAX_PRICE));
        }
        b.pump.remaining -= 1;
        if (b.pump.remaining <= 0) b.pump = null;
      } else {
        const pull = b.meanReversion * Math.log(b.anchor / b.truePrice);
        const r = b.drift + pull + gauss() * b.volatility;
        b.truePrice = round2(clamp(b.truePrice * Math.exp(r), MIN_PRICE, MAX_PRICE));
      }

      // The walk runs on the continuous truePrice so sub-euro drift keeps
      // accumulating; only the rounded price is ever shown or dealt.
      b.price = roundPrice(b.truePrice);
      b.dayHigh = Math.max(b.dayHigh, b.price);
      b.dayLow = Math.min(b.dayLow, b.price);
    }
    // A closed public listing simply repeats its last price, so the chart
    // shows a flat closed stretch rather than a gap.
    b.history.push(b.price);
  }
  state.portfolio.equityHistory.push(round2(netWorth(state)));
}

function rollDay(state) {
  state.clock.day += 1;
  state.clock.minuteOfDay = 0;
  for (const b of state.businesses) {
    b.prevClose = b.price;
    b.dayOpen = b.price;
    b.dayHigh = b.price;
    b.dayLow = b.price;
    b.history = [b.price];
  }
  state.portfolio.equityHistory = [round2(netWorth(state))];
}

/** Advance the world by exactly one simulated minute. */
export function step(state) {
  if (state.clock.minuteOfDay >= minutesPerDay(state)) {
    rollDay(state);
    return 'roll';
  }
  state.clock.minuteOfDay += 1;
  advancePrices(state, isExchangeOpen(state));
  return 'tick';
}

// --- mutations -------------------------------------------------------------

export function addBusiness(state, input) {
  const b = makeBusiness(input, nextColorSlot(state));
  b.history = new Array(state.clock.minuteOfDay + 1).fill(round2(b.price));
  state.businesses.push(b);
  state.rev += 1;
  return b;
}

export function updateBusiness(state, id, patch) {
  const b = state.businesses.find((x) => x.id === id);
  if (!b) return null;
  if (patch.name !== undefined) b.name = String(patch.name).slice(0, 48) || b.name;
  if (patch.symbol !== undefined) {
    b.symbol = String(patch.symbol).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || b.symbol;
  }
  if (patch.market !== undefined) b.market = patch.market === 'private' ? 'private' : 'public';
  if (patch.volatility !== undefined) b.volatility = num(patch.volatility, b.volatility, 0, 0.2);
  if (patch.drift !== undefined) b.drift = num(patch.drift, b.drift, -0.01, 0.01);
  if (patch.meanReversion !== undefined) b.meanReversion = num(patch.meanReversion, b.meanReversion, 0, 0.2);
  if (patch.anchor !== undefined) b.anchor = num(patch.anchor, b.anchor, MIN_PRICE, MAX_PRICE);
  if (patch.price !== undefined) {
    b.truePrice = num(patch.price, b.truePrice, MIN_PRICE, MAX_PRICE);
    b.price = roundPrice(b.truePrice);
    b.history[b.history.length - 1] = b.price;
    b.dayHigh = Math.max(b.dayHigh, b.price);
    b.dayLow = Math.min(b.dayLow, b.price);
  }
  if (patch.colorIndex !== undefined) {
    b.colorIndex = clamp(Math.round(Number(patch.colorIndex)) || 0, 0, SERIES_COLORS.length - 1);
  }
  state.rev += 1;
  return b;
}

export function removeBusiness(state, id) {
  const i = state.businesses.findIndex((x) => x.id === id);
  if (i === -1) return false;
  const [b] = state.businesses.splice(i, 1);
  // Liquidate any open position at the last traded price so cash stays honest.
  const pos = state.portfolio.positions[id];
  if (pos && pos.qty > 0) {
    const proceeds = pos.qty * b.price;
    state.portfolio.cash += proceeds;
    state.portfolio.realized += proceeds - pos.qty * pos.avgCost;
    state.portfolio.trades.unshift({
      t: Date.now(), day: state.clock.day, time: formatClock(state),
      symbol: b.symbol, side: 'liquidate', qty: pos.qty, price: b.price, value: proceeds,
    });
  }
  delete state.portfolio.positions[id];
  state.rev += 1;
  return true;
}

/**
 * Push a business up or down.
 *   minutes <= 0  -> instant jump this tick
 *   minutes > 0   -> the move is spread evenly over that many simulated minutes
 *   permanent     -> also moves the anchor, so mean reversion doesn't undo it
 */
export function pump(state, id, percent, minutes, permanent = true) {
  const b = state.businesses.find((x) => x.id === id);
  if (!b) return null;
  const pct = num(percent, 0, -99, 1000);
  const mins = Math.round(num(minutes, 0, 0, minutesPerDay(state)));
  const factor = 1 + pct / 100;
  if (factor <= 0) return null;

  if (permanent) b.anchor = clamp(b.anchor * factor, MIN_PRICE, MAX_PRICE);

  if (mins <= 0) {
    b.truePrice = clamp(round2(b.truePrice * factor), MIN_PRICE, MAX_PRICE);
    b.price = roundPrice(b.truePrice);
    b.history[b.history.length - 1] = b.price;
    b.dayHigh = Math.max(b.dayHigh, b.price);
    b.dayLow = Math.min(b.dayLow, b.price);
    b.pump = null;
  } else {
    // A campaign targets an exact price, not a fixed per-minute rate — see
    // advancePrices, which recomputes the rate needed every tick so the move
    // always lands on target regardless of the noise along the way.
    b.pump = {
      target: clamp(round2(b.truePrice * factor), MIN_PRICE, MAX_PRICE),
      remaining: mins,
      totalMinutes: mins,
      percent: pct,
    };
  }
  return b;
}

export function clearPump(state, id) {
  const b = state.businesses.find((x) => x.id === id);
  if (!b) return null;
  b.pump = null;
  return b;
}

export function trade(state, id, side, qtyInput) {
  const b = state.businesses.find((x) => x.id === id);
  if (!b) return { ok: false, error: 'Unknown business' };
  if (state.settings.enforceExchangeHours && b.market === 'public' && !isExchangeOpen(state)) {
    return { ok: false, error: `The exchange is closed (open ${sessionView(state).exchangeLabel})` };
  }
  const qty = Math.floor(num(qtyInput, 0, 0, 1e9));
  if (qty <= 0) return { ok: false, error: 'Quantity must be at least 1' };

  const p = state.portfolio;
  const price = b.price;
  // The dealer only has whole-euro coins and notes, so the fee (if any) has to
  // round to a whole euro too — nothing in the till can be fractional.
  const fee = Math.round((state.settings.feePct / 100) * qty * price);

  if (side === 'buy') {
    const cost = qty * price + fee;
    if (cost > p.cash + 1e-9) return { ok: false, error: 'Not enough cash' };
    const pos = p.positions[b.id] || { qty: 0, avgCost: 0 };
    const newQty = pos.qty + qty;
    // The buy fee rides in the cost basis so it shows up in realised P/L later.
    pos.avgCost = (pos.avgCost * pos.qty + price * qty + fee) / newQty;
    pos.qty = newQty;
    p.positions[b.id] = pos;
    p.cash -= cost;
  } else if (side === 'sell') {
    const pos = p.positions[b.id];
    if (!pos || pos.qty < qty) return { ok: false, error: 'Not enough shares' };
    const proceeds = qty * price - fee;
    p.realized += qty * (price - pos.avgCost) - fee;
    pos.qty -= qty;
    p.cash += proceeds;
    if (pos.qty === 0) delete p.positions[b.id];
  } else {
    return { ok: false, error: 'Side must be buy or sell' };
  }

  p.trades.unshift({
    t: Date.now(),
    day: state.clock.day,
    time: formatClock(state),
    symbol: b.symbol,
    side,
    qty,
    price,
    value: qty * price,
  });
  if (p.trades.length > 200) p.trades.length = 200;
  return { ok: true, business: b };
}

export function resetPortfolio(state, cash) {
  const start = roundPrice(num(cash, state.portfolio.startingCash, 0, 1e12));
  state.portfolio.startingCash = start;
  state.portfolio.cash = start;
  state.portfolio.realized = 0;
  state.portfolio.positions = {};
  state.portfolio.trades = [];
  state.portfolio.equityHistory = new Array(state.clock.minuteOfDay + 1).fill(round2(start));
  state.rev += 1;
}

export function setClock(state, patch) {
  const c = state.clock;
  if (patch.running !== undefined) c.running = Boolean(patch.running);
  if (patch.speed !== undefined) c.speed = num(patch.speed, c.speed, 0.001, 600);
  if (patch.day !== undefined) c.day = Math.max(1, Math.round(num(patch.day, c.day, 1, 1e6)));
  if (patch.minuteOfDay !== undefined) {
    c.minuteOfDay = clamp(Math.round(num(patch.minuteOfDay, c.minuteOfDay, 0, minutesPerDay(state))), 0, minutesPerDay(state));
    alignHistories(state);
    state.rev += 1;
  }
  return c;
}

/** Hours are whole numbers 0-24; the day window must be a forward span. */
export function setSchedule(state, patch) {
  const s = state.schedule;
  const hour = (v, fallback) => clamp(Math.round(num(v, fallback, 0, 24)), 0, 24);
  const next = {
    dayStart: patch.dayStart !== undefined ? hour(patch.dayStart, s.dayStart) : s.dayStart,
    dayEnd: patch.dayEnd !== undefined ? hour(patch.dayEnd, s.dayEnd) : s.dayEnd,
    exchangeOpen: patch.exchangeOpen !== undefined ? hour(patch.exchangeOpen, s.exchangeOpen) : s.exchangeOpen,
    exchangeClose: patch.exchangeClose !== undefined ? hour(patch.exchangeClose, s.exchangeClose) : s.exchangeClose,
    casinoOpen: patch.casinoOpen !== undefined ? hour(patch.casinoOpen, s.casinoOpen) : s.casinoOpen,
    casinoClose: patch.casinoClose !== undefined ? hour(patch.casinoClose, s.casinoClose) : s.casinoClose,
  };
  if (next.dayEnd <= next.dayStart) return { ok: false, error: 'The day must end after it starts' };
  state.schedule = next;
  state.clock.minuteOfDay = clamp(state.clock.minuteOfDay, 0, minutesPerDay(state));
  alignHistories(state);
  state.rev += 1;
  return { ok: true };
}

/** Jump straight to the next day start without simulating the rest of the day. */
export function skipToNextDay(state) {
  rollDay(state);
  state.rev += 1;
}
