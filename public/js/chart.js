// Canvas line chart for the trading day: fixed 09:00-24:00 x-domain that fills
// in as the day runs, auto-scaled y, crosshair + tooltip, right-edge labels.

import { minuteLabel } from './common.js';

const INK = {
  grid: '#2c2c2a',
  axis: '#383835',
  muted: '#898781',
  text: '#ffffff',
  secondary: '#c3c2b7',
  surface: '#1a1a19',
  chip: '#2a2927',
};

const PAD = { top: 14, right: 78, bottom: 26, left: 8 };
const Y_LABEL_W = 56;
const MAX_DIRECT_LABELS = 4;

function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) * 0.01 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 0.001; t += step) {
    ticks.push(Math.round(t / step) * step);
  }
  return ticks.length >= 2 ? ticks : [min, max];
}

export function createChart(canvas, tooltipEl) {
  const ctx = canvas.getContext('2d');
  let series = [];
  let domainMax = 600;
  let mode = 'price';
  let closedRanges = []; // [[fromIndex, toIndex], ...] — exchange shut
  let hoverIndex = null;
  let box = { w: 0, h: 0 };

  function value(s, i) {
    const v = s.values[i];
    if (v === undefined) return undefined;
    if (mode === 'percent') {
      const base = s.values[0];
      return base ? ((v - base) / base) * 100 : 0;
    }
    return v;
  }

  function fmt(v) {
    if (mode === 'percent') return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
    return v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(2);
  }

  function plot() {
    return {
      x0: PAD.left,
      x1: box.w - PAD.right,
      y0: PAD.top,
      y1: box.h - PAD.bottom,
    };
  }

  function yDomain(visible) {
    let min = Infinity;
    let max = -Infinity;
    for (const s of visible) {
      for (let i = 0; i < s.values.length; i++) {
        const v = value(s, i);
        if (v === undefined) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min)) return { min: 0, max: 1 };
    if (min === max) {
      const pad = Math.abs(min) * 0.02 || 1;
      return { min: min - pad, max: max + pad };
    }
    const pad = (max - min) * 0.08;
    // A price axis must never dip below zero; a percent axis may.
    const floor = mode === 'price' ? 0 : -Infinity;
    return { min: Math.max(floor, min - pad), max: max + pad };
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    box = { w: rect.width, h: rect.height };
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function render() {
    if (box.w === 0) resize();
    const { x0, x1, y0, y1 } = plot();
    const innerW = x1 - x0 - Y_LABEL_W;
    const px0 = x0 + Y_LABEL_W;
    ctx.clearRect(0, 0, box.w, box.h);
    if (innerW <= 0 || y1 <= y0) return;

    const visible = series.filter((s) => s.visible && s.values.length);
    const { min: lo, max: hi } = yDomain(visible);
    // Ticks are clipped to the data range rather than extending it, so a
    // low-priced series never drags the whole scale down to zero.
    const ticks = niceTicks(lo, hi, 5).filter((t) => t >= lo && t <= hi);

    const xAt = (i) => px0 + (i / domainMax) * innerW;
    const yAt = (v) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);

    // shade the stretches where the exchange is shut, before anything else
    for (const [from, to] of closedRanges) {
      const a = xAt(Math.max(0, from));
      const b = xAt(Math.min(domainMax, to));
      if (b <= a) continue;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
      ctx.fillRect(a, y0, b - a, y1 - y0);
      if (b - a > 54) {
        ctx.fillStyle = INK.muted;
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('beurs dicht', (a + b) / 2, y0 + 4);
      }
    }

    // horizontal grid + y labels
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (const t of ticks) {
      const y = Math.round(yAt(t)) + 0.5;
      if (y < y0 - 1 || y > y1 + 1) continue;
      ctx.strokeStyle = INK.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.fillStyle = INK.muted;
      ctx.textAlign = 'right';
      ctx.fillText(fmt(t), px0 - 8, y);
    }

    // zero reference line in percent mode
    if (mode === 'percent' && lo < 0 && hi > 0) {
      const y = Math.round(yAt(0)) + 0.5;
      ctx.strokeStyle = INK.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
    }

    // hour gridlines + x labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const hourStep = innerW < 480 ? 180 : 60;
    for (let m = 0; m <= domainMax; m += hourStep) {
      const x = Math.round(xAt(m)) + 0.5;
      ctx.strokeStyle = INK.grid;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
      ctx.fillStyle = INK.muted;
      ctx.fillText(minuteLabel(m), x, y1 + 7);
    }

    // baseline
    ctx.strokeStyle = INK.axis;
    ctx.beginPath();
    ctx.moveTo(px0, Math.round(y1) + 0.5);
    ctx.lineTo(x1, Math.round(y1) + 0.5);
    ctx.stroke();

    // series lines
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of visible) {
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < s.values.length; i++) {
        const v = value(s, i);
        if (v === undefined) continue;
        const x = xAt(i);
        const y = yAt(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // last-point markers, ringed against the surface so overlaps stay readable
    const ends = [];
    for (const s of visible) {
      const i = s.values.length - 1;
      const v = value(s, i);
      if (v === undefined) continue;
      const x = xAt(i);
      const y = yAt(v);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = INK.surface;
      ctx.stroke();
      ends.push({ s, x, y, v });
    }

    // direct labels at the right edge, nudged apart so they never collide
    if (ends.length && ends.length <= MAX_DIRECT_LABELS) {
      ends.sort((a, b) => a.y - b.y);
      const gap = 17;
      for (let i = 1; i < ends.length; i++) {
        if (ends[i].y - ends[i - 1].y < gap) ends[i].y = ends[i - 1].y + gap;
      }
      const overflow = ends[ends.length - 1].y - y1;
      if (overflow > 0) for (const e of ends) e.y -= overflow;

      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'middle';
      for (const e of ends) {
        const label = `${e.s.symbol} ${fmt(e.v)}`;
        const w = Math.min(ctx.measureText(label).width + 14, PAD.right - 6);
        const x = x1 + 4;
        const y = Math.round(e.y);
        ctx.fillStyle = INK.chip;
        ctx.beginPath();
        ctx.roundRect(x, y - 8, w, 16, 4);
        ctx.fill();
        ctx.fillStyle = e.s.color;
        ctx.beginPath();
        ctx.roundRect(x, y - 8, 3, 16, [4, 0, 0, 4]);
        ctx.fill();
        ctx.fillStyle = INK.text;
        ctx.textAlign = 'left';
        ctx.fillText(label, x + 7, y + 0.5);
      }
    }

    // crosshair
    if (hoverIndex !== null && visible.length) {
      const x = Math.round(xAt(hoverIndex)) + 0.5;
      ctx.strokeStyle = INK.axis;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const s of visible) {
        const v = value(s, hoverIndex);
        if (v === undefined) continue;
        ctx.beginPath();
        ctx.arc(x, yAt(v), 4, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = INK.surface;
        ctx.stroke();
      }
    }
  }

  function showTooltip(clientX) {
    if (!tooltipEl) return;
    const visible = series.filter((s) => s.visible && s.values.length);
    if (hoverIndex === null || !visible.length) {
      tooltipEl.dataset.show = 'false';
      return;
    }
    const rows = visible
      .map((s) => ({ s, v: value(s, hoverIndex) }))
      .filter((r) => r.v !== undefined)
      .sort((a, b) => b.v - a.v);
    tooltipEl.innerHTML =
      `<div class="tt-time">${minuteLabel(hoverIndex)}</div>` +
      rows.map((r) =>
        `<div class="tt-row"><span class="swatch" style="background:${r.s.color}"></span>` +
        `<span class="secondary">${r.s.symbol}</span>` +
        `<span class="tt-val">${fmt(r.v)}</span></div>`).join('');
    tooltipEl.dataset.show = 'true';

    const rect = canvas.getBoundingClientRect();
    const w = tooltipEl.offsetWidth;
    let left = clientX - rect.left + 14;
    if (left + w > rect.width) left = clientX - rect.left - w - 14;
    tooltipEl.style.left = `${Math.max(0, left)}px`;
    tooltipEl.style.top = `${PAD.top}px`;
  }

  function pointerMove(event) {
    const rect = canvas.getBoundingClientRect();
    const { x1 } = plot();
    const px0 = PAD.left + Y_LABEL_W;
    const innerW = x1 - px0;
    const maxIndex = Math.max(0, ...series.map((s) => s.values.length - 1));
    const rel = (event.clientX - rect.left - px0) / innerW;
    const idx = Math.round(rel * domainMax);
    hoverIndex = Math.max(0, Math.min(maxIndex, idx));
    render();
    showTooltip(event.clientX);
  }

  function pointerLeave() {
    hoverIndex = null;
    if (tooltipEl) tooltipEl.dataset.show = 'false';
    render();
  }

  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerleave', pointerLeave);

  const ro = new ResizeObserver(() => { resize(); render(); });
  ro.observe(canvas);

  return {
    setSeries(next) { series = next; },
    setClosedRanges(next) { closedRanges = next; },
    setMode(next) { mode = next; },
    setDomainMax(next) { domainMax = next; },
    render,
    destroy() { ro.disconnect(); },
  };
}

/** Minimal filled sparkline — used for the equity curve. */
export function drawSparkline(canvas, values, color = '#3987e5') {
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!values || values.length < 2 || rect.width === 0) return;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.abs(max) * 0.01 || 1;
  const pad = 4;
  const h = rect.height - pad * 2;
  const xAt = (i) => (i / (values.length - 1)) * rect.width;
  const yAt = (v) => pad + h - ((v - min) / span) * h;

  ctx.beginPath();
  ctx.moveTo(xAt(0), yAt(values[0]));
  for (let i = 1; i < values.length; i++) ctx.lineTo(xAt(i), yAt(values[i]));

  const fill = ctx.createLinearGradient(0, 0, 0, rect.height);
  fill.addColorStop(0, `${color}44`);
  fill.addColorStop(1, `${color}00`);
  ctx.save();
  ctx.lineTo(rect.width, rect.height);
  ctx.lineTo(0, rect.height);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(xAt(0), yAt(values[0]));
  for (let i = 1; i < values.length; i++) ctx.lineTo(xAt(i), yAt(values[i]));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();
}
