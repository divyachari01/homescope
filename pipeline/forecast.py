# Copyright (c) 2026 Divya Chari
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""Machine-learning price forecast for every zip code.

In simple words: for each past year from 2014 on, we describe every zip with what was
known that year (price trend, rates, income, jobs, renters, crime, politics, landlord
law ...) and record how much its prices actually grew over the next 1, 3 and 5 years.
A gradient-boosted tree model learns that mapping. We then describe each zip as of
today and ask the model for the next 1, 3 and 5 years.

Three models per horizon give a low / likely / high range (10th, 50th and 90th
percentile). Before the final fit, each horizon is tested on the most recent period the
model never saw, and compared with simply extending the zip's own 10-year trend.
"""
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance

HORIZONS = (1, 3, 5)
QUANTILES = (0.1, 0.5, 0.9)
FIRST_ORIGIN = 2014        # ACS zip data starts in 2012; each origin uses data published 2 years earlier
BACKTEST_FROM = 2022       # first year whose prices we "predict" using only older data
ACS_LAG = 2                # ACS 5-year data for year y comes out at the end of y+1

ACS_MODEL_VARS = ["B01003_001E", "B19013_001E", "B25077_001E", "B25064_001E", "B25003_001E",
                  "B25003_003E", "B25004_002E", "B17001_001E", "B17001_002E", "B23025_003E",
                  "B23025_005E", "B15003_001E", "B15003_022E", "B15003_023E", "B15003_024E",
                  "B15003_025E"]

LABELS = {
    "growth_1y": "Price change last year", "growth_3y": "Price trend, 3 yrs", "growth_5y": "Price trend, 5 yrs",
    "growth_10y": "Price trend, 10 yrs", "volatility": "How bumpy prices have been",
    "price_to_income": "Price vs local income", "rent_to_value": "Rent vs price",
    "log_income": "Household income", "income_growth": "Income growth", "rent_growth": "Rent growth",
    "stocks_1y": "Stock market, last year", "fed_rate": "Fed interest rate", "fed_change_1y": "Fed rate change, 1 yr",
    "mkt_dom": "Days homes take to sell", "mkt_sale_to_list": "Sale vs asking price", "mkt_above_list": "Share sold above asking",
    "mkt_price_drops": "Share of listings with price cuts", "mkt_pending_ratio": "Pending sales per listing", "mkt_months_supply": "Months of supply (buyer/seller market)",
    "hazard_risk": "Natural hazard risk", "hazard_loss": "Expected hazard losses", "stocks_5y": "Stock market, 5-yr trend", "college": "College-educated share",
    "college_change": "Change in college share", "poverty": "Poverty rate", "unemployment": "Unemployment",
    "renter_share": "Share of renters", "rent_vacancy": "Empty rentals", "log_pop": "Population",
    "pop_growth": "Population growth", "rate": "Mortgage rate", "rate_change_1y": "Rate change, 1 yr",
    "rate_change_3y": "Rate change, 3 yrs", "us_growth_1y": "US price trend", "crime": "Violent crime (county)",
    "vote_margin": "Political lean (R minus D)", "vote_shift": "Political shift, 8 yrs",
    "rent_control": "Rent control rules", "just_cause": "Just-cause eviction rule",
    "notice_days": "Eviction notice days", "car_insurance": "Car insurance cost", "state": "State",
}


def combined_prices(fh_wide, zhvi_year):
    """Yearly dollar price per zip: FHFA index (from 1975) scaled to Zillow, Zillow after that."""
    z = zhvi_year["all"].copy()
    if "sfr" in zhvi_year:                       # prefer single-family values, which match FHFA
        sfr = zhvi_year["sfr"].reindex(columns=z.columns)
        has = sfr.index[sfr.notna().any(axis=1)].intersection(z.index)
        z.loc[has] = sfr.loc[has]
    years = sorted(set(fh_wide.columns) | set(z.columns))
    zips = sorted(set(fh_wide.index) | set(z.index))
    f = fh_wide.reindex(index=zips, columns=years).to_numpy(float)
    zz = z.reindex(index=zips, columns=years).to_numpy(float)
    out = zz.copy()
    both = ~np.isnan(f) & ~np.isnan(zz)
    for i in np.where(both.any(axis=1))[0]:
        a = np.where(both[i])[0][-1]                # last year both exist
        scaled = f[i] * zz[i, a] / f[i, a]
        out[i, :a + 1] = scaled[:a + 1]
    return pd.DataFrame(out, index=zips, columns=years)


def features(P, y, acs, macro, votes, static, market):
    """One row per zip describing it as of year y, using only what was known then."""
    f = pd.DataFrame(index=P.index)
    p0 = P[y]
    for k in (1, 3, 5, 10):
        if y - k in P.columns:
            f[f"growth_{k}y"] = (p0 / P[y - k]) ** (1 / k) - 1
    past = P[[c for c in P.columns if y - 10 <= c <= y]]
    f["volatility"] = np.log(past).diff(axis=1).std(axis=1)

    a = acs.get(y - ACS_LAG)
    a5 = acs.get(y - ACS_LAG - 5)
    if a is not None:
        a = a.reindex(f.index)
        f["log_income"] = np.log(a["B19013_001E"])
        f["price_to_income"] = p0 / a["B19013_001E"]
        f["rent_to_value"] = a["B25064_001E"] * 12 / a["B25077_001E"]
        coll = (a["B15003_022E"] + a["B15003_023E"] + a["B15003_024E"] + a["B15003_025E"]) / a["B15003_001E"]
        f["college"] = coll
        f["poverty"] = a["B17001_002E"] / a["B17001_001E"]
        f["unemployment"] = a["B23025_005E"] / a["B23025_003E"]
        f["renter_share"] = a["B25003_003E"] / a["B25003_001E"]
        f["rent_vacancy"] = a["B25004_002E"] / (a["B25003_003E"] + a["B25004_002E"])
        f["log_pop"] = np.log(a["B01003_001E"])
        if a5 is not None:
            a5 = a5.reindex(f.index)
            f["income_growth"] = a["B19013_001E"] / a5["B19013_001E"] - 1
            f["rent_growth"] = a["B25064_001E"] / a5["B25064_001E"] - 1
            f["pop_growth"] = a["B01003_001E"] / a5["B01003_001E"] - 1
            f["college_change"] = coll - (a5["B15003_022E"] + a5["B15003_023E"] + a5["B15003_024E"]
                                          + a5["B15003_025E"]) / a5["B15003_001E"]

    m = lambda col, yy: macro[col].get(yy, np.nan)  # noqa: E731
    f["rate"] = m("rate", y)
    f["rate_change_1y"] = m("rate", y) - m("rate", y - 1)
    f["rate_change_3y"] = m("rate", y) - m("rate", y - 3)
    f["fed_rate"] = m("fed", y)
    f["fed_change_1y"] = m("fed", y) - m("fed", y - 1)
    mk = market.get(y)
    if mk is not None:
        for col in mk.columns:
            f[f"mkt_{col}"] = mk[col].reindex(f.index)
    f["stocks_1y"] = m("stocks", y) / m("stocks", y - 1) - 1
    f["stocks_5y"] = (m("stocks", y) / m("stocks", y - 5)) ** 0.2 - 1
    if y - 1 in P.columns:
        f["us_growth_1y"] = float(np.nanmedian(p0 / P[y - 1] - 1))

    margin, shift = votes(y)
    f["vote_margin"] = f.index.map(margin)
    f["vote_shift"] = f.index.map(shift)
    for col in static.columns:
        f[col] = static[col].reindex(f.index)
    return f.replace([np.inf, -np.inf], np.nan).astype(float)


def fit(X, y, q):
    """Quantile model on the inputs that have any data (empty inputs are dropped)."""
    cols = [c for c in X.columns if X[c].notna().any() and X[c].nunique() > 1]
    X = X[cols]
    cat = [c == "state" for c in X.columns]
    m = HistGradientBoostingRegressor(loss="quantile", quantile=q, max_iter=200, learning_rate=0.05,
                                      max_leaf_nodes=31, min_samples_leaf=200, l2_regularization=1.0,
                                      categorical_features=cat, random_state=0)
    m.fit(X, y)
    m.cols_ = cols
    return m


def predict(m, X):
    return m.predict(X[m.cols_])


def run(P, acs, macro, votes, static, market, log=print):
    """Train, test and predict. Returns (per-zip forecasts, model summary)."""
    P = P.where(P > 0).dropna(how="all")          # zero or negative prices are data errors
    now = max(P.columns)                                    # latest (possibly partial) year
    last_full = now - 1
    rows = {}
    for y in range(FIRST_ORIGIN, now + 1):
        if y in P.columns:
            rows[y] = features(P, y, acs, macro, votes, static, market)

    def dataset(h, origins, latest_target=last_full):
        Xs, ys = [], []
        for y in origins:
            if y + h > latest_target or y not in rows or y + h not in P.columns:
                continue
            target = np.log(P[y + h] / P[y])
            ok = target.notna() & P[y].notna()
            Xs.append(rows[y][ok]); ys.append(target[ok])
        return (pd.concat(Xs), pd.concat(ys)) if Xs else (None, None)

    summary = {"horizons": {}, "base_year": now, "first_origin": FIRST_ORIGIN, "backtest": []}
    preds, past = {}, {}
    X_now = rows[now]
    trend = lambda X, h: h * np.log1p(X["growth_10y"].fillna(X["growth_5y"]).fillna(0))  # noqa: E731
    for h in HORIZONS:
        scores = []   # how far each past outcome fell outside its predicted range (for widening it)
        # --- walk-forward test, like using the model in real time: to "predict" year T we stand
        # at year T-h and train only on outcomes that were already known then.
        for T in range(BACKTEST_FROM, now + 1):
            o = T - h
            Xtr, ytr = dataset(h, range(FIRST_ORIGIN, o - h + 1), latest_target=o)
            Xte, yte = dataset(h, [o], latest_target=T)
            if Xtr is None or Xte is None or len(Xtr) < 1000:
                continue
            q = {qq: predict(fit(Xtr, ytr, qq), Xte) for qq in QUANTILES}
            per_year = lambda e: float(np.nanmean(np.abs(e))) / h * 100   # noqa: E731
            res = {"horizon": h, "from": o, "to": T, "partial": T == now, "zips": int(len(yte)),
                   "model_error": round(per_year(q[0.5] - yte), 2),
                   "trend_error": round(per_year(trend(Xte, h) - yte), 2),
                   "inside_range": round(float(np.mean((yte >= q[0.1]) & (yte <= q[0.9]))) * 100, 1)}
            summary["backtest"].append(res)
            if T != now:
                scores += list(np.maximum(q[0.1] - yte.to_numpy(), yte.to_numpy() - q[0.9]))
            log(f"  {h}-yr test {o}->{T}: model off by {res['model_error']} pts/yr, "
                f"trend-only off by {res['trend_error']}, actual inside range {res['inside_range']}%")
            if h == 1:   # keep each zip's 1-year calls so the page can show predicted vs actual
                d = pd.DataFrame({"low": q[0.1], "mid": q[0.5], "high": q[0.9], "actual": yte.to_numpy()},
                                 index=yte.index)
                past[T] = (np.exp(d) - 1) * 100
        # --- final fit on everything known, then predict from today
        Xall, yall = dataset(h, range(FIRST_ORIGIN, last_full - h + 1))
        n_origins = len({y for y in range(FIRST_ORIGIN, last_full - h + 1) if y in rows})
        models = {qq: fit(Xall, yall, qq) for qq in QUANTILES}
        p = np.column_stack([predict(models[qq], X_now) for qq in QUANTILES])
        p.sort(axis=1)                                           # keep low <= mid <= high
        # Past tests showed the raw 10-90% range was too narrow, so widen it by the amount
        # that would have put 80% of past outcomes inside (a "conformal" correction).
        widen = max(0.0, float(np.percentile(scores, 80))) if scores else 0.0
        p[:, 0] -= widen
        p[:, 2] += widen
        preds[h] = pd.DataFrame((np.exp(p) - 1) * 100, index=X_now.index, columns=["low", "mid", "high"])
        summary["horizons"][h] = {"widened_pts": round((np.exp(widen) - 1) * 100, 1), "train_rows": int(len(yall)), "train_years": n_origins}
        if h == 5:
            # Which inputs matter most: shuffle one input at a time and see how much worse the model gets.
            idx = np.random.default_rng(0).choice(len(Xall), min(20000, len(Xall)), replace=False)
            cols = models[0.5].cols_
            imp = permutation_importance(models[0.5], Xall.iloc[idx][cols], yall.iloc[idx], n_repeats=2, random_state=0)
            order = np.argsort(imp.importances_mean)[::-1]
            top = [(LABELS.get(cols[j], cols[j]), float(imp.importances_mean[j])) for j in order]
            total = sum(v for _, v in top if v > 0) or 1
            summary["drivers"] = [[name, round(v / total * 100, 1)] for name, v in top[:10] if v > 0]
    return preds, past, summary
