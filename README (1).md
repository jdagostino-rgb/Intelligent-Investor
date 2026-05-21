# Intelligent Investor

A personal investment research dashboard built as a single-file web application. Combines real financial data (FMP, FRED), live brokerage data (Charles Schwab), and AI analysis (Anthropic Claude) to score and research stocks, ETFs, preferred stocks, and bonds.

---

## Live Demo
Deployed at: `https://tiny-kashata-6f86b3.netlify.app`

---

## Architecture

### Single-file application
The entire app is `intelligent-investor-v9.html` — HTML, CSS, and JavaScript in one file. No build step, no npm, no framework. Deploys by dragging the file to Netlify.

### Data sources

| Source | What it provides | How it's called |
|---|---|---|
| **FMP** (Financial Modeling Prep) | Income statements, cash flows, earnings, analyst targets, insider trading, institutional ownership, price history, screener | Direct browser fetch — FMP `/stable` API supports CORS |
| **FRED** (Federal Reserve) | Yield curve, VIX, credit spreads, CPI, PPI, PCE, Fed funds rate | Via `allorigins.win` CORS proxy — FRED API does not support browser CORS |
| **Anthropic Claude** | Qualitative scoring (moat, management, conviction), investment verdicts, daily brief | Direct browser fetch to `api.anthropic.com` |
| **Charles Schwab** | Live prices, P/E ratios, margins, dividends | Via Cloudflare Worker OAuth proxy at `https://bold-tooth-2c65.jbdagostino.workers.dev` |

### API keys
All keys are stored in browser `localStorage`. **This is appropriate for a private personal tool but not for shared deployment.**

| Key | localStorage name | Where to get it |
|---|---|---|
| FMP | `fmp_key` | financialmodelingprep.com — Starter plan $20/mo |
| FRED | `fred_key` | fred.stlouisfed.org/docs/api/api_key.html — free |
| Anthropic | `ii_key` | console.anthropic.com |
| Schwab | OAuth via CF Worker | developer.schwab.com |

---

## Features

### Dashboard
- 7 macro tiles: Rates/Bonds, Credit, Equities, Liquidity, Inflation, Commodities/FX, Fed Policy
- Inflation tile: CPI YoY, Core CPI YoY, PPI YoY, PCE YoY, CPI MoM (from FRED)
- Daily intelligence brief (AI-generated)
- Market regime scoring (0–100, Bullish/Mixed/Bearish)
- Watchlist top companies with scores

### Research
- Full company analysis with 9-criteria scoring (0–100)
- Data-driven scores for FCF, Debt, Growth, Buybacks, Valuation, Earnings from real FMP data
- AI-only scores for Moat, Management, Conviction
- Key Signals panel: ✓/✗ for every metric with real numbers (PE vs history, PE vs peers, FCF yield, etc.)
- Real 5-year price chart from FMP
- Insider trading signal (buy/sell ratio, individual transactions)
- Analyst targets, EV/EBITDA, revenue segments
- Preferred stock support: coverage ratio, yield-to-call, call date, cumulative/non-cumulative

### Portfolio
- Multiple portfolios
- Stock/ETF positions with tax lot tracking (LT/ST)
- **Bond positions**: full bond math — YTM, modified duration, rate scenario analysis (-200bps to +200bps)
- Stress test

### Screener
- FMP real screener (`/company-screener` endpoint)
- AI fallback if FMP unavailable
- Direct ticker lookup

### Calendar
- Month and list views
- Earnings dates from FMP `/earnings-calendar`
- Portfolio positions highlighted in gold, watchlist in blue

### Validate (Backtest)
- Tests 9 securities against known public facts: AAPL, MSFT, NVDA, GOOG, JPM, BAC-PL, JEPQ, SLV, US10Y
- Validates revenue, net income, gross margin, EPS beat rate, data freshness

---

## Scoring System

### 9 Criteria (weighted sum → 0–100)

| Criterion | Weight | Source |
|---|---|---|
| Competitive Advantage (Moat) | 20 | AI only |
| Management Credibility | 15 | AI only |
| Earnings Track Record | 15 | FMP (EPS beat rate, consecutive beats) |
| Margin of Safety / Valuation | 15 | FMP (PE vs history, PE vs peers, PEG, EV/EBITDA) |
| Profit Growth 7Y | 12 | FMP (7Y CAGR) |
| Debt Obligations | 10 | FMP (Debt/EBITDA, interest coverage) |
| Free Cash Flow | 10 | FMP (FCF positive, trend, yield) |
| Share Buybacks | 8 | FMP (5Y shares change, consistency) |
| Personal Conviction | 5 | User-adjustable |

**Formula:** `Math.round(weightedSum / 110 * 10)` → 0–100 integer

**Grades:** Exceptional (85+) · Strong Buy (70+) · Watch Closely (55+) · Needs Work (40+) · Pass (<40)

---

## FMP API — Critical Notes

FMP migrated their entire API in **August 2025**. The old `/api/v3/` endpoints are blocked for all new subscribers.

**New format:**
```
https://financialmodelingprep.com/stable/income-statement?symbol=AAPL&apikey=KEY
```

**Old format (blocked for new users):**
```
https://financialmodelingprep.com/api/v3/income-statement/AAPL?apikey=KEY
```

All endpoints in this codebase use the `/stable/` format with `symbol` as a query parameter.

---

## Known Issues

### 1. Dashboard macro tiles (FRED data)
**Problem:** FRED API does not support browser CORS. All FRED calls route through `allorigins.win`, a free public CORS proxy that is unreliable and slow.

**Correct fix:** Move FRED calls to a server-side proxy (Node.js/Express or Cloudflare Worker). The server reads `FRED_API_KEY` from environment variables and the browser calls `/api/macro` instead.

**Current workaround:** 3-proxy fallback chain (allorigins → corsproxy.io → codetabs.com) with 12-second timeout.

### 2. JEPQ in validation
**Problem:** FMP `/profile` returns inconsistent `isEtf` field for JEPQ on the Starter plan.

**Fix:** Hardcoded known-ETF list as fallback. Profile-only validation path added.

### 3. US10Y in validation
**Problem:** FMP `/treasury` endpoint requires a higher plan tier than Starter.

**Fix:** Use FRED `DGS10` series (10-Year Treasury Constant Maturity Rate) as data source instead.

### 4. API keys in localStorage
**Problem:** Keys are visible in browser DevTools. Fine for personal use; not acceptable for shared deployment.

**Correct fix:** Backend proxy that holds keys in environment variables. The browser never sees the keys.

### 5. valuationHistory type inconsistency
**Problem:** AI sometimes returns `valuationHistory` as an object `{}`, FMP returns it as an array `[]`. Code normalizes with `Array.isArray()` check but edge cases may remain.

---

## Recommended Architecture (for production)

```
Browser
  ↓ GET /api/macro        (yields, spreads, CPI, PPI)
  ↓ GET /api/quote/:ticker (live price, PE)
  ↓ GET /api/financials/:ticker (income, FCF, earnings)
  ↓ POST /api/ai/score    (Claude scoring)

Node.js / Express (or Cloudflare Workers)
  ↓ FRED API     (FRED_API_KEY in env)
  ↓ FMP API      (FMP_API_KEY in env)
  ↓ Anthropic    (ANTHROPIC_API_KEY in env)
  ↓ Schwab OAuth (already in CF Worker at bold-tooth-2c65.jbdagostino.workers.dev)
```

Benefits:
- Keys never exposed to browser
- Server-side caching (FRED data changes hourly, not per-request)
- No CORS proxy dependency
- Rate limit management in one place

The DigitalOcean droplet at `157.245.213.148` is already provisioned and partially configured for this backend.

---

## File Structure

```
intelligent-investor-v9.html    # Entire application (HTML + CSS + JS)
README.md                       # This file
```

### Key JavaScript sections (in order within the file)

| Section | What it does |
|---|---|
| CSS variables + layout | Dark theme, responsive breakpoints (1024px, 768px, 420px) |
| State variables | companies[], portfolios{}, macroData, alerts[] |
| Bond math engine | calcYTM(), calcModifiedDuration(), calcBondPrice() |
| Data-driven scoring | computeDataDrivenScores(), mergeDataDrivenScores() |
| FMP fetch layer | fmpFetch(), fetchFmpData() — 14 T1+T2 endpoints |
| FRED fetch layer | fetchFRED(), fetchFREDYoY(), fredProxyFetch() |
| AI analysis | fetchCompSet(), fetchAIScores(), fetchTrend(), fetchEarnings() |
| Portfolio system | getPortfolio(), savePortfolios(), addToPortfolio() |
| Company display | showCompany(), buildKeySignals(), buildValuation(), buildEarnings(), etc. |
| Dashboard | renderDashboard(), loadMacroData(), macroScore() |
| Calendar | renderCalendar(), fetchCalendarData(), showCalDay() |
| Validation | runDataBacktest(), fetchFmpValidation() |
| Earnings alerts | checkEarningsAlerts(), runEarningsCheckOnce() |

---

## Setup Instructions

1. Deploy `intelligent-investor-v9.html` to any static host (Netlify, S3, GitHub Pages)
2. Open the app → go to **Schwab** tab
3. Enter your **FMP API key** → click Connect
4. Enter your **FRED API key** → click Connect  
5. Enter your **Anthropic API key** → save
6. Go to **Validate** tab → click **▶ Run Backtest** — confirm 21/21 pass
7. Go to **Research** tab → type a ticker → analyze

---

## Cloudflare Worker (Schwab OAuth Proxy)

File: `schwab-cf-worker.js` (separate file, deployed to Cloudflare)

Handles:
- Schwab OAuth 2.0 flow
- Token refresh
- Quote and account data proxy

Endpoint: `https://bold-tooth-2c65.jbdagostino.workers.dev`

---

*Built with Claude (Anthropic) — May 2026*
