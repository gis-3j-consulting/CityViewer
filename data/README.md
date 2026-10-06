# data/

Everything here is optional. The app looks for these files first and falls back to live services where it can.

| File | Created by | Used for |
|---|---|---|
| `city_limits.geojson` | `node scripts/build-data.mjs` | boundaries (skips the live ArcGIS query) |
| `acs_places.json` | `node scripts/build-data.mjs` | Census figures (skips the live Census API) |
| `psu_population.csv` | **you** | official population and population change |

## psu_population.csv

Download from the PSU Population Research Center's *Population Estimate Reports* page
(https://www.pdx.edu/population-research/population-estimate-reports), choose the CSV versions of
*Certified Population Estimates* and/or the *Annual Population Report Tables*, and save as `data/psu_population.csv`.

The loader is tolerant. It needs:

- one column with the city name
- one column per year, with the year in the header (`2020`, `July 1, 2025`, `Census 2020`, `2025 certified` all work)
- numbers may contain commas

It skips title rows, county rows, "Oregon", "Total" and "Unincorporated" rows, strips footnote markers like `*`,
and when a city appears more than once (cities that span counties) it keeps the larger row.
Columns that mention change, percent or growth are ignored.

**Population change** is calculated from the first to the last year column, so include at least two years
(for example 2020 and 2025) to turn on the growth layer, the "since 2020" badge and the trend chart.
If the PSU workbook splits years across several sheets or tables, merge them into one sheet with a city column and
year columns first. `psu_population.EXAMPLE.csv` shows the simplest layout.

After adding the file, open the app and check **Data and sources**: it reports rows read, years found, and how many
cities matched.
