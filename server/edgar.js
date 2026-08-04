/**
 * Intelligent Investor - SEC XBRL facts layer
 * Install to: /app/server/edgar.js
 *
 * Wire into server.js (2 lines):
 *   import edgarRouter from './edgar.js';
 *   app.use('/api/edgar', edgarRouter);
 *
 * WHY
 * ---
 * FMP is a convenience layer over primary sources and it drifts: it renamed
 * priceEarningsRatio, dropped returnOnEquity and freeCashFlowYield, bundles
 * finance leases into totalDebt, and reports preferredStock without terms.
 * The SEC's XBRL API returns the exact values as filed, with the accession
 * number and filing date attached. That is ground truth.
 *
 * This module makes XBRL the system of record for anything that appears in a
 * filing, keeps FMP as fallback, and flags disagreements between them.
 *
 * ENDPOINTS
 *   POST /api/edgar/sync?symbol=GOOG      pull companyfacts into Postgres
 *   GET  /api/edgar/capital?symbol=GOOG   capital structure, as filed
 *   GET  /api/edgar/coverage?symbol=GOOG  interest + preferred dividend coverage
 *   GET  /api/edgar/reconcile?symbol=GOOG XBRL vs FMP, with divergence flags
 *   GET  /api/edgar/fact?symbol=GOOG&concept=PreferredStockValue   raw history
 *   GET  /api/edgar/health
 *
 * SEC RULES: a User-Agent identifying the requester is mandatory, and the rate
 * limit is 10 requests/second. Both are respected below.
 */

import express from 'express';
import fetch from 'node-fetch';
import pg from 'pg';

const router = express.Router();

/* ---------- lazy config (ESM imports evaluate before dotenv.config()) ---------- */
const dbUrl = () => process.env.KB_DATABASE_URL || '';
const fmpKey = () => (process.env.FMP_API_KEY || '').trim();
const userAgent = () =>
  (process.env.SEC_USER_AGENT || 'Intelligent Investor jbdagostino@gmail.com').trim();

let pool = null;
function getPool() {
  if (!pool && dbUrl()) {
    pool = new pg.Pool({ connectionString: dbUrl(), max: 4, idleTimeoutMillis: 30000 });
    pool.on('error', (e) => console.error('edgar pool error:', e.message));
  }
  return pool;
}
async function q(text, params = []) {
  const p = getPool();
  if (!p) throw new Error('KB_DATABASE_URL not configured');
  return p.query(text, params);
}

const bad = (res, code, msg) => res.status(code).json({ error: msg });

/* ---------- schema (idempotent, created on first use) ---------- */
let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await q(`
    CREATE TABLE IF NOT EXISTS sec_tickers (
      ticker TEXT PRIMARY KEY,
      cik    TEXT NOT NULL,
      title  TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS xbrl_facts (
      id         BIGSERIAL PRIMARY KEY,
      cik        TEXT NOT NULL,
      ticker     TEXT,
      taxonomy   TEXT NOT NULL,
      concept    TEXT NOT NULL,
      unit       TEXT NOT NULL,
      start_date DATE,
      end_date   DATE NOT NULL,
      val        NUMERIC,
      fy         INT,
      fp         TEXT,
      form       TEXT,
      filed      DATE,
      accn       TEXT,
      frame      TEXT,
      UNIQUE (cik, concept, unit, start_date, end_date, accn)
    );
    CREATE INDEX IF NOT EXISTS idx_xbrl_lookup ON xbrl_facts (ticker, concept, end_date DESC);
    CREATE INDEX IF NOT EXISTS idx_xbrl_cik    ON xbrl_facts (cik, concept, end_date DESC);

    CREATE TABLE IF NOT EXISTS securities (
      cusip       TEXT PRIMARY KEY,
      ticker      TEXT,
      issuer_name TEXT,
      sec_type    TEXT,
      coupon      NUMERIC,
      maturity    TEXT,
      seniority   TEXT,
      notes       TEXT,
      verified    BOOLEAN DEFAULT false,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS xbrl_sync_log (
      ticker      TEXT PRIMARY KEY,
      cik         TEXT,
      entity_name TEXT,
      facts_rows  INT,
      synced_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  schemaReady = true;
}

/* ---------- SEC fetch with required headers + polite rate limit ---------- */
let lastCall = 0;
async function secFetch(url) {
  const gap = Date.now() - lastCall;
  if (gap < 120) await new Promise((r) => setTimeout(r, 120 - gap));
  lastCall = Date.now();
  const r = await fetch(url, {
    headers: {
      'User-Agent': userAgent(),
      'Accept-Encoding': 'gzip, deflate',
      'Host': new URL(url).host,
    },
    timeout: 45000,
  });
  if (!r.ok) throw new Error(`SEC ${r.status} on ${url.replace(/https:\/\/[^/]+/, '')}`);
  return r.json();
}

/* ---------- ticker -> CIK ---------- */
async function cikFor(ticker) {
  ticker = String(ticker).toUpperCase();
  await ensureSchema();

  const hit = await q('SELECT cik, title FROM sec_tickers WHERE ticker = $1', [ticker]);
  if (hit.rows.length) return hit.rows[0];

  // one-time load of the SEC ticker map (~1MB)
  const map = await secFetch('https://www.sec.gov/files/company_tickers.json');
  const rows = Object.values(map || {});
  if (!rows.length) throw new Error('SEC ticker map empty');

  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const b = i * 3;
    values.push(`($${b + 1},$${b + 2},$${b + 3})`);
    params.push(String(r.ticker).toUpperCase(), String(r.cik_str).padStart(10, '0'), r.title || null);
  });
  // insert in chunks to stay under parameter limits
  const CHUNK = 2000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const vs = [];
    const ps = [];
    slice.forEach((r, j) => {
      const b = j * 3;
      vs.push(`($${b + 1},$${b + 2},$${b + 3})`);
      ps.push(String(r.ticker).toUpperCase(), String(r.cik_str).padStart(10, '0'), r.title || null);
    });
    await q(
      `INSERT INTO sec_tickers (ticker, cik, title) VALUES ${vs.join(',')}
       ON CONFLICT (ticker) DO UPDATE SET cik = EXCLUDED.cik, title = EXCLUDED.title, updated_at = now()`,
      ps
    );
  }

  const again = await q('SELECT cik, title FROM sec_tickers WHERE ticker = $1', [ticker]);
  if (!again.rows.length) throw new Error(`ticker ${ticker} not found in SEC map`);
  return again.rows[0];
}

/* ---------- concepts we care about ---------- */
const CONCEPTS = new Set([
  // preferred
  'PreferredStockValue',
  'PreferredStockLiquidationPreferenceValue',
  'PreferredStockLiquidationPreference',
  'PreferredStockDividendsAndOtherAdjustments',
  'PreferredStockDividendRatePercentage',
  'PreferredStockDividendsPerShareDeclared',
  'PreferredStockSharesOutstanding',
  'TemporaryEquityCarryingAmountAttributableToParent',
  // debt
  'LongTermDebtNoncurrent', 'LongTermDebtCurrent', 'LongTermDebt',
  'DebtLongtermAndShorttermCombinedAmount', 'ShortTermBorrowings',
  'DebtCurrent',
  // leases
  'FinanceLeaseLiabilityNoncurrent', 'FinanceLeaseLiabilityCurrent',
  'OperatingLeaseLiabilityNoncurrent', 'OperatingLeaseLiabilityCurrent',
  // liquidity / investments
  'CashAndCashEquivalentsAtCarryingValue', 'ShortTermInvestments',
  'MarketableSecuritiesCurrent', 'MarketableSecuritiesNoncurrent',
  'LongTermInvestments', 'EquitySecuritiesFvNiCurrentAndNoncurrent',
  // earnings / coverage
  'OperatingIncomeLoss', 'InterestExpense', 'InterestExpenseDebt',
  'InterestExpenseNonoperating',
  'NetIncomeLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic',
  'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
  'IncomeTaxExpenseBenefit',
  'Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax',
  // shares
  'WeightedAverageNumberOfDilutedSharesOutstanding',
  'WeightedAverageNumberOfSharesOutstandingBasic',
  'CommonStockSharesOutstanding',
  // the gains that started all this
  'EquitySecuritiesFvNiUnrealizedGainLoss',
  'GainLossOnInvestments',
]);

/* ---------- sync ---------- */
async function doSync(symbol) {
  {
    await ensureSchema();

    const { cik, title } = await cikFor(symbol);
    const facts = await secFetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);

    const rows = [];
    for (const [taxonomy, concepts] of Object.entries(facts.facts || {})) {
      for (const [concept, def] of Object.entries(concepts || {})) {
        // store every concept; roles resolve at query time
        for (const [unit, entries] of Object.entries(def.units || {})) {
          if (!['USD', 'USD/shares', 'shares', 'pure'].includes(unit)) continue;
          for (const e of entries) {
            if (e.val == null || !e.end) continue;
            rows.push([cik, symbol, taxonomy, concept, unit, e.start || null, e.end,
                       e.val, e.fy || null, e.fp || null, e.form || null,
                       e.filed || null, e.accn || null, e.frame || null]);
          }
        }
      }
    }

    let inserted = 0;
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const vs = [];
      const ps = [];
      slice.forEach((r, j) => {
        const b = j * 14;
        vs.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14})`);
        ps.push(...r);
      });
      const out = await q(
        `INSERT INTO xbrl_facts
           (cik,ticker,taxonomy,concept,unit,start_date,end_date,val,fy,fp,form,filed,accn,frame)
         VALUES ${vs.join(',')}
         ON CONFLICT (cik, concept, unit, start_date, end_date, accn) DO NOTHING`,
        ps
      );
      inserted += out.rowCount || 0;
    }

    await q(
      `INSERT INTO xbrl_sync_log (ticker, cik, entity_name, facts_rows, synced_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (ticker) DO UPDATE SET cik=EXCLUDED.cik, entity_name=EXCLUDED.entity_name,
         facts_rows=EXCLUDED.facts_rows, synced_at=now()`,
      [symbol, cik, facts.entityName || title || null, rows.length]
    );

    const supported = rows.length > 0;
    return {
      synced: true, supported, symbol, cik,
      entityName: facts.entityName || title,
      factsSeen: rows.length, newRows: inserted,
      conceptsTracked: CONCEPTS.size,
      warning: supported ? null
        : 'Zero US-GAAP facts. Likely a foreign private issuer (20-F/6-K, IFRS taxonomy) '
          + 'or a non-reporting entity. UNSUPPORTED - do not score this ticker on XBRL.',
    };
  }
}

/** Sync only if never synced or older than maxAgeDays. */
export async function ensureSynced(symbol, maxAgeDays = 7) {
  await ensureSchema();
  const r = await q(
    `SELECT facts_rows, synced_at, (now() - synced_at) > ($2 || ' days')::interval AS stale
       FROM xbrl_sync_log WHERE ticker = $1`,
    [symbol, String(maxAgeDays)]
  );
  if (!r.rows.length) return { action: 'synced', ...(await doSync(symbol)) };
  if (r.rows[0].stale) return { action: 'refreshed', ...(await doSync(symbol)) };
  return { action: 'cached', supported: Number(r.rows[0].facts_rows) > 0,
           syncedAt: r.rows[0].synced_at };
}

router.post('/sync', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || req.body?.symbol || '').toUpperCase();
    if (!symbol) return bad(res, 400, 'symbol is required');
    res.json(await doSync(symbol));
  } catch (e) {
    bad(res, 502, `sync failed: ${e.message}`);
  }
});

/** Batch refresh - used by the nightly cron. */
router.post('/sync-batch', async (req, res) => {
  try {
    let symbols = req.body?.symbols;
    if (!Array.isArray(symbols) || !symbols.length) {
      const r = await q(`SELECT DISTINCT ticker FROM analyses
                          WHERE created_at > now() - interval '90 days'
                          UNION SELECT ticker FROM xbrl_sync_log`);
      symbols = r.rows.map((x) => x.ticker).filter(Boolean);
    }
    const out = [];
    for (const sym of symbols.slice(0, 50)) {
      try { out.push({ symbol: sym, ...(await ensureSynced(sym, Number(req.query.maxAgeDays) || 7)) }); }
      catch (e) { out.push({ symbol: sym, error: e.message }); }
      await new Promise((r) => setTimeout(r, 200));
    }
    res.json({ count: out.length, results: out,
               unsupported: out.filter((x) => x.supported === false).map((x) => x.symbol) });
  } catch (e) {
    bad(res, 502, `sync-batch failed: ${e.message}`);
  }
});

/* ---------- query helpers ---------- */

/** Latest instant (balance-sheet) value for a concept. */
/** Per-request fact loader. Treats anything older than maxAgeDays as MISSING
    rather than current, and records why. Prevents 2013 figures being served
    as if they were this quarter (Berkshire stopped tagging OperatingIncomeLoss
    in 2013 and CashAndCashEquivalentsAtCarryingValue in 2017). */
function makeLoader(ticker, maxAgeDays = 200) {
  const quality = { ok: [], stale: [], missing: [] };
  async function load(concepts) {
    const r = await q(
      `SELECT concept, val, end_date, form, filed, accn, unit
         FROM xbrl_facts
        WHERE ticker = $1 AND concept = ANY($2) AND start_date IS NULL
        ORDER BY end_date DESC, filed DESC LIMIT 1`,
      [ticker, concepts]
    );
    const row = r.rows[0];
    if (!row) { quality.missing.push(concepts[0]); return null; }
    const ageDays = Math.round((Date.now() - new Date(row.end_date).getTime()) / 86400000);
    if (ageDays > maxAgeDays) {
      quality.stale.push({ concept: row.concept,
        lastTagged: new Date(row.end_date).toISOString().slice(0, 10), ageDays });
      return null;
    }
    quality.ok.push(row.concept);
    return row;
  }
  return { load, quality };
}

async function latestInstant(ticker, concepts) {
  const r = await q(
    `SELECT concept, val, end_date, form, filed, accn, unit
       FROM xbrl_facts
      WHERE ticker = $1 AND concept = ANY($2) AND start_date IS NULL
      ORDER BY end_date DESC, filed DESC
      LIMIT 1`,
    [ticker, concepts]
  );
  return r.rows[0] || null;
}

/** Sum of the last N quarterly durations (~80-100 day spans) for a concept. */
/** TTM with Q4 derived from the annual filing. */
async function ttmDuration(ticker, concepts, n = 4) {
  const r = await q(
    `SELECT DISTINCT ON (start_date, end_date) concept, val, start_date, end_date, form, filed, fy, fp
       FROM xbrl_facts
      WHERE ticker = $1 AND concept = ANY($2) AND start_date IS NOT NULL
      ORDER BY start_date, end_date, filed DESC`,
    [ticker, concepts]
  );
  const dc = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  const quarters = [], annuals = [];
  for (const row of r.rows) {
    const d = dc(row.start_date, row.end_date);
    if (d >= 80 && d <= 100) quarters.push({ ...row, days: d, derived: false });
    else if (d >= 350 && d <= 380) annuals.push({ ...row, days: d });
  }
  for (const a of annuals) {
    const aS = new Date(a.start_date).getTime(), aE = new Date(a.end_date).getTime();
    const inside = quarters.filter((x) => {
      const st = new Date(x.start_date).getTime(), en = new Date(x.end_date).getTime();
      return st >= aS && en <= aE && !x.derived;
    });
    if (inside.length !== 3) continue;
    if (quarters.some((x) => x.derived && new Date(x.end_date).getTime() === aE)) continue;
    const sum3 = inside.reduce((acc, x) => acc + Number(x.val || 0), 0);
    const lastEnd = inside.map((x) => new Date(x.end_date).getTime()).sort((p, z) => z - p)[0];
    quarters.push({ concept: a.concept, val: Number(a.val || 0) - sum3,
      start_date: new Date(lastEnd + 86400000).toISOString().slice(0, 10),
      end_date: a.end_date, form: (a.form || '10-K') + ' (Q4 derived)',
      filed: a.filed, fy: a.fy, fp: 'Q4', days: 90, derived: true });
  }
  quarters.sort((x, y) => new Date(y.end_date) - new Date(x.end_date));
  const last = quarters.slice(0, n);
  if (last.length < n) return { value: null, quarters: last, complete: false };
  return { value: last.reduce((acc, x) => acc + Number(x.val || 0), 0), quarters: last,
           complete: true, derivedCount: last.filter((x) => x.derived).length };
}

/** Aggregate preferred claim. The liquidation preference is tagged PER SHARE
    (unit USD/shares), so it must be multiplied by shares outstanding. */
function preferredAggregate(prefLiq, prefVal, prefSharesRow) {
  const sh = prefSharesRow && prefSharesRow.val != null ? Number(prefSharesRow.val) : null;
  if (prefLiq && String(prefLiq.unit || '').includes('/shares'))
    return sh ? Number(prefLiq.val) * sh : 0;
  if (prefLiq) return Number(prefLiq.val || 0);
  if (prefVal) return Number(prefVal.val || 0);
  return 0;
}

const numOr = (row, d = null) => (row && row.val != null ? Number(row.val) : d);


/* ============================================================
   ROLE-BASED RESOLUTION
   Filers tag the same economics under different concepts, and change
   them over time. Alphabet files long-term investments as
   OtherLongTermInvestments; Berkshire abandoned OperatingIncomeLoss in
   2013. So we resolve ROLES against an ordered alias list, record which
   concept satisfied each role, and when a role cannot be filled we
   return ranked candidates from that company's own fact set.
   ============================================================ */
const ROLES = {
  CASH:                 ['CashAndCashEquivalentsAtCarryingValue'],
  SHORT_TERM_INV:       ['ShortTermInvestments', 'MarketableSecuritiesCurrent',
                         'AvailableForSaleSecuritiesCurrent',
                         'AvailableForSaleSecuritiesDebtSecuritiesCurrent'],
  CASH_AND_STI:         ['CashCashEquivalentsAndShortTermInvestments'],
  LONG_TERM_INV:        ['OtherLongTermInvestments', 'LongTermInvestments', 'MarketableSecuritiesNoncurrent',
                         'EquitySecuritiesFvNiAndWithoutReadilyDeterminableFairValue',
                         'EquitySecuritiesFvNiCurrentAndNoncurrent'],
  NON_MARKETABLE:       ['EquitySecuritiesWithoutReadilyDeterminableFairValueAmount'],
  LONG_TERM_DEBT:       ['LongTermDebtNoncurrent', 'LongTermDebt', 'NotesPayableAndOtherBorrowings'],
  CURRENT_DEBT:         ['LongTermDebtCurrent', 'DebtCurrent'],
  SHORT_TERM_BORROW:    ['ShortTermBorrowings', 'OtherShortTermBorrowings'],
  FINANCE_LEASE_NC:     ['FinanceLeaseLiabilityNoncurrent'],
  FINANCE_LEASE_C:      ['FinanceLeaseLiabilityCurrent'],
  OPERATING_LEASE_NC:   ['OperatingLeaseLiabilityNoncurrent'],
  OPERATING_LEASE_C:    ['OperatingLeaseLiabilityCurrent'],
  PREFERRED_LIQ_PREF:   ['PreferredStockLiquidationPreferenceValue', 'PreferredStockLiquidationPreference'],
  PREFERRED_VALUE:      ['PreferredStockValue'],
  PREFERRED_SHARES:     ['PreferredStockSharesOutstanding'],
  DILUTED_SHARES:       ['WeightedAverageNumberOfDilutedSharesOutstanding'],
  COMMON_SHARES:        ['CommonStockSharesOutstanding', 'EntityCommonStockSharesOutstanding',
                         'WeightedAverageNumberOfSharesOutstandingBasic'],
  TOTAL_ASSETS:         ['Assets'],
  TOTAL_EQUITY:         ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
};

/* substrings used to surface candidates when a role is unresolved */
const ROLE_HINTS = {
  LONG_TERM_INV:     ['%nvestment%', '%Securities%'],
  CASH_AND_STI:      ['%Cash%'],
  CASH:              ['%Cash%'],
  SHORT_TERM_INV:    ['%Marketable%', '%ShortTerm%'],
  LONG_TERM_DEBT:    ['%Debt%', '%Borrowing%', '%NotesPayable%'],
  CURRENT_DEBT:      ['%Debt%', '%Borrowing%'],
  PREFERRED_LIQ_PREF:['%Preferred%'],
  DILUTED_SHARES:    ['%SharesOutstanding%'],
  TOTAL_ASSETS:      ['Assets'],
};

/** First alias with a fresh instant value wins. */
async function resolveRole(ticker, aliases, maxAgeDays) {
  const r = await q(
    `SELECT concept, val, unit, end_date, form, filed, accn
       FROM xbrl_facts
      WHERE ticker = $1 AND concept = ANY($2) AND start_date IS NULL
        AND end_date > (now() - ($3 || ' days')::interval)
      ORDER BY array_position($2::text[], concept), end_date DESC, filed DESC
      LIMIT 1`,
    [ticker, aliases, String(maxAgeDays)]
  );
  return r.rows[0] || null;
}

/** Ranked candidate concepts from this company's own facts. */
async function candidatesFor(ticker, patterns, maxAgeDays, limit = 6) {
  if (!patterns || !patterns.length) return [];
  const r = await q(
    `SELECT DISTINCT ON (concept) concept, val, end_date
       FROM xbrl_facts
      WHERE ticker = $1 AND start_date IS NULL AND unit = 'USD'
        AND end_date > (now() - ($3 || ' days')::interval)
        AND concept ILIKE ANY($2)
      ORDER BY concept, end_date DESC`,
    [ticker, patterns, String(maxAgeDays)]
  );
  return r.rows
    .map((x) => ({ concept: x.concept, valueB: +(Number(x.val) / 1e9).toFixed(2),
                   asOf: new Date(x.end_date).toISOString().slice(0, 10) }))
    .sort((a, b) => Math.abs(b.valueB) - Math.abs(a.valueB))
    .slice(0, limit);
}

/* ---------- capital structure ---------- */
router.get('/capital', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase();
    if (!symbol) return bad(res, 400, 'symbol is required');
    await ensureSchema();
    const sync = await ensureSynced(symbol);
    if (sync.supported === false)
      return bad(res, 422, `${symbol} is UNSUPPORTED for XBRL. ${sync.warning || ''}`);

    const maxAge = Number(req.query.maxAgeDays) || 200;
    const R = {}, unresolved = [], resolution = {};
    for (const [role, aliases] of Object.entries(ROLES)) {
      const hit = await resolveRole(symbol, aliases, maxAge);
      R[role] = hit;
      if (hit) resolution[role] = { concept: hit.concept,
        asOf: new Date(hit.end_date).toISOString().slice(0, 10) };
      else unresolved.push(role);
    }

    const v  = (role) => (R[role] && R[role].val != null ? Number(R[role].val) : null);
    const v0 = (role) => v(role) || 0;

    let shares = v('DILUTED_SHARES') || v('COMMON_SHARES');
    if (!shares) {
      // duration fallback: WeightedAverageNumberOf...Shares are period facts,
      // so an instant-only lookup misses them entirely.
      const dr = await q(
        `SELECT concept, val, end_date FROM xbrl_facts
          WHERE ticker = $1 AND concept = ANY($2) AND start_date IS NOT NULL
            AND end_date > (now() - ($3 || ' days')::interval)
          ORDER BY end_date DESC, filed DESC LIMIT 1`,
        [symbol, ['WeightedAverageNumberOfDilutedSharesOutstanding',
                  'WeightedAverageNumberOfSharesOutstandingBasic'], String(maxAge)]
      );
      if (dr.rows[0]) {
        shares = Number(dr.rows[0].val);
        resolution.DILUTED_SHARES = {
          concept: dr.rows[0].concept + ' (duration fallback)',
          asOf: new Date(dr.rows[0].end_date).toISOString().slice(0, 10),
        };
        const i = unresolved.indexOf('DILUTED_SHARES');
        if (i >= 0) unresolved.splice(i, 1);
      }
    }

    let preferred = 0, preferredBasis = 'none';
    const pl = R['PREFERRED_LIQ_PREF'], ps = v('PREFERRED_SHARES');
    if (pl && String(pl.unit || '').includes('/shares')) {
      preferred = ps ? Number(pl.val) * ps : 0;
      preferredBasis = ps ? `$${Number(pl.val)}/share x ${ps} shares` : 'per-share pref, shares missing';
    } else if (pl) { preferred = Number(pl.val); preferredBasis = 'aggregate liquidation preference'; }
    else if (R['PREFERRED_VALUE']) { preferred = v('PREFERRED_VALUE'); preferredBasis = 'carrying value'; }

    const liquid = v('CASH_AND_STI') != null ? v('CASH_AND_STI') : (v0('CASH') + v0('SHORT_TERM_INV'));
    const investments = liquid + v0('LONG_TERM_INV');
    const fundedDebt = v0('LONG_TERM_DEBT') + v0('CURRENT_DEBT') + v0('SHORT_TERM_BORROW');
    const financeLeases = v0('FINANCE_LEASE_NC') + v0('FINANCE_LEASE_C');
    const operatingLeases = v0('OPERATING_LEASE_NC') + v0('OPERATING_LEASE_C');
    const assets = v('TOTAL_ASSETS');
    const nonMkt = v('NON_MARKETABLE');

    // sanity checks against the filer's own balance sheet
    const warnings = [];
    if (assets && investments > assets)
      warnings.push('Resolved investments exceed total assets - alias resolution is wrong.');
    if (assets && investments && investments / assets < 0.02)
      warnings.push('Resolved investments are under 2% of total assets - likely an unmapped concept.');
    if (!liquid) warnings.push('No cash concept resolved.');
    if (!shares) warnings.push('No share count resolved.');

    // when a critical role is unresolved, hand back ranked candidates
    const CRITICAL = ['CASH_AND_STI', 'CASH', 'LONG_TERM_INV', 'LONG_TERM_DEBT', 'DILUTED_SHARES', 'TOTAL_ASSETS'];
    const candidates = {};
    for (const role of unresolved) {
      if (!CRITICAL.includes(role)) continue;
      const c = await candidatesFor(symbol, ROLE_HINTS[role], maxAge);
      if (c.length) candidates[role] = c;
    }

    const usable = !!liquid && !!shares && warnings.length === 0;
    const B = (x) => (x == null ? null : +(x / 1e9).toFixed(2));
    const netToCommon = investments - fundedDebt - financeLeases - preferred;

    res.json({
      symbol,
      usable,
      asOf: R['CASH_AND_STI'] || R['CASH']
        ? new Date((R['CASH_AND_STI'] || R['CASH']).end_date).toISOString().slice(0, 10) : null,
      source: 'SEC XBRL (as filed), resolved by role',
      capital: {
        fundedDebt: B(fundedDebt), financeLeases: B(financeLeases),
        operatingLeases: B(operatingLeases), preferred: B(preferred), preferredBasis,
        totalDebtLike: B(fundedDebt + financeLeases + preferred),
      },
      investments: {
        liquid: B(liquid), longTerm: B(v('LONG_TERM_INV')), total: B(investments),
        nonMarketable: B(nonMkt),
        nonMarketablePctOfInvestments: (nonMkt && investments)
          ? +((nonMkt / investments) * 100).toFixed(1) : null,
        nonMarketableNote: nonMkt
          ? 'No observable market price - carried at management estimate. Unrealised gains on these '
            + 'flow through GAAP net income but are not cash and not repeatable.'
          : null,
      },
      totalAssets: B(assets),
      netToCommon: B(netToCommon),
      sharesDilutedB: shares ? +(shares / 1e9).toFixed(3) : null,
      netToCommonPerShare: shares ? +(netToCommon / shares).toFixed(2) : null,
      resolution,
      unresolvedRoles: unresolved,
      candidates,
      warnings,
      note: Object.keys(candidates).length
        ? 'One or more critical roles are unmapped. `candidates` lists concepts this filer actually '
          + 'tags, ranked by size - add the right one to the ROLES alias list.'
        : 'All critical roles resolved from current filings.',
    });
  } catch (e) {
    bad(res, 500, `capital failed: ${e.message}`);
  }
});

/* ---------- coverage (the number that matters for preferreds) ---------- */
router.get('/coverage', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase();
    if (!symbol) return bad(res, 400, 'symbol is required');
    await ensureSchema();

    const [ebit, interest, prefDivs, netInc, availCommon] = await Promise.all([
      ttmDuration(symbol, ['OperatingIncomeLoss']),
      ttmDuration(symbol, ['InterestExpense', 'InterestExpenseDebt', 'InterestExpenseNonoperating']),
      ttmDuration(symbol, ['PreferredStockDividendsAndOtherAdjustments']),
      ttmDuration(symbol, ['NetIncomeLoss']),
      ttmDuration(symbol, ['NetIncomeLossAvailableToCommonStockholdersBasic']),
    ]);

    const newest = ebit.quarters[0] ? ebit.quarters[0].end_date : null;
    const ageDays = newest ? Math.round((Date.now() - new Date(newest).getTime()) / 86400000) : null;
    if (!ebit.complete || ageDays === null || ageDays > 200) {
      return res.status(422).json({
        symbol, usable: false,
        reason: !ebit.complete
          ? 'Fewer than 4 quarterly OperatingIncomeLoss periods available.'
          : `Newest OperatingIncomeLoss period ends ${new Date(newest).toISOString().slice(0, 10)} (${ageDays} days old).`,
        guidance: 'This filer does not report a current operating-income line. Insurers, banks and '
          + 'holding companies (e.g. Berkshire) commonly do not. Core-earnings and coverage ratios '
          + 'built on operating income DO NOT APPLY here - do not score this name on them.',
        newestPeriod: newest ? new Date(newest).toISOString().slice(0, 10) : null,
      });
    }
    const E = ebit.value;
    const I = interest.value || 0;
    const P = prefDivs.value || 0;

    const round = (v) => (v == null || !isFinite(v) ? null : +v.toFixed(2));
    const B = (v) => (v == null ? null : +(v / 1e9).toFixed(2));

    const interestCoverage = (E != null && I > 0) ? E / I : null;
    const fixedChargeCoverage = (E != null && (I + P) > 0) ? E / (I + P) : null;
    const prefDivCoverage = (E != null && P > 0) ? (E - I) / P : null;

    const warnings = [];
    if (P > 0 && fixedChargeCoverage != null && fixedChargeCoverage < 2)
      warnings.push('Fixed charge coverage below 2x - preferred dividend has limited cushion.');
    if (P === 0 && prefDivs.quarters.length === 0)
      warnings.push('No PreferredStockDividendsAndOtherAdjustments tagged. If a preferred exists, ' +
                    'dividends may be disclosed in narrative text only - check the filing.');
    if (!ebit.complete)
      warnings.push('Fewer than 4 quarterly periods available; TTM figures incomplete.');

    res.json({
      symbol,
      ttm: {
        operatingIncomeB: B(E),
        interestExpenseB: B(I),
        preferredDividendsB: B(P),
        netIncomeB: B(netInc.value),
        netIncomeAvailableToCommonB: B(availCommon.value),
      },
      coverage: {
        interestCoverage: round(interestCoverage),
        fixedChargeCoverage: round(fixedChargeCoverage),
        preferredDividendCoverage: round(prefDivCoverage),
      },
      complete: ebit.complete,
      warnings,
      periods: ebit.quarters.map((r) => ({ start: r.start_date, end: r.end_date, form: r.form })),
      note: 'fixedChargeCoverage = EBIT / (interest + preferred dividends). This is the ratio that ' +
            'determines whether a preferred dividend is safe, not P/E.',
    });
  } catch (e) {
    bad(res, 500, `coverage failed: ${e.message}`);
  }
});


/* ============================================================
   CUSIP -> ISSUER MAPPING
   Bonds and hybrids are held by CUSIP, not ticker. XBRL is filed per
   issuer, so a CUSIP must resolve to the parent's ticker before any
   analysis is possible. There is no free CUSIP API, so this is a table
   you extend. Seeded entries are marked verified=false until confirmed
   against a statement or prospectus.
   ============================================================ */
const SEED_SECURITIES = [
  ['381427AA1', 'GS',  'Goldman Sachs Capital (trust of Goldman Sachs Group)',
   'junior subordinated', null, '2056-05-15', 'junior subordinated',
   'Variable rate. Trust-preferred style; parent GS. VERIFY issuer entity.'],
  ['17327CBC6', 'C',   'Citigroup Inc',
   'junior subordinated', 6.875, '2095-07-23', 'junior subordinated',
   'Ultra-long dated, effectively perpetual. Coupon deferrable.'],
  ['06055HAK9', 'BAC', 'Bank of America Corp',
   'junior subordinated', 6.25, '2074-07-24', 'junior subordinated',
   'Ultra-long dated. Coupon deferrable.'],
  ['48128AAJ2', 'JPM', 'JPMorgan Chase & Co',
   'junior subordinated', 6.5, '2049-12-31', 'junior subordinated',
   '12/31/49 is the perpetual convention - treat as perpetual.'],
];

async function seedSecurities() {
  for (const r of SEED_SECURITIES) {
    await q(
      `INSERT INTO securities (cusip,ticker,issuer_name,sec_type,coupon,maturity,seniority,notes,verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)
       ON CONFLICT (cusip) DO NOTHING`, r);
  }
}

router.get('/resolve', async (req, res) => {
  try {
    await ensureSchema(); await seedSecurities();
    const cusip = String(req.query.cusip || '').toUpperCase().trim();
    if (!cusip) return bad(res, 400, 'cusip is required');
    const r = await q('SELECT * FROM securities WHERE cusip = $1', [cusip]);
    if (!r.rows.length)
      return res.status(404).json({ error: `CUSIP ${cusip} not mapped`,
        action: 'POST /api/edgar/securities with {cusip,ticker,issuerName,...} to add it.' });
    res.json(r.rows[0]);
  } catch (e) { bad(res, 500, e.message); }
});

router.get('/securities', async (req, res) => {
  try {
    await ensureSchema(); await seedSecurities();
    const r = await q('SELECT * FROM securities ORDER BY ticker, cusip');
    res.json({ count: r.rows.length, securities: r.rows,
      note: 'verified=false means the mapping was seeded by inference. Confirm against your statement.' });
  } catch (e) { bad(res, 500, e.message); }
});

router.post('/securities', async (req, res) => {
  try {
    await ensureSchema();
    const b = req.body || {};
    if (!b.cusip) return bad(res, 400, 'cusip is required');
    await q(
      `INSERT INTO securities (cusip,ticker,issuer_name,sec_type,coupon,maturity,seniority,notes,verified,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (cusip) DO UPDATE SET ticker=EXCLUDED.ticker, issuer_name=EXCLUDED.issuer_name,
         sec_type=EXCLUDED.sec_type, coupon=EXCLUDED.coupon, maturity=EXCLUDED.maturity,
         seniority=EXCLUDED.seniority, notes=EXCLUDED.notes, verified=EXCLUDED.verified, updated_at=now()`,
      [String(b.cusip).toUpperCase(), b.ticker || null, b.issuerName || null, b.secType || null,
       b.coupon ?? null, b.maturity || null, b.seniority || null, b.notes || null, !!b.verified]);
    res.json({ saved: true, cusip: String(b.cusip).toUpperCase() });
  } catch (e) { bad(res, 500, e.message); }
});

/* ============================================================
   FINANCIAL-ISSUER COVERAGE
   Banks and insurers report no OperatingIncomeLoss, so EBIT-based
   coverage cannot be computed. For a bank, interest expense on deposits
   is a cost of doing business, not a fixed charge. The meaningful test
   for preferred and junior subordinated holders is earnings coverage of
   the preferred dividend, plus regulatory capital - because a regulator
   can block distributions even when earnings look fine.
   ============================================================ */
router.get('/coverage-financial', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase();
    if (!symbol) return bad(res, 400, 'symbol is required');
    await ensureSchema();
    const sync = await ensureSynced(symbol);
    if (sync.supported === false) return bad(res, 422, `${symbol} UNSUPPORTED. ${sync.warning || ''}`);

    const [pretax, netInc, prefDivs, interest, availCommon] = await Promise.all([
      ttmDuration(symbol, ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
                           'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments']),
      ttmDuration(symbol, ['NetIncomeLoss']),
      ttmDuration(symbol, ['PreferredStockDividendsAndOtherAdjustments']),
      ttmDuration(symbol, ['InterestExpense']),
      ttmDuration(symbol, ['NetIncomeLossAvailableToCommonStockholdersBasic']),
    ]);

    let cet1 = await latestInstant(symbol, ['CommonEquityTierOneCapitalToRiskWeightedAssets',
                                            'TierOneRiskBasedCapitalToRiskWeightedAssets']);
    let cet1Note = null;
    if (cet1) {
      const age = Math.round((Date.now() - new Date(cet1.end_date).getTime()) / 86400000);
      if (age > 400) {
        cet1Note = `Newest tagged capital ratio (${cet1.concept}) is from `
          + `${new Date(cet1.end_date).toISOString().slice(0, 10)}, ${age} days old - DISCARDED. `
          + 'Banks report current capital ratios in exhibits, not XBRL. Check the 10-Q directly.';
        cet1 = null;
      }
    } else {
      cet1Note = 'No regulatory capital ratio tagged in XBRL. Check the filing directly - '
        + 'capital, not earnings, is the binding constraint on deferrable bank distributions.';
    }

    const P = pretax.value, N = netInc.value;
    let D = prefDivs.value || 0;
    let dSource = 'tagged (PreferredStockDividendsAndOtherAdjustments)';
    if (!D && N != null && availCommon.value != null) {
      // GS, C and JPM do not tag preferred dividends directly, but the gap
      // between net income and net income available to common IS the preferred
      // dividend. Verified against BAC, which tags both and agrees.
      const derived = N - availCommon.value;
      if (derived > 0) { D = derived; dSource = 'derived (net income - net income available to common)'; }
    }
    if (P == null && N == null)
      return res.status(422).json({ symbol, usable: false,
        reason: 'Neither pre-tax nor net income resolvable for 4 quarters.' });

    const B = (x) => (x == null ? null : +(x / 1e9).toFixed(2));
    const rnd = (x) => (x == null || !isFinite(x) ? null : +x.toFixed(2));

    const covPretax = (P != null && D > 0) ? P / D : null;
    const covNet = (N != null && D > 0) ? N / D : null;

    const warnings = [];
    if (D === 0) warnings.push('No preferred dividends tagged - either none outstanding, or disclosed only in narrative text.');
    if (covNet != null && covNet < 3) warnings.push('Net income covers preferred dividends less than 3x - thin.');
    if (N != null && N < 0) warnings.push('Negative net income - preferred dividend not covered by earnings.');
    warnings.push('Junior subordinated and trust-preferred coupons are DEFERRABLE. Regulatory capital, '
      + 'not earnings, is usually the binding constraint on bank distributions.');

    res.json({
      symbol, usable: true, method: 'financial-issuer (earnings coverage of preferred)',
      ttm: {
        pretaxIncomeB: B(P), netIncomeB: B(N), preferredDividendsB: B(D),
        interestExpenseB: B(interest.value), netIncomeToCommonB: B(availCommon.value),
      },
      coverage: {
        preferredCoveragePretax: rnd(covPretax),
        preferredCoverageNet: rnd(covNet),
      },
      regulatoryCapitalNote: cet1Note,
      regulatoryCapital: cet1 ? {
        concept: cet1.concept, value: Number(cet1.val),
        asOf: new Date(cet1.end_date).toISOString().slice(0, 10),
      } : null,
      complete: pretax.complete || netInc.complete,
      warnings,
      note: 'EBIT-based fixed-charge coverage is NOT meaningful for a bank - deposit interest is an '
        + 'operating cost, not a financing charge. Use these ratios instead.',
    });
  } catch (e) {
    bad(res, 500, `coverage-financial failed: ${e.message}`);
  }
});


/* ============================================================
   CASH-FLOW COVERAGE
   Cash flow statements are reported YEAR TO DATE, not per quarter, so a
   naive "sum the last four 90-day periods" is wrong - it would add four
   Q1s from four different years. TTM is rolled instead:
       TTM = FY(prior) + YTD(current) - YTD(prior year, same length)

   This answers the question earnings coverage cannot: is the dividend
   paid out of cash the business generates, or out of new issuance?
   ============================================================ */
async function ttmCashFlow(ticker, concepts) {
  const r = await q(
    `SELECT DISTINCT ON (start_date, end_date) concept, val, start_date, end_date, form, filed
       FROM xbrl_facts
      WHERE ticker = $1 AND concept = ANY($2) AND start_date IS NOT NULL
      ORDER BY start_date, end_date, filed DESC`,
    [ticker, concepts]
  );
  if (!r.rows.length) return { value: null, method: 'no data' };
  const dd = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  const R = r.rows.map((x) => ({ ...x, d: dd(x.start_date, x.end_date),
                                 e: new Date(x.end_date).getTime() }));
  const q90 = R.filter((x) => x.d >= 80 && x.d <= 100).sort((a, b) => b.e - a.e);
  const ann = R.filter((x) => x.d >= 350 && x.d <= 380).sort((a, b) => b.e - a.e);
  const ytd = R.filter((x) => x.d > 100 && x.d < 350).sort((a, b) => b.e - a.e);

  // True quarterly series: four CONSECUTIVE quarters. Testing only that the
  // durations total ~365 days is not enough - four Q1s from four different
  // years also total 356. The calendar span from earliest start to latest end
  // must itself be about one year.
  const iso = (x) => new Date(x).toISOString().slice(0, 10);
  if (q90.length >= 4) {
    const last4 = q90.slice(0, 4);
    const starts = last4.map((x) => new Date(x.start_date).getTime());
    const ends = last4.map((x) => x.e);
    const span = Math.round((Math.max(...ends) - Math.min(...starts)) / 86400000);
    const sumd = last4.reduce((a, x) => a + x.d, 0);
    if (span >= 330 && span <= 400 && sumd >= 330 && sumd <= 400) {
      return { value: last4.reduce((a, x) => a + Number(x.val), 0),
               method: 'sum of 4 consecutive quarters',
               periods: last4.map((x) => `${iso(x.start_date)}..${iso(x.end_date)}`) };
    }
  }
  // YTD roll
  if (ytd.length && ann.length) {
    const cur = ytd[0];
    const fy = ann.find((x) => x.e < cur.e);
    const pr = ytd.find((x) => Math.abs(x.d - cur.d) <= 12 && x.e < cur.e - 300 * 86400000);
    if (fy && pr) {
      return { value: Number(fy.val) + Number(cur.val) - Number(pr.val),
               method: 'FY(prior) + YTD(current) - YTD(prior year)',
               periods: [`FY ${iso(fy.start_date)}..${iso(fy.end_date)}`,
                         `YTD ${iso(cur.start_date)}..${iso(cur.end_date)}`,
                         `YTD ${iso(pr.start_date)}..${iso(pr.end_date)}`] };
    }
  }
  if (ann.length) return { value: Number(ann[0].val), method: 'latest full year (NOT trailing twelve months)',
                           periods: [`${iso(ann[0].start_date)}..${iso(ann[0].end_date)}`] };
  return { value: null, method: 'insufficient periods' };
}

router.get('/coverage-cash', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase();
    if (!symbol) return bad(res, 400, 'symbol is required');
    await ensureSchema();
    const sync = await ensureSynced(symbol);
    if (sync.supported === false) return bad(res, 422, `${symbol} UNSUPPORTED. ${sync.warning || ''}`);

    const [ocf, prefPaid, prefIssued, commonIssued, debtIssued, capex] = await Promise.all([
      ttmCashFlow(symbol, ['NetCashProvidedByUsedInOperatingActivities',
                           'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations']),
      ttmCashFlow(symbol, ['PaymentsOfDividendsPreferredStockAndPreferenceStock',
                           'PaymentsOfDividendsPreferredStock']),
      ttmCashFlow(symbol, ['ProceedsFromIssuanceOfPreferredStockAndPreferenceStock']),
      ttmCashFlow(symbol, ['ProceedsFromIssuanceOfCommonStock']),
      ttmCashFlow(symbol, ['ProceedsFromIssuanceOfLongTermDebt', 'ProceedsFromIssuanceOfSeniorLongTermDebt']),
      ttmCashFlow(symbol, ['PaymentsToAcquirePropertyPlantAndEquipment']),
    ]);

    let D = prefPaid.value;
    let dSource = prefPaid.method;
    if (D == null) {
      const [ni, nic] = await Promise.all([
        ttmDuration(symbol, ['NetIncomeLoss']),
        ttmDuration(symbol, ['NetIncomeLossAvailableToCommonStockholdersBasic']),
      ]);
      if (ni.value != null && nic.value != null && ni.value - nic.value > 0) {
        D = ni.value - nic.value;
        dSource = 'derived from income statement (net income - available to common); '
          + 'NOT tagged in the cash flow statement';
      }
    }
    const O = ocf.value, I = prefIssued.value;
    const M = (x) => (x == null ? null : +(x / 1e6).toFixed(0));
    const rnd = (x) => (x == null || !isFinite(x) ? null : +x.toFixed(2));

    const cov = (O != null && D) ? O / D : null;
    const gap = (O != null && D != null) ? D - O : null;

    // A bank's operating cash flow moves with trading assets, loan growth and
    // deposit flows - it is not distributable earnings. Applying a funding
    // verdict to it produces a false alarm, so detect and suppress.
    const opInc = await ttmDuration(symbol, ['OperatingIncomeLoss']);
    const isFinancialStyle = !opInc.complete;

    const flags = [];
    let verdict = 'not applicable';
    if (isFinancialStyle) {
      verdict = 'not meaningful for this issuer type';
      flags.push('This issuer reports no current operating income line, i.e. a bank, insurer or '
        + 'similar. Operating cash flow at such issuers swings with trading assets, loan growth and '
        + 'deposit flows and is NOT a measure of distributable earnings. Negative operating cash flow '
        + 'here is balance-sheet mechanics, not distress. Use /coverage-financial (earnings coverage '
        + 'of the preferred dividend) plus regulatory capital instead.');
    } else if (D) {
      if (O == null) verdict = 'operating cash flow unavailable';
      else if (O <= 0) {
        verdict = 'DIVIDEND NOT FUNDED BY OPERATIONS';
        flags.push('Operating cash flow is zero or negative while preferred dividends are being paid.');
      } else if (cov < 1) {
        verdict = 'PARTIALLY FUNDED BY OPERATIONS';
        flags.push(`Operating cash flow covers only ${(cov * 100).toFixed(0)}% of preferred dividends paid.`);
      } else if (cov < 2) { verdict = 'thinly funded by operations'; }
      else { verdict = 'funded by operations'; }

      if (I != null && D && I > D * 2 && (O == null || O < D)) {
        flags.push(`Preferred issuance proceeds of $${(I / 1e9).toFixed(2)}B against $${(D / 1e6).toFixed(0)}M `
          + 'of preferred dividends paid, with operations not covering the dividend. '
          + 'The distribution is being funded from new capital, not from the business. '
          + 'That depends on continued market access.');
      }
    } else {
      flags.push('No preferred dividend payments tagged in the cash flow statement.');
    }

    res.json({
      symbol, usable: true, verdict,
      meaningful: !isFinancialStyle,
      issuerStyle: isFinancialStyle ? 'financial (no operating income line)' : 'operating company',
      ttmMillions: {
        operatingCashFlow: M(O),
        preferredDividendsPaid: M(D),
        preferredIssuanceProceeds: M(I),
        commonIssuanceProceeds: M(commonIssued.value),
        debtIssuanceProceeds: M(debtIssued.value),
        capex: M(capex.value),
      },
      ratios: {
        ocfCoverageOfPreferredDividends: rnd(cov),
        fundingGapMillions: M(gap),
        preferredIssuanceToDividends: (I != null && D) ? rnd(I / D) : null,
      },
      derivation: {
        operatingCashFlow: ocf.method, periods: ocf.periods || null,
        preferredDividendsPaid: dSource,
        preferredIssuance: prefIssued.method,
      },
      flags,
      note: 'Cash flow items are filed year-to-date, so TTM is rolled as FY(prior) + YTD(current) '
        + '- YTD(prior year). This is the test earnings coverage cannot make: whether the '
        + 'distribution comes out of the business or out of new issuance.',
    });
  } catch (e) {
    bad(res, 500, `coverage-cash failed: ${e.message}`);
  }
});

/* ---------- reconciliation: XBRL vs FMP ---------- */
router.get('/reconcile', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase();
    if (!symbol) return bad(res, 400, 'symbol is required');
    if (!fmpKey()) return bad(res, 500, 'FMP_API_KEY not configured');
    await ensureSchema();

    const { load } = makeLoader(symbol, 200);
    const qs = new URLSearchParams({ symbol, period: 'quarter', limit: '1', apikey: fmpKey() });
    const fr = await fetch(`https://financialmodelingprep.com/stable/balance-sheet-statement?${qs}`, { timeout: 15000 });
    const fj = await fr.json();
    const fmpBal = (Array.isArray(fj) ? fj[0] : fj) || {};

    const [prefVal, ltdNon, ltdCur, finNon, finCur, cash] = await Promise.all([
      load(['PreferredStockValue']),
      load(['LongTermDebtNoncurrent']),
      load(['LongTermDebtCurrent', 'DebtCurrent']),
      load(['FinanceLeaseLiabilityNoncurrent']),
      load(['FinanceLeaseLiabilityCurrent']),
      load(['CashAndCashEquivalentsAtCarryingValue']),
    ]);

    const xFunded = numOr(ltdNon, 0) + numOr(ltdCur, 0);
    const xLeases = numOr(finNon, 0) + numOr(finCur, 0);
    const prefLiqR = await latestInstant(symbol, ['PreferredStockLiquidationPreferenceValue', 'PreferredStockLiquidationPreference']);
    const prefShR = await latestInstant(symbol, ['PreferredStockSharesOutstanding']);
    const xPref = preferredAggregate(prefLiqR, prefVal, prefShR);
    const xCash = numOr(cash, 0);

    const cmp = (label, xbrl, fmp, tolPct = 2) => {
      const diff = (xbrl != null && fmp != null) ? xbrl - fmp : null;
      const pct = (diff != null && fmp) ? (diff / Math.abs(fmp)) * 100 : null;
      return {
        label,
        xbrlB: xbrl == null ? null : +(xbrl / 1e9).toFixed(2),
        fmpB: fmp == null ? null : +(fmp / 1e9).toFixed(2),
        diffB: diff == null ? null : +(diff / 1e9).toFixed(2),
        diffPct: pct == null ? null : +pct.toFixed(1),
        flag: (pct != null && Math.abs(pct) > tolPct) ? 'DIVERGENT' : 'ok',
      };
    };

    const checks = [
      cmp('preferred', xPref, fmpBal.preferredStock),
      cmp('fundedDebt (excl leases)', xFunded, fmpBal.longTermDebt),
      cmp('financeLeases', xLeases, fmpBal.capitalLeaseObligations),
      cmp('totalDebt (funded + leases)', xFunded + xLeases, fmpBal.totalDebt),
      cmp('cash', xCash, fmpBal.cashAndCashEquivalents),
    ];

    res.json({
      symbol,
      xbrlAsOf: (prefVal || ltdNon || cash || {}).end_date || null,
      fmpAsOf: fmpBal.date || null,
      checks,
      divergent: checks.filter((c) => c.flag === 'DIVERGENT').map((c) => c.label),
      note: 'XBRL is as-filed and authoritative. Where these disagree, trust XBRL and treat the ' +
            'FMP-derived score as suspect.',
    });
  } catch (e) {
    bad(res, 502, `reconcile failed: ${e.message}`);
  }
});

/* ---------- raw fact history ---------- */
router.get('/fact', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase();
    const concept = String(req.query.concept || '');
    if (!symbol || !concept) return bad(res, 400, 'symbol and concept are required');
    await ensureSchema();
    const r = await q(
      `SELECT concept, unit, start_date, end_date, val, fy, fp, form, filed, accn
         FROM xbrl_facts WHERE ticker = $1 AND concept = $2
        ORDER BY end_date DESC, filed DESC LIMIT 40`,
      [symbol, concept]
    );
    res.json({ symbol, concept, rows: r.rows });
  } catch (e) {
    bad(res, 500, `fact failed: ${e.message}`);
  }
});

router.get('/health', async (req, res) => {
  try {
    await ensureSchema();
    const r = await q(`SELECT
      (SELECT count(*) FROM xbrl_facts)   AS facts,
      (SELECT count(*) FROM sec_tickers)  AS tickers,
      (SELECT count(*) FROM xbrl_sync_log) AS synced`);
    res.json({ status: 'ok', userAgent: userAgent(), counts: r.rows[0] });
  } catch (e) {
    bad(res, 500, `edgar unavailable: ${e.message}`);
  }
});

export default router;
