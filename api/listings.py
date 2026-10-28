# Copyright (c) 2026 Divya Chari
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""Live listings for any zip, as a Vercel serverless function.

GET /api/listings?zip=43201 returns the same JSON shape as listings/<zip>.json: homes for
sale and for rent from Realtor.com (via HomeHarvest). The page adds each home's facing
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
    with ThreadPoolExecutor(2) as pool:
        sale = pool.submit(fetch_listings.homeharvest, zipcode, "for_sale")
        rent = pool.submit(fetch_listings.homeharvest, zipcode, "for_rent")
        return {"zip": zipcode, "fetched": dt.date.today().isoformat(), "source": "Realtor.com",
                "sale": sale.result(), "rent": rent.result()}


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
