// Copyright (c) 2026 Divya Chari
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Browser version of pipeline/orient.py: from OpenStreetMap streets, estimate which way each
// listed home faces (the direction to its nearest street), flag corner lots and T-junctions,
// count everyday places within a 10-minute walk, and find nearby highways, railways and airports.
const Orient = (() => {
  const SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
  const ROADS = "residential|unclassified|tertiary|secondary|primary|living_street|trunk|tertiary_link|secondary_link";
  const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const POI = {
    grocery: t => ["supermarket", "grocery", "greengrocer"].includes(t.shop),
    park: t => t.leisure === "park",
    transit: t => t.highway === "bus_stop" || ["station", "tram_stop", "halt"].includes(t.railway) || t.public_transport === "station",
    pharmacy: t => t.amenity === "pharmacy",
    food: t => ["cafe", "restaurant"].includes(t.amenity),
    school: t => t.amenity === "school",
  };

  async function overpass(q) {
    let last;
    for (const url of SERVERS) {
      try {
        const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q),
          headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        if (r.ok) return (await r.json()).elements || [];
        last = new Error(r.status);
      } catch (e) { last = e; }
    }
    throw last;
  }

  async function fetchArea(points, pad = 0.01) {
    const lats = points.map(p => p[0]), lons = points.map(p => p[1]);
    const box = `${Math.min(...lats) - pad},${Math.min(...lons) - pad},${Math.max(...lats) + pad},${Math.max(...lons) + pad}`;
    const big = `${Math.min(...lats) - 0.06},${Math.min(...lons) - 0.08},${Math.max(...lats) + 0.06},${Math.max(...lons) + 0.08}`;
    const q = `[out:json][timeout:60];way["highway"~"^(${ROADS})$"](${box});out geom;` +
      `(nwr["shop"~"^(supermarket|grocery|greengrocer)$"](${box});nwr["leisure"="park"](${box});` +
      `node["highway"="bus_stop"](${box});nwr["railway"~"^(station|tram_stop|halt)$"](${box});` +
      `nwr["amenity"~"^(pharmacy|cafe|restaurant|school)$"](${box}););out center;` +
      `(way["highway"~"^(motorway|trunk)$"](${box});way["railway"="rail"]["service"!~"."](${box}););out geom;` +
      `nwr["aeroway"="aerodrome"]["iata"](${big});out center;`;
    const ways = [], places = Object.fromEntries(Object.keys(POI).map(k => [k, []])), noise = { highway: [], rail: [] }, airports = [];
    for (const el of await overpass(q)) {
      const t = el.tags || {}, geom = (el.geometry || []).map(g => [g.lat, g.lon]);
      if (t.aeroway === "aerodrome") { const c = el.center || el; airports.push([c.lat, c.lon, t.name || ""]); }
      else if (["motorway", "trunk"].includes(t.highway) && geom.length > 1) noise.highway.push(geom);
      else if (t.railway === "rail" && geom.length > 1) noise.rail.push(geom);
      else if (t.highway && t.highway !== "bus_stop" && geom.length > 1) ways.push({ name: t.name || "", pts: geom });
      else {
        const c = el.center || (el.lat != null ? el : null);
        if (c) for (const [k, test] of Object.entries(POI)) if (test(t)) places[k].push([c.lat, c.lon]);
      }
    }
    return { ways, places, noise, airports };
  }

  const xy = (lat, lon, lat0) => [lon * 111320 * Math.cos(lat0 * Math.PI / 180), lat * 110540];
  function nearestOnSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    const q = [a[0] + t * dx, a[1] + t * dy];
    return [q, Math.hypot(p[0] - q[0], p[1] - q[1])];
  }
  const compass = (dx, dy) => { const ang = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360; return [DIRS[Math.floor((ang + 22.5) / 45) % 8], Math.round(ang)]; };

  function orient(lat, lon, ways, maxDist = 80) {
    const p = xy(lat, lon, lat), best = [];
    for (const w of ways) {
      const pts = w.pts.map(([a, b]) => xy(a, b, lat));
      let bd = null;
      for (let i = 0; i + 1 < pts.length; i++) { const [q, d] = nearestOnSeg(p, pts[i], pts[i + 1]); if (!bd || d < bd[0]) bd = [d, q]; }
      best.push([bd[0], bd[1], w, pts]);
    }
    best.sort((a, b) => a[0] - b[0]);
    if (!best.length || best[0][0] > maxDist) return null;
    const [d0, q0, w0] = best[0];
    const [facing, deg] = compass(q0[0] - p[0], q0[1] - p[1]);
    const out = { facing, facing_deg: deg, street: w0.name, street_m: Math.round(d0) };
    for (const [d, q, w, pts] of best.slice(1)) {
      const endsHere = Math.min(...[pts[0], pts[pts.length - 1]].map(e => Math.hypot(q[0] - e[0], q[1] - e[1]))) < 15;
      if (w.name !== w0.name && d <= d0 + 15 && d <= 40 && !endsHere) { out.corner = true; break; }
    }
    outer: for (const [, , w, pts] of best) {
      if (w.name && w.name === w0.name) continue;
      for (const [end, prev] of [[pts[pts.length - 1], pts[pts.length - 2]], [pts[0], pts[1]]]) {
        if (Math.hypot(p[0] - end[0], p[1] - end[1]) > 60) continue;
        const v = [end[0] - prev[0], end[1] - prev[1]], h = [p[0] - end[0], p[1] - end[1]];
        const n1 = Math.hypot(...v), n2 = Math.hypot(...h);
        if (n1 && n2 && (v[0] * h[0] + v[1] * h[1]) / (n1 * n2) > Math.cos(25 * Math.PI / 180)) { out.tjunction = true; break outer; }
      }
    }
    return out;
  }

  const distM = (a, b) => Math.hypot((a[1] - b[1]) * 111320 * Math.cos(a[0] * Math.PI / 180), (a[0] - b[0]) * 110540);
  function lineDist(lat, lon, lines) {
    const p = xy(lat, lon, lat); let best = null;
    for (const g of lines) { const pts = g.map(([a, b]) => xy(a, b, lat)); for (let i = 0; i + 1 < pts.length; i++) { const d = nearestOnSeg(p, pts[i], pts[i + 1])[1]; if (best == null || d < best) best = d; } }
    return best;
  }
  function surroundings(lat, lon, area, walk = 800) {
    const near = {};
    for (const [k, pts] of Object.entries(area.places)) {
      const ds = pts.map(q => distM([lat, lon], q));
      near[k] = { n: ds.filter(d => d <= walk).length, m: ds.length ? Math.round(Math.min(...ds)) : null };
    }
    const nz = {}, hw = lineDist(lat, lon, area.noise.highway), rl = lineDist(lat, lon, area.noise.rail);
    if (hw != null) nz.highway_m = Math.round(hw);
    if (rl != null) nz.rail_m = Math.round(rl);
    if (area.airports.length) {
      const [d, name] = area.airports.map(a => [distM([lat, lon], a), a[2]]).sort((x, y) => x[0] - y[0])[0];
      nz.airport_km = Math.round(d / 100) / 10; nz.airport = name;
    }
    return [near, nz];
  }

  // Fill in orient / near / noise on listings that don't have them yet.
  async function addTo(listings) {
    const todo = listings.filter(x => x.latitude && !x.orient);
    if (!todo.length) return false;
    const area = await fetchArea(todo.map(x => [x.latitude, x.longitude]));
    for (const x of todo) {
      x.orient = orient(x.latitude, x.longitude, area.ways) || {};
      [x.near, x.noise] = surroundings(x.latitude, x.longitude, area);
    }
    return true;
  }
  return { addTo };
})();
