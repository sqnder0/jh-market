import test from 'node:test';
import assert from 'node:assert/strict';

import * as sim from '../src/sim.js';
import { formatMinute, minutesPerDay } from '../src/sim.js';

function freshState() {
  const s = sim.createState();
  // Keep the tests deterministic: no random wobble, no drift, no gravity.
  for (const b of s.businesses) {
    b.volatility = 0;
    b.drift = 0;
    b.meanReversion = 0;
  }
  return s;
}

/** Minutes from the start of the day to a wall-clock hour. */
const at = (s, hour) => (hour - s.schedule.dayStart) * 60;

test('a game day is the 09:00 - 19:00 cycle', () => {
  const s = freshState();
  assert.equal(minutesPerDay(s), 600);
  assert.equal(sim.formatClock(s, 0), '09:00');
  assert.equal(sim.formatClock(s, 90), '10:30');
  assert.equal(sim.formatClock(s, 599), '18:59');
  assert.equal(sim.formatClock(s, 600), '19:00');
  assert.equal(formatMinute(24 * 60), '00:00');
});

test('the exchange is open 09:00 - 17:00 and the casino 15:00 - 19:00', () => {
  const s = freshState();
  const openAt = (hour) => sim.isExchangeOpen(s, at(s, hour));
  const casinoAt = (hour) => sim.isCasinoOpen(s, at(s, hour));

  assert.equal(openAt(9), true);
  assert.equal(openAt(16), true);
  assert.equal(openAt(17), false, 'the exchange shuts at 17:00 sharp');
  assert.equal(openAt(18), false);

  assert.equal(casinoAt(14), false);
  assert.equal(casinoAt(15), true, 'the casino opens at 15:00');
  assert.equal(casinoAt(18), true);
  assert.equal(casinoAt(19), false);
});

test('the day rolls back to 09:00 after the 19:00 close', () => {
  const s = freshState();
  for (let i = 0; i < 600; i++) sim.step(s);
  assert.equal(s.clock.minuteOfDay, 600);
  assert.equal(s.clock.day, 1);
  assert.equal(sim.formatClock(s), '19:00');

  const closes = s.businesses.map((b) => b.price);
  assert.equal(sim.step(s), 'roll');
  assert.equal(s.clock.day, 2);
  assert.equal(s.clock.minuteOfDay, 0);
  s.businesses.forEach((b, i) => {
    assert.equal(b.prevClose, closes[i], 'yesterday close carries over');
    assert.equal(b.dayOpen, closes[i], 'today opens where yesterday closed');
    assert.equal(b.history.length, 1, 'history restarts for the new day');
  });
});

test('listed prices freeze once the exchange closes; the private book does not', () => {
  const s = freshState();
  for (const b of s.businesses) b.volatility = 0.02;

  sim.setClock(s, { minuteOfDay: at(s, 16) + 59 });
  sim.step(s); // -> 17:00, the first closed minute
  const frozen = new Map(s.businesses.map((b) => [b.id, b.price]));

  for (let i = 0; i < 90; i++) sim.step(s);
  assert.equal(sim.formatClock(s), '18:30');

  for (const b of s.businesses.filter((x) => x.market === 'public')) {
    assert.equal(b.price, frozen.get(b.id), `${b.symbol} does not move while closed`);
    assert.equal(b.history.at(-1), frozen.get(b.id), 'the closed stretch is drawn flat');
  }
  assert.ok(
    s.businesses.some((b) => b.market === 'private' && b.price !== frozen.get(b.id)),
    'private shares keep moving after the bell',
  );
  assert.equal(s.businesses[0].history.length, s.clock.minuteOfDay + 1);
});

test('every history stays the same length as the clock', () => {
  const s = freshState();
  for (let i = 0; i < 120; i++) sim.step(s);
  sim.addBusiness(s, { name: 'Late Lister', symbol: 'LATE', price: 50 });
  for (const b of s.businesses) {
    assert.equal(b.history.length, s.clock.minuteOfDay + 1, `${b.symbol} history aligned`);
  }
  assert.equal(s.portfolio.equityHistory.length, s.clock.minuteOfDay + 1);
});

test('prices move when volatility is on and stay put when it is off', () => {
  const s = freshState();
  const before = s.businesses.map((b) => b.price);
  for (let i = 0; i < 60; i++) sim.step(s);
  s.businesses.forEach((b, i) => assert.equal(b.price, before[i], 'flat with zero volatility'));

  for (const b of s.businesses) b.volatility = 0.01;
  for (let i = 0; i < 60; i++) sim.step(s);
  assert.ok(s.businesses.some((b, i) => b.price !== before[i]), 'volatility moves prices');
});

// Regression: prices are displayed and dealt in whole euros, but that
// rounding must not happen to the walk itself. A tiny per-tick drift is
// smaller than €0.50, so if the state were rounded to a whole euro every
// tick (as it briefly was), it would round straight back to where it started
// forever and the price could never move even with a steady, unmistakable
// trend behind it.
test('a small steady drift accumulates on the true price instead of being rounded away each tick', () => {
  const s = freshState();
  const b = s.businesses[0];
  b.truePrice = 100;
  b.price = 100;
  b.anchor = 100;
  b.drift = 0.0005; // ~€0.05/minute at this price — well under the €1 rounding grain
  for (let i = 0; i < 300; i++) sim.step(s);
  assert.ok(b.price > 100, 'the drift eventually crosses a whole-euro boundary');
});

test('the seed market has a public board and a private book', () => {
  const s = freshState();
  const publics = s.businesses.filter((b) => b.market === 'public');
  const privates = s.businesses.filter((b) => b.market === 'private');
  assert.ok(publics.length >= 3, 'several listings for the kids');
  assert.ok(privates.length >= 1, 'the businessman has private stock');
  assert.ok(publics.some((b) => /casino/i.test(b.name)), 'the casino is publicly traded');
});

// Regression: whole-euro rounding means a cheap listing needs proportionally
// more volatility than an expensive one to visibly move at the same pace —
// a flat percentage looks calm on a high price and frozen on a low one. This
// checks every seed business clears a minimum "euros of wobble per minute",
// not just a minimum percentage, so nobody re-tunes one in isolation and
// quietly freezes it again.
test('every seed listing has enough absolute volatility to visibly move', () => {
  const s = sim.createState();
  for (const b of s.businesses) {
    assert.ok(b.price * b.volatility > 0.25,
      `${b.symbol}: price(${b.price}) * volatility(${b.volatility}) is too small to move on a whole-euro board`);
  }
});

// Prices round to whole euros for the dealer, so these pump tests use a
// higher-priced business — otherwise a small percentage move can round away
// to nothing and mask the mechanism being tested.
test('an instant pump lands immediately and moves fair value', () => {
  const s = freshState();
  const b = s.businesses[0];
  b.truePrice = 1000;
  b.price = 1000;
  b.anchor = 1000;
  const start = b.price;
  sim.pump(s, b.id, 10, 0, true);
  assert.ok(Math.abs(b.price - start * 1.1) < 1, 'price jumped 10%');
  assert.ok(Math.abs(b.anchor - start * 1.1) < 0.02, 'fair value followed');
  assert.equal(b.history.at(-1), b.price, 'the jump is reflected in the last chart point');
});

test('a pump campaign is spread across its minutes and then expires', () => {
  const s = freshState();
  const b = s.businesses[0];
  b.truePrice = 1000;
  b.price = 1000;
  b.anchor = 1000;
  const start = b.price;
  const minutes = 40;
  sim.pump(s, b.id, -20, minutes, false);
  for (let i = 0; i < minutes / 2; i++) sim.step(s);
  // The campaign wobbles (deliberately), so any single early tick can swing
  // either direction — but by the midpoint it has moved and isn't done yet.
  assert.notEqual(b.price, start, 'has moved partway through the campaign');
  assert.ok(b.pump, 'campaign still running at the midpoint');
  for (let i = 0; i < minutes / 2; i++) sim.step(s);
  assert.equal(b.pump, null, 'campaign expires');
  assert.equal(b.price, start * 0.8, 'lands exactly on the promised -20%, not just close to it');
});

// A campaign is a promise: push it up X% over Y minutes and it WILL be up
// X% when Y minutes are up, no matter what the market throws at it along the
// way — heavy volatility, strong gravity pulling the other way, all of it.
// The path in between is free to wander (and is deliberately wobblier than
// normal), but the destination is not negotiable.
test('a pump campaign lands exactly on target despite strong gravity and noise fighting it', () => {
  const s = freshState();
  const b = s.businesses[0];
  b.truePrice = 500;
  b.price = 500;
  b.anchor = 500; // permanent:false below, so gravity actively opposes the push
  b.volatility = 0.02;
  b.meanReversion = 0.08;
  const start = b.truePrice;
  const target = start * 1.05;
  const minutes = 15;
  sim.pump(s, b.id, 5, minutes, false);
  // A perfectly noise-free bridge would follow this exact geometric path.
  const straightLine = (i) => start * Math.exp((Math.log(target / start) * i) / minutes);
  let maxDeviation = 0;
  for (let i = 1; i <= minutes; i++) {
    sim.step(s);
    maxDeviation = Math.max(maxDeviation, Math.abs(b.truePrice - straightLine(i)));
  }
  assert.equal(b.truePrice, target, 'landed exactly on the +5% target');
  assert.equal(b.pump, null, 'campaign expires on schedule');
  assert.ok(maxDeviation > 2, 'wobbled noticeably off the straight-line path along the way');
});

test('gravity pulls a pumped price back when the pump is not permanent', () => {
  const s = freshState();
  const b = s.businesses[0];
  b.truePrice = 1000;
  b.price = 1000;
  b.anchor = 1000;
  const start = b.price;
  b.meanReversion = 0.05;
  sim.pump(s, b.id, 25, 0, false);
  const jumped = b.price;
  for (let i = 0; i < 200; i++) sim.step(s);
  assert.ok(b.price < jumped, 'price fell back');
  assert.ok(Math.abs(b.price - start) < start * 0.02, 'settled near the old fair value');
});

test('buying and selling keeps cash, average cost and P/L honest', () => {
  const s = freshState();
  sim.resetPortfolio(s, 100000);
  const b = s.businesses[0];
  b.price = 100;

  assert.equal(sim.trade(s, b.id, 'buy', 10).ok, true);
  assert.equal(s.portfolio.cash, 100000 - 1000);
  assert.deepEqual(s.portfolio.positions[b.id], { qty: 10, avgCost: 100 });

  b.price = 200;
  assert.equal(sim.trade(s, b.id, 'buy', 10).ok, true);
  assert.equal(s.portfolio.positions[b.id].avgCost, 150, 'average cost blends');

  b.price = 250;
  assert.equal(sim.trade(s, b.id, 'sell', 20).ok, true);
  assert.equal(s.portfolio.positions[b.id], undefined, 'closed position is removed');
  assert.equal(s.portfolio.realized, 20 * (250 - 150));
  assert.equal(s.portfolio.cash, 100000 - 1000 - 2000 + 5000);
});

test('trades that cannot settle are rejected', () => {
  const s = freshState();
  const b = s.businesses[0];
  b.price = 100;
  assert.match(sim.trade(s, b.id, 'buy', 100000).error, /cash/i);
  assert.match(sim.trade(s, b.id, 'sell', 1).error, /shares/i);
  assert.match(sim.trade(s, b.id, 'buy', 0).error, /at least 1/i);
  assert.match(sim.trade(s, 'nope', 'buy', 1).error, /Unknown/i);
});

test('public trades are refused once the exchange closes, private ones are not', () => {
  const s = freshState();
  sim.resetPortfolio(s, 100000);
  sim.setClock(s, { minuteOfDay: at(s, 18) });

  const pub = s.businesses.find((b) => b.market === 'public');
  const priv = s.businesses.find((b) => b.market === 'private');
  assert.match(sim.trade(s, pub.id, 'buy', 1).error, /closed/i);
  assert.equal(sim.trade(s, priv.id, 'buy', 1).ok, true, 'the private book never closes');

  s.settings.enforceExchangeHours = false;
  assert.equal(sim.trade(s, pub.id, 'buy', 1).ok, true, 'the override lets the desk trade anyway');
});

test('a fee is charged on both sides and lands in realised P/L', () => {
  const s = freshState();
  sim.resetPortfolio(s, 100000);
  s.settings.feePct = 1;
  const b = s.businesses[0];
  b.price = 100;

  sim.trade(s, b.id, 'buy', 10);
  assert.equal(s.portfolio.cash, 100000 - 1000 - 10);
  assert.equal(s.portfolio.positions[b.id].avgCost, 101, 'buy fee rides in the cost basis');

  sim.trade(s, b.id, 'sell', 10);
  assert.equal(s.portfolio.cash, 100000 - 10 - 10, 'a round trip at a flat price costs two fees');
  assert.equal(s.portfolio.realized, -20);
});

test('delisting a business liquidates the position at the last price', () => {
  const s = freshState();
  sim.resetPortfolio(s, 100000);
  const b = s.businesses[0];
  b.price = 100;
  sim.trade(s, b.id, 'buy', 10);
  b.price = 130;
  sim.removeBusiness(s, b.id);
  assert.equal(s.businesses.find((x) => x.id === b.id), undefined);
  assert.equal(s.portfolio.positions[b.id], undefined);
  assert.equal(s.portfolio.cash, 100000 - 1000 + 1300);
  assert.equal(s.portfolio.realized, 300);
});

test('colour slots are allocated across the public board and reused when freed', () => {
  const s = freshState();
  const publics = s.businesses.filter((b) => b.market === 'public');
  assert.equal(new Set(publics.map((b) => b.colorIndex)).size, publics.length, 'no two board series share a colour');
  const firstPublic = publics[0];
  sim.removeBusiness(s, firstPublic.id);
  assert.equal(sim.nextColorSlot(s), firstPublic.colorIndex, 'a freed slot is reused');
});

test('the schedule can be retimed and rejects a backwards day', () => {
  const s = freshState();
  assert.equal(sim.setSchedule(s, { dayEnd: 8 }).ok, false);
  assert.equal(sim.setSchedule(s, { dayStart: 8, dayEnd: 20, exchangeClose: 18 }).ok, true);
  assert.equal(minutesPerDay(s), 720);
  assert.equal(sim.formatClock(s, 0), '08:00');
  assert.equal(sim.isExchangeOpen(s, at(s, 17)), true, 'the exchange now runs an hour later');
  for (const b of s.businesses) assert.equal(b.history.length, s.clock.minuteOfDay + 1);
});

test('a saved state round-trips through normalize', () => {
  const s = freshState();
  sim.resetPortfolio(s, 100000);
  for (let i = 0; i < 50; i++) sim.step(s);
  sim.trade(s, s.businesses[0].id, 'buy', 1);
  const restored = sim.normalizeState(JSON.parse(JSON.stringify(s)));
  assert.equal(restored.clock.minuteOfDay, s.clock.minuteOfDay);
  assert.equal(restored.businesses.length, s.businesses.length);
  assert.equal(restored.schedule.dayEnd, 19);
  assert.equal(restored.portfolio.positions[s.businesses[0].id].qty, 1);
  for (const b of restored.businesses) {
    assert.equal(b.history.length, restored.clock.minuteOfDay + 1);
  }
});

test('rewinding the clock trims history back to match', () => {
  const s = freshState();
  for (let i = 0; i < 300; i++) sim.step(s);
  sim.setClock(s, { minuteOfDay: 120 });
  assert.equal(s.clock.minuteOfDay, 120);
  for (const b of s.businesses) assert.equal(b.history.length, 121);
});

test('clock speed and time are clamped to sane ranges', () => {
  const s = freshState();
  sim.setClock(s, { speed: 99999 });
  assert.equal(s.clock.speed, 600);
  sim.setClock(s, { speed: 0 });
  assert.equal(s.clock.speed, 0.001);
  sim.setClock(s, { minuteOfDay: 5000 });
  assert.equal(s.clock.minuteOfDay, minutesPerDay(s));
});
