# Copyright (c) 2026 Divya Chari
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""Estimate which way each listed house faces, from OpenStreetMap streets.

In simple words: a house usually faces the street closest to it. For every listing we find
the nearest street within 80 m and take the compass direction from the house to that street.
From the same street map we also flag corner lots (two different streets almost equally close)
and T-junctions (a street that ends right at the house and points straight at it), which
Feng Shui treats as a concern. This is an estimate; a satellite view confirms it.
"""
import math
import time

import requests

OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
            "https://overpass.private.coffee/api/interpreter"]
ROADS = "residential|unclassified|tertiary|secondary|primary|living_street|trunk|tertiary_link|secondary_link"
DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


POI = {   # what counts as "within a 10-minute walk" (800 m)
    "grocery": lambda t: t.get("shop") in ("supermarket", "grocery", "greengrocer"),
    "park": lambda t: t.get("leisure") == "park",
    "transit": lambda t: t.get("highway") == "bus_stop" or t.get("railway") in ("station", "tram_stop", "halt")
    or t.get("public_transport") == "station",
    "pharmacy": lambda t: t.get("amenity") == "pharmacy",
    "food": lambda t: t.get("amenity") in ("cafe", "restaurant"),
    "school": lambda t: t.get("amenity") == "school",
}


OVERPASS_TIMEOUT = 240     # seconds per try; the live listings function lowers this


def overpass(q):
    last = None
    tries = 6 if OVERPASS_TIMEOUT > 60 else 1
    for attempt in range(tries):                     # public servers are often busy: retry and rotate
        try:
            r = requests.post(OVERPASS[attempt % len(OVERPASS)], data={"data": q}, timeout=OVERPASS_TIMEOUT,
                              headers={"User-Agent": "homescope (github.com, house orientation)"})
            r.raise_for_status()
            return r.json().get("elements", [])
        except requests.RequestException as e:
            last = e
            if tries > 1:
                time.sleep(15)
    raise last


def fetch_area(points, pad=0.01):
    """Streets, everyday places, and noise sources (highways, railways, airports) around the points."""
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    bbox = f"{min(lats) - pad},{min(lons) - pad},{max(lats) + pad},{max(lons) + pad}"
    big = f"{min(lats) - 0.06},{min(lons) - 0.08},{max(lats) + 0.06},{max(lons) + 0.08}"
    q = (f'[out:json][timeout:180];way["highway"~"^({ROADS})$"]({bbox});out geom;'
         f'(nwr["shop"~"^(supermarket|grocery|greengrocer)$"]({bbox});nwr["leisure"="park"]({bbox});'
         f'node["highway"="bus_stop"]({bbox});nwr["railway"~"^(station|tram_stop|halt)$"]({bbox});'
         f'nwr["amenity"~"^(pharmacy|cafe|restaurant|school)$"]({bbox}););out center;'
         f'(way["highway"~"^(motorway|trunk)$"]({bbox});way["railway"="rail"]["service"!~"."]({bbox}););out geom;'
         f'nwr["aeroway"="aerodrome"]["iata"]({big});out center;')
    ways, places, noise, airports = [], {k: [] for k in POI}, {"highway": [], "rail": []}, []
    for el in overpass(q):
        t = el.get("tags", {})
        geom = [(g["lat"], g["lon"]) for g in el.get("geometry", [])]
        if t.get("aeroway") == "aerodrome":
            c = el.get("center") or {"lat": el.get("lat"), "lon": el.get("lon")}
            airports.append((c["lat"], c["lon"], t.get("name", "")))
        elif t.get("highway") in ("motorway", "trunk") and len(geom) >= 2:
            noise["highway"].append(geom)
        elif t.get("railway") == "rail" and len(geom) >= 2:
            noise["rail"].append(geom)
        elif "highway" in t and len(geom) >= 2 and t.get("highway") != "bus_stop":
            ways.append({"id": el["id"], "name": t.get("name", ""), "pts": geom})
        else:
            c = el.get("center") or ({"lat": el["lat"], "lon": el["lon"]} if "lat" in el else None)
            if c:
                for k, test in POI.items():
                    if test(t):
                        places[k].append((c["lat"], c["lon"]))
    return ways, places, noise, airports


def fetch_streets(points, pad=0.004):
    """Streets only (kept for compatibility)."""
    return fetch_area(points, pad)[0]


def _dist_m(a, b):
    dy = (a[0] - b[0]) * 110540
    dx = (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0]))
    return math.hypot(dx, dy)


def _line_dist(lat, lon, lines):
    p = _xy(lat, lon, lat)
    best = None
    for g in lines:
        pts = [_xy(a, b, lat) for a, b in g]
        for a, b in zip(pts, pts[1:]):
            d = _nearest_on_segment(p, a, b)[1]
            best = d if best is None or d < best else best
    return best


def surroundings(lat, lon, places, noise, airports, walk_m=800):
    """Everyday places within a 10-minute walk, and nearby noise sources."""
    near = {}
    for k, pts in places.items():
        ds = [_dist_m((lat, lon), q) for q in pts]
        within = [d for d in ds if d <= walk_m]
        near[k] = {"n": len(within), "m": round(min(ds)) if ds else None}
    nz = {}
    hw = _line_dist(lat, lon, noise["highway"])
    rl = _line_dist(lat, lon, noise["rail"])
    if hw is not None:
        nz["highway_m"] = round(hw)
    if rl is not None:
        nz["rail_m"] = round(rl)
    if airports:
        d, name = min((_dist_m((lat, lon), (a[0], a[1])), a[2]) for a in airports)
        nz["airport_km"], nz["airport"] = round(d / 1000, 1), name
    return near, nz


def _xy(lat, lon, lat0):
    """Local flat coordinates in metres (x east, y north) - fine over a few hundred metres."""
    return (lon * 111320 * math.cos(math.radians(lat0)), lat * 110540)


def _nearest_on_segment(p, a, b):
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    q = (ax + t * dx, ay + t * dy)
    return q, math.hypot(px - q[0], py - q[1])


def compass(dx, dy):
    """Compass name for a direction given in east/north metres."""
    ang = (math.degrees(math.atan2(dx, dy)) + 360) % 360
    return DIRS[int((ang + 22.5) // 45) % 8], round(ang)


def orient(lat, lon, ways, max_dist=80):
    """Facing direction, distance to street, corner-lot and T-junction flags for one house."""
    p = _xy(lat, lon, lat)
    best = []                                     # (distance, nearest point, way) per way
    for w in ways:
        pts = [_xy(a, b, lat) for a, b in w["pts"]]
        d_best = None
        for a, b in zip(pts, pts[1:]):
            q, d = _nearest_on_segment(p, a, b)
            if d_best is None or d < d_best[0]:
                d_best = (d, q)
        best.append((d_best[0], d_best[1], w, pts))
    best.sort(key=lambda t: t[0])
    if not best or best[0][0] > max_dist:
        return None
    d0, q0, w0, _ = best[0]
    facing, deg = compass(q0[0] - p[0], q0[1] - p[1])
    out = {"facing": facing, "facing_deg": deg, "street": w0["name"], "street_m": round(d0)}
    # corner lot: a differently named street almost as close
    for d, q, w, pts in best[1:]:
        ends_here = min(math.hypot(q[0] - e[0], q[1] - e[1]) for e in (pts[0], pts[-1])) < 15
        if w["name"] != w0["name"] and d <= d0 + 15 and d <= 40 and not ends_here:
            out["corner"] = True
            break
    # T-junction: another street ends within 60 m and its last stretch points at the house
    for d, q, w, pts in best:
        if w["name"] and w["name"] == w0["name"]:
            continue
        for end, prev in ((pts[-1], pts[-2]), (pts[0], pts[1])):
            de = math.hypot(p[0] - end[0], p[1] - end[1])
            if de > 60:
                continue
            vx, vy = end[0] - prev[0], end[1] - prev[1]
            hx, hy = p[0] - end[0], p[1] - end[1]
            n1, n2 = math.hypot(vx, vy), math.hypot(hx, hy)
            if n1 and n2 and (vx * hx + vy * hy) / (n1 * n2) > math.cos(math.radians(25)):
                out["tjunction"] = True
                break
        if out.get("tjunction"):
            break
    return out


def add_orientation(listings):
    """Add 'orient' (facing), 'near' (walkable places) and 'noise' to every listing with coordinates.
    One map request per zip."""
    pts = [(x["latitude"], x["longitude"]) for x in listings if x.get("latitude") and x.get("longitude")]
    if not pts:
        return
    ways, places, noise, airports = fetch_area(pts)
    for x in listings:
        if x.get("latitude") and x.get("longitude"):
            o = orient(x["latitude"], x["longitude"], ways)
            x["orient"] = o or {}
            x["near"], x["noise"] = surroundings(x["latitude"], x["longitude"], places, noise, airports)
