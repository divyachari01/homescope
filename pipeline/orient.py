"""Estimate which way each listed house faces, from OpenStreetMap streets.

In simple words: a house usually faces the street closest to it. For every listing we find
the nearest street within 80 m and take the compass direction from the house to that street.
From the same street map we also flag corner lots (two different streets almost equally close)
and T-junctions (a street that ends right at the house and points straight at it), which
Feng Shui treats as a concern. This is an estimate; a satellite view confirms it.
"""
import math

import requests

OVERPASS = "https://overpass-api.de/api/interpreter"
ROADS = "residential|unclassified|tertiary|secondary|primary|living_street|trunk|tertiary_link|secondary_link"
DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def fetch_streets(points, pad=0.004):
    """All named/through streets in the box around the points, as lists of (lat, lon)."""
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    bbox = f"{min(lats) - pad},{min(lons) - pad},{max(lats) + pad},{max(lons) + pad}"
    q = f'[out:json][timeout:90];way["highway"~"^({ROADS})$"]({bbox});out geom;'
    r = requests.post(OVERPASS, data={"data": q}, timeout=180,
                      headers={"User-Agent": "homescope (github.com, house orientation)"})
    r.raise_for_status()
    ways = []
    for el in r.json().get("elements", []):
        geom = [(g["lat"], g["lon"]) for g in el.get("geometry", [])]
        if len(geom) >= 2:
            ways.append({"id": el["id"], "name": el.get("tags", {}).get("name", ""), "pts": geom})
    return ways


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
    """Add 'orient' to every listing with coordinates (one map request per zip)."""
    pts = [(x["latitude"], x["longitude"]) for x in listings if x.get("latitude") and x.get("longitude")]
    if not pts:
        return
    ways = fetch_streets(pts)
    for x in listings:
        if x.get("latitude") and x.get("longitude"):
            o = orient(x["latitude"], x["longitude"], ways)
            x["orient"] = o or {}
