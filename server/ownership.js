/**
 * Insider ownership from DEF 14A proxy statements.
 * Install: /app/server/ownership.js   (requires: npm install cheerio)
 * Wire:    import ownershipRouter from './ownership.js';
 *          app.use('/api/ownership', ownershipRouter);
 *
 * WHY THIS EXISTS
 * Insider ownership percentage is not in XBRL and is not a standard FMP
 * field. It lives in the "Security Ownership of Certain Beneficial Owners
 * and Management" table of the annual proxy (DEF 14A) - formatted HTML,
 * not tagged data. Without this the app fills the number from a model,
 * and criterion 2 (Management Credibility, 15pts) scores on a guess.
 *
 * The number that matters is the "all directors and executive officers as
 * a group" row. This finds it, stores it with the accession number and a
 * link, and returns the raw row text so any figure is auditable.
 *
 * ENDPOINTS
 *   GET /api/ownership/insider?symbol=GOOG[&refresh=1]
 *   GET /api/ownership/cached
 */

import express from 'express';
import fetch from 'node-fetch';
import { load } from 'cheerio';
import pg from 'pg';

const router = express.Router();
const dbUrl = () => process.env.KB_DATABASE_URL || '';
const ua = () => (process.env.SEC_USER_AGENT || 'Intelligent Investor jbdagostino@gmail.com').trim();

let pool = null;
function getPool() {
  if (!pool && dbUrl()) { pool = new pg.Pool({ connectionString: dbUrl(), max: 3 }); pool.on('error', e => console.error('own pool', e.message)); }
  return pool;
}
async function q(t, p = []) { const x = getPool(); if (!x) throw new Error('KB_DATABASE_URL not configured'); return x.query(t, p); }
const bad = (res, c, m) => res.status(c).json({ error: m });

let ready = false;
async function ensureSchema() {
  if (ready) return;
  await q(`CREATE TABLE IF NOT EXISTS proxy_ownership (
    ticker TEXT PRIMARY KEY, cik TEXT, accession TEXT, filed DATE, doc_url TEXT,
    group_pct NUMERIC, group_shares NUMERIC, row_text TEXT, confidence TEXT,
    parsed_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  ready = true;
}

let last = 0;
async function sec(url, asJson) {
  const gap = Date.now() - last; if (gap < 130) await new Promise(r => setTimeout(r, 130 - gap));
  last = Date.now();
  const r = await fetch(url, { headers: { 'User-Agent': ua(), 'Accept-Encoding': 'gzip, deflate' }, timeout: 45000 });
  if (!r.ok) throw new Error(`SEC ${r.status} on ${url.slice(0, 90)}`);
  return asJson ? r.json() : r.text();
}

async function cikFor(ticker) {
  const r = await q('SELECT cik FROM sec_tickers WHERE ticker = $1', [ticker]);
  if (!r.rows.length) throw new Error(`${ticker} not in sec_tickers - run /api/edgar/sync first`);
  return r.rows[0].cik;
}

/** Most recent DEF 14A (falls back to DEFA14A / 10-K if absent). */
async function latestProxy(cik) {
  const j = await sec(`https://data.sec.gov/submissions/CIK${cik}.json`, true);
  const R = j.filings && j.filings.recent;
  if (!R) throw new Error('no filings index');
  const want = ['DEF 14A', 'DEFM14A', 'DEFA14A'];
  for (const form of want) {
    for (let i = 0; i < R.form.length; i++) {
      if (R.form[i] === form) {
        return { accession: R.accessionNumber[i], filed: R.filingDate[i],
                 doc: R.primaryDocument[i], form };
      }
    }
  }
  throw new Error('no DEF 14A found in recent filings');
}

const NUM = (s) => { const m = String(s).replace(/[^\d.]/g, ''); const v = parseFloat(m); return isFinite(v) ? v : null; };

/** Locate the "all directors and executive officers as a group" row. */
function extractGroupRow(html) {
  const $ = load(html);
  const hits = [];
  $('tr').each((_, tr) => {
    const cells = $(tr).find('td,th').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
    const text = cells.join(' | ');
    const t = text.toLowerCase();
    const isGroup = /\bgroup\b/.test(t) &&
      /(all\s+)?(current\s+)?(directors|executive officers|named executive officers)/.test(t);
    if (!isGroup) return;
    // numbers that look like a percentage, and numbers that look like a share count
    let pct = null, shares = null;
    for (const c of cells) {
      const pm = c.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
      if (pm && pct == null) pct = parseFloat(pm[1]);
      if (/^\*+$/.test(c.trim()) && pct == null) pct = 0.5;      // "*" = less than 1%
    }
    if (pct == null) {
      // some proxies put the percent in a bare cell after the share count
      const nums = cells.map(NUM).filter(v => v != null);
      const small = nums.filter(v => v > 0 && v < 100);
      if (small.length) pct = small[small.length - 1];
    }
    const big = cells.map(NUM).filter(v => v != null && v > 1000);
    if (big.length) shares = Math.max(...big);
    hits.push({ pct, shares, text: text.slice(0, 400), cells });
  });
  if (!hits.length) return null;
  // prefer a row that yielded both a percentage and a share count
  hits.sort((a, b) => (b.pct != null) - (a.pct != null) || (b.shares != null) - (a.shares != null));
  return hits[0];
}

router.get('/insider', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase();
    if (!symbol) return bad(res, 400, 'symbol is required');
    await ensureSchema();

    if (!req.query.refresh) {
      const c = await q('SELECT * FROM proxy_ownership WHERE ticker = $1', [symbol]);
      if (c.rows.length) return res.json({ ...c.rows[0], cached: true });
    }

    const cik = await cikFor(symbol);
    const p = await latestProxy(cik);
    const accNo = p.accession.replace(/-/g, '');
    const url = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${accNo}/${p.doc}`;
    const html = await sec(url, false);
    const hit = extractGroupRow(html);

    if (!hit) {
      return res.status(422).json({
        symbol, cik, error: 'beneficial-ownership group row not located',
        source: { accession: p.accession, filed: p.filed, form: p.form, url },
        guidance: 'Proxy table formats vary. Open the URL and read the '
          + '"all directors and executive officers as a group" row directly.',
      });
    }

    const confidence = (hit.pct != null && hit.shares != null) ? 'high'
      : (hit.pct != null ? 'medium' : 'low');

    await q(
      `INSERT INTO proxy_ownership (ticker,cik,accession,filed,doc_url,group_pct,group_shares,row_text,confidence,parsed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (ticker) DO UPDATE SET cik=EXCLUDED.cik, accession=EXCLUDED.accession,
         filed=EXCLUDED.filed, doc_url=EXCLUDED.doc_url, group_pct=EXCLUDED.group_pct,
         group_shares=EXCLUDED.group_shares, row_text=EXCLUDED.row_text,
         confidence=EXCLUDED.confidence, parsed_at=now()`,
      [symbol, cik, p.accession, p.filed, url, hit.pct, hit.shares, hit.text, confidence]);

    res.json({
      symbol, cik, cached: false,
      insiderOwnershipPct: hit.pct,
      insiderShares: hit.shares,
      confidence,
      rowText: hit.text,
      source: { accession: p.accession, filed: p.filed, form: p.form, url },
      note: 'From the DEF 14A beneficial ownership table, "all directors and executive '
        + 'officers as a group". A "*" in the proxy means under 1% and is recorded as 0.5. '
        + 'rowText is the raw parsed row - verify before relying on it.',
    });
  } catch (e) {
    bad(res, 502, `insider ownership failed: ${e.message}`);
  }
});

router.get('/cached', async (req, res) => {
  try {
    await ensureSchema();
    const r = await q('SELECT ticker,group_pct,group_shares,confidence,filed,accession FROM proxy_ownership ORDER BY ticker');
    res.json({ count: r.rows.length, rows: r.rows });
  } catch (e) { bad(res, 500, e.message); }
});

export default router;
