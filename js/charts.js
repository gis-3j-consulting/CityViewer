// Small chart renderers. Each returns an HTML string. Colors come from CSS variables.

import { quantile } from './stats.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/* Horizontal bars: items = [{label, value}] where value is a percent */
export function barRows(items, { format = (v) => v.toFixed(0) + '%' } = {}) {
  const valid = items.filter((i) => Number.isFinite(i.value));
  if (!valid.length) return '<p class="empty">No data for this city.</p>';
  const max = Math.max(...valid.map((i) => i.value), 1);
  return `<div class="bars">${items
    .map((i) => {
      const ok = Number.isFinite(i.value);
      const w = ok ? Math.max(1.5, (i.value / max) * 100) : 0;
      return `<div class="bar-row">
        <span class="bar-label">${esc(i.label)}</span>
        <span class="bar-track"><span class="bar-fill" data-w="${w.toFixed(1)}"></span></span>
        <span class="bar-val">${ok ? format(i.value) : '—'}</span>
      </div>`;
    })
    .join('')}</div>`;
}

/* Population over time. series = [{year, value}] */
export function lineChart(series) {
  const W = 340, H = 170, L = 8, R = 8, T = 26, B = 28;
  const xs = series.map((p) => p.year);
  const ys = series.map((p) => p.value);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const padY = (y1 - y0) * 0.18 || y1 * 0.05 || 1;
  y0 = Math.max(0, y0 - padY);
  y1 = y1 + padY;
  const X = (x) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R);
  const Y = (y) => T + (1 - (y - y0) / (y1 - y0 || 1)) * (H - T - B);
  const pts = series.map((p) => [X(p.year), Y(p.value)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${H - B} L${pts[0][0].toFixed(1)} ${H - B} Z`;
  const first = series[0], last = series[series.length - 1];
  const f = (n) => Math.round(n).toLocaleString('en-US');
  const anchorLast = pts[pts.length - 1][0] > W - 60 ? 'end' : 'middle';
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Population from ${first.year} to ${last.year}: ${f(first.value)} to ${f(last.value)}">
    <line class="axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/>
    <path class="area" d="${area}"/>
    <path class="line" d="${line}"/>
    ${pts.map((p) => `<circle class="dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3"/>`).join('')}
    <text class="lbl" x="${pts[0][0].toFixed(1)}" y="${(pts[0][1] - 9).toFixed(1)}" text-anchor="start">${f(first.value)}</text>
    <text class="lbl strong" x="${pts[pts.length - 1][0].toFixed(1)}" y="${(pts[pts.length - 1][1] - 9).toFixed(1)}" text-anchor="${anchorLast}">${f(last.value)}</text>
    <text class="tick" x="${L}" y="${H - 8}" text-anchor="start">${first.year}</text>
    <text class="tick" x="${W - R}" y="${H - 8}" text-anchor="end">${last.year}</text>
  </svg>`;
}

/* One dot per city along a value axis, with the selected city highlighted. */
export function stripChart(cities, metric, selected) {
  const W = 340, H = 118, L = 12, R = 12;
  const vals = cities.map((c) => ({ c, v: metric.get(c) })).filter((d) => Number.isFinite(d.v) && (metric.scale !== 'log' || d.v > 0));
  if (vals.length < 5) return '<p class="empty">Not enough data to compare.</p>';

  const sorted = vals.map((d) => d.v).sort((a, b) => a - b);
  const lo = quantile(sorted, 0.02);
  const hi = quantile(sorted, 0.98);
  const med = quantile(sorted, 0.5);
  const tf = metric.scale === 'log' ? Math.log : (x) => x;
  const t0 = tf(lo), t1 = tf(hi);
  const X = (v) => {
    const t = Math.min(1, Math.max(0, (tf(Math.max(v, metric.scale === 'log' ? 1e-9 : -Infinity)) - t0) / (t1 - t0 || 1)));
    return L + t * (W - L - R);
  };
  const bandTop = 44, bandH = 36;
  const jitter = (i) => (((i * 2654435761) >>> 0) % 1000) / 1000;
  const dots = vals
    .map((d, i) => `<circle class="sdot" cx="${X(d.v).toFixed(1)}" cy="${(bandTop + jitter(i) * bandH).toFixed(1)}" r="2.3"/>`)
    .join('');

  let marker = '';
  const sv = metric.get(selected);
  if (Number.isFinite(sv)) {
    const x = X(sv);
    const anchor = x < 70 ? 'start' : x > W - 70 ? 'end' : 'middle';
    marker = `<line class="sel-line" x1="${x.toFixed(1)}" y1="28" x2="${x.toFixed(1)}" y2="${bandTop + bandH + 6}"/>
      <circle class="sel-dot" cx="${x.toFixed(1)}" cy="${(bandTop + bandH / 2).toFixed(1)}" r="6.5"/>
      <text class="lbl strong" x="${x.toFixed(1)}" y="20" text-anchor="${anchor}">${esc(selected.name)}: ${metric.full(sv)}</text>`;
  }
  const mx = X(med);
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(metric.label)} for all Oregon cities; ${esc(selected.name)} highlighted">
    <line class="axis" x1="${L}" y1="${bandTop + bandH + 8}" x2="${W - R}" y2="${bandTop + bandH + 8}"/>
    ${dots}
    <line class="med-line" x1="${mx.toFixed(1)}" y1="${bandTop - 4}" x2="${mx.toFixed(1)}" y2="${bandTop + bandH + 12}"/>
    ${marker}
    <text class="tick" x="${L}" y="${H - 6}" text-anchor="start">${metric.compact(lo)}</text>
    <text class="tick" x="${mx.toFixed(1)}" y="${H - 6}" text-anchor="middle">median ${metric.compact(med)}</text>
    <text class="tick" x="${W - R}" y="${H - 6}" text-anchor="end">${metric.compact(hi)}</text>
  </svg>`;
}
