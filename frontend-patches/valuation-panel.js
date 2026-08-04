/* BUFFETT TWO-COLUMN VALUATION PANEL
   Insert at the very end of the main inline script, before its closing tag.
   ASCII ONLY. Contains no script-closing sequence, no emoji, no box chars.

   SAFETY: this file only ADDS a button and a modal to the DOM. It does not
   modify, wrap or override any existing render function, so it cannot break
   the dashboard, research, portfolio or any other view.

   Usage:
     - A "Valuation" button appears bottom-right on every view.
     - Click it (or press Shift+V) to open the side-by-side comparison
       for whichever ticker is currently open.
     - Console: VAL.show('MSFT')
*/
(function () {
  var API = (function () {
    try { var o = localStorage.getItem('ii_kb_base'); if (o) return o; } catch (e) {}
    return 'https://api.iinvestor13.com';
  })();

  function currentTicker() {
    try {
      if (typeof activeId !== 'undefined' && activeId && typeof companies !== 'undefined') {
        var c = companies.filter(function (x) { return x.id === activeId; })[0];
        if (c && c.ticker) return c.ticker;
      }
      if (typeof companies !== 'undefined' && companies.length) {
        return companies[companies.length - 1].ticker;
      }
    } catch (e) {}
    return null;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmt(v, dp) {
    if (v == null || isNaN(v)) return '-';
    return Number(v).toFixed(dp == null ? 2 : dp);
  }

  /* ---------- modal shell ---------- */
  function ensureModal() {
    var m = document.getElementById('valModal');
    if (m) return m;

    m = document.createElement('div');
    m.id = 'valModal';
    m.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,.72)', 'z-index:99999',
      'display:none', 'align-items:flex-start', 'justify-content:center',
      'overflow:auto', 'padding:40px 16px', 'font-family:inherit'
    ].join(';');

    var box = document.createElement('div');
    box.id = 'valModalBox';
    box.style.cssText = [
      'background:#12161c', 'color:#e8edf3', 'max-width:920px', 'width:100%',
      'border-radius:12px', 'padding:24px 26px', 'box-shadow:0 20px 60px rgba(0,0,0,.6)',
      'border:1px solid #2a323d', 'font-size:14px', 'line-height:1.5'
    ].join(';');

    m.appendChild(box);
    m.addEventListener('click', function (e) { if (e.target === m) hide(); });
    document.body.appendChild(m);
    return m;
  }

  function hide() {
    var m = document.getElementById('valModal');
    if (m) m.style.display = 'none';
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hide();
    if (e.shiftKey && (e.key === 'V' || e.key === 'v') &&
        ['INPUT', 'TEXTAREA'].indexOf((e.target.tagName || '')) === -1) {
      VAL.show();
    }
  });

  /* ---------- rendering ---------- */
  function card(title, pe, eps, basis, accent, sub) {
    return '' +
      '<div style="flex:1;min-width:200px;background:#1a2029;border:1px solid ' + accent +
      ';border-radius:10px;padding:14px 16px">' +
        '<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8a97a8">' +
          esc(title) + '</div>' +
        '<div style="font-size:34px;font-weight:700;margin:6px 0 2px;color:' + accent + '">' +
          fmt(pe) + '</div>' +
        '<div style="font-size:12px;color:#9fb0c4">P/E on EPS of $' + fmt(eps) + '</div>' +
        (sub ? '<div style="font-size:12px;color:#9fb0c4;margin-top:2px">' + esc(sub) + '</div>' : '') +
        '<div style="font-size:11px;color:#7d8b9c;margin-top:9px">' + esc(basis) + '</div>' +
      '</div>';
  }

  function render(d) {
    var box = document.getElementById('valModalBox');
    var flag = d.flag
      ? '<div style="background:#3a2a12;border:1px solid #8a6520;color:#f0c674;padding:10px 13px;' +
        'border-radius:8px;margin:14px 0;font-size:13px"><b>Earnings quality divergence:</b> core P/E differs ' +
        'from the broker figure by ' + fmt(Math.abs(d.divergencePct), 0) + '%. Margin of Safety should be scored ' +
        'on the core number.</div>'
      : '';

    var rows = (d.quarters || []).slice(0, 4).map(function (q) {
      var conv = (q.operatingIncome && q.netIncome) ? (q.netIncome / q.operatingIncome) : null;
      var hot = conv && conv > 1.2;
      return '<tr>' +
        '<td style="padding:5px 10px 5px 0;color:#9fb0c4">' + esc(q.date) + ' ' + esc(q.period || '') + '</td>' +
        '<td style="padding:5px 10px;text-align:right">' + fmt(q.operatingIncome / 1e9, 1) + 'B</td>' +
        '<td style="padding:5px 10px;text-align:right">' + fmt(q.netIncome / 1e9, 1) + 'B</td>' +
        '<td style="padding:5px 0 5px 10px;text-align:right;font-weight:600;color:' +
          (hot ? '#f0c674' : '#8fbf8f') + '">' + fmt(conv) + 'x</td>' +
      '</tr>';
    }).join('');

    box.innerHTML = '' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline">' +
        '<div><span style="font-size:20px;font-weight:700">' + esc(d.symbol) + '</span>' +
        '<span style="color:#9fb0c4;margin-left:10px">$' + fmt(d.price) + '</span></div>' +
        '<button id="valClose" style="background:#232b36;border:1px solid #333d4a;color:#c9d5e2;' +
        'border-radius:6px;padding:5px 11px;cursor:pointer">Close</button>' +
      '</div>' +

      '<div style="display:flex;gap:12px;margin-top:16px;flex-wrap:wrap">' +
        card('Broker / GAAP TTM', d.headline.pe, d.headline.ttmEps,
             'What Yahoo and Schwab show. Trailing GAAP diluted EPS.', '#6f9ed8') +
        card('Core operating', d.core.pe, d.core.coreEps,
             d.core.basis, '#e0a44c') +
        card('Two-column (ex-investments)', d.buffett.pe, d.core.coreEps,
             d.buffett.basis, '#8fbf8f',
             'Price less $' + fmt(d.buffett.netInvestmentsPerShare) + ' investments') +
      '</div>' +

      flag +

      '<div style="margin-top:16px;font-size:12px;color:#8a97a8;letter-spacing:.08em;' +
      'text-transform:uppercase">Where the difference comes from</div>' +
      '<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:13px">' +
        '<tr style="color:#7d8b9c;font-size:11px;text-transform:uppercase">' +
          '<td style="padding-bottom:4px">Quarter</td>' +
          '<td style="text-align:right;padding-bottom:4px">Operating</td>' +
          '<td style="text-align:right;padding-bottom:4px">Net</td>' +
          '<td style="text-align:right;padding-bottom:4px">Net/Op</td></tr>' +
        rows +
      '</table>' +

      '<div style="margin-top:14px">' +
        (d.notes || []).map(function (n) {
          return '<div style="color:#b9c6d4;font-size:13px;margin-bottom:8px">- ' + esc(n) + '</div>';
        }).join('') +
      '</div>' +

      '<div style="margin-top:14px;font-size:11px;color:#66727f;border-top:1px solid #232b36;padding-top:10px">' +
        'Non-operating income: $' + fmt(d.nonOperating.amountB, 1) + 'B (' +
        fmt(d.nonOperating.pctOfNetIncome, 0) + '% of net). Conversion ' +
        fmt(d.nonOperating.priorYearConversion) + 'x a year ago vs ' +
        fmt(d.nonOperating.currentConversion) + 'x now. Tax rate used: ' +
        fmt(d.effectiveTaxRate, 1) + '%.' +
      '</div>';

    var b = document.getElementById('valClose');
    if (b) b.onclick = hide;
  }

  /* ---------- public API ---------- */
  window.VAL = {
    show: function (ticker) {
      ticker = ticker || currentTicker();
      var m = ensureModal();
      var box = document.getElementById('valModalBox');
      m.style.display = 'flex';

      if (!ticker) {
        box.innerHTML = '<div style="color:#e8edf3">No ticker selected. Analyze a company first, ' +
          'or call VAL.show("MSFT").</div>';
        return;
      }

      box.innerHTML = '<div style="color:#9fb0c4">Loading valuation for ' + esc(ticker) + '...</div>';

      fetch(API + '/api/valuation?symbol=' + encodeURIComponent(ticker))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) {
            box.innerHTML = '<div style="color:#e08c8c">Valuation failed: ' + esc(d.error) + '</div>';
            return;
          }
          render(d);
        })
        .catch(function (e) {
          box.innerHTML = '<div style="color:#e08c8c">Network error: ' + esc(e.message) + '</div>';
        });
    },
    hide: hide,
    raw: function (ticker) {
      return fetch(API + '/api/valuation?symbol=' + encodeURIComponent(ticker || currentTicker()))
        .then(function (r) { return r.json(); });
    }
  };

  /* ---------- floating button ---------- */
  function addButton() {
    if (document.getElementById('valBtn')) return;
    var b = document.createElement('button');
    b.id = 'valBtn';
    b.textContent = 'Valuation';
    b.title = 'Buffett two-column valuation (Shift+V)';
    b.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:9998',
      'background:#1f6feb', 'color:#fff', 'border:none', 'border-radius:22px',
      'padding:10px 18px', 'font-size:13px', 'font-weight:600', 'cursor:pointer',
      'box-shadow:0 4px 14px rgba(0,0,0,.4)', 'font-family:inherit'
    ].join(';');
    b.onclick = function () { VAL.show(); };
    document.body.appendChild(b);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addButton);
  } else {
    addButton();
  }

  console.log('Valuation panel active. Shift+V or VAL.show("TICKER")');
})();
