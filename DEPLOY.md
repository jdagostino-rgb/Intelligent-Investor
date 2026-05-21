# Backend Deployment Guide
## DigitalOcean Droplet: 157.245.213.148

### One-time setup (already done through Step 4)

```bash
# SSH into droplet
ssh root@157.245.213.148

# Install Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install PM2 globally
npm install -g pm2
```

---

### Deploy the backend

```bash
# SSH into droplet
ssh root@157.245.213.148

# Clone the repo (first time)
git clone https://github.com/jdagostino-rgb/Intelligent-Investor.git /app
cd /app

# Install dependencies
npm install

# Create .env from example
cp .env.example .env
nano .env    # paste your real keys here

# Create logs directory
mkdir -p logs

# Start with PM2
pm2 start ecosystem.config.cjs

# Save PM2 process list (survives reboot)
pm2 save

# Set PM2 to start on system boot
pm2 startup
# (copy and run the command it prints)
```

---

### Update after pushing new code

```bash
ssh root@157.245.213.148
cd /app
git pull
pm2 restart ii-backend
```

---

### Verify it's running

```bash
# Check status
pm2 status

# Check logs
pm2 logs ii-backend

# Test health endpoint
curl http://localhost:3001/health

# Test from browser (replace with your droplet IP)
curl http://157.245.213.148:3001/health
```

Expected response:
```json
{
  "status": "ok",
  "keys": { "fred": true, "fmp": true, "anthropic": true },
  "uptime": 42.3,
  "cache": 0
}
```

---

### Open firewall port 3001

```bash
ufw allow 3001
ufw status
```

---

### Update the frontend (intelligent-investor-v9.html)

Change the API base URL constant at the top of the script section:

```javascript
// Change this:
var FMP_BASE = 'https://financialmodelingprep.com/stable';

// To this:
var API_BASE = 'http://157.245.213.148:3001';  // or your domain if you set one up
```

Then update `fmpFetch()` and `fetchFRED()` to call your backend instead of FMP/FRED directly.

See `FRONTEND_CHANGES.md` for the exact diff.

---

### API endpoints available

| Endpoint | Description | Cache |
|---|---|---|
| `GET /health` | Server health + key status | none |
| `GET /api/fred/macro` | All macro data in one call | 1 min |
| `GET /api/fred/series?seriesid=DGS10` | Single FRED series | 1 min |
| `GET /api/fred/yoy?seriesid=CPIAUCSL` | FRED series with YoY calc | 5 min |
| `GET /api/fmp/profile?symbol=AAPL` | Company profile (ETF normalised) | 5 min |
| `GET /api/fmp/financials?symbol=AAPL` | Income, CF, balance, ratios, earnings | 5 min |
| `GET /api/fmp/quote?symbol=AAPL` | Live quote | 30 sec |
| `GET /api/fmp/screener?...` | Company screener | 5 min |
| `GET /api/fmp/earnings-calendar?from=&to=` | Earnings calendar | 1 hour |
| `GET /api/fmp/insider?symbol=AAPL` | Insider transactions | 1 hour |
| `POST /api/ai/complete` | Anthropic Claude proxy | none |
