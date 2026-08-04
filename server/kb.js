/**
 * Intelligent Investor — Knowledge Base router
 * Install to: /app/server/kb.js
 *
 * Requires: KB_DATABASE_URL in /app/.env  (written by kb-setup.sh)
 *           npm install pg
 *
 * Wire into server.js (2 lines):
 *   import kbRouter, { kbContextText } from './kb.js';
 *   app.use('/api/kb', kbRouter);
 *
 * Design rule: KB failures must NEVER break existing endpoints.
 * Every handler catches and returns a clean error; kbContextText()
 * returns '' on any failure so /api/ai/complete degrades gracefully.
 */

import express from 'express';
import pg from 'pg';

const router = express.Router();

// ── Pool (lazy — server boots fine even if KB_DATABASE_URL missing) ──
let pool = null;
function getPool() {
  if (!pool && process.env.KB_DATABASE_URL) {
    pool = new pg.Pool({
      connectionString: process.env.KB_DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (e) => console.error('KB pool error:', e.message));
  }
  return pool;
}

async function q(text, params = []) {
  const p = getPool();
  if (!p) throw new Error('KB_DATABASE_URL not configured');
  return p.query(text, params);
}

const bad = (res, code, msg) => res.status(code).json({ error: msg });

// ════════════════════════════════════════════════════════════════════
// HEALTH
// ════════════════════════════════════════════════════════════════════
router.get('/health', async (req, res) => {
  try {
    const r = await q(`
      SELECT
        (SELECT count(*) FROM analyses)      AS analyses,
        (SELECT count(*) FROM trades)        AS trades,
        (SELECT count(*) FROM preferences)   AS preferences,
        (SELECT count(*) FROM conversations) AS conversations
    `);
    res.json({ status: 'ok', counts: r.rows[0] });
  } catch (e) {
    bad(res, 500, `KB unavailable: ${e.message}`);
  }
});

// ════════════════════════════════════════════════════════════════════
// ANALYSES
// ════════════════════════════════════════════════════════════════════
router.post('/analyses', async (req, res) => {
  try {
    const { ticker, companyName, score, verdict, criteria, macroRegime, notes, raw } = req.body || {};
    if (!ticker) return bad(res, 400, 'ticker is required');
    const r = await q(
      `INSERT INTO analyses (ticker, company_name, score, verdict, criteria, macro_regime, notes, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
      [
        String(ticker).toUpperCase(),
        companyName || null,
        Number.isFinite(Number(score)) ? Number(score) : null,
        verdict || null,
        criteria ? JSON.stringify(criteria) : null,
        macroRegime || null,
        notes || null,
        raw ? JSON.stringify(raw) : null,
      ]
    );
    res.json({ saved: true, ...r.rows[0] });
  } catch (e) {
    bad(res, 500, `save analysis failed: ${e.message}`);
  }
});

router.get('/analyses', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const ticker = req.query.ticker ? String(req.query.ticker).toUpperCase() : null;
    const r = ticker
      ? await q(
          `SELECT id, ticker, company_name, score, verdict, criteria, macro_regime, notes, created_at
           FROM analyses WHERE ticker = $1 ORDER BY created_at DESC LIMIT $2`,
          [ticker, limit]
        )
      : await q(
          `SELECT id, ticker, company_name, score, verdict, macro_regime, created_at
           FROM analyses ORDER BY created_at DESC LIMIT $1`,
          [limit]
        );
    res.json(r.rows);
  } catch (e) {
    bad(res, 500, `list analyses failed: ${e.message}`);
  }
});

// ════════════════════════════════════════════════════════════════════
// TRADES
// ════════════════════════════════════════════════════════════════════
router.post('/trades', async (req, res) => {
  try {
    const { ticker, account, side, shares, entryPrice, exitPrice, pnl, entryDate, exitDate, notes } = req.body || {};
    if (!ticker) return bad(res, 400, 'ticker is required');
    const r = await q(
      `INSERT INTO trades (ticker, account, side, shares, entry_price, exit_price, pnl, entry_date, exit_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, created_at`,
      [
        String(ticker).toUpperCase(),
        account || 'boiler_room',
        side || 'long',
        shares ?? null,
        entryPrice ?? null,
        exitPrice ?? null,
        pnl ?? null,
        entryDate || null,
        exitDate || null,
        notes || null,
      ]
    );
    res.json({ saved: true, ...r.rows[0] });
  } catch (e) {
    bad(res, 500, `save trade failed: ${e.message}`);
  }
});

router.get('/trades', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const ticker = req.query.ticker ? String(req.query.ticker).toUpperCase() : null;
    const r = ticker
      ? await q(`SELECT * FROM trades WHERE ticker = $1 ORDER BY created_at DESC LIMIT $2`, [ticker, limit])
      : await q(`SELECT * FROM trades ORDER BY created_at DESC LIMIT $1`, [limit]);
    res.json(r.rows);
  } catch (e) {
    bad(res, 500, `list trades failed: ${e.message}`);
  }
});

// ════════════════════════════════════════════════════════════════════
// PREFERENCES  (upsert by key)
// ════════════════════════════════════════════════════════════════════
router.post('/preferences', async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return bad(res, 400, 'key is required');
    await q(
      `INSERT INTO preferences (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value ?? null)]
    );
    res.json({ saved: true, key });
  } catch (e) {
    bad(res, 500, `save preference failed: ${e.message}`);
  }
});

router.get('/preferences', async (req, res) => {
  try {
    const r = await q(`SELECT key, value, updated_at FROM preferences ORDER BY key`);
    res.json(r.rows);
  } catch (e) {
    bad(res, 500, `list preferences failed: ${e.message}`);
  }
});

// ════════════════════════════════════════════════════════════════════
// CONVERSATIONS
// ════════════════════════════════════════════════════════════════════
router.post('/conversations', async (req, res) => {
  try {
    const { summary, topics, date } = req.body || {};
    if (!summary) return bad(res, 400, 'summary is required');
    const r = await q(
      `INSERT INTO conversations (summary, topics, happened_on)
       VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE)) RETURNING id, created_at`,
      [summary, Array.isArray(topics) ? topics : null, date || null]
    );
    res.json({ saved: true, ...r.rows[0] });
  } catch (e) {
    bad(res, 500, `save conversation failed: ${e.message}`);
  }
});

router.get('/conversations', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 200);
    const r = await q(`SELECT * FROM conversations ORDER BY created_at DESC LIMIT $1`, [limit]);
    res.json(r.rows);
  } catch (e) {
    bad(res, 500, `list conversations failed: ${e.message}`);
  }
});

// ════════════════════════════════════════════════════════════════════
// CONTEXT — compact history bundle for AI calls
// ════════════════════════════════════════════════════════════════════
const CTX_TTL_MS = 5 * 60_000;
let ctxCache = { text: '', at: 0, ticker: null };

export async function kbContextText(ticker = null) {
  try {
    const now = Date.now();
    if (ctxCache.text && now - ctxCache.at < CTX_TTL_MS && ctxCache.ticker === (ticker || null)) {
      return ctxCache.text;
    }
    if (!getPool()) return '';

    const [recent, prefs, trades, tickerHist] = await Promise.all([
      q(`SELECT ticker, score, verdict, macro_regime, to_char(created_at,'YYYY-MM-DD') AS d
         FROM analyses ORDER BY created_at DESC LIMIT 8`),
      q(`SELECT key, value FROM preferences WHERE key NOT LIKE '%_snapshot' ORDER BY updated_at DESC LIMIT 10`),
      q(`SELECT ticker, pnl, exit_price, to_char(created_at,'YYYY-MM-DD') AS d
         FROM trades ORDER BY created_at DESC LIMIT 5`),
      ticker
        ? q(`SELECT score, verdict, macro_regime, to_char(created_at,'YYYY-MM-DD') AS d
             FROM analyses WHERE ticker = $1 ORDER BY created_at DESC LIMIT 3`, [String(ticker).toUpperCase()])
        : Promise.resolve({ rows: [] }),
    ]);

    const parts = [];
    if (recent.rows.length) {
      parts.push('Recent analyses: ' + recent.rows
        .map(r => `${r.ticker} ${r.score ?? '—'} (${r.verdict || 'n/a'}, ${r.macro_regime || 'n/a'}, ${r.d})`)
        .join('; '));
    }
    if (tickerHist.rows.length) {
      parts.push(`Prior scores for ${String(ticker).toUpperCase()}: ` + tickerHist.rows
        .map(r => `${r.score} on ${r.d} (${r.macro_regime || 'n/a'})`)
        .join('; '));
    }
    if (trades.rows.length) {
      parts.push('Recent trades: ' + trades.rows
        .map(r => `${r.ticker} pnl ${r.pnl ?? 'open'} (${r.d})`)
        .join('; '));
    }
    if (prefs.rows.length) {
      parts.push('Investor preferences: ' + prefs.rows
        .map(r => `${r.key}=${JSON.stringify(r.value)}`)
        .join('; ').slice(0, 600));
    }

    const text = parts.length
      ? `INVESTOR HISTORY (from knowledge base — use as context, never as a substitute for current data):\n${parts.join('\n')}`.slice(0, 2000)
      : '';

    ctxCache = { text, at: now, ticker: ticker || null };
    return text;
  } catch (e) {
    console.error('kbContextText failed:', e.message);
    return '';
  }
}

router.get('/context', async (req, res) => {
  const text = await kbContextText(req.query.ticker || null);
  res.json({ text });
});

export default router;
