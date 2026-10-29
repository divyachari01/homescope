// Copyright (c) 2026 Divya Chari
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Deal check: is one house a good buy, and what to offer. Pure math, no page code.
//
// Fair value blends three independent reads: recent sales of similar homes nearby (time-adjusted
// with the zip's price index), the house's own last sale grown by the same index, and Realtor.com's
// automated estimate. The offer then follows how hard homes here actually sold versus asking
// (sale-to-list), how long this one has sat, and your budget. The same rule is replayed on every
// recent sale in the zip to show how well it would have done.
const Deal = (() => {
  const GROUP = { "Single Family": "house", "Townhouse": "town", "Condo": "condo", "Apartment": "condo",
                  "Multi-Family": "multi", "Manufactured": "mfd", "Land": "land" };
  const groupOf = t => GROUP[t] || "other";
  // States that don't make sale prices public: sold-home data there has few or no prices.
  const NON_DISCLOSURE = new Set(["AK", "ID", "KS", "LA", "MS", "MT", "NM", "ND", "TX", "UT", "WY"]);
  const LIMITS = { conforming: 832750, fhaFloor: 541287, year: 2026 };   // FHFA / HUD 2026 one-unit

  const med = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); if (!b.length) return NaN;
    const m = (b.length - 1) / 2; return (b[Math.floor(m)] + b[Math.ceil(m)]) / 2; };
  const q = (a, p) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); if (!b.length) return NaN;
    const i = (b.length - 1) * p; return b[Math.floor(i)] + (b[Math.ceil(i)] - b[Math.floor(i)]) * (i % 1); };
  const miles = (a, b, c, d) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 +
    Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 7917.5 * Math.asin(Math.sqrt(x)); };
  const monthsBetween = (d0, d1) => (new Date(d1) - new Date(d0)) / 2.63e9;

  // Price index lookup: monthly Zillow values for recent years, yearly history before that.
  function indexer(monthly, yearly) {
    const mm = new Map();
    if (monthly) {
      const [y0, m0] = monthly.start.split("-").map(Number);
      monthly.v.forEach((v, i) => { if (v) { const k = m0 - 1 + i; mm.set(`${y0 + Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, "0")}`, v); } });
    }
    const ym = new Map();
    if (yearly) yearly.years.forEach((y, i) => { if (yearly.vals[i]) ym.set(y, yearly.vals[i]); });
    const lastM = [...mm.keys()].sort().pop(), now = lastM ? mm.get(lastM) : [...ym.values()].pop();
    const at = date => {
      if (!date) return null;
      const key = date.slice(0, 7);
      if (mm.has(key)) return mm.get(key);
      if (lastM && key > lastM) return now;
      return ym.get(Number(date.slice(0, 4))) ?? null;
    };
    return { now, at, factor: date => { const v = at(date); return v && now ? now / v : null; } };
  }

  // Recent sales most like the house: same kind of building, similar size, close by, recent.
  function comps(s, sold, idx, today, n = 8) {
    const g = groupOf(s.propertyType);
    const out = [];
    for (const c of sold) {
      if (!c.sold || groupOf(c.type) !== g || c.address === s.formattedAddress) continue;
      const dist = s.latitude && c.lat ? miles(s.latitude, s.longitude, c.lat, c.lon) : 1.5;
      if (dist > 3) continue;
      if (s.squareFootage && !c.sqft) continue;              // size unknown: can't compare
      const size = s.squareFootage ? c.sqft / s.squareFootage : null;
      if (size && (size < 0.75 || size > 1.33)) continue;
      const bedGap = s.bedrooms != null && c.bedrooms != null ? Math.abs(s.bedrooms - c.bedrooms) : 0;
      if (bedGap > 1) continue;
      const ago = c.date ? Math.max(0, monthsBetween(c.date, today)) : 6;
      const f = idx.factor(c.date) || 1;
      // Bigger homes cost less per square foot, so scale by size to the 0.7 power.
      const value = c.sold * f * (size ? Math.pow(1 / size, 0.7) : 1);
      out.push({ ...c, dist, ago, value, score: dist + (size ? Math.abs(Math.log(size)) * 3 : 0.5) + bedGap * 0.5 + ago * 0.05 });
    }
    return out.sort((a, b) => a.score - b.score).slice(0, n);
  }

  // How hard homes sold versus asking, from recent sales (skips obvious data errors).
  function competition(sold, skip) {
    const r = sold.filter(c => c !== skip && c.sold && c.list && c.sold / c.list > 0.75 && c.sold / c.list < 1.25);
    return { n: r.length, stl: med(r.map(c => c.sold / c.list)), above: r.length ? r.filter(c => c.sold > c.list).length / r.length : NaN,
             dom: med(sold.filter(c => c !== skip).map(c => c.dom)) };
  }

  // The offer rule. L = asking price, F = fair value, m = typical sale-to-list here. The target is
  // what homes like this have been selling for (asking x m), pulled toward fair value by weight w,
  // with a discount d for listings that have sat much longer than usual. w and d are picked per zip
  // by replaying the rule on its recent sales (see backtest).
  function offerRule(L, F, m, dom, zipDom, w = 0.2, d = 0.97, k = 1) {
    m = Number.isFinite(m) ? Math.min(1.08, Math.max(0.9, m)) : 0.98;
    const ratio = Number.isFinite(F) ? Math.min(1.25, Math.max(0.8, F / L)) : 1;
    let o = L * Math.pow(m, k) * Math.pow(ratio, w);
    const stale = dom != null && dom > Math.max(60, 1.5 * (Number.isFinite(zipDom) ? zipDom : 45));
    if (stale) o *= d;
    return { offer: Math.max(o, L * 0.85), stale, m };
  }

  // Replays the rule on each recent sale, using only the other sales for fair value and
  // sale-to-list, and picks the weights that came closest to the real sale prices.
  function backtest(sold, idx, today) {
    const cases = [];
    for (const h of sold) {
      if (!h.sold || !h.list || h.sold / h.list < 0.75 || h.sold / h.list > 1.25) continue;
      const s = { formattedAddress: h.address, propertyType: h.type, latitude: h.lat, longitude: h.lon, squareFootage: h.sqft, bedrooms: h.bedrooms };
      const others = sold.filter(c => c !== h);
      const cs = comps(s, others, idx, h.date || today);
      const back = idx.factor(h.date) || 1;               // comps are in today's prices; bring them back to the sale date
      const F = cs.length >= 3 ? med(cs.map(c => c.value)) / back : NaN;
      const comp = competition(others);
      cases.push({ h, F, m: comp.stl, zipDom: comp.dom });
    }
    if (cases.length < 8) return { n: cases.length };
    const score = (w, d, k) => {
      const e = cases.map(c => offerRule(c.h.list, c.F, c.m, c.h.dom, c.zipDom, w, d, k).offer / c.h.sold - 1);
      return { e, miss: med(e.map(Math.abs)) };
    };
    let best = null;
    for (const k of [1]) for (const w of [0, 0.1, 0.2, 0.3, 0.5]) for (const d of [1, 0.98, 0.96]) {
      const r = score(w, d, k);
      if (!best || r.miss < best.miss - 1e-9) best = { w, d, k, ...r };
    }
    const plain = score(0, 1, 1), withF = cases.filter(c => Number.isFinite(c.F));
    // Chance-of-winning ladder: share of recent sales that closed at or below each share of asking.
    const ratios = cases.map(c => c.h.sold / c.h.list);
    const ladder = [0.94, 0.96, 0.98, 1, 1.02, 1.04].map(f => ({ f, beat: ratios.filter(r => r <= f + 1e-9).length / ratios.length * 100 }));
    return { n: cases.length, w: best.w, d: best.d, k: best.k, ladder,
      offerMiss: best.miss * 100, offerBias: med(best.e) * 100, plainMiss: plain.miss * 100,
      within5: best.e.filter(x => Math.abs(x) <= 0.05).length / best.e.length * 100,
      atOrAbove: best.e.filter(x => x >= -0.01).length / best.e.length * 100,
      fairMiss: withF.length ? med(withF.map(c => Math.abs(c.F / c.h.sold - 1))) * 100 : NaN,
      listMiss: med(cases.map(c => Math.abs(c.h.list / c.h.sold - 1))) * 100 };
  }

  // Words in the listing description that point to updates or to problems.
  const GOOD = [[/new roof|roof (?:was )?replaced|roof \(20\d\d\)|20\d\d roof/i, "newer roof"],
    [/new (?:hvac|furnace|a\/?c\b|air condition|heat pump)|hvac (?:replaced|20\d\d)/i, "newer heating / cooling"],
    [/new (?:windows)|windows (?:replaced|20\d\d)/i, "newer windows"],
    [/new (?:water heater|tankless)/i, "newer water heater"],
    [/(?:re-?wired|new electrical|updated electrical|new (?:electric )?panel)/i, "electrical updated"],
    [/new plumbing|re-?plumbed|updated plumbing|pex/i, "plumbing updated"],
    [/fully renovated|completely renovated|full(?:y)? remodel|gut(?:ted)? renovation|renovated|remodeled|remodelled/i, "renovated"],
    [/updated kitchen|kitchen (?:was )?(?:remodel|renovat|updated)|new kitchen/i, "kitchen updated"],
    [/new construction|newly built|builder warranty/i, "new build"]];
  const BAD = [[/\bas[- ]is\b/i, "sold as-is"], [/\btlc\b|needs (?:some )?(?:work|updating|love)|handyman|fixer|investor special|diamond in the (?:rough|ruff)/i, "needs work"],
    [/foundation (?:issue|repair|problem|work)|settling|structural/i, "foundation / structure mentioned"],
    [/water damage|leak|flood(?:ed|ing)? (?:damage|in)/i, "water damage mentioned"], [/\bmold\b|mould/i, "mold mentioned"],
    [/fire damage/i, "fire damage"], [/cash only|cash buyers? only|no (?:fha|va)/i, "cash or limited loans only"],
    [/tenant[- ]occupied|current(?:ly)? (?:leased|rented)|lease in place/i, "tenant in place"],
    [/septic/i, "septic system"], [/\bwell water\b|private well/i, "private well"],
    [/shared driveway/i, "shared driveway"], [/price (?:reduction|reduced|improvement)|reduced|just reduced/i, "price already cut"],
    [/estate sale|probate|trust sale/i, "estate / probate sale"], [/short sale|foreclos|bank[- ]owned|reo\b/i, "distressed sale"]];
  const BUILD = [[/\bbasement\b/i, "basement"], [/\bslab\b/i, "slab foundation"], [/crawl ?space/i, "crawl space"], [/pier and beam|pier & beam/i, "pier-and-beam"],
    [/\bbrick\b/i, "brick"], [/\bstone\b/i, "stone"], [/vinyl siding/i, "vinyl siding"], [/stucco/i, "stucco"], [/hardie|fiber cement/i, "fiber-cement siding"],
    [/metal roof/i, "metal roof"], [/tile roof/i, "tile roof"]];
  const scan = (text, list) => text ? list.filter(([re]) => re.test(text)).map(([, l]) => l) : [];

  // Loan choices at a given price. o = the page's inputs (rate, tax, insurance, cash, income...).
  function loans(P, o, hoa, rate15) {
    const pmt = (loan, r, yrs) => { const i = r / 1200, n = yrs * 12; return i ? loan * i / (1 - Math.pow(1 + i, -n)) : loan / n; };
    const tax = P * o.taxRate / 1200, ins = P * o.insRate / 1200, closing = P * o.closingPct / 100;
    const budget = Math.min(o.income / 12 * o.housingShare / 100, o.income / 12 * o.dtiCap / 100 - o.debts, o.maxMonthly || Infinity);
    const mk = (name, down, loan, rate, yrs, mi, note) => {
      const pi = pmt(loan, rate, yrs), monthly = pi + tax + ins + mi + (hoa || 0), cash = P * down / 100 + closing;
      return { name, down, loan, rate, yrs, pi, mi, monthly, cash, fits: cash <= o.cash && monthly <= budget,
        why: cash > o.cash ? "Cash short" : monthly > budget ? "Payment too high" : "Fits", note,
        jumbo: loan > LIMITS.conforming };
    };
    const r = o.ratePct, base = P * 0.8;
    const out = [
      mk("Conventional, 20% down", 20, base, r, 30, 0, "No mortgage insurance."),
      mk("Conventional, 10% down", 10, P * 0.9, r, 30, P * 0.9 * o.pmiRate / 1200, "Mortgage insurance drops off at about 22% equity."),
      mk("Conventional, 5% down", 5, P * 0.95, r, 30, P * 0.95 * o.pmiRate / 1200, "Same; needs good credit for a fair insurance price."),
      mk("FHA, 3.5% down", 3.5, P * 0.965 * 1.0175, r, 30, P * 0.965 * 0.0055 / 12,
        `1.75% upfront insurance added to the loan and 0.55%/yr for the life of the loan. Loan limit is at least ${Math.round(LIMITS.fhaFloor / 1000)}k (higher in pricier counties).`),
      mk("VA, 0% down (veterans and service members)", 0, P * 1.0215, r, 30, 0, "2.15% funding fee (first use) added to the loan, no monthly insurance."),
    ];
    if (rate15) out.push(mk("15-year fixed, 20% down", 20, base, rate15, 15, 0, "Higher payment, far less interest overall."));
    return out;
  }

  // Everything for one house. ctx: { sold, monthly, yearly, rec, state, o, maxPrice, rate15, today }
  function analyze(s, ctx) {
    const { rec, o } = ctx, today = ctx.today || new Date().toISOString().slice(0, 10);
    const idx = indexer(ctx.monthly, ctx.yearly);
    const sold = (ctx.sold || []).filter(c => c.sold);
    const L = s.price, reads = [];
    const cs = comps(s, sold, idx, today);
    if (cs.length >= 3) reads.push({ name: `${cs.length} similar homes sold nearby`, value: med(cs.map(c => c.value)), w: cs.length >= 5 ? 2 : 1,
      lo: q(cs.map(c => c.value), 0.25), hi: q(cs.map(c => c.value), 0.75) });
    else if (ctx.active) {
      // No usable sale prices (e.g. a non-disclosure state): compare with similar homes listed now, at asking.
      const act = ctx.active.filter(a => a.price && a.id !== s.id).map(a => ({ address: a.formattedAddress, type: a.propertyType, sold: a.price,
        date: today, sqft: a.squareFootage, bedrooms: a.bedrooms, lat: a.latitude, lon: a.longitude }));
      const ca = comps(s, act, idx, today);
      if (ca.length >= 3) reads.push({ name: `${ca.length} similar homes listed now (their asking prices)`, value: med(ca.map(c => c.value)), w: 0.75,
        lo: q(ca.map(c => c.value), 0.25), hi: q(ca.map(c => c.value), 0.75), asking: true });
    }
    let flip = false, lastIdx = null;
    if (s.lastSoldPrice && s.lastSoldDate) {
      const f = idx.factor(s.lastSoldDate), yrs = monthsBetween(s.lastSoldDate, today) / 12;
      if (f && yrs >= 0.5) {
        lastIdx = s.lastSoldPrice * f;
        flip = yrs < 3 && L > lastIdx * 1.25;
        reads.push({ name: `Its ${s.lastSoldDate.slice(0, 4)} sale grown with local prices`, value: lastIdx, w: flip ? 0 : 0.5,
          note: flip ? "left out: price jumped since, so it was likely renovated" : "" });
      }
    }
    const ests = (s.estimates || []).filter(e => e.value);
    if (ests.length) ests.forEach(e => reads.push({ name: `${e.name || "Automated"} estimate (via Realtor.com)`, value: e.value, w: 1.5 / ests.length,
      lo: e.low, hi: e.high }));
    else if (s.estimate) reads.push({ name: "Realtor.com's automated estimate", value: s.estimate, w: 1 });
    const used = reads.filter(r => r.w > 0);
    const F = used.length ? used.reduce((a, r) => a + r.value * r.w, 0) / used.reduce((a, r) => a + r.w, 0) : NaN;

    const comp = ctx.comp || competition(sold);
    const mk = rec.market || {};
    const stl = comp.n >= 8 ? comp.stl : mk.sale_to_list ?? NaN;
    const zipDom = comp.n >= 8 ? comp.dom : mk.dom ?? NaN;
    const bt = ctx.bt || backtest(sold, idx, today);      // same for every home in a zip, so callers can pass it in
    const rule = offerRule(L, F, stl, s.daysOnMarket, zipDom, bt.w ?? 0.1, bt.d ?? 0.97, bt.k ?? 1);
    const label = mk.label || (rule.m >= 1 ? "Seller's market" : rule.m < 0.97 ? "Buyer's market" : "Balanced");
    // Bidding over asking only makes sense for a fresh listing in a hot market. A home that has sat longer
    // than is typical here has no competing buyers to beat, whatever the market overall.
    const fresh = s.daysOnMarket == null || s.daysOnMarket <= Math.max(14, Number.isFinite(zipDom) ? zipDom : 30);
    const hot = (label === "Seller's market" || rule.m >= 1) && fresh && !rule.stale;
    const soft = label === "Buyer's market" || rule.stale || !fresh;
    if (!hot) rule.offer = Math.min(rule.offer, L * (rule.stale ? 0.97 : 1));   // never plan to pay over asking then
    // Two sides of the price: what the home is worth (F) and what sellers here actually get (E).
    // Aim between them, so neither the listing price nor an automated estimate alone sets the offer.
    const E = rule.offer;
    let target = Number.isFinite(F) ? Math.sqrt(F * E) : E;
    if (hot) target = Math.min(Math.max(target, E), (Number.isFinite(F) ? Math.max(F, E) : E) * 1.03);   // a fresh hot listing needs a competitive bid
    else target = Math.min(target, L, soft ? E * 1.02 : Infinity);   // in a slow market, don't pay much over what homes really sell for
    const opening = hot ? Math.min(target, Math.max(L, E)) : Math.min(target * (soft ? 0.96 : 0.98), L * 0.99);
    // value + 3% (or the aim, if higher), but outside a seller's market never more than asking
    const valueWalk = Math.min(Math.max(Number.isFinite(F) ? F : target, target) * 1.03, hot ? Infinity : L);
    // Your budget caps it, unless even the expected price is over budget (then that's flagged instead).
    const walk = ctx.maxPrice && ctx.maxPrice < valueWalk && ctx.maxPrice >= Math.min(target, valueWalk) ? ctx.maxPrice : valueWalk;
    const gap = Number.isFinite(F) ? (L / F - 1) * 100 : NaN;

    // Taxes, land, building
    const th = (s.taxHistory || []).filter(r => r && r[0]);
    const taxNow = s.tax || th[0]?.[1] || null;
    const taxAfter = target * (o.taxRate / 100);
    const withLand = th.find(r => r[2] && r[4]);
    const landShare = withLand ? withLand[2] / withLand[4] : null;
    const taxTrend = th.length >= 4 && th[0][1] && th[th.length - 1][1] ? (Math.pow(th[0][1] / th[th.length - 1][1], 1 / (th[0][0] - th[th.length - 1][0])) - 1) * 100 : null;

    const featLines = Object.values(s.features || {}).flat();
    const text = [s.text || "", ...featLines].join(" . ");
    const facts = featLines.filter(t => /foundation|construction material|roof|siding|exterior|structure|heating features|cooling features|sewer|water source|basement|common walls/i.test(t)
      && !/:\s*(?:no|none|0)$/i.test(t));
    return {
      L, F, gap, reads, comps: cs, comp, stl: rule.m, zipDom, stale: rule.stale, label, hot, soft,
      offer: target, expected: E, opening, walk, overBudget: ctx.maxPrice && ctx.maxPrice < target, maxPrice: ctx.maxPrice,
      flip, lastIdx, taxNow, taxAfter, taxTrend, landShare, landValue: landShare && Number.isFinite(F) ? landShare * F : null,
      good: scan(text, GOOD), bad: scan(text, BAD), build: scan(text, BUILD), facts: [...new Set(facts)].slice(0, 12),
      views7: s.views7, saves7: s.saves7,
      loans: loans(target, o, s.hoa, ctx.rate15),
      backtest: bt, nonDisclosure: NON_DISCLOSURE.has(rec.state) && sold.length < 8,
      soldCount: sold.length,
    };
  }

  // The zip-wide parts (how homes sell vs asking, and the replay test), computed once per zip.
  function zipParts(sold, monthly, yearly) {
    const s = (sold || []).filter(c => c.sold), today = new Date().toISOString().slice(0, 10);
    return { comp: competition(s), bt: backtest(s, indexer(monthly, yearly), today) };
  }

  return { analyze, zipParts, LIMITS, groupOf, NON_DISCLOSURE };
})();
if (typeof module !== "undefined") module.exports = Deal;
