#!/usr/bin/env python3
# Copyright (c) 2026 Divya Chari
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""Pull homes for sale and for rent for the zips in watchlist.txt.

Listings come from Realtor.com through the free open-source HomeHarvest library (no key,
refreshed daily). If that fails for a zip and a RENTCAST_API_KEY is set, RentCast is used as
a backup, at most weekly and for a few zips so the free plan (50 calls a month) lasts.
Results are saved in listings/<zip>.json, with each home's facing direction estimated from
OpenStreetMap streets.

It also looks up the RentCast property record (year built, roof / exterior / foundation type,
tax assessments, property taxes, last sale) for each address in inspect.txt. Each address is
looked up once and kept, at most NEW_INSPECTIONS per run.
"""
import datetime as dt
import json
import math
import os
import sys
from pathlib import Path

import requests

import orient

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "listings"
WATCHLIST = ROOT / "watchlist.txt"
INSPECT = ROOT / "inspect.txt"
RENTCAST = "https://api.rentcast.io/v1/listings"
MAX_ZIPS = 30            # zips pulled daily from Realtor.com
RENTCAST_DAYS = 6        # backup source: refresh at most weekly ...
RENTCAST_ZIPS = 5        # ... and for at most this many zips
NEW_INSPECTIONS = 3      # new house lookups per run

STYLE = [("SINGLE", "Single Family"), ("CONDO", "Condo"), ("COOP", "Condo"), ("TOWN", "Townhouse"),
         ("MULTI", "Multi-Family"), ("DUPLEX", "Multi-Family"), ("LAND", "Land"), ("FARM", "Land"),
         ("MOBILE", "Manufactured"), ("MANUFACTURED", "Manufactured"), ("APARTMENT", "Apartment")]


def num(v):
    try:
        v = float(v)
        return None if math.isnan(v) else v
    except (TypeError, ValueError):
        return None


def from_homeharvest(row):
    """One HomeHarvest row -> the listing fields the site uses."""
    g = lambda *keys: next((row.get(k) for k in keys if row.get(k) not in (None, "") and str(row.get(k)) != "nan"), None)  # noqa: E731
    style = str(g("style", "property_type") or "").upper()
    ptype = next((name for key, name in STYLE if key in style), style.title() or None)
    addr = g("formatted_address")
    if not addr:
        street = " ".join(str(x) for x in (g("street"), g("unit")) if x)
        addr = ", ".join(str(x) for x in (street, g("city"), f"{g('state') or ''} {g('zip_code') or ''}".strip()) if x)
    full, half = num(g("full_baths")), num(g("half_baths"))
    out = {
        "id": str(g("property_id", "listing_id", "mls_id") or addr),
        "formattedAddress": addr, "propertyType": ptype, "price": num(g("list_price")),
        "bedrooms": num(g("beds")), "bathrooms": (full or 0) + 0.5 * (half or 0) if full is not None else None,
        "squareFootage": num(g("sqft")), "lotSize": num(g("lot_sqft")), "yearBuilt": num(g("year_built")),
        "daysOnMarket": num(g("days_on_mls")), "latitude": num(g("latitude")), "longitude": num(g("longitude")),
        "hoa": num(g("hoa_fee")), "url": g("property_url"),   # no photos or descriptions are kept
    }
    for k in ("bedrooms", "squareFootage", "lotSize", "yearBuilt", "daysOnMarket"):
        if out[k] is not None:
            out[k] = int(out[k])
    return {k: v for k, v in out.items() if v not in (None, "", 0) or k == "bedrooms" and v == 0}


def homeharvest(zipcode, kind):
    from homeharvest import scrape_property
    df = scrape_property(location=zipcode, listing_type=kind)
    rows = [from_homeharvest(r) for r in df.to_dict("records")]
    # keep homes actually in this zip (searches can spill into neighbours)
    return [r for r in rows if zipcode in (r.get("formattedAddress") or "") or not r.get("formattedAddress")]


def rentcast(path, key, zipcode):
    r = requests.get(f"{RENTCAST}/{path}", headers={"X-Api-Key": key, "Accept": "application/json"},
                     params={"zipCode": zipcode, "status": "Active", "limit": 500}, timeout=60)
    r.raise_for_status()
    keep = ["id", "formattedAddress", "propertyType", "price", "bedrooms", "bathrooms", "squareFootage",
            "lotSize", "yearBuilt", "daysOnMarket", "latitude", "longitude"]
    out = []
    for x in r.json():
        y = {k: x[k] for k in keep if x.get(k) is not None}
        if (x.get("hoa") or {}).get("fee"):
            y["hoa"] = x["hoa"]["fee"]
        out.append(y)
    return out


def add_facing(data):
    """Estimate which way each house faces from OpenStreetMap streets."""
    try:
        orient.add_orientation(data["sale"])
        n = sum(1 for x in data["sale"] if x.get("orient"))
        print(f"{data['zip']}: facing direction estimated for {n} of {len(data['sale'])} homes")
    except Exception as e:  # noqa: BLE001
        print(f"{data['zip']}: could not estimate facing directions: {e}", file=sys.stderr)


def inspect_houses(key):
    """RentCast property records for the addresses in inspect.txt, saved in listings/properties.json."""
    path = OUT / "properties.json"
    saved = json.loads(path.read_text()) if path.exists() else {}
    wanted = [ln.split("#")[0].strip() for ln in INSPECT.read_text().splitlines()] if INSPECT.exists() else []
    wanted = [a for a in wanted if a]
    for address in [a for a in wanted if a not in saved][:NEW_INSPECTIONS] if key else []:
        r = requests.get("https://api.rentcast.io/v1/properties", headers={"X-Api-Key": key, "Accept": "application/json"},
                         params={"address": address}, timeout=60)
        if r.status_code != 200:
            print(f"{address}: RentCast error {r.status_code}: {r.text[:200]}", file=sys.stderr)
            continue
        found = r.json()
        saved[address] = found[0] if found else {"formattedAddress": address, "notFound": True}
        print(f"{address}: {'found' if found else 'not found'}")
    saved = {a: v for a, v in saved.items() if a in wanted}      # drop removed addresses
    path.write_text(json.dumps(saved, separators=(",", ":")))


def main():
    key = os.environ.get("RENTCAST_API_KEY", "").strip()
    zips = []
    for line in WATCHLIST.read_text().splitlines():
        z = line.split("#")[0].strip()
        if len(z) == 5 and z.isdigit() and z not in zips:
            zips.append(z)
    if len(zips) > MAX_ZIPS:
        print(f"Watchlist has {len(zips)} zips; only the first {MAX_ZIPS} are used.")
        zips = zips[:MAX_ZIPS]
    OUT.mkdir(exist_ok=True)
    today = dt.date.today()
    rentcast_used = 0
    for z in zips:
        path = OUT / f"{z}.json"
        old = json.loads(path.read_text()) if path.exists() else None
        data = None
        try:
            data = {"zip": z, "fetched": today.isoformat(), "source": "Realtor.com",
                    "sale": homeharvest(z, "for_sale"), "rent": homeharvest(z, "for_rent")}
        except Exception as e:  # noqa: BLE001
            print(f"{z}: Realtor.com (HomeHarvest) failed: {e}", file=sys.stderr)
            stale = not old or (today - dt.date.fromisoformat(old["fetched"])).days >= RENTCAST_DAYS
            if key and stale and rentcast_used < RENTCAST_ZIPS:
                try:
                    data = {"zip": z, "fetched": today.isoformat(), "source": "RentCast",
                            "sale": rentcast("sale", key, z), "rent": rentcast("rental/long-term", key, z)}
                    rentcast_used += 1
                except requests.HTTPError as e2:
                    print(f"{z}: RentCast error {e2.response.status_code}: {e2.response.text[:200]}", file=sys.stderr)
        if data is None:
            if old:
                print(f"{z}: keeping listings from {old['fetched']}")
            continue
        print(f"{z}: {len(data['sale'])} for sale, {len(data['rent'])} for rent ({data['source']})")
        add_facing(data)
        path.write_text(json.dumps(data, separators=(",", ":")))
    # drop zips that were removed from the watchlist
    for p in OUT.glob("*.json"):
        if p.stem not in zips and p.stem not in ("index", "properties"):
            p.unlink()
    index = sorted(p.stem for p in OUT.glob("*.json") if p.stem not in ("index", "properties"))
    (OUT / "index.json").write_text(json.dumps(index))
    inspect_houses(key)


if __name__ == "__main__":
    main()
