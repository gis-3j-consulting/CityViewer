// Saves snapshots of the two live sources into /data so the deployed site doesn't depend on
// the State's ArcGIS server or the Census API being reachable (or rate-limiting) at the conference.
//
//   node scripts/build-data.mjs              # needs Node 18+ and internet access
//   CENSUS_KEY=xxxx node scripts/build-data.mjs
//
// Writes:  data/city_limits.geojson   data/acs_places.json
// The app uses these files when present and falls back to the live services when they are not.

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CONFIG } from '../js/config.js';
import { fetchCityLimitsLive, fetchAcsLive } from '../js/data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const key = process.env.CENSUS_KEY || CONFIG.censusKey;

await mkdir(dataDir, { recursive: true });
let failures = 0;

// 1. city limits
try {
  console.log('Fetching city limits…');
  const gj = await fetchCityLimitsLive();
  const file = path.join(dataDir, 'city_limits.geojson');
  await writeFile(file, JSON.stringify(gj));
  console.log(`  ${gj.features.length} polygons -> data/city_limits.geojson (${(JSON.stringify(gj).length / 1e6).toFixed(2)} MB)`);
} catch (e) {
  failures++;
  console.error('  City limits failed:', e.message);
}

// 2. ACS
let saved = false;
for (const year of CONFIG.acsYears) {
  try {
    console.log(`Fetching ACS 5-year ${year}…`);
    const places = await fetchAcsLive(year, key);
    const n = Object.keys(places).length;
    if (!n) throw new Error('no places returned');
    await writeFile(path.join(dataDir, 'acs_places.json'), JSON.stringify({ year, fetched: new Date().toISOString(), places }));
    console.log(`  ${n} Oregon places -> data/acs_places.json`);
    saved = true;
    break;
  } catch (e) {
    console.error(`  ACS ${year} failed:`, e.message);
  }
}
if (!saved) failures++;

if (failures) {
  console.error(`\n${failures} source(s) failed. The app will fall back to live services for those.`);
  process.exitCode = 1;
}
