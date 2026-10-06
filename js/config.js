// Everything you might want to change lives here.

export const CONFIG = {
  title: 'Oregon Cities Explorer',

  // Census ACS 5-year vintages to try, newest first. 2024 = the 2020-2024 release.
  acsYears: [2024, 2023],

  // Optional free key from https://api.census.gov/data/key_signup.html
  // Without one the Census API allows ~500 requests/day per IP address, which a
  // whole conference room on shared wifi can burn through. Run
  // `node scripts/build-data.mjs` to bake a snapshot into /data and the app
  // will use that instead of calling the API from every visitor's browser.
  censusKey: '',

  cityLimits: {
    // ODOT/State of Oregon "City Limits" feature service (layer 0).
    queryUrl: 'https://maps.dsl.state.or.us/arcgis/rest/services/CityLimits/FeatureServer/0/query',
    nameField: 'CITYNAME',
    acresField: 'acres',
    // Server-side generalization, in degrees (~0.0004 deg is about 40 m).
    // Keeps the statewide download small. Lower = more detail, bigger file.
    simplifyDegrees: 0.0004,
  },

  // Files the app looks for first. If they are missing it falls back to live services
  // (city limits, ACS). The PSU file has no live fallback.
  local: {
    cityLimits: 'data/city_limits.geojson',
    acs: 'data/acs_places.json',
    psu: 'data/psu_population.csv',
  },

  basemaps: {
    light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  },

  // Manual name fixes for joins between sources. Keys and values are
  // *normalized* names (lowercase, no punctuation, "saint"->"st", "mount"->"mt").
  // Example: { 'mount hood village': 'mt hood village' }
  // The "Data & sources" dialog lists any city that failed to match.
  aliases: {},

  psu: {
    // Zero-based column index holding the city name. null = auto-detect.
    nameColumn: null,
  },
};
