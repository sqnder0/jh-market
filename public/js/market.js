// The wall board. Read only, one screen, no navigation — this is what hangs on
// the projector while the game runs, so it has to survive being left alone for
// two hours and still be legible from the back of the room.

import { arrow, connect, el, gameDuration, onState, pct, signClass, store } from './common.js';
import { createChart } from './chart.js';
import { setText, syncRows } from './dom.js';

const $ = (id) => document.getElementById(id);

const chart = createChart($('chart'), $('tooltip'));
let mode = localStorage.getItem('boardMode') || 'price';

// Last price we drew per listing, so a change can flash the row green or red.
const lastPrice = new Map();
const flashTimers = new Map();

const publicListings = (s) => s.businesses.filter((b) => b.market === 'public');

// --- chart -----------------------------------------------------------------

/** Chrome scales with the viewport so the axes stay readable on a big screen. */
function chartScale() {
  return Math.min(2.2, Math.max(1, window.innerWidth / 1100));
}

function setMode(next) {
  mode = next;
  localStorage.setItem('boardMode', next);
  chart.setMode(next);
  setText($('chart-title'), next === 'price' ? 'Koersen vandaag' : 'Verschil sinds opening');
  setText($('btn-mode'), next === 'price' ? '% weergave' : 'Koersweergave');
  chart.render();
}

/** Stretches of the day, in minute indices, where the exchange is shut. */
function closedRanges(clock) {
  const { dayStart, dayEnd, exchangeOpen, exchangeClose } = clock.schedule;
  const ranges = [];
  if (exchangeOpen > dayStart) ranges.push([0, (exchangeOpen - dayStart) * 60]);
  if (exchangeClose < dayEnd) ranges.push([(exchangeClose - dayStart) * 60, (dayEnd - dayStart) * 60]);
  return ranges;
}

function renderChart(s) {
  chart.setScale(chartScale());
  chart.setDomainMax(s.clock.minutesPerDay);
  chart.setClosedRanges(closedRanges(s.clock));
  chart.setSeries(publicListings(s).map((b) => ({
    id: b.id,
    symbol: b.symbol,
    name: b.name,
    color: b.color,
    values: b.history,
    visible: true,
  })));
  chart.render();
}

// --- header ----------------------------------------------------------------

function renderHead(s) {
  const { sessions } = s.clock;

  setText($('board-day'), `Dag ${s.clock.day}`);
  setText($('board-time'), s.clock.time);

  $('badge-beurs').dataset.open = String(sessions.exchangeOpen);
  setText($('badge-beurs-text'), sessions.exchangeOpen ? 'Beurs open' : 'Beurs dicht');

  $('badge-casino').dataset.open = String(sessions.casinoOpen);
  setText($('badge-casino-text'), sessions.casinoOpen ? 'Casino open' : 'Casino dicht');

  setText($('chart-window'), `handelsuren ${sessions.exchangeLabel}`);

  const shut = !sessions.exchangeOpen;
  $('shut-note').hidden = !shut;
  if (shut) {
    const until = gameDuration(sessions.exchangeChangesIn);
    setText($('shut-detail'), until
      ? `Koersen liggen stil · opent over ${until}`
      : 'Koersen liggen stil tot morgen');
  }
}

// --- quote rows ------------------------------------------------------------

/** Repaint a row for half a second whenever its price moves. */
function flash(node, direction) {
  node.dataset.tick = direction;
  clearTimeout(flashTimers.get(node));
  flashTimers.set(node, setTimeout(() => { delete node.dataset.tick; }, 480));
}

function renderQuotes(s) {
  const listings = publicListings(s);
  $('quotes-empty').hidden = listings.length > 0;

  syncRows($('quotes'), listings, (b) => b.id,
    (node) => {
      node.className = 'quote-row';
      const refs = {
        bar: el('div', { class: 'bar' }),
        sym: el('div', { class: 'sym' }),
        co: el('div', { class: 'co' }),
        px: el('div', { class: 'px' }),
        chg: el('div', { class: 'chg' }),
      };
      node.append(
        refs.bar,
        el('div', { class: 'who' }, [refs.sym, refs.co]),
        el('div', { class: 'nums' }, [refs.px, refs.chg]),
      );
      return refs;
    },
    (node, c, b) => {
      c.bar.style.background = b.color;
      setText(c.sym, b.symbol);
      setText(c.co, b.name);
      setText(c.px, b.price.toFixed(0));

      const change = b.price - b.dayOpen;
      setText(
        c.chg,
        `${arrow(change)} ${Math.abs(change).toFixed(0)}  ${b.dayOpen ? pct((change / b.dayOpen) * 100, 1) : ''}`,
        `chg ${signClass(change)}`,
      );

      const previous = lastPrice.get(b.id);
      if (previous !== undefined && previous !== b.price) {
        flash(node, b.price > previous ? 'up' : 'down');
      }
      lastPrice.set(b.id, b.price);
    },
    'div');
}

// --- ticker tape -----------------------------------------------------------

// The tape is two identical runs translated by -50%, which loops seamlessly.
// It is rebuilt only when the listing set changes; prices are written in place
// so the scroll never jumps.
function buildTape(listings) {
  const track = $('tape-track');
  track.textContent = '';
  if (!listings.length) return;

  for (let copy = 0; copy < 2; copy++) {
    const run = el('div', { class: 'tape-run', 'aria-hidden': copy === 1 ? 'true' : null });
    for (const b of listings) {
      run.append(
        el('span', { class: 'tape-item', 'data-key': b.id }, [
          el('span', { class: 'swatch', style: `background:${b.color}` }),
          el('span', { class: 't-sym', text: b.symbol }),
          el('span', { class: 't-px' }),
          el('span', { class: 't-chg' }),
        ]),
        el('span', { class: 'tape-sep', text: '·' }),
      );
    }
    track.append(run);
  }

  // Hold the scroll speed constant however many listings there are.
  requestAnimationFrame(() => {
    const width = track.scrollWidth / 2;
    const seconds = Math.max(18, width / 55);
    track.style.setProperty('--tape-duration', `${seconds.toFixed(1)}s`);
  });
}

function renderTape(s) {
  const listings = publicListings(s);
  const track = $('tape-track');
  const signature = listings.map((b) => `${b.id}:${b.symbol}`).join(',');
  if (track.dataset.sig !== signature) {
    track.dataset.sig = signature;
    buildTape(listings);
  }

  for (const b of listings) {
    const change = b.price - b.dayOpen;
    const changeText = `${arrow(change)} ${b.dayOpen ? pct((change / b.dayOpen) * 100, 1) : '–'}`;
    for (const item of track.querySelectorAll(`[data-key="${b.id}"]`)) {
      setText(item.querySelector('.t-px'), b.price.toFixed(0));
      setText(item.querySelector('.t-chg'), changeText, `t-chg ${signClass(change)}`);
    }
  }
}

// --- operator controls -----------------------------------------------------

// Nothing is visible until somebody moves the mouse, so the projector shows a
// clean board; the controls fade back out on their own.
let hideControls;
function revealControls() {
  $('controls').dataset.show = 'true';
  clearTimeout(hideControls);
  hideControls = setTimeout(() => { $('controls').dataset.show = 'false'; }, 2500);
}

document.addEventListener('mousemove', revealControls);

$('btn-mode').addEventListener('click', () => setMode(mode === 'price' ? 'percent' : 'price'));

$('btn-full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'f' || event.key === 'F') $('btn-full').click();
  if (event.key === 'p' || event.key === 'P') setMode(mode === 'price' ? 'percent' : 'price');
});

// --- go --------------------------------------------------------------------

setMode(mode);
onState((s) => {
  if (!s.clock) return;
  renderHead(s);
  renderChart(s);
  renderQuotes(s);
  renderTape(s);
});
window.addEventListener('resize', () => chart.setScale(chartScale()));
connect();
