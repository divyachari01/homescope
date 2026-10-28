// Copyright (c) 2026 Divya Chari
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Pure math used by the page. No DOM code here.
const Calc = (() => {
  // Monthly principal + interest on a fixed-rate loan.
  function pmt(loan, ratePct, years) {
    if (loan <= 0) return 0;
    const r = ratePct / 100 / 12, n = years * 12;
    return r === 0 ? loan / n : loan * r / (1 - Math.pow(1 + r, -n));
  }

  // Full monthly cost of owning a home at a given price.
  // o: downPct, ratePct, years, taxRate, insRate, pmiRate (all % per year), hoa ($/month)
  function monthly(price, o) {
    const down = price * o.downPct / 100, loan = price - down;
    const pi = pmt(loan, o.ratePct, o.years);
    const tax = price * o.taxRate / 100 / 12;
    const ins = price * o.insRate / 100 / 12;
    const pmi = o.downPct < 20 ? loan * o.pmiRate / 100 / 12 : 0;
    const hoa = o.hoa || 0;
    return { price, down, loan, pi, tax, ins, pmi, hoa, total: pi + tax + ins + pmi + hoa };
  }

  // Highest price you can buy, limited by income (payment rules) and by cash (down payment + closing).
  // o also needs: income ($/yr), debts ($/mo), cash, closingPct, housingShare (%), dtiCap (%)
  function maxPrice(o) {
    const inc = o.income / 12;
    const budget = Math.min(inc * o.housingShare / 100, inc * o.dtiCap / 100 - o.debts);
    const per = monthly(1, { ...o, hoa: 0 });          // cost per $1 of price (it is linear in price)
    const perDollar = per.pi + per.tax + per.ins + per.pmi;
    const byPayment = Math.max(0, (budget - (o.hoa || 0)) / perDollar);
    const byCash = o.cash / ((o.downPct + o.closingPct) / 100);
    return { price: Math.min(byPayment, byCash), byPayment, byCash, budget,
             limitedBy: byPayment <= byCash ? "income" : "cash" };
  }

  function percentile(arr, p) {
    const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return NaN;
    const i = (a.length - 1) * p / 100, lo = Math.floor(i), hi = Math.ceil(i);
    return a[lo] + (a[hi] - a[lo]) * (i - lo);
  }

  // Yearly growth rates over every h-year stretch in a yearly price series.
  function windowGrowth(values, h) {
    const out = [];
    for (let i = 0; i + h < values.length; i++) {
      const a = values[i], b = values[i + h];
      if (a > 0 && b > 0) out.push(Math.pow(b / a, 1 / h) - 1);
    }
    return out;
  }

  // Low / middle / high yearly growth for a given horizon, from the zip's own history.
  function growthBand(values, h) {
    const w = windowGrowth(values, h);
    if (w.length < 5) return null;
    return { low: percentile(w, 10), mid: percentile(w, 50), high: percentile(w, 90), n: w.length };
  }

  // How much mortgage rates have moved over 12-month spans.
  function rateMoves(monthlyRates) {
    const d = [];
    for (let i = 12; i < monthlyRates.length; i++) d.push(monthlyRates[i] - monthlyRates[i - 12]);
    const big = d.filter(x => Math.abs(x) >= 1).length / d.length * 100;
    return { shareOver1pt: big, p10: percentile(d, 10), p90: percentile(d, 90), n: d.length };
  }

  // Month-by-month simulation of "keep renting, buy after k years" with a fixed monthly budget
  // (today's rent + monthly saving, both growing over time). Money not spent on housing is invested.
  // Returns cash position at purchase, payment details and net worth at the horizon.
  function simulate(o, k, g) {
    const months = o.H * 12;
    let inv = o.cash0, own = false, bal = 0, pi = 0, value = 0, rate = 0, loan = 0, row = { k };
    for (let m = 0; m < months; m++) {
      const t = m / 12;
      if (k !== null && m === k * 12) {
        const price = o.price0 * Math.pow(1 + g, k);
        rate = o.rate0 + o.rateShift * Math.min(k, 5) / 5;
        const need = price * (o.downPct + o.closingPct) / 100;
        const mc = monthly(price, { ...o, ratePct: rate });
        const income = o.income * Math.pow(1 + o.incomeGrowth / 100, k);
        Object.assign(row, { price, rate, need, have: inv, payment: mc.total,
                             share: mc.total / (income / 12) * 100 });
        row.feasible = inv >= need && row.share <= o.housingShare;
        inv -= need;
        loan = mc.loan; bal = loan; pi = mc.pi; value = price; own = true;
      }
      const budget = o.rent0 * Math.pow(1 + o.rentGrowth / 100, t) + o.save * Math.pow(1 + o.incomeGrowth / 100, t);
      let cost;
      if (own) {
        value *= Math.pow(1 + g, 1 / 12);
        const interest = bal * rate / 1200;
        bal = Math.max(0, bal - (pi - interest));
        const pmi = o.downPct < 20 && bal / value > 0.78 ? loan * o.pmiRate / 1200 : 0;
        cost = pi + value * (o.taxRate + o.insRate + o.maintRate) / 1200 + (o.hoa || 0) + pmi;
      } else {
        cost = o.rent0 * Math.pow(1 + o.rentGrowth / 100, t);
      }
      inv = inv * (1 + o.invReturn / 1200) + (budget - cost);
    }
    row.netWorth = inv + (own ? value * (1 - o.sellPct / 100) - bal : 0);
    return row;
  }

  // Yearly numbers for an investment property (long-term rental or short-term rental).
  // o: downPct, ratePct, years, taxRate, insRate, maintRate, hoa, vacancy, mgmt (% of rent), closingPct
  function rental(price, rentMonthly, o) {
    const m = monthly(price, { ...o, pmiRate: 0 });
    const gross = rentMonthly * 12;
    const expenses = gross * (o.vacancy + o.mgmt) / 100 + price * (o.taxRate + o.insRate + o.maintRate) / 100 + (o.hoa || 0) * 12;
    const noi = gross - expenses;
    const cashIn = price * (o.downPct + o.closingPct) / 100;
    const cashFlow = noi / 12 - m.pi;
    return { gross, expenses, noi, capRate: noi / price * 100, cashFlow, cashIn,
             cashOnCash: cashFlow * 12 / cashIn * 100, pi: m.pi };
  }

  return { pmt, monthly, maxPrice, percentile, windowGrowth, growthBand, rateMoves, simulate, rental };
})();
if (typeof module !== "undefined") module.exports = Calc;
