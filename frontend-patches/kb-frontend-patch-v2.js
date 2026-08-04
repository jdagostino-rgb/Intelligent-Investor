/* KB SYNC v2 - Knowledge Base auto-save layer
   Insert at the very end of the main inline script, before its closing tag.
   ASCII ONLY. Contains no script-closing sequence, no emoji, no box chars.

   v2 change: score is computed via calcScore(company) because the company
   object holds per-criterion scores in c.scores but no stored total.
*/
(function () {
  var KB_BASE = (function () {
    try { var o = localStorage.getItem('ii_kb_base'); if (o) return o; } catch (e) {}
    return 'https://api.iinvestor13.com';
  })();

  function kbPost(path, body) {
    try {
      return fetch(KB_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) {
        if (!r.ok) console.warn('KB save failed:', path, r.status);
        return r.ok ? r.json() : null;
      }).catch(function (e) { console.warn('KB offline:', e.message); return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function verdictFor(score) {
    if (score == null || isNaN(score)) return null;
    if (score >= 85) return 'Exceptional';
    if (score >= 70) return 'Strong Buy';
    if (score >= 55) return 'Watch Closely';
    if (score >= 40) return 'Needs Work';
    return 'Pass';
  }

  function currentRegime() {
    try {
      if (typeof macroData !== 'undefined' && macroData) {
        return macroData.regime || macroData.regimeLabel || macroData.regimeName || null;
      }
    } catch (e) {}
    return null;
  }

  window.KB = {
    base: KB_BASE,

    saveAnalysis: function (c) {
      if (!c) return Promise.resolve(null);
      var ticker = c.ticker || c.symbol || c.id || null;
      if (!ticker) return Promise.resolve(null);

      /* The company object stores per-criterion scores in c.scores but no
         total - the app computes it on demand via calcScore(). Call it. */
      var score = null;
      try {
        if (typeof calcScore === 'function') score = calcScore(c);
      } catch (e) { console.warn('KB: calcScore failed:', e.message); }
      if (score == null && c.score != null) score = c.score;
      if (score == null && c.totalScore != null) score = c.totalScore;
      var n = (score == null || isNaN(Number(score))) ? null : Number(score);

      var ai = c.aiAnalysis || {};
      return kbPost('/api/kb/analyses', {
        ticker: String(ticker).toUpperCase(),
        companyName: c.companyName || c.name || null,
        score: n,
        verdict: verdictFor(n),
        criteria: c.scores || c.criteria || null,
        macroRegime: currentRegime(),
        notes: c.notes || ai.overallVerdict || null,
        raw: c
      });
    },

    saveTrade: function (t) { return kbPost('/api/kb/trades', t); },

    savePref: function (key, value) { return kbPost('/api/kb/preferences', { key: key, value: value }); },

    saveConversation: function (summary, topics) {
      return kbPost('/api/kb/conversations', { summary: summary, topics: topics || [] });
    },

    context: function (ticker) {
      return fetch(KB_BASE + '/api/kb/context' + (ticker ? '?ticker=' + encodeURIComponent(ticker) : ''))
        .then(function (r) { return r.json(); })
        .catch(function () { return { text: '' }; });
    },

    /* Console helper: shows exactly what would be sent, without saving. */
    dryRun: function (c) {
      c = c || (typeof companies !== 'undefined' && companies.length ? companies[companies.length - 1] : null);
      if (!c) { console.log('KB.dryRun: no company found'); return null; }
      var s = null;
      try { if (typeof calcScore === 'function') s = calcScore(c); } catch (e) {}
      var out = { ticker: c.ticker, companyName: c.companyName, calcScore: s, verdict: verdictFor(Number(s)) };
      console.log('KB.dryRun:', out);
      return out;
    }
  };

  /* Hook 1: auto-save every completed analysis */
  if (typeof onAnalysisComplete === 'function') {
    var _kbOrigOAC = onAnalysisComplete;
    onAnalysisComplete = function (company) {
      var result = _kbOrigOAC.apply(this, arguments);
      try { KB.saveAnalysis(company); } catch (e) { console.warn('KB hook error:', e.message); }
      return result;
    };
  } else {
    console.warn('KB: onAnalysisComplete not found - analysis auto-save not hooked');
  }

  /* Hook 2: snapshot portfolio changes (debounced) */
  var _kbTimers = {};
  function debouncedSnapshot(prefKey, jsonString) {
    clearTimeout(_kbTimers[prefKey]);
    _kbTimers[prefKey] = setTimeout(function () {
      var val = null;
      try { val = JSON.parse(jsonString); } catch (e) { val = jsonString; }
      KB.savePref(prefKey, val);
    }, 3000);
  }

  var _kbOrigSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    _kbOrigSetItem.apply(this, arguments);
    try {
      if (this === localStorage) {
        if (key === 'ii_portfolios') debouncedSnapshot('portfolios_snapshot', value);
        if (key === 'ii_regimes')    debouncedSnapshot('regimes_snapshot', value);
      }
    } catch (e) {}
  };

  console.log('KB sync v2 active:', KB_BASE);
})();
