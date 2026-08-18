// The kids' board: chart + prices, read only. No trading happens here — the
// dealer does that on /desk.

import { arrow, connect, el, gameDuration, mountChrome, onState, pct, signClass, store } from './common.js';
import { createChart } from './chart.js';
import { syncRows, setText } from './dom.js';

mountChrome('market');

const $ = (id) => document.getElementById(id);

const chart = createChart($('chart'), $('tooltip'));
const hidden = new Set(JSON.parse(localStorage.getItem('hiddenSeries') || '[]'));
let mode = localStorage.getItem('chartMode') || 'price';

function setMode(next) {
  mode = next;
  localStorage.setItem('chartMode', next);
  chart.setMode(next);
  $('mode-price').setAttribute('aria-pressed', String(next === 'price'));
  $('mode-percent').setAttribute('aria-pressed', String(next === 'percent'));
  $('chart-title').textContent = next === 'price' ? 'Koersen · vandaag' : 'Verschil sinds opening · vandaag';
  chart.render();
}

$('mode-price').addEventListener('click', () => setMode('price'));
$('mode-percent').addEventListener('click', () => setMode('percent'));

const publicListings = (s) => s.businesses.filter((b) => b.market === 'public');

/** Stretches of the day, in minute indices, where the exchange is shut. */
function closedRanges(clock) {
  const { dayStart, dayEnd, exchangeOpen, exchangeClose } = clock.schedule;
  const ranges = [];
  if (exchangeOpen > dayStart) ranges.push([0, (exchangeOpen - dayStart) * 60]);
  if (exchangeClose < dayEnd) ranges.push([(exchangeClose - dayStart) * 60, (dayEnd - dayStart) * 60]);
  return ranges;
}

function renderBanner(s) {
  const { sessions } = s.clock;
  const banner = $('banner');
  banner.dataset.open = String(sessions.exchangeOpen);

  const state = $('banner-state');
  setText(state, sessions.exchangeOpen ? 'BEURS OPEN' : 'BEURS DICHT',
    `state ${sessions.exchangeOpen ? 'open' : 'shut'}`);

  const until = gameDuration(sessions.exchangeChangesIn);
  setText($('banner-detail'), sessions.exchangeOpen
    ? `Handelsuren ${sessions.exchangeLabel}${until ? ` · sluit over ${until}` : ''}`
    : `Handelsuren ${sessions.exchangeLabel}${until ? ` · opent over ${until}` : ' · koersen liggen stil'}`);

  const casinoUntil = gameDuration(sessions.casinoChangesIn);
  setText($('banner-casino'), sessions.casinoOpen
    ? `Casino open (${sessions.casinoLabel})${casinoUntil ? ` · sluit over ${casinoUntil}` : ''}`
    : `Casino ${sessions.casinoLabel}${casinoUntil ? ` · opent over ${casinoUntil}` : ''}`);
}

function renderChart(s) {
  chart.setDomainMax(s.clock.minutesPerDay);
  chart.setClosedRanges(closedRanges(s.clock));
  chart.setSeries(publicListings(s).map((b) => ({
    id: b.id,
    symbol: b.symbol,
    name: b.name,
    color: b.color,
    values: b.history,
    visible: !hidden.has(b.id),
  })));
  chart.render();
}

function toggleSeries(id) {
  if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
  localStorage.setItem('hiddenSeries', JSON.stringify([...hidden]));
  render();
}

function renderLegend(s) {
  const listings = publicListings(s);
  const host = $('legend');
  // A lone series is named by the chart title, so no legend box is needed.
  host.hidden = listings.length < 2;
  syncRows(host, listings, (b) => b.id,
    (node, b) => {
      node.className = 'legend-item';
      node.type = 'button';
      node.addEventListener('click', () => toggleSeries(b.id));
      const swatch = el('span', { class: 'swatch' });
      const sym = el('span', {});
      const val = el('span', { class: 'lg-val' });
      const chg = el('span', {});
      node.append(swatch, sym, val, chg);
      return { swatch, sym, val, chg };
    },
    (node, c, b) => {
      node.dataset.off = String(hidden.has(b.id));
      node.title = `${b.name} — klik om te tonen of te verbergen`;
      c.swatch.style.background = b.color;
      setText(c.sym, b.symbol);
      setText(c.val, b.price.toFixed(2));
      const change = b.price - b.dayOpen;
      setText(c.chg, b.dayOpen ? pct((change / b.dayOpen) * 100, 1) : '–', signClass(change));
    },
    'button');
}

function renderPrices(s) {
  const listings = publicListings(s);
  $('prices-empty').hidden = listings.length > 0;
  syncRows($('prices-body'), listings, (b) => b.id,
    (tr, b) => {
      const swatch = el('span', { class: 'swatch' });
      const sym = el('span', { class: 'sym' });
      const name = el('span', { class: 'co-name' });
      const cells = {
        swatch, sym, name,
        price: el('td', { class: 'num price' }),
        chg: el('td', { class: 'num chg' }),
        chgPct: el('td', { class: 'num chg' }),
        low: el('td', { class: 'num muted' }),
        high: el('td', { class: 'num muted' }),
        open: el('td', { class: 'num muted' }),
      };
      tr.append(
        el('td', {}, [swatch, sym, name]),
        cells.price, cells.chg, cells.chgPct, cells.low, cells.high, cells.open,
      );
      void b;
      return cells;
    },
    (tr, c, b) => {
      c.swatch.style.background = b.color;
      setText(c.sym, b.symbol);
      setText(c.name, ` ${b.name}`);
      const change = b.price - b.dayOpen;
      const cls = signClass(change);
      setText(c.price, b.price.toFixed(2));
      setText(c.chg, `${arrow(change)} ${Math.abs(change).toFixed(2)}`, `num chg ${cls}`);
      setText(c.chgPct, b.dayOpen ? pct((change / b.dayOpen) * 100) : '–', `num chg ${cls}`);
      setText(c.low, b.dayLow.toFixed(2));
      setText(c.high, b.dayHigh.toFixed(2));
      setText(c.open, b.dayOpen.toFixed(2));
    });
}

function render(s = store) {
  if (!s.clock) return;
  renderBanner(s);
  renderChart(s);
  renderLegend(s);
  renderPrices(s);
}

setMode(mode);
onState(render);
connect();
