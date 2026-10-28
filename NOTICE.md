# Notices

Copyright (c) 2026 Divya Chari. The HomeScope code (everything in `pipeline/` and `site/` except `site/vendor/`) is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). You may use, copy and change it for noncommercial purposes; any commercial use needs written permission from the copyright holder.

That license covers only this project's own code and text. The third-party software and data listed below keep their own licenses and terms.

## Third-party software

| Software | Use | License |
|---|---|---|
| [Chart.js](https://www.chartjs.org) 4.4.1, copyright (c) 2023 Chart.js Contributors | bundled in `site/vendor/` | MIT |
| [HomeHarvest](https://github.com/ZacharyHampton/HomeHarvest) | listings download (installed, not bundled) | MIT |
| [pandas](https://pandas.pydata.org), [NumPy](https://numpy.org), [scikit-learn](https://scikit-learn.org) | data processing and the forecast model | BSD 3-Clause |
| [Requests](https://requests.readthedocs.io) | downloads | Apache 2.0 |
| [openpyxl](https://openpyxl.readthedocs.io) | reading Excel files | MIT |

## Data sources and attribution

Every source the site uses, with a link to where it comes from and the terms it is used under.

| Data | Provider and link | Terms |
|---|---|---|
| Home value and rent indexes, 1-year forecast | Zillow Research: [ZHVI, ZORI, ZHVF](https://www.zillow.com/research/data/) | [Zillow terms of use](https://www.zillow.com/z/corp/terms/); attribution to Zillow |
| Zip-code house price index | Federal Housing Finance Agency: [HPI at the zip level](https://www.fhfa.gov/data/hpi/datasets) | US government work, public domain |
| Income, population, housing units, education, utilities, property tax, broadband | US Census Bureau: [American Community Survey 5-year API](https://www.census.gov/data/developers/data-sets/acs-5year.html) | Public domain. This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau |
| New homes permitted by county | US Census Bureau: [Building Permits Survey](https://www.census.gov/construction/bps/) | US government work, public domain |
| County jobs and pay | US Bureau of Labor Statistics: [Quarterly Census of Employment and Wages](https://www.bls.gov/cew/) (fallback: Census [County Business Patterns](https://www.census.gov/programs-surveys/cbp.html)) | US government work, public domain |
| Zip code centres and zip-to-county links | US Census Bureau: [Gazetteer files](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html) and [relationship files](https://www.census.gov/geographies/reference-files/time-series/geo/relationship-files.html) | US government work, public domain |
| Inflation (CPI-U) | [US Bureau of Labor Statistics API](https://www.bls.gov/developers/) | Public domain. BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov |
| Mortgage rates | Freddie Mac: [Primary Mortgage Market Survey](https://www.freddiemac.com/pmms) | Source: Freddie Mac; used under its [terms of use](https://www.freddiemac.com/terms-of-use) |
| Effective federal funds rate | [Federal Reserve Bank of New York](https://www.newyorkfed.org/markets/reference-rates/effr) | Source: Federal Reserve Bank of New York; used under its terms of use |
| Stock market index | S&P 500 history from [stooq](https://stooq.com) / [datasets on GitHub](https://github.com/datasets/s-and-p-500) | As published by those sources |
| Natural hazards | FEMA: [National Risk Index](https://hazards.fema.gov/nri/) (read from a public ArcGIS copy when FEMA's download is unavailable) | US government work, public domain |
| Buyer/seller market | [Realtor.com Economic Research](https://www.realtor.com/research/data/) | Source: Realtor.com Economic Research |
| Crime (county homicides) | [County Health Rankings & Roadmaps](https://www.countyhealthrankings.org/health-data/methodology-and-sources/data-documentation), University of Wisconsin Population Health Institute | Free use with attribution |
| County presidential results | [MIT Election Data and Science Lab](https://electionlab.mit.edu/data) (CC0); backup copy from [tonmcg/US_County_Level_Election_Results_08-24](https://github.com/tonmcg/US_County_Level_Election_Results_08-24) | As published by those sources |
| School test scores and progress | Stanford Education Data Archive ([SEDA 2025.1](https://edopportunity.org/get-the-data/)): Reardon, S. F., Ho, A. D., Shear, B. R., Fahle, E. M., Kalogrides, D., & Saliba, J., Stanford Education Data Archive | Used with the citation the provider requests |
| School directory and state test results | Urban Institute [Education Data Portal](https://educationdata.urban.org/) (NCES Common Core of Data, EDFacts) | Used with the citation the provider requests |
| Car insurance | [NAIC Auto Insurance Database Report](https://content.naic.org/) (average paid, 2024) and [Insurify](https://insurify.com/car-insurance/report/) (typical full-coverage quotes by state, Sep 2026) | Published state figures, cited |
| Home insurance by state | [NerdWallet, average home insurance cost (May 2026)](https://www.nerdwallet.com/article/insurance/average-homeowners-insurance-cost) | Published state averages, cited |
| Closing costs by state | LodeStar Software Solutions 2025 closing cost report, as published by [Bankrate](https://www.bankrate.com/mortgages/average-closing-costs-by-state/) | Published state averages, cited |
| Loan limits and loan fees | [FHFA 2026 conforming loan limits](https://www.fhfa.gov/news/news-release/fhfa-announces-conforming-loan-limit-values-for-2026), [HUD FHA loan limits](https://entp.hud.gov/idapp/html/hicostlook.cfm), FHA mortgage insurance ([HUD](https://www.hud.gov/program_offices/housing/sfh)), [VA funding fee](https://www.va.gov/housing-assistance/home-loans/funding-fee-and-closing-costs/) | US government information, public domain |
| State landlord-tenant law summary | Compiled from [NAA](https://www.naahq.org/), [NLIHC](https://nlihc.org/) and [Nolo](https://www.nolo.com/legal-encyclopedia/state-landlord-tenant-laws) publications, with a link to the [LSC / LawAtlas eviction laws database](https://lawatlas.org/datasets/state-eviction-laws) | Facts summarized in our own words |
| Streets, places and noise sources | (c) [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), read from [OpenFreeMap](https://openfreemap.org/) vector tiles (OpenMapTiles schema) | [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/). Facing directions and nearby-place counts derived from OpenStreetMap are available under the ODbL |
| Address lookup and drive times | [Nominatim](https://nominatim.org/) and the [OSRM](https://project-osrm.org/) demo server, on OpenStreetMap data | Used lightly from the visitor's browser under their [usage policy](https://operations.osmfoundation.org/policies/nominatim/) |
| Listings, recent sales, tax history and automated value estimates (Quantarium, Collateral Analytics, Cotality) | [Realtor.com](https://www.realtor.com/), read with [HomeHarvest](https://github.com/ZacharyHampton/HomeHarvest); [RentCast](https://www.rentcast.io/) as backup | See "Listings" below |
| Hosting | [GitHub Pages](https://pages.github.com/) for the site, [Vercel](https://vercel.com/) for the live listings function | Their terms of service |

## Listings

Listings are read from Realtor.com with the open-source HomeHarvest library. Realtor.com's terms of use do not permit automated collection, and listing photos and descriptions belong to their owners (brokers, photographers and MLSs). HomeScope does not copy or store any listing photo or description. Each listing card shows the listing's main photo loaded directly from Realtor.com's own servers, labelled "Photo: Realtor.com" and linked to the original listing, with basic facts (price, beds, baths, size, year built, location). The deal check reads a listing's description only in the visitor's browser to flag a few words (for example "new roof" or "as-is") and never shows or saves the description itself. Value estimates are shown with the name of the company that made them. Owners who want a photo or listing removed can open an issue on this repository and it will be taken down. Anyone running this project is responsible for checking that their use complies with the terms of the sites they read.

## Disclaimer

HomeScope is provided "as is", without warranty of any kind. It is an informational tool and does not give financial, investment, legal, tax, insurance or real estate advice. Value estimates, suggested offers and forecasts are statistical estimates that have been wrong before and will be wrong again; check past accuracy on the page and make decisions with qualified professionals (a licensed agent, lender, inspector, appraiser or attorney). Data can be incomplete, out of date or wrong. Vaastu and Feng Shui notes are traditional guidance, not engineering or safety assessments. HomeScope is not affiliated with or endorsed by any data provider named here, and all product and company names are trademarks of their owners.
