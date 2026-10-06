import { CONFIG } from './config.js';
import { loadAll, normName } from './data.js';
import { METRICS, metricById, availableMetrics, quantileBreaks, computeRanks, findPeers, funFacts, fmt } from './stats.js';
import { esc, barRows, lineChart, stripChart } from './charts.js';

const $ = (sel, el = document) => el.querySelector(sel);
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
const isMobile = () => innerWidth <= 720;

/* Map colors (kept in sync with the CSS palette) */
const SEQ = dark
  ? ['#17332b', '#20503f', '#2f7a5f', '#58a37f', '#8fcaa6', '#d4efdc']
  : ['#e8f0ea', '#c3dcc9', '#93c3a2', '#5c9f7d', '#2b7659', '#123f33'];
const DIV = dark
  ? ['#e8a24e', '#c28a43', '#7a6035', '#2b3d36', '#3e7a60', '#62b08a', '#a6dfc0']
  : ['#b5651d', '#dfa24a', '#f1d9a0', '#e4ece6', '#a6cfb0', '#4f9a78', '#1b5e49'];
const NODATA = dark ? '#2b3a35' : '#cbd3cf';
const GOLD = dark ? '#e8b14a' : '#d99a2b';
const OUTLINE = dark ? '#0d1714' : '#0f2e25';

const state = { metric: 'pop', size: 'all', selected: null, tab: 'compare', metricsAvail: METRICS };
let map;
let data;

init();

/* ------------------------------------------------------------------ init */

async function init() {
  try {
    data = await loadAll((msg) => ($('#loading-text').textContent = msg + '…'));
  } catch (err) {
    showFatal(err);
    return;
  }
  computeRanks(data.cities);
  state.metricsAvail = availableMetrics(data.cities).filter((m) => !(m.needsPsu && !data.hasGrowth));
  attachFeatureProps();
  setupControls();
  setupSearch();
  setupAbout();
  renderWelcome();
  setupMap();
}

function showFatal(err) {
  console.error(err);
  const box = $('.loading-inner');
  box.className = 'loading-inner error';
  box.innerHTML = `<h2>The map data didn't load</h2>
    <p>${esc(err.message || err)}</p>
    <p>If you opened <code>index.html</code> straight from your computer, browsers block the data requests.
    Run a local server instead: <code>python3 -m http.server</code> and visit <code>http://localhost:8000</code>.</p>
    <p>Otherwise the State of Oregon city limits service may be down. A saved copy at <code>data/city_limits.geojson</code> avoids that (see the README).</p>`;
}

// Put every metric on each polygon/point so MapLibre can color and filter by it.
function attachFeatureProps() {
  const apply = (fc) => {
    for (const f of fc.features) {
      const c = data.byKey.get(f.properties.key);
      const p = { key: c.key, name: c.name };
      for (const m of METRICS) {
        const v = m.get(c);
        p[m.id] = Number.isFinite(v) ? v : null;
      }
      f.properties = p;
    }
  };
  apply(data.polys);
  apply(data.points);
}

/* ------------------------------------------------------------------- map */

function setupMap() {
  const BLANK = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': dark ? '#0d1714' : '#dfe6e2' } }] };

  map = new maplibregl.Map({
    container: 'map',
    style: dark ? CONFIG.basemaps.dark : CONFIG.basemaps.light,
    bounds: [[-124.9, 41.9], [-116.4, 46.4]],
    fitBoundsOptions: { padding: mapPadding() },
    maxBounds: [[-130, 39.5], [-110, 49]],
    minZoom: 4.5,
    attributionControl: false,
    dragRotate: false,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.touchZoomRotate.disableRotation();

  let ready = false;
  const start = () => {
    if (ready) return;
    ready = true;
    addDataLayers();
    setMetric(state.metric, { silent: true });
    $('#loading').classList.add('done');
    document.body.classList.remove('is-loading');
    routeFromHash();
  };
  map.on('load', start);

  // If the basemap style can't be fetched (offline venue wifi, blocked CDN), draw on a plain background instead.
  setTimeout(() => {
    if (ready) return;
    map.setStyle(BLANK);
    map.once('styledata', start);
  }, 9000);

  map.on('click', (e) => {
    const f = featureAt(e.point);
    if (f) selectCity(f.properties.key);
  });
  map.on('mousemove', onHover);
  map.on('mouseout', () => ($('#tip').hidden = true));
}

function featureAt(point, pad = 4) {
  if (!map.getLayer('city-fill')) return null;
  const box = [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]];
  const layers = ['city-pts', 'city-fill'].filter((id) => map.getLayer(id));
  const hits = map.queryRenderedFeatures(box, { layers });
  return hits[0] || null;
}

function pickColors(palette, n) {
  if (n <= 1) return [palette[Math.floor(palette.length / 2)]];
  return Array.from({ length: n }, (_, i) => palette[Math.round((i * (palette.length - 1)) / (n - 1))]);
}

// Builds the MapLibre color expression and legend description for a metric.
function colorScale(metric) {
  const vals = data.cities.map(metric.get).filter(Number.isFinite);
  if (!vals.length) return { expr: NODATA, breaks: [], colors: [NODATA], min: null, max: null };
  const breaks = metric.breaks || quantileBreaks(vals, 6);
  const palette = metric.diverging ? DIV : SEQ;
  const colors = metric.diverging ? palette : pickColors(palette, breaks.length + 1);
  const get = ['get', metric.id];
  const step = ['step', get, colors[0]];
  breaks.forEach((b, i) => step.push(b, colors[i + 1]));
  return {
    expr: ['case', ['==', ['typeof', get], 'number'], step, NODATA],
    breaks,
    colors,
    min: Math.min(...vals),
    max: Math.max(...vals),
  };
}

function addDataLayers() {
  if (map.getSource('cities')) return;
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  const scale = colorScale(metricById(state.metric));

  map.addSource('cities', { type: 'geojson', data: data.polys });
  map.addSource('city-pts', { type: 'geojson', data: data.points });

  map.addLayer({ id: 'city-fill', type: 'fill', source: 'cities', paint: { 'fill-color': scale.expr, 'fill-opacity': 0.85 } }, firstSymbol);
  map.addLayer({
    id: 'city-line', type: 'line', source: 'cities',
    paint: { 'line-color': OUTLINE, 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.3, 10, 1.2] },
  }, firstSymbol);
  map.addLayer({
    id: 'city-sel-line', type: 'line', source: 'cities', filter: ['==', ['get', 'key'], ''],
    paint: { 'line-color': GOLD, 'line-width': 3.5 },
  });

  // Dots make tiny cities clickable at statewide zoom; they fade out once polygons are big enough to click.
  const base = ['max', 3.4, ['*', 1.15, ['ln', ['max', ['to-number', ['get', 'pop'], 10], 10]]]];
  const radius = (extra) => ['interpolate', ['linear'], ['zoom'], 5, ['+', ['*', 0.75, base], extra], 9, ['+', ['*', 1.15, base], extra]];
  const fade = ['interpolate', ['linear'], ['zoom'], 9.5, 0.95, 11, 0];
  map.addLayer({
    id: 'city-pts', type: 'circle', source: 'city-pts', maxzoom: 11.5,
    paint: {
      'circle-radius': radius(0), 'circle-color': scale.expr, 'circle-opacity': fade,
      'circle-stroke-color': OUTLINE, 'circle-stroke-width': 1, 'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 9.5, 0.7, 11, 0],
    },
  });
  map.addLayer({
    id: 'city-sel-pt', type: 'circle', source: 'city-pts', maxzoom: 11.5, filter: ['==', ['get', 'key'], ''],
    paint: { 'circle-radius': radius(5), 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': GOLD, 'circle-stroke-width': 3.5 },
  });
  applySizeFilter();
}

function applySizeFilter() {
  const pop = ['to-number', ['get', 'pop'], 0];
  const filters = {
    all: null,
    small: ['<', pop, 2500],
    mid: ['all', ['>=', pop, 2500], ['<', pop, 10000]],
    large: ['>=', pop, 10000],
  };
  const f = filters[state.size];
  ['city-fill', 'city-line', 'city-pts'].forEach((id) => map.getLayer(id) && map.setFilter(id, f));
}

function onHover(e) {
  const tip = $('#tip');
  const f = featureAt(e.point, 3);
  if (!f) {
    tip.hidden = true;
    map.getCanvas().style.cursor = '';
    return;
  }
  const c = data.byKey.get(f.properties.key);
  const m = metricById(state.metric);
  const v = m.get(c);
  map.getCanvas().style.cursor = 'pointer';
  tip.innerHTML = `<b>${esc(c.name)}</b>${Number.isFinite(v) ? ` · ${esc(m.full(v))}` : ' · no data'}`;
  tip.style.left = e.originalEvent.clientX + 'px';
  tip.style.top = e.originalEvent.clientY + 'px';
  tip.hidden = false;
}

/* --------------------------------------------------------- map controls */

function setupControls() {
  const sel = $('#metric-select');
  sel.innerHTML = METRICS.map((m) => {
    const ok = state.metricsAvail.includes(m);
    const label = m.needsPsu && !data.hasGrowth ? `${m.label} (needs PSU data)` : m.label;
    return `<option value="${m.id}" ${ok ? '' : 'disabled'}>${esc(label)}</option>`;
  }).join('');
  sel.value = state.metric;
  sel.addEventListener('change', () => setMetric(sel.value));

  $('#size-chips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-size]');
    if (!b) return;
    state.size = b.dataset.size;
    $('#size-chips').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    applySizeFilter();
  });
}

function setMetric(id, { silent = false } = {}) {
  const m = metricById(id);
  if (!m) return;
  state.metric = id;
  $('#metric-select').value = id;
  const scale = colorScale(m);
  if (map && map.getLayer('city-fill')) {
    map.setPaintProperty('city-fill', 'fill-color', scale.expr);
    map.setPaintProperty('city-pts', 'circle-color', scale.expr);
  }
  renderLegend(m, scale);
  if (!silent && state.selected) refreshChart();
}

function renderLegend(m, scale) {
  const el = $('#legend');
  if (!scale.colors.length || scale.min == null) {
    el.innerHTML = `<div class="legend-title">${esc(m.label)}</div><div class="legend-note">No data loaded for this measure.</div>`;
    return;
  }
  const lowers = [scale.min, ...scale.breaks];
  const steps = scale.colors
    .map((col, i) => `<div class="legend-step"><i style="background:${col}"></i><span>${esc(m.compact(lowers[i]))}${i === scale.colors.length - 1 ? '+' : ''}</span></div>`)
    .join('');
  const missing = data.cities.filter((c) => !Number.isFinite(m.get(c))).length;
  const note = [`Lowest ${m.compact(scale.min)}, highest ${m.compact(scale.max)}`];
  if (missing) note.push(`<span class="swatch-nodata"></span>${missing} without data`);
  el.innerHTML = `<div class="legend-title">${esc(m.label)}</div><div class="legend-scale">${steps}</div><div class="legend-note">${note.join('&nbsp;&nbsp;')}</div>`;
}

/* ---------------------------------------------------------------- search */

function setupSearch() {
  const input = $('#search-input');
  const list = $('#search-results');
  const index = data.cities.map((c) => ({ c, q: normName(c.name) }));
  let active = -1;
  let current = [];

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const paint = () => {
    list.innerHTML = current
      .map((c, i) => `<li role="option" id="sr-${i}" data-key="${esc(c.key)}" aria-selected="${i === active}">
        <span>${esc(c.name)}</span><small>${c.pop ? fmt.int(c.pop) : ''}</small></li>`)
      .join('');
    list.hidden = !current.length;
    input.setAttribute('aria-expanded', String(!!current.length));
  };
  const choose = (key) => {
    close();
    input.value = '';
    input.blur();
    selectCity(key);
  };

  input.addEventListener('input', () => {
    const q = normName(input.value);
    if (!q) { current = []; return close(); }
    const starts = index.filter((x) => x.q.startsWith(q));
    const contains = index.filter((x) => !x.q.startsWith(q) && x.q.includes(q));
    current = [...starts, ...contains].slice(0, 8).map((x) => x.c);
    active = current.length ? 0 : -1;
    paint();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && current.length) { active = (active + 1) % current.length; paint(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && current.length) { active = (active - 1 + current.length) % current.length; paint(); e.preventDefault(); }
    else if (e.key === 'Enter' && active >= 0) { choose(current[active].key); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); }
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-key]');
    if (li) { e.preventDefault(); choose(li.dataset.key); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
}

/* ------------------------------------------------------------- selection */

// Keep the map's usable area clear of the controls card (left) and the side panel (right).
function mapPadding() {
  const w = innerWidth;
  const h = innerHeight;
  if (isMobile()) return { top: 130, left: 20, right: 20, bottom: state.selected ? Math.round(h * 0.58) + 10 : 80 };
  let left = $('.controls').getBoundingClientRect().right + 16;
  let right = $('#panel').getBoundingClientRect().width + 32;
  const maxTotal = w * 0.7; // never ask MapLibre to fit into less than 30% of the screen
  if (left + right > maxTotal) {
    const k = maxTotal / (left + right);
    left *= k;
    right *= k;
  }
  return { top: 40, left: Math.round(left), right: Math.round(right), bottom: 60 };
}

function selectCity(key, { fly = true, updateHash = true } = {}) {
  const c = data.byKey.get(key);
  if (!c) return;
  state.selected = key;
  document.body.classList.add('has-panel');
  $('#panel').classList.remove('is-empty');
  if (map.getLayer('city-sel-line')) {
    map.setFilter('city-sel-line', ['==', ['get', 'key'], key]);
    map.setFilter('city-sel-pt', ['==', ['get', 'key'], key]);
  }
  renderCity(c);
  $('#panel').scrollTop = 0;
  if (fly) map.fitBounds(c.bbox, { padding: mapPadding(), maxZoom: 12, duration: 900 });
  if (updateHash && location.hash !== `#/city/${key}`) history.replaceState(null, '', `#/city/${key}`);
}

function clearSelection() {
  state.selected = null;
  document.body.classList.remove('has-panel');
  $('#panel').classList.add('is-empty');
  if (map.getLayer('city-sel-line')) {
    map.setFilter('city-sel-line', ['==', ['get', 'key'], '']);
    map.setFilter('city-sel-pt', ['==', ['get', 'key'], '']);
  }
  history.replaceState(null, '', location.pathname + location.search);
  renderWelcome();
}

function routeFromHash() {
  const m = /^#\/city\/([^/]+)/.exec(location.hash);
  if (m && data.byKey.has(decodeURIComponent(m[1]))) selectCity(decodeURIComponent(m[1]), { updateHash: false });
}
addEventListener('hashchange', () => {
  if (!data || !map) return;
  const m = /^#\/city\/([^/]+)/.exec(location.hash);
  if (m) {
    const key = decodeURIComponent(m[1]);
    if (key !== state.selected && data.byKey.has(key)) selectCity(key, { updateHash: false });
  } else if (state.selected) clearSelection();
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selected && !$('#about').open && document.activeElement !== $('#search-input')) clearSelection();
});

/* ----------------------------------------------------------------- panel */

function renderWelcome() {
  const total = data.cities.reduce((s, c) => s + (c.pop || 0), 0);
  const facts = funFacts(data.cities);
  $('#panel-body').innerHTML = `<div class="welcome">
    <h2>Pick a city</h2>
    <p class="lede">Search for your city or click one on the map. ${data.cities.length} incorporated cities, home to about ${fmt.int(total)} residents.</p>
    <div class="facts"><h3>Quick facts</h3>
      <ul class="fact-list">${facts
        .map((f) => `<li>${f.key ? `<button type="button" data-key="${esc(f.key)}">${esc(f.text)}</button>` : esc(f.text)}</li>`)
        .join('')}</ul>
    </div>
  </div>`;
}

const STAT_CARDS = [
  { v: (c) => fmt.int(c.density), raw: (c) => c.density, label: 'people per square mile' },
  { v: (c) => fmt.usd(c.income), raw: (c) => c.income, label: 'median household income', flag: 'income', moe: (c) => c.incomeMoe },
  { v: (c) => fmt.usd(c.homeValue), raw: (c) => c.homeValue, label: 'median home value', flag: 'homeValue', moe: (c) => c.homeValueMoe },
  { v: (c) => fmt.usd(c.rent), raw: (c) => c.rent, label: 'median monthly rent', flag: 'rent', moe: (c) => c.rentMoe },
  { v: (c) => fmt.pct(c.rentBurden), raw: (c) => c.rentBurden, label: 'of renters spend 30% or more of income on rent' },
  { v: (c) => fmt.pct(c.ownerPct), raw: (c) => c.ownerPct, label: 'of households own their home' },
];

function renderCity(c) {
  const rankIds = ['pop', 'growth', 'density', 'rentBurden'];
  const rankChips = rankIds
    .filter((id) => c.ranks[id])
    .slice(0, 3)
    .map((id) => `<li title="1 = highest">#${c.ranks[id].rank} of ${c.ranks[id].of} in ${esc(metricById(id).rankLabel)}</li>`)
    .join('');

  const growth = c.growth != null
    ? `<span class="growth ${c.growth >= 0 ? 'up' : 'down'}">${c.growth >= 0 ? '▲' : '▼'} ${fmt.pct(Math.abs(c.growth), 1)} since ${c.growthFrom}</span>`
    : '';

  const stats = STAT_CARDS.map((s) => {
    const has = Number.isFinite(s.raw(c));
    const moe = s.flag && c.flags[s.flag] && s.moe(c) != null
      ? `<span class="moe">Small sample: could be off by ±${fmt.usd(s.moe(c))}</span>` : '';
    return `<div><div class="stat-val">${has ? s.v(c) : '—'}</div><div class="stat-label">${esc(s.label)}</div>${moe}</div>`;
  }).join('');

  const peers = findPeers(data.cities, c, 5);
  const noAcs = !c.hasAcs
    ? `<p class="notice">No Census match was found for this city, so income and housing figures are missing. Open “Data and sources” to see how names were matched.</p>` : '';

  $('#panel-body').innerHTML = `
    <div class="panel-head">
      <h2 class="city-name">${esc(c.name)}</h2>
      <div class="head-actions">
        <button type="button" class="icon-btn" id="copy-link">Copy link</button>
        <button type="button" class="icon-btn" id="close-panel" aria-label="Close city details">Close</button>
      </div>
    </div>
    <p class="city-sub">${fmt.dec1(c.sqmi)} square miles inside city limits</p>

    <div class="hero">
      <div class="hero-num">${fmt.int(c.pop)}</div>
      <div class="hero-row"><span class="hero-label">residents</span>${growth}</div>
    </div>
    ${rankChips ? `<ul class="ranks">${rankChips}</ul>` : ''}
    ${noAcs}
    <div class="stats">${stats}</div>

    <div class="chart-area">
      <div class="tabs" role="tablist" id="tabs"></div>
      <div class="chart-body" id="chart-body" role="tabpanel"></div>
    </div>

    ${peers.length ? `<div class="peers"><h3>Similar cities</h3>
      <p>Closest matches on size, income, housing costs, tenure, age and housing stock.</p>
      <div class="peer-list">${peers.map((p) => `<button type="button" data-key="${esc(p.key)}">${esc(p.name)}<small>${fmt.int(p.pop)} residents</small></button>`).join('')}</div></div>` : ''}

    <p class="source-note">${c.popSource ? `Population: ${esc(c.popSource)}. ` : ''}Housing and income: Census ACS 5-year estimates${data.acsYear ? `, ${data.acsYear - 4}–${data.acsYear}` : ''}. Density is population divided by area inside city limits.</p>
  `;
  renderTabs(c);
}

function tabsFor(c) {
  const t = [{ id: 'compare', label: 'How it compares' }];
  if (c.mix) t.push({ id: 'housing', label: 'Housing types' }, { id: 'built', label: 'Age of homes' }, { id: 'age', label: 'Residents by age' });
  if (c.series && c.series.length >= 2) t.push({ id: 'trend', label: 'Population trend' });
  return t;
}

function renderTabs(c) {
  const tabs = tabsFor(c);
  if (!tabs.some((t) => t.id === state.tab)) state.tab = tabs[0].id;
  $('#tabs').innerHTML = tabs
    .map((t) => `<button type="button" role="tab" data-tab="${t.id}" aria-selected="${t.id === state.tab}">${esc(t.label)}</button>`)
    .join('');
  refreshChart();
}

function refreshChart() {
  const c = data.byKey.get(state.selected);
  if (!c) return;
  const body = $('#chart-body');
  const acsNote = data.acsYear ? `Census ACS 5-year estimates, ${data.acsYear - 4}–${data.acsYear}.` : '';
  let html = '';

  switch (state.tab) {
    case 'housing':
      html = `<h3 class="chart-title">Homes by building type</h3>${barRows(c.mix)}<p class="chart-cap">Share of all homes. ${acsNote}</p>`;
      break;
    case 'built':
      html = `<h3 class="chart-title">When homes were built</h3>${barRows(c.built)}<p class="chart-cap">Share of all homes. ${acsNote}</p>`;
      break;
    case 'age':
      html = `<h3 class="chart-title">Residents by age</h3>${barRows(c.ages)}<p class="chart-cap">Share of residents. ${acsNote}</p>`;
      break;
    case 'trend':
      html = `<h3 class="chart-title">Population, ${c.series[0].year} to ${c.series[c.series.length - 1].year}</h3>${lineChart(c.series)}<p class="chart-cap">Source: PSU Population Research Center.</p>`;
      break;
    default: {
      const m = metricById(state.metric);
      html = `<label class="sr-only" for="cmp-metric">Compare on</label>
        <select id="cmp-metric">${state.metricsAvail.map((x) => `<option value="${x.id}" ${x.id === state.metric ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
        ${stripChart(data.cities, m, c)}
        <p class="chart-cap">Each dot is one Oregon city. The dashed line marks the median city. Choosing a measure here also recolors the map.</p>`;
    }
  }
  body.innerHTML = html;
  requestAnimationFrame(() => requestAnimationFrame(() => body.querySelectorAll('.bar-fill').forEach((b) => (b.style.width = b.dataset.w + '%'))));
}

// One delegated handler for everything inside the panel
$('#panel').addEventListener('click', (e) => {
  const tab = e.target.closest('button[data-tab]');
  if (tab) {
    state.tab = tab.dataset.tab;
    $('#tabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b === tab)));
    return refreshChart();
  }
  const cityBtn = e.target.closest('button[data-key]');
  if (cityBtn) return selectCity(cityBtn.dataset.key);
  if (e.target.closest('#close-panel')) return clearSelection();
  const copy = e.target.closest('#copy-link');
  if (copy) return copyLink(copy);
});
$('#panel').addEventListener('change', (e) => {
  if (e.target.id === 'cmp-metric') setMetric(e.target.value);
});

async function copyLink(btn) {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = 'Link copied';
  } catch {
    window.prompt('Copy this link', url);
  }
  setTimeout(() => (btn.textContent = 'Copy link'), 1800);
}

/* ------------------------------------------------------------ about dialog */

function setupAbout() {
  $('#data-btn').addEventListener('click', () => {
    $('#about-body').innerHTML = aboutHtml();
    $('#about').showModal();
  });
}

function aboutHtml() {
  const st = data.status;
  const s = st.summary;
  const ok = (t) => `<span class="ok">${t}</span>`;
  const warn = (t) => `<span class="warn">${t}</span>`;
  const list = (arr, max = 40) => (arr.length ? `<ul>${arr.slice(0, max).map((x) => `<li>${esc(x)}</li>`).join('')}${arr.length > max ? `<li>…and ${arr.length - max} more</li>` : ''}</ul>` : '<p>None.</p>');

  const acs = st.acs?.error
    ? `${warn('Not loaded.')} ${esc(st.acs.error)}`
    : `${ok('Loaded')} from the ${esc(st.acs.source)}: ACS 5-year ${st.acs.year - 4}–${st.acs.year}, matched to ${s.acsMatched} of ${s.cities} cities.`;

  const psu = st.psu?.loaded
    ? `${ok('Loaded')} <code>${esc(st.psu.file)}</code>: ${st.psu.rowsRead} rows read, years ${esc((st.psu.years || []).join(', '))}, matched to ${s.psuMatched} of ${s.cities} cities.`
    : st.psu?.error
      ? `${warn('Could not read')} <code>${esc(st.psu.file)}</code>: ${esc(st.psu.error)}`
      : `${warn('Not loaded.')} Population falls back to the Census estimate and the population-change layer is off. Add <code>data/psu_population.csv</code> (see <code>data/README.md</code>).`;

  return `<h2 id="about-title">Data and sources</h2>
    <h3>City limits</h3>
    <p>${ok('Loaded')} from a ${esc(st.cityLimits.source)}: ${s.polygons} boundary polygons forming ${s.cities} cities. State of Oregon / ODOT City Limits layer, simplified for web display.</p>
    <h3>Census American Community Survey</h3>
    <p>${acs}</p>
    <p>Income, housing, age and rent figures are survey estimates, so small cities can have wide margins of error. Where the margin is more than a quarter of the estimate, the city card says so.</p>
    <h3>Portland State University Population Research Center</h3>
    <p>${psu}</p>
    <h3>How measures are calculated</h3>
    <ul>
      <li>Population density: population divided by square miles inside city limits (water included).</li>
      <li>Rent burden: renters spending 30% or more of income on rent, among renters whose ratio could be computed.</li>
      <li>Population change: first to last year in the PSU file.</li>
      <li>Similar cities: nearest neighbors on population, income, rent burden, homeownership, median age, older homes and multifamily share.</li>
    </ul>
    <h3>Cities with no Census match (${s.unmatchedLimits.length})</h3>
    ${list(s.unmatchedLimits)}
    ${s.unmatchedPsu.length ? `<h3>PSU rows that matched no city (${s.unmatchedPsu.length})</h3><p>Often county or region rows, which is fine.</p>${list(s.unmatchedPsu, 25)}` : ''}
    ${s.unmatchedAcs.length ? `<h3>Census cities missing from the boundary layer (${s.unmatchedAcs.length})</h3>${list(s.unmatchedAcs)}` : ''}
    <p>Fix a mismatch by adding an entry to <code>aliases</code> in <code>js/config.js</code>.</p>`;
}
