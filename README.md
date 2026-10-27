# House Check

A free website that sizes up any US zip code before you buy a home. You type a zip code and say what the home is for (to live in, as a rental, to live in part and rent out part, or as an Airbnb), and the page pulls together what you need to decide:

- **Prices:** about 50 years of home price history for the zip (FHFA index back to 1975, scaled to Zillow's dollar values), typical values by type (house, condo, starter, upper-end), with an option to show everything after inflation.
- **Rates and buying power:** mortgage rates since 1971, how far rates usually move in a year, and how much home you can afford if rates move up or down by 1 or 2 points.
- **Monthly cost:** loan, property tax (the zip's own rate), insurance, mortgage insurance, HOA and upkeep.
- **Outlook and timing:** a low / middle / high price range built from every past stretch of the zip's own history, and a month-by-month comparison of buying now, in 1 to 5 years, or renting, based on your income, savings and rent.
- **Investing:** cap rate, cash flow and cash-on-cash return for long-term or short-term renting, and the numbers for living in one part and renting the other.
- **Neighborhood:** income, education, poverty and unemployment now versus 10 years earlier, renter share, rental vacancy, housing mix, a gentrification check, county violent crime and the state's average car insurance cost.
- **Politics and law:** county and state presidential results since 2000, plus state rent control rules, just-cause eviction rules and eviction notice periods.
- **Listings:** homes for sale and for rent from RentCast for a short watchlist of zips, grouped by type and price tier, with the monthly cost and rental cash flow of each.

Your own numbers (income, savings and so on) are only stored in your browser and never leave your device.

## How it works

Everything runs on GitHub for free. A GitHub Action runs once a day, downloads the public datasets, builds small data files for every zip code and publishes the site with GitHub Pages. The page itself is plain HTML and JavaScript with no server.

```
pipeline/build_data.py      downloads and joins the public data, writes site/data/
pipeline/fetch_listings.py  pulls RentCast listings for the zips in watchlist.txt
pipeline/states.csv         hand-kept state table: landlord-tenant law and car insurance
site/                       the website (index.html, app.js, calc.js, style.css)
watchlist.txt               zips to pull live listings for
.github/workflows/build.yml the daily build and deploy
```

## Setup

1. Create a new **public** repository on GitHub and upload these files (GitHub Pages is free for public repos).
2. In the repo, go to **Settings > Pages** and set **Source** to **GitHub Actions**.
3. Optional but recommended, add these under **Settings > Secrets and variables > Actions**:
   - `CENSUS_API_KEY`: a free key from https://api.census.gov/data/key_signup.html, so Census requests aren't rate limited.
   - `RENTCAST_API_KEY`: a key from https://app.rentcast.io/app/api (the free plan gives 50 calls a month). Without it the site works, just without live listings.
4. Go to **Actions > Build and deploy > Run workflow**. The first run takes about 10 to 15 minutes, and the site appears at `https://<your-username>.github.io/<repo-name>/`.

After that it rebuilds itself every day. You can also link straight to a zip with `?zip=43201` at the end of the address.

## Listings and the free RentCast plan

Each zip on the watchlist costs 2 RentCast calls (one for sale, one for rent). The script only refreshes a zip once it's 6 days old and uses at most 6 zips, which keeps a month under the free 50 calls. Saved listings are committed back to the repo so they survive the daily rebuild. To track different zips, edit `watchlist.txt`. A paid RentCast plan would allow daily refreshes and more zips; change `REFRESH_DAYS` and `MAX_ZIPS` at the top of `pipeline/fetch_listings.py` if you upgrade.

## How fresh the data is

The site rebuilds daily, but each source publishes on its own schedule, and every section of the page shows its own "as of" date.

| Data | Source | Updates |
|---|---|---|
| Mortgage rates | Freddie Mac via FRED | weekly (Thursdays) |
| Listings | RentCast | weekly on the free plan |
| Home values, rents, 1-year forecast | Zillow Research | monthly (around the 16th) |
| 50-year zip price index | FHFA | yearly |
| Income, renters, education, housing mix, property tax | Census ACS 5-year | yearly |
| Violent crime (county) | County Health Rankings | yearly |
| Presidential results | MIT Election Data and Science Lab | every 4 years |
| Rent control, just cause, notice periods | NAA, NLIHC, Nolo (in `pipeline/states.csv`) | checked by hand, Oct 2026 |
| Car insurance | NAIC state averages | 2024, updated by hand |

## Limits worth knowing

- The price range for future years is built from the zip's own past, not a forecast model. It shows what has happened before, not what will happen.
- FHFA's long index covers single-family homes bought with standard (Fannie Mae / Freddie Mac) mortgages, and some small zips have gaps.
- Crime is county-level and car insurance is a state average, because finer free data doesn't exist nationally.
- Listing sites don't tag styles like villa or bungalow, so homes are grouped by building type and by price tier within the zip.
- Laws change. The state table was checked in October 2026; confirm local rules (rent control, short-term rental permits) with the city before acting.
- Nothing here is financial or legal advice.

## Running it on your own computer

```
pip install -r pipeline/requirements.txt
python pipeline/build_data.py
python -m http.server --directory site 8000
```

Then open http://localhost:8000. Downloads are kept in `raw/` so later runs are faster, and `--offline` rebuilds using only what's already there.

## Not built yet

School ratings (Stanford Education Data Archive or state report cards), county job and layoff data (BLS and state WARN notices), and land values (FHFA land price estimates) are the natural next additions.
