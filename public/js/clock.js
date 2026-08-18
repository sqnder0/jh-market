import { api, connect, durationText, el, gameDuration, mountChrome, onState, store, toast } from './common.js';
import { setText } from './dom.js';

mountChrome('clock');

const $ = (id) => document.getElementById(id);

const PRESET_TOLERANCE = 0.01;

// speed is simulated minutes per real second; the dial the game master turns is
// "how many real minutes does one game hour take", which is its reciprocal.
const realMinutesPerGameHour = (clock) => clock.realSecondsPerGameHour / 60;
const speedFromHourMinutes = (minutes) => 1 / minutes;

/** Position of a wall-clock hour inside the day, as a 0-1 fraction. */
function fraction(schedule, hour) {
  const span = schedule.dayEnd - schedule.dayStart;
  return Math.min(1, Math.max(0, (hour - schedule.dayStart) / span));
}

function placeWindow(node, schedule, openHour, closeHour) {
  const from = fraction(schedule, openHour);
  const to = fraction(schedule, closeHour);
  node.style.left = `${from * 100}%`;
  node.style.width = `${Math.max(0, to - from) * 100}%`;
}

function renderTicks(schedule) {
  const host = $('hour-ticks');
  const wanted = `${schedule.dayStart}-${schedule.dayEnd}`;
  if (host.dataset.range === wanted) return;
  host.dataset.range = wanted;
  host.textContent = '';
  const span = schedule.dayEnd - schedule.dayStart;
  const step = span > 12 ? 3 : span > 6 ? 2 : 1;
  for (let h = schedule.dayStart; h <= schedule.dayEnd; h += step) {
    host.appendChild(el('span', { text: `${String(h % 24).padStart(2, '0')}:00` }));
  }
}

onState((s) => {
  const c = s.clock;
  const { sessions, schedule } = c;

  setText($('day-badge'), `Speldag ${c.day}`);
  setText($('big-time'), c.time, 'big-time');

  $('sess-exchange').dataset.open = String(sessions.exchangeOpen);
  const exUntil = gameDuration(sessions.exchangeChangesIn);
  setText($('sess-exchange-when'), sessions.exchangeOpen
    ? `open · ${sessions.exchangeLabel}${exUntil ? ` · dicht over ${exUntil}` : ''}`
    : `dicht · ${sessions.exchangeLabel}${exUntil ? ` · open over ${exUntil}` : ''}`);

  $('sess-casino').dataset.open = String(sessions.casinoOpen);
  const caUntil = gameDuration(sessions.casinoChangesIn);
  setText($('sess-casino-when'), sessions.casinoOpen
    ? `open · ${sessions.casinoLabel}${caUntil ? ` · dicht over ${caUntil}` : ''}`
    : `dicht · ${sessions.casinoLabel}${caUntil ? ` · open over ${caUntil}` : ''}`);

  $('sess-run').dataset.open = String(c.running);
  setText($('run-word'), c.running ? 'Loopt' : 'Gepauzeerd', 'who');
  setText($('btn-toggle'), c.running ? 'Pauze' : 'Verder');

  renderTicks(schedule);
  placeWindow($('win-exchange'), schedule, schedule.exchangeOpen, schedule.exchangeClose);
  placeWindow($('win-casino'), schedule, schedule.casinoOpen, schedule.casinoClose);

  const progress = c.minuteOfDay / c.minutesPerDay;
  for (const id of ['elapsed-a', 'elapsed-b']) $(id).style.width = `${progress * 100}%`;
  for (const id of ['head-a', 'head-b']) $(id).style.left = `calc(${progress * 100}% - 1px)`;

  const hours = Math.floor(c.minuteOfDay / 60);
  setText($('r-elapsed'), `${hours}u ${String(c.minuteOfDay % 60).padStart(2, '0')}m`);
  setText($('r-elapsed-sub'), `van ${c.minutesPerDay / 60}u speldag`);
  setText($('r-close'), c.running ? durationText(c.remainingRealSeconds) : 'gepauzeerd');
  setText($('r-hour'), durationText(c.realSecondsPerGameHour));
  setText($('r-daylen'), durationText(c.realSecondsPerDay));
  setText($('r-daylen-sub'), `${schedule.dayStart}:00 → ${schedule.dayEnd}:00`);

  const perHour = realMinutesPerGameHour(c);
  if (document.activeElement !== $('hourlen')) {
    $('hourlen').value = perHour.toFixed(2).replace(/\.?0+$/, '');
  }
  for (const btn of document.querySelectorAll('#preset button')) {
    btn.setAttribute('aria-pressed', String(Math.abs(Number(btn.dataset.min) - perHour) < PRESET_TOLERANCE));
  }

  // The whole point of the dial: how much game time a session of play buys.
  const gameHoursIn90 = 90 / perHour;
  setText($('plan-hint'),
    `Bij deze snelheid loopt er in 1u30 echte speeltijd ongeveer ${gameHoursIn90.toFixed(1)} speluren voorbij ` +
    `— zo'n ${(gameHoursIn90 / (c.minutesPerDay / 60)).toFixed(1)} speldagen.`);
});

$('preset').addEventListener('click', (event) => {
  const btn = event.target.closest('button');
  if (btn) api('/api/clock', { speed: speedFromHourMinutes(Number(btn.dataset.min)) });
});

$('btn-toggle').addEventListener('click', () => api('/api/clock', { running: !store.clock.running }));
$('btn-skip').addEventListener('click', () =>
  api('/api/clock/skip-day').then(() => toast('Nieuwe speldag begonnen', 'success')));

$('btn-apply').addEventListener('click', () => {
  const patch = {};
  const minutes = Number.parseFloat($('hourlen').value);
  if (Number.isFinite(minutes) && minutes > 0) patch.speed = speedFromHourMinutes(minutes);

  const jump = $('jump').value.trim();
  if (jump) {
    const match = /^(\d{1,2})\s*[:.]?\s*(\d{2})?$/.exec(jump);
    if (!match) return toast('Schrijf de tijd als 15:00', 'error');
    const { schedule, minutesPerDay } = store.clock;
    const asMinutes = Number(match[1]) * 60 + Number(match[2] || 0) - schedule.dayStart * 60;
    if (asMinutes < 0 || asMinutes > minutesPerDay) {
      return toast(`De speldag loopt van ${schedule.dayStart}:00 tot ${schedule.dayEnd}:00`, 'error');
    }
    patch.minuteOfDay = asMinutes;
  }

  if (!Object.keys(patch).length) return;
  return api('/api/clock', patch).then(() => {
    $('jump').value = '';
    toast('Klok bijgewerkt', 'success');
  });
});

// Space toggles the clock — handy when this page runs on a second screen.
document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.target.matches('input, select, textarea, button')) return;
  event.preventDefault();
  api('/api/clock', { running: !store.clock.running });
});

connect();
