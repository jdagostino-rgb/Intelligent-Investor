/**
 * Bond analytics.
 * Install: /app/server/bonds.js
 * Wire:    import bondsRouter from './bonds.js';
 *          app.use('/api/bonds', bondsRouter);
 *
 * WHY
 * Credit coverage answers "will they pay". For an ultra-long or perpetual
 * junior subordinated note, that is rarely what moves the position. A 6.875%
 * perpetual carries a modified duration near 15 - a 100bp move in rates is a
 * ~15% price move. Rate risk dominates credit risk for these securities, and
 * nothing in the app measured it.
 *
 * Computes: current yield, YTM, yield-to-call, yield-to-worst, modified
 * duration, convexity, and spread over the Treasury curve (FRED).
 *
 * CONVENTIONS
 *  - price is percent of par (104.672 = $1,046.72 per $1,000)
 *  - maturity 2049-12-31 is the market's perpetual convention; treated as
 *    perpetual, not as a 2049 bond
 *  - floaters have near-zero duration to the next reset; a fixed-rate
 *    duration would be badly wrong, so they are handled separately
 */

import express from 'express';
import fetch from 'node-fetch';
import pg from 'pg';

const router = express.Router();
const dbUrl = () => process.env.KB_DATABASE_URL || '';
let pool = null;
function getPool() { if (!pool && dbUrl()) { pool = new pg.Pool({ connectionString: dbUrl(), max: 3 }); pool.on('error', e => console.error('bonds pool', e.message)); } return pool; }
async function q(t, p = []) { const x = getPool(); if (!x) throw new Error('KB_DATABASE_URL not configured'); return x.query(t, p); }
const bad = (res, c, m) => res.status(c).json({ error: m });

const PERPETUAL_HINTS = ['2049-12-31', '2099-12-31', '9999-12-31'];
const isPerp = (m) => !m || PERPETUAL_HINTS.includes(String(m).slice(0, 10));

/** Price of a bond given yield. Perpetuals use a long finite horizon, which
    converges to the perpetual value well inside rounding. */
function priceAt(y, couponRate, yearsToMaturity, freq = 2, redemption = 100) {
  if (y <= -0.99) return NaN;
  const c = (couponRate / 100) * 100 / freq;      // cash coupon per period, per 100 par
  const n = Math.max(1, Math.round(yearsToMaturity * freq));
  const r = y / freq;
  let pv = 0;
  for (let t = 1; t <= n; t++) pv += c / Math.pow(1 + r, t);
  pv += redemption / Math.pow(1 + r, n);
  return pv;
}

/** Solve yield from price by bisection - robust where Newton can diverge. */
function solveYield(price, couponRate, years, freq = 2, redemption = 100) {
  let lo = -0.5, hi = 2.0;
  if (!isFinite(price) || price <= 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const p = priceAt(mid, couponRate, years, freq, redemption);
    if (!isFinite(p)) return null;
    if (p > price) lo = mid; else hi = mid;
  }
  const y = (lo + hi) / 2;
  return (y > -0.49 && y < 1.99) ? y : null;
}

/** Numeric modified duration and convexity - avoids closed-form mistakes
    on perpetuals and odd structures. */
function riskMeasures(y, couponRate, years, freq = 2, redemption = 100) {
  const h = 0.0001;
  const p0 = priceAt(y, couponRate, years, freq, redemption);
  const pu = priceAt(y + h, couponRate, years, freq, redemption);
  const pd = priceAt(y - h, couponRate, years, freq, redemption);
  const modDur = (pd - pu) / (2 * p0 * h);
  const convexity = (pu + pd - 2 * p0) / (p0 * h * h);
  return { modDur, convexity, dv01: (modDur * p0) / 10000 };
}

async function treasuryYield(years) {
  // uses the existing FRED proxy on this server
  const series = years >= 25 ? 'DGS30' : years >= 8 ? 'DGS10' : years >= 4 ? 'DGS5' : 'DGS2';
  try {
    const port = process.env.PORT || 3001;
    const r = await fetch(`http://127.0.0.1:${port}/api/fred/series?seriesid=${series}`, { timeout: 12000 });
    const j = await r.json();
    return (j && typeof j.latest === 'number') ? { series, pct: j.latest, date: j.date } : null;
  } catch (e) { return null; }
}

function analyse(b) {
  const price = Number(b.price);
  const coupon = b.couponRate == null ? null : Number(b.couponRate);
  const perp = isPerp(b.maturity);
  const freq = Number(b.frequency) || 2;
  const out = { cusip: b.cusip || null, name: b.name || null, price, couponRate: coupon,
                maturity: b.maturity || null, perpetual: perp, rateType: b.rateType || 'fixed' };

  if (b.rateType === 'float') {
    out.note = 'Floating rate. Coupon resets to index + spread, so rate duration runs only to '
      + 'the next reset (typically under 0.25 years) - NOT the 15+ years a fixed-rate perpetual '
      + 'would carry. Yield cannot be computed until the spread over the index is supplied.';
    out.modifiedDuration = 0.25;
    out.durationBasis = 'to next coupon reset (assumed quarterly)';
    out.spreadRequired = true;
    return out;
  }
  if (coupon == null || !isFinite(price)) { out.error = 'coupon and price required'; return out; }

  const yearsToMat = perp ? 100
    : Math.max(0.01, (new Date(b.maturity) - Date.now()) / (365.25 * 864e5));

  const ytm = solveYield(price, coupon, yearsToMat, freq, 100);
  const currentYield = (coupon / price) * 100;
  out.currentYieldPct = +currentYield.toFixed(3);
  out.ytmPct = ytm != null ? +(ytm * 100).toFixed(3) : null;
  out.yearsToMaturity = perp ? null : +yearsToMat.toFixed(2);

  if (ytm != null) {
    const rm = riskMeasures(ytm, coupon, yearsToMat, freq, 100);
    out.modifiedDuration = +rm.modDur.toFixed(2);
    out.convexity = +rm.convexity.toFixed(1);
    out.dv01PerHundredPar = +rm.dv01.toFixed(4);
    out.priceChangeFor100bp = +(-rm.modDur * 1).toFixed(2) + '% (approx, per +1.00% in yield)';
    out.durationBasis = perp ? 'perpetual (100y horizon)' : 'to maturity';
  }

  if (b.callPrice && b.callDate) {
    const yearsToCall = Math.max(0.01, (new Date(b.callDate) - Date.now()) / (365.25 * 864e5));
    const ytc = solveYield(price, coupon, yearsToCall, freq, Number(b.callPrice));
    out.yearsToCall = +yearsToCall.toFixed(2);
    out.ytcPct = ytc != null ? +(ytc * 100).toFixed(3) : null;
    if (out.ytmPct != null && out.ytcPct != null)
      out.yieldToWorstPct = Math.min(out.ytmPct, out.ytcPct);
  } else {
    out.yieldToWorstPct = out.ytmPct;
    out.callNote = 'No call schedule supplied. Junior subordinated notes are typically callable - '
      + 'yield-to-worst may be materially lower than yield-to-maturity.';
  }
  return out;
}

router.get('/analyze', async (req, res) => {
  try {
    const b = {
      cusip: req.query.cusip, name: req.query.name,
      price: req.query.price, couponRate: req.query.coupon,
      maturity: req.query.maturity, frequency: req.query.frequency,
      rateType: req.query.rateType, callDate: req.query.callDate, callPrice: req.query.callPrice,
    };
    if (!b.price) return bad(res, 400, 'price is required (percent of par)');
    const out = analyse(b);
    const yrs = out.perpetual ? 30 : (out.yearsToMaturity || 10);
    const t = await treasuryYield(yrs);
    if (t && out.ytmPct != null) {
      out.treasury = { series: t.series, yieldPct: t.pct, asOf: t.date };
      out.spreadOverTreasuryBps = Math.round((out.ytmPct - t.pct) * 100);
      out.spreadNote = 'Spread over the comparable Treasury. For a perpetual junior subordinated '
        + 'note this compensates for subordination, coupon deferral risk and extension risk.';
    }
    res.json(out);
  } catch (e) { bad(res, 500, `analyze failed: ${e.message}`); }
});

/** Every bond in the securities table, plus portfolio-level rate risk. */
router.get('/portfolio', async (req, res) => {
  try {
    const r = await q('SELECT * FROM securities ORDER BY ticker');
    if (!r.rows.length) return res.json({ count: 0, bonds: [], note: 'no securities mapped yet' });

    const priceOverride = {};
    String(req.query.prices || '').split(',').filter(Boolean).forEach((p) => {
      const [c, v] = p.split(':'); if (c && v) priceOverride[c.toUpperCase()] = parseFloat(v);
    });

    const out = [];
    for (const s of r.rows) {
      const price = priceOverride[s.cusip] != null ? priceOverride[s.cusip] : null;
      if (price == null) {
        out.push({ cusip: s.cusip, name: s.issuer_name, issuer: s.ticker,
          error: 'no current price supplied',
          hint: `pass ?prices=${s.cusip}:104.5 to analyse at a live price` });
        continue;
      }
      const a = analyse({ cusip: s.cusip, name: s.issuer_name, price,
        couponRate: s.coupon, maturity: s.maturity, rateType: s.seniority && s.notes
          && /variable|float/i.test(s.notes) ? 'float' : 'fixed' });
      a.issuer = s.ticker; a.seniority = s.seniority;
      out.push(a);
    }

    const rated = out.filter((x) => x.modifiedDuration != null);
    const avgDur = rated.length ? rated.reduce((a, x) => a + x.modifiedDuration, 0) / rated.length : null;
    res.json({
      count: out.length, bonds: out,
      portfolioRateRisk: avgDur != null ? {
        averageModifiedDuration: +avgDur.toFixed(2),
        interpretation: `A 100bp parallel rise in yields would cut the value of the analysed `
          + `bonds by roughly ${avgDur.toFixed(1)}%. Perpetual and ultra-long subordinated paper `
          + `carries far more rate risk than credit risk in normal conditions.`,
      } : null,
    });
  } catch (e) { bad(res, 500, `portfolio failed: ${e.message}`); }
});

export default router;
