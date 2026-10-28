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

| Data | Provider | Terms |
|---|---|---|
| Home value and rent indexes, 1-year forecast | Zillow Research (ZHVI, ZORI, ZHVF) | Zillow's terms for its public research data; attribution to Zillow |
| Zip-code house price index | Federal Housing Finance Agency | US government work, public domain |
| Income, housing, education, utilities, property tax | US Census Bureau, American Community Survey | US government work, public domain. This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau |
| Inflation (CPI-U) | US Bureau of Labor Statistics | US government work, public domain. BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov |
| Mortgage rates | Freddie Mac Primary Mortgage Market Survey | Source: Freddie Mac; used under Freddie Mac's terms of use |
| Effective federal funds rate | Federal Reserve Bank of New York | Source: Federal Reserve Bank of New York; used under its terms of use |
| Natural hazards | FEMA National Risk Index | US government work, public domain |
| Buyer/seller market | Realtor.com Economic Research | Source: Realtor.com Economic Research |
| County health and crime measures | County Health Rankings & Roadmaps, University of Wisconsin Population Health Institute | Free use with attribution |
| County presidential results | MIT Election Data and Science Lab (CC0); backup copy from the tonmcg/US_County_Level_Election_Results_08-24 GitHub collection | As published by those sources |
| Zip code centres and relationships | US Census Bureau gazetteer and relationship files | US government work, public domain |
| Streets, places, noise sources, address lookup and drive times | (c) OpenStreetMap contributors, via Overpass API, Nominatim and OSRM | [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/). Facing directions and nearby-place counts derived from OpenStreetMap are made available under the ODbL. Nominatim and the OSRM demo server are used lightly from the browser under their usage policies |
| School test scores | Stanford Education Data Archive (Reardon, S. F., Ho, A. D., Shear, B. R., Fahle, E. M., Kalogrides, D., & Saliba, J. (2024). Stanford Education Data Archive, Version 5.0) and the Urban Institute Education Data Portal | Used with the citation requested by each provider |
| County jobs and pay | US Census Bureau, County Business Patterns | US government work, public domain |
| Car insurance | National Association of Insurance Commissioners (average paid, 2024, released Oct 2026) and Insurify (typical full-coverage quotes by state through Sep 2026) | Published state figures, cited |
| State landlord-tenant law summary | Compiled from NAA, NLIHC and Nolo publications | Facts summarized in our own words |
| Listings | Realtor.com, read with HomeHarvest; RentCast as backup | See "Listings" below |

## Listings

Listings are read from Realtor.com with the open-source HomeHarvest library. Realtor.com's terms of use do not permit automated collection, and listing photos and descriptions belong to their owners (brokers, photographers and MLSs). HomeScope does not copy or store any listing photo or description: each listing card shows the listing's main photo loaded directly from Realtor.com's own servers, labelled "Photo: Realtor.com" and linked to the original listing, together with basic facts (price, beds, baths, size, year built, location). Owners who want a photo or listing removed can open an issue on this repository and it will be taken down. Anyone running this project is responsible for checking that their use complies with the terms of the sites they read.

## Disclaimer

HomeScope is provided "as is", without warranty of any kind. It is an informational tool and does not give financial, investment, legal, tax, insurance or real estate advice. Forecasts are statistical estimates that have been wrong before and will be wrong again; check past accuracy on the page and make decisions with qualified professionals. Data can be incomplete, out of date or wrong. Vaastu and Feng Shui notes are traditional guidance, not engineering or safety assessments. HomeScope is not affiliated with or endorsed by any data provider named here, and all product and company names are trademarks of their owners.
