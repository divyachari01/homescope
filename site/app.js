// HomeScope page logic. Data files come from pipeline/build_data.py.
(() => {
  const $ = s => document.querySelector(s);
  const DEFAULTS = {
    income: 100000, debts: 300, cash: 60000, save: 1500, rent0: 1500, downPct: 20, years: 30, rate: "",
    housingShare: 28, dtiCap: 36, taxRate: "", insRate: 0.5, pmiRate: 0.5, maintRate: 1, closingPct: 3,
    sellPct: 6, hoa: "", incomeGrowth: 3, invReturn: 5, rateShift: 0, H: 10, invPremium: 0.75, invDown: 25,
    vacancy: 5, mgmt: 8, hackRent: "", strNightly: 150, strOcc: 55, strFees: 25,
  };
  const TYPES = [
    ["all", "Typical home (all types)"], ["sfr", "House (single-family)"], ["condo", "Condo / apartment"],
    ["bottom", "Starter home (cheaper third)"], ["top", "Upper-end home (priciest third)"], ["custom", "My own price"],
  ];
  const LISTING_GROUPS = {
    "Single Family": "House", "Condo": "Condo / apartment", "Townhouse": "Townhouse",
    "Multi-Family": "2-4 unit building", "Apartment": "Apartment building (5+)", "Manufactured": "Manufactured",
    "Land": "Land",
  };

  let NAT = null, STATES = {}, LISTED = [], INSPECTED = {};
  let rec = null, zip = "", target = { type: "all", custom: null }, listing = null, listFilter = "All", listSort = "price";
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
    for (const [key, def] of Object.entries(DEFAULTS)) if (o[key] === null || Number.isNaN(o[key])) o[key] = def === "" ? null : def;
    o.ratePct = o.rate ?? currentRate(o.years);
    o.taxRate = o.taxRate ?? (rec?.acs?.tax_rate || 1.1);
    o.hoaAuto = o.hoa === null;
    o.hoa = o.hoa ?? autoHoa();
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
  const utilities = () => rec?.util ? (rec.util.electric || 0) + (rec.util.gas || 0) : 0;

  function currentRate(years) {
    if (!NAT) return 6.5;
    if (Number(years) === 15 && NAT.rate15_latest) return NAT.rate15_latest.value;
    return NAT.rate30_latest.value;
  }

  // ---------------------------------------------------------------- data access
  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }
  async function init() {
    loadInputs();
    try {
      [NAT, STATES] = await Promise.all([getJSON("data/national.json"), getJSON("data/states.json")]);
      LISTED = await getJSON("data/listings/index.json").catch(() => []);
      INSPECTED = await getJSON("data/listings/properties.json").catch(() => ({}));
    } catch (e) {
      $("#status").textContent = "Data files are missing. Run the build (see README) and reload.";
      return;
    }
    $("#rateHint").textContent = `(blank = ${NAT.rate30_latest.value}% from ${NAT.rate30_latest.date})`;
    renderSources();
    const q = new URLSearchParams(location.search).get("zip");
    let last = null;
    try { last = localStorage.getItem("hc-zip"); } catch (e) { /* ignore */ }
    if (q || last) { $("#zip").value = q || last; lookup(); }
  }

  async function lookup() {
    zip = $("#zip").value.trim();
    if (!/^\d{5}$/.test(zip)) { $("#status").textContent = "Enter a 5-digit zip code."; return; }
    $("#status").textContent = "Loading...";
    try {
      const shard = await getJSON(`data/zips/${zip.slice(0, 3)}.json`);
      rec = shard[zip];
    } catch (e) { rec = null; }
    if (!rec) { $("#results").hidden = true; $("#status").textContent = `No data for ${zip}. It may be a PO box or business-only zip.`; return; }
    listing = LISTED.includes(zip) ? await getJSON(`data/listings/${zip}.json`).catch(() => null) : null;
    try { localStorage.setItem("hc-zip", zip); } catch (e) { /* ignore */ }
    history.replaceState(null, "", `?zip=${zip}`);
    target = { type: rec.zhvi_now?.all ? "all" : "custom", custom: rec.zhvi_now?.all ? null : rec.acs?.home_value || 300000 };
    $("#status").textContent = "";
    $("#results").hidden = false;
    renderAll();
  }

  // Yearly dollar price history. FHFA's index goes back to 1975 but has no dollar level, so it is
  // scaled to match Zillow's value in the latest year both have, then Zillow continues after that.
  function priceHistory() {
    const toMap = s => { const m = new Map(); if (s) s.v.forEach((v, i) => { if (v != null) m.set(s.start + i, v); }); return m; };
    const z = toMap(rec.zhvi && (rec.zhvi.sfr || rec.zhvi.all)), h = toMap(rec.hpi);
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
  const typicalRent = () => rec.zori_now || rec.acs?.rent || null;
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
    renderHead();
    renderSummary(o);
    renderMarket();
    renderPrices();
    renderBuying(o);
    renderTiming(o);
    renderPurpose(o);
    renderHood();
    renderHazards(o);
    renderLaw();
    renderSun();
    renderListings(o);
    renderInspected();
    renderSchools();
  }

  function renderHead() {
    const place = [rec.city, rec.county, rec.state].filter(Boolean).join(", ");
    $("#s-head").innerHTML = `<h2>${zip}${place ? " &middot; " + esc(place) : ""}</h2>
      <div class="asof">${rec.metro ? esc(rec.metro) + " metro &middot; " : ""}Each section notes how recent its data is.</div>`;
  }

  function card(label, value, sub, pill) {
    return `<div class="card"><div class="k">${label}</div><div class="v">${value}</div>
      <div class="s">${sub || ""}</div>${pill ? `<div style="margin-top:6px">${pill}</div>` : ""}</div>`;
  }
  const pctSub = (p, text) => Number.isFinite(p) ? `${text} ${ord(Math.round(p))} of US zips` : "";

  function renderSummary(o) {
    const out = [];
    const now = rec.zhvi_now?.all, rr = rec.zhvi_recent?.v || [];
    const yoy = rr.length > 12 && rr[rr.length - 13] ? (rr[rr.length - 1] / rr[rr.length - 13] - 1) * 100 : NaN;
    if (now) out.push(card("Typical home value", k(now), `${signed(yoy)} over the last year`));
    else if (rec.acs?.home_value) out.push(card("Median home value", k(rec.acs.home_value), "Census estimate (Zillow has no value here)"));
    const mp = Calc.maxPrice(o);
    const tp = targetPrice(o);
    out.push(card("You can afford up to", k(mp.price), `at ${o.ratePct}% &middot; limited by your ${mp.limitedBy}`,
      tp ? (mp.price >= tp ? `<span class="pill">Covers the ${TYPES.find(t => t[0] === target.type)[1].toLowerCase()}</span>`
                          : `<span class="pill warn">${k(tp - mp.price)} short of the selected home</span>`) : ""));
    const ind = rec.ind || {}, p = rec.pct || {};
    if (ind.price_to_income) out.push(card("Price to income", ind.price_to_income.toFixed(1) + "x",
      pctSub(p.price_to_income, "Homes cost more relative to income than") || "home value / median income"));
    const rent = typicalRent();
    if (rent) out.push(card("Typical rent", money(rent) + "/mo",
      ind.rent_yield ? `Yearly rent is ${pct(ind.rent_yield)} of home value (${ord(Math.round(p.rent_yield || 0))} pct)` : (rec.zori_now ? "" : "Census median rent")));
    if (rec.acs?.income) out.push(card("Median household income", money(rec.acs.income),
      Number.isFinite(ind.income_change) ? `${signed(ind.income_change)} in 10 yrs after inflation` : ""));
    if (rec.acs?.renter_share != null) out.push(card("Renters", pct(rec.acs.renter_share, 0) + " of homes",
      `${pct(rec.acs.rent_vacancy)} of rentals sit empty`));
    if (ind.crime != null) out.push(card("Violent crime (county)", Math.round(ind.crime) + " per 100k", pctSub(p.crime, "Higher than")));
    const car = STATES[rec.state]?.car_insurance;
    if (car) out.push(card("Car insurance (state avg)", money(car) + "/yr", `About ${money(car / 12)}/mo per car, NAIC 2024`));
    const v = rec.votes, sv = STATES[rec.state]?.votes;
    if (v || sv) {
      const src = v || sv, i = src.years.length - 1, m = src.rep[i] - src.dem[i];
      out.push(card(`${src.years[i]} president (${v ? "county" : "state"})`, `${m > 0 ? "R" : "D"} +${Math.abs(m).toFixed(0)}`,
        `R ${src.rep[i]}% &middot; D ${src.dem[i]}%` + (v && sv ? ` &middot; state ${sv.rep[sv.rep.length - 1] > sv.dem[sv.dem.length - 1] ? "R" : "D"} +${Math.abs(sv.rep[sv.rep.length - 1] - sv.dem[sv.dem.length - 1]).toFixed(0)}` : "")));
    }
    const lean = lawLean(STATES[rec.state]?.law);
    if (lean) out.push(card("Landlord-tenant law", lean.label, esc(STATES[rec.state].name)));
    if (rec.gent) out.push(card("Neighborhood change", rec.gent.replace("Signs of gentrification", "Gentrifying"), "10-year Census comparison"));
    $("#s-summary").innerHTML = out.join("");
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
      const m = Calc.monthly(tp, { ...o, downPct: dp }), cash = tp * (dp + o.closingPct) / 100;
      const share = m.total / (o.income / 12) * 100, dti = (m.total + o.debts) / (o.income / 12) * 100;
      const ok = cash <= o.cash && share <= o.housingShare && dti <= o.dtiCap;
      const why = cash > o.cash ? "Cash short" : share > o.housingShare || dti > o.dtiCap ? "Payment too high" : "Yes";
      return { dp, m, cash, share, ok, why };
    });
    const row = (label, f) => `<tr><td>${label}</td>${cols.map(c => `<td${c.dp === o.downPct ? ' style="font-weight:650"' : ""}>${f(c)}</td>`).join("")}</tr>`;
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
      <p class="note">Over any 12 months since 1971, the 30-year rate moved by a full point or more ${pct(moves.shareOver1pt, 0)} of the time. In 8 of 10 such years the change was between ${signed(moves.p10, 1).replace("%", "")} and ${signed(moves.p90, 1).replace("%", "")} points.</p>
      <div class="two">
        <div>
          <h3>If rates move</h3>
          <div class="table-wrap"><table><tr><th>Rate</th><th>Max you can buy</th><th>Payment on selected home</th></tr>${rows}</table></div>
          <p class="note">Each 1-point rise in rates cuts your buying power by about ${k(perPoint)} (when income is the limit).</p>
          <h3>Down payment options</h3>
          ${downTable(tp, o)}
        </div>
        <div>
          <h3>Monthly cost of a home</h3>
          <div class="row"><select id="targetType">${sel}</select>
            <input id="customPrice" type="number" step="5000" style="width:9em" value="${target.type === "custom" ? target.custom || "" : Math.round(tp)}" ${target.type === "custom" ? "" : "hidden"}></div>
          <table style="margin-top:8px">
            <tr><td>Price</td><td>${money(tp)}</td></tr>
            <tr><td>Down payment (${o.downPct}%) + closing</td><td>${money(m.down + tp * o.closingPct / 100)}</td></tr>
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
          <p class="note">Property tax is about ${money(m.tax * 12)} a year. The rate ${rec.acs?.tax_rate && !Number(document.querySelector('[data-k="taxRate"]').value) ? "is what owners in this zip actually pay vs their home values (Census), so state, county and city taxes and local assessment practice are all included" : "is your setting"}.
          ${o.hoaAuto && o.hoa ? ` HOA is the typical condo fee in this zip's current listings.` : ""}${o.hoaAuto && !o.hoa && target.type === "condo" ? " Condo HOA fees aren't known for this zip; enter one under More assumptions." : ""}
          Water and trash aren't included (no national data).</p>
        </div>
      </div>`;
    const start = NAT.rate30.start.split("-").map(Number);
    const labels = rates.map((_, i) => { const mm = start[1] - 1 + i; return `${start[0] + Math.floor(mm / 12)}-${String(mm % 12 + 1).padStart(2, "0")}`; });
    makeChart("cRates", { type: "line", data: { labels,
      datasets: [{ label: "30-year mortgage rate", data: rates, borderColor: css("--c2"), pointRadius: 0, borderWidth: 1.5 },
        ...(NAT.fed ? [{ label: "Fed funds rate", data: alignMonthly(NAT.fed, labels), borderColor: css("--c3"), pointRadius: 0, borderWidth: 1.5 }] : [])] },
      options: { scales: { x: { ticks: { maxTicksLimit: 10, callback: function (v) { return this.getLabelForValue(v).slice(0, 4); } } },
        y: { ticks: { callback: v => v + "%" } } }, plugins: { legend: { display: !!NAT.fed } } } });
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
    const sim = { ...o, price0: tp, rate0: o.ratePct };
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
      verdict = `Best timing for the selected home: <b>${best.k === 0 ? "now" : "in " + best.k + " year" + (best.k > 1 ? "s" : "") + " (" + (yr + best.k) + ")"}</b>. ` +
        `After ${o.H} years that leaves you about ${k(Math.abs(gap))} ${gap >= 0 ? "ahead of" : "behind"} renting the whole time (likely scenario). ` +
        (best.low.netWorth < rentOnly.low.netWorth ? `In the low scenario, renting would come out ahead.` : `It still beats renting in the low scenario.`);
    }
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
      <p class="note">${fc ? `Low / likely / high use the model's 5-year forecast: ${signed(scen.low * 100)}, ${signed(scen.mid * 100)}, ${signed(scen.high * 100)} a year, carried on after year 5. ` : ""}How it works: each plan spends the same each month (your rent now plus what you save). Whatever isn't spent on housing earns ${o.invReturn}%/yr. Rates drift by your "rate change over next 5 years" setting (${o.rateShift >= 0 ? "+" : ""}${o.rateShift} pts). Net worth counts savings plus home equity after ${o.sellPct}% selling costs. Rent grows ${o.rentGrowth.toFixed(1)}%/yr.</p>`;
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
      <p class="note">Low and high are the model's 10th and 90th percentile: the price change should land between them about 8 times in 10.</p>
      <details class="sub"><summary>How well did it predict 2022 to ${yr}?</summary>
        <p class="note">Each row pretends it's the start year, trains only on what was known then, predicts, and compares with what actually happened across all zips. Error is the average miss in percentage points per year. "Trend only" just extends each zip's own 10-year trend.
        ${beat.length ? `The model beat the trend-only guess in ${wins} of ${beat.length} completed tests.` : ""}</p>
        <div class="table-wrap"><table><tr><th>Period</th><th>Horizon</th><th>Model error</th><th>Trend-only error</th><th>Inside range</th></tr>${bt}</table></div>
        ${mine ? `<h3>This zip, 1 year ahead</h3><div class="table-wrap"><table><tr><th>Year</th><th>Predicted range</th><th>Likely</th><th>Actual</th><th>Inside?</th></tr>${mine}</table></div>` : ""}
      </details>
      ${M.drivers ? `<details class="sub"><summary>What drives the forecast</summary><p class="note">How much the 5-year forecast gets worse when each input is scrambled, as a share of the total. Bigger means the model leans on it more.</p>
        <table>${M.drivers.map(([n, v]) => `<tr><td>${esc(n)}</td><td>${pct(v, 0)}</td></tr>`).join("")}</table></details>` : ""}`;
  }

  // ---------------------------------------------------------------- purpose-specific numbers
  function investorOpts(o) {
    return { ...o, downPct: o.invDown, ratePct: o.ratePct + o.invPremium };
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
        ${car ? `<tr><td>Car insurance, state average per car</td><td>${money(car / 12)}</td></tr>` : ""}
        ${rent ? `<tr><td>Typical rent in this zip</td><td>${money(rent)}</td></tr>
        <tr><td>Owning costs ${own > rent ? "more" : "less"} than renting by</td><td>${money(Math.abs(own - rent))}/mo</td></tr>` : ""}</table>
        <p class="note">Part of each mortgage payment is savings (principal), which renting doesn't give you. The best-time table above weighs both sides.</p>`;
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
        <p class="note">Living in one unit of a 2-4 unit building lets you use owner-occupant loans (lower rates, FHA from 3.5% down) instead of investor loans. In listings, look at "2-4 unit building". Renting a room or basement can need a permit, so check the city's rules.</p>`;
    }
    $("#s-purpose").innerHTML = html;
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
          ${ind.crime != null ? `<tr><td>Violent crime per 100k (county)</td><td>${Math.round(ind.crime)}</td><td></td></tr>` : ""}
          ${STATES[rec.state]?.car_insurance ? `<tr><td>Car insurance per car (state avg, 2024)</td><td>${money(STATES[rec.state].car_insurance)}/yr</td><td></td></tr>` : ""}
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
      <p class="note">How the label is set: tenant-leaning if the state has rent control or just-cause eviction rules (plus long notice periods); landlord-leaning if cities are banned from rent control, there's no just-cause rule and the unpaid-rent notice is 5 days or less. Cities can add their own rules where the state allows.
      Full state eviction-law profile: <a href="https://lawatlas.org/datasets/state-eviction-laws" target="_blank" rel="noopener">LSC / LawAtlas eviction laws database</a>.</p>`;
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

  // ---------------------------------------------------------------- listings
  function median(a) { return Calc.percentile(a, 50); }
  function renderListings(o) {
    const el = $("#s-listings");
    if (!listing) {
      el.innerHTML = `<h2>Listings</h2><p class="note">Live listings are pulled weekly for the zips in <code>watchlist.txt</code> (up to 5 on RentCast's free plan). To add ${zip}, put it on its own line in that file on GitHub and run the workflow.
        Meanwhile: <a href="https://www.zillow.com/homes/${zip}_rb/" target="_blank" rel="noopener">browse ${zip} on Zillow</a>.</p>`;
      return;
    }
    const mode = $("#purpose").value, maxP = Calc.maxPrice(o).price;
    const sale = listing.sale || [], rentals = listing.rent || [];
    const rentByBeds = {};
    rentals.forEach(r => { if (r.price && r.bedrooms != null) (rentByBeds[r.bedrooms] = rentByBeds[r.bedrooms] || []).push(r.price); });
    const prices = sale.map(s => s.price).filter(Boolean);
    const t1 = Calc.percentile(prices, 33.3), t2 = Calc.percentile(prices, 66.7);
    const groups = ["All", ...new Set(sale.map(s => LISTING_GROUPS[s.propertyType] || s.propertyType || "Other"))];
    const rows = sale.filter(s => s.price).map(s => {
      const group = LISTING_GROUPS[s.propertyType] || s.propertyType || "Other";
      const tier = s.price <= t1 ? "Lower third" : s.price <= t2 ? "Middle third" : "Upper third";
      const oo = { ...o, hoa: s.hoa || o.hoa };
      const pay = Calc.monthly(s.price, oo).total;
      const estRent = rentByBeds[s.bedrooms]?.length >= 3 ? median(rentByBeds[s.bedrooms]) : typicalRent();
      const inv = estRent ? Calc.rental(s.price, estRent, investorOpts(oo)) : null;
      return { s, group, tier, pay, estRent, inv, fits: s.price <= maxP };
    }).filter(r => listFilter === "All" || r.group === listFilter);
    const sorters = { price: (a, b) => a.s.price - b.s.price, cash: (a, b) => (b.inv?.cashFlow ?? -1e9) - (a.inv?.cashFlow ?? -1e9),
      fit: (a, b) => (b.fits - a.fits) || a.s.price - b.s.price, newest: (a, b) => (a.s.daysOnMarket ?? 1e9) - (b.s.daysOnMarket ?? 1e9) };
    rows.sort(sorters[listSort] || sorters.price);
    const beds = Object.keys(rentByBeds).sort((a, b) => a - b).map(b => `<tr><td>${b == 0 ? "Studio" : b + " bed"}</td><td>${rentByBeds[b].length}</td><td>${money(median(rentByBeds[b]))}</td></tr>`).join("");
    el.innerHTML = `
      <h2>Listings in ${zip}</h2>
      <div class="asof">RentCast, fetched ${listing.fetched}: ${sale.length} for sale, ${rentals.length} for rent</div>
      <div class="chips" id="chips">${groups.map(g => `<button type="button" class="${g === listFilter ? "on" : ""}" data-g="${esc(g)}">${esc(g)}</button>`).join("")}</div>
      <div class="row"><label class="note">Sort <select id="listSort">
        ${[["fit", "Within my budget first"], ["price", "Price"], ["cash", "Rental cash flow"], ["newest", "Newest"]].map(([v, l]) => `<option value="${v}" ${v === listSort ? "selected" : ""}>${l}</option>`).join("")}
      </select></label></div>
      <div class="listings">${rows.slice(0, 60).map(r => `<div class="listing">
        <div class="price">${money(r.s.price)} ${r.fits ? '<span class="pill">In budget</span>' : ""}</div>
        <div>${esc(r.s.formattedAddress || "")}</div>
        <div class="note">${esc(r.group)} &middot; ${r.tier}${r.s.squareFootage >= 5000 ? " &middot; Large (5,000+ sq ft)" : ""}</div>
        <div class="note">${r.s.bedrooms ?? "?"} bd &middot; ${r.s.bathrooms ?? "?"} ba${r.s.squareFootage ? ` &middot; ${r.s.squareFootage.toLocaleString()} sq ft` : ""}${r.s.yearBuilt ? ` &middot; built ${r.s.yearBuilt}` : ""}${r.s.daysOnMarket != null ? ` &middot; ${r.s.daysOnMarket} days listed` : ""}</div>
        <div>Owner cost ${money(r.pay)}/mo${r.s.hoa ? ` (incl. HOA ${money(r.s.hoa)})` : ""}</div>
        ${r.s.latitude ? `<div class="note"><a href="https://www.google.com/maps/@${r.s.latitude},${r.s.longitude},60m/data=!3m1!1e3" target="_blank" rel="noopener">Satellite view</a> (to check which way it faces)</div>` : ""}
        ${mode !== "live" && r.inv ? `<div class="note">If rented at ~${money(r.estRent)}: cash flow ${money(r.inv.cashFlow)}/mo, cap rate ${pct(r.inv.capRate, 1)}</div>` : ""}
      </div>`).join("")}</div>
      ${rows.length > 60 ? `<p class="note">Showing 60 of ${rows.length}.</p>` : ""}
      ${beds ? `<h3>Rentals listed now</h3><table><tr><th>Size</th><th>Listings</th><th>Median rent</th></tr>${beds}</table>` : ""}`;
    el.querySelectorAll("#chips button").forEach(b => b.onclick = () => { listFilter = b.dataset.g; renderListings(inputs()); });
    $("#listSort").onchange = e => { listSort = e.target.value; renderListings(inputs()); };
  }

  // ---------------------------------------------------------------- buyer's / seller's market
  function renderMarket() {
    const m = rec.market;
    if (!m) { $("#s-market").innerHTML = ""; return; }
    const y = m.year_ago || {};
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
        ${row("Violent crime per 100k (county)", ind.crime, r.crime, v => v == null ? "n/a" : Math.round(v))}
      </table></div>
      <p class="note">Average of the ${r.n} zip${r.n === 1 ? "" : "s"} whose centre is within 5 miles, weighted by population. Crime is only published by county and police force, so it differs here only when nearby zips are in another county.</p>`;
  }

  // ---------------------------------------------------------------- natural hazards and the building
  function ageFlags(year) {
    if (!year) return [];
    const f = [];
    if (year < 1940) f.push("Built before 1940: check wiring (knob-and-tube), plumbing and foundation.");
    if (year < 1978) f.push("Built before 1978: lead paint is possible (federal disclosure required).");
    if (year < 1981) f.push("Built before about 1980: asbestos may be in insulation, tiles or siding.");
    if (year >= 1965 && year <= 1973) f.push("1965-1973: aluminium wiring was common; ask an electrician.");
    if (year >= 1978 && year <= 1995) f.push("1978-1995: polybutylene water pipes were used in some homes.");
    const age = new Date().getFullYear() - year;
    if (age > 20) f.push(`Asphalt-shingle roofs last about 20-30 years. If the roof is original it is ${age} years old, so ask for its age and permits.`);
    return f;
  }
  function renderHazards(o) {
    const h = rec.hazard, yb = rec.acs?.year_built;
    if (!h && !yb) { $("#s-hazards").innerHTML = ""; return; }
    const tp = targetPrice(o);
    const flood = (h?.top || []).some(([n, , lab]) => /flood/i.test(n) && /high/i.test(lab || ""));
    $("#s-hazards").innerHTML = `<h2>Natural hazards and the building</h2>
      ${h ? `<div class="asof">FEMA National Risk Index for the neighbourhoods in this zip</div>
        <p class="verdict">Overall risk: <b>${h.label || "n/a"}</b>${h.risk != null ? ` (${Math.round(h.risk)} of 100, higher than ${Math.round(h.risk)}% of US neighbourhoods)` : ""}.
        ${h.loss_rate != null && tp ? ` Expected yearly damage to buildings here averages ${pct(h.loss_rate, 2)} of their value, about ${money(tp * h.loss_rate / 100)}/yr on the selected home.` : ""}</p>
        <table><tr><th>Hazard</th><th>Score</th><th>Rating</th></tr>
          ${h.top.map(([n, v, lab]) => `<tr><td>${esc(n)}</td><td>${Math.round(v)}</td><td>${lab || ""}</td></tr>`).join("")}</table>
        <p class="note">${flood ? "Flood risk is notable here: regular home insurance doesn't cover floods, so price in flood insurance. " : ""}Check the exact address on <a href="https://msc.fema.gov/portal/search?AddressQuery=${zip}" target="_blank" rel="noopener">FEMA's flood maps</a>.</p>` : ""}
      ${yb ? `<h3>Age of homes here (typical year built: ${yb})</h3><ul class="note">${ageFlags(yb).map(f => `<li>${f}</li>`).join("")}</ul>` : ""}
      <p class="note">Roof age, structure and what a specific house is built from aren't in any public database. An inspection covers these, and the "Houses you're checking" section below shows what RentCast has on record for addresses you add.</p>`;
  }

  // ---------------------------------------------------------------- sun path, Vaastu and Feng Shui
  const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const DIR_NAMES = { N: "North", NE: "North-east", E: "East", SE: "South-east", S: "South", SW: "South-west", W: "West", NW: "North-west" };
  let sunInputs = { facing: "", kitchen: "", bedroom: "", prayer: "", shape: "", fs: {} };
  try { sunInputs = Object.assign(sunInputs, JSON.parse(localStorage.getItem("hc-sun") || "{}")); } catch (e) { /* ignore */ }
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
      const through = lat >= dec ? 180 : 0, large = ((t.set - t.rise + 360) % 360) > 180 ? 1 : 0;
      g += `<path d="M ${x1} ${y1} A ${rr} ${rr} 0 ${large} ${through === 180 ? 1 : 0} ${x2} ${y2}" fill="none" stroke="${css(col)}" stroke-width="3"/>`;
      g += `<circle cx="${x1}" cy="${y1}" r="4" fill="${css(col)}"/><circle cx="${x2}" cy="${y2}" r="4" fill="none" stroke="${css(col)}" stroke-width="2"/>`;
    }
    return `<svg viewBox="0 0 260 260" width="240" height="240" role="img" aria-label="Sun path through the year">${g}</svg>`;
  }
  function vaastu(si) {
    const out = [];
    if (si.facing) out.push(["Entrance / facing", ["N", "E", "NE"].includes(si.facing) ? "good" : si.facing === "SW" ? "poor" : ["S", "SE"].includes(si.facing) ? "mixed" : "ok",
      ["N", "E", "NE"].includes(si.facing) ? `${DIR_NAMES[si.facing]}-facing is the most favoured in Vaastu.` : si.facing === "SW" ? "South-west-facing is traditionally the least favoured." : `${DIR_NAMES[si.facing]}-facing is acceptable; Vaastu puts more weight on where the door sits along that side.`]);
    if (si.kitchen) out.push(["Kitchen", si.kitchen === "SE" ? "good" : si.kitchen === "NW" ? "ok" : ["NE", "SW"].includes(si.kitchen) ? "poor" : "mixed", "Vaastu places the kitchen in the south-east (fire corner), with north-west as the alternative; north-east and south-west are avoided."]);
    if (si.bedroom) out.push(["Main bedroom", si.bedroom === "SW" ? "good" : ["S", "W"].includes(si.bedroom) ? "ok" : si.bedroom === "NE" ? "poor" : "mixed", "The main bedroom is placed in the south-west for stability."]);
    if (si.prayer) out.push(["Prayer room", si.prayer === "NE" ? "good" : ["N", "E"].includes(si.prayer) ? "ok" : "mixed", "The prayer room belongs in the north-east."]);
    if (si.shape) out.push(["Plot shape", si.shape === "square" || si.shape === "rect" ? "good" : "poor", "Square or rectangular plots are preferred; cut or irregular corners (especially north-east) are avoided."]);
    return out;
  }
  const FS_ITEMS = {
    aligned: "Front door lines up straight with a back door or big back window",
    tjunction: "House sits at the end of a T-junction or a straight road points at it",
    stairs: "Staircase faces the front door directly",
    bathdoor: "A bathroom is right next to or facing the front door",
    garage: "A bedroom sits over the garage",
    below: "House sits below road level or at the bottom of a slope",
    irregular: "Irregular, L-shaped or missing-corner floor plan",
  };
  function renderSun() {
    if (rec.lat == null) { $("#s-sun").innerHTML = ""; return; }
    const lat = rec.lat, si = sunInputs;
    const t = [["Summer (Jun 21)", sunTimes(lat, 23.44)], ["Spring / autumn", sunTimes(lat, 0)], ["Winter (Dec 21)", sunTimes(lat, -23.44)]];
    const opt = (key, extra = "") => `<select data-sun="${key}"><option value="">Not sure</option>${DIRS.map(d => `<option value="${d}" ${si[key] === d ? "selected" : ""}>${DIR_NAMES[d]}</option>`).join("")}${extra}</select>`;
    const facingLight = si.facing ? {
      N: "The front gets little direct sun; the back garden gets the most.", S: "The front gets sun most of the day, strongest in winter.",
      E: "The front gets morning sun; the back gets the afternoon.", W: "The front gets afternoon and evening sun, which is hot in summer.",
      NE: "The front gets early morning sun only.", NW: "The front gets late-evening sun in summer.", SE: "The front gets morning and midday sun.", SW: "The front gets the hot afternoon sun.",
    }[si.facing] : "";
    const vs = vaastu(si), fsHits = Object.keys(FS_ITEMS).filter(kk => si.fs[kk]);
    const tag = v => v === "good" ? '<span class="pill">Good</span>' : v === "poor" ? '<span class="pill warn">Avoid</span>' : v === "mixed" ? '<span class="pill warn">Not ideal</span>' : '<span class="pill">OK</span>';
    $("#s-sun").innerHTML = `<h2>Sun, Vaastu and Feng Shui</h2>
      <div class="asof">Sun path for latitude ${lat.toFixed(2)} (centre of this zip)</div>
      <div class="two">
        <div style="text-align:center">${sunSvg(lat)}<div class="note">Filled dot = sunrise, open dot = sunset. Outer arc summer, inner arc winter.</div></div>
        <div class="table-wrap"><table><tr><th></th><th>Sunrise</th><th>Sunset</th><th>Noon height</th><th>Daylight</th></tr>
          ${t.map(([lab, x]) => `<tr><td>${lab}</td><td>${compass(x.rise)} (${Math.round(x.rise)}&deg;)</td><td>${compass(x.set)} (${Math.round(x.set)}&deg;)</td><td>${Math.round(x.noon)}&deg;</td><td>${x.hours.toFixed(1)} h</td></tr>`).join("")}
        </table></div>
      </div>
      <h3>Check a house</h3>
      <p class="note">Listings don't say which way a house faces. Use the satellite link on a listing to see which way the front door faces, then fill these in.</p>
      <div class="grid-inputs">
        <label>House faces (front door side)${opt("facing")}</label>
        <label>Kitchen is in the${opt("kitchen")}</label>
        <label>Main bedroom is in the${opt("bedroom")}</label>
        <label>Prayer room is in the${opt("prayer")}</label>
        <label>Plot shape<select data-sun="shape"><option value="">Not sure</option>
          ${[["square", "Square"], ["rect", "Rectangle"], ["irregular", "Irregular / cut corner"]].map(([v, l]) => `<option value="${v}" ${si.shape === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      ${facingLight ? `<p class="note"><b>Sunlight:</b> ${facingLight}</p>` : ""}
      ${vs.length ? `<h3>Vaastu</h3><table>${vs.map(([lab, v, txt]) => `<tr><td>${lab}</td><td style="white-space:normal;text-align:left">${tag(v)} ${txt}</td></tr>`).join("")}</table>` : ""}
      <h3>Feng Shui</h3>
      <div class="note">Tick anything that applies to the house:</div>
      ${Object.entries(FS_ITEMS).map(([kk, lab]) => `<label class="note" style="display:block"><input type="checkbox" data-fs="${kk}" ${si.fs[kk] ? "checked" : ""}> ${lab}</label>`).join("")}
      <p class="note">${fsHits.length ? `${fsHits.length} traditional Feng Shui concern${fsHits.length > 1 ? "s" : ""}. These are usually softened with layout, plants, screens or mirrors rather than being deal-breakers.` : "No Feng Shui concerns ticked."} Personal Feng Shui directions also depend on your birth year (Kua number), which this page doesn't cover.</p>
      <p class="note">Vaastu and Feng Shui are traditional systems, so they're kept separate from the price, risk and forecast numbers.</p>`;
    const save = () => { try { localStorage.setItem("hc-sun", JSON.stringify(sunInputs)); } catch (e) { /* ignore */ } renderSun(); };
    document.querySelectorAll("[data-sun]").forEach(el => el.onchange = () => { sunInputs[el.dataset.sun] = el.value; save(); });
    document.querySelectorAll("[data-fs]").forEach(el => el.onchange = () => { sunInputs.fs[el.dataset.fs] = el.checked; save(); });
  }

  // ---------------------------------------------------------------- houses checked through RentCast property records
  function renderInspected() {
    const houses = Object.values(INSPECTED || {}).filter(h => (h.zipCode || "") === zip || (h.formattedAddress || "").includes(zip));
    const how = `To check a specific house, add its full address (e.g. "123 Main St, Columbus, OH 43201") on its own line in <code>inspect.txt</code> on GitHub. Each new address uses one RentCast lookup.`;
    if (!houses.length) { $("#s-inspect").innerHTML = `<h2>Houses you're checking</h2><p class="note">${how}</p>`; return; }
    const feat = h => Object.entries(h.features || {}).filter(([, v]) => v !== null && v !== "" && typeof v !== "object").map(([kk, v]) => `${kk.replace(/([A-Z])/g, " $1").toLowerCase()}: ${v === true ? "yes" : v}`).join(" &middot; ");
    const lastYear = obj => { const ks = Object.keys(obj || {}).sort(); return ks.length ? obj[ks[ks.length - 1]] : null; };
    $("#s-inspect").innerHTML = `<h2>Houses you're checking</h2><div class="listings">${houses.map(h => {
      const tax = lastYear(h.propertyTaxes), asmt = lastYear(h.taxAssessments);
      return `<div class="listing"><div class="price">${esc(h.formattedAddress || "")}</div>
        <div class="note">${esc(h.propertyType || "")}${h.yearBuilt ? ` &middot; built ${h.yearBuilt}` : ""}${h.squareFootage ? ` &middot; ${h.squareFootage.toLocaleString()} sq ft` : ""}${h.lotSize ? ` &middot; lot ${h.lotSize.toLocaleString()} sq ft` : ""}</div>
        ${feat(h) ? `<div class="note">${feat(h)}</div>` : ""}
        ${h.lastSalePrice ? `<div>Last sold ${money(h.lastSalePrice)}${h.lastSaleDate ? ` (${h.lastSaleDate.slice(0, 10)})` : ""}</div>` : ""}
        ${asmt ? `<div>Tax assessment ${asmt.year || ""}: ${money(asmt.value)}${asmt.land ? ` (land ${money(asmt.land)})` : ""}</div>` : ""}
        ${tax ? `<div>Property tax ${tax.year || ""}: ${money(tax.total)}</div>` : ""}
        ${h.yearBuilt ? `<ul class="note">${ageFlags(h.yearBuilt).map(f => `<li>${f}</li>`).join("")}</ul>` : ""}
      </div>`; }).join("")}</div><p class="note">${how}</p>`;
  }

  function renderSchools() {
    $("#s-schools").innerHTML = `<h2>Schools</h2><p class="note">School ratings aren't built in yet. For now:
      <a href="https://nces.ed.gov/ccd/schoolsearch/school_list.asp?Search=1&Zip=${zip}&Miles=5" target="_blank" rel="noopener">public schools within 5 miles of ${zip} (NCES)</a>.</p>`;
  }

  function renderSources() {
    const a = NAT.asof || {};
    $("#sources").innerHTML = `Data rebuilt ${NAT.built}. Sources: Freddie Mac mortgage rates (${a.rates || ""}), Zillow home value and rent indexes (${a.zillow_values || ""}),
      FHFA zip-code house price index (through ${a.fhfa || ""}), US Census ACS 5-year (${a.acs || ""}), County Health Rankings (crime), MIT Election Data and Science Lab,
      Nolo / NAA / NLIHC for state law, RentCast for listings. Nothing here is financial or legal advice.`;
  }

  // ---------------------------------------------------------------- events
  $("#lookup").addEventListener("submit", e => { e.preventDefault(); saveInputs(); lookup(); });
  $("#purpose").addEventListener("change", () => { saveInputs(); if (rec) renderAll(); });
  document.querySelectorAll("[data-k]").forEach(el => el.addEventListener("change", () => { saveInputs(); if (rec) renderAll(); }));
  $("#resetInputs").addEventListener("click", () => {
    try { localStorage.removeItem("hc-inputs"); } catch (e) { /* ignore */ }
    loadInputs(); if (rec) renderAll();
  });
  init();
})();
