import { connect, el, gameDuration, mountChrome, onState } from './common.js';
import { setText } from './dom.js';

mountChrome('clock');

const $ = (id) => document.getElementById(id);

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

  renderTicks(schedule);
  placeWindow($('win-exchange'), schedule, schedule.exchangeOpen, schedule.exchangeClose);
  placeWindow($('win-casino'), schedule, schedule.casinoOpen, schedule.casinoClose);

  const progress = c.minuteOfDay / c.minutesPerDay;
  for (const id of ['elapsed-a', 'elapsed-b']) $(id).style.width = `${progress * 100}%`;
  for (const id of ['head-a', 'head-b']) $(id).style.left = `calc(${progress * 100}% - 1px)`;
});

connect();
