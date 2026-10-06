# data/

Everything here is optional. The app looks for these files first and falls back to live services where it can.

| File | Created by | Used for |
|---|---|---|
| `city_limits.geojson` | `node scripts/build-data.mjs` | boundaries (skips the live ArcGIS query) |
| `acs_places.json` | `node scripts/build-data.mjs` | Census figures (skips the live Census API) |
| `psu_population.csv` | `scripts/psu_xlsx_to_csv.py` | official population and population change (included: PSU 2025 certified estimates) |

## psu_population.csv

Included: PSU's **Vintage 2025 certified estimates** (certified December 15, 2025; Hillsboro and Mill City revised
April 15, 2026), July 1 estimates for 2020 through 2025 for all 241 cities. "Population change" in the app is
2020 to 2025.

To refresh it when PSU publishes new numbers, download the workbook from the *Population Estimate Reports* page
(https://www.pdx.edu/population-research/population-estimate-reports) and run:

```bash
pip install openpyxl
python3 scripts/psu_xlsx_to_csv.py path/to/Certified_Population_Estimates.xlsx
```

That rewrites `data/psu_population.csv`. You can also supply any CSV of your own: one column of city names, one column
per year with the year in the header (`2020`, `July 1, 2025` and `Census 2020` all work). The loader skips title,
county, "Oregon", "Total" and "Unincorporated" rows, strips footnote markers, keeps the larger row when a city appears
twice, and ignores columns that mention change, percent or growth. The first and last year columns drive the change figure.

After changing the file, open the app and check **Data and sources**: it reports rows read, years found and how many
cities matched.
