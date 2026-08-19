import { api, connect, durationText, el, money, mountChrome, onState, pct, signClass, store, toast } from './common.js';
import { setText } from './dom.js';

mountChrome('admin');

const $ = (id) => document.getElementById(id);

// Per-minute rates are stored as decimals but edited as percentages.
const toPct = (v) => (v * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
const fromPct = (v) => Number(v) / 100;

const speedFromHourMinutes = (minutes) => 1 / minutes;

// --- clock ------------------------------------------------------------------

$('btn-play').addEventListener('click', () => api('/api/clock', { running: true }));
$('btn-pause').addEventListener('click', () => api('/api/clock', { running: false }));
$('btn-stop').addEventListener('click', () =>
  api('/api/clock', { running: false, minuteOfDay: 0 }).then(() => toast('Klok teruggezet naar het begin van de dag', 'success')));
$('btn-skip').addEventListener('click', () => api('/api/clock/skip-day').then(() => toast('Nieuwe speldag', 'success')));

$('btn-reset').addEventListener('click', (event) => {
  const btn = event.currentTarget;
  if (btn.dataset.armed !== 'true') {
    btn.dataset.armed = 'true';
    btn.textContent = 'Zeker weten? Klik nog eens';
    setTimeout(() => {
      btn.dataset.armed = 'false';
      btn.textContent = '↺ Spel herstarten';
    }, 4000);
    return;
  }
  btn.dataset.armed = 'false';
  btn.textContent = '↺ Spel herstarten';
  api('/api/market/reset').then(() => toast('Spel herstart', 'success'));
});

$('preset').addEventListener('click', (event) => {
  const btn = event.target.closest('button');
  if (btn) api('/api/clock', { speed: speedFromHourMinutes(Number(btn.dataset.min)) });
});

$('btn-clock-apply').addEventListener('click', () => {
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

// --- schedule ---------------------------------------------------------------

const HOUR_FIELDS = {
  dayStart: 'h-daystart',
  dayEnd: 'h-dayend',
  exchangeOpen: 'h-exopen',
  exchangeClose: 'h-exclose',
  casinoOpen: 'h-casopen',
  casinoClose: 'h-casclose',
};

function submitSchedule(values) {
  return api('/api/schedule', values).then(() => toast('Dagindeling opgeslagen', 'success'));
}

$('btn-schedule').addEventListener('click', () => {
  const patch = {};
  for (const [key, id] of Object.entries(HOUR_FIELDS)) patch[key] = Number($(id).value);
  submitSchedule(patch);
});

$('btn-schedule-default').addEventListener('click', () => submitSchedule({
  dayStart: 9, dayEnd: 19, exchangeOpen: 9, exchangeClose: 17, casinoOpen: 15, casinoClose: 19,
}));

// --- dealer settings --------------------------------------------------------

$('btn-reset-portfolio').addEventListener('click', () => {
  api('/api/portfolio/reset', { cash: Number($('cash').value) }).then(() => toast('Boek gereset', 'success'));
});

$('btn-fee').addEventListener('click', () => {
  api('/api/settings', { feePct: Number($('fee').value) }).then(() => toast('Kosten opgeslagen', 'success'));
});

$('enforce').addEventListener('change', (event) => {
  api('/api/settings', { enforceExchangeHours: event.target.checked });
});

// --- add business -----------------------------------------------------------

$('btn-add').addEventListener('click', async () => {
  const name = $('n-name').value.trim();
  if (!name) return toast('Geef het bedrijf een naam', 'error');
  await api('/api/business/create', {
    name,
    symbol: $('n-symbol').value.trim() || name.slice(0, 3),
    market: $('n-market').value,
    price: Number($('n-price').value),
    volatility: fromPct($('n-vol').value),
    drift: fromPct($('n-drift').value),
    meanReversion: fromPct($('n-mr').value),
  });
  $('n-name').value = '';
  $('n-symbol').value = '';
  toast(`${name} toegevoegd`, 'success');
});

// --- business cards ---------------------------------------------------------

/** Cards are rebuilt only when the listing set changes, so typing is never clobbered. */
const cards = new Map();

function buildCard(b, palette) {
  const refs = {};

  refs.swatch = el('span', { class: 'swatch', style: `background:${b.color}` });
  refs.sym = el('span', { class: 'sym', text: b.symbol });
  refs.name = el('span', { class: 'co-name', text: b.name });
  refs.tag = el('span', { class: 'tag' });
  refs.price = el('span', { class: 'p num' });
  refs.change = el('span', { class: 'num' });

  const head = el('div', { class: 'biz-head' }, [
    refs.swatch, refs.sym, refs.name, refs.tag,
    el('span', { class: 'live' }, [refs.change, refs.price]),
  ]);

  // -- listing column
  refs.inName = el('input', { type: 'text', value: b.name });
  refs.inSymbol = el('input', { type: 'text', value: b.symbol, maxlength: '6' });
  refs.inMarket = el('select', {}, [
    el('option', { value: 'public', text: 'Beurs (op het bord)' }),
    el('option', { value: 'private', text: 'Privé (zakenman)' }),
  ]);
  refs.inMarket.value = b.market;
  refs.inPrice = el('input', { type: 'number', step: '1', min: '1', placeholder: 'leeg = ongewijzigd' });
  refs.inAnchor = el('input', { type: 'number', step: '1', min: '1', value: b.anchor.toFixed(0) });

  refs.swatches = el('div', { class: 'swatches' }, palette.map((hex, i) => el('button', {
    type: 'button',
    style: `background:${hex}`,
    'aria-pressed': String(i === b.colorIndex),
    title: `Kleur ${i + 1}`,
    onclick: () => api('/api/business/update', { id: b.id, colorIndex: i }),
  })));

  const listing = el('div', {}, [
    el('div', { class: 'sub-head', text: 'Notering' }),
    el('div', { class: 'field' }, [el('label', { text: 'Naam' }), refs.inName]),
    el('div', { class: 'field-row', style: 'margin-bottom:10px' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Code' }), refs.inSymbol]),
      el('div', { class: 'field' }, [el('label', { text: 'Koers zetten op' }), refs.inPrice]),
    ]),
    el('div', { class: 'field' }, [el('label', { text: 'Markt' }), refs.inMarket]),
    el('div', { class: 'field' }, [el('label', { text: 'Richtprijs (zwaartekracht trekt hierheen)' }), refs.inAnchor]),
    el('div', { class: 'field' }, [el('label', { text: 'Kleur op de grafiek' }), refs.swatches]),
  ]);

  // -- behaviour column
  refs.inVol = el('input', { type: 'number', step: '0.05', min: '0', max: '20', value: toPct(b.volatility) });
  refs.inDrift = el('input', { type: 'number', step: '0.001', min: '-1', max: '1', value: toPct(b.drift) });
  refs.inMr = el('input', { type: 'number', step: '0.01', min: '0', max: '20', value: toPct(b.meanReversion) });

  const save = el('button', {
    class: 'primary',
    text: 'Opslaan',
    onclick: async () => {
      const patch = {
        id: b.id,
        name: refs.inName.value.trim() || b.name,
        symbol: refs.inSymbol.value.trim() || b.symbol,
        market: refs.inMarket.value,
        anchor: Number(refs.inAnchor.value),
        volatility: fromPct(refs.inVol.value),
        drift: fromPct(refs.inDrift.value),
        meanReversion: fromPct(refs.inMr.value),
      };
      const priceOverride = Number.parseFloat(refs.inPrice.value);
      if (Number.isFinite(priceOverride) && priceOverride > 0) patch.price = priceOverride;
      await api('/api/business/update', patch);
      refs.inPrice.value = '';
      toast(`${patch.symbol} bijgewerkt`, 'success');
    },
  });

  refs.deleteBtn = el('button', {
    class: 'danger',
    text: 'Verwijderen',
    onclick: (event) => {
      const btn = event.currentTarget;
      if (btn.dataset.armed !== 'true') {
        btn.dataset.armed = 'true';
        btn.textContent = 'Zeker weten?';
        setTimeout(() => { btn.dataset.armed = 'false'; btn.textContent = 'Verwijderen'; }, 4000);
        return;
      }
      api('/api/business/delete', { id: b.id }).then(() => toast(`${b.symbol} geschrapt`, 'success'));
    },
  });

  const behaviour = el('div', {}, [
    el('div', { class: 'sub-head', text: 'Gedrag (per speelminuut)' }),
    el('div', { class: 'field' }, [el('label', { text: 'Beweeglijkheid %' }), refs.inVol]),
    el('div', { class: 'field' }, [el('label', { text: 'Trend %' }), refs.inDrift]),
    el('div', { class: 'field' }, [el('label', { text: 'Zwaartekracht %' }), refs.inMr]),
    el('div', { class: 'btn-row', style: 'margin-top:12px' }, [save, refs.deleteBtn]),
  ]);

  // -- pump column
  refs.pumpPct = el('input', { type: 'number', step: '0.5', value: '10' });
  refs.pumpMins = el('input', { type: 'number', step: '5', min: '0', value: '30' });
  refs.pumpPermanent = el('input', { type: 'checkbox', id: `perm-${b.id}`, checked: 'checked' });

  const quick = el('div', { class: 'pump-quick' }, [-10, -5, -1, 1, 5, 10].map((p) => el('button', {
    type: 'button',
    'data-dir': p > 0 ? 'up' : 'down',
    text: `${p > 0 ? '+' : ''}${p}%`,
    title: `${b.symbol} meteen ${p > 0 ? 'omhoog' : 'omlaag'} met ${Math.abs(p)}%`,
    onclick: () => api('/api/pump', { id: b.id, percent: p, minutes: 0, permanent: true }),
  })));

  const applyPump = el('button', {
    class: 'primary',
    text: 'Campagne starten',
    onclick: () => api('/api/pump', {
      id: b.id,
      percent: Number(refs.pumpPct.value),
      minutes: Number(refs.pumpMins.value),
      permanent: refs.pumpPermanent.checked,
    }).then(() => toast(`${b.symbol}: ${refs.pumpPct.value}% over ${refs.pumpMins.value} min`, 'success')),
  });

  refs.pumpText = el('span', {});
  refs.pumpBanner = el('div', { class: 'pump-active' }, [
    refs.pumpText,
    el('button', { class: 'sm ghost', text: 'Stop', onclick: () => api('/api/pump/clear', { id: b.id }) }),
  ]);
  refs.pumpBanner.hidden = true;

  const pumpCol = el('div', {}, [
    el('div', { class: 'sub-head', text: 'Koers duwen' }),
    quick,
    el('div', { class: 'field-row', style: 'margin-bottom:10px' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Met % ' }), refs.pumpPct]),
      el('div', { class: 'field' }, [el('label', { text: 'Over speelminuten' }), refs.pumpMins]),
    ]),
    el('div', { class: 'check', style: 'margin-bottom:10px' }, [
      refs.pumpPermanent,
      el('label', { for: `perm-${b.id}`, text: 'Blijvend — verzet ook de richtprijs' }),
    ]),
    applyPump,
    refs.pumpBanner,
  ]);

  const card = el('div', { class: 'biz' }, [head, el('div', { class: 'biz-body' }, [listing, behaviour, pumpCol])]);
  return { card, refs };
}

function renderBusinesses(s) {
  const host = $('biz-list');
  const signature = s.businesses.map((b) => b.id).join(',');
  const publics = s.businesses.filter((b) => b.market === 'public').length;
  setText($('biz-count'), `${publics} op de beurs · ${s.businesses.length - publics} privé`);
  $('biz-empty').hidden = s.businesses.length > 0;

  if (host.dataset.sig !== signature) {
    host.dataset.sig = signature;
    host.textContent = '';
    cards.clear();
    for (const b of s.businesses) {
      const entry = buildCard(b, s.palette);
      cards.set(b.id, entry);
      host.appendChild(entry.card);
    }
  }

  for (const b of s.businesses) {
    const entry = cards.get(b.id);
    if (!entry) continue;
    const { refs, card } = entry;
    card.dataset.market = b.market;
    const change = b.price - b.dayOpen;
    refs.swatch.style.background = b.color;
    refs.tag.dataset.market = b.market;
    setText(refs.tag, b.market === 'private' ? 'privé' : 'beurs', 'tag');
    setText(refs.price, money(b.price), 'p num');
    setText(refs.change, b.dayOpen ? pct((change / b.dayOpen) * 100) : '–', `num ${signClass(change)}`);
    for (const [i, btn] of [...refs.swatches.children].entries()) {
      btn.setAttribute('aria-pressed', String(i === b.colorIndex));
    }
    refs.pumpBanner.hidden = !b.pump;
    if (b.pump) {
      setText(refs.pumpText,
        `Campagne loopt: ${b.pump.percent > 0 ? '+' : ''}${b.pump.percent}% over ` +
        `${b.pump.totalMinutes} min · nog ${b.pump.remaining} min`);
    }
  }
}

// --- top-level state --------------------------------------------------------

onState((s) => {
  const c = s.clock;
  setText($('clock-read'), `Dag ${c.day} · ${c.time}`);
  $('btn-play').disabled = c.running;
  $('btn-pause').disabled = !c.running;
  setText($('speed-hint'),
    `Eén speluur duurt ${durationText(c.realSecondsPerGameHour)} · een hele speldag ${durationText(c.realSecondsPerDay)}` +
    ` · beurs ${c.sessions.exchangeOpen ? 'open' : 'dicht'}, casino ${c.sessions.casinoOpen ? 'open' : 'dicht'}`);

  const perHour = c.realSecondsPerGameHour / 60;
  if (document.activeElement !== $('hourlen')) $('hourlen').value = perHour.toFixed(2).replace(/\.?0+$/, '');
  for (const btn of document.querySelectorAll('#preset button')) {
    btn.setAttribute('aria-pressed', String(Math.abs(Number(btn.dataset.min) - perHour) < 0.01));
  }

  for (const [key, id] of Object.entries(HOUR_FIELDS)) {
    if (document.activeElement !== $(id)) $(id).value = String(c.schedule[key]);
  }

  if (document.activeElement !== $('cash')) $('cash').value = String(s.portfolio.startingCash);
  if (document.activeElement !== $('fee')) $('fee').value = String(s.settings.feePct);
  $('enforce').checked = Boolean(s.settings.enforceExchangeHours);

  setText($('player-hint'),
    `Boek ${money(s.portfolio.equity)} muntjes · kas ${money(s.portfolio.cash)} · ` +
    `${s.portfolio.positions.length} positie${s.portfolio.positions.length === 1 ? '' : 's'}`);

  renderBusinesses(s);
});

connect();
