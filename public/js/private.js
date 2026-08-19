// The businessman's private book. No chart on purpose — these prices are read
// out by hand, so they are set in big type with the day's context beside them.

import { arrow, connect, el, money, mountChrome, onState, pct, signClass } from './common.js';
import { setText, syncRows } from './dom.js';

mountChrome('private');

const $ = (id) => document.getElementById(id);

function renderQuotes(s) {
  const privates = s.businesses.filter((b) => b.market === 'private');
  $('quotes-empty').hidden = privates.length > 0;

  syncRows($('quotes'), privates, (b) => b.id,
    (node, b) => {
      node.className = 'quote';
      const refs = {
        sym: el('span', { class: 'sym' }),
        name: el('span', { class: 'name' }),
        price: el('span', {}),
        delta: el('div', { class: 'delta' }),
        open: el('div', { class: 'v' }),
        low: el('div', { class: 'v' }),
        high: el('div', { class: 'v' }),
        held: el('div', { class: 'held' }),
      };
      node.append(
        el('div', { class: 'top' }, [refs.sym, refs.name]),
        el('div', { class: 'price' }, [refs.price, el('span', { class: 'unit', text: 'muntjes' })]),
        refs.delta,
        el('div', { class: 'quote-rows' }, [
          el('div', {}, [el('div', { class: 'k', text: 'Opening' }), refs.open]),
          el('div', {}, [el('div', { class: 'k', text: 'Laagste' }), refs.low]),
          el('div', {}, [el('div', { class: 'k', text: 'Hoogste' }), refs.high]),
        ]),
        refs.held,
      );
      void b;
      return refs;
    },
    (node, c, b) => {
      setText(c.sym, b.symbol);
      setText(c.name, b.name);
      setText(c.price, b.price.toFixed(0));
      const change = b.price - b.dayOpen;
      setText(
        c.delta,
        `${arrow(change)} ${Math.abs(change).toFixed(0)}  ${b.dayOpen ? pct((change / b.dayOpen) * 100) : ''}`,
        `delta ${signClass(change)}`,
      );
      setText(c.open, b.dayOpen.toFixed(0));
      setText(c.low, b.dayLow.toFixed(0));
      setText(c.high, b.dayHigh.toFixed(0));
      const qty = b.position?.qty || 0;
      c.held.hidden = qty === 0;
      if (qty) setText(c.held, `${qty} in bezit · gemiddeld gekocht aan ${money(b.position.avgCost)}`);
    },
    'div');
}

function renderPublic(s) {
  syncRows($('public-body'), s.businesses.filter((b) => b.market === 'public'), (b) => b.id,
    (tr) => {
      const swatch = el('span', { class: 'swatch' });
      const sym = el('span', { class: 'sym' });
      const name = el('span', { class: 'co-name' });
      const cells = { swatch, sym, name, price: el('td', { class: 'num' }), chg: el('td', { class: 'num' }) };
      tr.append(el('td', {}, [swatch, sym, name]), cells.price, cells.chg);
      return cells;
    },
    (tr, c, b) => {
      c.swatch.style.background = b.color;
      setText(c.sym, b.symbol);
      setText(c.name, ` ${b.name}`);
      setText(c.price, b.price.toFixed(0));
      const change = b.price - b.dayOpen;
      setText(c.chg, b.dayOpen ? pct((change / b.dayOpen) * 100) : '–', `num ${signClass(change)}`);
    });
}

onState((s) => {
  setText($('p-clock'), `Dag ${s.clock.day} · ${s.clock.time}`);
  renderQuotes(s);
  renderPublic(s);
});

connect();
