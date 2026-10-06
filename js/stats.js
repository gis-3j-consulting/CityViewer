// Metric definitions, number formatting, rankings, peer matching, "did you know" facts.

/* ------------------------------------------------------------- formatting */

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export const fmt = {
  int: (n) => (n == null ? '—' : nf.format(Math.round(n))),
  intK: (n) => {
    if (n == null) return '—';
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return Math.round(n / 1e3) + 'k';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return nf.format(Math.round(n));
  },
  usd: (n) => (n == null ? '—' : '$' + nf.format(Math.round(n))),
  usdK: (n) => {
    if (n == null) return '—';
    const a = Math.abs(n);
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return '$' + Math.round(n / 1e3) + 'k';
    return '$' + nf.format(Math.round(n));
  },
  pct: (n, d = 0) => (n == null ? '—' : n.toFixed(d) + '%'),
  pctSigned: (n, d = 1) => (n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(d) + '%'),
  dec1: (n) => (n == null ? '—' : n.toFixed(1)),
};

/* ---------------------------------------------------------------- metrics */

// scale: 'log' is used by the dot-plot axis for skewed measures
export const METRICS = [
  { id: 'pop', label: 'Population', get: (c) => c.pop, full: fmt.int, compact: fmt.intK, scale: 'log', rankLabel: 'population' },
  { id: 'density', label: 'Population density (people per sq. mi.)', get: (c) => c.density, full: fmt.int, compact: fmt.intK, scale: 'log', rankLabel: 'density' },
  {
    id: 'growth', label: 'Population change', get: (c) => c.growth, full: (n) => fmt.pctSigned(n, 1), compact: (n) => fmt.pctSigned(n, 0),
    diverging: true, breaks: [-3, -1, 1, 3, 8, 15], scale: 'linear', rankLabel: 'growth', needsPsu: true,
  },
  { id: 'income', label: 'Median household income', get: (c) => c.income, full: fmt.usd, compact: fmt.usdK, scale: 'log', rankLabel: 'income' },
  { id: 'homeValue', label: 'Median home value', get: (c) => c.homeValue, full: fmt.usd, compact: fmt.usdK, scale: 'log', rankLabel: 'home value' },
  { id: 'rent', label: 'Median monthly rent', get: (c) => c.rent, full: fmt.usd, compact: fmt.usdK, scale: 'linear', rankLabel: 'rent' },
  { id: 'rentBurden', label: 'Renters paying 30%+ of income on rent', get: (c) => c.rentBurden, full: (n) => fmt.pct(n, 0), compact: (n) => fmt.pct(n, 0), scale: 'linear', rankLabel: 'rent burden' },
  { id: 'ownerPct', label: 'Households that own their home', get: (c) => c.ownerPct, full: (n) => fmt.pct(n, 0), compact: (n) => fmt.pct(n, 0), scale: 'linear', rankLabel: 'homeownership' },
  { id: 'vacancy', label: 'Vacant homes', get: (c) => c.vacancy, full: (n) => fmt.pct(n, 1), compact: (n) => fmt.pct(n, 0), scale: 'linear', rankLabel: 'vacancy' },
  { id: 'medianAge', label: 'Median age', get: (c) => c.medianAge, full: fmt.dec1, compact: (n) => fmt.dec1(n), scale: 'linear', rankLabel: 'median age' },
  { id: 'age65', label: 'Residents 65 and older', get: (c) => c.age65, full: (n) => fmt.pct(n, 0), compact: (n) => fmt.pct(n, 0), scale: 'linear', rankLabel: '65+ share' },
  { id: 'builtOld', label: 'Homes built before 1980', get: (c) => c.builtOld, full: (n) => fmt.pct(n, 0), compact: (n) => fmt.pct(n, 0), scale: 'linear', rankLabel: 'older homes' },
  { id: 'multi5', label: 'Homes in buildings with 5+ units', get: (c) => c.multi5, full: (n) => fmt.pct(n, 0), compact: (n) => fmt.pct(n, 0), scale: 'linear', rankLabel: 'multifamily share' },
];

export const metricById = (id) => METRICS.find((m) => m.id === id);

export function availableMetrics(cities) {
  return METRICS.filter((m) => cities.some((c) => Number.isFinite(m.get(c))));
}

/* ------------------------------------------------------------- statistics */

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Class breaks with roughly equal numbers of cities per class, rounded to 2 significant digits.
export function quantileBreaks(values, classes) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < classes) return [];
  const out = [];
  for (let i = 1; i < classes; i++) {
    const b = Number(quantile(v, i / classes).toPrecision(2));
    if (!out.length || b > out[out.length - 1]) out.push(b);
  }
  return out;
}

export function computeRanks(cities) {
  for (const m of METRICS) {
    const ranked = cities.filter((c) => Number.isFinite(m.get(c))).sort((a, b) => m.get(b) - m.get(a));
    ranked.forEach((c, i) => {
      c.ranks[m.id] = { rank: i + 1, of: ranked.length };
    });
  }
}

const PEER_FEATURES = [
  { get: (c) => (c.pop > 0 ? Math.log10(c.pop) : null), w: 1.6 },
  { get: (c) => (c.income > 0 ? Math.log10(c.income) : null), w: 1 },
  { get: (c) => c.rentBurden, w: 1 },
  { get: (c) => c.ownerPct, w: 1 },
  { get: (c) => c.medianAge, w: 1 },
  { get: (c) => c.builtOld, w: 0.7 },
  { get: (c) => c.multi5, w: 0.7 },
];

export function findPeers(cities, target, n = 5) {
  const stats = PEER_FEATURES.map((f) => {
    const vals = cities.map(f.get).filter(Number.isFinite);
    const mean = vals.reduce((s, x) => s + x, 0) / (vals.length || 1);
    const sd = Math.sqrt(vals.reduce((s, x) => s + (x - mean) ** 2, 0) / (vals.length || 1)) || 1;
    return { mean, sd };
  });
  const z = (c) => PEER_FEATURES.map((f, i) => {
    const v = f.get(c);
    return Number.isFinite(v) ? (v - stats[i].mean) / stats[i].sd : null;
  });
  const zt = z(target);
  if (zt.filter((x) => x != null).length < 3) return [];
  return cities
    .filter((c) => c !== target)
    .map((c) => {
      const zc = z(c);
      let d = 0, used = 0;
      PEER_FEATURES.forEach((f, i) => {
        if (zt[i] == null || zc[i] == null) return;
        d += f.w * (zt[i] - zc[i]) ** 2;
        used += f.w;
      });
      return { c, dist: used >= 3 ? Math.sqrt(d / used) : Infinity };
    })
    .filter((x) => Number.isFinite(x.dist))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n)
    .map((x) => x.c);
}

/* ------------------------------------------------------------ fun facts */

export function funFacts(cities) {
  const facts = [];
  const withPop = cities.filter((c) => c.pop > 0);
  if (!withPop.length) return facts;

  const byPop = [...withPop].sort((a, b) => b.pop - a.pop);
  const largest = byPop[0];
  const smallest = byPop[byPop.length - 1];
  const under5k = withPop.filter((c) => c.pop < 5000).length;

  facts.push({ key: largest.key, text: `${largest.name} is the largest city, with ${fmt.int(largest.pop)} residents.` });
  facts.push({ key: smallest.key, text: `${smallest.name} is the smallest, with ${fmt.int(smallest.pop)}.` });
  facts.push({
    text: `${under5k} of ${withPop.length} cities have fewer than 5,000 residents.`,
  });

  // Rankings among cities big enough, and with an estimate that isn't mostly noise
  const solid = (flag) => (c) => c.pop >= 1000 && !c.flags[flag];
  const top = (arr, get) => arr.reduce((best, c) => (best == null || get(c) > get(best) ? c : best), null);

  const inc = top(cities.filter(solid('income')).filter((c) => c.income != null), (c) => c.income);
  if (inc) facts.push({ key: inc.key, text: `${inc.name} has the highest median household income among cities with 1,000+ residents: ${fmt.usd(inc.income)}.` });

  const rb = top(cities.filter((c) => c.pop >= 1000 && c.rentBurden != null), (c) => c.rentBurden);
  if (rb) facts.push({ key: rb.key, text: `In ${rb.name}, ${fmt.pct(rb.rentBurden)} of renters spend 30% or more of their income on rent.` });

  const old = top(cities.filter((c) => c.pop >= 1000 && c.medianAge != null), (c) => c.medianAge);
  if (old) facts.push({ key: old.key, text: `${old.name} has the oldest population of any city with 1,000+ residents (median age ${fmt.dec1(old.medianAge)}).` });

  const fast = top(cities.filter((c) => c.pop >= 1000 && c.growth != null), (c) => c.growth);
  if (fast) facts.push({ key: fast.key, text: `${fast.name} grew fastest since ${fast.growthFrom} among cities with 1,000+ residents: ${fmt.pctSigned(fast.growth, 1)}.` });

  return facts;
}
