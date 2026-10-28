# HomeScope

A free website that sizes up any US zip code before you buy a home. You type a zip code and say what the home is for (to live in, as a rental, to live in part and rent out part, or as an Airbnb), and the page pulls together what you need to decide:

- **Forecast:** a machine-learning model trained on every US zip predicts price changes 1, 3 and 5 years ahead with a low / likely / high range. It learns from price trends, mortgage and Fed rates, the stock market, income, rents, jobs, education, renters, the buyer/seller market, crime, natural hazards, politics, landlord law and insurance. The page also shows how well it predicted 2022 to 2026 when it was trained only on older data, side by side with simply extending the past trend.
- **Prices:** about 50 years of home price history for the zip (FHFA index back to 1975, scaled to Zillow's dollar values) and typical values by type, with an option to show everything after inflation.
- **Buyer's or seller's market:** months of supply, days to sell, sale price vs asking, share sold above asking and price cuts, now and a year ago (Redfin).
- **Rates and buying power:** mortgage rates since 1971 and the Fed's rate since 2000, how much home you can afford if rates move up or down, and a 5 / 10 / 15 / 20% down payment comparison showing cash needed, mortgage insurance and the monthly payment.
- **Monthly cost:** loan, property tax at the zip's own effective rate, insurance, mortgage insurance, HOA (typical condo fee from listings), upkeep and typical electric and gas bills.
- **Best time to buy:** a month-by-month comparison of buying now, in 1 to 5 years, or renting, using your income, savings and rent.
- **Investing:** cap rate, cash flow and cash-on-cash return for long-term or short-term renting, and the numbers for living in one part and renting the other.
- **Neighborhood:** income, education, poverty and unemployment now versus 10 years earlier, renters, housing mix, a gentrification check, and how the zip compares with the zips within 5 miles of it.
- **Natural hazards and the building:** FEMA's National Risk Index (flood, wildfire, hurricane, tornado, earthquake, heat and more), the expected yearly damage on the selected home, and what to check for the age of homes in the area.
- **Politics and law:** county and state presidential results since 2000, plus state rent control rules, just-cause eviction rules and eviction notice periods.
- **Vaastu and Feng Shui:** every listing gets a Vaastu score from what the street map shows (which way it faces, whether a street points at it), and you can filter and sort by it. Shortlisted homes get the full room-by-room Vaastu score and a Feng Shui checklist. A sun-path chart for the zip shows how light falls on each side of a house.
- **Commute, walkability and noise:** drive time from each home to your work or school address, the everyday places within a 10-minute walk of each listed home (groceries, parks, transit, pharmacies, cafes, schools), and nearby highways, railways and airports.
- **Jobs and internet:** county jobs growth over 5 years and average pay (Census County Business Patterns), and the share of homes with broadband.
- **Schools:** the school district's grade (A to F, from Stanford's nationally comparable test scores) and the nearest public schools with size, students per teacher and state test results.
- **Homes you can buy:** homes for sale and for rent in your watchlist zips, filtered to what you can afford, each with its estimated facing direction and Vaastu / Feng Shui notes, plus the property record (year built, roof, exterior and foundation type, tax assessments, last sale) for specific addresses you add.

Your own numbers (income, savings and so on) are only stored in your browser and never leave your device.

## How it works

Everything runs on GitHub for free. A GitHub Action runs once a day, downloads the public datasets, trains the forecast model, builds small data files for every zip code and publishes the site with GitHub Pages. The page itself is plain HTML and JavaScript with no server.

```
pipeline/build_data.py      downloads and joins the public data, writes site/data/
pipeline/forecast.py        the machine-learning forecast and its 2022-2026 test
pipeline/extras.py          location, surrounding area, hazards, market, Fed rate, utilities
pipeline/fetch_listings.py  listings for watchlist.txt (Realtor.com) and house lookups for inspect.txt
pipeline/orient.py          estimates which way each listed home faces from OpenStreetMap
pipeline/states.csv         hand-kept state table: landlord-tenant law and car insurance
site/                       the website (index.html, app.js, calc.js, style.css)
logs/last-build.txt         output of the latest daily build, to see what worked
```

## Setup

1. Create a **public** repository on GitHub and upload these files, keeping the folders (GitHub Pages is free for public repos).
2. In the repo, go to **Settings > Pages** and set **Source** to **GitHub Actions**.
3. Add these under **Settings > Secrets and variables > Actions**:
   - `CENSUS_API_KEY` (required): a free key from https://api.census.gov/data/key_signup.html.
   - `RENTCAST_API_KEY` (optional): a key from https://app.rentcast.io/app/api (the free plan gives 50 calls a month), used for house lookups and as a backup listings source.
4. Go to **Actions > Build and deploy > Run workflow**. The first run takes about 30 to 45 minutes because it downloads everything and trains the model, and the site appears at `https://<your-username>.github.io/<repo-name>/`.

After that it rebuilds itself every day. You can also link straight to a zip with `?zip=43201` at the end of the address.

## Listings and house lookups

Homes for sale and for rent in the zips on `watchlist.txt` (up to 30) are pulled every day from Realtor.com through [HomeHarvest](https://github.com/ZacharyHampton/HomeHarvest), a free open-source library that needs no key. It reads Realtor.com's site, which their terms of use don't allow, so it can stop working if they block it; this project is for personal use. If it fails, RentCast is used as a backup (weekly, up to 5 zips) when `RENTCAST_API_KEY` is set. Each address in `inspect.txt` gets one RentCast property-record lookup the first time and is then kept, with at most 3 new addresses per day. Saved listings and lookups are committed back to the repo so they survive the daily rebuild.

Each listed home's facing direction is estimated from OpenStreetMap streets (the direction from the house to its nearest street), which drives the per-house Vaastu and Feng Shui notes.

## How fresh the data is

The site rebuilds daily, but each source publishes on its own schedule, and every section of the page shows its own "as of" date.

| Data | Source | Updates |
|---|---|---|
| Mortgage rates | Freddie Mac | weekly (Thursdays) |
| Fed funds rate | Federal Reserve Bank of New York | daily |
| Inflation (CPI) | Bureau of Labor Statistics | monthly |
| Stock market (S&P 500) | Stooq or the open S&P 500 dataset | monthly |
| Listings | Realtor.com via HomeHarvest (RentCast as backup) | daily |
| House records (inspect.txt) | RentCast | on request |
| Streets, places and noise sources near listings | OpenStreetMap (Overpass) | daily |
| Address lookup and drive times | OpenStreetMap Nominatim and OSRM, called from your browser | when you set a work address |
| County jobs and pay | Census County Business Patterns | yearly |
| Home values, rents, Zillow's 1-year forecast | Zillow Research | monthly (around the 16th) |
| Buyer/seller market | Redfin Data Center | monthly |
| 50-year zip price index | FHFA | yearly |
| Income, renters, education, housing mix, property tax, utility bills | Census ACS 5-year | yearly |
| Natural hazards | FEMA National Risk Index | every year or two |
| School district scores | Stanford Education Data Archive (SEDA 2025.1) | yearly |
| School directory and test results | Urban Institute Education Data Portal (NCES / EDFacts) | yearly (test results 2018-19) |
| Violent crime (county) | County Health Rankings | yearly |
| Presidential results | MIT Election Data and Science Lab | every 4 years |
| Rent control, just cause, notice periods | NAA, NLIHC, Nolo (in `pipeline/states.csv`) | checked by hand, Oct 2026 |
| Car insurance | NAIC state averages | 2024, updated by hand |

## Limits worth knowing

- The forecast is a statistical model, not a promise. Its track record on 2022 to 2026 is shown on the page so you can judge it, and it can't see shocks that haven't happened yet.
- FHFA's long index covers single-family homes bought with standard (Fannie Mae / Freddie Mac) mortgages, and some small zips have gaps.
- Crime is county-level and car insurance is a state average, because finer free data doesn't exist nationally.
- Roof age, structural condition and building materials of a specific house aren't in public data. A home inspection covers these; RentCast's property record has some of them for addresses in `inspect.txt`.
- Listing sites don't tag styles like villa or bungalow, so homes are grouped by building type and by price tier within the zip.
- Laws change. The state table was checked in October 2026; confirm local rules (rent control, short-term rental permits) with the city before acting.
- Vaastu and Feng Shui checks are traditional guidance and are kept separate from the price, risk and forecast numbers.
- Nothing here is financial or legal advice.

## Running it on your own computer

```
pip install -r pipeline/requirements.txt
export CENSUS_API_KEY=your-key
python pipeline/build_data.py
python -m http.server --directory site 8000
```

Then open http://localhost:8000. Downloads are kept in `raw/` so later runs are faster, and `--offline` rebuilds using only what's already there.

## Not built yet

County job and layoff data (BLS and state WARN notices), land values (FHFA land price estimates), building-code adoption by county (FEMA BCAT), and internet speeds by address (FCC National Broadband Map, needs a free FCC account) are the natural next additions.

## License

Copyright (c) 2026 Divya Chari. The code is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md): you can use, copy and change it for personal, research, educational and other noncommercial purposes, and commercial use needs written permission. Third-party software and data keep their own terms; see [NOTICE.md](NOTICE.md), which also has the attributions and the disclaimer.
