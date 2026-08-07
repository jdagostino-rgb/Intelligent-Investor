/**
 * Fund / income-ETF analytics.
 * Install: /app/server/funds.js
 * Wire:    import fundsRouter from './funds.js';
 *          app.use('/api/funds', fundsRouter);
 *
 * WHY
 * JEPI, JEPQ and AMLP are funds, not filers - no XBRL, no earnings, no NAV
 * discount worth speaking of. The question for a high-distribution fund is
 * whether the payout is income or partly your own capital returned. The
 * return-of-capital percentage lives in 19a-1 notices and 1099-DIVs, which
 * no API here exposes - but NAV erosion is its observable consequence and
 * IS computable: decompose total return into distribution return and price
 * return. A fund paying 8% while the price falls 4% a year is handing back
 * capital, whatever the label on the distribution.
 */

import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();
const bad = (res, c, m) => res.status(c).json({ error: m });

async function fmp(path) {
  const port = process.env.PORT || 3001;
  const r = await fetch(`http://127.0.0.1:${port}/api/fmp/${path}`, { timeout: 20000 });
  if (!r.ok) return null;
  try { return await r.json(); } catch (e) { return null; }
}

const asArray = (j, keys = ['historical', 'data']) => {
  if (Array.isArray(j)) return j;
  if (!j) return [];
  for (const k of keys) if (Array.isArray(j[k])) return j[k];
  return [];
};

/** Closest price on or before a target date. */
function priceOn(series, target) {
  const t = new Date(target).getTime();
  let best = null;
  for (const p of series) {
    const d = new Date(p.date).getTime();
    if (d <= t && (!best || d > new Date(best.date).getTime())) best = p;
  }
  return best;
}

router.get('/analyze', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase();
    if (!symbol) return bad(res, 400, 'symbol is required');

    const [divRaw, priceRaw, infoRaw, quoteRaw] = await Promise.all([
      fmp(`dividends?symbol=${symbol}`),
      fmp(`historical-price-eod/light?symbol=${symbol}&from=2018-01-01`),
      fmp(`etf/info?symbol=${symbol}`),
      fmp(`quote?symbol=${symbol}`),
    ]);

    const divs = asArray(divRaw).map((d) => ({
      date: d.date || d.paymentDate || d.recordDate,
      amt: Number(d.dividend ?? d.adjDividend ?? 0),
    })).filter((d) => d.date && isFinite(d.amt) && d.amt > 0)
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const prices = asArray(priceRaw).map((p) => ({
      date: p.date, close: Number(p.price ?? p.close ?? p.adjClose),
    })).filter((p) => p.date && isFinite(p.close))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    if (!divs.length || !prices.length)
      return bad(res, 422, 'insufficient dividend or price history');

    const q = Array.isArray(quoteRaw) ? quoteRaw[0] : quoteRaw;
    const price = (q && Number(q.price)) || prices[0].close;
    const info = Array.isArray(infoRaw) ? infoRaw[0] : infoRaw;

    const now = Date.now();
    const distSince = (yearsBack) => {
      const cut = now - yearsBack * 365.25 * 864e5;
      return divs.filter((d) => new Date(d.date).getTime() >= cut)
                 .reduce((a, d) => a + d.amt, 0);
    };

    const ttmDist = distSince(1);
    const distYield = (ttmDist / price) * 100;

    // payment cadence
    const last12 = divs.filter((d) => new Date(d.date).getTime() >= now - 365.25 * 864e5).length;
    const cadence = last12 >= 11 ? 'monthly' : last12 >= 4 ? 'quarterly' : last12 >= 2 ? 'semi-annual' : 'irregular';

    const periods = [1, 3, 5];
    const decomposition = periods.map((yrs) => {
      const target = new Date(now - yrs * 365.25 * 864e5).toISOString().slice(0, 10);
      const p0 = priceOn(prices, target);
      if (!p0) return { years: yrs, available: false };
      const priceRet = ((price / p0.close) - 1) * 100;
      const distRet = (distSince(yrs) / p0.close) * 100;
      const total = priceRet + distRet;
      return {
        years: yrs, available: true, startDate: p0.date, startPrice: +p0.close.toFixed(2),
        priceReturnPct: +priceRet.toFixed(2),
        distributionReturnPct: +distRet.toFixed(2),
        totalReturnPct: +total.toFixed(2),
        annualisedTotalPct: +(((Math.pow(1 + total / 100, 1 / yrs)) - 1) * 100).toFixed(2),
        capitalErosion: priceRet < 0,
      };
    });

    const flags = [];
    const d3 = decomposition.find((d) => d.years === 3 && d.available);
    if (d3 && d3.priceReturnPct < 0) {
      flags.push(`Price is down ${Math.abs(d3.priceReturnPct).toFixed(1)}% over 3 years while `
        + `distributions paid ${d3.distributionReturnPct.toFixed(1)}%. Part of the payout is `
        + 'coming out of capital - the yield is real cash but the principal is shrinking.');
    }
    if (d3 && d3.priceReturnPct >= 0 && distYield > 6) {
      flags.push(`Distribution yield of ${distYield.toFixed(1)}% with the price holding up - the `
        + 'payout is being covered without eroding principal on this window.');
    }
    if (/AMLP/.test(symbol)) {
      flags.push('AMLP is structured as a C-CORPORATION, not a RIC. It accrues a deferred tax '
        + 'liability on unrealised gains, which is a persistent drag on NAV that does not appear '
        + 'in the expense ratio. Its tracking of the underlying MLP index is reduced accordingly.');
    }
    if (/JEPI|JEPQ/.test(symbol)) {
      flags.push('Income here derives substantially from an options overlay (equity-linked notes / '
        + 'covered calls). That premium is real income, but it caps upside in strong markets - '
        + 'expect underperformance versus the underlying index when it rallies hard.');
    }
    flags.push('RETURN OF CAPITAL PERCENTAGE IS NOT AVAILABLE HERE. It is disclosed in 19a-1 '
      + 'notices and finalised on the 1099-DIV. Price return is the observable proxy used above.');

    res.json({
      symbol, type: 'fund/ETF',
      price,
      name: info ? (info.name || info.companyName || null) : null,
      expenseRatioPct: info && info.expenseRatio != null ? Number(info.expenseRatio) : null,
      distribution: {
        ttmPerShare: +ttmDist.toFixed(4),
        ttmYieldPct: +distYield.toFixed(2),
        cadence, paymentsLast12m: last12,
        latest: divs.slice(0, 3),
      },
      returnDecomposition: decomposition,
      flags,
      note: 'Total return is price return plus distributions taken as cash (not reinvested). '
        + 'The split between the two is the point: a high yield paired with a falling price is '
        + 'capital being returned, not income being earned.',
      source: 'FMP dividend and price history',
    });
  } catch (e) {
    bad(res, 500, `fund analyze failed: ${e.message}`);
  }
});

export default router;
