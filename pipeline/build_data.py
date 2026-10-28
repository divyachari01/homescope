#!/usr/bin/env python3
# Copyright (c) 2026 Divya Chari
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""Build the data files the website reads.

It downloads free public datasets, joins them by ZIP code and writes small
JSON files into site/data/. Downloads are kept in raw/ and only fetched again
once they are older than the refresh age set for each source below, so a
daily run mostly re-downloads the fast-moving files (mortgage rates).

Usage:
    python pipeline/build_data.py            # normal run
    python pipeline/build_data.py --offline  # only use files already in raw/

Optional environment variable:
    CENSUS_API_KEY   free key from https://api.census.gov/data/key_signup.html
"""
import argparse
import traceback
import hashlib
import datetime as dt
import json
import os
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

import extras
import forecast

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
OUT = ROOT / "site" / "data"
LISTINGS_SRC = ROOT / "listings"          # written by fetch_listings.py
STATE_TABLE = Path(__file__).resolve().parent / "states.csv"   # hand-kept: state law + car insurance

ZILLOW = "https://files.zillowstatic.com/research/public_csvs"

# name: (url or list of candidate urls, local file, required?, max age in days)
SOURCES = {
    # Freddie Mac's weekly 30- and 15-year mortgage rates (FRED blocks GitHub's servers, so not used)
    "pmms":    ("https://www.freddiemac.com/pmms/docs/PMMS_history.csv", "pmms.csv", True, 0),
    # S&P 500 monthly, for the stock-market input of the forecast (optional)
    "stocks":  (["https://stooq.com/q/d/l/?s=%5Espx&i=m",
                 "https://raw.githubusercontent.com/datasets/s-and-p-500/main/data/data.csv"], "sp500.csv", False, 7),
    "zhvi_all": (f"{ZILLOW}/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv", "zhvi_all.csv", True, 3),
    "zhvi_sfr": (f"{ZILLOW}/zhvi/Zip_zhvi_uc_sfr_tier_0.33_0.67_sm_sa_month.csv", "zhvi_sfr.csv", False, 3),
    "zhvi_condo": (f"{ZILLOW}/zhvi/Zip_zhvi_uc_condo_tier_0.33_0.67_sm_sa_month.csv", "zhvi_condo.csv", False, 3),
    "zhvi_bottom": (f"{ZILLOW}/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.0_0.33_sm_sa_month.csv", "zhvi_bottom.csv", False, 3),
    "zhvi_top": (f"{ZILLOW}/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.67_1.0_sm_sa_month.csv", "zhvi_top.csv", False, 3),
    "zori":    (f"{ZILLOW}/zori/Zip_zori_uc_sfrcondomfr_sm_month.csv", "zori.csv", False, 3),
    "zhvf":    (f"{ZILLOW}/zhvf_growth/Zip_zhvf_growth_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv", "zhvf.csv", False, 3),
    "fhfa":    (["https://www.fhfa.gov/hpi/download/annual/hpi_at_zip5.xlsx",
                 "https://www.fhfa.gov/hpi/download/annually/hpi_at_bdl_zip5.xlsx"], "fhfa_zip5.xlsx", True, 14),
    "zip_county": ("https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt",
                   "zcta_county.txt", True, 180),
    "gazetteer": ("https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_zcta_national.zip",
                  "gazetteer.zip", False, 365),
    "zip_tract": ("https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_tract20_natl.txt",
                  "zcta_tract.txt", False, 365),
    "nri": (["https://hazards.fema.gov/nri/Content/StaticDocuments/DataDownload//NRI_Table_CensusTracts/NRI_Table_CensusTracts.zip",
             "https://hazards.fema.gov/nri/Content/StaticDocuments/DataDownload/NRI_Table_CensusTracts/NRI_Table_CensusTracts.zip"],
            "nri_tracts.zip", False, 90),
    "seda": ("https://stacks.stanford.edu/file/hm970gr1371/seda_admindist_annual_cs_2025.1.csv", "seda_admindist.csv", False, 90),
    "realtor": ("https://econdata.s3-us-west-2.amazonaws.com/Reports/Core/RDC_Inventory_Core_Metrics_Zip_History.csv",
                "realtor_zip.csv", False, 7),
    "redfin": ("https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_market_tracker/zip_code_market_tracker.tsv000.gz",
               "redfin_zip.tsv.gz", False, 7),
    "fed": ("https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json?startDate=2000-07-03&endDate="
            + dt.date.today().isoformat(), "effr.json", False, 1),
    "chr": ([f"https://www.countyhealthrankings.org/sites/default/files/media/document/analytic_data{y}{s}.csv"
             for y in (2026, 2025, 2024) for s in ("", "_v2", "_0")], "chr.csv", False, 30),
}
ELECTIONS_DOI = "doi:10.7910/DVN/VOQCHQ"   # MIT Election Lab, county presidential returns

STATES = {
    "01": ("AL", "Alabama"), "02": ("AK", "Alaska"), "04": ("AZ", "Arizona"), "05": ("AR", "Arkansas"),
    "06": ("CA", "California"), "08": ("CO", "Colorado"), "09": ("CT", "Connecticut"), "10": ("DE", "Delaware"),
    "11": ("DC", "District of Columbia"), "12": ("FL", "Florida"), "13": ("GA", "Georgia"), "15": ("HI", "Hawaii"),
    "16": ("ID", "Idaho"), "17": ("IL", "Illinois"), "18": ("IN", "Indiana"), "19": ("IA", "Iowa"),
    "20": ("KS", "Kansas"), "21": ("KY", "Kentucky"), "22": ("LA", "Louisiana"), "23": ("ME", "Maine"),
    "24": ("MD", "Maryland"), "25": ("MA", "Massachusetts"), "26": ("MI", "Michigan"), "27": ("MN", "Minnesota"),
    "28": ("MS", "Mississippi"), "29": ("MO", "Missouri"), "30": ("MT", "Montana"), "31": ("NE", "Nebraska"),
    "32": ("NV", "Nevada"), "33": ("NH", "New Hampshire"), "34": ("NJ", "New Jersey"), "35": ("NM", "New Mexico"),
    "36": ("NY", "New York"), "37": ("NC", "North Carolina"), "38": ("ND", "North Dakota"), "39": ("OH", "Ohio"),
    "40": ("OK", "Oklahoma"), "41": ("OR", "Oregon"), "42": ("PA", "Pennsylvania"), "44": ("RI", "Rhode Island"),
    "45": ("SC", "South Carolina"), "46": ("SD", "South Dakota"), "47": ("TN", "Tennessee"), "48": ("TX", "Texas"),
    "49": ("UT", "Utah"), "50": ("VT", "Vermont"), "51": ("VA", "Virginia"), "53": ("WA", "Washington"),
    "54": ("WV", "West Virginia"), "55": ("WI", "Wisconsin"), "56": ("WY", "Wyoming"), "72": ("PR", "Puerto Rico"),
}
ABBR_TO_FIPS = {v[0]: k for k, v in STATES.items()}

ACS_VARS = {
    "B01003_001E": "pop", "B19013_001E": "income", "B25077_001E": "home_value", "B25064_001E": "rent",
    "B25003_001E": "occupied", "B25003_003E": "renters", "B25004_002E": "for_rent_vacant",
    "B17001_001E": "pov_total", "B17001_002E": "pov", "B23025_003E": "labor", "B23025_005E": "unemployed",
    "B15003_001E": "edu_total", "B15003_022E": "ba", "B15003_023E": "ma", "B15003_024E": "prof", "B15003_025E": "phd",
    "B25103_001E": "re_tax", "B25035_001E": "year_built",
    "B28002_001E": "net_total", "B28002_004E": "broadband",
    "B25024_001E": "units", "B25024_002E": "u1d", "B25024_003E": "u1a", "B25024_004E": "u2", "B25024_005E": "u34",
    "B25024_006E": "u59", "B25024_007E": "u1019", "B25024_008E": "u2049", "B25024_009E": "u50", "B25024_010E": "umobile",
}
ACS_OLD_VARS = ["B01003_001E", "B19013_001E", "B25077_001E", "B25064_001E", "B25003_001E", "B25003_003E",
                "B15003_001E", "B15003_022E", "B15003_023E", "B15003_024E", "B15003_025E"]

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
})
OFFLINE = False


def log(msg):
    print(msg, flush=True)


def fetch(name):
    """Return the local path of a source, downloading it if missing or stale."""
    urls, fname, required, max_age = SOURCES[name]
    path = RAW / fname
    fresh = path.exists() and (time.time() - path.stat().st_mtime) < max_age * 86400
    if OFFLINE or fresh:
        if path.exists():
            return path
        return fail(name, "not in raw/", required)
    for url in urls if isinstance(urls, list) else [urls]:
        try:
            download(url, path)
            log(f"  downloaded {name}")
            return path
        except Exception as e:  # noqa: BLE001
            last = e
    if path.exists():
        log(f"  WARNING: {name} download failed ({last}); using the older copy in raw/")
        return path
    return fail(name, last, required)


def download(url, path, tries=3):
    tmp = path.with_suffix(".part")
    for i in range(tries):
        try:
            with SESSION.get(url, stream=True, timeout=300) as r:
                r.raise_for_status()
                r.raw.decode_content = True          # unpack gzip-encoded responses (e.g. census.gov)
                with open(tmp, "wb") as f:
                    shutil.copyfileobj(r.raw, f)
            if tmp.stat().st_size < 200:
                raise ValueError("file looks empty")
            with open(tmp, "rb") as f:
                head = f.read(200).lstrip().lower()
            if head.startswith((b"<!doctype html", b"<html")) and not url.endswith((".html", ".htm")):
                raise ValueError("got a web page instead of a data file")
            tmp.replace(path)
            return
        except Exception:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(10 * (i + 1))


def fail(name, why, required):
    if required:
        sys.exit(f"ERROR: required source {name} unavailable: {why}")
    log(f"  WARNING: skipping {name}: {why}")
    return None


# ---------------------------------------------------------------- loaders

def load_rates():
    """Weekly 30- and 15-year mortgage rates from Freddie Mac."""
    df = pd.read_csv(fetch("pmms"))
    df.columns = [c.strip().lower() for c in df.columns]
    df["date"] = pd.to_datetime(df["date"], format="mixed")
    out = []
    for col in ("pmms30", "pmms15"):
        d = pd.DataFrame({"date": df["date"], "value": pd.to_numeric(df.get(col), errors="coerce")}).dropna()
        out.append(d.reset_index(drop=True) if len(d) else None)
    return out[0], out[1]


def load_cpi():
    """Monthly consumer price index (CPI-U, all items) from the BLS data API, 10 years per request."""
    path = RAW / "cpi_bls.json"
    if not (path.exists() and (OFFLINE or time.time() - path.stat().st_mtime < 7 * 86400)):
        if OFFLINE:
            sys.exit("ERROR: no CPI file in raw/")
        rows = []
        for start in range(1950, dt.date.today().year + 1, 10):
            r = SESSION.post("https://api.bls.gov/publicAPI/v2/timeseries/data/", timeout=120,
                             json={"seriesid": ["CUUR0000SA0"], "startyear": str(start), "endyear": str(start + 9)})
            r.raise_for_status()
            body = r.json()
            if body.get("status") != "REQUEST_SUCCEEDED":
                sys.exit(f"ERROR: BLS CPI request failed: {body.get('message')}")
            rows += body["Results"]["series"][0]["data"]
        path.write_text(json.dumps(rows))
        log("  downloaded CPI")
    rows = [r for r in json.loads(path.read_text()) if r["period"].startswith("M") and r["period"] != "M13"]
    df = pd.DataFrame({"date": pd.to_datetime([f"{r['year']}-{r['period'][1:]}-01" for r in rows]),
                       "value": pd.to_numeric([r["value"] for r in rows], errors="coerce")})
    return df.dropna().sort_values("date").reset_index(drop=True)


def load_stocks():
    """S&P 500 yearly average (optional): returns a Series indexed by year, or None."""
    p = fetch("stocks")
    if not p:
        return None
    df = pd.read_csv(p)
    df.columns = [c.strip().lower() for c in df.columns]
    price = next((c for c in ("close", "sp500") if c in df.columns), None)
    if price is None or "date" not in df.columns:
        return None
    d = pd.DataFrame({"date": pd.to_datetime(df["date"], errors="coerce"),
                      "v": pd.to_numeric(df[price], errors="coerce")}).dropna()
    return d.set_index("date")["v"].groupby(lambda x: x.year).mean()


def load_zillow(path):
    """Zillow research CSV -> (meta DataFrame, wide values DataFrame indexed by zip)."""
    df = pd.read_csv(path, dtype={"RegionName": str})
    df.index = df["RegionName"].str.zfill(5).rename("zip")
    datecols = [c for c in df.columns if len(c) == 10 and c[4] == "-" and c[:2] in ("19", "20")]
    meta_cols = [c for c in ("City", "State", "CountyName", "Metro") if c in df.columns]
    vals = df[datecols].apply(pd.to_numeric, errors="coerce")
    vals.columns = pd.to_datetime(datecols)
    return df[meta_cols], vals


def annual(vals):
    """Monthly wide frame -> yearly mean wide frame."""
    return vals.T.groupby(vals.columns.year).mean().T


def load_fhfa(path):
    raw = pd.read_excel(path, header=None, dtype=str)
    hdr = next(i for i in range(min(40, len(raw)))
               if raw.iloc[i].astype(str).str.strip().str.lower().eq("year").any())
    df = raw.iloc[hdr + 1:].copy()
    df.columns = [str(c).strip() for c in raw.iloc[hdr]]
    zcol = next(c for c in df.columns if "zip" in c.lower())
    ycol = next(c for c in df.columns if c.lower() == "year")
    hcol = next(c for c in df.columns if c.upper() == "HPI")
    out = pd.DataFrame({
        "zip": df[zcol].astype(str).str.extract(r"^(\d+)")[0].str.zfill(5),
        "year": pd.to_numeric(df[ycol], errors="coerce"),
        "hpi": pd.to_numeric(df[hcol], errors="coerce"),
    }).dropna()
    out["year"] = out["year"].astype(int)
    return out


def load_zip_county(path):
    rel = pd.read_csv(path, sep="|", dtype=str)
    rel = rel.dropna(subset=["GEOID_ZCTA5_20", "GEOID_COUNTY_20"])
    rel["area"] = pd.to_numeric(rel["AREALAND_PART"], errors="coerce").fillna(0)
    rel = rel.sort_values("area", ascending=False).drop_duplicates("GEOID_ZCTA5_20")
    return {r.GEOID_ZCTA5_20: (r.GEOID_COUNTY_20, r.NAMELSAD_COUNTY_20) for r in rel.itertuples()}


def census_get(year, variables, extra=None):
    key = os.environ.get("CENSUS_API_KEY", "")
    params = {"get": ",".join(variables), "for": "zip code tabulation area:*"}
    params.update(extra or {})
    if key:
        params["key"] = key
    r = SESSION.get(f"https://api.census.gov/data/{year}/acs/acs5", params=params, timeout=600)
    try:
        rows = r.json()
    except ValueError:
        raise RuntimeError(f"HTTP {r.status_code}, reply: {r.text[:200]!r}") from None
    return pd.DataFrame(rows[1:], columns=rows[0])


def acs_cache_path(year, variables):
    return RAW / f"acs_{year}_{hashlib.md5(','.join(variables).encode()).hexdigest()[:8]}.csv"


def census_group_meta(year, group):
    """Variable labels of one Census table (cached), used to read the utility-bill brackets."""
    path = RAW / f"acs_meta_{year}_{group}.json"
    if not path.exists() and not OFFLINE:
        r = SESSION.get(f"https://api.census.gov/data/{year}/acs/acs5/groups/{group}.json", timeout=120)
        r.raise_for_status()
        path.write_text(r.text)
    return json.loads(path.read_text())


def load_acs(year, variables):
    """ACS 5-year table for all ZCTAs, cached in raw/. Returns None if not published."""
    path = acs_cache_path(year, variables)
    if path.exists() and (OFFLINE or time.time() - path.stat().st_mtime < 30 * 86400):
        return clean_acs(pd.read_csv(path, dtype={"zip": str}), variables)
    if OFFLINE:
        return None
    try:
        df = census_get(year, variables)
    except Exception:  # noqa: BLE001
        try:  # older vintages sometimes only answer per state
            parts = []
            for fips in STATES:
                if fips == "72":
                    continue
                parts.append(census_get(year, variables, {"in": f"state:{fips}"}))
            df = pd.concat(parts)
        except Exception as e:  # noqa: BLE001
            log(f"  ACS {year} not available: {str(e)[:120]}")
            return None
    zcol = next(c for c in df.columns if c.startswith("zip code"))
    df = df.rename(columns={zcol: "zip"})[["zip"] + variables].drop_duplicates("zip")
    df.to_csv(path, index=False)
    log(f"  downloaded ACS {year}")
    return clean_acs(df, variables)


def clean_acs(df, variables):
    for v in variables:
        df[v] = pd.to_numeric(df[v], errors="coerce")
        df.loc[df[v] < -1e5, v] = np.nan        # census uses -666666666 etc. for "no estimate"
    return df


def load_elections():
    """County presidential vote shares 2000-2024 -> (county dict, state dict)."""
    path = RAW / "countypres.csv"
    stale = not path.exists() or time.time() - path.stat().st_mtime > 90 * 86400
    if stale and not OFFLINE:
        try:
            meta = SESSION.get("https://dataverse.harvard.edu/api/datasets/:persistentId/",
                               params={"persistentId": ELECTIONS_DOI}, timeout=120).json()
            files = meta["data"]["latestVersion"]["files"]
            f = next(x for x in files if "countypres" in x["dataFile"]["filename"].lower()
                     and not x["dataFile"]["filename"].lower().endswith((".md", ".pdf", ".txt")))
            fid = f["dataFile"]["id"]
            try:
                download(f"https://dataverse.harvard.edu/api/access/datafile/{fid}?format=original", path)
            except Exception:  # noqa: BLE001
                download(f"https://dataverse.harvard.edu/api/access/datafile/{fid}", path)
            log("  downloaded elections")
        except Exception as e:  # noqa: BLE001
            log(f"  WARNING: elections download failed: {e}")
    if not path.exists():
        return load_elections_github()
    with open(path, encoding="utf-8", errors="replace") as fh:
        sep = "\t" if "\t" in fh.readline() else ","
    el = pd.read_csv(path, sep=sep, dtype=str)
    el.columns = [c.strip().lower() for c in el.columns]
    el["votes"] = pd.to_numeric(el["candidatevotes"], errors="coerce").fillna(0)
    el["year"] = pd.to_numeric(el["year"], errors="coerce")
    el["fips"] = pd.to_numeric(el["county_fips"], errors="coerce")
    el = el.dropna(subset=["year", "fips"])
    el["fips"] = el["fips"].astype(int).astype(str).str.zfill(5)
    el["mode"] = el.get("mode", pd.Series("TOTAL", index=el.index)).fillna("TOTAL").str.upper()
    # Some states report only by voting method (no TOTAL row): keep TOTAL where it exists, else sum methods.
    has_total = el.loc[el["mode"] == "TOTAL", ["year", "fips"]].drop_duplicates().assign(_t=1)
    el = el.merge(has_total, on=["year", "fips"], how="left")
    el = el[(el["_t"].isna()) | (el["mode"] == "TOTAL")]
    el["party"] = el["party"].fillna("OTHER").str.upper()

    def shares(group_cols):
        g = el.groupby(group_cols + ["party"])["votes"].sum().unstack(fill_value=0)
        tot = g.sum(axis=1).replace(0, np.nan)
        return pd.DataFrame({"dem": g.get("DEMOCRAT", 0) / tot, "rep": g.get("REPUBLICAN", 0) / tot}).dropna()

    def pack(df, key_col):
        out = {}
        for key, sub in df.reset_index().groupby(key_col):
            sub = sub.sort_values("year")
            out[key] = {"years": sub["year"].astype(int).tolist(),
                        "dem": [round(x * 100, 1) for x in sub["dem"]],
                        "rep": [round(x * 100, 1) for x in sub["rep"]]}
        return out

    county = pack(shares(["year", "fips"]), "fips")
    state = pack(shares(["year", "state_po"]), "state_po")
    return county, state


GH_ELECTIONS = "https://raw.githubusercontent.com/tonmcg/US_County_Level_Election_Results_08-24/master/"


def load_elections_github():
    """Backup: county presidential results 2008-2024 from a public GitHub collection."""
    rows = []
    try:
        for y in (2024, 2020):
            p = RAW / f"pres_{y}.csv"
            if not p.exists() and not OFFLINE:
                download(GH_ELECTIONS + f"{y}_US_County_Level_Presidential_Results.csv", p)
            d = pd.read_csv(p, dtype={"county_fips": str})
            rows.append(pd.DataFrame({"year": y, "fips": d["county_fips"].str.zfill(5),
                                      "dem": d["votes_dem"], "rep": d["votes_gop"], "tot": d["total_votes"]}))
        p = RAW / "pres_2016.csv"
        if not p.exists() and not OFFLINE:
            download(GH_ELECTIONS + "2016_US_County_Level_Presidential_Results.csv", p)
        d = pd.read_csv(p, dtype={"combined_fips": str})
        rows.append(pd.DataFrame({"year": 2016, "fips": d["combined_fips"].str.zfill(5),
                                  "dem": d["votes_dem"], "rep": d["votes_gop"], "tot": d["total_votes"]}))
        p = RAW / "pres_08_16.csv"
        if not p.exists() and not OFFLINE:
            download(GH_ELECTIONS + "US_County_Level_Presidential_Results_08-16.csv", p)
        d = pd.read_csv(p, dtype={"fips_code": str})
        for y in (2008, 2012):
            rows.append(pd.DataFrame({"year": y, "fips": d["fips_code"].str.zfill(5),
                                      "dem": d[f"dem_{y}"], "rep": d[f"gop_{y}"], "tot": d[f"total_{y}"]}))
        log("  elections from the GitHub backup")
    except Exception as e:  # noqa: BLE001
        log(f"  WARNING: election backup failed: {e!r}")
        if not rows:
            return {}, {}
    el = pd.concat(rows)
    for c in ("dem", "rep", "tot"):
        el[c] = pd.to_numeric(el[c], errors="coerce")
    el = el.dropna()
    el["state"] = el["fips"].str[:2].map(lambda f: STATES.get(f, ("",))[0])

    def pack(g, key):
        out = {}
        for k, sub in g.groupby(key):
            sub = sub.groupby("year")[["dem", "rep", "tot"]].sum().sort_index()
            out[k] = {"years": sub.index.astype(int).tolist(),
                      "dem": (sub["dem"] / sub["tot"] * 100).round(1).tolist(),
                      "rep": (sub["rep"] / sub["tot"] * 100).round(1).tolist()}
        return out
    return pack(el, "fips"), pack(el, "state")


def load_cbp(year):
    """County Business Patterns: jobs and yearly payroll per county (cached). None if unavailable."""
    path = RAW / f"cbp_{year}.csv"
    if not path.exists():
        if OFFLINE:
            return None
        key = os.environ.get("CENSUS_API_KEY", "")
        params = {"get": "EMP,PAYANN", "for": "county:*", **({"key": key} if key else {})}
        r = SESSION.get(f"https://api.census.gov/data/{year}/cbp", params=params, timeout=300)
        try:
            rows = r.json()
        except ValueError:
            return None
        pd.DataFrame(rows[1:], columns=rows[0]).to_csv(path, index=False)
    df = pd.read_csv(path, dtype=str)
    df["fips"] = df["state"].str.zfill(2) + df["county"].str.zfill(3)
    for c in ("EMP", "PAYANN"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df.set_index("fips")[["EMP", "PAYANN"]]


def load_jobs():
    """County jobs now, change over 5 years, and average pay (County Business Patterns)."""
    for y in range(dt.date.today().year - 2, dt.date.today().year - 6, -1):
        new = load_cbp(y)
        if new is not None and len(new):
            old = load_cbp(y - 5)
            out = pd.DataFrame({"jobs": new["EMP"], "avg_pay": new["PAYANN"] * 1000 / new["EMP"]})
            if old is not None:
                out["jobs_change"] = (new["EMP"] / old["EMP"].reindex(new.index) - 1) * 100
            out["year"] = y
            return out.replace([np.inf, -np.inf], np.nan)
    return None


def load_chr(path):
    """County Health Rankings analytic file -> {county fips: (violent crime per 100k, release year)}."""
    df = pd.read_csv(path, dtype=str, low_memory=False)
    if "fipscode" in df.iloc[0].astype(str).str.lower().tolist() and not any("fips" in c.lower() for c in df.columns):
        df.columns = df.iloc[0].astype(str)
        df = df.iloc[1:]
    fcol = next((c for c in df.columns if "5-digit fips" in c.lower() or c.lower() == "fipscode"), None)
    ccol = next((c for c in df.columns if "violent crime raw value" in c.lower() or c.lower() == "v043_rawvalue"), None)
    if not ccol:   # newer releases may drop violent crime; homicides is the closest measure they keep
        ccol = next((c for c in df.columns if "homicide" in c.lower() and "raw value" in c.lower()), None)
    log(f"  crime measure used: {ccol}")
    if not fcol or not ccol:
        raise ValueError("no crime column; columns mentioning crime/homicide: "
                         f"{[c for c in df.columns if 'crime' in c.lower() or 'homicide' in c.lower()][:10]}")
    ycol = next((c for c in df.columns if "release year" in c.lower() or c.lower() == "year"), None)
    df = df[df[fcol].str.fullmatch(r"\d{4,5}", na=False)]
    df["fips"] = df[fcol].str.zfill(5)
    df = df[~df["fips"].str.endswith("000")]
    df["crime"] = pd.to_numeric(df[ccol], errors="coerce")
    year = df[ycol].dropna().iloc[0] if ycol else ""
    year = f"{year}, {'homicides' if 'homicide' in ccol.lower() else 'violent crime'}"
    return {r.fips: round(r.crime, 1) for r in df.dropna(subset=["crime"]).itertuples()}, year


# ---------------------------------------------------------------- helpers

def series(row, ndigits=0):
    """Wide row (index = year or date) -> {"start": first, "v": [...]} trimmed of leading/trailing gaps."""
    s = row.dropna()
    if s.empty:
        return None
    full = row.loc[s.index[0]:s.index[-1]]
    start = s.index[0]
    start = int(start) if not hasattr(start, "strftime") else start.strftime("%Y-%m")
    vals = [None if pd.isna(x) else (round(float(x), ndigits) if ndigits else int(round(x))) for x in full]
    return {"start": start, "v": vals}


def pct_rank(s):
    return (s.rank(pct=True) * 100).round(0)


def clean(obj):
    """Make values JSON-safe (NaN -> None, numpy -> python)."""
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items() if v is not None}
    if isinstance(obj, list):
        return [clean(v) for v in obj]
    if isinstance(obj, (np.floating, float)):
        return None if np.isnan(obj) else float(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    return obj


def laws_table():
    return pd.read_csv(STATE_TABLE, dtype=str).fillna("")


def run_forecast(fh_wide, zhvi_year, acs_year, r30, zip_county, county_votes, laws, crime, fed, market, hazard):
    """Collect the inputs the forecast model needs and run it. Returns per-zip results."""
    P = forecast.combined_prices(fh_wide, zhvi_year)
    acs = {}
    for y in range(2012, acs_year + 1):
        a = load_acs(y, forecast.ACS_MODEL_VARS)
        if a is not None:
            acs[y] = a.set_index("zip")
    macro = pd.DataFrame({"rate": r30.set_index("date")["value"].groupby(lambda d: d.year).mean()})
    sp = load_stocks()
    macro["stocks"] = sp if sp is not None else np.nan
    macro["fed"] = fed.groupby(fed.index.year).mean() if fed is not None else np.nan
    macro = macro.to_dict()

    county_of = {z: c[0] for z, c in zip_county.items()}

    def votes(y):
        margin, shift = {}, {}
        for fips, v in county_votes.items():
            yrs = [i for i, yy in enumerate(v["years"]) if yy <= y]
            if not yrs:
                continue
            i = yrs[-1]
            margin[fips] = v["rep"][i] - v["dem"][i]
            j = [k for k in yrs if v["years"][k] <= v["years"][i] - 8]
            if j:
                shift[fips] = margin[fips] - (v["rep"][j[-1]] - v["dem"][j[-1]])
        zm = {z: margin.get(c) for z, c in county_of.items()}
        zs = {z: shift.get(c) for z, c in county_of.items()}
        return zm, zs

    rc_code = {"cities banned": 0, "no statewide ban": 1, "no rent caps": 2, "local rent control": 3, "statewide": 4}
    law = {}
    for r in laws.itertuples():
        code = next((v for k, v in rc_code.items() if r.rent_control.lower().startswith(k)), np.nan)
        jc = 1.0 if r.just_cause.lower().startswith("yes") else 0.5 if r.just_cause.lower().startswith("limited") else 0.0
        law[r.state] = (code, jc, float(r.nonpay_notice_days or 0), float(r.car_insurance or "nan"))
    rows = {}
    for z, c in county_of.items():
        st = STATES.get(c[:2], ("",))[0]
        lw = law.get(st, (np.nan,) * 4)
        rows[z] = {"state": int(c[:2]), "rent_control": lw[0], "just_cause": lw[1], "notice_days": lw[2],
                   "car_insurance": lw[3], "crime": crime.get(c, np.nan)}
    static = pd.DataFrame.from_dict(rows, orient="index")
    if hazard is not None:
        static["hazard_risk"] = hazard["risk"].reindex(static.index)
        static["hazard_loss"] = hazard["loss_rate"].reindex(static.index)

    preds, past, summary = forecast.run(P, acs, macro, votes, static, market or {}, log=log)
    fc = {}
    for h, df in preds.items():
        for z, r in df.round(1).iterrows():
            if r.notna().all():
                fc.setdefault(z, {})[str(h)] = [r["low"], r["mid"], r["high"]]
    bt = {}
    for T, df in past.items():
        for z, r in df.round(1).iterrows():
            bt.setdefault(z, {})[str(T)] = [r["low"], r["mid"], r["high"], r["actual"]]
    return fc, bt, summary


# ---------------------------------------------------------------- main build

def main():
    global OFFLINE
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="use only files already in raw/")
    OFFLINE = ap.parse_args().offline
    RAW.mkdir(exist_ok=True)
    now = dt.date.today()
    asof = {}

    log("National series")
    r30, r15 = load_rates()
    cpi = load_cpi()
    monthly30 = r30.set_index("date")["value"].resample("MS").mean()
    cpi_year = cpi.set_index("date")["value"].groupby(lambda d: d.year).mean()
    national = {
        "built": now.isoformat(),
        "rate30": {"start": monthly30.index[0].strftime("%Y-%m"), "v": [round(x, 2) for x in monthly30]},
        "rate30_latest": {"date": r30["date"].iloc[-1].strftime("%Y-%m-%d"), "value": float(r30["value"].iloc[-1])},
        "cpi": {"start": int(cpi_year.index[0]), "v": [round(x, 2) for x in cpi_year]},
    }
    if r15 is not None:
        national["rate15_latest"] = {"date": r15["date"].iloc[-1].strftime("%Y-%m-%d"),
                                     "value": float(r15["value"].iloc[-1])}
    asof["rates"] = national["rate30_latest"]["date"]

    log("Zillow")
    meta, zall = load_zillow(fetch("zhvi_all"))
    zhvi = {"all": zall}
    for k in ("sfr", "condo", "bottom", "top"):
        p = fetch(f"zhvi_{k}")
        if p:
            zhvi[k] = load_zillow(p)[1]
    zhvi_year = {k: annual(v) for k, v in zhvi.items()}
    asof["zillow_values"] = zall.columns[-1].strftime("%Y-%m")
    zori_p = fetch("zori")
    zori = load_zillow(zori_p)[1] if zori_p else None
    zori_year = annual(zori) if zori is not None else None
    if zori is not None:
        asof["zillow_rents"] = zori.columns[-1].strftime("%Y-%m")
    zhvf = None
    zhvf_p = fetch("zhvf")
    if zhvf_p:
        zf = pd.read_csv(zhvf_p, dtype={"RegionName": str})
        zf["zip"] = zf["RegionName"].str.zfill(5)
        datecols = [c for c in zf.columns if len(c) == 10 and c[4] == "-"]
        zhvf = zf.set_index("zip")[datecols[-1]]       # year-ahead forecast, % change
        asof["zillow_forecast_base"] = str(zf["BaseDate"].iloc[0]) if "BaseDate" in zf else ""

    log("FHFA")
    fh = load_fhfa(fetch("fhfa"))
    fh_wide = fh.pivot_table(index="zip", columns="year", values="hpi")
    asof["fhfa"] = int(fh["year"].max())

    log("Census")
    zip_county = load_zip_county(fetch("zip_county"))
    acs_new = acs_year = None
    for y in range(now.year - 1, now.year - 5, -1):
        acs_new = load_acs(y, list(ACS_VARS))
        if acs_new is not None:
            acs_year = y
            break
    if acs_new is None:
        sys.exit("ERROR: no ACS 5-year data could be loaded")
    acs_new = acs_new.rename(columns=ACS_VARS).set_index("zip")
    acs_old = old_year = None
    for y in (acs_year - 10, acs_year - 9, acs_year - 11):
        acs_old = load_acs(y, ACS_OLD_VARS)
        if acs_old is not None:
            old_year = y
            break
    if acs_old is not None:
        acs_old = acs_old.rename(columns=ACS_VARS).set_index("zip")
    asof["acs"] = f"{acs_year - 4}-{acs_year}"
    if old_year:
        asof["acs_old"] = f"{old_year - 4}-{old_year}"

    log("Crime and elections")
    crime, crime_year = {}, ""
    chr_p = fetch("chr")
    if chr_p:
        try:
            crime, crime_year = load_chr(chr_p)
            asof["crime"] = f"County Health Rankings {crime_year}"
        except Exception as e:  # noqa: BLE001
            log(f"  WARNING: could not read County Health Rankings file: {e}")
    county_votes, state_votes = load_elections()
    if state_votes:
        asof["elections"] = max(max(v["years"]) for v in state_votes.values())

    # ---------- derived zip-level metrics and national percentiles
    log("Computing indicators")
    a = acs_new
    d = pd.DataFrame(index=a.index)
    d["renter_share"] = a["renters"] / a["occupied"] * 100
    d["rent_vacancy"] = a["for_rent_vacant"] / (a["renters"] + a["for_rent_vacant"]) * 100
    d["poverty"] = a["pov"] / a["pov_total"] * 100
    d["broadband"] = a["broadband"] / a["net_total"] * 100
    d["unemployment"] = a["unemployed"] / a["labor"] * 100
    d["college"] = (a["ba"] + a["ma"] + a["prof"] + a["phd"]) / a["edu_total"] * 100
    d["tax_rate"] = (a["re_tax"] / a["home_value"] * 100).where(lambda s: s.between(0.05, 5))
    latest_all = zall.ffill(axis=1).iloc[:, -1]
    d["price_to_income"] = (latest_all.reindex(d.index) / a["income"])
    if zori is not None:
        d["rent_yield"] = zori.ffill(axis=1).iloc[:, -1].reindex(d.index) * 12 / latest_all.reindex(d.index) * 100
    ya = zhvi_year["all"]
    last_full = now.year - 1
    if last_full in ya.columns and last_full - 10 in ya.columns:
        d["growth10"] = ((ya[last_full] / ya[last_full - 10]) ** 0.1 - 1).reindex(d.index) * 100
    if acs_old is not None:
        o = acs_old.reindex(d.index)
        infl = cpi_year.get(acs_year, np.nan) / cpi_year.get(old_year, np.nan)
        d["income_change"] = (a["income"] / (o["income"] * infl) - 1) * 100          # after inflation
        d["value_change"] = (a["home_value"] / (o["home_value"] * infl) - 1) * 100
        d["rent_change"] = (a["rent"] / (o["rent"] * infl) - 1) * 100
        d["college_old"] = (o["ba"] + o["ma"] + o["prof"] + o["phd"]) / o["edu_total"] * 100
        d["college_change"] = d["college"] - d["college_old"]
        d["income_old"] = o["income"]
    d["state"] = [STATES.get(zip_county.get(z, ("",))[0][:2], ("",))[0] for z in d.index]
    d["county_fips"] = [zip_county.get(z, ("",))[0] for z in d.index]
    d["crime"] = d["county_fips"].map(crime)
    d = d.replace([np.inf, -np.inf], np.nan)

    pct = pd.DataFrame(index=d.index)
    for col in ("price_to_income", "rent_yield", "renter_share", "income_change", "growth10", "crime",
                "college_change", "poverty", "unemployment"):
        if col in d:
            pct[col] = pct_rank(d[col])
    pct["income"] = pct_rank(a["income"])

    # Gentrification rule of thumb (after Freeman 2005), compared within each state:
    # lower-income start (income and home value below the state's middle zip) and then
    # faster-than-typical growth in college share and in real home values.
    gent = {}
    if acs_old is not None:
        o = acs_old.reindex(d.index)
        g = pd.DataFrame({"state": d["state"], "inc0": o["income"], "val0": o["home_value"],
                          "dcol": d["college_change"], "dval": d["value_change"], "pop": a["pop"]})
        g = g[(g["pop"] >= 500)].dropna()
        med = g.groupby("state")[["inc0", "val0", "dcol", "dval"]].transform("median")
        low = (g["inc0"] < med["inc0"]) & (g["val0"] < med["val0"])
        up = (g["dcol"] > med["dcol"]) & (g["dval"] > med["dval"])
        for z in g.index:
            if not low[z]:
                gent[z] = "Not a lower-income area at the start"
            elif up[z]:
                gent[z] = "Signs of gentrification"
            else:
                gent[z] = "Lower-income, no gentrification signs"

    # ---------- extra zip data: utilities, surrounding area, hazards, market, Fed rate (all optional)
    log("Extra data")
    util = ring = hazard = mk = mk_year = fed = None
    points = pd.DataFrame(columns=["lat", "lon"])
    try:
        be = extras.bracket_vars(census_group_meta(acs_year, "B25132"))   # electricity
        bg = extras.bracket_vars(census_group_meta(acs_year, "B25133"))   # gas
        ut = load_acs(acs_year, sorted(be) + sorted(bg)).set_index("zip")
        util = pd.DataFrame({"electric": extras.bracket_mean(ut, be), "gas": extras.bracket_mean(ut, bg)})
    except Exception as e:  # noqa: BLE001
        log(f"  WARNING: utility bills skipped: {e!r}")
    try:
        points = extras.zip_points(fetch("gazetteer"))
        vals = pd.DataFrame({"income": a["income"], "poverty": d["poverty"], "renter_share": d["renter_share"],
                             "growth10": d.get("growth10"), "crime": d["crime"], "college": d["college"]})
        ring, ring_n = extras.surrounding(points, vals, a["pop"])
        ring["n"] = ring_n
    except Exception as e:  # noqa: BLE001
        log(f"  WARNING: surrounding-area comparison skipped: {e!r}")
    try:
        nri = fetch("nri")
        if nri is None and not OFFLINE:
            nri = RAW / "nri_tracts.csv"
            if not nri.exists() or time.time() - nri.stat().st_mtime > 90 * 86400:
                extras.nri_from_arcgis(SESSION, nri)
                log("  downloaded NRI (ArcGIS copy)")
        hazard = extras.hazards_by_zip(nri, fetch("zip_tract"))
        asof["hazards"] = "FEMA National Risk Index"
    except Exception as e:  # noqa: BLE001
        log(f"  WARNING: natural hazards skipped: {e!r}")
    try:
        rf = fetch("redfin")
        mk = extras.redfin_market(rf) if rf else extras.realtor_market(fetch("realtor"))
        mk_year = extras.market_by_year(mk)
        asof["market"] = str(mk["month"].max())
        asof["market_source"] = "Redfin" if rf else "Realtor.com"
    except Exception as e:  # noqa: BLE001
        log(f"  WARNING: buyer/seller market skipped: {e!r}")
    try:
        fed = extras.fed_funds(fetch("fed"))
        national["fed"] = {"start": fed.index[0].strftime("%Y-%m"), "v": [round(x, 2) for x in fed]}
        asof["fed"] = fed.index[-1].strftime("%Y-%m")
    except Exception as e:  # noqa: BLE001
        log(f"  WARNING: Fed rate skipped: {e!r}")

    jobs = None
    try:
        jobs = load_jobs()
        if jobs is not None:
            asof["jobs"] = f"County Business Patterns {int(jobs['year'].iloc[0])}"
    except Exception as e:  # noqa: BLE001
        log(f"  WARNING: county jobs skipped: {e!r}")
    schools = near = dgrades = None
    try:
        if OFFLINE and not (RAW / "schools_dir.json").exists():
            raise FileNotFoundError("no school directory in raw/")
        sdir = extras.urban_all(SESSION, f"{extras.URBAN}/schools/ccd/directory/2023/", RAW / "schools_dir.json")
        sdir["ncessch"] = sdir["ncessch"].astype(str).str.zfill(12)
        sdir["leaid"] = sdir["leaid"].astype(str).str.zfill(7)
        try:
            ef = extras.urban_all(SESSION, f"{extras.URBAN}/schools/edfacts/assessments/2018/grade-99/",
                                  RAW / "schools_edfacts_2018.json")
            ef["ncessch"] = ef["ncessch"].astype(str).str.zfill(12)
            ef = ef.drop_duplicates("ncessch")[["ncessch", "math_test_pct_prof_midpt", "read_test_pct_prof_midpt"]]
            sdir = sdir.merge(ef, on="ncessch", how="left")
        except Exception as e:  # noqa: BLE001
            log(f"  WARNING: school test results skipped: {e!r}")
        sd = fetch("seda")
        if sd:
            dgrades = extras.district_grades(sd)
            asof["schools"] = f"SEDA 2025.1 ({int(dgrades['year'].iloc[0]) if dgrades['year'].notna().any() else ''})"
        schools, near = extras.schools_near(points, sdir, list(d.index))
        log(f"  schools: {len(schools)} in directory")
    except Exception as e:  # noqa: BLE001
        log(f"  WARNING: schools skipped: {e!r}")

    # ---------- machine-learning forecast (skipped with a warning if anything goes wrong)
    fc, bt = {}, {}
    try:
        log("Forecast model")
        fc, bt, national["model"] = run_forecast(fh_wide, zhvi_year, acs_year, r30, zip_county,
                                                 county_votes, laws_table(), crime, fed, mk_year, hazard)
    except Exception as e:  # noqa: BLE001
        log(f"  WARNING: forecast skipped: {e!r}")
        log(traceback.format_exc())

    # ---------- write zip shards
    log("Writing zip files")
    mk_index = {z: g.sort_values("month") for z, g in mk.groupby("zip")} if mk is not None else {}
    zips = sorted(set(d.index) | set(zall.index) | set(fh_wide.index))
    zips = [z for z in zips if len(z) == 5 and z.isdigit()]
    shards = {}
    for z in zips:
        rec = {}
        if z in meta.index:
            m = meta.loc[z]
            rec.update({"city": m.get("City"), "state": m.get("State"), "county": m.get("CountyName"),
                        "metro": m.get("Metro")})
        cf = zip_county.get(z)
        if cf:
            rec["county_fips"] = cf[0]
            rec.setdefault("county", cf[1])
            rec.setdefault("state", STATES.get(cf[0][:2], ("",))[0])
        if z in fh_wide.index:
            rec["hpi"] = series(fh_wide.loc[z], 1)
        values, now_vals = {}, {}
        for k, yr in zhvi_year.items():
            if z in yr.index:
                values[k] = series(yr.loc[z])
                last = zhvi[k].loc[z].dropna()
                if len(last):
                    now_vals[k] = int(round(last.iloc[-1]))
        if values:
            rec["zhvi"] = values
            rec["zhvi_now"] = now_vals
            rec["zhvi_recent"] = series(zall.loc[z].iloc[-60:]) if z in zall.index else None
        if zori_year is not None and z in zori_year.index:
            rec["zori"] = series(zori_year.loc[z])
            last = zori.loc[z].dropna()
            if len(last):
                rec["zori_now"] = int(round(last.iloc[-1]))
        if zhvf is not None and z in zhvf.index and pd.notna(zhvf[z]):
            rec["zhvf_1y"] = round(float(zhvf[z]), 1)
        if z in a.index:
            row, dr = a.loc[z], d.loc[z]
            rec["acs"] = {
                "pop": row["pop"], "income": row["income"], "home_value": row["home_value"], "rent": row["rent"],
                "renter_share": dr["renter_share"], "rent_vacancy": dr["rent_vacancy"], "poverty": dr["poverty"],
                "unemployment": dr["unemployment"], "college": dr["college"], "tax_rate": dr["tax_rate"],
                "broadband": dr["broadband"],
                "year_built": row["year_built"],
                "mix": {"Single-family detached": row["u1d"], "Townhouse / attached": row["u1a"],
                        "2-4 units": row["u2"] + row["u34"], "5-19 units": row["u59"] + row["u1019"],
                        "20+ units": row["u2049"] + row["u50"], "Mobile home": row["umobile"]},
            }
            for k in ("income_old", "college_old"):
                if k in dr:
                    rec["acs"][k] = dr[k]
            rec["acs"] = {k: (round(float(v), 2) if isinstance(v, (float, np.floating)) else v)
                          for k, v in rec["acs"].items()}
            rec["acs"]["mix"] = {k: (None if pd.isna(v) else int(v)) for k, v in rec["acs"]["mix"].items()}
            rec["ind"] = {k: round(float(dr[k]), 2) for k in
                          ("income_change", "value_change", "rent_change", "college_change",
                           "price_to_income", "rent_yield", "growth10", "crime")
                          if k in dr and pd.notna(dr[k])}
            rec["pct"] = {k: pct.loc[z, k] for k in pct.columns if pd.notna(pct.loc[z, k])}
        if z in points.index:
            rec["lat"], rec["lon"] = round(float(points.loc[z, "lat"]), 4), round(float(points.loc[z, "lon"]), 4)
        if util is not None and z in util.index and util.loc[z].notna().any():
            rec["util"] = {k: round(float(v)) for k, v in util.loc[z].items() if pd.notna(v)}
        if ring is not None and z in ring.index and ring.loc[z, "n"] > 0:
            rec["ring"] = {k: round(float(v), 2) for k, v in ring.loc[z].items() if pd.notna(v)}
        if hazard is not None and z in hazard.index:
            hz = hazard.loc[z]
            per = sorted(((extras.HAZARDS[c], float(hz[c])) for c in extras.HAZARDS if c in hz and pd.notna(hz[c])),
                         key=lambda t: -t[1])
            rec["hazard"] = {"risk": round(float(hz["risk"]), 1) if pd.notna(hz["risk"]) else None,
                             "label": extras.hazard_label(float(hz["risk"])),
                             "loss_rate": round(float(hz["loss_rate"]), 3) if pd.notna(hz["loss_rate"]) else None,
                             "top": [[n, round(v, 1), extras.hazard_label(v)] for n, v in per[:6]]}
        if mk is not None and z in mk_index:
            sub = mk_index[z]
            last = sub.iloc[-1].to_dict()
            prev = sub[sub["month"] <= sub["month"].iloc[-1] - 12]
            rec["market"] = {"month": str(last["month"]), "label": extras.market_label(last),
                             **{k: round(float(last[k]), 3) for k in sub.columns
                                if k not in ("zip", "month") and pd.notna(last[k])}}
            if len(prev):
                p0 = prev.iloc[-1].to_dict()
                rec["market"]["year_ago"] = {k: round(float(p0[k]), 3) for k in sub.columns
                                             if k not in ("zip", "month") and pd.notna(p0[k])}
                rec["market"]["year_ago"]["label"] = extras.market_label(p0)
        if jobs is not None and rec.get("county_fips") in jobs.index:
            j = jobs.loc[rec["county_fips"]]
            rec["jobs"] = {k: (round(float(j[k]), 1) if pd.notna(j[k]) else None) for k in ("jobs", "avg_pay", "jobs_change")}
        if near and z in near:
            rows_ = []
            for dist_mi, i in near[z]:
                sc = schools.iloc[i]
                g = lambda c: sc[c] if c in sc and pd.notna(sc[c]) else None  # noqa: E731
                lea = g("leaid")
                dg = dgrades.loc[lea] if dgrades is not None and lea in dgrades.index else None
                lvl = g("school_level")
                num_ = lambda v: float(v) if v is not None and float(v) >= 0 else None  # noqa: E731
                enroll, fte = num_(g("enrollment")), num_(g("teachers_fte"))
                rows_.append({"name": g("school_name"), "level": extras.LEVELS.get(int(lvl), "Other") if lvl is not None and float(lvl) > 0 else None,
                              "mi": round(dist_mi, 1), "enroll": int(enroll) if enroll else None,
                              "ratio": round(enroll / fte, 1) if enroll and fte else None,
                              "math": num_(g("math_test_pct_prof_midpt")), "read": num_(g("read_test_pct_prof_midpt")),
                              "charter": bool(g("charter") == 1), "district": g("lea_name"),
                              "dgrade": str(dg["grade"]) if dg is not None else None})
            main = None
            if dgrades is not None:
                leas = [schools.iloc[i]["leaid"] for _, i in near[z][:4] if schools.iloc[i]["leaid"] in dgrades.index]
                if leas:
                    lea = min(set(leas), key=lambda x: (-leas.count(x), leas.index(x)))   # most common, then nearest
                    dg = dgrades.loc[lea]
                    main = {"name": schools[schools["leaid"] == lea]["lea_name"].iloc[0], "grade": str(dg["grade"]),
                            "pct": float(dg["pct"]), "year": int(dg["year"]) if pd.notna(dg["year"]) else None}
            rec["schools"] = {"district": main, "list": rows_}
        if z in gent:
            rec["gent"] = gent[z]
        fips = rec.get("county_fips")
        if z in fc:
            rec["fc"] = fc[z]
        if z in bt:
            rec["bt"] = bt[z]
        if fips and fips in county_votes:
            rec["votes"] = county_votes[fips]
        if len(rec) <= 1:
            continue
        shards.setdefault(z[:3], {})[z] = clean(rec)

    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "zips").mkdir(parents=True)
    for prefix, recs in shards.items():
        (OUT / "zips" / f"{prefix}.json").write_text(json.dumps(recs, separators=(",", ":")))

    # ---------- states (votes + landlord/tenant law table)
    laws = laws_table()
    states = {}
    for r in laws.itertuples():
        states[r.state] = {"name": r.name, "car_insurance": int(r.car_insurance) if r.car_insurance else None,
                           "law": {"rent_control": r.rent_control, "just_cause": r.just_cause,
                                   "nonpay_notice_days": r.nonpay_notice_days, "notes": r.notes}}
        if r.state in state_votes:
            states[r.state]["votes"] = state_votes[r.state]
    (OUT / "states.json").write_text(json.dumps(states, separators=(",", ":")))

    # ---------- listings saved by fetch_listings.py
    if LISTINGS_SRC.exists():
        shutil.copytree(LISTINGS_SRC, OUT / "listings")

    national["asof"] = asof
    national["acs_years"] = [old_year, acs_year]
    (OUT / "national.json").write_text(json.dumps(clean(national), separators=(",", ":")))
    total = sum(len(v) for v in shards.values())
    log(f"Done: {total} zip codes in {len(shards)} files. Sources as of: {asof}")


if __name__ == "__main__":
    main()
