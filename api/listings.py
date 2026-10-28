# Copyright (c) 2026 Divya Chari
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""Live listings for any zip, as a Vercel serverless function.

GET /api/listings?zip=43201 returns the same JSON shape as listings/<zip>.json: homes for
sale and for rent from Realtor.com (via HomeHarvest), plus homes sold in the last 6 months.
GET /api/listings?address=... returns one property's record, listed or not. The page adds each home's facing
direction, walkable places and noise from OpenStreetMap itself. Vercel's cache keeps each
zip's answer for 6 hours, so repeat visits are instant.
"""
import datetime as dt
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import fetch_listings  # noqa: E402


def build(zipcode):
    # Sale and rental searches run at the same time. The street-map step (facing, walkable
    # places, noise) runs in the visitor's browser instead, which is faster than from here.
    with ThreadPoolExecutor(3) as pool:
        sale = pool.submit(fetch_listings.homeharvest, zipcode, "for_sale")
        rent = pool.submit(fetch_listings.homeharvest, zipcode, "for_rent")
        sold = pool.submit(fetch_listings.sold, zipcode)
        out = {"zip": zipcode, "fetched": dt.date.today().isoformat(), "source": "Realtor.com",
               "sale": sale.result(), "rent": rent.result()}
        try:
            out["sold"] = sold.result()      # recent sales for the deal check; optional
        except Exception as e:  # noqa: BLE001
            out["sold"], out["soldError"] = [], repr(e)[:300]
        return out


FEATURES = ("Building and Construction", "Heating and Cooling", "Other Rooms", "Utilities",
            "Exterior and Lot Features", "Garage and Parking", "Homeowners Association", "Interior Features")


def parse_home(r):
    """Realtor.com's full record for one home -> the fields the deal check uses."""
    d, loc = r.get("description") or {}, (r.get("location") or {}).get("address") or {}
    num = fetch_listings.num
    full, half = num(d.get("baths_full")), num(d.get("baths_half"))
    ptype = next((n for k, n in fetch_listings.STYLE if k in str(d.get("type") or "").upper()), None)
    addr = ", ".join(x for x in (loc.get("line"), loc.get("city"), f"{loc.get('state_code') or ''} {loc.get('postal_code') or ''}".strip()) if x)
    coord = loc.get("coordinate") or {}
    est = [{"name": (e.get("source") or {}).get("name"), "value": num(e.get("estimate")), "low": num(e.get("estimateLow")),
            "high": num(e.get("estimateHigh")), "date": e.get("date")}
           for e in ((r.get("estimates") or {}).get("currentValues") or []) if e.get("estimate")]
    taxes = [[t.get("year"), num(t.get("tax")), num((t.get("assessment") or {}).get("land")),
              num((t.get("assessment") or {}).get("building")), num((t.get("assessment") or {}).get("total"))]
             for t in (r.get("taxHistory") or [])[:12] if t.get("year")]
    feats = {x["category"]: x.get("text", [])[:8] for x in (r.get("details") or []) if x.get("category") in FEATURES}
    pop = next((p for p in ((r.get("popularity") or {}).get("periods") or []) if p.get("last_n_days") == 7), {})
    out = {
        "id": str(r.get("property_id") or addr), "formattedAddress": addr, "zip": str(loc.get("postal_code") or "")[:5],
        "state": loc.get("state_code"), "status": r.get("status"), "propertyType": ptype, "price": num(r.get("list_price")),
        "bedrooms": d.get("beds"), "bathrooms": (full or 0) + 0.5 * (half or 0) if full is not None else None,
        "squareFootage": d.get("sqft"), "lotSize": d.get("lot_sqft"), "yearBuilt": d.get("year_built"),
        "stories": d.get("stories"), "garage": d.get("garage"), "latitude": coord.get("lat"), "longitude": coord.get("lon"),
        "hoa": num((r.get("hoa") or {}).get("fee")), "url": r.get("href"), "photo": (r.get("primary_photo") or {}).get("href"),
        "listDate": fetch_listings.day(r.get("list_date")), "lastSoldDate": fetch_listings.day(r.get("last_sold_date")),
        "lastSoldPrice": num(r.get("last_sold_price")), "estimates": est or None,
        "estimate": next((e["value"] for e in est), None), "taxHistory": taxes or None, "tax": taxes[0][1] if taxes else None,
        "features": feats or None, "tags": r.get("tags"), "text": ((d.get("text") or "")[:3000]) or None,
        "views7": pop.get("views_total"), "saves7": pop.get("saves_total"),
        "newBuild": True if (r.get("flags") or {}).get("is_new_construction") else None,
    }
    if out["listDate"] and out["status"] == "for_sale":
        out["daysOnMarket"] = (dt.date.today() - dt.date.fromisoformat(out["listDate"])).days
    return {k: v for k, v in out.items() if v not in (None, "", [])}


def home(address):
    """One property by address, listed or not (for checking a house you found elsewhere)."""
    from homeharvest import scrape_property
    rows = scrape_property(location=address, return_type="raw")
    return {"home": parse_home(rows[0]) if rows else None}


class handler(BaseHTTPRequestHandler):  # noqa: N801  (name required by Vercel)
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        address = (q.get("address") or [""])[0].strip()
        if address:
            try:
                return self.send(200, home(address[:200]), cache=True)
            except Exception as e:  # noqa: BLE001
                return self.send(502, {"error": f"lookup failed: {e}"}, cache=False)
        z = (q.get("zip") or [""])[0].strip()
        if not (len(z) == 5 and z.isdigit()):
            return self.send(400, {"error": "give a 5-digit zip, e.g. ?zip=43201"}, cache=False)
        try:
            return self.send(200, build(z), cache=True)
        except Exception as e:  # noqa: BLE001
            return self.send(502, {"error": f"listings source failed: {e}"}, cache=False)

    def send(self, status, body, cache):
        raw = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400" if cache else "no-store")
        self.end_headers()
        self.wfile.write(raw)
