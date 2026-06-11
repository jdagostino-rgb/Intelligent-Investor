import dotenv from "dotenv";
dotenv.config();
/**
 * Intelligent Investor — Backend Proxy Server
 *
 * Proxies FRED, FMP, and Anthropic API calls server-side so:
 *  - API keys are never exposed to the browser
 *  - FRED CORS issue is eliminated (no allorigins proxy)
 *  - Results are cached to reduce API quota usage
 *  - ETF detection is normalised (JEPQ, etc.)
 *  - valuationHistory is always returned as a sorted array
 *
 * Deploy to: DigitalOcean droplet at 157.245.213.148
 * Start with: node server.js  (or via PM2: pm2 start server.js --name ii-backend)
 */

import express from 'express';
import fetch   from 'node-fetch';
import cors    from 'cors';

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Keys (set in .env or DigitalOcean environment) ──────────────────
const FRED_KEY      = process.env.FRED_API_KEY;
const FMP_KEY       = process.env.FMP_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── CORS ─────────────────────────────────────────────────────────────
// Allow your Netlify domain + localhost for dev
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (server-to-server, Postman)
    if (!origin) return cb(null, true);
    // Allow localhost for dev
    if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) return cb(null, true);
    // Allow configured origins (e.g. https://tiny-kashata-6f86b3.netlify.app)
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Simple in-memory cache ────────────────────────────────────────────
const cache = new Map();
function cGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) { cache.delete(key); return null; }
  return entry.val;
}
function cSet(key, val, ttlMs = 60_000) {
  cache.set(key, { val, exp: Date.now() + ttlMs });
}

// ── Helpers ───────────────────────────────────────────────────────────
const ok  = (res, data, maxAge = 60) => {
  res.set('Cache-Control', `public, max-age=${maxAge}`);
  res.json(data);
};
const bad = (res, code, msg) => res.status(code).json({ error: msg });

// ETFs that FMP may misidentify on Starter plan
const KNOWN_ETFS = new Set([
  'SPY','QQQ','VOO','VTI','IVV','BND','TLT','GLD','SLV','IWM',
  'VEA','EEM','SCHD','JEPQ','JEPI','AGG','JPIE','SPDW','SCHI',
]);

function normalizeValuationHistory(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw)
    .map(([date, value]) => ({ date, ...(typeof value === 'object' ? value : { value }) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ════════════════════════════════════════════════════════════════════════
// FRED ENDPOINTS
// ════════════════════════════════════════════════════════════════════════

/**
 * GET /api/fred/series?seriesid=DGS10
 * Returns: { seriesid, latest, date }
 */
app.get('/api/fred/series', async (req, res) => {
  try {
    const { seriesid } = req.query;
    if (!seriesid)   return bad(res, 400, 'seriesid is required');
    if (!FRED_KEY)   return bad(res, 500, 'FRED_API_KEY not configured on server');

    const ck  = `fred:${seriesid}`;
    const hit = cGet(ck);
    if (hit) return ok(res, hit, 60);

    const url = `https://api.stlouisfed.org/fred/series/observations`
      + `?series_id=${encodeURIComponent(seriesid)}`
      + `&api_key=${encodeURIComponent(FRED_KEY)}`
      + `&file_type=json&sort_order=desc&limit=1`;

    const r = await fetch(url, { timeout: 10_000 });
    if (!r.ok) return bad(res, r.status, `FRED error ${r.status}`);

    const j   = await r.json();
    const obs = j.observations?.[0] || null;
    const val = obs && obs.value !== '.' ? parseFloat(obs.value) : null;

    const payload = { seriesid, latest: val, date: obs?.date || null };
    cSet(ck, payload, 60_000); // cache 1 min
    ok(res, payload, 60);
  } catch (e) {
    bad(res, 502, `FRED proxy failed: ${e.message}`);
  }
});

/**
 * GET /api/fred/yoy?seriesid=CPIAUCSL
 * Returns: { seriesid, latest, yoy, mom, date }
 * Fetches 14 observations to compute year-over-year %
 */
app.get('/api/fred/yoy', async (req, res) => {
  try {
    const { seriesid } = req.query;
    if (!seriesid) return bad(res, 400, 'seriesid is required');
    if (!FRED_KEY) return bad(res, 500, 'FRED_API_KEY not configured on server');

    const ck  = `fred:yoy:${seriesid}`;
    const hit = cGet(ck);
    if (hit) return ok(res, hit, 300);

    const url = `https://api.stlouisfed.org/fred/series/observations`
      + `?series_id=${encodeURIComponent(seriesid)}`
      + `&api_key=${encodeURIComponent(FRED_KEY)}`
      + `&file_type=json&sort_order=desc&limit=14`;

    const r = await fetch(url, { timeout: 10_000 });
    if (!r.ok) return bad(res, r.status, `FRED error ${r.status}`);

    const j     = await r.json();
    const valid = (j.observations || [])
      .filter(o => o.value !== '.' && !isNaN(parseFloat(o.value)));

    if (valid.length < 2) return ok(res, { seriesid, latest: null, yoy: null, mom: null, date: null }, 300);

    const current  = parseFloat(valid[0].value);
    const yearAgo  = valid.length >= 13 ? parseFloat(valid[12].value) : null;
    const prevMonth = parseFloat(valid[1].value);

    const yoy = yearAgo   != null ? parseFloat(((current - yearAgo)   / yearAgo   * 100).toFixed(2)) : null;
    const mom =                     parseFloat(((current - prevMonth) / prevMonth * 100).toFixed(3));

    const payload = { seriesid, latest: current, yoy, mom, date: valid[0].date };
    cSet(ck, payload, 300_000); // cache 5 min (FRED data is monthly)
    ok(res, payload, 300);
  } catch (e) {
    bad(res, 502, `FRED YoY proxy failed: ${e.message}`);
  }
});

/**
 * GET /api/fred/macro
 * Returns all dashboard macro data in one request (11 series in parallel)
 */
app.get('/api/fred/macro', async (req, res) => {
  try {
    if (!FRED_KEY) return bad(res, 500, 'FRED_API_KEY not configured on server');

    const ck  = 'fred:macro';
    const hit = cGet(ck);
    if (hit) return ok(res, hit, 60);

    const SERIES = {
      spread:    'T10Y2Y',
      sentiment: 'UMCSENT',
      vix:       'VIXCLS',
      hySpread:  'BAMLH0A0HYM2',
      igSpread:  'BAMLC0A0CM',
      fedRate:   'FEDFUNDS',
      fedUpper:  'DFEDTARU',
      fedLower:  'DFEDTARL',
    };
    const YOY_SERIES = {
      cpi:     'CPIAUCSL',
      coreCpi: 'CPILFESL',
      ppi:     'PPIACO',
      pce:     'PCEPI',
    };

    // Fetch all in parallel
    const [seriesResults, yoyResults] = await Promise.all([
      Promise.all(
        Object.entries(SERIES).map(async ([key, sid]) => {
          try {
            const url = `https://api.stlouisfed.org/fred/series/observations`
              + `?series_id=${sid}&api_key=${encodeURIComponent(FRED_KEY)}`
              + `&file_type=json&sort_order=desc&limit=1`;
            const r = await fetch(url, { timeout: 8_000 });
            const j = await r.json();
            const obs = (j.observations || []).find(o => o.value !== '.');
            return [key, obs ? { value: parseFloat(obs.value), date: obs.date } : null];
          } catch { return [key, null]; }
        })
      ),
      Promise.all(
        Object.entries(YOY_SERIES).map(async ([key, sid]) => {
          try {
            const url = `https://api.stlouisfed.org/fred/series/observations`
              + `?series_id=${sid}&api_key=${encodeURIComponent(FRED_KEY)}`
              + `&file_type=json&sort_order=desc&limit=14`;
            const r = await fetch(url, { timeout: 8_000 });
            const j = await r.json();
            const valid = (j.observations || []).filter(o => o.value !== '.' && !isNaN(parseFloat(o.value)));
            if (valid.length < 2) return [key, null];
            const cur  = parseFloat(valid[0].value);
            const yAgo = valid.length >= 13 ? parseFloat(valid[12].value) : null;
            const prev = parseFloat(valid[1].value);
            return [key, {
              value: cur,
              yoy:   yAgo != null ? parseFloat(((cur - yAgo) / yAgo * 100).toFixed(2)) : null,
              mom:   parseFloat(((cur - prev) / prev * 100).toFixed(3)),
              date:  valid[0].date,
            }];
          } catch { return [key, null]; }
        })
      ),
    ]);

    const payload = {
      ...Object.fromEntries(seriesResults),
      ...Object.fromEntries(yoyResults),
      fetchedAt: new Date().toISOString(),
    };

    cSet(ck, payload, 60_000);
    ok(res, payload, 60);
  } catch (e) {
    bad(res, 502, `Macro fetch failed: ${e.message}`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// FMP ENDPOINTS
// ════════════════════════════════════════════════════════════════════════

const FMP_BASE = 'https://financialmodelingprep.com/stable';

async function fmpFetch(endpoint, params = {}) {
  const qs  = new URLSearchParams({ ...params, apikey: FMP_KEY }).toString();
  const url = `${FMP_BASE}${endpoint}?${qs}`;
  const r   = await fetch(url, { timeout: 10_000 });
  if (!r.ok) throw new Error(`FMP ${r.status} on ${endpoint}`);
  return r.json();
}

/**
 * GET /api/fmp/profile?symbol=AAPL
 * Returns profile with isEtf normalised
 */
app.get('/api/fmp/profile', async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol)   return bad(res, 400, 'symbol is required');
    if (!FMP_KEY)  return bad(res, 500, 'FMP_API_KEY not configured on server');

    const sym = symbol.toUpperCase();
    const ck  = `fmp:profile:${sym}`;
    const hit = cGet(ck);
    if (hit) return ok(res, hit, 300);

    const j       = await fmpFetch('/profile', { symbol: sym });
    const profile = Array.isArray(j) ? j[0] : j;

    const enhanced = {
      ...(profile || {}),
      isEtf:  Boolean(profile?.isEtf) || KNOWN_ETFS.has(sym),
      isFund: Boolean(profile?.isFund) || KNOWN_ETFS.has(sym),
    };

    cSet(ck, enhanced, 300_000);
    ok(res, enhanced, 300);
  } catch (e) {
    bad(res, 502, `FMP profile failed: ${e.message}`);
  }
});

/**
 * GET /api/fmp/financials?symbol=AAPL
 * Returns income, cashflow, balance, ratios, earnings in one request
 */
app.get('/api/fmp/financials', async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol)  return bad(res, 400, 'symbol is required');
    if (!FMP_KEY) return bad(res, 500, 'FMP_API_KEY not configured on server');

    const sym = symbol.toUpperCase();
    const ck  = `fmp:financials:${sym}`;
    const hit = cGet(ck);
    if (hit) return ok(res, hit, 300);

    const [income, cashflow, balance, ratios, earnings] = await Promise.all([
      fmpFetch('/income-statement',        { symbol: sym, period: 'annual', limit: 10 }),
      fmpFetch('/cash-flow-statement',     { symbol: sym, period: 'annual', limit: 10 }),
      fmpFetch('/balance-sheet-statement', { symbol: sym, period: 'annual', limit: 5  }),
      fmpFetch('/ratios',                  { symbol: sym, period: 'annual', limit: 10 }),
      fmpFetch('/earnings',                { symbol: sym, limit: 16 }),
    ]);

    // Normalise valuationHistory from ratios
    const valuationHistory = normalizeValuationHistory(
      (Array.isArray(ratios) ? ratios : []).slice(0, 8).map(r => ({
        year:     parseInt(r.calendarYear || r.date?.substring(0, 4) || 0),
        pe:       r.priceEarningsRatio    || null,
        pb:       r.priceToBookRatio      || null,
        roe:      r.returnOnEquity        ? r.returnOnEquity * 100 : null,
        fcfYield: r.freeCashFlowYield     ? r.freeCashFlowYield * 100 : null,
      })).reverse()
    );

    const payload = { symbol: sym, income, cashflow, balance, ratios, earnings, valuationHistory, fetchedAt: new Date().toISOString() };
    cSet(ck, payload, 300_000);
    ok(res, payload, 300);
  } catch (e) {
    bad(res, 502, `FMP financials failed: ${e.message}`);
  }
});

/**
 * GET /api/fmp/quote?symbol=AAPL
 */
app.get('/api/fmp/quote', async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol)  return bad(res, 400, 'symbol is required');
    if (!FMP_KEY) return bad(res, 500, 'FMP_API_KEY not configured on server');

    const sym = symbol.toUpperCase();
    const ck  = `fmp:quote:${sym}`;
    const hit = cGet(ck);
    if (hit) return ok(res, hit, 30);

    const j = await fmpFetch('/quote', { symbol: sym });
    const q = Array.isArray(j) ? j[0] : j;

    cSet(ck, q, 30_000); // cache 30s — price data
    ok(res, q, 30);
  } catch (e) {
    bad(res, 502, `FMP quote failed: ${e.message}`);
  }
});

/**
 * GET /api/fmp/screener?marketCapMoreThan=10000000000&limit=25&sector=Technology
 */
app.get('/api/fmp/screener', async (req, res) => {
  try {
    if (!FMP_KEY) return bad(res, 500, 'FMP_API_KEY not configured on server');

    const params = { ...req.query };
    const ck     = `fmp:screener:${JSON.stringify(params)}`;
    const hit    = cGet(ck);
    if (hit) return ok(res, hit, 300);

    const j = await fmpFetch('/company-screener', params);
    cSet(ck, j, 300_000);
    ok(res, j, 300);
  } catch (e) {
    bad(res, 502, `FMP screener failed: ${e.message}`);
  }
});

/**
 * GET /api/fmp/earnings-calendar?from=2026-05-01&to=2026-08-01
 */
app.get('/api/fmp/earnings-calendar', async (req, res) => {
  try {
    if (!FMP_KEY) return bad(res, 500, 'FMP_API_KEY not configured on server');
    const { from, to } = req.query;
    const ck  = `fmp:ec:${from}:${to}`;
    const hit = cGet(ck);
    if (hit) return ok(res, hit, 3600);

    const j = await fmpFetch('/earnings-calendar', { from, to });
    cSet(ck, j, 3_600_000); // cache 1 hour
    ok(res, j, 3600);
  } catch (e) {
    bad(res, 502, `FMP earnings-calendar failed: ${e.message}`);
  }
});

/**
 * GET /api/fmp/insider?symbol=AAPL
 */
app.get('/api/fmp/insider', async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol)  return bad(res, 400, 'symbol is required');
    if (!FMP_KEY) return bad(res, 500, 'FMP_API_KEY not configured on server');

    const sym = symbol.toUpperCase();
    const ck  = `fmp:insider:${sym}`;
    const hit = cGet(ck);
    if (hit) return ok(res, hit, 3600);

    const j = await fmpFetch('/insider-trading', { symbol: sym, limit: 30 });
    cSet(ck, j, 3_600_000);
    ok(res, j, 3600);
  } catch (e) {
    bad(res, 502, `FMP insider failed: ${e.message}`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// ANTHROPIC PROXY
// ════════════════════════════════════════════════════════════════════════

/**
 * POST /api/ai/complete
 * Body: { messages: [...], max_tokens: 1000, system?: "..." }
 * Proxies to Anthropic claude-sonnet-4-6
 */
app.post('/api/ai/complete', async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) return bad(res, 500, 'ANTHROPIC_API_KEY not configured on server');

    const { messages, max_tokens = 1000, system } = req.body;
    if (!messages || !Array.isArray(messages)) return bad(res, 400, 'messages array is required');

    const body = {
      model:      'claude-sonnet-4-6',
      max_tokens,
      messages,
      ...(system ? { system } : {}),
    };

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      timeout: 60_000,
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return bad(res, r.status, `Anthropic error ${r.status}: ${errText.substring(0, 200)}`);
    }

    const j = await r.json();
    // Return just the content array — same shape the frontend already expects
    res.json({ content: j.content });
  } catch (e) {
    bad(res, 502, `AI proxy failed: ${e.message}`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════════════════════

app.post('/api/schwab/token', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(400).json({error:'Missing auth'});
    const body = new URLSearchParams();
    const gt = req.body.refresh_token ? 'refresh_token' : 'authorization_code';
    body.append('grant_type', req.body.grant_type || gt);
    if (req.body.code) body.append('code', req.body.code);
    if (req.body.refresh_token) body.append('refresh_token', req.body.refresh_token);
    body.append('redirect_uri', req.body.redirect_uri || 'https://127.0.0.1');
    const r = await fetch('https://api.schwabapi.com/v1/oauth/token', {
      method: 'POST',
      headers: {'Content-Type':'application/x-www-form-urlencoded','Authorization':authHeader},
      body: body.toString()
    });
    const t = await r.text();
    res.status(r.status).set('Content-Type','application/json').send(t);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    keys: {
      fred:      !!FRED_KEY,
      fmp:       !!FMP_KEY,
      anthropic: !!ANTHROPIC_KEY,
    },
    uptime: process.uptime(),
    cache:  cache.size,
  });
});

app.get('/', (req, res) => res.json({ service: 'Intelligent Investor Backend', version: '1.0.0' }));

app.listen(PORT, () => {
  console.log(`\n✓ II Backend running on port ${PORT}`);
  console.log(`  FRED key:      ${FRED_KEY      ? '✓ set' : '✗ missing — set FRED_API_KEY'}`);
  console.log(`  FMP key:       ${FMP_KEY       ? '✓ set' : '✗ missing — set FMP_API_KEY'}`);
  console.log(`  Anthropic key: ${ANTHROPIC_KEY ? '✓ set' : '✗ missing — set ANTHROPIC_API_KEY'}`);
  console.log(`\n  Health check: http://localhost:${PORT}/health\n`);
});
