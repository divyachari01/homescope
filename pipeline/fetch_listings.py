#!/usr/bin/env python3
"""Pull for-sale and for-rent listings from RentCast for the zips in watchlist.txt.

Each zip costs 2 API calls (sale + rental). A zip is only refreshed when its saved
listings are older than REFRESH_DAYS, so the daily site rebuild does not use up the
free plan (50 calls a month). Results are saved in listings/<zip>.json.

Needs the environment variable RENTCAST_API_KEY. Without it the script does nothing.
"""
import datetime as dt
import json
import os
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "listings"
WATCHLIST = ROOT / "watchlist.txt"
API = "https://api.rentcast.io/v1/listings"
REFRESH_DAYS = 6     # about weekly
MAX_ZIPS = 6         # 6 zips x 2 calls x ~4 weeks = 48 calls, inside the free 50 a month

KEEP = ["id", "formattedAddress", "propertyType", "price", "bedrooms", "bathrooms", "squareFootage",
        "lotSize", "yearBuilt", "daysOnMarket", "listedDate", "latitude", "longitude"]


def trim(item):
    out = {k: item[k] for k in KEEP if item.get(k) is not None}
    hoa = (item.get("hoa") or {}).get("fee")
    if hoa:
        out["hoa"] = hoa
    return out


def get(path, key, zipcode):
    r = requests.get(f"{API}/{path}", headers={"X-Api-Key": key, "Accept": "application/json"},
                     params={"zipCode": zipcode, "status": "Active", "limit": 500}, timeout=60)
    r.raise_for_status()
    return [trim(x) for x in r.json()]


def main():
    key = os.environ.get("RENTCAST_API_KEY", "").strip()
    if not key:
        print("No RENTCAST_API_KEY set, skipping listings.")
        return
    zips = []
    for line in WATCHLIST.read_text().splitlines():
        z = line.split("#")[0].strip()
        if len(z) == 5 and z.isdigit() and z not in zips:
            zips.append(z)
    if len(zips) > MAX_ZIPS:
        print(f"Watchlist has {len(zips)} zips; only the first {MAX_ZIPS} are used to stay in the free plan.")
        zips = zips[:MAX_ZIPS]
    OUT.mkdir(exist_ok=True)
    today = dt.date.today()
    for z in zips:
        path = OUT / f"{z}.json"
        if path.exists():
            last = dt.date.fromisoformat(json.loads(path.read_text())["fetched"])
            if (today - last).days < REFRESH_DAYS:
                print(f"{z}: fetched {last}, still fresh")
                continue
        try:
            data = {"zip": z, "fetched": today.isoformat(),
                    "sale": get("sale", key, z), "rent": get("rental/long-term", key, z)}
        except requests.HTTPError as e:
            print(f"{z}: RentCast error {e.response.status_code}: {e.response.text[:200]}", file=sys.stderr)
            continue
        path.write_text(json.dumps(data, separators=(",", ":")))
        print(f"{z}: {len(data['sale'])} for sale, {len(data['rent'])} for rent")
    # drop zips that were removed from the watchlist
    for p in OUT.glob("*.json"):
        if p.stem not in zips and p.stem != "index":
            p.unlink()
    index = sorted(p.stem for p in OUT.glob("*.json") if p.stem != "index")
    (OUT / "index.json").write_text(json.dumps(index))


if __name__ == "__main__":
    main()
