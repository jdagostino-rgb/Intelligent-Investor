# Frontend Changes Required
## Update intelligent-investor-v9.html to use the backend

Once the backend is deployed at `http://157.245.213.148:3001`,
make these changes to the HTML file.

---

## 1. Add API_BASE constant (near top of script section)

```javascript
// Backend URL — change to your domain if you set up DNS
var API_BASE = 'http://157.245.213.148:3001';
```

---

## 2. Replace fmpFetch() — call backend instead of FMP directly

```javascript
// REPLACE the existing fmpFetch function with this:
async function fmpFetch(endpoint, params) {
  try {
    // Map FMP endpoint to backend route
    const endpointMap = {
      '/profile':                '/api/fmp/profile',
      '/quote':                  '/api/fmp/quote',
      '/company-screener':       '/api/fmp/screener',
      '/earnings-calendar':      '/api/fmp/earnings-calendar',
      '/insider-trading':        '/api/fmp/insider',
    };

    // For financials endpoints, use the combined /api/fmp/financials call
    const financialEndpoints = [
      '/income-statement', '/cash-flow-statement', '/balance-sheet-statement',
      '/ratios', '/earnings', '/enterprise-values', '/key-metrics',
    ];

    const backendRoute = endpointMap[endpoint];

    if (backendRoute) {
      // Direct backend route
      const qs = new URLSearchParams(params || {}).toString();
      const url = `${API_BASE}${backendRoute}${qs ? '?' + qs : ''}`;
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000));
      const r = await Promise.race([fetch(url), timeout]);
      if (!r.ok) return null;
      return await r.json();
    }

    if (financialEndpoints.some(e => endpoint.startsWith(e))) {
      // Financial data — use combined endpoint if we have a symbol
      const symbol = params?.symbol;
      if (symbol) {
        const ck = `fin:${symbol}`;
        if (!window._finCache) window._finCache = {};
        if (!window._finCache[ck]) {
          const url = `${API_BASE}/api/fmp/financials?symbol=${encodeURIComponent(symbol)}`;
          const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
          const r = await Promise.race([fetch(url), timeout]);
          if (!r.ok) return null;
          window._finCache[ck] = await r.json();
        }
        const data = window._finCache[ck];
        // Map endpoint to the right field
        if (endpoint.startsWith('/income-statement'))        return data.income        || null;
        if (endpoint.startsWith('/cash-flow-statement'))     return data.cashflow      || null;
        if (endpoint.startsWith('/balance-sheet-statement')) return data.balance       || null;
        if (endpoint.startsWith('/ratios'))                  return data.ratios        || null;
        if (endpoint.startsWith('/earnings'))                return data.earnings      || null;
      }
    }

    // Fallback: return null (don't call FMP directly — keys are server-side)
    console.warn('[fmpFetch] No backend route for:', endpoint);
    return null;
  } catch (e) {
    console.warn('[fmpFetch]', endpoint, e.message);
    return null;
  }
}
```

---

## 3. Replace fetchFRED() — call backend instead of allorigins

```javascript
// REPLACE fetchFRED with this:
async function fetchFRED(series) {
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000));
    const r = await Promise.race([
      fetch(`${API_BASE}/api/fred/series?seriesid=${encodeURIComponent(series)}`),
      timeout,
    ]);
    if (!r.ok) return null;
    const j = await r.json();
    return j.latest != null ? { value: j.latest, date: j.date } : null;
  } catch (e) {
    console.warn('[FRED]', series, e.message);
    return null;
  }
}

// REPLACE fetchFREDYoY with this:
async function fetchFREDYoY(series) {
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000));
    const r = await Promise.race([
      fetch(`${API_BASE}/api/fred/yoy?seriesid=${encodeURIComponent(series)}`),
      timeout,
    ]);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.warn('[FRED YoY]', series, e.message);
    return null;
  }
}
```

---

## 4. Replace the Anthropic claude() call — proxy through backend

```javascript
// REPLACE the existing claude() function with this:
async function claude(prompt, maxTokens, systemPrompt) {
  try {
    const r = await fetch(`${API_BASE}/api/ai/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages:   [{ role: 'user', content: prompt }],
        max_tokens: maxTokens || 1000,
        system:     systemPrompt || undefined,
      }),
    });
    if (!r.ok) throw new Error(`AI proxy ${r.status}`);
    const j = await r.json();
    return j.content?.[0]?.text || '';
  } catch (e) {
    console.warn('[AI]', e.message);
    return '';
  }
}
```

---

## 5. Remove localStorage key inputs from UI

Once the backend is live, the API key input fields in the Schwab tab
can be removed or hidden — keys live in the server `.env` file only.

Keep the Schwab OAuth section (that still goes through the CF Worker).

---

## 6. Update hasFmp() and getFredKey() checks

```javascript
// These become always-true if the backend is running
// Replace with a backend health check on startup:

var _backendOnline = false;

async function checkBackend() {
  try {
    const r = await fetch(`${API_BASE}/health`, { timeout: 3000 });
    const j = await r.json();
    _backendOnline = j.status === 'ok';
    if (!j.keys.fmp)  console.warn('Backend: FMP key not set');
    if (!j.keys.fred) console.warn('Backend: FRED key not set');
    return j;
  } catch (e) {
    _backendOnline = false;
    return null;
  }
}

function hasFmp()     { return _backendOnline; }
function getFredKey() { return _backendOnline ? 'via-backend' : ''; }
```

---

## Summary of what gets removed from the browser

| Removed from browser | Moved to |
|---|---|
| `fmp_key` in localStorage | `FMP_API_KEY` in server `.env` |
| `fred_key` in localStorage | `FRED_API_KEY` in server `.env` |
| `ii_key` in localStorage | `ANTHROPIC_API_KEY` in server `.env` |
| `allorigins.win` proxy calls | Direct server-to-server fetch |
| `corsproxy.io` fallback | Not needed |
| Key input fields in Schwab tab | Can be removed |
