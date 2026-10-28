# Copyright (c) 2026 Divya Chari
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""Live listings for any zip, as a Vercel serverless function.

GET /api/listings?zip=43201 returns the same JSON shape as listings/<zip>.json: homes for
sale and for rent from Realtor.com (via HomeHarvest), with each home's estimated facing
direction, walkable places and noise sources from OpenStreetMap. Vercel's cache keeps each
zip's answer for 6 hours, so repeat visits are instant.
"""
import datetime as dt
import json
import sys
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import fetch_listings  # noqa: E402
import orient  # noqa: E402


def build(zipcode):
    data = {"zip": zipcode, "fetched": dt.date.today().isoformat(), "source": "Realtor.com",
            "sale": fetch_listings.homeharvest(zipcode, "for_sale"),
            "rent": fetch_listings.homeharvest(zipcode, "for_rent")}
    start = time.time()
    try:   # the street-map step is a bonus: skip it if the map server is slow
        orient.OVERPASS_TIMEOUT = 25
        orient.add_orientation(data["sale"])
    except Exception:  # noqa: BLE001
        pass
    data["map_seconds"] = round(time.time() - start, 1)
    return data


class handler(BaseHTTPRequestHandler):  # noqa: N801  (name required by Vercel)
    def do_GET(self):
        z = (parse_qs(urlparse(self.path).query).get("zip") or [""])[0].strip()
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
