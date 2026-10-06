// Data loading, parsing and joining.
// Deliberately free of DOM access so scripts/build-data.mjs can reuse it in Node.

import { CONFIG } from './config.js';

/* ------------------------------------------------------------------ names */

export function normName(raw) {
  if (raw == null) return '';
  let s = String(raw).toLowerCase();
  s = s.replace(/\(.*?\)/g, ' ').replace(/[*†‡]/g, ' ');
  s = s.replace(/,\s*oregon$/, '');
  s = s.replace(/[.'’]/g, '');
  s = s.replace(/\bsaint\b/g, 'st').replace(/\bmount\b/g, 'mt');
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  return CONFIG.aliases[s] || s;
}

export function slug(raw) {
  return normName(raw).replace(/ /g, '-');
}

export function prettyName(raw) {
  const s = String(raw || '').trim();
  if (s && (s === s.toUpperCase() || s === s.toLowerCase())) {
    return s
      .toLowerCase()
      .replace(/(^|[\s.'-])([a-z])/g, (m, a, b) => a + b.toUpperCase())
      .replace(/\bMc([a-z])/g, (m, a) => 'Mc' + a.toUpperCase());
  }
  return s;
}

// "Bend city, Oregon" -> { name: 'Bend', type: 'city' }.  "Johnson City city, Oregon" -> 'Johnson City'.
export function parseCensusPlaceName(name) {
  const m = /^(.*?)\s+(city|town|village|CDP),\s*Oregon$/i.exec(String(name || '').trim());
  if (!m) return null;
  return { name: m[1], type: m[2].toLowerCase() };
}

/* -------------------------------------------------------------------- IO */

async function fetchWithTimeout(url, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url.split('?')[0]}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url.split('?')[0]}`);
  }
}

async function tryLocalJson(path) {
  try {
    const res = await fetchWithTimeout(path, 20000);
    if (!res.ok) return null;
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}

async function tryLocalText(path) {
  try {
    const res = await fetchWithTimeout(path, 20000);
    if (!res.ok) return null;
    const text = await res.text();
    // GitHub Pages serves an HTML 404 page with status 200 in some setups
    if (/^\s*<(!doctype|html)/i.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ city limits */

export async function fetchCityLimitsLive() {
  const { queryUrl, nameField, acresField, simplifyDegrees } = CONFIG.cityLimits;
  const pageSize = 1000;
  const features = [];
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: `${nameField},${acresField}`,
      returnGeometry: 'true',
      outSR: '4326',
      f: 'geojson',
      maxAllowableOffset: String(simplifyDegrees),
      geometryPrecision: '5',
      orderByFields: 'OBJECTID',
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
    });
    const gj = await fetchJson(`${queryUrl}?${params}`);
    if (gj.error) throw new Error(`City limits service error: ${gj.error.message || JSON.stringify(gj.error)}`);
    if (!Array.isArray(gj.features)) throw new Error('City limits service returned no features');
    features.push(...gj.features);
    if (gj.features.length < pageSize && !gj.exceededTransferLimit) break;
    if (gj.features.length === 0) break;
    offset += gj.features.length;
  }
  return { type: 'FeatureCollection', features };
}

async function loadCityLimits(status) {
  const local = await tryLocalJson(CONFIG.local.cityLimits);
  if (local && Array.isArray(local.features) && local.features.length) {
    status.cityLimits = { source: 'snapshot in repo', file: CONFIG.local.cityLimits };
    return local;
  }
  const live = await fetchCityLimitsLive();
  status.cityLimits = { source: 'live ArcGIS service', url: CONFIG.cityLimits.queryUrl };
  return live;
}

/* -------------------------------------------------------------------- ACS */

const pad3 = (n) => String(n).padStart(3, '0');
const tbl = (t, from, to) => {
  const out = [];
  for (let i = from; i <= to; i++) out.push(`${t}_${pad3(i)}E`);
  return out;
};

// Two requests because the Census API caps a call at 50 variables.
export const ACS_VAR_GROUPS = [
  [
    'B01003_001E', // total population
    'B01002_001E', // median age
    'B19013_001E', 'B19013_001M', // median household income
    'B25077_001E', 'B25077_001M', // median home value
    'B25064_001E', 'B25064_001M', // median gross rent
    ...tbl('B25003', 1, 3), // tenure
    ...tbl('B25002', 1, 3), // occupancy
    'B25070_001E', 'B25070_007E', 'B25070_008E', 'B25070_009E', 'B25070_010E', 'B25070_011E', // rent burden
    ...tbl('B25034', 1, 11), // year built
    ...tbl('B25024', 1, 11), // units in structure
  ],
  [
    'B01001_001E',
    ...tbl('B01001', 3, 25), // male by age
    ...tbl('B01001', 27, 49), // female by age
  ],
];

export function buildAcsUrls(year, key = CONFIG.censusKey) {
  // Built by hand (not URLSearchParams) so commas and colons stay literal, exactly as in the Census API docs.
  return ACS_VAR_GROUPS.map((vars) => {
    const get = ['NAME', ...vars].join(',');
    return `https://api.census.gov/data/${year}/acs/acs5?get=${get}&for=place:*&in=state:41${key ? `&key=${encodeURIComponent(key)}` : ''}`;
  });
}

function cleanNum(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  // Census uses large negative sentinels (-666666666, -222222222 ...) for "not available"
  if (!Number.isFinite(n) || n < -100000000) return null;
  return n;
}

// Merge the array-of-arrays responses into { '4105800': { NAME, B01003_001E, ... } }
export function mergeAcsResponses(responses) {
  const places = {};
  for (const resp of responses) {
    const [header, ...rows] = resp;
    const iState = header.indexOf('state');
    const iPlace = header.indexOf('place');
    for (const row of rows) {
      const fips = `${row[iState]}${row[iPlace]}`;
      const rec = (places[fips] ||= {});
      header.forEach((h, i) => {
        if (h === 'state' || h === 'place') return;
        rec[h] = h === 'NAME' ? row[i] : cleanNum(row[i]);
      });
    }
  }
  return places;
}

export async function fetchAcsLive(year, key = CONFIG.censusKey) {
  const responses = await Promise.all(buildAcsUrls(year, key).map(fetchJson));
  return mergeAcsResponses(responses);
}

async function loadAcs(status) {
  const local = await tryLocalJson(CONFIG.local.acs);
  if (local && local.places && Object.keys(local.places).length) {
    status.acs = { source: 'snapshot in repo', year: local.year, fetched: local.fetched, file: CONFIG.local.acs };
    return local;
  }
  let lastErr;
  for (const year of CONFIG.acsYears) {
    try {
      const places = await fetchAcsLive(year);
      status.acs = { source: 'live Census API', year };
      return { year, places };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Census API unavailable');
}

const sum = (rec, keys) => keys.reduce((s, k) => s + (rec[k] ?? 0), 0);
const pct = (num, den) => (den && den > 0 && num != null ? (100 * num) / den : null);

// Turn a raw ACS record into the figures the app shows.
export function deriveAcs(r) {
  const E = (t, n) => r[`${t}_${pad3(n)}E`];
  const S = (t, ns) => ns.reduce((s, n) => s + (E(t, n) ?? 0), 0);

  const rentBase = (E('B25070', 1) ?? 0) - (E('B25070', 11) ?? 0);
  const burdened = S('B25070', [7, 8, 9, 10]);

  // B01001: male = 003..025, female = 027..049 (same offsets +24)
  const ageTotal = r.B01001_001E;
  const both = (ns) => S('B01001', ns) + S('B01001', ns.map((n) => n + 24));
  const ageBands = [
    ['Under 18', both([3, 4, 5, 6])],
    ['18 to 34', both([7, 8, 9, 10, 11, 12])],
    ['35 to 54', both([13, 14, 15, 16])],
    ['55 to 64', both([17, 18, 19])],
    ['65 and over', both([20, 21, 22, 23, 24, 25])],
  ].map(([label, n]) => ({ label, value: pct(n, ageTotal) }));

  const builtTotal = E('B25034', 1);
  const built = [
    ['2010 or later', S('B25034', [2, 3])],
    ['2000 to 2009', S('B25034', [4])],
    ['1980 to 1999', S('B25034', [5, 6])],
    ['1960 to 1979', S('B25034', [7, 8])],
    ['Before 1960', S('B25034', [9, 10, 11])],
  ].map(([label, n]) => ({ label, value: pct(n, builtTotal) }));

  const mixTotal = E('B25024', 1);
  const mix = [
    ['Single-family homes', S('B25024', [2, 3])],
    ['2 to 4 units', S('B25024', [4, 5])],
    ['5 to 19 units', S('B25024', [6, 7])],
    ['20 or more units', S('B25024', [8, 9])],
    ['Mobile homes and other', S('B25024', [10, 11])],
  ].map(([label, n]) => ({ label, value: pct(n, mixTotal) }));

  const lowReliability = (est, moe) => est != null && moe != null && est > 0 && moe / est > 0.25;

  return {
    pop: r.B01003_001E ?? null,
    medianAge: r.B01002_001E ?? null,
    income: r.B19013_001E ?? null,
    incomeMoe: r.B19013_001M ?? null,
    homeValue: r.B25077_001E ?? null,
    homeValueMoe: r.B25077_001M ?? null,
    rent: r.B25064_001E ?? null,
    rentMoe: r.B25064_001M ?? null,
    ownerPct: pct(E('B25003', 2), E('B25003', 1)),
    renterPct: pct(E('B25003', 3), E('B25003', 1)),
    vacancy: pct(E('B25002', 3), E('B25002', 1)),
    housingUnits: E('B25002', 1) ?? null,
    rentBurden: rentBase > 0 ? pct(burdened, rentBase) : null,
    severeBurden: rentBase > 0 ? pct(E('B25070', 10), rentBase) : null,
    age65: ageBands[4].value,
    builtOld: builtTotal ? pct(S('B25034', [7, 8, 9, 10, 11]), builtTotal) : null,
    multi5: mixTotal ? pct(S('B25024', [6, 7, 8, 9]), mixTotal) : null,
    ages: ageBands,
    built,
    mix,
    flags: {
      income: lowReliability(r.B19013_001E, r.B19013_001M),
      homeValue: lowReliability(r.B25077_001E, r.B25077_001M),
      rent: lowReliability(r.B25064_001E, r.B25064_001M),
    },
  };
}

/* -------------------------------------------------------------------- PSU */

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// A header cell counts as a year column if it holds exactly one 4-digit year
// ("2025", "July 1, 2025", "Census 2020", "2025 certified") and isn't a change/percent column.
function headerYear(cell) {
  const s = String(cell ?? '').trim();
  if (!s || s.length > 40) return null;
  const years = s.match(/\b(?:19|20)\d\d\b/g);
  if (!years || years.length !== 1) return null;
  if (/change|percent|%|growth|rate|avg|average|since|diff|numeric/i.test(s)) return null;
  return Number(years[0]);
}

function parseNum(x) {
  if (x == null) return null;
  const n = Number(String(x).replace(/[,$\s%]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Reads a PSU Population Research Center CSV (or any "city name + one column per year" CSV).
// Returns { series: Map(normalizedName -> [{year, value}]), years, rowsRead, error? }
export function parsePsuCsv(text) {
  const rows = parseCsv(text);
  let headerIdx = -1;
  let yearCols = [];
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const cols = [];
    rows[r].forEach((c, i) => {
      const year = headerYear(c);
      if (year != null) cols.push({ i, year });
    });
    if (cols.length >= 1 && (headerIdx < 0 || cols.length > yearCols.length)) {
      headerIdx = r;
      yearCols = cols;
    }
  }
  if (headerIdx < 0) {
    return { series: new Map(), years: [], rowsRead: 0, error: 'No year columns (like 2020, 2021, ... 2025) found in the header row.' };
  }

  let nameCol = CONFIG.psu.nameColumn;
  if (nameCol == null) {
    const firstYearCol = Math.min(...yearCols.map((c) => c.i));
    nameCol = rows[headerIdx].findIndex((c, i) => i < firstYearCol && /city|name|jurisdiction|place|area|geograph/i.test(c));
    if (nameCol < 0) nameCol = 0;
  }

  const series = new Map();
  let rowsRead = 0;
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const rawName = (rows[r][nameCol] || '').trim();
    if (!rawName) continue;
    if (/county\b/i.test(rawName) || /^oregon$/i.test(rawName) || /\btotal\b/i.test(rawName) || /unincorporated/i.test(rawName)) continue;

    const byYear = new Map();
    for (const { i, year } of yearCols) {
      const v = parseNum(rows[r][i]);
      if (v != null) byYear.set(year, v); // later columns win if a year repeats
    }
    if (!byYear.size) continue;
    rowsRead++;

    const list = [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, value]) => ({ year, value }));
    const key = normName(rawName);
    const prev = series.get(key);
    // Cities split across counties can appear more than once: keep the larger (whole-city) row.
    if (!prev || list[list.length - 1].value > prev[prev.length - 1].value) series.set(key, list);
  }
  const years = [...new Set(yearCols.map((c) => c.year))].sort();
  return { series, years, rowsRead };
}

async function loadPsu(status) {
  const text = await tryLocalText(CONFIG.local.psu);
  if (!text) {
    status.psu = { loaded: false };
    return null;
  }
  const parsed = parsePsuCsv(text);
  status.psu = { loaded: !parsed.error, file: CONFIG.local.psu, years: parsed.years, rowsRead: parsed.rowsRead, error: parsed.error };
  return parsed.error ? null : parsed;
}

/* -------------------------------------------------------------- geometry */

function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-14) return ring[0];
  return [cx / (6 * a), cy / (6 * a)];
}

function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Approximate acres for a lon/lat polygon (used only when the service gives no acres value).
function geomAcres(geom) {
  let m2 = 0;
  for (const rings of polygonsOf(geom)) {
    rings.forEach((ring, idx) => {
      const lat0 = ring[0][1];
      const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
      const ky = 110540;
      const pts = ring.map(([x, y]) => [x * kx, y * ky]);
      const a = Math.abs(ringArea(pts));
      m2 += idx === 0 ? a : -a;
    });
  }
  return m2 * 0.000247105;
}

function bboxOf(features) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const f of features) {
    for (const poly of polygonsOf(f.geometry)) {
      for (const [x, y] of poly[0]) {
        if (x < w) w = x; if (x > e) e = x;
        if (y < s) s = y; if (y > n) n = y;
      }
    }
  }
  return [w, s, e, n];
}

function labelPoint(features) {
  let best = null, bestA = -1;
  for (const f of features) {
    for (const poly of polygonsOf(f.geometry)) {
      const a = Math.abs(ringArea(poly[0]));
      if (a > bestA) { bestA = a; best = poly[0]; }
    }
  }
  if (!best) return null;
  const c = ringCentroid(best);
  if (inRing(c, best)) return c;
  const xs = best.map((p) => p[0]), ys = best.map((p) => p[1]);
  const mid = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  return inRing(mid, best) ? mid : best[0];
}

/* ------------------------------------------------------------------- join */

export function buildCities({ geojson, acs, psu, status = {} }) {
  const { nameField, acresField } = CONFIG.cityLimits;

  // 1. one record per city (cities can have several non-contiguous polygons)
  const groups = new Map();
  for (const f of geojson.features) {
    if (!f.geometry) continue;
    const raw = f.properties?.[nameField];
    if (!raw) continue;
    const norm = normName(raw);
    if (!norm) continue;
    let g = groups.get(norm);
    if (!g) { g = { norm, key: norm.replace(/ /g, '-'), rawName: String(raw).trim(), parts: [], acres: 0 }; groups.set(norm, g); }
    g.parts.push(f);
    const a = Number(f.properties?.[acresField]);
    g.acres += Number.isFinite(a) && a > 0 ? a : geomAcres(f.geometry);
  }

  // 2. index Census places (incorporated only) by normalized name
  const acsIdx = new Map();
  const acsCdp = [];
  if (acs?.places) {
    for (const rec of Object.values(acs.places)) {
      const p = parseCensusPlaceName(rec.NAME);
      if (!p) continue;
      if (p.type === 'cdp') { acsCdp.push(p.name); continue; }
      const k = normName(p.name);
      const prev = acsIdx.get(k);
      if (!prev || (rec.B01003_001E || 0) > (prev.B01003_001E || 0)) acsIdx.set(k, rec);
    }
  }

  // 3. assemble
  const cities = [];
  const polyFeatures = [];
  const pointFeatures = [];
  const unmatchedLimits = [];
  const usedAcs = new Set();
  const usedPsu = new Set();

  for (const g of groups.values()) {
    const rec = acsIdx.get(g.norm);
    const d = rec ? deriveAcs(rec) : null;
    if (rec) usedAcs.add(g.norm); else unmatchedLimits.push(prettyName(g.rawName));

    const series = psu?.series.get(g.norm) || null;
    if (series) usedPsu.add(g.norm);

    let pop = null, popSource = null, popYear = null, growth = null, growthFrom = null;
    if (series?.length) {
      const last = series[series.length - 1];
      pop = last.value; popYear = last.year; popSource = `PSU Population Research Center, July 1, ${last.year}`;
      if (series.length >= 2) {
        const first = series[0];
        growth = (100 * (last.value - first.value)) / first.value;
        growthFrom = first.year;
      }
    } else if (d?.pop != null) {
      pop = d.pop; popSource = `Census ACS 5-year estimate (${acs.year - 4}-${acs.year})`;
    }

    const acres = g.acres;
    const sqmi = acres / 640;
    const c = {
      key: g.key,
      name: prettyName(g.rawName),
      acres,
      sqmi,
      bbox: bboxOf(g.parts),
      centroid: labelPoint(g.parts),
      hasAcs: !!d,
      pop, popSource, popYear,
      series,
      growth, growthFrom,
      density: pop != null && sqmi > 0 ? pop / sqmi : null,
      income: d?.income ?? null, incomeMoe: d?.incomeMoe ?? null,
      homeValue: d?.homeValue ?? null, homeValueMoe: d?.homeValueMoe ?? null,
      rent: d?.rent ?? null, rentMoe: d?.rentMoe ?? null,
      medianAge: d?.medianAge ?? null,
      ownerPct: d?.ownerPct ?? null, renterPct: d?.renterPct ?? null,
      vacancy: d?.vacancy ?? null, housingUnits: d?.housingUnits ?? null,
      rentBurden: d?.rentBurden ?? null, severeBurden: d?.severeBurden ?? null,
      age65: d?.age65 ?? null, builtOld: d?.builtOld ?? null, multi5: d?.multi5 ?? null,
      ages: d?.ages ?? null, built: d?.built ?? null, mix: d?.mix ?? null,
      flags: d?.flags ?? { income: false, homeValue: false, rent: false },
      ranks: {},
    };
    cities.push(c);

    for (const f of g.parts) polyFeatures.push({ type: 'Feature', geometry: f.geometry, properties: { key: c.key } });
    if (c.centroid) pointFeatures.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c.centroid }, properties: { key: c.key } });
  }

  cities.sort((a, b) => a.name.localeCompare(b.name));
  const byKey = new Map(cities.map((c) => [c.key, c]));

  const unmatchedAcs = [];
  for (const [k, rec] of acsIdx) if (!usedAcs.has(k)) unmatchedAcs.push(parseCensusPlaceName(rec.NAME).name);
  const unmatchedPsu = [];
  if (psu) for (const k of psu.series.keys()) if (!usedPsu.has(k)) unmatchedPsu.push(k);

  status.summary = {
    cities: cities.length,
    polygons: polyFeatures.length,
    acsMatched: cities.filter((c) => c.hasAcs).length,
    psuMatched: usedPsu.size,
    unmatchedLimits,
    unmatchedAcs,
    unmatchedPsu,
    acsCdpCount: acsCdp.length,
  };

  return {
    cities,
    byKey,
    polys: { type: 'FeatureCollection', features: polyFeatures },
    points: { type: 'FeatureCollection', features: pointFeatures },
    acsYear: acs?.year ?? null,
    hasPsu: !!psu,
    hasGrowth: cities.some((c) => c.growth != null),
    status,
  };
}

/* ------------------------------------------------------------ entry point */

export async function loadAll(onProgress = () => {}) {
  const status = {};
  onProgress('Loading city boundaries');
  const geojson = await loadCityLimits(status);

  onProgress('Loading Census data');
  const acs = await loadAcs(status).catch((e) => {
    status.acs = { error: e.message };
    return null;
  });

  onProgress('Loading population estimates');
  const psu = await loadPsu(status);

  return buildCities({ geojson, acs, psu, status });
}
