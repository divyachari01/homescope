// Copyright (c) 2026 Divya Chari
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Browser version of pipeline/orient.py, reading OpenStreetMap data from OpenFreeMap's vector
// tiles (fast and cached worldwide). From the streets it estimates which way each
// listed home faces (the direction to its nearest street), flag corner lots and T-junctions,
// count everyday places within a 10-minute walk, and find nearby highways, railways and airports.
const Orient = (() => {
  const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

  // ---- map data from OpenFreeMap vector tiles (OpenStreetMap data, OpenMapTiles schema)
  let tileUrl = null;
  async function tileTemplate() {
    if (!tileUrl) tileUrl = (await (await fetch("https://tiles.openfreemap.org/planet")).json()).tiles[0];
    return tileUrl;
  }
  // Minimal Mapbox Vector Tile reader: returns {layer: [{type, tags, rings}]} with rings in [lat, lon].
  function readTile(buf, z, x, y) {
    const b = new Uint8Array(buf); let pos = 0;
    const varint = () => { let r = 0, s = 0, c; do { c = b[pos++]; r += (c & 0x7f) * 2 ** s; s += 7; } while (c >= 0x80); return r; };
    const skip = w => { if (w === 0) varint(); else if (w === 1) pos += 8; else if (w === 2) pos += varint(); else if (w === 5) pos += 4; };
    const str = (s, e) => new TextDecoder().decode(b.subarray(s, e));
    const zz = n => (n % 2 ? -(n + 1) / 2 : n / 2);
    const out = {};
    while (pos < b.length) {
      const tag = varint();
      if (tag >> 3 !== 3 || (tag & 7) !== 2) { skip(tag & 7); continue; }
      const end = varint() + pos; let name = "", extent = 4096; const keys = [], vals = [], feats = [];
      while (pos < end) {
        const t = varint(), f = t >> 3, w = t & 7;
        if (f === 1 && w === 2) { const l = varint(); name = str(pos, pos + l); pos += l; }
        else if (f === 3 && w === 2) { const l = varint(); keys.push(str(pos, pos + l)); pos += l; }
        else if (f === 4 && w === 2) {
          const ve = varint() + pos; let v = null;
          while (pos < ve) {
            const vt = varint(), vf = vt >> 3;
            if (vf === 1) { const l = varint(); v = str(pos, pos + l); pos += l; }
            else if (vf === 2) { v = new DataView(b.buffer, b.byteOffset + pos, 4).getFloat32(0, true); pos += 4; }
            else if (vf === 3) { v = new DataView(b.buffer, b.byteOffset + pos, 8).getFloat64(0, true); pos += 8; }
            else if (vf === 4 || vf === 5) v = varint();
            else if (vf === 6) v = zz(varint());
            else if (vf === 7) v = !!varint();
            else skip(vt & 7);
          }
          vals.push(v);
        } else if (f === 2 && w === 2) {
          const fe = varint() + pos; let type = 0, tags = [], geom = [];
          while (pos < fe) {
            const ft = varint(), ff = ft >> 3;
            if (ff === 2 || ff === 4) { const pe = varint() + pos; const arr = []; while (pos < pe) arr.push(varint()); if (ff === 2) tags = arr; else geom = arr; }
            else if (ff === 3) type = varint();
            else skip(ft & 7);
          }
          feats.push({ type, tags, geom });
        } else if (f === 5) extent = varint();
        else skip(w);
      }
      const n = 2 ** z, toLatLon = (gx, gy) => {
        const lon = (x + gx / extent) / n * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + gy / extent) / n))) * 180 / Math.PI;
        return [lat, lon];
      };
      out[name] = feats.map(ft => {
        const props = {};
        for (let i = 0; i + 1 < ft.tags.length; i += 2) props[keys[ft.tags[i]]] = vals[ft.tags[i + 1]];
        const rings = []; let cx = 0, cy = 0, ring = null, i = 0;
        while (i < ft.geom.length) {
          const cmd = ft.geom[i] & 7, cnt = ft.geom[i] >> 3; i++;
          if (cmd === 7) { if (ring && ring.length) ring.push(ring[0]); continue; }
          for (let k = 0; k < cnt; k++) {
            cx += zz(ft.geom[i++]); cy += zz(ft.geom[i++]);
            if (cmd === 1) { ring = []; rings.push(ring); }
            ring.push(toLatLon(cx, cy));
          }
        }
        return { type: ft.type, props, rings };
      });
    }
    return out;
  }
  const tileOf = (lat, lon, z) => {
    const n = 2 ** z, r = lat * Math.PI / 180;
    return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)];
  };
  async function getTiles(points, z, ring) {
    const want = new Map();
    for (const [lat, lon] of points) {
      const [tx, ty] = tileOf(lat, lon, z);
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) want.set(`${tx + dx}/${ty + dy}`, [tx + dx, ty + dy]);
    }
    const tpl = await tileTemplate();
    const list = [...want.values()].slice(0, 80);
    return Promise.all(list.map(async ([tx, ty]) => {
      const r = await fetch(tpl.replace("{z}", z).replace("{x}", tx).replace("{y}", ty));
      return r.ok ? readTile(await r.arrayBuffer(), z, tx, ty) : {};
    }));
  }

  const ROAD = new Set(["primary", "secondary", "tertiary", "minor", "trunk"]);
  const centre = rings => { const r = rings[0] || []; let a = 0, b = 0; r.forEach(p => { a += p[0]; b += p[1]; }); return r.length ? [a / r.length, b / r.length] : null; };
  async function fetchArea(points) {
    const [near, wide] = await Promise.all([getTiles(points, 14, 1), getTiles(points, 10, 0)]);
    const ways = [], places = Object.fromEntries(["grocery", "park", "transit", "pharmacy", "food", "school"].map(k => [k, []]));
    const noise = { highway: [], rail: [] }, airports = [];
    for (const t of near) {
      for (const f of t.transportation_name || []) if (ROAD.has(f.props.class) && f.props.name) f.rings.forEach(r => r.length > 1 && ways.push({ name: f.props.name, pts: r }));
      for (const f of t.transportation || []) {
        if (f.props.class === "motorway" || f.props.class === "trunk") f.rings.forEach(r => r.length > 1 && noise.highway.push(r));
        if (f.props.class === "rail" && (!f.props.service) && f.props.subclass === "rail") f.rings.forEach(r => r.length > 1 && noise.rail.push(r));
      }
      for (const f of t.park || []) { const c = centre(f.rings); if (c) places.park.push(c); }
      for (const f of t.poi || []) {
        const c = f.rings[0]?.[0]; if (!c) continue;
        const cl = f.props.class, sub = f.props.subclass;
        if (cl === "grocery" || ["supermarket", "grocery", "greengrocer"].includes(sub)) places.grocery.push(c);
        else if (cl === "park") places.park.push(c);
        else if (cl === "bus" || ["station", "halt", "tram_stop", "bus_stop"].includes(sub)) places.transit.push(c);
        else if (cl === "pharmacy" || sub === "pharmacy") places.pharmacy.push(c);
        else if (["cafe", "restaurant", "fast_food"].includes(cl) || ["cafe", "restaurant"].includes(sub)) places.food.push(c);
        else if (cl === "school" || sub === "school") places.school.push(c);
      }
    }
    for (const t of wide) for (const f of t.aerodrome_label || []) if (f.props.iata) { const c = f.rings[0]?.[0]; if (c) airports.push([c[0], c[1], f.props.name || f.props["name:en"] || ""]); }
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
