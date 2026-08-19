// The dealer's terminal: every listing (public and private), the trade ticket
// and the book. Kids never see this screen.

import {
  api, arrow, connect, el, money, mountChrome, onState, pct, signClass, store, toast,
} from './common.js';
import { setText, syncRows } from './dom.js';

mountChrome('desk');

const $ = (id) => document.getElementById(id);

let selectedId = localStorage.getItem('deskBusiness') || null;

const currentBusiness = () =>
  store.businesses.find((b) => b.id === selectedId) || store.businesses[0] || null;

/** Is this listing tradeable right now? */
function tradability(s, b) {
  if (!b) return { ok: false, reason: 'Geen bedrijf gekozen' };
  if (b.market === 'private') return { ok: true };
  if (!s.settings.enforceExchangeHours) return { ok: true };
  if (s.clock.sessions.exchangeOpen) return { ok: true };
  return { ok: false, reason: `De beurs is dicht — handelsuren ${s.clock.sessions.exchangeLabel}.` };
}

function selectBusiness(id) {
  selectedId = id;
  localStorage.setItem('deskBusiness', id);
  render(store);
}

// --- tables ----------------------------------------------------------------

function renderPrices(s) {
  $('prices-empty').hidden = s.businesses.length > 0;
  syncRows($('prices-body'), s.businesses, (b) => b.id,
    (tr, b) => {
      tr.className = 'selectable';
      tr.addEventListener('click', () => selectBusiness(b.id));
      const swatch = el('span', { class: 'swatch' });
      const sym = el('span', { class: 'sym' });
      const name = el('span', { class: 'co-name' });
      const tag = el('span', { class: 'tag' });
      const cells = {
        swatch, sym, name, tag,
        price: el('td', { class: 'num' }),
        chg: el('td', { class: 'num' }),
        chgPct: el('td', { class: 'num' }),
        low: el('td', { class: 'num muted' }),
        high: el('td', { class: 'num muted' }),
        pos: el('td', { class: 'num' }),
      };
      tr.append(
        el('td', {}, [swatch, sym, name, tag]),
        cells.price, cells.chg, cells.chgPct, cells.low, cells.high, cells.pos,
      );
      void b;
      return cells;
    },
    (tr, c, b) => {
      tr.setAttribute('aria-selected', String(b.id === selectedId));
      c.swatch.style.background = b.color;
      setText(c.sym, b.symbol);
      setText(c.name, ` ${b.name}`);
      c.tag.dataset.market = b.market;
      setText(c.tag, b.market === 'private' ? 'privé' : 'beurs');
      const change = b.price - b.dayOpen;
      const cls = signClass(change);
      setText(c.price, b.price.toFixed(0));
      setText(c.chg, `${arrow(change)} ${Math.abs(change).toFixed(0)}`, `num ${cls}`);
      setText(c.chgPct, b.dayOpen ? pct((change / b.dayOpen) * 100) : '–', `num ${cls}`);
      setText(c.low, b.dayLow.toFixed(0));
      setText(c.high, b.dayHigh.toFixed(0));
      setText(c.pos, b.position ? String(b.position.qty) : '–');
    });
}

function renderBook(s) {
  const p = s.portfolio;
  const totalPL = p.equity - p.startingCash;

  setText($('s-equity'), money(p.equity), `value num ${signClass(totalPL)}`);
  setText($('s-equity-sub'), `${pct(p.totalPct)} tegenover ${money(p.startingCash)} start`, `sub ${signClass(totalPL)}`);
  setText($('s-cash'), money(p.cash));
  setText($('s-invested'), money(p.invested));
  setText($('s-invested-sub'), `${p.positions.length} positie${p.positions.length === 1 ? '' : 's'}`);
  setText($('s-unreal'), money(p.unrealized), `value num ${signClass(p.unrealized)}`);
  setText($('s-real-sub'), `${money(p.realized)} gerealiseerd`, `sub ${signClass(p.realized)}`);

  $('holdings-empty').hidden = p.positions.length > 0;
  syncRows($('holdings-body'), p.positions, (pos) => pos.id,
    (tr, pos) => {
      tr.className = 'selectable';
      tr.addEventListener('click', () => selectBusiness(pos.id));
      const swatch = el('span', { class: 'swatch' });
      const sym = el('span', { class: 'sym' });
      const cells = {
        swatch, sym,
        qty: el('td', { class: 'num' }),
        avg: el('td', { class: 'num muted' }),
        last: el('td', { class: 'num' }),
        pl: el('td', { class: 'num' }),
      };
      tr.append(el('td', {}, [swatch, sym]), cells.qty, cells.avg, cells.last, cells.pl);
      return cells;
    },
    (tr, c, pos) => {
      c.swatch.style.background = pos.color;
      setText(c.sym, pos.symbol);
      setText(c.qty, String(pos.qty));
      setText(c.avg, pos.avgCost.toFixed(0));
      setText(c.last, pos.price.toFixed(0));
      setText(c.pl, `${money(pos.unrealized)} (${pct(pos.unrealizedPct, 1)})`, `num ${signClass(pos.unrealized)}`);
    });

  // Trades only change on a fill, so rebuild them behind a cheap signature.
  const signature = `${p.trades.length}:${p.trades[0]?.t || 0}`;
  const body = $('trades-body');
  $('trades-empty').hidden = p.trades.length > 0;
  if (body.dataset.sig !== signature) {
    body.dataset.sig = signature;
    body.textContent = '';
    const label = { buy: 'KOOP', sell: 'VERKOOP', liquidate: 'AFGESLOTEN' };
    for (const t of p.trades) {
      body.appendChild(el('tr', {}, [
        el('td', { class: 'muted', text: `D${t.day} ${t.time}` }),
        el('td', {}, [el('span', {
          class: t.side === 'buy' ? 'up' : 'down',
          text: `${label[t.side] || t.side} ${t.symbol}`,
        })]),
        el('td', { class: 'num', text: String(t.qty) }),
        el('td', { class: 'num', text: t.price.toFixed(0) }),
      ]));
    }
  }
}

// --- ticket ----------------------------------------------------------------

function renderTicket(s) {
  const select = $('t-business');
  const wanted = s.businesses.map((b) => `${b.id}:${b.symbol}:${b.market}`).join(',');
  if (select.dataset.ids !== wanted) {
    select.dataset.ids = wanted;
    select.textContent = '';
    for (const b of s.businesses) {
      select.appendChild(el('option', {
        value: b.id,
        text: `${b.symbol} · ${b.name}${b.market === 'private' ? ' (privé)' : ''}`,
      }));
    }
  }

  const b = currentBusiness();
  if (!b) {
    for (const id of ['t-price', 't-change', 't-cost', 't-after']) setText($(id), '–');
    $('btn-buy').disabled = true;
    $('btn-sell').disabled = true;
    setText($('t-hint'), 'Voeg eerst een bedrijf toe op de adminpagina.');
    $('t-closed').hidden = true;
    return;
  }
  selectedId = b.id;
  if (select.value !== b.id) select.value = b.id;

  const change = b.price - b.dayOpen;
  setText($('t-price'), money(b.price));
  setText(
    $('t-change'),
    `${arrow(change)} ${money(Math.abs(change))} ${b.dayOpen ? pct((change / b.dayOpen) * 100) : ''}`,
    `num ${signClass(change)}`,
  );

  const qty = Math.max(0, Math.floor(Number($('t-qty').value) || 0));
  const unit = b.price * (1 + s.settings.feePct / 100);
  const cost = qty * unit;
  setText($('t-cost'), money(cost));
  const after = s.portfolio.cash - cost;
  setText($('t-after'), money(after), after < 0 ? 'down' : '');

  const open = tradability(s, b);
  $('t-closed').hidden = open.ok;
  if (!open.ok) setText($('t-closed'), open.reason);

  const held = b.position?.qty || 0;
  $('btn-buy').disabled = !open.ok || qty <= 0 || cost > s.portfolio.cash;
  $('btn-sell').disabled = !open.ok || qty <= 0 || qty > held;
  setText($('t-hint'),
    `${held} in bezit · genoeg kas voor ${Math.floor(s.portfolio.cash / unit)}` +
    (s.settings.feePct ? ` · ${s.settings.feePct}% kosten` : ''));
}

function render(s = store) {
  if (!s.clock) return;
  renderPrices(s);
  renderBook(s);
  renderTicket(s);
}

// --- interaction ------------------------------------------------------------

$('t-business').addEventListener('change', (event) => selectBusiness(event.target.value));
$('t-qty').addEventListener('input', () => renderTicket(store));

document.querySelector('.qty-row').addEventListener('click', (event) => {
  const btn = event.target.closest('button');
  if (!btn) return;
  const b = currentBusiness();
  if (!b) return;
  if (btn.dataset.qty) {
    $('t-qty').value = btn.dataset.qty;
  } else {
    const unit = b.price * (1 + store.settings.feePct / 100);
    $('t-qty').value = String(Math.max(1, Math.floor((store.portfolio.cash * Number(btn.dataset.fraction)) / unit)));
  }
  renderTicket(store);
});

async function submit(side) {
  const b = currentBusiness();
  const qty = Math.floor(Number($('t-qty').value) || 0);
  if (!b || qty <= 0) return;
  const price = b.price;
  await api('/api/trade', { id: b.id, side, qty });
  toast(`${side === 'buy' ? 'Gekocht' : 'Verkocht'}: ${qty} ${b.symbol} rond ${money(price)}`, 'success');
}

$('btn-buy').addEventListener('click', () => submit('buy'));
$('btn-sell').addEventListener('click', () => submit('sell'));

onState(render);
connect();
