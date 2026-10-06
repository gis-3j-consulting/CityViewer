# Oregon Cities Explorer

An interactive map of Oregon's incorporated cities. Click a city (or search for it) to see population,
growth, density, income, housing costs, housing mix, age profile and which other Oregon cities look most like it.
Static site: no server, no build step, deploys straight to GitHub Pages.

## Run it locally

Browsers block data requests from `file://`, so serve the folder:

```bash
python3 -m http.server 8000      # then open http://localhost:8000
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repo (default branch `main`).
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` publishes on every push, on demand, and monthly.

Each deploy first runs `scripts/build-data.mjs`, which saves fresh snapshots of the city limits and Census
data into the published site. If a source is down, that step fails softly and the app calls the live service instead.
Optional: add a repository secret called `CENSUS_KEY` (free key from api.census.gov) for a higher rate limit.

## Where the data comes from

| What | Source | How it is loaded |
|---|---|---|
| City boundaries | State of Oregon / ODOT *City Limits* layer | `data/city_limits.geojson` if present, otherwise queried live from the ArcGIS REST service |
| Income, rent, home value, tenure, housing age and types, age, rent burden | Census ACS 5-year (2020–2024), places in Oregon | `data/acs_places.json` if present, otherwise the Census API |
| Official population and population change | Portland State University Population Research Center, certified estimates (Vintage 2025) | `data/psu_population.csv`, included; refresh with `scripts/psu_xlsx_to_csv.py` (see `data/README.md`) |

Without the PSU file the app would still work: population comes from the ACS estimate and the "Population change" layer
and trend chart are switched off.

Density is population divided by square miles inside city limits. "Similar cities" uses nearest neighbors on
population, income, rent burden, homeownership, median age, older homes and multifamily share.

## If the map says the data didn't load

"Failed to fetch" means the browser couldn't reach the State's live city limits service (blocked, offline, or the
server doesn't allow requests from web pages). Skip the live service by saving a copy in the repo:

1. Open https://geohub.oregon.gov/datasets/oregon-geo::city-limits, click **Download**, choose **GeoJSON**.
2. Save it as `data/city_limits.geojson` in the repo. GitHub's web upload accepts files up to 25 MB.
   If the file is bigger, open it at https://mapshaper.org, click **Simplify** (keep roughly 10 to 20 percent),
   then **Export → GeoJSON**.
3. Commit. The site redeploys and uses the saved copy.

The file needs a city name column (`CITY_NAME` is expected; other obvious names are detected) and ideally `acres`.
Another option for a GIS team: publish the layer as a public hosted feature layer on ArcGIS Online and point
`cityLimits.queryUrl` in `js/config.js` at its `/query` URL. Those services allow web page requests.

## If the map loads but no cities are drawn

The app checks itself: if boundaries loaded but none render, a yellow banner appears. Open **Data and sources →
Map diagnostics** to see the file's coordinate system, its extent (it should fall inside Oregon), which layers were
added and any messages from the map library. Files in Oregon Lambert feet (EPSG:2992) or Web Mercator are converted
automatically; anything else needs re-exporting as lon/lat GeoJSON (WGS84).

## Important: Census snapshot before the conference

The Census API allows roughly 500 keyless requests per day per IP address, and each visitor's browser makes two.
A room full of people on the same wifi can hit that. Run `node scripts/build-data.mjs` once (or let the GitHub
Action do it) so visitors load a static file instead.

## Files

```
index.html            page shell
img/                  3J logo and favicon
css/style.css         all styling (light and dark follow the system setting)
js/config.js          URLs, vintages, name aliases: the one file you may need to edit
js/data.js            loading, parsing and joining the three sources
js/stats.js           metrics, rankings, similar-city matching, quick facts
js/charts.js          small SVG/HTML charts
js/main.js            map, search, panel
scripts/build-data.mjs  saves data snapshots   |   scripts/test.mjs  offline tests (npm test)
scripts/psu_xlsx_to_csv.py  converts PSU's workbook to data/psu_population.csv
```

## When names don't match

Sources spell cities slightly differently. Names are normalized (case, punctuation, "St."/"Saint", "Mt."/"Mount"),
and anything that still fails to match is listed under **Data and sources** in the app. Fix it by adding a line to
`aliases` in `js/config.js`.

## Ideas not built yet

Side-by-side city comparison, a kiosk mode that cycles through cities, a population "growth race" animation,
and housing production vs. state target (OHCS/DLCD data; needs a source file).
