/**
 * Intelligent Investor - Buffett two-column valuation
 * Install to: /app/server/valuation.js
 *
 * Wire into server.js (2 lines):
 *   import valuationRouter from './valuation.js';
 *   app.use('/api/valuation', valuationRouter);
 *
 * GET /api/valuation?symbol=GOOG
 *
 * WHY THIS EXISTS
 * ---------------
 * Alphabet Q2 2026 booked a $99.0B GROSS unrealized gain on equity securities
 * (SpaceX / Anthropic private marks), $77.1B net of tax. That inflated GAAP net
 * income to $112.2B for the quarter. Brokers compute P/E on trailing GAAP EPS,
 * so Yahoo shows ~18.7 and Schwab ~17.9 - arithmetically correct, economically
 * misleading, because it prices the company as if $96B of paper gains recur.
 *
 * Buffett's two-column method separates the two things a holding company owns:
 *   Column 1: INVESTMENTS per share  (cash, securities, equity stakes)
 *   Column 2: OPERATING EARNINGS per share (what the business itself earns)
 *
 * You then value column 2 on a multiple and ADD column 1, rather than letting
 * column 1's mark-to-market swings masquerade as column 2's earnings.
 *
 * The cleanest single number this produces is the EX-INVESTMENTS P/E:
 *   (price - investments per share) / core operating EPS
 * i.e. what you actually pay for the operating business after netting out the
 * securities you also receive.
 *
 * All field lookups use multi-name fallbacks because FMP's 'stable' API renames
 * fields relative to legacy. The response includes a `_resolved` block showing
 * which field names were actually found - check it if a number looks wrong.
 */

import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();
const FMP_BASE = 'https://financialmodelingprep.com/stable';
// lazy: ESM imports evaluate before dotenv.config() runs in server.js
const fmpKey = () => (process.env.FMP_API_KEY || '').trim();

/* ---------- helpers ---------- */

const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;

/** First present numeric field from a list of candidate names. */
function pick(obj, names, resolved, label) {
  for (const n of names) {
    const v = num(obj ? obj[n] : null);
    if (v !== null) {
      if (resolved && label) resolved[label] = n;
      return v;
    }
  }
  if (resolved && label && !(label in resolved)) resolved[label] = null;
  return null;
}

function median(arr) {
  const a = arr.filter((x) => typeof x === 'number' && isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

async function fmp(endpoint, params = {}) {
  const qs = new URLSearchParams({ ...params, apikey: fmpKey() }).toString();
  const r = await fetch(`${FMP_BASE}${endpoint}?${qs}`, { timeout: 15000 });
  if (!r.ok) throw new Error(`FMP ${r.status} on ${endpoint}`);
  return r.json();
}

/** Call our own edgar endpoints. XBRL is the system of record; FMP is fallback. */
async function edgar(path) {
  try {
    const port = process.env.PORT || 3001;
    const r = await fetch(`http://127.0.0.1:${port}/api/edgar/${path}`, { timeout: 20000 });
    const j = await r.json();
    return j && !j.error ? j : null;
  } catch (e) { return null; }
}

/* ---------- cache ---------- */
const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

/* ---------- main ---------- */

router.get('/', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    if (!fmpKey()) return res.status(500).json({ error: 'FMP_API_KEY not configured' });

    const hit = cache.get(symbol);
    if (hit && Date.now() - hit.at < CACHE_MS && !req.query.t) return res.json(hit.val);

    const [incQ, balQ, quoteRaw] = await Promise.all([
      fmp('/income-statement', { symbol, period: 'quarter', limit: 8 }),
      fmp('/balance-sheet-statement', { symbol, period: 'quarter', limit: 2 }),
      fmp('/quote', { symbol }),
    ]);

    const q = Array.isArray(incQ) ? incQ : [];
    const bal = (Array.isArray(balQ) ? balQ : [])[0] || {};
    const quote = (Array.isArray(quoteRaw) ? quoteRaw[0] : quoteRaw) || {};
    if (q.length < 4) return res.status(502).json({ error: 'insufficient quarterly data', quarters: q.length });

    const [xCap, xCov] = await Promise.all([
      edgar(`capital?symbol=${symbol}`),
      edgar(`coverage?symbol=${symbol}`),
    ]);
    const xUsable = !!(xCap && xCap.usable);

    const resolved = {};
    const price = pick(quote, ['price', 'previousClose'], resolved, 'price');

    /* --- per-quarter extraction --- */
    const quarters = q.map((r) => ({
      date: r.date,
      period: r.period,
      revenue: pick(r, ['revenue']),
      operatingIncome: pick(r, ['operatingIncome']),
      netIncome: pick(r, ['netIncome']),
      eps: pick(r, ['epsdiluted', 'epsDiluted', 'eps']),
      incomeBeforeTax: pick(r, ['incomeBeforeTax', 'ebt', 'pretaxIncome']),
      taxExpense: pick(r, ['incomeTaxExpense']),
      shares: pick(r, ['weightedAverageShsOutDil', 'weightedAverageShsOut']),
    }));

    const last4 = quarters.slice(0, 4);
    const prior4 = quarters.slice(4, 8);
    const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);

    const ttmNet = sum(last4, 'netIncome');
    const ttmOp = sum(last4, 'operatingIncome');
    const ttmRev = sum(last4, 'revenue');
    const ttmEps = last4.reduce((a, r) => a + (r.eps || 0), 0);

    /* --- diluted share count --- */
    let shares = median(last4.map((r) => r.shares));
    if (!shares) {
      const c = last4.find((r) => r.netIncome && r.eps);
      shares = c ? c.netIncome / c.eps : null;
    }
    resolved.sharesSource = last4.some((r) => r.shares) ? 'weightedAverageShsOutDil' : 'netIncome/eps';

    /* --- effective tax rate: median of quarterly rates (robust to outliers) --- */
    const rates = quarters
      .map((r) => (r.incomeBeforeTax && r.taxExpense != null && r.incomeBeforeTax !== 0)
        ? r.taxExpense / r.incomeBeforeTax : null)
      .filter((x) => x !== null && x > 0 && x < 0.5);
    const taxRate = median(rates) ?? 0.17;

    /* --- CORE earnings: operating income, taxed at the normal rate ---
       Deliberately conservative. Excludes interest income on the cash pile,
       which is real but small relative to the distortion being removed. */
    const ttmOpX = (xCov && xCov.ttm && xCov.ttm.operatingIncomeB != null)
      ? xCov.ttm.operatingIncomeB * 1e9 : null;
    const opUsed = ttmOpX != null ? ttmOpX : ttmOp;
    // preferred dividends are a prior claim - they reduce earnings available to common
    const prefDivs = (xCov && xCov.ttm && xCov.ttm.preferredDividendsB)
      ? xCov.ttm.preferredDividendsB * 1e9 : 0;
    const coreNet = opUsed * (1 - taxRate) - prefDivs;
    const coreEps = shares ? coreNet / shares : null;

    /* --- how much of GAAP net income is non-operating --- */
    const nonOperating = ttmNet - ttmOp;
    const nonOperatingPctOfNet = ttmNet ? (nonOperating / ttmNet) * 100 : null;

    /* prior-year TTM conversion, for context on what "normal" looks like */
    const priorNet = sum(prior4, 'netIncome');
    const priorOp = sum(prior4, 'operatingIncome');
    const priorConversion = priorOp ? priorNet / priorOp : null;

    /* --- COLUMN 1: investments per share --- */
    const cashSTI = pick(bal, ['cashAndShortTermInvestments'], resolved, 'cashAndShortTermInvestments');
    const cash = pick(bal, ['cashAndCashEquivalents'], resolved, 'cashAndCashEquivalents');
    const sti = pick(bal, ['shortTermInvestments'], resolved, 'shortTermInvestments');
    const lti = pick(bal, ['longTermInvestments'], resolved, 'longTermInvestments');
    const totalDebt = pick(bal, ['totalDebt'], resolved, 'totalDebt');

    // avoid double counting: prefer the combined field when present
    const liquid = (cashSTI !== null) ? cashSTI : ((cash || 0) + (sti || 0));
    let investmentsGross = liquid + (lti || 0);
    let investmentsNet = investmentsGross - (totalDebt || 0);
    let capitalSource = 'FMP';
    if (xUsable && xCap.investments && xCap.investments.total != null) {
      investmentsGross = xCap.investments.total * 1e9;
      const fd = (xCap.capital.fundedDebt || 0) * 1e9;
      const fl = (xCap.capital.financeLeases || 0) * 1e9;
      const pf = (xCap.capital.preferred || 0) * 1e9;
      // operating leases deliberately excluded - they are commitments, not financing
      investmentsNet = investmentsGross - fd - fl - pf;
      capitalSource = 'XBRL';
    }
    const investmentsPerShare = shares ? investmentsGross / shares : null;
    const netInvestmentsPerShare = shares ? investmentsNet / shares : null;

    /* --- the three P/Es --- */
    const headlinePe = (price && ttmEps) ? price / ttmEps : null;
    const corePe = (price && coreEps) ? price / coreEps : null;
    const exInvestPrice = (price !== null && netInvestmentsPerShare !== null)
      ? price - netInvestmentsPerShare : null;
    const exInvestmentsPe = (exInvestPrice !== null && coreEps) ? exInvestPrice / coreEps : null;

    const divergencePct = (headlinePe && corePe) ? ((corePe - headlinePe) / headlinePe) * 100 : null;

    /* --- narrative notes explaining broker vs Buffett --- */
    const notes = [];
    if (nonOperatingPctOfNet !== null && nonOperatingPctOfNet > 15) {
      notes.push(
        `${nonOperatingPctOfNet.toFixed(0)}% of trailing GAAP net income came from below the operating line ` +
        `($${(nonOperating / 1e9).toFixed(1)}B). Broker P/E ratios (Yahoo, Schwab) divide price by GAAP EPS ` +
        `and therefore treat those gains as recurring earnings.`
      );
    }
    if (priorConversion !== null) {
      notes.push(
        `A year ago this company converted operating income to net income at ${priorConversion.toFixed(2)}x. ` +
        `Trailing twelve months it is ${ttmOp ? (ttmNet / ttmOp).toFixed(2) : 'n/a'}x - the gap is the distortion.`
      );
    }
    if (divergencePct !== null && Math.abs(divergencePct) > 25) {
      notes.push(
        `DIVERGENCE FLAG: core P/E is ${divergencePct > 0 ? 'higher' : 'lower'} than headline by ` +
        `${Math.abs(divergencePct).toFixed(0)}%. Score Margin of Safety on the core figure, not the headline.`
      );
    }
    if (investmentsPerShare) {
      notes.push(
        `Two-column view: you are paying $${price ? price.toFixed(2) : '?'} per share, of which roughly ` +
        `$${netInvestmentsPerShare.toFixed(2)} is investments and net cash. The operating business is therefore ` +
        `priced at $${exInvestPrice !== null ? exInvestPrice.toFixed(2) : '?'} against $${coreEps ? coreEps.toFixed(2) : '?'} ` +
        `of core earnings per share.`
      );
    }

    const payload = {
      symbol,
      price,
      sharesDilutedB: shares ? +(shares / 1e9).toFixed(3) : null,
      effectiveTaxRate: +(taxRate * 100).toFixed(1),

      headline: {
        label: 'Broker / GAAP TTM',
        ttmEps: +ttmEps.toFixed(2),
        ttmNetIncomeB: +(ttmNet / 1e9).toFixed(1),
        pe: headlinePe ? +headlinePe.toFixed(2) : null,
        basis: 'Trailing 12m GAAP diluted EPS. What Yahoo and Schwab display.',
      },

      core: {
        label: 'Core operating earnings',
        ttmOperatingIncomeB: +(ttmOp / 1e9).toFixed(1),
        ttmRevenueB: +(ttmRev / 1e9).toFixed(1),
        coreNetIncomeB: +(coreNet / 1e9).toFixed(1),
        coreEps: coreEps ? +coreEps.toFixed(2) : null,
        pe: corePe ? +corePe.toFixed(2) : null,
        basis: `Operating income taxed at ${(taxRate * 100).toFixed(1)}%. Excludes all non-operating items.`,
      },

      buffett: {
        label: 'Two-column (ex-investments)',
        investmentsPerShare: investmentsPerShare ? +investmentsPerShare.toFixed(2) : null,
        netInvestmentsPerShare: netInvestmentsPerShare ? +netInvestmentsPerShare.toFixed(2) : null,
        totalDebtB: totalDebt ? +(totalDebt / 1e9).toFixed(1) : null,
        operatingBusinessPrice: exInvestPrice !== null ? +exInvestPrice.toFixed(2) : null,
        pe: exInvestmentsPe ? +exInvestmentsPe.toFixed(2) : null,
        basis: 'Column 1 investments netted out of price; column 2 operating earnings priced on the remainder.',
      },

      nonOperating: {
        amountB: +(nonOperating / 1e9).toFixed(1),
        pctOfNetIncome: nonOperatingPctOfNet ? +nonOperatingPctOfNet.toFixed(1) : null,
        priorYearConversion: priorConversion ? +priorConversion.toFixed(2) : null,
        currentConversion: ttmOp ? +(ttmNet / ttmOp).toFixed(2) : null,
      },

      divergencePct: divergencePct ? +divergencePct.toFixed(1) : null,
      flag: (divergencePct !== null && Math.abs(divergencePct) > 25) ? 'EARNINGS_QUALITY_DIVERGENCE' : null,
      dataSource: {
        capital: capitalSource,
        operatingIncome: ttmOpX != null ? 'XBRL' : 'FMP',
        preferredDividendsDeductedB: +(prefDivs / 1e9).toFixed(2),
      },
      xbrl: xUsable ? {
        preferredB: xCap.capital.preferred,
        preferredBasis: xCap.capital.preferredBasis,
        fundedDebtB: xCap.capital.fundedDebt,
        financeLeasesB: xCap.capital.financeLeases,
        operatingLeasesExcludedB: xCap.capital.operatingLeases,
        investmentsB: xCap.investments.total,
        nonMarketableB: xCap.investments.nonMarketable,
        nonMarketablePctOfInvestments: xCap.investments.nonMarketablePctOfInvestments,
        asOf: xCap.asOf,
      } : null,
      xbrlWarnings: xCap
        ? (xCap.warnings || []).concat(xCap.usable ? [] : ['XBRL capital NOT usable - FMP fallback in use'])
        : ['XBRL unavailable - FMP fallback in use'],
      notes,
      quarters: quarters.slice(0, 8),
      _resolved: resolved,
      fetchedAt: new Date().toISOString(),
    };

    cache.set(symbol, { at: Date.now(), val: payload });
    res.set('Cache-Control', 'public, max-age=300');
    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: `valuation failed: ${e.message}` });
  }
});

export default router;
