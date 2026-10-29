// Copyright (c) 2026 Divya Chari
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// HomeScope page logic. Data files come from pipeline/build_data.py.
(() => {
  const $ = s => document.querySelector(s);
  const DEFAULTS = {
    income: 100000, debts: 0, cash: "", save: 0, rent0: 1500, downPct: 20, downAmt: "", maxMonthly: "", years: 30, rate: "",
    housingShare: 28, dtiCap: 36, taxRate: "", insRate: "", pmiRate: 0.5, maintRate: 1, closingPct: "",
    sellPct: 6, hoa: "", incomeGrowth: 3, invReturn: 5, rateShift: 0, H: 10, invPremium: 0.75, invDown: 25,
    vacancy: 5, mgmt: 8, hackRent: "", strNightly: 150, strOcc: 55, strFees: 25,
  };
  const TYPES = [
    ["all", "Typical home (all types)"], ["sfr", "House (single-family)"], ["condo", "Condo / apartment"],
    ["bottom", "Starter home (cheaper third)"], ["top", "Upper-end home (priciest third)"], ["custom", "My own price"],
  ];
  const LISTING_GROUPS = {
    "Single Family": "House", "Condo": "Condo / apartment", "Townhouse": "Townhouse",
    "Multi-Family": "Multi-unit", "Apartment": "Apartment building (5+)", "Manufactured": "Manufactured",
    "Land": "Land",
  };

  let NAT = null, STATES = {}, LISTED = [];
  let rec = null, zip = "", target = { type: "all", custom: null }, listing = null;
  const charts = {};

  // ---------------------------------------------------------------- formatting
  const money = (x, digits = 0) => !Number.isFinite(x) ? "n/a" :
    (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const k = x => !Number.isFinite(x) ? "n/a" : Math.abs(x) >= 1e6 ? money(x / 1e6, 2) + "M" : money(Math.round(x / 1000) * 1000);
  const pct = (x, d = 1) => !Number.isFinite(x) ? "n/a" : x.toFixed(d) + "%";
  const signed = (x, d = 1) => !Number.isFinite(x) ? "n/a" : (x > 0 ? "+" : "") + x.toFixed(d) + "%";
  const ord = n => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------------------------------------------------------------- inputs (saved in this browser only)
  function loadInputs() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem("hc-inputs") || "{}"); } catch (e) { /* storage unavailable */ }
    // Older versions saved fixed defaults for these; blank them so each zip's own values are used.
    if (saved.insRate === "0.5") delete saved.insRate;
    if (saved.closingPct === "3") delete saved.closingPct;
    delete saved.debts; delete saved.save;             // no longer asked for
    // Cash saved used to cap the budget; it's optional now (blank = budget from income and down payment %).
    try { if (!localStorage.getItem("hc-cash-optional")) { delete saved.cash; localStorage.setItem("hc-cash-optional", "1"); } } catch (e) { /* ignore */ }
    document.querySelectorAll("[data-k]").forEach(el => {
      const key = el.dataset.k;
      el.value = saved[key] ?? DEFAULTS[key];
    });
    try { $("#purpose").value = localStorage.getItem("hc-purpose") || "live"; } catch (e) { /* ignore */ }
  }
  function saveInputs() {
    const o = {};
    document.querySelectorAll("[data-k]").forEach(el => { o[el.dataset.k] = el.value; });
    try { localStorage.setItem("hc-inputs", JSON.stringify(o)); localStorage.setItem("hc-purpose", $("#purpose").value); } catch (e) { /* ignore */ }
  }
  function inputs() {
    const o = {};
    document.querySelectorAll("[data-k]").forEach(el => {
      const v = el.value.trim();
      o[el.dataset.k] = v === "" ? null : Number(v);
    });
    for (const [key, def] of Object.entries(DEFAULTS)) if (o[key] == null || Number.isNaN(o[key])) o[key] = def === "" ? null : def;
    o.ratePct = o.rate ?? currentRate(o.years);
    // California resets the tax to about 1.1% of the price when a home sells (Prop 13), so long-time
    // owners' low bills (what the Census rate reflects) don't apply to a buyer.
    o.taxRate = o.taxRate ?? Math.max(rec?.acs?.tax_rate || 1.1, rec?.state === "CA" ? 1.1 : 0);
    // Home insurance and closing costs follow the zip's state unless set by hand.
    const st = STATES[rec?.state] || {};
    o.insAuto = o.insRate === null;
    o.insRate = o.insRate ?? (st.home_ins ? st.home_ins / 400000 * 100 : 0.5);
    o.closingAuto = o.closingPct === null;
    o.closingFees = st.closing_fees ?? 1;
    // Closing = title, recording and transfer taxes (state average) + about 1% lender fees
    // + first year of home insurance + 3 months of property tax paid into escrow.
    o.closingPct = o.closingPct ?? (o.closingFees + 1 + o.insRate + o.taxRate / 4);
    o.hoaAuto = o.hoa === null;
    o.hoa = o.hoa ?? autoHoa();
    o.cashKnown = o.cash != null;
    if (!o.cashKnown) o.cash = Infinity;                // not limited by savings unless you enter them
    o.cash0 = o.cash;
    o.rentGrowth = rentGrowth();
    return o;
  }
  // Yearly rent growth over the last 5 full years of Zillow's rent index (3% if unknown), kept within 0-8%.
  function rentGrowth() {
    const z = rec?.zori;
    if (!z) return 3;
    const y1 = builtYear() - 1, y0 = y1 - 5, a = z.v[y0 - z.start], b = z.v[y1 - z.start];
    if (!(a > 0 && b > 0)) return 3;
    return Math.min(8, Math.max(0, (Math.pow(b / a, 1 / 5) - 1) * 100));
  }
  // Typical condo HOA in this zip from current listings (only used for condos when HOA is left blank).
  function autoHoa() {
    if (target.type !== "condo" || !listing) return 0;
    const fees = (listing.sale || []).filter(s => s.propertyType === "Condo" && s.hoa).map(s => s.hoa);
    return fees.length >= 3 ? Math.round(Calc.percentile(fees, 50)) : 0;
  }
  const crimeName = () => /homicide/i.test(NAT?.asof?.crime || "") ? "Homicides" : "Violent crime";
  const utilities = () => rec?.util ? (rec.util.electric || 0) + (rec.util.gas || 0) : 0;

  function currentRate(years) {
    if (!NAT) return 6.5;
    if (Number(years) === 15 && NAT.rate15_latest) return NAT.rate15_latest.value;
    return NAT.rate30_latest.value;
  }

  // ---------------------------------------------------------------- data access
  // Live listings for any zip from the serverless function (see api/listings.py); set in config.js.
  const API = (window.HOMESCOPE_API || "").replace(/\/$/, "");
  const liveCache = new Map(), liveState = new Map();   // zip -> data; zip -> "loading" | "failed"
  async function loadLive(z) {
    if (liveState.get(z) === "loading") return;
    liveState.set(z, "loading");
    try {
      const r = await fetch(`${API}/api/listings?zip=${z}&v=2`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      liveCache.set(z, j); liveState.delete(z);
      j.mapState = "loading";
      if (z === zip) { listing = j; renderAll(); }
      homesChanged(z);
      // then add facing, walkable places and noise from the street map, right here in the browser
      try { await Orient.addTo(j.sale); j.mapState = "done"; } catch (e) { j.mapState = "failed"; }
      if (z === zip) renderListings(inputs());
      homesChanged(z);
    } catch (e) {
      liveState.set(z, "failed");
      if (z === zip) renderListings(inputs());
      homesChanged(z);
    }
  }

  // Zip data comes in files of ~40 zips (by first 3 digits); keep each file once it's loaded.
  const shards = new Map();
  function getShard(prefix) {
    if (!shards.has(prefix)) shards.set(prefix, getJSON(`data/zips/${prefix}.json`).catch(e => { shards.delete(prefix); throw e; }));
    return shards.get(prefix);
  }
  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }
  async function init() {
    if (history.state?.deal) history.replaceState(null, "");    // a reload while a sheet was open
    loadInputs();
    try {
      [NAT, STATES] = await Promise.all([getJSON("data/national.json"), getJSON("data/states.json")]);
      LISTED = await getJSON("data/listings/index.json").catch(() => []);
    } catch (e) {
      $("#status").textContent = "Data files are missing. Run the build (see README) and reload.";
      return;
    }
    $("#rateHint").textContent = `(blank = ${NAT.rate30_latest.value}% from ${NAT.rate30_latest.date})`;
    renderSources();
    const P = new URLSearchParams(location.search), q = P.get("zip") || P.get("city");
    updateBudget();
    if (P.get("zip") && P.get("view") === "area") { $("#zip").value = P.get("zip"); openReport(P.get("zip")); return; }
    if (q) { $("#zip").value = q; lookup(); return; }
    // a plain visit opens on the welcome header; offer the last search instead of jumping into it
    let last = null;
    try { last = localStorage.getItem("hc-search"); } catch (e) { /* ignore */ }
    if (last) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "ex"; b.textContent = last;
      b.onclick = () => { $("#zip").value = last; lookup(); };
      $(".examples").prepend(document.createTextNode(" "));
      $(".examples").prepend(b);
      $(".examples").prepend(document.createTextNode("Pick up where you left off: "));
    }
  }

  // One search box: a zip, a city or county, or a house (street address or listing link).
  async function lookup() {
    const q = $("#zip").value.trim();
    if (/^\d{5}$/.test(q)) return zipSearch(q);
    if (/^https?:\/\//i.test(q) || /^\d+[a-z]?\s+\S+/i.test(q)) return houseSearch(q);
    if (q.length >= 2) return citySearch(q);
    $("#status").textContent = "Type a city, zip code, address or listing link.";
  }
  // The full area report for one zip.
  async function openReport(z) {
    zip = z;
    document.body.classList.add("searched");
    $("#status").textContent = "Loading...";
    try {
      const shard = await getShard(zip.slice(0, 3));
      rec = shard[zip];
    } catch (e) { rec = null; }
    if (!rec) { $("#results").hidden = true; $("#status").textContent = `No data for ${zip}. It may be a PO box or business-only zip.`; return; }
    $("#v-homes").hidden = true;
    // Live listings when available (they include recent sales); the daily copy shows meanwhile.
    listing = liveCache.get(zip) || (LISTED.includes(zip) ? await getJSON(`data/listings/${zip}.json`).catch(() => null) : null);
    if (!liveCache.has(zip) && API) loadLive(zip);
    try { localStorage.setItem("hc-zip", zip); } catch (e) { /* ignore */ }
    history.replaceState(null, "", `?zip=${zip}&view=area`);
    target = { type: rec.zhvi_now?.all ? "all" : "custom", custom: rec.zhvi_now?.all ? null : rec.acs?.home_value || 300000 };
    $("#status").textContent = "";
    $("#results").hidden = false;
    renderAll();
    window.scrollTo(0, 0);
  }

  // Yearly dollar price history. FHFA's index goes back to 1975 but has no dollar level, so it is
  // scaled to match Zillow's value in the latest year both have, then Zillow continues after that.
  function priceHistory(r = rec) {
    const toMap = s => { const m = new Map(); if (s) s.v.forEach((v, i) => { if (v != null) m.set(s.start + i, v); }); return m; };
    const z = toMap(r.zhvi && (r.zhvi.sfr || r.zhvi.all)), h = toMap(r.hpi);
    const out = new Map();
    const overlap = [...h.keys()].filter(y => z.has(y));
    if (overlap.length) {
      const ay = Math.max(...overlap), scale = z.get(ay) / h.get(ay);
      for (const [y, v] of h) out.set(y, v * scale);
      for (const [y, v] of z) if (y > ay) out.set(y, v);
    } else for (const [y, v] of z) out.set(y, v);
    if (!out.size) return null;
    const ys = [...out.keys()].sort((a, b) => a - b), years = [], vals = [];
    for (let y = ys[0]; y <= ys[ys.length - 1]; y++) { years.push(y); vals.push(out.get(y) ?? null); }
    return { years, vals, fromFhfa: overlap.length > 0 };
  }
  const builtYear = () => Number((NAT.built || "").slice(0, 4)) || new Date().getFullYear();
  function completeYears(hist) {   // drop the current, partial year for growth statistics
    const i = hist.years.indexOf(builtYear());
    return i >= 0 ? hist.vals.slice(0, i) : hist.vals;
  }
  function targetPrice(o) {
    if (target.type === "custom") return target.custom || 0;
    return rec.zhvi_now?.[target.type] || rec.zhvi_now?.all || rec.acs?.home_value || 0;
  }
  // Typical rent for the selected kind of home. Zillow's rent index and the Census mix apartments
  // with houses, so when enough rentals of the same kind are listed now, their median is used.
  function listedRent() {
    if (!listing || listing.zip !== zip) return null;
    const condo = target.type === "condo";
    const r = (listing.rent || []).filter(x => x.price > 200 && (condo ? ["Condo", "Apartment"].includes(x.propertyType) : x.propertyType === "Single Family")).map(x => x.price);
    if (r.length < 8) return null;
    const p = target.type === "bottom" ? 30 : target.type === "top" ? 70 : 50;
    return { v: Calc.percentile(r, p), n: r.length, kind: condo ? "condos and apartments" : "houses" };
  }
  const typicalRent = () => listedRent()?.v || rec.zori_now || rec.acs?.rent || null;
  function rentSource() {
    const l = listedRent();
    if (l) return `median of ${l.n} ${l.kind} for rent now${rec.zori_now ? `; Zillow's all-rentals index: ${money(rec.zori_now)}` : ""}`;
    return rec.zori_now ? "Zillow rent index (all rentals, incl. apartments)" : "Census median rent (all rentals)";
  }
  function cpiFactor(year) {
    const c = NAT.cpi, last = c.v[c.v.length - 1], v = c.v[year - c.start];
    return v ? last / v : null;
  }

  function makeChart(id, config) {
    if (charts[id]) charts[id].destroy();
    const el = document.getElementById(id);
    if (!el) return;
    Chart.defaults.color = css("--muted");
    Chart.defaults.borderColor = css("--line");
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    config.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false }, plugins: { legend: { labels: { boxWidth: 12 } } } }, config.options || {});
    charts[id] = new Chart(el, config);
  }

  // ---------------------------------------------------------------- render
  function renderAll() {
    const o = inputs();
    renderHead(o);
    renderSummary(o);
    renderMarket();
    renderPrices();
    renderBuying(o);
    renderTiming(o);
    renderPurpose(o);
    renderHood();
    renderHazards(o);
    renderGrowth();
    renderLaw();
    renderSun();
    renderSchools();
  }

  function renderHead(o) {
    const place = [rec.city, rec.county, rec.state].filter(Boolean).join(", ");
    const mp = Calc.maxPrice(o), tp = targetPrice(o), bits = [];
    if (tp) bits.push(mp.price >= tp ? `You can afford the ${typeName()} here.` : `The ${typeName()} here is ${k(tp - mp.price)} over your budget.`);
    if (rec.market?.label) bits.push(`${rec.market.label.replace(/^Balanced$/, "Balanced market")}${rec.market.dom ? `, homes take about ${Math.round(rec.market.dom)} days to sell` : ""}.`);
    const risks = (rec.hazard?.top || []).filter(([, , lab]) => /very high|relatively high/i.test(lab || "")).slice(0, 2).map(([n]) => n.toLowerCase());
    if (risks.length) bits.push(`Main natural risks: ${risks.join(" and ")}.`);
    const gr = rec.growth;
    if (gr?.rate != null && (gr.pct >= 80 || gr.rate < -0.3)) bits.push(gr.rate < 0 ? `Population is shrinking (${signed(gr.rate)}/yr).` : `Population is growing fast (${signed(gr.rate)}/yr).`);
    $("#s-head").innerHTML = `<h2>${zip}${place ? " &middot; " + esc(place) : ""}</h2>
      <div class="asof">${rec.metro ? esc(rec.metro) + " metro &middot; " : ""}Each section notes how recent its data is.</div>
      ${bits.length ? `<p class="bottom">${bits.join(" ")}</p>` : ""}`;
  }
  const typeName = () => (TYPES.find(t => t[0] === target.type) || TYPES[0])[1].replace(/ \(.*\)/, "").toLowerCase().replace("my own price", "home at your price");
  const hint = (id, text) => { const el = document.getElementById(id); if (el) el.innerHTML = text ? "&middot; " + text : ""; };

  function card(label, value, sub, pill) {
    return `<div class="card"><div class="k">${label}</div><div class="v">${value}</div>
      <div class="s">${sub || ""}</div>${pill ? `<div style="margin-top:6px">${pill}</div>` : ""}</div>`;
  }
  const pctSub = (p, text) => Number.isFinite(p) ? `${text} ${Math.round(p)}% of US zips` : "";
  // School and district names come in capitals ("SEGUIN ISD"); show them in normal case, keeping short codes.
  const nice = t => !t || t !== t.toUpperCase() ? (t || "") : t.toLowerCase().replace(/\b([a-z])([a-z']*)/g, (w, a, b) => a.toUpperCase() + b)
    .replace(/\b(Isd|Cisd|Usd|Csd|Sd|Esd|Hs|Ms|Es|Ii|Iii|Iv)\b/g, w => w.toUpperCase()).replace(/\bOf\b/g, "of").replace(/\bAnd\b/g, "and");

  function renderSummary(o) {
    const out = [], more = [];
    const now = rec.zhvi_now?.all, rr = rec.zhvi_recent?.v || [];
    const yoy = rr.length > 12 && rr[rr.length - 13] ? (rr[rr.length - 1] / rr[rr.length - 13] - 1) * 100 : NaN;
    if (now) out.push(card("Typical home value", k(now), `${signed(yoy)} over the last year`));
    else if (rec.acs?.home_value) out.push(card("Median home value", k(rec.acs.home_value), "Census estimate (Zillow has no value here)"));
    const mp = Calc.maxPrice(o);
    const tp = targetPrice(o);
    const where = rec.state || "this state";
    out.push(card("You can afford up to", k(mp.price), `about ${money(Calc.monthly(mp.price, o).total)}/mo at ${o.ratePct}% with ${o.downAmt != null ? `${k(o.downAmt)} down` : `${o.downPct}% down`}${o.cashKnown ? `: income allows ${k(mp.byPayment)}, your savings allow ${k(mp.byCash)}` : `, from your income`}
      <details class="sub"><summary>What's included</summary>Cash covers ${o.downAmt != null ? `${k(o.downAmt)} down` : `${o.downPct}% down`} + ${pct(o.closingPct)} closing${o.closingAuto ? ` (${where} title, recording and transfer fees ${pct(o.closingFees, 2)}, lender about 1%, first-year insurance and tax escrow)` : ""}.
      Monthly includes ${pct(o.taxRate, 2)} property tax${o.insAuto ? ` and ${where} average home insurance (${pct(o.insRate, 2)} of price)` : ""}${o.hoa ? ` and ${money(o.hoa)} HOA` : ""}.</details>`,
      tp ? (mp.price >= tp ? `<span class="pill">Covers the ${TYPES.find(t => t[0] === target.type)[1].toLowerCase()}</span>`
                          : `<span class="pill warn">${k(tp - mp.price)} short of the selected home</span>`) : ""));
    const ind = rec.ind || {}, p = rec.pct || {};
    if (rec.market?.label) out.push(card("Market", rec.market.label.replace(" market", ""), [rec.market.dom ? `${Math.round(rec.market.dom)} days to sell` : "",
      rec.market.price_drops != null ? `${pct(rec.market.price_drops * 100, 0)} of listings cut their price` : ""].filter(Boolean).join(" &middot; ")));
    const fc1 = rec.fc?.["1"];
    if (fc1) out.push(card("Price outlook, next year", signed(fc1[1]), `likely; range ${signed(fc1[0])} to ${signed(fc1[2])} (model forecast)`));
    if (rec.hazard?.label) out.push(card("Natural hazard risk", rec.hazard.label, (rec.hazard.top || []).slice(0, 2).map(([n]) => esc(n)).join(", ")));
    const sd = rec.schools?.district;
    if (sd) out.push(card("School district", sd.n10 ? `${sd.n10}/10` : `Grade ${sd.grade}`, `${esc(nice(sd.name))}${sd.s10 ? `: test scores ${sd.n10}/10 US, ${sd.s10}/10 ${esc(rec.state)}` : ""}${sd.g10 ? `; progress ${sd.g10}/10 US, ${sd.gs10}/10 ${esc(rec.state)}` : ""}`));
    const gr = rec.growth;
    if (gr?.rate != null) out.push(card("Population growth", `${signed(gr.rate)}/yr`, `${gr.pct != null ? `faster than ${gr.pct}% of US zips` : ""}${gr.pk != null ? ` &middot; county permits ${gr.pk} new homes per 1,000 people a year` : ""}`));
    const rent = typicalRent(), rs = rentSource();
    if (rent) out.push(card("Typical rent", money(rent) + "/mo", rs));
    if (ind.price_to_income) more.push(card("Price to income", ind.price_to_income.toFixed(1) + "x",
      pctSub(p.price_to_income, "Homes cost more relative to income than") || "home value / median income"));
    if (rec.acs?.income) more.push(card("Median household income", money(rec.acs.income),
      Number.isFinite(ind.income_change) ? `${signed(ind.income_change)} in 10 yrs after inflation` : ""));
    if (rec.acs?.renter_share != null) more.push(card("Renters", pct(rec.acs.renter_share, 0) + " of homes",
      `${pct(rec.acs.rent_vacancy)} of rentals sit empty`));
    if (ind.crime != null) more.push(card(`${crimeName()} (county)`, Math.round(ind.crime) + " per 100k", pctSub(p.crime, "Higher than")));
    const car = STATES[rec.state]?.car_insurance, carQ = STATES[rec.state]?.car_quote;
    if (carQ || car) more.push(card("Car insurance (state)", carQ ? `${money(carQ)}/mo` : `${money(car)}/yr`,
      carQ ? `Typical full-coverage quote, Sep 2026 (Insurify).${car ? ` Average actually paid in 2024: ${money(car / 12)}/mo (NAIC)` : ""}` : "Average paid per car, 2024 (NAIC)"));
    const v = rec.votes, sv = STATES[rec.state]?.votes;
    if (v || sv) {
      const src = v || sv, i = src.years.length - 1, m = src.rep[i] - src.dem[i];
      more.push(card(`${src.years[i]} president (${v ? "county" : "state"})`, `${m > 0 ? "R" : "D"} +${Math.abs(m).toFixed(0)}`,
        `R ${src.rep[i]}% &middot; D ${src.dem[i]}%` + (v && sv ? ` &middot; state ${sv.rep[sv.rep.length - 1] > sv.dem[sv.dem.length - 1] ? "R" : "D"} +${Math.abs(sv.rep[sv.rep.length - 1] - sv.dem[sv.dem.length - 1]).toFixed(0)}` : "")));
    }
    if (work && rec.lat != null) {
      const t = driveText(rec.lat, rec.lon);
      out.push(card("Drive to work", t ? t.replace(" drive to work", "") : "...", "from the centre of this zip, without traffic"));
      if (!t) fetchDrives([[rec.lat, rec.lon]]).then(ch => { if (ch && rec) renderSummary(inputs()); });
    }
    if (rec.jobs) more.push(card("Jobs in the county", rec.jobs.jobs_change != null ? signed(rec.jobs.jobs_change) : "n/a",
      `over 5 years &middot; average pay ${money(rec.jobs.avg_pay)}`));
    const lean = lawLean(STATES[rec.state]?.law);
    if (lean) more.push(card("Landlord-tenant law", lean.label, esc(STATES[rec.state].name)));
    if (rec.gent) more.push(card("Neighborhood change", rec.gent.replace("Signs of gentrification", "Gentrifying"), "10-year Census comparison"));
    $("#s-summary").innerHTML = out.join("");
    $("#s-more").innerHTML = more.join("");
    hint("h-hood", [rec.acs?.income ? `median income ${money(rec.acs.income)}` : "", rec.jobs?.jobs_change != null ? `jobs ${signed(rec.jobs.jobs_change)} in 5 yrs` : ""].filter(Boolean).join(", "));
  }

  // ---------------------------------------------------------------- prices
  let realPrices = false;
  function renderPrices() {
    const hist = priceHistory();
    if (!hist) { $("#s-prices").innerHTML = `<h2>Price history</h2><p class="note">No price history for this zip.</p>`; return; }
    const vals = completeYears(hist);
    const firstI = vals.findIndex(v => v != null), lastI = vals.length - 1;
    const span = lastI - firstI;
    const cagr = span > 0 ? (Math.pow(vals[lastI] / vals[firstI], 1 / span) - 1) * 100 : NaN;
    const inflAll = cpiFactor(hist.years[firstI]) / cpiFactor(hist.years[lastI]);
    const realCagr = span > 0 && inflAll ? (Math.pow(vals[lastI] / vals[firstI] / inflAll, 1 / span) - 1) * 100 : NaN;
    const ten = vals.length > 10 && vals[lastI - 10] ? (Math.pow(vals[lastI] / vals[lastI - 10], 0.1) - 1) * 100 : NaN;
    const changes = vals.slice(1).map((v, i) => v && vals[i] ? (v / vals[i] - 1) * 100 : null).filter(x => x != null);
    const downYears = changes.filter(x => x < 0).length, worst = Math.min(...changes);
    const types = TYPES.filter(t => t[0] !== "custom" && rec.zhvi_now?.[t[0]])
      .map(t => `<tr><td>${t[1]}</td><td>${k(rec.zhvi_now[t[0]])}</td></tr>`).join("");
    $("#s-prices").innerHTML = `
      <h2>Price history</h2>
      <div class="asof">${hist.fromFhfa ? `FHFA zip price index (${rec.hpi.start}-${NAT.asof.fhfa}) scaled to Zillow values, Zillow after that` : "Zillow home value index"}, through ${NAT.asof.zillow_values}</div>
      <div class="row" style="margin-top:8px"><label><input type="checkbox" id="realToggle" ${realPrices ? "checked" : ""}> Show in today's dollars (after inflation)</label></div>
      <div class="chart"><canvas id="cPrices"></canvas></div>
      <div class="two">
        <div><table>
          <tr><td>Yearly growth since ${hist.years[firstI]}</td><td>${signed(cagr)}</td></tr>
          <tr><td>Same, after inflation</td><td>${signed(realCagr)}</td></tr>
          <tr><td>Yearly growth, last 10 years</td><td>${signed(ten)}</td></tr>
          <tr><td>Years prices fell</td><td>${downYears} of ${changes.length}</td></tr>
          <tr><td>Worst single year</td><td>${signed(worst)}</td></tr>
        </table></div>
        <div>${types ? `<table><tr><th>Typical value now, by type</th><th></th></tr>${types}</table>` : ""}
          <p class="note">Listings sites don't tag villas or bungalows, so "type" here is building type plus price tier. Upper-end is the typical home in the priciest third, the closest stand-in for mansions.</p></div>
      </div>`;
    const ds = hist.vals.map((v, i) => v == null ? null : realPrices ? v * (cpiFactor(hist.years[i]) || 1) : v);
    makeChart("cPrices", { type: "line", data: { labels: hist.years,
      datasets: [{ label: realPrices ? "Typical value, today's dollars" : "Typical value", data: ds, borderColor: css("--c1"),
        backgroundColor: "transparent", pointRadius: 0, borderWidth: 2, spanGaps: true }] },
      options: { scales: { y: { ticks: { callback: v => k(v) } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => k(c.parsed.y) } } } } });
    $("#realToggle").onchange = e => { realPrices = e.target.checked; renderPrices(); };
  }

  function alignMonthly(series, labels) {
    const [y0, m0] = series.start.split("-").map(Number);
    const map = new Map(series.v.map((v, i) => { const mm = m0 - 1 + i; return [`${y0 + Math.floor(mm / 12)}-${String(mm % 12 + 1).padStart(2, "0")}`, v]; }));
    return labels.map(l => map.get(l) ?? null);
  }

  // 5 / 10 / 15 / 20% down side by side for the selected home.
  function downTable(tp, o) {
    const opts = [5, 10, 15, 20];
    const cols = opts.map(dp => {
      const m = Calc.monthly(tp, { ...o, downPct: dp, downAmt: null }), cash = tp * (dp + o.closingPct) / 100;
      const share = m.total / (o.income / 12) * 100, dti = (m.total + o.debts) / (o.income / 12) * 100;
      const ok = cash <= o.cash && share <= o.housingShare && dti <= o.dtiCap;
      const why = cash > o.cash ? "Cash short" : share > o.housingShare || dti > o.dtiCap ? "Payment too high" : "Yes";
      return { dp, m, cash, share, ok, why };
    });
    const row = (label, f) => `<tr><td>${label}</td>${cols.map(c => `<td${o.downAmt == null && c.dp === o.downPct ? ' style="font-weight:650"' : ""}>${f(c)}</td>`).join("")}</tr>`;
    return `<div class="table-wrap"><table>
      <tr><th></th>${cols.map(c => `<th>${c.dp}% down</th>`).join("")}</tr>
      ${row("Cash up front (incl. closing)", c => k(c.cash))}
      ${row("Loan", c => k(c.m.loan))}
      ${row("Mortgage insurance / mo", c => c.m.pmi ? money(c.m.pmi) : "None")}
      ${row("Monthly payment", c => money(c.m.total))}
      ${row("Share of income", c => pct(c.share, 0))}
      ${row("Works for you?", c => c.ok ? '<span class="pill">Yes</span>' : `<span class="pill warn">${c.why}</span>`)}
    </table></div>
    <p class="note">Under 20% down, lenders add mortgage insurance (${o.pmiRate}%/yr of the loan here) until you reach about 22% equity. FHA loans allow 3.5% down with their own insurance.</p>`;
  }

  // ---------------------------------------------------------------- buying power and monthly cost
  function renderBuying(o) {
    const tp = targetPrice(o);
    const m = Calc.monthly(tp, o);
    const rates = NAT.rate30.v, moves = Calc.rateMoves(rates);
    const shifts = [-2, -1, 0, 1, 2];
    const rows = shifts.map(s => {
      const r = o.ratePct + s;
      if (r <= 0) return "";
      const mp = Calc.maxPrice({ ...o, ratePct: r }).price;
      const pay = Calc.monthly(tp, { ...o, ratePct: r }).total;
      return `<tr${s === 0 ? ' class="best"' : ""}><td>${r.toFixed(2)}%${s === 0 ? " (now)" : ""}</td><td>${k(mp)}</td><td>${money(pay)}</td></tr>`;
    }).join("");
    const perPoint = Calc.maxPrice(o).byPayment - Calc.maxPrice({ ...o, ratePct: o.ratePct + 1 }).byPayment;
    const sel = TYPES.filter(t => t[0] === "custom" || rec.zhvi_now?.[t[0]])
      .map(t => `<option value="${t[0]}" ${t[0] === target.type ? "selected" : ""}>${t[1]}${t[0] !== "custom" ? " - " + k(rec.zhvi_now[t[0]]) : ""}</option>`).join("");
    $("#s-buying").innerHTML = `
      <h2>Rates, buying power and monthly cost</h2>
      <div class="asof">Freddie Mac 30-year average rate since 1971, latest ${NAT.rate30_latest.date}: ${NAT.rate30_latest.value}%${NAT.fed ? `. Fed funds rate (New York Fed) since 2000, latest ${NAT.asof.fed}: ${NAT.fed.v[NAT.fed.v.length - 1]}%. Mortgage rates follow the Fed's rate loosely, through longer-term bond yields` : ""}</div>
      <div class="chart"><canvas id="cRates"></canvas></div>
      <p class="note">Since 1971, rates moved a full point or more within a year ${pct(moves.shareOver1pt, 0)} of the time.</p>
      <div class="two">
        <div>
          <h3>If rates move</h3>
          <div class="table-wrap"><table><tr><th>Rate</th><th>Max you can buy</th><th>Payment on selected home</th></tr>${rows}</table></div>
          <p class="note">${Calc.maxPrice(o).limitedBy === "cash" ? "Your cash sets your limit right now, so rate changes only change the monthly payment." : `Each 1-point rise in rates cuts your buying power by about ${k(perPoint)}.`}</p>
          <h3>Down payment options</h3>
          ${downTable(tp, o)}
        </div>
        <div>
          <h3>Monthly cost of a home</h3>
          <div class="row"><select id="targetType">${sel}</select>
            <input id="customPrice" type="number" step="5000" style="width:9em" value="${target.type === "custom" ? target.custom || "" : Math.round(tp)}" ${target.type === "custom" ? "" : "hidden"}></div>
          <table style="margin-top:8px">
            <tr><td>Price</td><td>${money(tp)}</td></tr>
            <tr><td>Down payment (${pct(Calc.pctAt(tp, o), 0)}) + closing</td><td>${money(m.down + tp * o.closingPct / 100)}</td></tr>
            <tr><td>Loan principal + interest</td><td>${money(m.pi)}</td></tr>
            <tr><td>Property tax (${o.taxRate.toFixed(2)}%/yr)</td><td>${money(m.tax)}</td></tr>
            <tr><td>Insurance</td><td>${money(m.ins)}</td></tr>
            ${m.pmi ? `<tr><td>Mortgage insurance</td><td>${money(m.pmi)}</td></tr>` : ""}
            ${m.hoa ? `<tr><td>HOA</td><td>${money(m.hoa)}</td></tr>` : ""}
            <tr class="best"><td><b>Monthly total</b></td><td><b>${money(m.total)}</b></td></tr>
            <tr><td>Share of your income</td><td>${pct(m.total / (o.income / 12) * 100)}</td></tr>
            <tr><td>Upkeep set-aside (${o.maintRate}%/yr)</td><td>${money(tp * o.maintRate / 1200)}</td></tr>
            ${utilities() ? `<tr><td>Utilities: electric ${money(rec.util.electric || 0)} + gas ${money(rec.util.gas || 0)} (zip average)</td><td>${money(utilities())}</td></tr>` : ""}
            <tr><td><b>All-in per month</b></td><td><b>${money(m.total + tp * o.maintRate / 1200 + utilities())}</b></td></tr>
          </table>
          <p class="note">Tax rate is what owners here actually pay (Census)${rec.state === "CA" ? ", raised to 1.1% because California reassesses at the sale price" : ""}.${o.hoaAuto && o.hoa ? " HOA is the typical condo fee in current listings." : ""}${o.hoaAuto && !o.hoa && target.type === "condo" ? " Condo HOA unknown here; add it under More assumptions." : ""} Water and trash not included.</p>
        </div>
      </div>`;
    const start = NAT.rate30.start.split("-").map(Number);
    const labels = rates.map((_, i) => { const mm = start[1] - 1 + i; return `${start[0] + Math.floor(mm / 12)}-${String(mm % 12 + 1).padStart(2, "0")}`; });
    makeChart("cRates", { type: "line", data: { labels,
      datasets: [{ label: "30-year mortgage rate", data: rates, borderColor: css("--c2"), pointRadius: 0, borderWidth: 1.5 },
        ...(NAT.fed ? [{ label: "Fed funds rate", data: alignMonthly(NAT.fed, labels), borderColor: css("--c3"), pointRadius: 0, borderWidth: 1.5 }] : [])] },
      options: { scales: { x: { ticks: { maxTicksLimit: 10, callback: function (v) { return this.getLabelForValue(v).slice(0, 4); } } },
        y: { ticks: { callback: v => v + "%" } } }, plugins: { legend: { display: !!NAT.fed } } } });
    hint("h-cost", `${money(m.total)}/mo for the ${typeName()} at ${o.ratePct}%`);
    $("#targetType").onchange = e => {
      target.type = e.target.value;
      if (target.type === "custom" && !target.custom) target.custom = Math.round(tp);
      renderAll();
    };
    $("#customPrice").onchange = e => { target.custom = Number(e.target.value) || 0; renderAll(); };
  }

  // ---------------------------------------------------------------- outlook and best time to buy
  function bands(hist, o) {
    const vals = completeYears(hist);
    const byH = {};
    for (let h = 1; h <= 10; h++) byH[h] = Calc.growthBand(vals, h);
    return { byH, plan: Calc.growthBand(vals, Math.min(o.H, 15)) || byH[10] || byH[5] };
  }
  function renderTiming(o) {
    const hist = priceHistory(), tp = targetPrice(o);
    if (!hist || !tp) { $("#s-timing").innerHTML = ""; return; }
    const b = bands(hist, o), fc = rec.fc && rec.fc["5"] ? rec.fc : null;
    if (!fc && !b.plan) { $("#s-timing").innerHTML = `<h2>Outlook</h2><p class="note">Not enough price history here to build a range.</p>`; return; }
    const ownNow = Calc.monthly(tp, o).total + tp * o.maintRate / 1200;
    const sim = { ...o, save: Math.max(0, ownNow - o.rent0), price0: tp, rate0: o.ratePct, cash0: o.cashKnown ? o.cash : Calc.downAt(tp, o) + tp * o.closingPct / 100 };
    const ann = x => Math.pow(1 + x / 100, 1 / 5) - 1;     // 5-year % change -> yearly rate
    const scen = fc ? { low: ann(fc["5"][0]), mid: ann(fc["5"][1]), high: ann(fc["5"][2]) }
                    : { low: b.plan.low, mid: b.plan.mid, high: b.plan.high };
    const plans = [null, 0, 1, 2, 3, 4, 5];
    const res = plans.map(kk => ({ k: kk, low: Calc.simulate(sim, kk, scen.low), mid: Calc.simulate(sim, kk, scen.mid), high: Calc.simulate(sim, kk, scen.high) }));
    const buyRows = res.filter(r => r.k !== null);
    const ok = buyRows.filter(r => r.mid.feasible);
    const best = ok.length ? ok.reduce((a, c) => c.mid.netWorth > a.mid.netWorth ? c : a) : null;
    const rentOnly = res[0];
    const yr = builtYear();
    let verdict;
    if (!best) verdict = `Under the likely scenario the selected home doesn't fit your cash and income in the next 5 years. Try a cheaper type, a bigger down payment fund or a longer horizon.`;
    else {
      const gap = best.mid.netWorth - rentOnly.mid.netWorth;
      const when = best.k === 0 ? "now" : `in ${best.k} year${best.k > 1 ? "s" : ""} (${yr + best.k})`;
      verdict = gap >= 0
        ? `Best time to buy the selected home: <b>${when}</b>. After ${o.H} years that leaves you about ${k(gap)} ahead of renting (likely case). ` +
          (best.low.netWorth < rentOnly.low.netWorth ? "If prices do badly, renting would come out ahead." : "It still beats renting if prices do badly.")
        : `<b>Renting comes out ahead</b> here over ${o.H} years, by about ${k(-gap)} in the likely case. If you do buy, ${when} is the best time.`;
    }
    hint("h-future", [fc ? `likely ${signed(fc["1"][1])} next year, ${signed(fc["5"][1])} in 5 years` : "", best ? `best time to buy: ${best.k === 0 ? "now" : yr + best.k}` : ""].filter(Boolean).join("; "));
    const rows = buyRows.map(r => `<tr${best && r.k === best.k ? ' class="best"' : ""}>
      <td>${r.k === 0 ? "Now" : yr + r.k}</td><td>${k(r.mid.price)}</td><td>${r.mid.rate.toFixed(2)}%</td><td>${money(r.mid.payment)}</td>
      <td>${pct(r.mid.share, 0)}</td><td>${k(r.mid.need)} / ${k(r.mid.have)}</td><td>${r.mid.feasible ? "Yes" : r.mid.have < r.mid.need ? "Cash short" : "Payment too high"}</td>
      <td>${k(r.low.netWorth)}</td><td>${k(r.mid.netWorth)}</td><td>${k(r.high.netWorth)}</td></tr>`).join("");
    $("#s-timing").innerHTML = `
      <h2>Outlook and best time to buy</h2>
      ${fc ? forecastBlock(fc) : `<div class="asof">No model forecast for this zip, so the range comes from every past stretch of its own price history (${b.plan.n} stretches). Not a forecast.</div>
      <div class="chart"><canvas id="cOutlook"></canvas></div>
      <p class="note">Low / middle / high = how this zip grew in its weakest 10%, typical, and strongest 10% of past stretches: ${signed(scen.low * 100)}, ${signed(scen.mid * 100)}, ${signed(scen.high * 100)} a year.</p>`}
      ${rec.zhvi_1y != null ? `<p class="note">For comparison, Zillow's own 1-year forecast for this zip: ${signed(rec.zhvi_1y)}.</p>` : ""}
      <p class="verdict">${verdict}</p>
      <div class="table-wrap"><table>
        <tr><th>Buy in</th><th>Price</th><th>Rate</th><th>Monthly</th><th>% income</th><th>Cash need / have</th><th>Works?</th><th>Net worth ${yr + o.H}: low</th><th>middle</th><th>high</th></tr>
        ${rows}
        <tr><td>Keep renting</td><td colspan="6" class="muted" style="text-align:left">Rent ${money(o.rent0)}/mo, rising with typical rent growth, savings invested</td>
          <td>${k(rentOnly.low.netWorth)}</td><td>${k(rentOnly.mid.netWorth)}</td><td>${k(rentOnly.high.netWorth)}</td></tr>
      </table></div>
      <p class="note">Each plan spends the same each month (what owning costs now); while renting, the difference is invested at ${o.invReturn}%/yr. Net worth = savings + home equity after ${o.sellPct}% selling costs. Rent grows ${o.rentGrowth.toFixed(1)}%/yr.</p>`;
    // fan chart: last 15 years of history + 10 years of range
    const lastI = hist.vals.length - 1, startI = Math.max(0, lastI - 15);
    const labels = [], hv = [], lo = [], mi = [], hi = [];
    for (let i = startI; i <= lastI; i++) { labels.push(hist.years[i]); hv.push(hist.vals[i]); lo.push(null); mi.push(null); hi.push(null); }
    const base = hist.vals[lastI];
    lo[lo.length - 1] = mi[mi.length - 1] = hi[hi.length - 1] = base;
    for (let h = 1; h <= (fc ? 5 : 10); h++) {
      labels.push(hist.years[lastI] + h); hv.push(null);
      if (fc) {
        const f = fc[String(h)];
        lo.push(f ? base * (1 + f[0] / 100) : null); mi.push(f ? base * (1 + f[1] / 100) : null); hi.push(f ? base * (1 + f[2] / 100) : null);
      } else {
        const bb = b.byH[h];
        lo.push(bb ? base * Math.pow(1 + bb.low, h) : null); mi.push(bb ? base * Math.pow(1 + bb.mid, h) : null); hi.push(bb ? base * Math.pow(1 + bb.high, h) : null);
      }
    }
    makeChart("cOutlook", { type: "line", data: { labels, datasets: [
      { label: "History", data: hv, borderColor: css("--c1"), pointRadius: 0, borderWidth: 2 },
      { label: "High", data: hi, borderColor: css("--c3"), borderDash: [4, 4], pointRadius: fc ? 3 : 0, borderWidth: 1.5, fill: "+2", backgroundColor: css("--accent-soft"), spanGaps: true },
      { label: fc ? "Likely" : "Middle", data: mi, borderColor: css("--c3"), pointRadius: fc ? 3 : 0, borderWidth: 2, spanGaps: true },
      { label: "Low", data: lo, borderColor: css("--c3"), borderDash: [4, 4], pointRadius: fc ? 3 : 0, borderWidth: 1.5, spanGaps: true },
    ] }, options: { scales: { y: { ticks: { callback: v => k(v) } } },
      plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${k(c.parsed.y)}` } } } } });
  }

  // The model forecast, how well it did on past years, and what drives it.
  function forecastBlock(fc) {
    const M = NAT.model || {}, yr = M.base_year || builtYear(), now = rec.zhvi_now?.all;
    const rows = ["1", "3", "5"].filter(h => fc[h]).map(h => `<tr><td>${yr + Number(h)} (${h} yr)</td>
      <td>${signed(fc[h][0])}</td><td><b>${signed(fc[h][1])}</b></td><td>${signed(fc[h][2])}</td><td>${now ? k(now * (1 + fc[h][1] / 100)) : ""}</td></tr>`).join("");
    const bt = (M.backtest || []).map(r => `<tr><td>${r.from} &rarr; ${r.to}${r.partial ? " (so far)" : ""}</td><td>${r.horizon} yr</td>
      <td>${r.model_error.toFixed(1)}</td><td>${r.trend_error.toFixed(1)}</td><td>${pct(r.inside_range, 0)}</td></tr>`).join("");
    const mine = rec.bt ? Object.entries(rec.bt).map(([T, v]) => `<tr><td>${T}${Number(T) === yr ? " (so far)" : ""}</td>
      <td>${signed(v[0])} to ${signed(v[2])}</td><td>${signed(v[1])}</td><td>${signed(v[3])}</td><td>${v[3] >= v[0] && v[3] <= v[2] ? "Yes" : "No"}</td></tr>`).join("") : "";
    const beat = (M.backtest || []).filter(r => !r.partial), wins = beat.filter(r => r.model_error < r.trend_error).length;
    return `<div class="asof">Machine-learning model trained on every US zip from ${M.first_origin || 2014} on. It learns how price growth depends on price trends, rates, the stock market, income, rents, jobs, education, renters, crime, politics, landlord law and insurance.</div>
      <div class="chart"><canvas id="cOutlook"></canvas></div>
      <div class="table-wrap"><table><tr><th>Forecast for</th><th>Low</th><th>Likely</th><th>High</th><th>Typical value then</th></tr>${rows}</table></div>
      <p class="note">About 8 in 10 outcomes should land between low and high (ranges widened to match past misses).</p>
      <details class="sub"><summary>How well did it predict 2022 to ${yr}?</summary>
        <p class="note">Each row trains only on data known at the start year, then compares with what happened. Error = average miss, points per year. "Trend only" extends each zip's 10-year trend.
        ${beat.length ? `The model beat the trend-only guess in ${wins} of ${beat.length} completed tests.` : ""}</p>
        <div class="table-wrap"><table><tr><th>Period</th><th>Horizon</th><th>Model error</th><th>Trend-only error</th><th>Inside range</th></tr>${bt}</table></div>
        ${mine ? `<h3>This zip, 1 year ahead</h3><div class="table-wrap"><table><tr><th>Year</th><th>Predicted range</th><th>Likely</th><th>Actual</th><th>Inside?</th></tr>${mine}</table></div>` : ""}
      </details>
      ${M.drivers ? `<details class="sub"><summary>What drives the forecast</summary><p class="note">How much the 5-year forecast gets worse when each input is scrambled, as a share of the total. Bigger means the model leans on it more.</p>
        <table>${M.drivers.map(([n, v]) => `<tr><td>${esc(n)}</td><td>${pct(v, 0)}</td></tr>`).join("")}</table></details>` : ""}`;
  }

  // ---------------------------------------------------------------- purpose-specific numbers
  function investorOpts(o) {
    return { ...o, downPct: o.invDown, downAmt: null, ratePct: o.ratePct + o.invPremium };
  }
  function renderPurpose(o) {
    const mode = $("#purpose").value, tp = targetPrice(o), rent = typicalRent();
    const law = STATES[rec.state]?.law, lean = lawLean(law);
    let html = "";
    if (mode === "live") {
      const own = Calc.monthly(tp, o).total + tp * o.maintRate / 1200;
      const car = STATES[rec.state]?.car_insurance;
      html = `<h2>Buying to live in</h2>
        <table><tr><td>Owning the selected home, all-in per month</td><td>${money(own)}</td></tr>
        ${STATES[rec.state]?.car_quote ? `<tr><td>Car insurance, typical full-coverage quote in the state (Sep 2026)</td><td>${money(STATES[rec.state].car_quote)}</td></tr>` : car ? `<tr><td>Car insurance, state average per car (2024)</td><td>${money(car / 12)}</td></tr>` : ""}
        ${rent ? `<tr><td>Typical rent in this zip</td><td>${money(rent)}</td></tr>
        <tr><td>Owning costs ${own > rent ? "more" : "less"} than renting by</td><td>${money(Math.abs(own - rent))}/mo</td></tr>` : ""}</table>
        <p class="note">Part of each mortgage payment is savings (principal), which renting doesn't give you. The best-time table on the Prices tab weighs both sides.</p>`;
    } else if (mode === "rent" || mode === "str") {
      const io = investorOpts(o);
      let monthlyRent = rent, label = "Typical long-term rent";
      if (mode === "str") {
        monthlyRent = o.strNightly * 30.4 * o.strOcc / 100 * (1 - o.strFees / 100);
        label = `Airbnb take-home (${money(o.strNightly)}/night, ${o.strOcc}% booked, after ${o.strFees}% fees)`;
      }
      if (!monthlyRent) { $("#s-purpose").innerHTML = `<h2>Rental investment</h2><p class="note">No rent data for this zip.</p>`; return; }
      const r = Calc.rental(tp, monthlyRent, { ...io, mgmt: mode === "str" ? 0 : o.mgmt });
      html = `<h2>${mode === "str" ? "Short-term rental" : "Rental investment"}</h2>
        <div class="asof">Investor loan: ${io.downPct}% down at ${io.ratePct.toFixed(2)}% (owner rate + ${o.invPremium} pts)</div>
        <table>
          <tr><td>${label}</td><td>${money(monthlyRent)}/mo</td></tr>
          <tr><td>Yearly operating costs (vacancy, ${mode === "str" ? "" : "manager, "}tax, insurance, upkeep${o.hoa ? ", HOA" : ""})</td><td>${money(r.expenses)}</td></tr>
          <tr><td>Net operating income / yr</td><td>${money(r.noi)}</td></tr>
          <tr><td>Cap rate (income / price)</td><td>${pct(r.capRate, 2)}</td></tr>
          <tr><td>Loan payment</td><td>${money(r.pi)}/mo</td></tr>
          <tr class="best"><td><b>Cash flow after the loan</b></td><td><b>${money(r.cashFlow)}/mo</b></td></tr>
          <tr><td>Cash-on-cash return</td><td>${pct(r.cashOnCash)}</td></tr>
          <tr><td>Cash needed up front</td><td>${money(r.cashIn)}</td></tr>
        </table>
        <p class="note">${r.cashFlow < 0 ? "Negative cash flow means you'd pay in each month and rely on price growth. " : ""}
        Landlord law in ${esc(STATES[rec.state]?.name || rec.state)}: ${lean ? lean.label.toLowerCase() : "n/a"}.
        ${mode === "str" ? "Short-term rentals are licensed, capped or banned city by city (and by many HOAs). Check the city's rules before counting on this income; there's no national dataset for it." : ""}
        ${rec.acs?.renter_share != null ? `Renters live in ${pct(rec.acs.renter_share, 0)} of homes here and ${pct(rec.acs.rent_vacancy)} of rentals are empty.` : ""}</p>`;
    } else if (mode === "hack") {
      const partRent = o.hackRent ?? (rent ? rent / 2 : 0);
      const m = Calc.monthly(tp, o), own = m.total + tp * o.maintRate / 1200;
      const net = own - partRent * (1 - o.vacancy / 100);
      html = `<h2>Live in part, rent out part</h2>
        <table>
          <tr><td>Owning the selected home, all-in</td><td>${money(own)}/mo</td></tr>
          <tr><td>Rent from the part you rent out</td><td>${money(partRent)}/mo</td></tr>
          <tr class="best"><td><b>What housing costs you</b></td><td><b>${money(net)}/mo</b></td></tr>
          <tr><td>Your rent now</td><td>${money(o.rent0)}/mo</td></tr>
          <tr><td>Lenders usually count 75% of the rent toward qualifying</td><td>${money(partRent * 0.75)}/mo</td></tr>
        </table>
        <p class="note">Living in one unit of a 2-4 unit building lets you use owner-occupant loans (lower rates, FHA from 3.5% down) instead of investor loans. In listings, pick the "Multi-unit" type. Renting a room or basement can need a permit, so check the city's rules.</p>`;
    }
    $("#s-purpose").innerHTML = html;
    hint("h-purpose", ({ live: "to live in", rent: "as a rental", hack: "live in part, rent out part", str: "short-term rental" })[mode]);
  }

  // ---------------------------------------------------------------- neighborhood
  function renderHood() {
    const a = rec.acs;
    if (!a) { $("#s-hood").innerHTML = ""; return; }
    const ind = rec.ind || {}, y = NAT.acs_years || [];
    const mix = a.mix || {}, total = Object.values(mix).reduce((s, v) => s + (v || 0), 0);
    const bars = total ? Object.entries(mix).map(([lab, v]) => `<div class="bar"><span>${lab}</span>
      <span class="fill" style="width:${(v || 0) / total * 100}%"></span><span>${pct((v || 0) / total * 100, 0)}</span></div>`).join("") : "";
    const gentText = {
      "Signs of gentrification": "Was lower-income for its state 10 years ago, and since then both the college-educated share and real home values rose faster than in the state's typical zip.",
      "Lower-income, no gentrification signs": "Was lower-income for its state 10 years ago, but college share and home values haven't both outpaced the state.",
      "Not a lower-income area at the start": "Wasn't lower-income for its state 10 years ago, so the gentrification test doesn't apply.",
    };
    $("#s-hood").innerHTML = `
      <h2>Neighborhood</h2>
      <div class="asof">Census American Community Survey ${NAT.asof.acs}${NAT.asof.acs_old ? `, compared with ${NAT.asof.acs_old}` : ""}${NAT.asof.crime ? `. Crime: ${NAT.asof.crime}, county level` : ""}</div>
      <div class="two">
        <table>
          <tr><th></th><th>Now</th><th>10 yrs earlier</th></tr>
          <tr><td>Median household income</td><td>${money(a.income)}</td><td>${money(a.income_old)}</td></tr>
          <tr><td>Income change after inflation</td><td>${signed(ind.income_change)}</td><td></td></tr>
          <tr><td>Adults with a bachelor's degree+</td><td>${pct(a.college, 0)}</td><td>${pct(a.college_old, 0)}</td></tr>
          <tr><td>Home value change after inflation</td><td>${signed(ind.value_change)}</td><td></td></tr>
          <tr><td>Rent change after inflation</td><td>${signed(ind.rent_change)}</td><td></td></tr>
          <tr><td>Poverty rate</td><td>${pct(a.poverty)}</td><td></td></tr>
          <tr><td>Unemployment</td><td>${pct(a.unemployment)}</td><td></td></tr>
          <tr><td>Population</td><td>${Math.round(a.pop).toLocaleString()}</td><td></td></tr>
          <tr><td>Typical year homes were built</td><td>${a.year_built || "n/a"}</td><td></td></tr>
          ${ind.crime != null ? `<tr><td>${crimeName()} per 100k (county)</td><td>${Math.round(ind.crime)}</td><td></td></tr>` : ""}
          ${a.broadband != null ? `<tr><td>Homes with broadband internet</td><td>${pct(a.broadband, 0)}</td><td></td></tr>` : ""}
          ${rec.jobs ? `<tr><td>Jobs in the county</td><td>${Math.round(rec.jobs.jobs).toLocaleString()}</td><td>${signed(rec.jobs.jobs_change)} since</td></tr>
          <tr><td>Average pay in the county</td><td>${money(rec.jobs.avg_pay)}</td><td></td></tr>` : ""}
          ${STATES[rec.state]?.car_quote ? `<tr><td>Car insurance, full-coverage quote (state, Sep 2026)</td><td>${money(STATES[rec.state].car_quote)}/mo</td><td></td></tr>` : ""}
          ${STATES[rec.state]?.car_insurance ? `<tr><td>Car insurance, average actually paid (state, 2024)</td><td>${money(STATES[rec.state].car_insurance)}/yr</td><td></td></tr>` : ""}
        </table>
        <div>
          <b>Housing mix</b> <span class="note">(share of all homes by building type)</span>
          <div class="mix">${bars}</div>
          ${ringTable(a, ind)}
          ${rec.gent ? `<h3>Gentrification check: ${rec.gent}</h3><p class="note">${gentText[rec.gent] || ""} A rule of thumb from housing research, not a verdict.</p>` : ""}
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------- politics and law
  function lawLean(law) {
    if (!law) return null;
    const rc = law.rent_control.toLowerCase(), jc = law.just_cause.toLowerCase(), days = Number(law.nonpay_notice_days);
    const tenantPts = (rc.startsWith("statewide") || rc.startsWith("local rent control") ? 1 : 0) +
      (jc.startsWith("yes") ? 1 : jc.startsWith("limited") ? 0.5 : 0) + (days >= 14 ? 0.5 : 0);
    if (tenantPts >= 1.5) return { label: "Tenant-leaning" };
    if (rc.startsWith("cities banned") && jc === "no" && days <= 5) return { label: "Landlord-leaning" };
    return { label: "In between" };
  }
  function renderLaw() {
    const st = STATES[rec.state];
    if (!st) { $("#s-law").innerHTML = ""; return; }
    const law = st.law, lean = lawLean(law), days = Number(law.nonpay_notice_days);
    hint("h-law", `${lean.label.toLowerCase()} (${esc(st.name)})`);
    $("#s-law").innerHTML = `
      <h2>Politics and landlord-tenant law</h2>
      <div class="asof">Presidential results from MIT Election Lab${NAT.asof.elections ? ` through ${NAT.asof.elections}` : ""}. Law table checked October 2026; laws change, so confirm before you act.</div>
      ${st.votes || rec.votes ? `<div class="chart"><canvas id="cVotes"></canvas></div><p class="note">Above zero leans Republican, below zero leans Democratic (margin in points).</p>` : ""}
      <h3>${esc(st.name)}: ${lean.label}</h3>
      <table>
        <tr><td>Rent control</td><td style="white-space:normal">${esc(law.rent_control)}</td></tr>
        <tr><td>Landlord needs a reason to end a lease (just cause)</td><td>${esc(law.just_cause)}</td></tr>
        <tr><td>Notice before filing eviction for unpaid rent</td><td>${days ? days + " days" : "None or immediate"}</td></tr>
        ${law.notes ? `<tr><td colspan="2" style="text-align:left;white-space:normal" class="note">${esc(law.notes)}</td></tr>` : ""}
      </table>
      <p class="note">Cities can add their own rules. Full details: <a href="https://lawatlas.org/datasets/state-eviction-laws" target="_blank" rel="noopener">LSC / LawAtlas eviction laws database</a>.</p>`;
    if (st.votes || rec.votes) {
      const years = (st.votes || rec.votes).years;
      const margin = v => v ? years.map(y => { const i = v.years.indexOf(y); return i < 0 ? null : +(v.rep[i] - v.dem[i]).toFixed(1); }) : null;
      const ds = [];
      if (rec.votes) ds.push({ label: (rec.county || "County"), data: margin(rec.votes), borderColor: css("--c1"), borderWidth: 2, pointRadius: 3 });
      if (st.votes) ds.push({ label: st.name, data: margin(st.votes), borderColor: css("--c2"), borderWidth: 2, borderDash: [4, 3], pointRadius: 3 });
      makeChart("cVotes", { type: "line", data: { labels: years, datasets: ds },
        options: { scales: { y: { ticks: { callback: v => (v > 0 ? "R +" : v < 0 ? "D +" : "") + Math.abs(v) } } },
          plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y > 0 ? "R" : "D"} +${Math.abs(c.parsed.y)}` } } } } });
    }
  }

  // ---------------------------------------------------------------- overall scores
  // Each factor becomes 0-100 (by rank among the options shown, or a fixed scale), and the overall
  // score is their plain average over the factors you've switched on.
  const rankPct = vals => {
    const a = vals.filter(Number.isFinite).sort((x, y) => x - y);
    return v => !Number.isFinite(v) || a.length < 3 ? null : Math.round((a.filter(x => x < v).length + 0.5 * a.filter(x => x === v).length) / a.length * 100);
  };
  const clamp100 = v => Math.max(0, Math.min(100, Math.round(v)));
  const blend = (parts, on) => { let t = 0, n = 0; for (const [kk, v] of Object.entries(parts)) if (v != null && on.has(kk)) { t += v; n++; } return n ? Math.round(t / n) : null; };
  const loadSet = (key, all) => { try { const v = JSON.parse(localStorage.getItem(key)); if (Array.isArray(v)) return new Set(v); } catch (e) { /* ignore */ } return new Set(all); };
  const saveSet = (key, set) => { try { localStorage.setItem(key, JSON.stringify([...set])); } catch (e) { /* ignore */ } };
  const LFACT = [["space", "Space"], ["value", "Price vs estimate"], ["shop", "Store nearby"], ["walk", "Walkable"], ["commute", "Commute"], ["quiet", "Quiet"], ["vaastu", "Vaastu"]];
  const ZFACT = [["school", "Schools"], ["safety", "Safety"], ["risk", "Low disaster risk"], ["growth", "Growth"], ["outlook", "Price outlook"], ["room", "Room in budget"], ["commute", "Commute"]];
  let lOn = loadSet("hc-lfact", LFACT.map(f => f[0])), zOn = loadSet("hc-zfact", ZFACT.map(f => f[0]));
  const factorChips = (list, on, id) => `<div class="chips" id="${id}"><span class="note" style="align-self:center">What matters:</span>${list.map(([kk, l]) => `<button type="button" class="${on.has(kk) ? "on" : ""}" data-f="${kk}">${l}</button>`).join("")}</div>`;
  const strong = (parts, on, list) => list.filter(([kk]) => on.has(kk) && parts[kk] >= 75).map(([, l]) => l.toLowerCase());
  const HAZ = { "Very low": 100, "Relatively low": 80, "Relatively moderate": 60, "Relatively high": 35, "Very high": 10 };

  // ---------------------------------------------------------------- listings
  function median(a) { return Calc.percentile(a, 50); }

  const WALK = [["grocery", "grocery / convenience store"], ["park", "park"], ["transit", "bus/train stop"], ["pharmacy", "pharmacy"], ["food", "cafe or restaurant"], ["school", "school"]];



  // Crime level from the county rate per 100k (US averages: about 6 homicides, about 380 violent crimes).
  const crimeLevel = v => { if (!Number.isFinite(v)) return null; const t = crimeName() === "Homicides" ? [3, 7, 12] : [200, 400, 700];
    return v < t[0] ? "low" : v < t[1] ? "moderate" : v < t[2] ? "high" : "very high"; };
  const facingRatingText = f => ["N", "E", "NE"].includes(f) ? "favoured" : f === "SW" ? "least favoured" : ["S", "SE"].includes(f) ? "not ideal" : "acceptable";

  // ---------------------------------------------------------------- "Our take": a written read on one house
  // Built from every signal the page has (value, market, forecast, budget, schools, crime, hazards,
  // growth, condition, Vaastu, purpose). Plain rules, no paid AI: each sentence says what the data says.
  function ourTake(s, d, o) {
    const out = [], mode = $("#purpose").value, kind = { "Condo": "condo", "Apartment": "apartment", "Townhouse": "townhouse", "Single Family": "house", "Manufactured": "manufactured home" }[s.propertyType] || "home";
    const size = s.propertyType === "Multi-Family" ? `multi-unit building${s.bedrooms ? ` (${s.bedrooms} beds in total)` : ""}` : [s.bedrooms ? `${s.bedrooms}-bed` : "", kind].filter(Boolean).join(" ");
    const m = rec.market || {}, fc = rec.fc?.["1"], fc5 = rec.fc?.["5"], sd = rec.schools?.district, g = rec.growth, hz = rec.hazard;
    // 1. the price
    const priceBit = !Number.isFinite(d.gap) ? `There isn't enough data to put a value on this ${size}.`
      : d.gap <= -15 ? `This ${size} is listed ${Math.abs(d.gap).toFixed(0)}% below what similar homes are worth (${k(d.F)}). That's unusually low: either a real bargain or a problem the photos don't show.`
      : d.gap <= -5 ? `This ${size} is listed ${Math.abs(d.gap).toFixed(0)}% below what similar homes are worth (${k(d.F)}), which is a good start.`
      : d.gap <= 8 ? `This ${size} is priced about right: asking is within a few percent of its value (${k(d.F)}).`
      : `This ${size} is listed ${d.gap.toFixed(0)}% above what similar homes are worth (${k(d.F)}), so there's room to push the price down.`;
    const mkBit = m.label ? ` It's a ${m.label.toLowerCase().replace(/^balanced$/, "balanced market")}${m.dom ? ` where homes take about ${Math.round(m.dom)} days to sell` : ""}${d.stale ? `, and this one has sat for ${s.daysOnMarket} days` : ""}.` : "";
    out.push(priceBit + mkBit);
    // 2. what it means for you
    const oo = { ...o, hoa: s.hoa || o.hoa || 0 }, mo = Calc.monthly(d.offer, oo), cash = Calc.downAt(d.offer, o) + d.offer * o.closingPct / 100;
    const share = mo.total / (o.income / 12) * 100;
    out.push(d.overBudget
      ? `At around ${k(d.offer)} it's over your budget of ${k(d.maxPrice)}: you'd need more saved or a cheaper home.`
      : `At around ${k(d.offer)} you'd pay about ${money(mo.total)} a month (${share.toFixed(0)}% of your income) and need about ${k(cash)} up front${o.cashKnown ? (o.cash >= cash ? `, leaving ${k(o.cash - cash)} of your savings as a cushion` : `, ${k(cash - o.cash)} more than you have saved`) : ""}.`);
    if (mode === "rent" || mode === "str") {
      const rents = (listing?.rent || []).filter(r => r.price && r.bedrooms === s.bedrooms).map(r => r.price);
      const rent = rents.length >= 3 ? median(rents) : typicalRent();
      if (rent) {
        const r = Calc.rental(d.offer, rent, { ...investorOpts(oo), mgmt: o.mgmt });
        out.push(`As a rental it would bring about ${money(rent)} a month${rents.length >= 3 ? ` (similar ${s.bedrooms}-bed rentals nearby)` : ""}, for ${r.cashFlow >= 0 ? `${money(r.cashFlow)} a month of profit` : `a loss of ${money(-r.cashFlow)} a month`} after the loan and costs (cap rate ${pct(r.capRate, 1)}).`);
      }
    } else if (o.rent0) {
      out.push(mo.total > o.rent0 ? `That's ${money(mo.total - o.rent0)} a month more than your rent now, though part of each payment builds equity.` : `That's ${money(o.rent0 - mo.total)} a month less than your rent now.`);
    }
    // 3. where prices and the area are heading
    const fut = [];
    if (fc) fut.push(`prices here are expected to ${fc[1] >= 0 ? "rise" : "fall"} about ${Math.abs(fc[1]).toFixed(1)}% next year (range ${signed(fc[0])} to ${signed(fc[2])})${fc5 ? ` and ${signed(fc5[1])} over 5 years` : ""}`);
    if (g?.rate != null) fut.push(g.rate < -0.3 ? `the population is shrinking (${signed(g.rate)} a year), which can soften demand` : g.pct >= 80 ? `the population is growing fast (${signed(g.rate)} a year), which supports demand` : `the population is ${g.rate > 0.3 ? "growing" : "steady"} (${signed(g.rate)} a year)`);
    if (rec.jobs?.jobs_change != null) fut.push(`county jobs are ${rec.jobs.jobs_change >= 0 ? "up" : "down"} ${Math.abs(rec.jobs.jobs_change).toFixed(0)}% over 5 years`);
    if (fut.length) out.push(fut.join("; ").replace(/^./, c => c.toUpperCase()) + ".");
    // 4. living there
    const area = [];
    if (sd?.n10) area.push(`schools score ${sd.n10}/10 nationally${sd.g10 ? ` with ${sd.g10 >= 6 ? "good" : "weak"} student progress (${sd.g10}/10)` : ""}`);
    if (rec.ind?.crime != null) area.push(`county crime is ${crimeLevel(rec.ind.crime)}`);
    const risks = (hz?.top || []).filter(([, , lab]) => /very high|relatively high/i.test(lab || "")).slice(0, 2).map(([n]) => n.toLowerCase());
    if (/low/i.test(hz?.label || "")) area.push("natural disaster risk is low overall");
    else if (risks.length) area.push(`the main natural risks are ${risks.join(" and ")}${risks.some(r => /flood/.test(r)) ? " (get a flood insurance quote)" : ""}`);
    if (area.length) out.push(area.join(", ").replace(/^./, c => c.toUpperCase()) + ".");
    // 5. the house itself
    const house = [];
    const shared = ["Condo", "Apartment"].includes(s.propertyType);
    if (s.yearBuilt) {
      const age = new Date().getFullYear() - s.yearBuilt;
      house.push(s.yearBuilt <= 1900 ? "the year built is listed as 1900, which often means unknown, so ask"
        : shared ? (age > 40 ? `the building is ${age} years old, so check the HOA's reserve fund and any planned special assessments` : `the building dates from ${s.yearBuilt}`)
        : age > 40 ? `it's ${age} years old, so budget for older systems (roof, wiring, pipes)` : age < 5 ? "it's nearly new" : `it was built in ${s.yearBuilt}`);
    }
    if (d.good.length) house.push(`the listing mentions ${d.good.slice(0, 2).join(" and ")}`);
    const badNotes = d.bad.filter(b => b !== "tenant in place" && b !== "price already cut");
    if (badNotes.length) house.push(`it also mentions ${badNotes.slice(0, 2).join(" and ")}, which needs a closer look`);
    if (d.bad.includes("tenant in place")) house.push("a tenant lives there now, so check the lease end date before planning to move in");
    if (d.flip) house.push("it looks recently flipped, so check the quality of the work");
    const f = s.orient?.facing;
    if (f) house.push(`it faces ${DIR_NAMES[f].toLowerCase()} (${facingRatingText(f)} in Vaastu)`);
    if (house.length) out.push(house.join("; ").replace(/^./, c => c.toUpperCase()) + ".");
    // 6. bottom line
    const serious = d.bad.some(b => /foundation|water|mold|fire/.test(b)), fixer = d.bad.some(b => /as-is|needs work|distressed/.test(b));
    const yes = !d.overBudget && Number.isFinite(d.gap) && d.gap <= 8 && !serious;
    out.push(`Bottom line: ${d.overBudget ? "not one for your current budget." : yes ? `${fixer ? "worth a look if the inspection and repair quotes come back fine." : "worth pursuing."} Open around ${k(Math.min(d.opening, d.walk))} and don't go above ${k(d.walk)}.` : `be careful. If you go for it, open around ${k(Math.min(d.opening, d.walk))} and walk away above ${k(d.walk)}.`}`);
    return out;
  }

  // ---------------------------------------------------------------- deal check for one house
  let deal = null;                               // { id, zip, base: listing row, full: property record, state }
  const fullCache = new Map();
  let steps = {};
  try { steps = JSON.parse(localStorage.getItem("hc-steps") || "{}"); } catch (e) { /* ignore */ }
  const saveSteps = () => { try { localStorage.setItem("hc-steps", JSON.stringify(steps)); } catch (e) { /* ignore */ } };

  // An address from a Realtor.com, Zillow or Redfin link, or the text as typed.
  function addressFrom(text) {
    const t = text.trim();
    let m = t.match(/realestateandhomes-detail\/([^/?#]+)/);
    if (m) { const p = m[1].split("_"); if (p.length >= 4) return `${p[0].replace(/-/g, " ")}, ${p[1].replace(/-/g, " ")}, ${p[2]} ${p[3]}`; }
    m = t.match(/zillow\.com\/homedetails\/([^/?#]+)/);
    if (m) return m[1].replace(/-/g, " ");
    m = t.match(/redfin\.com\/([A-Z]{2})\/([^/]+)\/([^/]+)\/home/);
    if (m) return `${m[3].replace(/-/g, " ").replace(/ (\d{5})$/, ", $1")}, ${m[2].replace(/-/g, " ")}, ${m[1]}`.replace(/, (\d{5}), (.+), ([A-Z]{2})$/, ", $2, $3 $1");
    return t;
  }
  async function openDeal(s) {
    deal = { id: s.id || s.formattedAddress, zip, base: s };
    if (!history.state?.deal) history.pushState({ deal: true }, "");   // the phone's back button closes the sheet
    renderDeal(inputs());
    $("#dealModal").scrollTop = 0;
    if (!fullCache.has(deal.id) && API && s.formattedAddress) {
      try {
        const r = await fetch(`${API}/api/listings?address=${encodeURIComponent(s.formattedAddress)}&v=2`), j = await r.json();
        fullCache.set(deal.id, j.home || {});
      } catch (e) { fullCache.set(deal.id, {}); }
      if (deal && rec) renderDeal(inputs());
    }
  }

  function closeDeal() {
    if (history.state?.deal) { history.back(); return; }          // the popstate handler does the closing
    deal = null; renderDeal(inputs());
  }
  window.addEventListener("popstate", () => { if (deal) { deal = null; renderDeal(inputs()); } });
  function renderDeal(o) {
    const el = $("#s-deal");
    $("#dealModal").hidden = !(deal && deal.zip === zip);
    document.body.classList.toggle("noscroll", !$("#dealModal").hidden);
    if (!deal || deal.zip !== zip) { el.innerHTML = ""; return; }
    const loadingFull = API && !fullCache.has(deal.id);
    const full = fullCache.get(deal.id) || {};
    // the listing's own days-on-market and list date win (the record's date can be from an older listing)
    const s = { ...deal.base, ...full, daysOnMarket: deal.base.daysOnMarket ?? full.daysOnMarket, listDate: deal.base.listDate ?? full.listDate };
    if (!s.price) { el.innerHTML = `<h2>${esc(s.formattedAddress || "")}</h2><p class="note">This house isn't listed for sale right now, so there's no asking price to check. ${s.lastSoldPrice ? `It last sold for ${money(s.lastSoldPrice)} on ${s.lastSoldDate}.` : ""}</p><button type="button" class="link" id="dealClose">&larr; Back to homes</button>`; $("#dealClose").onclick = closeDeal; return; }
    const oo = { ...o, hoa: s.hoa || o.hoa };
    const hist = priceHistory();
    const d = Deal.analyze(s, { sold: listing?.zip === zip ? listing.sold || [] : [], active: listing?.zip === zip ? listing.sale : null,
      monthly: rec.zhvi_recent, yearly: hist, rec, o: oo, maxPrice: Calc.maxPrice(oo).price, rate15: NAT.rate15_latest?.value });
    const bt = d.backtest, gapTxt = Number.isFinite(d.gap) ? (Math.abs(d.gap) < 3 ? "in line with" : `${Math.abs(d.gap).toFixed(0)}% ${d.gap > 0 ? "above" : "below"}`) : null;
    const verdict = !Number.isFinite(d.F) ? "No value estimate available." : d.gap > 8 ? "Priced high." : d.gap <= -15 ? "Good price, maybe too good: check for hidden problems." : d.gap <= -5 ? "Good price." : "Fair price.";
    const yrs = s.lastSoldDate ? (Date.now() - new Date(s.lastSoldDate)) / 3.156e10 : null;
    const ins = d.offer * oo.insRate / 100, hz = rec.hazard, flood = (hz?.top || []).some(([n, , lab]) => /flood/i.test(n) && /high/i.test(lab || ""));

    // the strategist's advice, shortest first
    const tips = [];
    if (d.hot) tips.push(`Homes here often sell over asking. Make a clean offer: pre-approval, 1-3% deposit, flexible closing date.`);
    if (d.soft) tips.push(`Buyers have the upper hand${rec.market?.price_drops != null ? ` (${pct(rec.market.price_drops * 100, 0)} of listings cut their price)` : ""}. Open low and ask the seller to cover closing costs or buy down your rate.`);
    if (d.stale) tips.push(`Listed ${s.daysOnMarket} days (typical here: ${Math.round(d.zipDom)}). The seller may take less.`);
    if (d.gap > 8) tips.push(`Asking is ${d.gap.toFixed(0)}% above the value estimate, so the appraisal may come in low.`);
    if (d.walk < d.expected) tips.push(`Homes here sell for more (about ${k(d.expected)}) than this one looks worth. Don't go past ${k(d.walk)}; it's fine to lose this one.`);
    if (d.gap < -8) tips.push(d.soft ? `Asking is well below the value estimate. Inspect carefully: a low price can hide problems.` : `Asking is below the value estimate. Expect competition and inspect carefully.`);
    if (d.flip) tips.push(`Sold for ${k(s.lastSoldPrice)} in ${s.lastSoldDate.slice(0, 4)}, now much higher: likely flipped. Ask for permits and receipts.`);
    if (d.bad.length) tips.push(`Listing mentions: ${d.bad.join(", ")}. Ask about it before you offer.`);
    if (d.taxNow && d.taxAfter > d.taxNow * 1.15) tips.push(`Property tax will likely rise from ${money(d.taxNow)} to about ${money(d.taxAfter)} a year after you buy.`);
    if (s.hoa) tips.push(`HOA ${money(s.hoa)}/mo: ask for its budget, reserves and any planned special fees.`);
    if (flood) tips.push(`High flood risk in this zip: check FEMA's flood map and get a flood insurance quote.`);
    tips.push(`Keep the inspection, financing and appraisal contingencies.`);

    const STEPS = [
      ["preapp", "Before the offer", "Get pre-approved, with rate quotes from 3 lenders on the same day"],
      ["ask", "Before the offer", "Ask the listing agent: other offers, price cuts, the seller's timeline, disclosure form"],
      ["permits", "Before the offer", "Look up permits on the city or county site and check the FEMA flood map"],
      ["offer", "Day 0", "Send the offer with inspection, financing and appraisal contingencies"],
      ["earnest", "Days 1-3", "Wire earnest money (confirm wiring instructions by phone: wire fraud is common)"],
      ["inspect", "Days 1-10", `Inspections: general${s.yearBuilt && s.yearBuilt < 1980 ? ", sewer scope" : ""}, radon${/TX|FL|LA|GA|AL|MS|SC|NC|AZ|CA/.test(rec.state || "") ? ", termite" : ""}${d.bad.some(b => /foundation|water/.test(b)) ? ", structural engineer" : ""}`],
      ["repairs", "Days 10-14", "Ask for repairs or a credit based on the inspection"],
      ["lock", "Days 10-20", "Lock your interest rate"],
      ["insure", "Days 10-25", `Buy homeowners insurance${flood ? " and flood insurance" : ""}`],
      ["appraisal", "Days 7-21", "Appraisal; if it comes in low, renegotiate or use the contingency"],
      ["ctc", "Days 21-35", "Final loan approval (clear to close); review the closing disclosure 3 days before"],
      ["walk", "Day before closing", "Final walk-through: repairs done, nothing new broken"],
      ["close", "Days 30-45", "Closing: sign, pay the rest of your down payment and costs, get the keys"]];
    const done = steps[deal.id] || {};
    const readRows = d.reads.map(r => `<tr><td>${esc(r.name)}${r.note ? ` <span class="note">(${esc(r.note)})</span>` : ""}</td><td>${k(r.value)}</td><td>${r.lo && r.hi ? `${k(r.lo)} - ${k(r.hi)}` : ""}</td></tr>`).join("");
    const lad = bt.ladder ? bt.ladder.map(x => `<tr><td>${pct(x.f * 100, 0)} of asking</td><td>${k(d.L * x.f)}</td><td>${pct(x.beat, 0)}</td></tr>`).join("") : "";
    const loanRows = d.loans.map(l => `<tr${l.fits ? "" : ' class="muted"'}><td>${esc(l.name)}${l.jumbo ? ' <span class="pill warn">jumbo</span>' : ""}</td><td>${k(l.cash)}</td><td>${money(l.monthly)}</td>
      <td>${l.fits ? '<span class="pill">Fits</span>' : `<span class="pill warn">${l.why}</span>`}</td></tr>`).join("");
    const th = (s.taxHistory || []).slice(0, 6);

    el.innerHTML = `<div class="dealbar"><button type="button" class="link" id="dealClose">&larr; Back to homes</button></div><h2>${esc(s.formattedAddress || "")}</h2>
      <div class="asof">Asking ${money(d.L)}${s.daysOnMarket != null ? ` &middot; listed ${s.daysOnMarket} days` : ""}${s.squareFootage ? ` &middot; ${s.squareFootage.toLocaleString()} sq ft` : ""}${s.yearBuilt ? ` &middot; built ${s.yearBuilt}` : ""}
        ${s.url ? ` &middot; <a href="${esc(s.url)}" target="_blank" rel="noopener">listing</a>` : ""}${loadingFull ? " &middot; loading the full property record..." : ""}</div>
      <p class="verdict"><b>${verdict}</b>${gapTxt ? ` Asking is ${gapTxt} the value estimate (${k(d.F)}).` : ""}</p>
      <div class="offer3">
        <div><div class="k">Open at</div><div class="v">${k(Math.min(d.opening, d.walk))}</div><div class="note">${pct(Math.min(d.opening, d.walk) / d.L * 100, 1)} of asking</div></div>
        <div><div class="k">Aim for</div><div class="v">${k(d.offer)}</div><div class="note">${Number.isFinite(d.F) ? `between its value (${k(d.F)}) and what similar homes sell for (${k(d.expected)})` : `what similar homes sell for`}</div></div>
        <div><div class="k">Walk away above</div><div class="v">${k(d.walk)}</div><div class="note">${d.walk === d.maxPrice ? "your budget" : d.walk === d.L ? "the asking price" : "value estimate + 3%"}</div></div>
      </div>
      ${d.overBudget ? `<p><span class="pill warn">Over your budget of ${k(d.maxPrice)}</span></p>` : ""}
      <p class="note">The aim starts between the home's value${Number.isFinite(d.F) ? ` (${k(d.F)})` : ""}, the asking price (${k(d.L)}) and what similar homes sell for (${k(d.expected)})${d.moves.length ? `, then moves ${d.adj >= 0 ? "up" : "down"} ${Math.abs(d.adj * 100).toFixed(1).replace(".0", "")}% for:` : "."}</p>
      ${d.moves.length ? `<ul class="note tight">${d.moves.map(m => `<li>${m.pct > 0 ? "+" : ""}${m.pct}%: ${esc(m.why)}</li>`).join("")}</ul>` : ""}
      ${(() => { const f = s.orient?.facing || shortlist[deal.id]?.facing, v = vaastuScore({ ...(shortlist[deal.id] || {}), facing: f, tjunction: s.orient ? !!s.orient.tjunction : undefined });
        return f ? `<p class="vaastu-line"><b>Vaastu ${v ? `${v.pct}%` : ""}</b>${v ? ` <span class="muted">(from ${v.checks} of 8 checks)</span>` : ""} &middot; faces ${DIR_NAMES[f].toLowerCase()} (${facingRatingText(f)} in Vaastu)${s.orient?.tjunction ? " &middot; a street points straight at it" : ""}${s.orient?.corner ? " &middot; corner lot" : ""}. ${shortlist[deal.id] ? "" : "Save it to add the rooms for a full score."}</p>`
          : `<p class="vaastu-line muted">Facing not known yet, so no Vaastu score. Check the satellite view.</p>`; })()}
      <div class="take"><h3>Our take</h3>${ourTake(s, d, o).map(t => `<p>${t}</p>`).join("")}</div>
      <h3>What to do</h3><ul class="tight">${tips.map(t => `<li>${t}</li>`).join("")}</ul>

      <details class="sub"><summary>How this was worked out</summary>
        <p class="note">${d.comp.n >= 8 ? `${d.comp.n} homes sold here in the last 6 months, typically at ${pct(d.comp.stl * 100, 1)} of asking after ${Math.round(d.comp.dom)} days.` :
          d.nonDisclosure ? `${esc(STATES[rec.state]?.name || rec.state)} doesn't publish sale prices, so this uses market data and value estimates only.` : "Too few recent sales here; assumes homes sell at 98% of asking."}
        ${bt.n >= 8 ? `Tested on those sales, the "what similar homes sell for" price (${k(d.expected)} here) landed within 5% of the real price ${pct(bt.within5, 0)} of the time. The aim sits between that and the home's value (${Number.isFinite(d.F) ? k(d.F) : "n/a"}), so you neither overpay because the asking price is high nor lowball a home that's worth more.` : ""}</p>
        ${lad ? `<div class="table-wrap"><table><tr><th>Offer</th><th>Price</th><th>Recent sales it would have matched or beaten</th></tr>${lad}</table></div>` : ""}
        <h3>Value estimates</h3>
        <div class="table-wrap"><table><tr><th>Source</th><th>Value</th><th>Range</th></tr>${readRows || `<tr><td colspan="3">None available</td></tr>`}</table></div>
        ${d.comps.length ? `<details class="sub"><summary>The nearby sales used (${d.comps.length})</summary><div class="table-wrap"><table><tr><th>Address</th><th>Sold</th><th>When</th><th>Sq ft</th><th>Beds</th><th>Miles</th><th>In today's prices, scaled to this size</th></tr>
          ${d.comps.map(c => `<tr><td>${esc(c.address || "")}</td><td>${k(c.sold)}</td><td>${c.date || ""}</td><td>${c.sqft ? c.sqft.toLocaleString() : ""}</td><td>${c.bedrooms ?? ""}</td><td>${c.dist.toFixed(1)}</td><td>${k(c.value)}</td></tr>`).join("")}</table></div>
          <p class="note">Adjusted to today's prices and this home's size. Condition isn't recorded.</p></details>` : ""}
      </details>

      <details class="sub"><summary>History, taxes and land</summary>
        <table>
          ${s.listDate ? `<tr><td>Listed</td><td>${s.listDate}${s.daysOnMarket != null ? ` (${s.daysOnMarket} days${Number.isFinite(d.zipDom) ? `; typical here ${Math.round(d.zipDom)}` : ""})` : ""}</td></tr>` : ""}
          ${s.lastSoldDate ? `<tr><td>Last sold</td><td>${s.lastSoldPrice ? money(s.lastSoldPrice) + " on " : ""}${s.lastSoldDate}</td></tr>` : ""}
          ${d.lastIdx ? `<tr><td>That price grown with the zip's prices</td><td>${k(d.lastIdx)}</td></tr>` : ""}
          ${d.taxNow ? `<tr><td>Property tax, seller's latest bill</td><td>${money(d.taxNow)}/yr</td></tr>` : ""}
          <tr><td>Property tax at the expected price (${pct(o.taxRate, 2)} zip rate)</td><td>${money(d.taxAfter)}/yr</td></tr>
          ${d.taxTrend != null ? `<tr><td>Yearly change in the tax bill</td><td>${signed(d.taxTrend)}</td></tr>` : ""}
          ${d.landShare ? `<tr><td>Land share of the tax assessment</td><td>${pct(d.landShare * 100, 0)}</td></tr><tr><td>Land value at the value estimate</td><td>${k(d.landValue)}</td></tr>` : ""}
          ${s.hoa ? `<tr><td>HOA</td><td>${money(s.hoa)}/mo</td></tr>` : ""}
          <tr><td>Home insurance, state average at this price</td><td>${money(ins)}/yr</td></tr>
          ${s.views7 ? `<tr><td>Realtor.com views / saves, last 7 days</td><td>${s.views7.toLocaleString()} / ${s.saves7 ?? 0}</td></tr>` : ""}
        </table>
        ${th.length ? `<div class="table-wrap"><table><tr><th>Tax year</th><th>Tax</th><th>Land</th><th>Building</th><th>Assessed</th></tr>${th.map(r => `<tr><td>${r[0]}</td><td>${money(r[1])}</td><td>${r[2] ? k(r[2]) : ""}</td><td>${r[3] ? k(r[3]) : ""}</td><td>${r[4] ? k(r[4]) : ""}</td></tr>`).join("")}</table></div>
          <p class="note">County assessments often run below market value; the land share is what matters.</p>` : ""}
      </details>

      <details class="sub"><summary>Condition, structure, crime and risks</summary>
        ${d.facts.length ? `<p class="note"><b>From the listing record:</b> ${d.facts.map(esc).join("; ")}.</p>` : ""}
        ${d.build.length ? `<p class="note"><b>Built with / on:</b> ${d.build.join(", ")}.</p>` : ""}
        ${d.good.length ? `<p class="note"><b>Updates mentioned:</b> ${d.good.join(", ")}. Ask for dates, permits and receipts.</p>` : ""}
        ${d.bad.length ? `<p class="note"><b>Watch-outs mentioned:</b> ${d.bad.join(", ")}.</p>` : ""}
        ${s.yearBuilt ? `<ul class="note tight">${ageFlags(s.yearBuilt, ["Condo", "Apartment"].includes(s.propertyType)).map(f => `<li>${f}</li>`).join("")}</ul>` : ""}
        ${rec.ind?.crime != null ? `<p class="note"><b>Crime (county):</b> ${crimeLevel(rec.ind.crime)}, ${rec.ind.crime.toFixed(1)} ${crimeName().toLowerCase()} per 100,000 people a year${rec.pct?.crime != null ? `, higher than ${Math.round(rec.pct.crime)}% of US zips` : ""}. Check the city police department's crime map for the street.</p>` : ""}
        ${hz ? `<p class="note"><b>Natural hazards (FEMA, this zip):</b> overall ${(hz.label || "").toLowerCase()}${(hz.top || []).length ? `. Rated highest here: ${hz.top.slice(0, 3).map(([n, , lab]) => `${esc(n.toLowerCase())} (${(lab || "").toLowerCase()})`).join(", ")}` : ""}.
          ${hz.loss_rate != null ? ` Expected damage averages about ${money(d.offer * hz.loss_rate / 100)} a year at this price.` : ""}</p>` : ""}
        <p class="note">Roof, wiring and foundation condition only come from an inspection.</p>
      </details>

      <details class="sub"><summary>Loan options at ${k(d.offer)}</summary>
        <div class="table-wrap"><table><tr><th>Loan</th><th>Cash up front</th><th>Monthly</th><th>For you</th></tr>${loanRows}</table></div>
        <ul class="note tight">${d.loans.map(l => `<li><b>${esc(l.name)}:</b> ${esc(l.note)}</li>`).join("")}</ul>
        <p class="note">All at ${o.ratePct}% except the 15-year. Get written quotes from 3 lenders. Loans over ${k(Deal.LIMITS.conforming)} are "jumbo" in most counties (${Deal.LIMITS.year}).</p>
      </details>

      <details class="sub"><summary>Step-by-step plan to closing</summary>
        <div class="steps">${STEPS.map(([key, when, what]) => `<label class="note"><input type="checkbox" data-step="${key}" ${done[key] ? "checked" : ""}> <b>${when}:</b> ${what}</label>`).join("")}</div>
        <p class="note">Ticks are saved in this browser.</p>
      </details>
      <p class="note">Estimates from public data, not an appraisal.</p>`;
    $("#dealClose").onclick = closeDeal;
    el.querySelectorAll("[data-step]").forEach(c => c.onchange = () => { (steps[deal.id] = steps[deal.id] || {})[c.dataset.step] = c.checked; saveSteps(); });
  }

  // ---------------------------------------------------------------- buyer's / seller's market
  function renderMarket() {
    const m = rec.market;
    if (!m) { $("#s-market").innerHTML = ""; return; }
    const y = m.year_ago || {};
    hint("h-market", `${m.label || "n/a"}${m.dom ? `, about ${Math.round(m.dom)} days to sell` : ""}`);
    const line = (lab, key, fmt) => m[key] == null ? "" : `<tr><td>${lab}</td><td>${fmt(m[key])}</td><td>${y[key] == null ? "" : fmt(y[key])}</td></tr>`;
    $("#s-market").innerHTML = `<h2>Buyer's or seller's market: ${m.label || "n/a"}</h2>
      <div class="asof">${NAT.asof.market_source || "Redfin"}, ${m.month}${y.label ? `. A year earlier it was: ${y.label.toLowerCase()}` : ""}</div>
      <div class="table-wrap"><table><tr><th></th><th>Now</th><th>A year ago</th></tr>
        ${line("Months of supply (under 4 favours sellers, over 6 favours buyers)", "months_supply", v => v.toFixed(1))}
        ${line("Typical days to go under contract", "dom", v => Math.round(v))}
        ${line("Sale price vs asking", "sale_to_list", v => pct(v * 100, 1))}
        ${line("Sold above asking", "above_list", v => pct(v * 100, 0))}
        ${line("Listings with a price cut", "price_drops", v => pct(v * 100, 0))}
        ${line("Pending sales per active listing (higher favours sellers)", "pending_ratio", v => v.toFixed(2))}
        ${line("Homes sold", "homes_sold", v => Math.round(v))}
        ${line("Homes listed for sale", "inventory", v => Math.round(v))}
        ${line("Median asking price", "median_list", v => k(v))}
      </table></div>
      <p class="note">In a buyer's market you have room to negotiate on price and repairs; in a seller's market expect competing offers.</p>`;
  }

  // ---------------------------------------------------------------- surrounding area
  function ringTable(a, ind) {
    const r = rec.ring;
    if (!r) return "";
    const row = (lab, here, there, fmt) => here == null && there == null ? "" : `<tr><td>${lab}</td><td>${fmt(here)}</td><td>${fmt(there)}</td></tr>`;
    return `<h3>Compared with the area around it</h3>
      <div class="table-wrap"><table><tr><th></th><th>This zip</th><th>Within 5 miles</th></tr>
        ${row("Median household income", a.income, r.income, v => money(v))}
        ${row("Poverty rate", a.poverty, r.poverty, v => pct(v))}
        ${row("College degree+", a.college, r.college, v => pct(v, 0))}
        ${row("Renters", a.renter_share, r.renter_share, v => pct(v, 0))}
        ${row("Yearly price growth, 10 yrs", ind.growth10, r.growth10, v => signed(v))}
        ${row(`${crimeName()} per 100k (county)`, ind.crime, r.crime, v => v == null ? "n/a" : Math.round(v))}
      </table></div>
      <p class="note">Average of the ${r.n} zip${r.n === 1 ? "" : "s"} whose centre is within 5 miles, weighted by population. Crime is only published by county and police force, so it differs here only when nearby zips are in another county.</p>`;
  }

  // ---------------------------------------------------------------- population growth and building
  function renderGrowth() {
    const g = rec.growth, el = $("#s-growth");
    if (!g) { el.innerHTML = ""; hint("h-growth", ""); return; }
    const years = g.pop.map((_, i) => g.start + i), last = g.pop[g.pop.length - 1], r = g.rate;
    const label = r == null ? "n/a" : r < -0.3 ? "Shrinking" : g.pct >= 80 ? "Growing fast" : r > 0.3 ? "Growing" : "Steady";
    const dbl = r > 0.5 ? Math.log(2) / Math.log(1 + r / 100) : null;
    const proj = t => last && r != null ? last * Math.pow(1 + r / 100, t) : null;
    hint("h-growth", `${label}${r != null ? `: population ${signed(r)}/yr` : ""}`);
    el.innerHTML = `<h2>Growth and development: ${label}</h2>
      <div class="asof">Census ACS 5-year estimates ${years[0]}-${years[years.length - 1]} (each is a 5-year average, so the line is smoothed)${g.permits ? `; new homes permitted in ${esc(rec.county || "the county")}, Census Building Permits Survey through ${NAT.asof.permits || ""}` : ""}</div>
      <div class="chart"><canvas id="cPop"></canvas></div>
      <table>
        <tr><td>Population now</td><td>${last ? Math.round(last).toLocaleString() : "n/a"}</td></tr>
        <tr><td>Growth per year (exponential fit)</td><td>${signed(r)}${g.pct != null ? ` <span class="note">(faster than ${g.pct}% of zips)</span>` : ""}</td></tr>
        ${dbl && dbl < 100 ? `<tr><td>Population doubles in</td><td>about ${Math.round(dbl)} years</td></tr>` : ""}
        ${g.urate != null ? `<tr><td>Homes (housing units) growth per year</td><td>${signed(g.urate)}</td></tr>` : ""}
        ${g.pk != null ? `<tr><td>New homes permitted per 1,000 people a year (county, last 3 years)</td><td>${g.pk}${g.pkpct != null ? ` <span class="note">(more than ${g.pkpct}% of counties)</span>` : ""}</td></tr>` : ""}
        ${r != null ? `<tr><td>If the trend continues: population in 5 / 10 years</td><td>about ${(Math.round(proj(5) / 100) * 100).toLocaleString()} / ${(Math.round(proj(10) / 100) * 100).toLocaleString()}</td></tr>` : ""}
      </table>
      ${g.permits ? `<h3>New homes permitted each year (county)</h3><div class="chart"><canvas id="cPermits"></canvas></div>` : ""}
      <p class="note">Fast growth usually means rising demand and more building nearby (traffic, construction, new shops). Homes growing faster than people can mean more supply and softer prices.</p>`;
    makeChart("cPop", { type: "line", data: { labels: years, datasets: [
      { label: "Population", data: g.pop, borderColor: css("--c1"), pointRadius: 2, borderWidth: 2 },
      ...(g.units ? [{ label: "Housing units", data: g.units, borderColor: css("--c2"), pointRadius: 2, borderWidth: 2 }] : [])] },
      options: { scales: { y: { ticks: { callback: v => Math.round(v).toLocaleString() } } } } });
    if (g.permits) makeChart("cPermits", { type: "bar", data: { labels: g.permits.v.map((_, i) => g.permits.start + i),
      datasets: [{ label: "New homes permitted", data: g.permits.v, backgroundColor: css("--c3") }] }, options: { plugins: { legend: { display: false } } } });
  }

  // ---------------------------------------------------------------- natural hazards and the building
  // Notes on a building's age. Shared buildings (condos, apartments) get HOA notes instead of roof notes,
  // and a year of 1900 or earlier is often a placeholder for "unknown" in listing data.
  function ageFlags(year, shared = false) {
    if (!year) return [];
    const f = [];
    if (year <= 1900) return ["Year built shows as 1900 or earlier, which listing data often uses when the year is unknown. Confirm it with the listing agent; if it really is that old, check wiring, plumbing, lead paint and the foundation."];
    if (year < 1940) f.push("Built before 1940: check wiring (knob-and-tube), plumbing and foundation.");
    if (year < 1978) f.push("Built before 1978: lead paint is possible (federal disclosure required).");
    if (year < 1981) f.push("Built before about 1980: asbestos may be in insulation, tiles or siding.");
    if (year >= 1965 && year <= 1973) f.push("1965-1973: aluminium wiring was common; ask an electrician.");
    if (year >= 1978 && year <= 1995) f.push("1978-1995: polybutylene water pipes were used in some homes.");
    const age = new Date().getFullYear() - year;
    if (shared) f.push("Roof, outside walls and structure are usually the HOA's job: ask for its reserve fund and any planned special assessments.");
    else if (age > 20) f.push(`Asphalt-shingle roofs last about 20-30 years. If the roof is original it is ${age} years old, so ask for its age and permits.`);
    return f;
  }
  function renderHazards(o) {
    const h = rec.hazard, yb = rec.acs?.year_built;
    if (!h && !yb) { $("#s-hazards").innerHTML = ""; return; }
    const tp = targetPrice(o);
    hint("h-risk", h ? `${h.label || ""}${(h.top || []).length ? ": " + h.top.slice(0, 2).map(([n]) => esc(n.toLowerCase())).join(", ") : ""}` : yb ? `homes typically built ${yb}` : "");
    const flood = (h?.top || []).some(([n, , lab]) => /flood/i.test(n) && /high/i.test(lab || ""));
    $("#s-hazards").innerHTML = `<h2>Natural hazards and the building</h2>
      ${h ? `<div class="asof">FEMA National Risk Index for the neighbourhoods in this zip</div>
        <p class="verdict">Overall risk: <b>${h.label || "n/a"}</b>${h.risk != null ? ` (${Math.round(h.risk)} of 100, higher than ${Math.round(h.risk)}% of US neighbourhoods)` : ""}.
        ${h.loss_rate != null && tp ? ` Expected yearly damage to buildings here averages ${pct(h.loss_rate, 2)} of their value, about ${money(tp * h.loss_rate / 100)}/yr on the selected home.` : ""}</p>
        <table><tr><th>Hazard</th><th>Score</th><th>Rating</th></tr>
          ${h.top.map(([n, v, lab]) => `<tr><td>${esc(n)}</td><td>${Math.round(v)}</td><td>${lab || ""}</td></tr>`).join("")}</table>
        <p class="note">${flood ? "Flood risk is notable here: regular home insurance doesn't cover floods, so price in flood insurance. " : ""}Check the exact address on <a href="https://msc.fema.gov/portal/search?AddressQuery=${zip}" target="_blank" rel="noopener">FEMA's flood maps</a>.</p>` : ""}
      ${yb ? `<h3>Age of homes here (typical year built: ${yb})</h3><ul class="note">${ageFlags(yb).map(f => `<li>${f}</li>`).join("")}</ul>` : ""}
      <p class="note">Roof age, structure and what a specific house is built from aren't in any public database. A home inspection covers these.</p>`;
  }

  // ---------------------------------------------------------------- sun path, Vaastu and Feng Shui
  const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const DIR_NAMES = { N: "North", NE: "North-east", E: "East", SE: "South-east", S: "South", SW: "South-west", W: "West", NW: "North-west" };
  // ---------------------------------------------------------------- Vaastu and Feng Shui scoring
  // Points for each Vaastu check (traditional guidance). The score is points earned out of the
  // points possible for the checks that are known, so it says how many checks it is based on.
  const VAASTU = {
    facing: { label: "Entrance / facing", max: 25, pts: { N: 25, E: 25, NE: 25, NW: 15, W: 15, S: 8, SE: 8, SW: 0 },
      why: "North, east and north-east entrances are favoured; south-west is avoided." },
    road: { label: "No street pointing at the house (veedhi shoola)", max: 10, why: "A road ending straight at the plot is avoided." },
    kitchen: { label: "Kitchen", max: 15, pts: { SE: 15, NW: 10, E: 5, S: 5, N: 2, W: 2, NE: 0, SW: 0 }, why: "South-east (fire corner) is best, north-west second." },
    bedroom: { label: "Main bedroom", max: 15, pts: { SW: 15, S: 8, W: 8, NW: 4, SE: 2, N: 2, E: 2, NE: 0 }, why: "South-west is best for the main bedroom." },
    puja: { label: "Prayer room", max: 10, pts: { NE: 10, N: 6, E: 6, NW: 2, W: 2, SE: 0, S: 0, SW: 0 }, why: "North-east is the place for prayer." },
    toilet: { label: "No toilet in the north-east", max: 10, why: "Toilets in the north-east corner are avoided." },
    stairs: { label: "Staircase", max: 5, pts: { S: 5, W: 5, SW: 5, SE: 3, NW: 3, N: 1, E: 1, NE: 0 }, why: "Stairs belong in the south, west or south-west." },
    shape: { label: "Plot shape", max: 10, why: "Square or rectangular plots are preferred." },
  };
  const FS_ITEMS = {
    tjunction: "A street ends pointing at the house (T-junction)",
    aligned: "Front door lines up straight with a back door or big back window",
    stairs: "Staircase faces the front door directly",
    bathdoor: "A bathroom is right next to or facing the front door",
    garage: "A bedroom sits over the garage",
    below: "House sits below road level or at the bottom of a slope",
    irregular: "Irregular, L-shaped or missing-corner floor plan",
  };
  // h: { facing, tjunction, rooms: {kitchen, bedroom, puja, toilet ("yes"/"no"), stairs, shape}, fs: {...} }
  function vaastuScore(h) {
    const r = h.rooms || {};
    const got = [], known = [];
    const add = (key, pts) => { known.push(VAASTU[key].max); got.push(pts); };
    if (h.facing) add("facing", VAASTU.facing.pts[h.facing] ?? 0);
    if (h.tjunction !== undefined) add("road", h.tjunction ? 0 : 10);
    for (const key of ["kitchen", "bedroom", "puja", "stairs"]) if (r[key]) add(key, VAASTU[key].pts[r[key]] ?? 0);
    if (r.toilet) add("toilet", r.toilet === "no" ? 10 : 0);
    if (r.shape) add("shape", r.shape === "irregular" ? 0 : 10);
    const max = known.reduce((a, b) => a + b, 0);
    return max ? { pct: Math.round(got.reduce((a, b) => a + b, 0) / max * 100), checks: known.length, of: 8 } : null;
  }
  function fengShui(h) {
    const fs = { ...(h.fs || {}) };
    if (h.tjunction !== undefined) fs.tjunction = !!h.tjunction;
    const answered = Object.keys(fs).filter(kk => fs[kk] !== undefined);
    const concerns = answered.filter(kk => fs[kk]);
    return { concerns, answered: answered.length, pct: answered.length ? Math.round((1 - concerns.length / Object.keys(FS_ITEMS).length) * 100) : null };
  }
  const scorePill = v => v == null ? "" : `<span class="${v >= 70 ? "pill" : "pill warn"}">${v}%</span>`;

  // ---------------------------------------------------------------- commute (OpenStreetMap geocoding + OSRM routing)
  let work = null;
  try { work = JSON.parse(localStorage.getItem("hc-work") || "null"); } catch (e) { /* ignore */ }
  const drive = new Map();                       // "lat,lon" -> minutes (null while unknown)
  const keyOf = (lat, lon) => `${(+lat).toFixed(5)},${(+lon).toFixed(5)}`;
  async function setWork(q) {
    $("#workStatus").textContent = "Looking up the address...";
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (!j.length) { $("#workStatus").textContent = "Couldn't find that address. Try adding the city and state."; return; }
      work = { q, lat: +j[0].lat, lon: +j[0].lon, label: j[0].display_name };
      try { localStorage.setItem("hc-work", JSON.stringify(work)); } catch (e) { /* ignore */ }
      drive.clear();
      showWork(); if (rec) renderAll();
    } catch (e) { $("#workStatus").textContent = "The address lookup service didn't respond; try again in a minute."; }
  }
  function showWork() {
    if (!work) return;
    $("#workAddr").value = work.q;
    $("#workStatus").innerHTML = `Drive times are to: ${esc(work.label)}. <button type="button" class="link" id="workClear">Clear</button>`;
    $("#workClear").onclick = () => { work = null; drive.clear(); try { localStorage.removeItem("hc-work"); } catch (e) { /* ignore */ } $("#workStatus").textContent = ""; $("#workAddr").value = ""; if (rec) renderAll(); };
  }
  // Drive minutes from many points to work in one request (OSRM table service, no traffic).
  async function fetchDrives(points) {
    const todo = points.filter(p => !drive.has(keyOf(p[0], p[1]))).slice(0, 90);
    if (!work || !todo.length) return false;
    todo.forEach(p => drive.set(keyOf(p[0], p[1]), null));
    const coords = [[work.lat, work.lon], ...todo].map(p => `${p[1]},${p[0]}`).join(";");
    try {
      const r = await fetch(`https://router.project-osrm.org/table/v1/driving/${coords}?sources=${todo.map((_, i) => i + 1).join(";")}&destinations=0`);
      const j = await r.json();
      (j.durations || []).forEach((row, i) => drive.set(keyOf(todo[i][0], todo[i][1]), row[0] != null ? Math.round(row[0] / 60) : null));
      return true;
    } catch (e) { todo.forEach(p => drive.set(keyOf(p[0], p[1]), -1)); return true; }
  }
  const driveText = (lat, lon) => { const m = drive.get(keyOf(lat, lon)); return m == null ? "" : m < 0 ? "drive time unavailable" : `${m} min drive to work`; };

  // ---------------------------------------------------------------- shortlist (saved in this browser)
  let shortlist = {};
  try { shortlist = JSON.parse(localStorage.getItem("hc-shortlist") || "{}"); } catch (e) { /* ignore */ }
  const saveShortlist = () => { try { localStorage.setItem("hc-shortlist", JSON.stringify(shortlist)); } catch (e) { /* ignore */ } };
  function toggleShortlist(s) {
    const id = s.id || s.formattedAddress;
    if (shortlist[id]) delete shortlist[id];
    else shortlist[id] = { id, address: s.formattedAddress, zip, price: s.price, url: s.url, lat: s.latitude, lon: s.longitude,
      facing: s.orient?.facing || "", tjunction: s.orient ? !!s.orient.tjunction : undefined, corner: !!s.orient?.corner, rooms: {}, fs: {} };
    saveShortlist();
  }
  function renderShortlist() {
    const el = $("#s-shortlist"), items = Object.values(shortlist);
    const dirSel = (h, key, val) => `<select data-sl="${esc(h.id)}" data-key="${key}"><option value="">Not sure</option>${DIRS.map(d => `<option value="${d}" ${val === d ? "selected" : ""}>${DIR_NAMES[d]}</option>`).join("")}</select>`;
    const yn = (h, key, val, labels) => `<select data-sl="${esc(h.id)}" data-key="${key}"><option value="">Not sure</option>${labels.map(([v, l]) => `<option value="${v}" ${val === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
    el.innerHTML = `<h2>Your shortlist</h2>
      <p class="note">Tap "Shortlist" on any listing to keep it here (saved in this browser only). Fill in the rooms from the listing photos or a visit to get the full Vaastu score.</p>
      ${items.length ? "" : `<p class="note">Nothing shortlisted yet.</p>`}
      <div class="listings">${items.map(h => {
        const v = vaastuScore(h), f = fengShui(h), r = h.rooms || {};
        return `<div class="listing">
          <div class="price">${h.price ? money(h.price) : ""} <button type="button" class="link" data-unlist="${esc(h.id)}">Remove</button>
            ${h.address ? `<button type="button" class="link" data-sdeal="${esc(h.id)}">Deal check</button>` : ""}</div>
          <div>${esc(h.address || "")}</div>
          <div class="note">${h.url ? `<a href="${esc(h.url)}" target="_blank" rel="noopener">Listing</a> &middot; ` : ""}${h.lat ? `<a href="https://www.google.com/maps/@${h.lat},${h.lon},60m/data=!3m1!1e3" target="_blank" rel="noopener">Satellite view</a>` : ""}</div>
          <p style="margin:6px 0">Vaastu ${scorePill(v?.pct)} <span class="note">(${v ? v.checks : 0} of 8 checks)</span> &middot; Feng Shui ${scorePill(f.pct)} <span class="note">(${f.concerns.length} concern${f.concerns.length === 1 ? "" : "s"})</span></p>
          <div class="grid-inputs" style="grid-template-columns:1fr 1fr">
            <label>Faces${dirSel(h, "facing", h.facing)}</label>
            <label>Kitchen${dirSel(h, "kitchen", r.kitchen)}</label>
            <label>Main bedroom${dirSel(h, "bedroom", r.bedroom)}</label>
            <label>Prayer room${dirSel(h, "puja", r.puja)}</label>
            <label>Staircase${dirSel(h, "stairs", r.stairs)}</label>
            <label>Toilet in north-east?${yn(h, "toilet", r.toilet, [["no", "No"], ["yes", "Yes"]])}</label>
            <label>Plot shape${yn(h, "shape", r.shape, [["square", "Square"], ["rect", "Rectangle"], ["irregular", "Irregular / cut corner"]])}</label>
          </div>
          <div class="note" style="margin-top:6px">Feng Shui, tick what applies:</div>
          ${Object.entries(FS_ITEMS).filter(([kk]) => kk !== "tjunction").map(([kk, lab]) => `<label class="note" style="display:block"><input type="checkbox" data-slfs="${esc(h.id)}" data-key="${kk}" ${h.fs?.[kk] ? "checked" : ""}> ${lab}</label>`).join("")}
          ${h.tjunction ? `<div class="note"><b>From the street map:</b> a street ends pointing at this house.</div>` : ""}
          ${f.concerns.length ? `<div class="note">Concerns: ${f.concerns.map(kk => FS_ITEMS[kk].toLowerCase()).join("; ")}.</div>` : ""}
        </div>`; }).join("")}</div>
      ${items.length ? `<details class="sub"><summary>How the scores work</summary>
        <table>${Object.values(VAASTU).map(x => `<tr><td>${x.label} (${x.max} pts)</td><td style="white-space:normal;text-align:left">${x.why}</td></tr>`).join("")}</table>
        <p class="note">The Vaastu score is points earned out of the points possible for the checks you've answered. Feng Shui is the share of the 7 common concerns that don't apply. Personal Feng Shui directions also depend on your birth year (Kua number), which isn't covered. These are traditional guides, kept separate from the price, risk and forecast numbers.</p></details>` : ""}`;
    el.querySelectorAll("[data-sl]").forEach(s => s.onchange = () => {
      const h = shortlist[s.dataset.sl];
      if (s.dataset.key === "facing") h.facing = s.value; else h.rooms[s.dataset.key] = s.value || undefined;
      saveShortlist(); renderShortlist();
    });
    el.querySelectorAll("[data-slfs]").forEach(c => c.onchange = () => { shortlist[c.dataset.slfs].fs[c.dataset.key] = c.checked; saveShortlist(); renderShortlist(); });
    el.querySelectorAll("[data-sdeal]").forEach(b => b.onclick = async () => {
      const h = shortlist[b.dataset.sdeal];
      const s = (liveCache.get(h.zip)?.sale || []).find(x => (x.id || x.formattedAddress) === h.id) ||
        { id: h.id, formattedAddress: h.address, price: h.price, url: h.url, latitude: h.lat, longitude: h.lon };
      openHome(s, h.zip);
    });
    el.querySelectorAll("[data-unlist]").forEach(b => b.onclick = () => { delete shortlist[b.dataset.unlist]; saveShortlist(); renderShortlist(); if (rec) renderListings(inputs()); });
  }

  // ---------------------------------------------------------------- sun path
  function sunTimes(lat, dec) {
    const r = Math.PI / 180, x = Math.sin(dec * r) / Math.cos(lat * r);
    const az = Math.acos(Math.max(-1, Math.min(1, x))) / r;           // sunrise azimuth from north
    const h0 = Math.acos(Math.max(-1, Math.min(1, -Math.tan(lat * r) * Math.tan(dec * r)))) / r;
    return { rise: az, set: 360 - az, noon: 90 - Math.abs(lat - dec), hours: 2 * h0 / 15 };
  }
  const compass = a => DIRS[Math.round(((a % 360) + 360) % 360 / 45) % 8];
  function sunSvg(lat) {
    const cx = 130, cy = 130, pt = (a, rr) => [cx + rr * Math.sin(a * Math.PI / 180), cy - rr * Math.cos(a * Math.PI / 180)];
    const seasons = [["Summer (Jun 21)", 23.44, 100, "--c2"], ["Spring / autumn", 0, 78, "--c1"], ["Winter (Dec 21)", -23.44, 56, "--c3"]];
    let g = `<circle cx="${cx}" cy="${cy}" r="112" fill="none" stroke="${css("--line")}"/>`;
    for (const [d, lab] of [[0, "N"], [90, "E"], [180, "S"], [270, "W"]]) { const [x, y] = pt(d, 122); g += `<text x="${x}" y="${y + 4}" text-anchor="middle" font-size="12" fill="${css("--muted")}">${lab}</text>`; }
    for (const [, dec, rr, col] of seasons) {
      const t = sunTimes(lat, dec), [x1, y1] = pt(t.rise, rr), [x2, y2] = pt(t.set, rr);
      const large = ((t.set - t.rise + 360) % 360) > 180 ? 1 : 0;
      g += `<path d="M ${x1} ${y1} A ${rr} ${rr} 0 ${large} ${lat >= dec ? 1 : 0} ${x2} ${y2}" fill="none" stroke="${css(col)}" stroke-width="3"/>`;
      g += `<circle cx="${x1}" cy="${y1}" r="4" fill="${css(col)}"/><circle cx="${x2}" cy="${y2}" r="4" fill="none" stroke="${css(col)}" stroke-width="2"/>`;
    }
    return `<svg viewBox="0 0 260 260" width="240" height="240" role="img" aria-label="Sun path through the year">${g}</svg>`;
  }
  function renderSun() {
    if (rec.lat == null) { $("#s-sun").innerHTML = ""; return; }
    const lat = rec.lat;
    const t = [["Summer (Jun 21)", sunTimes(lat, 23.44)], ["Spring / autumn", sunTimes(lat, 0)], ["Winter (Dec 21)", sunTimes(lat, -23.44)]];
    $("#s-sun").innerHTML = `<h2>Sun path</h2>
      <div class="asof">For latitude ${lat.toFixed(2)} (centre of this zip)</div>
      <div class="two">
        <div style="text-align:center">${sunSvg(lat)}<div class="note">Filled dot = sunrise, open dot = sunset. Outer arc summer, inner arc winter.</div></div>
        <div><div class="table-wrap"><table><tr><th></th><th>Sunrise</th><th>Sunset</th><th>Noon height</th><th>Daylight</th></tr>
          ${t.map(([lab, x]) => `<tr><td>${lab}</td><td>${compass(x.rise)} (${Math.round(x.rise)}&deg;)</td><td>${compass(x.set)} (${Math.round(x.set)}&deg;)</td><td>${Math.round(x.noon)}&deg;</td><td>${x.hours.toFixed(1)} h</td></tr>`).join("")}
        </table></div>
        <p class="note">In the northern US the sun sits in the southern sky, so south-facing rooms get the most winter light and west-facing rooms the hottest summer afternoons. Each listing's card says what its facing means for light.</p></div>
      </div>`;
  }

  // ---------------------------------------------------------------- houses checked through RentCast property records
  function renderSchools() {
    const sc = rec.schools, nces = `https://nces.ed.gov/ccd/schoolsearch/school_list.asp?Search=1&Zip=${zip}&Miles=5`;
    if (!sc) { $("#s-schools").innerHTML = `<h2>Schools</h2><p class="note">No school data for this zip. <a href="${nces}" target="_blank" rel="noopener">Public schools within 5 miles (NCES)</a>.</p>`; return; }
    const d = sc.district;
    const gradeTag = g => !g ? "" : `<span class="${g >= 6 ? "pill" : "pill warn"}">${g}/10</span>`;
    hint("h-schools", d ? `${esc(nice(d.name))}: scores ${d.n10 ?? "?"}/10 US, ${d.s10 ?? "?"}/10 ${esc(rec.state)}${d.g10 ? `; progress ${d.g10}/10 US, ${d.gs10}/10 ${esc(rec.state)}` : ""}` : "");
    $("#s-schools").innerHTML = `<h2>Schools</h2>
      ${d ? `<p class="verdict">School district: <b>${esc(nice(d.name))}</b> ${gradeTag(d.n10)} nationally${d.s10 ? `, ${gradeTag(d.s10)} within ${esc(rec.state)}` : ""}
        <span class="note">test scores higher than ${Math.round(d.pct)}% of US districts${d.spct != null ? ` and ${Math.round(d.spct)}% of ${esc(rec.state)} districts` : ""}${d.year ? ` (${d.year})` : ""}</span></p>
      ${d.g10 ? `<p class="verdict">Student progress: ${gradeTag(d.g10)} nationally, ${gradeTag(d.gs10)} within ${esc(rec.state)} <span class="note">how much students gain from grade to grade compared with the national average</span></p>` : ""}` : ""}
      <div class="table-wrap"><table><tr><th>Nearest public schools</th><th>Level</th><th>Miles</th><th>Students</th><th>Per teacher</th><th>Math</th><th>Reading</th><th>District score</th></tr>
        ${sc.list.map(x => `<tr><td>${esc(nice(x.name))}${x.charter ? " <span class=\"note\">(charter)</span>" : ""}</td><td>${x.level || ""}</td><td>${x.mi}</td>
          <td>${x.enroll ?? ""}</td><td>${x.ratio ?? ""}</td><td>${x.math != null ? pct(x.math, 0) : ""}</td><td>${x.read != null ? pct(x.read, 0) : ""}</td><td>${gradeTag(x.d10)}</td></tr>`).join("")}
      </table></div>
      <p class="note">Scores rank average test results (Stanford SEDA 2025.1): 10/10 = top 10%. Progress ranks how scores rise from grade 3 to 8. GreatSchools mixes these and more, so its ratings can differ. Math and reading: share proficient on the state test (2018-19). Check which school an address is zoned for with the district. More: <a href="${nces}" target="_blank" rel="noopener">NCES school search</a>.</p>`;
  }


  function renderSources() {
    const a = NAT.asof || {};
    $("#sources").innerHTML = `Data rebuilt ${NAT.built}. Sources: Freddie Mac mortgage rates (${a.rates || ""}), Federal Reserve Bank of New York, Zillow Research (${a.zillow_values || ""}),
      FHFA house price index (through ${a.fhfa || ""}), Census Building Permits Survey, BLS Quarterly Census of Employment and Wages, US Census Bureau ACS (${a.acs || ""}; this product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau), BLS, FEMA National Risk Index,
      ${a.market_source || "Realtor.com"} Economic Research, County Health Rankings &amp; Roadmaps, MIT Election Data and Science Lab, Stanford Education Data Archive, Urban Institute Education Data Portal, NAIC,
      street, place and routing data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> (ODbL) via Overpass, Nominatim and OSRM, county jobs from Census County Business Patterns, listings, recent sales and value estimates (Quantarium, Collateral Analytics, Cotality) from Realtor.com.
      <br>&copy; 2026 Divya Chari. Code licensed under <a href="https://polyformproject.org/licenses/noncommercial/1.0.0/" target="_blank" rel="noopener">PolyForm Noncommercial 1.0.0</a>; see the project's NOTICE for third-party terms.
      Provided as is, for information only: not financial, legal or real estate advice.`;
  }

  // ---------------------------------------------------------------- homes for sale: map + list (the main view)
  // A search (zip, city or county) lands here: homes on a map and as cards, each with a plain verdict
  // (good price / fair / priced high / over budget), what to offer, and its top reasons. The area
  // report and the full deal check open from here.
  let PLACES = null;
  const loadPlaces = () => PLACES || (PLACES = getJSON("data/places.json").then(j => j.rows.map(r => Object.fromEntries(j.cols.map((c, i) => [c, r[i]])))).catch(e => { PLACES = null; throw e; }));
  const norm = t => t.toLowerCase().replace(/^st\.? /, "saint ").replace(/[^a-z ]/g, "").trim();
  let homesCtx = null;                     // { label, st, zips: [place rows], here: Set of zips searched, mode }
  const recs = new Map(), partsCache = new Map();
  const F = { max: null, beds: 0, baths: 0, type: "All", sqft: 0, nearby: false, sort: "best", vaastu: false, shown: 24 };

  function updateBudget() {
    const el = $("#budgetTxt");
    if (!el || !NAT) return;
    const o = inputs(), mp = Calc.maxPrice(o), m = Calc.monthly(mp.price, o);
    el.textContent = `up to ${k(mp.price)}, about ${money(m.total)}/mo with ${k(Calc.downAt(mp.price, o))} down`;
  }
  function placeFromRec(z, r) {
    return { zip: z, city: r.city, state: r.state, county: r.county, lat: r.lat, lon: r.lon, value: r.zhvi_now?.all || r.acs?.home_value,
      rent: r.zori_now || r.acs?.rent, tax: r.acs?.tax_rate, school: r.schools?.district?.n10, growth: r.growth?.rate,
      hazard: r.hazard?.label, market: r.market?.label, fc1: r.fc?.["1"]?.[1], crime: r.ind?.crime };
  }
  async function zipSearch(z) {
    $("#status").textContent = "Loading...";
    let r = null;
    try { r = (await getShard(z.slice(0, 3)))[z]; } catch (e) { /* none */ }
    if (!r) { $("#status").textContent = `No data for ${z}. It may be a PO box or business-only zip.`; return; }
    recs.set(z, r);
    homesCtx = { view: null, label: `${z}${r.city ? " " + r.city : ""}`, st: r.state, zips: [{ ...placeFromRec(z, r), here: true, mi: 0 }], here: new Set([z]), mode: "zip" };
    showHomes(`?zip=${z}`, z);
  }
  async function citySearch(q, st) {
    $("#status").textContent = "Searching...";
    let places;
    try { places = await loadPlaces(); } catch (e) { $("#status").textContent = "City search isn't available yet."; return; }
    const m = q.match(/^(.*?)(?:,\s*([a-z]{2}))?\s*$/i), name = norm(m[1]), wantSt = (st || m[2] || "").toUpperCase();
    const isCounty = /\b(county|parish|borough)$/.test(name);
    let hits = isCounty ? places.filter(p => norm(p.county || "") === name) : places.filter(p => norm(p.city) === name);
    if (!hits.length && !isCounty) hits = places.filter(p => norm(p.city).startsWith(name));
    if (wantSt) hits = hits.filter(p => p.state === wantSt);
    const states = [...new Set(hits.map(p => p.state))];
    if (!hits.length) { $("#status").textContent = `Nothing found for "${q}". Try a city, county, zip, or a full street address.`; return; }
    if (states.length > 1) {
      $("#status").innerHTML = `Which one? ${states.sort().map(x => `<button type="button" class="link" data-st="${x}">${esc(isCounty ? hits.find(p => p.state === x).county : hits.find(p => p.state === x).city)}, ${x}</button>`).join(" &middot; ")}`;
      $("#status").querySelectorAll("[data-st]").forEach(b => b.onclick = () => citySearch(q.replace(/,.*$/, ""), b.dataset.st));
      return;
    }
    const lat = hits.reduce((a, p) => a + p.lat, 0) / hits.length, lon = hits.reduce((a, p) => a + p.lon, 0) / hits.length;
    const mi = p => 69 * Math.hypot(p.lat - lat, (p.lon - lon) * Math.cos(lat * Math.PI / 180));
    const here = new Set(hits.map(p => p.zip));
    const zips = places.filter(p => here.has(p.zip) || mi(p) <= 10).map(p => ({ ...p, mi: mi(p), here: here.has(p.zip) }));
    const label = isCounty ? hits[0].county : hits[0].city;
    homesCtx = { view: null, label, st: states[0], zips, here, mode: isCounty ? "county" : "city" };
    showHomes(`?city=${encodeURIComponent(`${label}, ${states[0]}`)}`, `${label}, ${states[0]}`);
  }
  async function houseSearch(q) {
    if (!API) { $("#status").textContent = "House lookup isn't set up for this site."; return; }
    $("#status").textContent = "Looking up the house...";
    try {
      const a = addressFrom(q), r = await fetch(`${API}/api/listings?address=${encodeURIComponent(a)}&v=2`), j = await r.json();
      if (!r.ok || !j.home?.zip) throw new Error("not found");
      fullCache.set(j.home.id, j.home);
      await zipSearch(j.home.zip);
      openHome(j.home, j.home.zip);
    } catch (e) { $("#status").textContent = "Couldn't find that house. Try the full address with city, state and zip, or paste the listing link."; }
  }
  function showHomes(url, remember) {
    F.shown = 24; F.bounds = null; lastFit = "";
    document.body.classList.add("searched");
    $("#status").textContent = "";
    $("#results").hidden = true;
    $("#v-homes").hidden = false;
    history.replaceState(null, "", url);
    try { localStorage.setItem("hc-search", remember); } catch (e) { /* ignore */ }
    renderHomes();
    renderCompare();
    renderShortlist();
  }
  // Cities inside a county search, biggest first.
  function cityCounts() {
    const n = {};
    homesCtx.zips.filter(p => p.here).forEach(p => { n[p.city] = (n[p.city] || 0) + 1; });
    return Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 12);
  }
  function homeZips() {
    if (homesCtx.view) return homesCtx.view;            // the zips the map is showing, once you've moved it
    // a big city or county has many zips: start with the 12 nearest its centre (move the map for more)
    const zs = homesCtx.zips.filter(p => p.here).sort((a, b) => a.mi - b.mi).slice(0, 12);
    if (F.nearby) zs.push(...homesCtx.zips.filter(p => !p.here).sort((a, b) => a.mi - b.mi).slice(0, 12));
    return zs;
  }
  let homesTimer = null;
  function homesChanged(z) {
    if (!homesCtx || $("#v-homes").hidden || !(homesCtx.zips.some(p => p.zip === z) || (homesCtx.view || []).some(p => p.zip === z))) return;
    clearTimeout(homesTimer); homesTimer = setTimeout(renderHomes, 300);
  }

  // Everything one card needs: verdict, offer, reasons, score.
  function judge(h, o, ranks) {
    const s = h.s, r = recs.get(h.p.zip), L = liveCache.get(h.p.zip);
    let d = null;
    if (r && L) {
      if (!partsCache.has(h.p.zip) || partsCache.get(h.p.zip).L !== L) {
        const hist = priceHistory(r);
        partsCache.set(h.p.zip, { L, hist, ...Deal.zipParts(L.sold, r.zhvi_recent, hist) });
      }
      const pc = partsCache.get(h.p.zip);
      try { d = Deal.analyze(s, { sold: L.sold || [], active: L.sale, monthly: r.zhvi_recent, yearly: pc.hist, rec: r, o: h.o, maxPrice: h.max, comp: pc.comp, bt: pc.bt }); } catch (e) { d = null; }
    }
    const near = s.near, nz = s.noise, mins = work && s.latitude ? drive.get(keyOf(s.latitude, s.longitude)) : null;
    const vs = vaastuScore({ facing: s.orient?.facing, tjunction: s.orient ? !!s.orient.tjunction : undefined });
    const parts = { space: ranks.space(s.squareFootage), value: d && Number.isFinite(d.gap) ? clamp100(50 - d.gap * 4) : null,
      school: h.p.school ? h.p.school * 10 : null,
      shop: near?.grocery?.m != null ? clamp100(100 - (near.grocery.m - 300) / 17) : null,
      walk: near ? Math.round(WALK.filter(([kk]) => near[kk]?.n > 0).length / WALK.length * 100) : null,
      commute: mins != null && mins >= 0 ? clamp100(100 - (mins - 10) * 2) : null,
      quiet: nz ? clamp100(100 - (nz.highway_m != null && nz.highway_m < 300 ? 40 : 0) - (nz.rail_m != null && nz.rail_m < 250 ? 30 : 0) - (nz.airport_km != null && nz.airport_km < 5 ? 30 : 0)) : null,
      vaastu: vs ? vs.pct : null };
    const score = blend(parts, new Set([...lOn, "school"]));
    const gap = d?.gap;
    const verdict = !h.fits ? ["over", "Over budget"] : !Number.isFinite(gap) ? ["none", "No estimate"]
      : gap <= -5 ? ["good", "Good price"] : gap <= 8 ? ["fair", "Fair price"] : ["high", "Priced high"];
    const why = [];                                  // [good?, text], best first
    if (Number.isFinite(gap) && Math.abs(gap) >= 3) why.push([gap < 0, `${Math.abs(gap).toFixed(0)}% ${gap < 0 ? "below" : "above"} its value estimate`]);
    if (!h.fits) why.push([false, `${k(s.price - h.max)} over your budget`]);
    if (d?.stale) why.push([true, `Listed ${s.daysOnMarket} days: room to negotiate`]);
    else if (s.daysOnMarket != null && s.daysOnMarket <= 7) why.push([null, "Just listed"]);
    if (d?.bad.length) why.push([false, d.bad[0][0].toUpperCase() + d.bad[0].slice(1)]);
    if (d?.flip) why.push([false, "Likely flipped: check the work"]);
    if (d?.good.length) why.push([true, d.good[0][0].toUpperCase() + d.good[0].slice(1)]);
    if (parts.space >= 80) why.push([true, "Roomy for the area"]);
    if (parts.school >= 80) why.push([true, `Schools ${h.p.school}/10`]);
    if (parts.commute >= 80) why.push([true, `${mins} min to work`]);
    if (s.hoa > 400) why.push([false, `HOA ${money(s.hoa)}/mo`]);
    if (["high", "very high"].includes(crimeLevel(h.p.crime))) why.push([false, `${crimeLevel(h.p.crime)[0].toUpperCase() + crimeLevel(h.p.crime).slice(1)} crime in the county`]);
    return { d, parts, score, verdict, why: why.slice(0, 3), mins };
  }

  function renderHomes() {
    if (!homesCtx) return;
    updateBudget();
    const o = inputs(), zs = homeZips();
    // load what's missing: zip records (for value history) and live listings
    zs.forEach(p => {
      if (!recs.has(p.zip)) getShard(p.zip.slice(0, 3)).then(sh => { if (sh[p.zip]) { recs.set(p.zip, sh[p.zip]); homesChanged(p.zip); } }).catch(() => {});
      if (API && !liveCache.has(p.zip) && !["loading", "failed"].includes(liveState.get(p.zip))) loadLive(p.zip);
    });
    const loading = zs.filter(p => API && !liveCache.has(p.zip) && liveState.get(p.zip) !== "failed").length;
    const homes = [];
    for (const p of zs) {
      const L = liveCache.get(p.zip);
      if (!L) continue;
      const st = STATES[p.state] || {}, ins = st.home_ins ? st.home_ins / 4000 : 0.5, tax = Math.max(p.tax || 1.1, p.state === "CA" ? 1.1 : 0);
      for (const s of L.sale) {
        if (!s.price || s.propertyType === "Land") continue;
        const oz = { ...o, taxRate: tax, insRate: ins, closingPct: (st.closing_fees ?? 1) + 1 + ins + tax / 4, hoa: s.hoa || 0 };
        const max = Calc.maxPrice(oz).price;
        homes.push({ s, p, o: oz, max, fits: s.price <= max, pay: Calc.monthly(s.price, oz).total });
      }
    }
    const seen = new Set();
    for (let i = homes.length - 1; i >= 0; i--) {
      const s = homes[i].s, key = [s.price, s.squareFootage, s.bedrooms, s.bathrooms, (+s.latitude).toFixed(3), (+s.longitude).toFixed(3)].join("|");
      if (seen.has(key)) homes.splice(i, 1); else seen.add(key);
    }
    const budget = Math.round(Calc.maxPrice(o).price / 5000) * 5000, cap = F.max ?? budget;
    const typeOf = s => LISTING_GROUPS[s.propertyType] || s.propertyType || "Other";
    const passes = h => (F.beds === -1 ? h.s.bedrooms === 0 : (h.s.bedrooms ?? 0) >= F.beds) && (h.s.bathrooms ?? 0) >= F.baths && (!F.sqft || (h.s.squareFootage ?? 0) >= F.sqft)
      && (F.type === "All" || typeOf(h.s) === F.type) && (!F.vaastu || ["N", "E", "NE"].includes(h.s.orient?.facing));
    const inMap = h => !F.bounds || (h.s.latitude && F.bounds.contains([h.s.longitude, h.s.latitude]));
    let shown = homes.filter(h => h.s.price <= cap && passes(h) && inMap(h)), noneInBudget = false;
    if (!shown.length && F.max == null && homes.length) { shown = homes.filter(h => passes(h) && inMap(h)); noneInBudget = true; }
    const ranks = { space: rankPct(shown.map(h => h.s.squareFootage)) };
    if (work) fetchDrives(shown.filter(h => h.s.latitude).map(h => [h.s.latitude, h.s.longitude])).then(ch => { if (ch) homesChanged(zs[0]?.zip); });
    for (const h of shown) h.j = judge(h, o, ranks);
    const bonus = { good: 12, fair: 4, none: 0, high: -12, over: -40 };
    const sorters = { best: (a, b) => (b.j.score ?? 50) + bonus[b.j.verdict[0]] - ((a.j.score ?? 50) + bonus[a.j.verdict[0]]),
      low: (a, b) => a.s.price - b.s.price, high: (a, b) => b.s.price - a.s.price,
      new: (a, b) => (a.s.daysOnMarket ?? 1e9) - (b.s.daysOnMarket ?? 1e9), big: (a, b) => (b.s.squareFootage || 0) - (a.s.squareFootage || 0),
      small: (a, b) => (a.s.squareFootage || 1e9) - (b.s.squareFootage || 1e9) };
    shown.sort(noneInBudget && F.sort === "best" ? sorters.low : sorters[F.sort] || sorters.best);

    // one line about the area
    const here = homesCtx.view || homesCtx.zips.filter(p => p.here), medOf = key => median(here.map(p => p[key]).filter(Number.isFinite));
    const hz = here.map(p => p.hazard).filter(Boolean), mk = here.map(p => p.market).filter(Boolean);
    const mode = a => a.sort((x, y) => a.filter(v => v === y).length - a.filter(v => v === x).length)[0];
    $("#areaStrip").innerHTML = `<h2>${homesCtx.view ? "Homes in the map area" : `${esc(homesCtx.label)}${homesCtx.mode !== "zip" ? `, ${homesCtx.st}` : ""}`}</h2>
      <div class="facts">
        ${Number.isFinite(medOf("value")) ? `<span>Typical home <b>${k(medOf("value"))}</b></span>` : ""}
        ${mk.length ? `<span>${esc(mode(mk))}</span>` : ""}
        ${Number.isFinite(medOf("school")) ? `<span>Schools <b>${Math.round(medOf("school"))}/10</b></span>` : ""}
        ${hz.length ? `<span>Disaster risk <b>${esc(mode(hz).replace("Relatively ", "").toLowerCase())}</b></span>` : ""}
        ${Number.isFinite(medOf("growth")) ? `<span>Population <b>${signed(medOf("growth"))}/yr</b></span>` : ""}
        ${Number.isFinite(medOf("crime")) ? `<span title="${crimeName()} per 100,000 people a year, county level">Crime <b>${crimeLevel(medOf("crime"))}</b> (${medOf("crime").toFixed(1)} ${crimeName().toLowerCase()} per 100k, county)</span>` : ""}
      </div>
      ${homesCtx.mode === "county" && !homesCtx.view ? `<div class="row">Cities in ${esc(homesCtx.label)}: ${cityCounts().map(([c, n]) => `<button type="button" class="chipbtn" data-city="${esc(c)}">${esc(c)} (${n} zip${n > 1 ? "s" : ""})</button>`).join("")}</div>` : ""}
      ${(() => { const zs = homeZips().filter(p => p.here || homesCtx.view);
        return zs.length === 1 ? `<button type="button" class="chipbtn" id="reportOne">Area report for ${zs[0].zip}</button>`
          : `<label class="note">Area report: <select id="reportPick"><option value="">pick a zip code</option>${zs.map(p => `<option value="${p.zip}">${p.zip} ${esc(p.city || "")}</option>`).join("")}</select></label>`; })()}`;
    if ($("#reportOne")) $("#reportOne").onclick = () => openReport(homeZips()[0].zip);
    if ($("#reportPick")) $("#reportPick").onchange = e => { if (e.target.value) openReport(e.target.value); };
    $("#areaStrip").querySelectorAll("[data-city]").forEach(b => b.onclick = () => { $("#zip").value = `${b.dataset.city}, ${homesCtx.st}`; citySearch(b.dataset.city, homesCtx.st); });

    const types = ["All", ...new Set(homes.map(h => typeOf(h.s)))];
    const sel = (id, opts, v) => `<select id="${id}">${opts.map(([val, lab]) => `<option value="${val}" ${String(val) === String(v) ? "selected" : ""}>${lab}</option>`).join("")}</select>`;
    $("#filters").innerHTML = `<div class="row filters">
        ${sel("fMax", [...new Map([...[50, 100, 200, 300, 400, 500, 600, 750, 1000, 1500, 2500, 5000].map(v => [v * 1000, `Up to ${k(v * 1000)}`]),
          [budget, `Up to ${k(budget)} (your budget)`]].sort((a, b) => a[0] - b[0]).map(x => [x[0], x])).values()].concat([[1e12, "$5M and up"]]), cap)}
        ${sel("fBeds", [[0, "Any beds"], [-1, "Studio"], [1, "1+ beds"], [2, "2+ beds"], [3, "3+ beds"], [4, "4+ beds"], [5, "5+ beds"]], F.beds)}
        ${sel("fBaths", [[0, "Any baths"], [1, "1+ baths"], [2, "2+ baths"], [3, "3+ baths"], [4, "4+ baths"]], F.baths)}
        ${sel("fType", types.map(t => [t, t === "All" ? "All types" : t]), F.type)}
        ${sel("fSort", [["best", "Best match"], ["low", "Lowest price"], ["high", "Highest price"], ["new", "Newest"], ["big", "Largest"], ["small", "Smallest"]], F.sort)}
      </div>
      <details class="sub"><summary>More filters</summary>
        <div class="row filters" style="margin-top:6px">
          ${sel("fSqft", [[0, "Any size"], ...[500, 750, 1000, 1250, 1500, 1750, 2000, 2500, 3000, 3500, 4000].map(v => [v, `${v.toLocaleString()}+ sq ft`])], F.sqft)}
          <label class="note"><input type="checkbox" id="fVaastu" ${F.vaastu ? "checked" : ""}> Vaastu facing only (N, E, NE)</label>
          ${homesCtx.mode !== "zip" ? `<label class="note"><input type="checkbox" id="fNear" ${F.nearby ? "checked" : ""}> Include nearby towns</label>` : ""}
        </div>
        ${factorChips(LFACT, lOn, "fFact")}
        ${work ? "" : `<p class="note">Add your work address under "Your budget" to rank by commute.</p>`}
      </details>
      <p class="note legend"><span style="color:#1f9d6b">&#9679;</span> good price <span style="color:#2f6fb5">&#9679;</span> fair <span style="color:#c4622d">&#9679;</span> priced high <span style="color:#9a9a9a">&#9679;</span> over budget or no estimate</p>
      <p class="verdict">${loading ? `<span class="note">Loading homes for ${loading} zip code${loading > 1 ? "s" : ""} (5-30 s the first time)... </span>` : ""}
        ${homesCtx.tooWide ? `<span class="note">Showing the ${homesCtx.view.length} zip codes nearest the map's centre; zoom in to see the rest. </span>` : ""}
        ${loading && !homes.length ? "" : noneInBudget ? `Nothing within your budget of ${k(budget)} here. Cheapest homes shown.` : `<b>${shown.length}</b> home${shown.length === 1 ? "" : "s"}${shown.length ? ", best matches first" : ". Try fewer filters or a higher price"}.`}</p>`;
    const on = (id, f) => { const x = $("#" + id); if (x) x.onchange = e => { f(e.target); F.shown = 24; renderHomes(); }; };
    on("fMax", t => { F.max = Number(t.value) === budget ? null : Number(t.value); }); on("fBeds", t => { F.beds = Number(t.value); });
    on("fBaths", t => { F.baths = Number(t.value); }); on("fType", t => { F.type = t.value; }); on("fSort", t => { F.sort = t.value; });
    on("fSqft", t => { F.sqft = Number(t.value); }); on("fVaastu", t => { F.vaastu = t.checked; }); on("fNear", t => { F.nearby = t.checked; });
    $("#filters").querySelectorAll("#fFact [data-f]").forEach(b => b.onclick = () => { const f = b.dataset.f; lOn.has(f) ? lOn.delete(f) : lOn.add(f); saveSet("hc-lfact", lOn); renderHomes(); });

    $("#homeList").innerHTML = shown.slice(0, F.shown).map(h => {
      const s = h.s, id = esc(s.id || s.formattedAddress), j = h.j, saved = shortlist[s.id || s.formattedAddress];
      return `<article class="home" data-id="${id}">
        <div class="photo">${s.photo ? `${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">` : ""}<img src="${esc(s.photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">${s.url ? "</a>" : ""}<span class="credit">Photo: Realtor.com</span>` : ""}
          <span class="sign ${j.verdict[0]}">${j.verdict[1]}</span></div>
        <div class="body">
          <div class="headrow"><span class="price">${money(s.price)}</span></div>
          <div>${[s.bedrooms != null ? `${s.bedrooms} bd` : "", s.bathrooms ? `${s.bathrooms} ba` : "", s.squareFootage ? `${s.squareFootage.toLocaleString()} sq ft` : "", esc(typeOf(s))].filter(Boolean).join(" &middot; ")}</div>
          <div class="note">${esc((s.formattedAddress || "").replace(/, [A-Z]{2},? \d{5}$/, ""))}${s.daysOnMarket != null ? ` &middot; ${s.daysOnMarket} day${s.daysOnMarket === 1 ? "" : "s"} on market` : ""}</div>
          ${j.d && h.fits ? `<div class="offer">Offer around <b>${k(Math.min(j.d.opening, j.d.walk))}</b> &middot; ${money(h.pay)}/mo</div>` : `<div class="note">${money(h.pay)}/mo</div>`}
          ${s.orient?.facing ? `<div class="vaastu">Faces ${DIR_NAMES[s.orient.facing].toLowerCase()} &middot; ${facingRatingText(s.orient.facing)} in Vaastu${s.orient.tjunction ? " &middot; street points at it" : ""}</div>`
            : liveCache.get(h.p.zip)?.mapState === "loading" ? `<div class="vaastu muted">Checking which way it faces...</div>` : ""}
          <ul class="why">${j.why.map(([g, t]) => `<li class="${g === true ? "pro" : g === false ? "con" : ""}">${esc(t)}</li>`).join("")}</ul>
          <div class="row"><button type="button" data-open="${id}" data-zip="${h.p.zip}">Details and offer</button>
            <button type="button" class="link" data-save="${id}" data-zip="${h.p.zip}">${saved ? "&#9829; Saved" : "&#9825; Save"}</button></div>
        </div></article>`;
    }).join("") + (shown.length > F.shown ? `<button type="button" class="link" id="fMore">Show more (${shown.length - F.shown} left)</button>` : "");
    const find = (zz, id) => (liveCache.get(zz)?.sale || []).find(x => (x.id || x.formattedAddress) === id);
    $("#homeList").querySelectorAll("[data-open]").forEach(b => b.onclick = () => { const s = find(b.dataset.zip, b.dataset.open); if (s) openHome(s, b.dataset.zip); });
    $("#homeList").querySelectorAll("[data-save]").forEach(b => b.onclick = () => { const s = find(b.dataset.zip, b.dataset.save); if (s) { zip = b.dataset.zip; toggleShortlist(s); renderHomes(); renderShortlist(); } });
    if ($("#fMore")) $("#fMore").onclick = () => { F.shown += 24; renderHomes(); };
    drawMap(shown);
  }

  // ---------------------------------------------------------------- the map (MapLibre + OpenFreeMap tiles, no key needed)
  let map = null, mapReady = false, pendingMap = null;
  function drawMap(shown) {
    if (!window.maplibregl) { $("#mapBox").hidden = true; return; }
    const COL = { good: "#1f9d6b", fair: "#2f6fb5", none: "#7a7f7c", high: "#c4622d", over: "#9a9a9a" };
    const fc = { type: "FeatureCollection", features: shown.filter(h => h.s.latitude).map(h => ({ type: "Feature",
      geometry: { type: "Point", coordinates: [h.s.longitude, h.s.latitude] },
      properties: { id: h.s.id || h.s.formattedAddress, zip: h.p.zip, label: k(h.s.price).replace(",000", "k").replace(/\$(\d+)\.(\d)\dM/, "$$$1.$2M"), color: COL[h.j.verdict[0]] } })) };
    pendingMap = fc;
    if (!map) {
      map = new maplibregl.Map({ container: "map", style: "https://tiles.openfreemap.org/styles/positron", attributionControl: { compact: true },
        center: [homesCtx.zips[0].lon, homesCtx.zips[0].lat], zoom: 11 });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => {
        map.addSource("homes", { type: "geojson", data: pendingMap });
        map.addLayer({ id: "homes-dot", type: "circle", source: "homes", paint: { "circle-radius": 6, "circle-color": ["get", "color"], "circle-stroke-width": 1.5, "circle-stroke-color": "#fff" } });
        map.addLayer({ id: "homes-label", type: "symbol", source: "homes", minzoom: 12.5,
          layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, -1.2], "text-font": ["Noto Sans Bold"], "text-allow-overlap": false },
          paint: { "text-color": ["get", "color"], "text-halo-color": "#fff", "text-halo-width": 1.5 } });
        map.on("click", "homes-dot", e => {
          const f = e.features[0].properties, s = (liveCache.get(f.zip)?.sale || []).find(x => (x.id || x.formattedAddress) === f.id);
          if (s) openHome(s, f.zip);
        });
        map.on("mouseenter", "homes-dot", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "homes-dot", () => { map.getCanvas().style.cursor = ""; });
        map.on("moveend", e => { if (e.originalEvent) onMapMove(); });
        mapReady = true; fitMap(pendingMap);
      });
    } else if (mapReady) {
      map.getSource("homes").setData(fc);
      fitMap(fc);
    }
  }
  // Moving the map searches the area it shows (up to the 15 zip codes nearest its centre).
  async function onMapMove() {
    if (!$("#mapFollow").checked || !homesCtx) return;
    const b = map.getBounds(), c = map.getCenter();
    let places;
    try { places = await loadPlaces(); } catch (e) { return; }
    const inView = places.filter(p => b.contains([p.lon, p.lat])).map(p => ({ ...p, here: homesCtx.here.has(p.zip),
      mi: 69 * Math.hypot(p.lat - c.lat, (p.lon - c.lng) * Math.cos(c.lat * Math.PI / 180)) })).sort((x, y) => x.mi - y.mi);
    if (!inView.length) return;
    homesCtx.view = inView.slice(0, 15); homesCtx.tooWide = inView.length > 15;
    F.bounds = b; F.shown = 24;
    renderHomes();
  }
  let lastFit = "";
  function fitMap(fc) {
    if (F.bounds) return;                                    // you're steering the map; don't jump
    const key = homesCtx.label + homeZips().map(p => p.zip).join();
    if (key === lastFit || !fc.features.length) return;     // only re-centre when the place changes
    lastFit = key;
    const b = new maplibregl.LngLatBounds();
    fc.features.forEach(f => b.extend(f.geometry.coordinates));
    map.fitBounds(b, { padding: 40, maxZoom: 14, duration: 0 });
  }

  // ---------------------------------------------------------------- one home in detail (sheet over the page)
  async function openHome(s, z) {
    let r = recs.get(z);
    if (!r) { try { r = (await getShard(z.slice(0, 3)))[z]; recs.set(z, r); } catch (e) { /* none */ } }
    if (!r) return;
    zip = z; rec = r; listing = liveCache.get(z) || null;
    target = { type: rec.zhvi_now?.all ? "all" : "custom", custom: rec.zhvi_now?.all ? null : rec.acs?.home_value || 300000 };
    openDeal(s);
  }

  // ---------------------------------------------------------------- compare the zips of a city (folded under the homes)
  let zSort = "best";
  function renderCompare() {
    const el = $("#compareWrap");
    if (!homesCtx || homesCtx.mode === "zip") { el.innerHTML = ""; return; }
    const base = inputs(), list = homesCtx.zips.map(p => ({ ...p }));
    list.forEach(p => {
      const s = STATES[p.state] || {}, ins = s.home_ins ? s.home_ins / 4000 : 0.5, tax = Math.max(p.tax || 1.1, p.state === "CA" ? 1.1 : 0);
      p.max = Calc.maxPrice({ ...base, taxRate: tax, insRate: ins, closingPct: (s.closing_fees ?? 1) + 1 + ins + tax / 4 }).price;
      p.fits = !!(p.value && p.value <= p.max);
    });
    const fit = list.filter(p => p.fits);
    const safeR = rankPct(fit.map(p => -(p.crime ?? NaN))), growR = rankPct(fit.map(p => p.growth ?? NaN)),
      outR = rankPct(fit.map(p => p.fc1 ?? NaN)), roomR = rankPct(fit.map(p => (p.max - p.value) / p.max));
    list.forEach(p => {
      if (!p.fits) { p.score = null; return; }
      const mins = work ? drive.get(keyOf(p.lat, p.lon)) : null;
      p.score = blend({ school: p.school ? p.school * 10 : null, safety: safeR(-(p.crime ?? NaN)), risk: HAZ[p.hazard] ?? null,
        growth: growR(p.growth ?? NaN), outlook: outR(p.fc1 ?? NaN), room: roomR((p.max - p.value) / p.max),
        commute: mins != null && mins >= 0 ? clamp100(100 - (mins - 10) * 2) : null }, zOn);
    });
    const sorters = { best: (a, b) => (b.fits - a.fits) || ((b.score ?? -1) - (a.score ?? -1)), value: (a, b) => (a.value || 9e9) - (b.value || 9e9),
      school: (a, b) => (b.school || 0) - (a.school || 0), near: (a, b) => a.mi - b.mi };
    list.sort(sorters[zSort]);
    const open = el.querySelector("details")?.open;
    el.innerHTML = `<details class="sub panel" ${open ? "open" : ""}><summary>Compare the ${list.length} zip codes in and around ${esc(homesCtx.label)}</summary>
      ${factorChips(ZFACT, zOn, "zfact")}
      <div class="row"><label class="note">Sort <select id="zSort">${[["best", "Best overall (in budget)"], ["value", "Cheapest"], ["school", "Best schools"], ["near", "Closest"]].map(([v, l]) => `<option value="${v}" ${v === zSort ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
      <div class="table-wrap"><table><tr><th>Zip</th><th>City, county</th><th>Score</th><th>Typical home</th><th>In budget?</th><th>Schools</th><th>Growth</th><th>Disaster risk</th><th>Miles</th></tr>
        ${list.map(p => `<tr data-zip="${p.zip}"${p.here ? ' class="best"' : ""}><td><b>${p.zip}</b></td><td>${esc(p.city)}${p.county ? `, <span class="note">${esc(p.county)}</span>` : ""}</td>
          <td>${p.score ?? ""}</td><td>${p.value ? k(p.value) : "n/a"}</td><td>${p.fits ? '<span class="pill">Yes</span>' : `<span class="pill warn">max ${k(p.max)}</span>`}</td>
          <td>${p.school ? p.school + "/10" : ""}</td><td>${p.growth != null ? signed(p.growth) : ""}</td><td>${esc(p.hazard || "")}</td><td>${p.mi.toFixed(1)}</td></tr>`).join("")}
      </table></div><p class="note">Tap a row to see that zip's homes. Highlighted rows are in ${esc(homesCtx.label)}.</p></details>`;
    $("#zSort").onchange = e => { zSort = e.target.value; renderCompare(); };
    el.querySelectorAll("#zfact [data-f]").forEach(b => b.onclick = () => { const f = b.dataset.f; zOn.has(f) ? zOn.delete(f) : zOn.add(f); saveSet("hc-zfact", zOn); renderCompare(); });
    el.querySelectorAll("tr[data-zip]").forEach(tr => tr.onclick = () => { $("#zip").value = tr.dataset.zip; zipSearch(tr.dataset.zip); window.scrollTo(0, 0); });
  }

  // ---------------------------------------------------------------- suggestions while typing a place
  let NAMES = null;
  async function suggest(v) {
    let places;
    try { places = await loadPlaces(); } catch (e) { return; }
    if (!NAMES) {                                   // every "City, ST" and "County, ST", with how many zips each has
      const n = new Map();
      for (const p of places) for (const nm of [p.city, p.county]) if (nm && p.state) { const key = `${nm}, ${p.state}`; n.set(key, (n.get(key) || 0) + 1); }
      NAMES = [...n.entries()].map(([name, c]) => ({ name, c, key: norm(name) })).sort((a, b) => b.c - a.c);
    }
    const q = norm(v.replace(/,.*$/, "")), st = (v.match(/,\s*([a-z]{1,2})$/i) || [])[1]?.toUpperCase();
    if (q.length < 2) return;
    const hits = NAMES.filter(x => x.key.startsWith(q) && (!st || x.name.endsWith(", " + st) || x.name.split(", ")[1].startsWith(st))).slice(0, 8);
    $("#placeList").innerHTML = hits.map(x => `<option value="${esc(x.name)}"></option>`).join("");
    if (NAMES.some(x => x.name === v.trim())) lookup();   // picked from the list
  }

  // ---------------------------------------------------------------- events
  $("#workSet").addEventListener("click", () => { const q = $("#workAddr").value.trim(); if (q) setWork(q); });
  $("#workAddr").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); const q = e.target.value.trim(); if (q) setWork(q); } });
  showWork();
  $("#lookup").addEventListener("submit", e => { e.preventDefault(); saveInputs(); lookup(); });
  $("#mapFollow").addEventListener("change", e => { if (e.target.checked) onMapMove(); else { F.bounds = null; if (homesCtx) homesCtx.view = null; lastFit = ""; renderHomes(); } });
  document.querySelectorAll(".examples .ex").forEach(b => b.onclick = () => { $("#zip").value = b.dataset.q; lookup(); });
  // Start loading as soon as the first 3 digits are typed; open the zip automatically at 5 digits.
  $("#zip").addEventListener("input", e => {
    const v = e.target.value.trim();
    if (/^\d{3,5}$/.test(v)) getShard(v.slice(0, 3)).catch(() => {});
    if (/^\d{5}$/.test(v) && !(homesCtx?.mode === "zip" && homesCtx.zips[0].zip === v)) lookup();
    if (/^[a-z]/i.test(v)) suggest(v);                  // a city or county name: show matching places
  });
  let typingTimer = null;
  function refresh() {
    updateBudget();
    if (!$("#v-homes").hidden && homesCtx) { renderHomes(); renderCompare(); }
    else if (!$("#results").hidden && rec) renderAll();
    if (deal) renderDeal(inputs());
  }
  const liveUpdate = () => { clearTimeout(typingTimer); typingTimer = setTimeout(() => { saveInputs(); refresh(); }, 350); };
  $("#purpose").addEventListener("change", () => { saveInputs(); refresh(); });
  $("#backHomes").addEventListener("click", () => { if (homesCtx) { $("#results").hidden = true; $("#v-homes").hidden = false; renderHomes(); window.scrollTo(0, 0); } else { $("#zip").value = zip; zipSearch(zip); } });
  $("#dealModal").addEventListener("click", e => { if (e.target.id === "dealModal") closeDeal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && deal) closeDeal(); });
  document.querySelectorAll("[data-k]").forEach(el => { el.addEventListener("input", liveUpdate); el.addEventListener("change", liveUpdate); });
  $("#resetInputs").addEventListener("click", () => {
    try { localStorage.removeItem("hc-inputs"); } catch (e) { /* ignore */ }
    loadInputs(); refresh();
  });
  // Turn the folded sections into tabs: one section showing at a time, picked from a row of buttons.
  (function makeTabs() {
    const groups = [...document.querySelectorAll("details.group")], nav = $("#tabs");
    if (!nav || !groups.length) return;
    const SHORT = { "g-cost": "Costs", "g-future": "Prices", "g-market": "Market", "g-purpose": "Your plan", "g-hood": "Neighbourhood",
      "g-growth": "Growth", "g-schools": "Schools", "g-risk": "Risks", "g-law": "Law", "g-sun": "Sun" };
    let cur = null;
    try { cur = localStorage.getItem("hc-tab"); } catch (e) { /* ignore */ }
    if (!groups.some(g => g.id === cur)) cur = groups[0].id;
    nav.innerHTML = groups.map(g => `<button type="button" data-tab="${g.id}">${SHORT[g.id] || g.querySelector("summary").firstChild.textContent}</button>`).join("");
    const show = id => {
      cur = id;
      groups.forEach(g => { g.open = true; g.classList.toggle("on", g.id === id); });
      nav.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.tab === id));
      try { localStorage.setItem("hc-tab", id); } catch (e) { /* ignore */ }
      window.dispatchEvent(new Event("resize"));            // let charts size themselves
    };
    nav.querySelectorAll("button").forEach(b => b.onclick = () => show(b.dataset.tab));
    document.body.classList.add("tabbed");
    show(cur);
  })();
  init();
})();
