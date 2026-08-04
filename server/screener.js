/**
 * Preferred-security safety screener.
 * Install: /app/server/screener.js
 * Wire:    import screenerRouter from './screener.js';
 *          app.use('/api/screen', screenerRouter);
 *
 * WHAT THIS ANSWERS
 * A preferred holder is not buying growth. The only question that matters is
 * whether the dividend keeps getting paid, and what stands ahead of you if it
 * does not. So this ranks ISSUERS on:
 *
 *   fixedChargeCoverage = EBIT / (interest + preferred dividends)
 *      The single most important ratio. Below ~2x the cushion is thin.
 *   seniorClaims        = funded debt + finance leases, all senior to preferred
 *   preferredShare      = preferred / (debt + preferred), how much of the
 *                         non-equity stack is you rather than lenders
 *   cushion             = investments and cash available against senior claims
 *
 * LIMITS - read these.
 *  - Issuer level only. Coupon, call date, cumulative vs non-cumulative and
 *    conversion terms are in the prospectus (424B), not XBRL. Two preferreds
 *    from one issuer can differ sharply and this cannot tell them apart.
 *  - Insurers, banks and holding companies have no tagged operating income,
 *    so coverage cannot be computed. They return unusable rather than a guess.
 *  - TTM preferred dividends understate the annual charge when the preferred
 *    was issued mid-year. Flagged when detected.
 */

import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

async function edgar(path) {
  try {
    const port = process.env.PORT || 3001;
    const r = await fetch(`http://127.0.0.1:${port}/api/edgar/${path}`, { timeout: 25000 });
    const j = await r.json();
    return { ok: r.ok, body: j };
  } catch (e) { return { ok: false, body: { error: e.message } }; }
}

function grade(fcc) {
  if (fcc == null) return { grade: 'N/A', rank: 9 };
  if (fcc >= 8) return { grade: 'Strong', rank: 1 };
  if (fcc >= 5) return { grade: 'Sound', rank: 2 };
  if (fcc >= 3) return { grade: 'Adequate', rank: 3 };
  if (fcc >= 2) return { grade: 'Thin', rank: 4 };
  return { grade: 'Weak', rank: 5 };
}

function gradeFinancial(cov) {
  if (cov == null) return { grade: 'N/A', rank: 9 };
  if (cov >= 10) return { grade: 'Strong', rank: 1 };
  if (cov >= 6) return { grade: 'Sound', rank: 2 };
  if (cov >= 4) return { grade: 'Adequate', rank: 3 };
  if (cov >= 2) return { grade: 'Thin', rank: 4 };
  return { grade: 'Weak', rank: 5 };
}

async function assess(symbol) {
  const out = { symbol, usable: false };
  const cap = await edgar(`capital?symbol=${symbol}`);
  const cov = await edgar(`coverage?symbol=${symbol}`);
  const c = (cap.ok && cap.body && !cap.body.error) ? cap.body : null;

  // funding-source check runs on every issuer, both paths
  const cash = await edgar(`coverage-cash?symbol=${symbol}`);
  const cashFunding = (cash.ok && cash.body && cash.body.usable) ? {
    verdict: cash.body.verdict,
    ocfCoverage: cash.body.ratios.ocfCoverageOfPreferredDividends,
    ttmMillions: cash.body.ttmMillions,
    flags: cash.body.flags,
  } : null;

  // ---- financial-issuer path: banks and insurers have no operating income,
  //      so route to earnings coverage of the preferred dividend instead.
  const opUnusable = !cov.ok || !cov.body || cov.body.usable === false;
  if (opUnusable) {
    const cf = await edgar(`coverage-financial?symbol=${symbol}`);
    if (cf.ok && cf.body && cf.body.usable) {
      const f = cf.body;
      const D = f.ttm.preferredDividendsB || 0;
      if (!D) { out.reason = 'no preferred dividends found (none outstanding, or narrative-only)'; return out; }
      const ratio = f.coverage.preferredCoverageNet;
      const g = gradeFinancial(ratio);
      const flags = [
        'Financial issuer: EBIT-based fixed-charge coverage does not apply. '
          + 'Deposit interest is an operating cost, not a financing charge.',
        'Junior subordinated and trust-preferred coupons are DEFERRABLE. Regulatory capital, '
          + 'not earnings, is normally the binding constraint on distributions.',
      ];
      if (f.regulatoryCapitalNote) flags.push(f.regulatoryCapitalNote);
      Object.assign(out, {
        usable: true, method: 'financial-issuer', grade: g.grade, _rank: g.rank,
        preferredCoverageNet: ratio,
        preferredCoveragePretax: f.coverage.preferredCoveragePretax,
        ttm: f.ttm,
        preferredDividendSource: f.ttm.preferredDividendSource,
        regulatoryCapital: f.regulatoryCapital,
        capital: c && c.usable ? {
          preferredB: c.capital.preferred, seniorClaimsB: c.capital.fundedDebt,
        } : null,
        flags, cashFunding,
      });
      return out;
    }
    out.reason = (cov.body && cov.body.reason) || 'coverage unavailable on both paths';
    out.guidance = cov.body && cov.body.guidance;
    return out;
  }

  // ---- operating-company path
  if (!c) { out.reason = 'capital unavailable'; return out; }
  if (!c.usable) {
    out.reason = 'capital structure not resolvable from XBRL';
    out.unresolvedRoles = c.unresolvedRoles;
    return out;
  }

  const preferred = c.capital.preferred || 0;
  out.preferredB = preferred;
  out.preferredBasis = c.capital.preferredBasis;
  if (!preferred) {
    out.reason = 'no preferred outstanding';
    if (cashFunding && cashFunding.ttmMillions.preferredDividendsPaid) {
      out.reason = 'preferred balance not in companyfacts (likely tagged per series with a PreferredClassAxis dimension, which the API omits) - but preferred dividends ARE being paid';
      out.cashFunding = cashFunding;
    }
    return out;
  }

  const v = cov.body;

  const ebit = v.ttm.operatingIncomeB;
  const interest = v.ttm.interestExpenseB || 0;
  const prefDivs = v.ttm.preferredDividendsB || 0;
  const senior = (c.capital.fundedDebt || 0) + (c.capital.financeLeases || 0);
  const investments = (c.investments && c.investments.total) || 0;

  const fcc = (ebit != null && (interest + prefDivs) > 0) ? ebit / (interest + prefDivs) : null;
  const g = grade(fcc);

  const flags = [];
  // a preferred issued mid-period understates the annual charge
  const impliedRate = preferred ? (prefDivs / preferred) * 100 : null;
  if (impliedRate != null && impliedRate < 3)
    flags.push(`TTM preferred dividends imply only ${impliedRate.toFixed(1)}% on liquidation value - `
      + 'likely issued mid-period, so the forward charge is higher than shown.');
  if (senior && preferred && senior / preferred > 5)
    flags.push('Senior claims exceed preferred by more than 5x - thin subordination cushion.');
  if (c.investments && c.investments.nonMarketablePctOfInvestments > 40)
    flags.push(`${c.investments.nonMarketablePctOfInvestments}% of investments are non-marketable `
      + '(marked to model) - realisable value in stress is uncertain.');
  if (ebit != null && ebit < 0) flags.push('Negative operating income - dividend is not covered by operations.');

  Object.assign(out, {
    usable: true,
    method: 'operating',
    grade: g.grade,
    _rank: g.rank,
    fixedChargeCoverage: fcc != null ? +fcc.toFixed(2) : null,
    interestCoverage: v.coverage.interestCoverage,
    ttm: { operatingIncomeB: ebit, interestExpenseB: interest, preferredDividendsB: prefDivs },
    capital: {
      preferredB: preferred,
      seniorClaimsB: +senior.toFixed(2),
      preferredPctOfNonEquity: (senior + preferred) ? +((preferred / (senior + preferred)) * 100).toFixed(1) : null,
      investmentsB: investments,
      investmentsToSeniorClaims: senior ? +(investments / senior).toFixed(2) : null,
    },
    impliedCurrentRatePct: impliedRate != null ? +impliedRate.toFixed(2) : null,
    cashFunding,
    asOf: c.asOf,
    flags,
  });
  return out;
}

router.get('/preferred', handler);
router.post('/preferred', handler);

async function handler(req, res) {
  try {
    let symbols = (req.body && req.body.symbols) || null;
    if (!symbols && req.query.symbols) symbols = String(req.query.symbols).split(',');
    if (!symbols || !symbols.length)
      return res.status(400).json({
        error: 'Provide symbols, e.g. /api/screen/preferred?symbols=GOOG,MSFT,BAC',
        note: 'Symbols are ISSUER common tickers, not preferred series tickers. '
          + 'XBRL is filed per issuer; series-level terms are not tagged.',
      });

    symbols = symbols.map((x) => String(x).trim().toUpperCase()).filter(Boolean).slice(0, 40);

    const results = [];
    for (const sym of symbols) {
      try { results.push(await assess(sym)); }
      catch (e) { results.push({ symbol: sym, usable: false, reason: e.message }); }
      await new Promise((r) => setTimeout(r, 150));
    }

    const usable = results.filter((r) => r.usable)
      .sort((a, b) => (a._rank - b._rank) || ((b.fixedChargeCoverage || 0) - (a.fixedChargeCoverage || 0)));
    usable.forEach((r) => delete r._rank);
    const excluded = results.filter((r) => !r.usable)
      .map((r) => ({ symbol: r.symbol, reason: r.reason, preferredB: r.preferredB }));

    res.json({
      screened: symbols.length,
      ranked: usable,
      excluded,
      method: 'fixedChargeCoverage = EBIT / (interest + preferred dividends). '
        + 'Grades: Strong >=8x, Sound >=5x, Adequate >=3x, Thin >=2x, Weak <2x.',
      caveat: 'Issuer-level only. Coupon, call date, cumulative status and conversion terms '
        + 'come from the prospectus and are NOT reflected here. Two series from the same '
        + 'issuer can differ materially.',
    });
  } catch (e) {
    res.status(500).json({ error: `screen failed: ${e.message}` });
  }
}

export default router;
