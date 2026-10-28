# Copyright (c) 2026 Divya Chari
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""Plain HTML pages that search engines can read: one per zip, one per state, and a sitemap.

The main page builds itself with JavaScript, which search engines often skip. These small
pages carry each zip's key numbers as ordinary text and link to the full interactive report.
"""
import datetime as dt
import html
import json
from pathlib import Path

SITE = "https://divyachari01.github.io/homescope/"


def money(x):
    if not isinstance(x, (int, float)):
        return "n/a"
    return f"${round(x, -3):,.0f}" if x >= 10000 else f"${x:,.0f}"


def page(title, desc, canonical, body):
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title><meta name="description" content="{html.escape(desc)}">
<link rel="canonical" href="{canonical}"><meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{html.escape(desc)}"><meta property="og:url" content="{canonical}">
<meta property="og:type" content="website"><link rel="stylesheet" href="../../style.css">
</head><body><div class="wrap" style="padding:20px 16px">{body}
<p class="foot">HomeScope is a free, independent tool. Not financial or real estate advice. Data: Zillow Research, FHFA, US Census Bureau, FEMA, Stanford Education Data Archive and others.</p>
</div></body></html>"""


def zip_page(z, r, built):
    place = ", ".join(x for x in (r.get("city"), r.get("state")) if x)
    now = r.get("zhvi_now", {}).get("all") or r.get("acs", {}).get("home_value")
    fc = (r.get("fc") or {}).get("5")
    rent = r.get("zori_now") or r.get("acs", {}).get("rent")
    inc = r.get("acs", {}).get("income")
    school = (r.get("schools") or {}).get("district")
    hz = r.get("hazard") or {}
    mk = r.get("market") or {}
    title = f"{z} {place} home prices, forecast, schools and risks | HomeScope"
    bits = [f"typical home {money(now)}" if now else None,
            f"5-year forecast {fc[1]:+.0f}%" if fc else None,
            f"school district {school.get('n10', '?')}/10 nationally" if school else None,
            f"{hz['label'].lower()} natural hazard risk" if hz.get("label") else None]
    desc = f"Buying a home in {z} ({place})? " + ", ".join(b for b in bits if b) + \
        ". Prices since 1975, rates, affordability, listings, schools, crime, flood risk and more."
    rows = [("Typical home value", money(now)),
            ("5-year price forecast (low / likely / high)", f"{fc[0]:+.0f}% / {fc[1]:+.0f}% / {fc[2]:+.0f}%" if fc else "n/a"),
            ("Typical rent", f"{money(rent)}/mo" if rent else "n/a"),
            ("Median household income", money(inc)),
            ("Market", mk.get("label") or "n/a"),
            ("School district", f"{school['name']} ({school.get('n10', '?')}/10 nationally, {school.get('s10', '?')}/10 in state)" if school else "n/a"),
            ("Natural hazard risk (FEMA)", hz.get("label") or "n/a")]
    table = "".join(f"<tr><td>{html.escape(a)}</td><td>{html.escape(str(b))}</td></tr>" for a, b in rows)
    body = (f"<h1>{z} &middot; {html.escape(place)}</h1><p>Home buying report, data as of {built}.</p>"
            f"<table>{table}</table><p><a href=\"../../?zip={z}\"><b>Open the full {z} report</b></a>: "
            "listings you can afford, monthly cost, best time to buy, Vaastu and Feng Shui, commute, schools and more.</p>"
            f"<p><a href=\"../{html.escape(r.get('state') or 'US')}/\">More zip codes in {html.escape(r.get('state') or 'the US')}</a></p>")
    return page(title, desc, f"{SITE}zip/{z}/", body)


def build(out_site, shards, built):
    """Write site/zip/<zip>/index.html, site/zip/<ST>/index.html and site/sitemap.xml."""
    out = Path(out_site) / "zip"
    by_state = {}
    urls = [SITE]
    for recs in shards.values():
        for z, r in recs.items():
            if not (r.get("zhvi_now") or r.get("acs")):
                continue
            d = out / z
            d.mkdir(parents=True, exist_ok=True)
            (d / "index.html").write_text(zip_page(z, r, built))
            by_state.setdefault(r.get("state") or "US", []).append((z, r.get("city") or ""))
            urls.append(f"{SITE}zip/{z}/")
    for st, zs in by_state.items():
        d = out / st
        d.mkdir(parents=True, exist_ok=True)
        items = "".join(f'<li><a href="../{z}/">{z} {html.escape(c)}</a></li>' for z, c in sorted(zs))
        (d / "index.html").write_text(page(f"{st} zip codes: home prices, forecasts and schools | HomeScope",
                                           f"Home buying reports for {len(zs)} zip codes in {st}.",
                                           f"{SITE}zip/{st}/", f"<h1>Zip codes in {st}</h1><ul>{items}</ul>"))
        urls.append(f"{SITE}zip/{st}/")
    lastmod = built
    xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    xml += [f"<url><loc>{u}</loc><lastmod>{lastmod}</lastmod></url>" for u in urls]
    xml.append("</urlset>")
    (Path(out_site) / "sitemap.xml").write_text("\n".join(xml))
    states = "".join(f'<a href="zip/{st}/">{st}</a> ' for st in sorted(by_state))
    return len(urls), states
