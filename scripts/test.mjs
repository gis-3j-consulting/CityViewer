// Offline sanity tests for the pure data logic (no network, no browser).  Run: node scripts/test.mjs
import assert from 'node:assert/strict';
import {
  normName, slug, prettyName, parseCensusPlaceName, parseCsv, parsePsuCsv,
  buildAcsUrls, mergeAcsResponses, deriveAcs, buildCities, ACS_VAR_GROUPS,
} from '../js/data.js';
import { quantileBreaks, computeRanks, findPeers, funFacts, METRICS, fmt } from '../js/stats.js';
import { barRows, lineChart, stripChart } from '../js/charts.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ', name); };

t('normName handles punctuation, saint/mount, case', () => {
  assert.equal(normName('St. Helens'), 'st helens');
  assert.equal(normName('SAINT HELENS'), 'st helens');
  assert.equal(normName('Mount Angel'), 'mt angel');
  assert.equal(normName('Mt. Angel'), 'mt angel');
  assert.equal(normName('Portland*'), 'portland');
  assert.equal(normName('Bend (part)'), 'bend');
  assert.equal(slug('Lake Oswego'), 'lake-oswego');
  assert.equal(prettyName('MCMINNVILLE'), 'McMinnville');
  assert.equal(prettyName('LAKE OSWEGO'), 'Lake Oswego');
  assert.equal(prettyName('Mt. Angel'), 'Mt. Angel');
});

t('Census place names', () => {
  assert.deepEqual(parseCensusPlaceName('Bend city, Oregon'), { name: 'Bend', type: 'city' });
  assert.deepEqual(parseCensusPlaceName('Johnson City city, Oregon'), { name: 'Johnson City', type: 'city' });
  assert.deepEqual(parseCensusPlaceName('Oregon City city, Oregon'), { name: 'Oregon City', type: 'city' });
  assert.deepEqual(parseCensusPlaceName('Aloha CDP, Oregon'), { name: 'Aloha', type: 'cdp' });
  assert.equal(parseCensusPlaceName('Something else'), null);
});

t('ACS requests stay under the 50-variable limit', () => {
  for (const g of ACS_VAR_GROUPS) assert.ok(g.length + 1 <= 50, `group has ${g.length + 1}`);
  const urls = buildAcsUrls(2024, 'KEY');
  assert.equal(urls.length, 2);
  assert.match(urls[0], /api\.census\.gov\/data\/2024\/acs\/acs5\?/);
  assert.match(urls[0], /&for=place:\*&in=state:41/);
  assert.match(urls[0], /get=NAME,B01003_001E,/);
  assert.match(urls[0], /key=KEY/);
});

// Build a synthetic ACS record where every number is easy to verify.
function mockResponses(places) {
  const [g1, g2] = ACS_VAR_GROUPS;
  const mk = (vars, valueFor) => {
    const header = ['NAME', ...vars, 'state', 'place'];
    const rows = places.map((p) => [p.name, ...vars.map((v) => valueFor(p, v)), '41', p.fips]);
    return [header, ...rows];
  };
  const val = (p, v) => (p.values[v] !== undefined ? p.values[v] : p.defaults ?? 0);
  return [mk(g1, val), mk(g2, val)];
}

const bendValues = {
  B01003_001E: 100000, B01002_001E: 36.5,
  B19013_001E: 80000, B19013_001M: 3000,
  B25077_001E: 550000, B25077_001M: 20000,
  B25064_001E: 1700, B25064_001M: 900,           // wide MOE -> flagged
  B25003_001E: 1000, B25003_002E: 600, B25003_003E: 400,
  B25002_001E: 1100, B25002_002E: 1000, B25002_003E: 100,
  B25070_001E: 400, B25070_007E: 40, B25070_008E: 30, B25070_009E: 50, B25070_010E: 80, B25070_011E: 0,
  B25034_001E: 1000, B25034_002E: 50, B25034_003E: 150, B25034_004E: 200, B25034_005E: 200, B25034_006E: 100,
  B25034_007E: 100, B25034_008E: 100, B25034_009E: 50, B25034_010E: 25, B25034_011E: 25,
  B25024_001E: 1000, B25024_002E: 600, B25024_003E: 50, B25024_004E: 50, B25024_005E: 50, B25024_006E: 50,
  B25024_007E: 50, B25024_008E: 50, B25024_009E: 50, B25024_010E: 50, B25024_011E: 0,
  // ages: 1000 people, 10 per age-cell on the male side (23 cells) and 10 on female side
  B01001_001E: 460,
};
for (let i = 3; i <= 25; i++) bendValues[`B01001_${String(i).padStart(3, '0')}E`] = 10;
for (let i = 27; i <= 49; i++) bendValues[`B01001_${String(i).padStart(3, '0')}E`] = 10;

t('mergeAcsResponses + deriveAcs compute the right numbers', () => {
  const places = mergeAcsResponses(mockResponses([
    { name: 'Bend city, Oregon', fips: '05800', values: bendValues },
    { name: 'Missing city, Oregon', fips: '99999', values: { B01003_001E: -666666666, B19013_001E: -222222222 } },
  ]));
  assert.equal(places['4105800'].B01003_001E, 100000);
  assert.equal(places['4199999'].B01003_001E, null);   // sentinel -> null
  assert.equal(places['4199999'].B19013_001E, null);

  const d = deriveAcs(places['4105800']);
  assert.equal(d.ownerPct, 60);
  assert.equal(d.vacancy, (100 / 1100) * 100);
  assert.equal(d.rentBurden, 50);                    // (40+30+50+80)/400
  assert.equal(d.severeBurden, 20);
  assert.equal(d.builtOld, 30);                      // (100+100+50+25+25)/1000
  assert.equal(d.built[0].value, 20);                // 2010+ : 50+150
  assert.equal(d.multi5, 20);                        // 6..9 = 4*50
  assert.equal(d.mix[0].value, 65);                  // 600+50
  // age bands: each of the 460 people-cells are 10 => under 18 = 4 cells *2 sexes *10 = 80
  assert.equal(Math.round(d.ages[0].value * 460 / 100), 80);
  assert.equal(d.ages.length, 5);
  const ageSum = d.ages.reduce((s, a) => s + a.value, 0);
  assert.ok(Math.abs(ageSum - 100) < 1e-9, `age bands sum to ${ageSum}`);
  assert.equal(d.flags.rent, true);                  // 900/1700 > 0.25
  assert.equal(d.flags.income, false);
});

t('parseCsv handles quotes, CRLF, BOM', () => {
  const rows = parseCsv('\uFEFFa,b\r\n"x, y",2\r\n"he said ""hi""",3\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', '2'], ['he said "hi"', '3']]);
});

t('parsePsuCsv: tidy file', () => {
  const r = parsePsuCsv('city,2020,2025\nBend,"99,178","107,079"\nSisters,3000,3834\n');
  assert.equal(r.series.get('bend').at(-1).value, 107079);
  assert.equal(r.series.get('sisters')[0].year, 2020);
});

t('parsePsuCsv: messy PSU-style file (title rows, counties, totals, footnotes, multi-county dupes)', () => {
  const csv = [
    'Oregon Certified Population Estimates,,,,',
    'Prepared by PSU,,,,',
    ',,,,',
    'Area,Census 2020,July 1 2023,July 1 2024,"July 1, 2025 certified"',
    'Oregon,"4,237,256","4,233,358","4,244,795","4,250,000"',
    'Deschutes County,"198,253","205,000","210,000","215,000"',
    'Bend,"99,178","103,000","105,000","107,079"',
    'Redmond*,"33,000","36,000","37,000","38,000"',
    'Unincorporated,"60,000","61,000","62,000","63,000"',
    'Hood River County,"23,000","23,100","23,200","23,300"',
    'Hood River,"8,300","8,500","8,600","8,633"',
    'Total Cities,"1","2","3","4"',
    'Umatilla (part),"100","110","120","130"',
    'Umatilla,"7,363","8,000","8,300","8,617"',
    'Umatilla,"500","510","520","530"',
  ].join('\n');
  const r = parsePsuCsv(csv);
  assert.deepEqual(r.years, [2020, 2023, 2024, 2025]);
  assert.equal(r.series.get('bend').at(-1).value, 107079);
  assert.equal(r.series.get('redmond').at(-1).value, 38000);
  assert.equal(r.series.has('deschutes county'), false);
  assert.equal(r.series.has('oregon'), false);
  assert.equal(r.series.has('unincorporated'), false);
  assert.equal(r.series.get('umatilla').at(-1).value, 8617);   // whole-city row beats split rows
  assert.equal(r.series.get('hood river').at(-1).value, 8633);
});

t('parsePsuCsv reports a useful error when no year columns', () => {
  const r = parsePsuCsv('city,population\nBend,100\n');
  assert.ok(r.error);
});

// A tiny three-city world
const square = (x, y, s = 0.1) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];
const geojson = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { CITY_NAME: 'BEND', acres: 20000 }, geometry: { type: 'Polygon', coordinates: square(-121.4, 44.0, 0.2) } },
    { type: 'Feature', properties: { CITY_NAME: 'BEND', acres: 100 }, geometry: { type: 'Polygon', coordinates: square(-121.1, 44.0, 0.01) } },
    { type: 'Feature', properties: { CITY_NAME: 'ST. HELENS', acres: 3000 }, geometry: { type: 'Polygon', coordinates: square(-122.8, 45.8) } },
    { type: 'Feature', properties: { CITY_NAME: 'Nowhere', acres: null }, geometry: { type: 'Polygon', coordinates: square(-120.0, 43.0) } },
  ],
};
const acsPlaces = mergeAcsResponses(mockResponses([
  { name: 'Bend city, Oregon', fips: '05800', values: bendValues },
  { name: 'St. Helens city, Oregon', fips: '65000', values: { ...bendValues, B01003_001E: 14000, B19013_001E: 70000, B25003_002E: 700, B25003_003E: 300 } },
  { name: 'Aloha CDP, Oregon', fips: '00850', values: bendValues },
  { name: 'Ghost city, Oregon', fips: '31000', values: bendValues },
]));

t('buildCities joins sources, dissolves multipart cities, computes density', () => {
  const psu = parsePsuCsv('city,2020,2025\nBend,"99,178","107,079"\nSt. Helens,"13,000","14,552"\n');
  const out = buildCities({ geojson, acs: { year: 2024, places: acsPlaces }, psu });
  assert.equal(out.cities.length, 3);
  const bend = out.byKey.get('bend');
  assert.equal(bend.name, 'Bend');
  assert.equal(bend.acres, 20100);
  assert.equal(bend.pop, 107079);
  assert.equal(bend.popYear, 2025);
  assert.ok(Math.abs(bend.growth - 7.97) < 0.05);
  assert.equal(bend.growthFrom, 2020);
  assert.ok(Math.abs(bend.density - 107079 / (20100 / 640)) < 1e-6);
  assert.equal(bend.hasAcs, true);
  assert.equal(out.byKey.get('st-helens').pop, 14552);       // joined across "ST. HELENS" / "St. Helens city"
  const nowhere = out.byKey.get('nowhere');
  assert.equal(nowhere.hasAcs, false);
  assert.ok(nowhere.acres > 0, 'acres computed from geometry when missing');
  assert.equal(out.polys.features.length, 4);
  assert.equal(out.points.features.length, 3);
  assert.deepEqual(out.status.summary.unmatchedLimits, ['Nowhere']);
  assert.deepEqual(out.status.summary.unmatchedAcs, ['Ghost']);
  assert.equal(out.status.summary.acsCdpCount, 1);
  assert.equal(out.hasGrowth, true);
});

t('buildCities without PSU falls back to ACS population and has no growth', () => {
  const out = buildCities({ geojson, acs: { year: 2024, places: acsPlaces }, psu: null });
  assert.equal(out.byKey.get('bend').pop, 100000);
  assert.match(out.byKey.get('bend').popSource, /2020-2024/);
  assert.equal(out.hasGrowth, false);
});

t('buildCities works with no ACS at all', () => {
  const out = buildCities({ geojson, acs: null, psu: null });
  assert.equal(out.cities.length, 3);
  assert.equal(out.byKey.get('bend').pop, null);
});

t('stats: breaks, ranks, peers, facts, formatting', () => {
  // 60 synthetic cities
  const cities = Array.from({ length: 60 }, (_, i) => ({
    key: 'c' + i, name: 'City ' + i, pop: 500 + i * 900, density: 300 + i * 20, income: 40000 + i * 1200, rentBurden: 30 + (i % 20),
    ownerPct: 50 + (i % 30), medianAge: 30 + (i % 25), builtOld: 20 + (i % 40), multi5: i % 15, growth: -5 + i * 0.4,
    growthFrom: 2020, rent: 900 + i * 15, homeValue: 200000 + i * 8000, vacancy: 3 + (i % 9), age65: 10 + (i % 20),
    flags: { income: false, homeValue: false, rent: false }, ranks: {},
  }));
  const br = quantileBreaks(cities.map((c) => c.pop), 6);
  assert.equal(br.length, 5);
  assert.ok(br.every((b, i) => i === 0 || b > br[i - 1]));
  computeRanks(cities);
  assert.equal(cities[59].ranks.pop.rank, 1);
  assert.equal(cities[0].ranks.pop.rank, 60);
  const peers = findPeers(cities, cities[30], 5);
  assert.equal(peers.length, 5);
  assert.ok(!peers.includes(cities[30]));
  const facts = funFacts(cities);
  assert.ok(facts.length >= 6);
  assert.match(facts[0].text, /City 59/);
  assert.equal(fmt.usdK(412300), '$412k');
  assert.equal(fmt.usdK(1450), '$1,450');
  assert.equal(fmt.intK(1200000), '1.2M');
  assert.equal(fmt.pctSigned(-3.14159, 1), '−3.1%');

  // charts return markup for every metric without throwing
  for (const m of METRICS) {
    const html = stripChart(cities, m, cities[10]);
    assert.ok(html.includes('<svg') || html.includes('Not enough'), m.id);
  }
  assert.match(lineChart([{ year: 2020, value: 10 }, { year: 2021, value: 12 }, { year: 2025, value: 15 }]), /<svg/);
  assert.match(barRows([{ label: 'A', value: 50 }, { label: 'B', value: null }]), /bar-row/);
});

console.log(`\n${n} test groups passed`);
