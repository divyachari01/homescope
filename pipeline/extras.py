"""Extra zip-level data: location, surrounding area, natural hazards, buyer/seller market,
the Fed's interest rate and typical utility bills. Every loader is optional: build_data.py
skips a block with a warning if its source can't be downloaded or read."""
import io
import json
import re
import zipfile

import numpy as np
import pandas as pd

HAZARDS = {
    "AVLN": "Avalanche", "CFLD": "Coastal flooding", "CWAV": "Cold wave", "DRGT": "Drought",
    "ERQK": "Earthquake", "HAIL": "Hail", "HWAV": "Heat wave", "HRCN": "Hurricane", "ISTM": "Ice storm",
    "LNDS": "Landslide", "LTNG": "Lightning", "RFLD": "River flooding", "SWND": "Strong wind",
    "TRND": "Tornado", "TSUN": "Tsunami", "VLCN": "Volcano", "WFIR": "Wildfire", "WNTW": "Winter weather",
}
EARTH_RADIUS_MI = 3958.8


def read_zipped_table(path, sep=None):
    """First csv/txt inside a zip file as a DataFrame (all text)."""
    with zipfile.ZipFile(path) as z:
        name = next(n for n in z.namelist() if n.lower().endswith((".csv", ".txt")))
        with z.open(name) as f:
            data = f.read()
    return pd.read_csv(io.BytesIO(data), sep=sep, engine="python" if sep is None else "c", dtype=str)


# ---------------------------------------------------------------- location and surrounding area

def zip_points(gazetteer_zip):
    """ZCTA centre points (lat, lon) from the Census gazetteer file."""
    df = read_zipped_table(gazetteer_zip, sep="\t")
    df.columns = [c.strip() for c in df.columns]
    out = pd.DataFrame({"lat": pd.to_numeric(df["INTPTLAT"], errors="coerce"),
                        "lon": pd.to_numeric(df["INTPTLONG"], errors="coerce")})
    out.index = df["GEOID"].str.strip().str.zfill(5)
    return out.dropna()


def surrounding(points, values, weights, radius_mi=5.0):
    """For each zip, the population-weighted average of `values` over the OTHER zips whose
    centre is within `radius_mi`. Returns (averages DataFrame, number of neighbours)."""
    from sklearn.neighbors import BallTree
    pts = points.reindex(values.index).dropna()
    if pts.empty:
        return pd.DataFrame(), pd.Series(dtype=int)
    tree = BallTree(np.radians(pts[["lat", "lon"]].to_numpy()), metric="haversine")
    nbrs = tree.query_radius(np.radians(pts[["lat", "lon"]].to_numpy()), r=radius_mi / EARTH_RADIUS_MI)
    vals = values.reindex(pts.index).to_numpy(float)
    w = weights.reindex(pts.index).fillna(0).to_numpy(float)
    out = np.full(vals.shape, np.nan)
    count = np.zeros(len(pts), int)
    for i, idx in enumerate(nbrs):
        idx = idx[idx != i]
        count[i] = len(idx)
        if not len(idx):
            continue
        v, ww = vals[idx], w[idx][:, None]
        ok = ~np.isnan(v)
        tot = (ww * ok).sum(axis=0)
        with np.errstate(invalid="ignore", divide="ignore"):
            out[i] = np.where(tot > 0, np.nansum(v * ww, axis=0) / tot, np.nan)
    return pd.DataFrame(out, index=pts.index, columns=values.columns), pd.Series(count, index=pts.index)


# ---------------------------------------------------------------- FEMA National Risk Index

def hazards_by_zip(nri_zip, zcta_tract_path):
    """FEMA National Risk Index (census tracts) averaged to zips, weighted by land area.
    Returns DataFrame: risk (0-100 score), loss_rate (expected yearly loss to buildings as % of
    building value) and one 0-100 score per hazard."""
    nri = read_zipped_table(nri_zip)
    nri.columns = [c.strip().upper() for c in nri.columns]
    tract = nri["TRACTFIPS"].str.zfill(11)
    cols = {"risk": "RISK_SCORE"}
    for code in HAZARDS:
        if f"{code}_RISKS" in nri.columns:
            cols[code] = f"{code}_RISKS"
    t = pd.DataFrame({k: pd.to_numeric(nri[v], errors="coerce") for k, v in cols.items()})
    t["eal_b"] = pd.to_numeric(nri.get("EAL_VALB"), errors="coerce")
    t["buildvalue"] = pd.to_numeric(nri.get("BUILDVALUE"), errors="coerce")
    t.index = tract
    rel = pd.read_csv(zcta_tract_path, sep="|", dtype=str).dropna(subset=["GEOID_ZCTA5_20", "GEOID_TRACT_20"])
    rel["w"] = pd.to_numeric(rel["AREALAND_PART"], errors="coerce").fillna(0)
    rel = rel[rel["w"] > 0]
    tracts_total = rel.groupby("GEOID_TRACT_20")["w"].transform("sum")
    rel["share"] = rel["w"] / tracts_total            # share of the tract that lies in this zip
    m = rel.join(t, on="GEOID_TRACT_20")
    score_cols = [c for c in cols]
    out = {}
    for c in score_cols:
        ok = m[c].notna()
        out[c] = (m.loc[ok, c] * m.loc[ok, "w"]).groupby(m.loc[ok, "GEOID_ZCTA5_20"]).sum() / \
            m.loc[ok, "w"].groupby(m.loc[ok, "GEOID_ZCTA5_20"]).sum()
    eal = (m["eal_b"] * m["share"]).groupby(m["GEOID_ZCTA5_20"]).sum()
    bv = (m["buildvalue"] * m["share"]).groupby(m["GEOID_ZCTA5_20"]).sum()
    out["loss_rate"] = (eal / bv.replace(0, np.nan)) * 100
    return pd.DataFrame(out)


def hazard_label(score):
    """NRI-style wording for a 0-100 score."""
    if not np.isfinite(score):
        return None
    for cut, lab in ((80, "Very high"), (60, "Relatively high"), (40, "Moderate"), (20, "Relatively low")):
        if score >= cut:
            return lab
    return "Very low"


# ---------------------------------------------------------------- Redfin buyer/seller market

REDFIN_COLS = {"PERIOD_END": "end", "REGION": "region", "PROPERTY_TYPE": "ptype", "PERIOD_DURATION": "dur",
               "MEDIAN_DOM": "dom", "AVG_SALE_TO_LIST": "sale_to_list", "SOLD_ABOVE_LIST": "above_list",
               "PRICE_DROPS": "price_drops", "MONTHS_OF_SUPPLY": "months_supply", "INVENTORY": "inventory",
               "HOMES_SOLD": "homes_sold", "MEDIAN_SALE_PRICE": "median_sale"}


def redfin_market(path):
    """Redfin zip market tracker -> monthly table (zip, month, metrics), all residential homes."""
    header = pd.read_csv(path, sep="\t", nrows=0).columns
    pick = {c: REDFIN_COLS[c.upper()] for c in header if c.upper() in REDFIN_COLS}
    parts = []
    for chunk in pd.read_csv(path, sep="\t", usecols=list(pick), chunksize=500_000, dtype=str):
        chunk = chunk.rename(columns=pick)
        chunk = chunk[chunk["ptype"].str.strip().str.lower() == "all residential"]
        if "dur" in chunk:
            chunk = chunk[chunk["dur"].astype(str).str.strip().isin(["90", "90.0"])]
        parts.append(chunk)
    df = pd.concat(parts)
    df["zip"] = df["region"].str.extract(r"(\d{5})")[0]
    df["month"] = pd.to_datetime(df["end"]).dt.to_period("M")
    for c in ("dom", "sale_to_list", "above_list", "price_drops", "months_supply", "inventory", "homes_sold", "median_sale"):
        if c in df:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    keep = ["zip", "month"] + [c for c in ("dom", "sale_to_list", "above_list", "price_drops", "months_supply",
                                            "inventory", "homes_sold", "median_sale") if c in df]
    return df.dropna(subset=["zip"])[keep].drop_duplicates(["zip", "month"], keep="last")


def market_label(row):
    """Plain buyer's / seller's market call, mainly from months of supply (the usual rule of thumb)."""
    ms, stl, dom = row.get("months_supply"), row.get("sale_to_list"), row.get("dom")
    if ms is not None and np.isfinite(ms):
        return "Seller's market" if ms < 4 else "Buyer's market" if ms > 6 else "Balanced"
    if stl is not None and np.isfinite(stl):
        if stl >= 1.0 and (dom is None or not np.isfinite(dom) or dom < 30):
            return "Seller's market"
        if stl < 0.97:
            return "Buyer's market"
        return "Balanced"
    return None


def market_by_year(mk):
    """Yearly averages of the market measures, for the forecast model: {year: DataFrame by zip}."""
    mk = mk.copy()
    mk["year"] = mk["month"].dt.year
    cols = [c for c in ("dom", "sale_to_list", "above_list", "price_drops", "months_supply") if c in mk]
    g = mk.groupby(["year", "zip"])[cols].mean()
    return {int(y): sub.droplevel(0) for y, sub in g.groupby(level=0)}


# ---------------------------------------------------------------- Fed funds rate (New York Fed)

def fed_funds(path):
    """Effective federal funds rate, monthly average, from the NY Fed's saved JSON."""
    rows = json.loads(open(path).read()).get("refRates", [])
    df = pd.DataFrame({"date": pd.to_datetime([r["effectiveDate"] for r in rows]),
                       "value": pd.to_numeric([r.get("percentRate") for r in rows], errors="coerce")}).dropna()
    return df.set_index("date")["value"].sort_index().resample("MS").mean().dropna()


# ---------------------------------------------------------------- utility bills from the Census

def bracket_vars(meta):
    """Census group metadata -> {variable: (low, high)} for the '$ bracket' rows of a cost table."""
    out = {}
    for name, info in meta.get("variables", {}).items():
        if not name.endswith("E"):
            continue
        label = info.get("label", "")
        last = label.split("!!")[-1]
        nums = [int(x.replace(",", "")) for x in re.findall(r"\$([\d,]+)", last)]
        if not nums:
            continue
        if last.lower().startswith("less than"):
            out[name] = (0, nums[0])
        elif "or more" in last.lower():
            out[name] = (nums[0], nums[0] * 1.4)
        elif len(nums) == 2:
            out[name] = (nums[0], nums[1] + 1)
    return out


def bracket_mean(df, brackets):
    """Average monthly cost per zip from bracket counts (each bracket counted at its midpoint)."""
    num = sum(df[v] * (lo + hi) / 2 for v, (lo, hi) in brackets.items())
    den = sum(df[v] for v in brackets)
    return num / den.replace(0, np.nan)
