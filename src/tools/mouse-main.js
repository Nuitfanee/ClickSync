(function(){
  const isTestToolsActive = () => document.body.classList.contains('page-testtools');

// --- Button Setup ---
    const tr = (zh, en) => (typeof window !== 'undefined' && window.tr) ? window.tr(zh, en) : zh;

    const btnDefs = [
      { id: 0, key: 'left',   zh: '左键', en: 'Left Button' },
      { id: 1, key: 'middle', zh: '中键', en: 'Middle Button' },
      { id: 2, key: 'right',  zh: '右键', en: 'Right Button' },
      { id: 3, key: 'back',   zh: '后退', en: 'Back' },
      { id: 4, key: 'fwd',    zh: '前进', en: 'Forward' }
    ];

    const container = document.getElementById('btnContainer');
    const btnPanelOrder = ['left', 'middle', 'right', 'fwd', 'back'];

    // Only adjust card display order in the double-click page.
    // Keep button ID mapping unchanged (e.button -> stats object).
    function applyBtnPanelOrder() {
      if (!container) return;
      const orderedPanels = btnPanelOrder
        .map((key) => container.querySelector(`.mouse-btn.${key}`))
        .filter(Boolean);
      for (const panel of orderedPanels) container.appendChild(panel);
    }
    applyBtnPanelOrder();

    function appendAvgMetric(minValueEl, avgClassName) {
      if (!minValueEl) return;
      const rowEl = minValueEl.parentElement;
      if (!rowEl || rowEl.querySelector(`.${avgClassName}`)) return;
      rowEl.appendChild(document.createTextNode('  平均: '));
      const avgEl = document.createElement('span');
      avgEl.className = avgClassName;
      avgEl.textContent = '--';
      rowEl.appendChild(avgEl);
    }

    // Add an "average" slot on the same row as "minimum"
    // to avoid large static HTML changes.
    function ensureAvgDelayMetrics() {
      if (!container) return;
      const cards = container.querySelectorAll('.mouse-btn');
      for (const card of cards) {
        appendAvgMetric(card.querySelector('.dd-min'), 'dd-avg');
        appendAvgMetric(card.querySelector('.du-min'), 'du-avg');
      }
    }
    ensureAvgDelayMetrics();

    const pageMain = document.getElementById('pageMain');
    function isMainActive(){
      return !!(pageMain && pageMain.classList.contains('active'));
    }

    // Ignore UI controls (nav/language/theme/buttons/inputs) so tests don't break UI clicks
    function isUiControlTarget(target){
      if(!target || !target.closest) return false;
      return !!target.closest('header, .nav, .theme-toggle, .sidebar, #navLinks, .nav-item, .ttTabs, button, input, textarea, select, a, label');
    }

    function updateButtonTitles(){
      for (const b of btnDefs){
        const div = container && container.querySelector(`.mouse-btn.${b.key}`);
        const titleEl = div && div.querySelector('.btn-title');
        if(titleEl) titleEl.textContent = tr(b.zh, b.en);
      }
    }


    // Button-latency calculation uses a unified high-precision timeline
    // (auto-aligned between e.timeStamp and performance.now), plus robust
    // estimation (median filtering) and outlier trimming.
    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

    // Use performance.now() as the latency timing baseline
    // (monotonic and high precision).
    // event.timeStamp baselines vary by browser/system and can yield unstable deltas.
let __lastNow = 0;
function now() {
  const t = performance.now();
  // In rare cases timestamps can move backward slightly
  // (implementation differences / cross-thread timing). Keep monotonic protection.
  if (t < __lastNow) return __lastNow;
  __lastNow = t;
  return t;
}
    function robustMedian(arr) {
      if (!arr || arr.length === 0) return NaN;
      const a = arr.slice().sort((x, y) => x - y);
      const mid = (a.length - 1) / 2;
      const lo = Math.floor(mid);
      const hi = Math.ceil(mid);
      return (a[lo] + a[hi]) / 2;
    }

    function fmtMs(v) {
      if (!Number.isFinite(v)) return '--';
      // Show 2 decimals for values under 10ms to better observe switch jitter and very short intervals.
      if (v < 10) return v.toFixed(2) + ' ms';
      return v.toFixed(1) + ' ms';
    }

    const btns = btnDefs.map(b => {
      // Button cards are now static in HTML; resolve them directly by class.
      const div = container.querySelector(`.mouse-btn.${b.key}`);
      if(!div){
        console.warn('[mouse-main] Missing static button card:', b.key);
        return null;
      }

      // Optional: keep titles synchronized (even if HTML already has them).
      const titleEl = div.querySelector('.btn-title');
      if(titleEl) titleEl.textContent = tr(b.zh, b.en);

      return {
        def: b,
        el: div,
        ui: {
          dbl: div.querySelector('.dbl-val'),
          down: div.querySelector('.down-count'),
          up: div.querySelector('.up-count'),
          ddCurr: div.querySelector('.dd-curr'),
          ddMin: div.querySelector('.dd-min'),
          ddAvg: div.querySelector('.dd-avg'),
          duCurr: div.querySelector('.du-curr'),
          duMin: div.querySelector('.du-min'),
          duAvg: div.querySelector('.du-avg'),
        },
        stats: {
          down: 0, up: 0, dbl: 0,
          lastDownT: NaN,
          isDown: false,
          downStartT: NaN,
          minDD: Infinity, minDU: Infinity,
          sumDD: 0, countDD: 0,
          sumDU: 0, countDU: 0,
          ddWin: [],
          duWin: [],
          lastMouseDownTS: NaN,
        }
      };
    }).filter(Boolean);


    if (window.updateLiquidGlassDrops) window.updateLiquidGlassDrops();

    // Initial i18n sync for static titles created from JS
    updateButtonTitles();

    // Keep non-ID text in sync when language toggles (no refresh required)
    window.addEventListener('uilangchange', ()=>{
      updateButtonTitles();
    });


    const thresholdInput = document.getElementById('thresholdInput');
    const DEFAULT_THRESHOLD = 80;
    let threshold = DEFAULT_THRESHOLD;

    (function initThreshold() {
      const v = parseFloat(thresholdInput.value);
      if (Number.isFinite(v) && v > 1 && v < 1000) threshold = v;
      else {
        threshold = DEFAULT_THRESHOLD;
        thresholdInput.value = DEFAULT_THRESHOLD;
      }
    })();

    // Prevent wheel from changing number input values
    // (avoid unintended non-direct edits).
    thresholdInput.addEventListener('wheel', (e) => {
      if (document.activeElement === thresholdInput) e.preventDefault();
    }, { passive: false });

    thresholdInput.addEventListener('input', () => {
      const v = parseFloat(thresholdInput.value);
      if (Number.isFinite(v) && v > 1 && v < 1000) {
        threshold = v;
        thresholdInput.classList.remove('error-threshold');
      } else {
        thresholdInput.classList.add('error-threshold');
      }
    });

    thresholdInput.addEventListener('change', () => {
      const v = parseFloat(thresholdInput.value);
      if (Number.isFinite(v) && v > 1 && v < 1000) threshold = v;
      else {
        threshold = DEFAULT_THRESHOLD;
        thresholdInput.value = DEFAULT_THRESHOLD;
      }
      thresholdInput.classList.remove('error-threshold');
    });

    function pulseValue(el, isMin) {
      if (!el) return;
      // Only flash briefly for emphasis; do not change the final resting color.
      // In light themes, hard white may look invisible.
      el.style.color = isMin ? 'var(--accent-blue)' : 'white';
      setTimeout(() => {
        // Clear inline style to return to CSS default color
        // (for example .ttMini var(--muted)).
        el.style.color = '';
      }, 240);
    }
    function flashTitle(btn){
      const title = btn && btn.el ? btn.el.querySelector('.btn-title') : null;
      if(!title) return;
      title.classList.add('flash');
      clearTimeout(btn.__titleTimer);
      btn.__titleTimer = setTimeout(()=> title.classList.remove('flash'), 160);
    }


    // --- Mouse Events ---
    window.addEventListener('mousedown', (e) => {
      if(!isTestToolsActive()) return;
      if (!isMainActive()) return;
      if (typeof pollingOnly !== 'undefined' && pollingOnly) return;
      if (isUiControlTarget(e.target)) return;
      if (e.target && e.target.tagName === 'INPUT') return;

      const btn = btns[e.button];
      if (!btn) return;

      // Prevent default only for stats-area key actions to reduce side effects.
      e.preventDefault();

      btn.el.classList.add('active');
      flashTitle(btn);

      const nowT = now();

      // Debounce: ignore repeated mousedown events in the same press cycle
      // to avoid overwriting downStartT and skewing down-up latency.
      if (btn.stats.isDown) return;
      btn.stats.isDown = true;
      btn.stats.downStartT = nowT;

      // Down-Down (interval between consecutive press-down events)
      if (!btn.first && Number.isFinite(btn.stats.lastDownT)) {
        const rawDD = nowT - btn.stats.lastDownT;
        const ddShow = Math.min(rawDD, 999);

        // Outlier handling: very small values are often timestamp quantization/noise;
        // very large values do not help minimum-delay tracking.
        if (rawDD > 0.2 && rawDD < 3000) {
          // Sliding window for robust estimation (median filter).
          btn.stats.ddWin.push(rawDD);
          if (btn.stats.ddWin.length > 9) btn.stats.ddWin.shift();

          const ddEst = robustMedian(btn.stats.ddWin);

          // Display current as raw to keep it aligned with minimum-source behavior.
          btn.ui.ddCurr.textContent = fmtMs(ddShow);
          btn.ui.ddCurr.title = tr('平滑(中位数): ','Smoothed (median): ') + fmtMs(ddEst);

          if (rawDD < btn.stats.minDD) {
            btn.stats.minDD = rawDD;
            btn.ui.ddMin.textContent = fmtMs(Math.min(rawDD, 999));
            pulseValue(btn.ui.ddMin, true);
          }

          btn.stats.sumDD += rawDD;
          btn.stats.countDD++;
          if (btn.ui.ddAvg) {
            btn.ui.ddAvg.textContent = fmtMs(Math.min(btn.stats.sumDD / btn.stats.countDD, 999));
          }
        } else {
          // Even when excluded from statistics, still show current value for visibility.
          btn.ui.ddCurr.textContent = fmtMs(ddShow);
          btn.ui.ddCurr.title = '';
        }

        // Double-click detection uses rawDD (no filtering)
        // for more sensitive false-double/jitter capture.
        if (rawDD > 0 && rawDD < threshold) {
          btn.stats.dbl++;
          btn.ui.dbl.textContent = btn.stats.dbl;
          btn.ui.dbl.classList.add('warning');
          btn.el.style.borderColor = 'var(--accent-red)';
          setTimeout(() => { btn.el.style.borderColor = ''; }, 350);
        }
      }

      btn.stats.down++;
      btn.ui.down.textContent = btn.stats.down;
      btn.stats.lastDownT = nowT;
      btn.first = false;
    });

    window.addEventListener('mouseup', (e) => {
      if(!isTestToolsActive()) return;
      if (!isMainActive()) return;
      if (typeof pollingOnly !== 'undefined' && pollingOnly) return;
      if (isUiControlTarget(e.target)) return;
      const btn = btns[e.button];
      if (!btn) return;
      if (e.button === 3 || e.button === 4) e.preventDefault();
      btn.el.classList.remove('active');

      const titleEl = btn.el.querySelector('.btn-title');
      if(titleEl) titleEl.classList.remove('flash');

      const nowT = now();
      const downT = btn.stats.downStartT;

      if (btn.stats.isDown && Number.isFinite(downT)) {
        const rawDU = nowT - downT;

        if (rawDU > 0.2 && rawDU < 5000) {
          btn.stats.duWin.push(rawDU);
          if (btn.stats.duWin.length > 9) btn.stats.duWin.shift();

          const duEst = robustMedian(btn.stats.duWin);

          // Display current as raw to stay consistent with minimum tracking.
          btn.ui.duCurr.textContent = fmtMs(rawDU);
          btn.ui.duCurr.title = tr('平滑(中位数): ','Smoothed (median): ') + fmtMs(duEst);

          if (rawDU < btn.stats.minDU) {
            btn.stats.minDU = rawDU;
            btn.ui.duMin.textContent = fmtMs(rawDU);
            pulseValue(btn.ui.duMin, true);
          }

          btn.stats.sumDU += rawDU;
          btn.stats.countDU++;
          if (btn.ui.duAvg) {
            btn.ui.duAvg.textContent = fmtMs(btn.stats.sumDU / btn.stats.countDU);
          }
        } else {
          btn.ui.duCurr.textContent = fmtMs(rawDU);
          btn.ui.duCurr.title = '';
        }
      }

      // End one press cycle: reset state to avoid stuck state if mouseup is missed.
      btn.stats.isDown = false;
      btn.stats.downStartT = NaN;

      btn.stats.up++;
      btn.ui.up.textContent = btn.stats.up;
    });

    window.addEventListener('contextmenu', (e) => e.preventDefault());


    // Prevent stuck state when mouseup is not received
    // (window switch, blur, context menu, etc.).
    function resetButtonDownStates() {
      if(!isTestToolsActive()) return;
      for (const b of btns) {
        b.stats.isDown = false;
        b.stats.downStartT = NaN;
      }
    }
    window.addEventListener('blur', resetButtonDownStates);
    document.addEventListener('visibilitychange', () => {
      if(!isTestToolsActive()) return;
      if (document.visibilityState !== 'visible') resetButtonDownStates();
    });


    // --- Scroll Events ---
    // 1) Remove left/right wheel stats: track only vertical wheel.
    const sUI = {
      up:   { val: 0, el: document.getElementById('sUp'),   icon: document.getElementById('wrapUp').querySelector('.scroll-arrow') },
      down: { val: 0, el: document.getElementById('sDown'), icon: document.getElementById('wrapDown').querySelector('.scroll-arrow') },
    };

// Reset statistics (double-click test page)
const resetClicksBtn = document.getElementById('resetClicks');
if (resetClicksBtn){
  resetClicksBtn.addEventListener('click', ()=>{
    // reset button cards
    for (const b of btns){
      b.stats.down = 0; b.stats.up = 0; b.stats.dbl = 0;
      b.stats.lastDownT = NaN;
      b.stats.isDown = false;
      b.stats.downStartT = NaN;
      b.stats.minDD = Infinity; b.stats.minDU = Infinity;
      b.stats.sumDD = 0; b.stats.countDD = 0;
      b.stats.sumDU = 0; b.stats.countDU = 0;
      b.stats.ddWin = []; b.stats.duWin = [];
      b.first = true;

      b.ui.dbl.textContent = '0';
      b.ui.dbl.classList.remove('warning');
      b.ui.down.textContent = '0';
      b.ui.up.textContent = '0';
      b.ui.ddCurr.textContent = '--';
      b.ui.ddMin.textContent = '--';
      if (b.ui.ddAvg) b.ui.ddAvg.textContent = '--';
      b.ui.duCurr.textContent = '--';
      b.ui.duMin.textContent = '--';
      if (b.ui.duAvg) b.ui.duAvg.textContent = '--';
      b.el.style.borderColor = '';
    }
    // reset scroll
    sUI.up.val = 0; sUI.down.val = 0;
    sUI.up.el.textContent = '0';
    sUI.down.el.textContent = '0';

    // reset custom key (if exists)
    if (typeof resetCustomKeyStats === 'function') resetCustomKeyStats(true);
  });
}

    // --- Custom Key Test (any keyboard key: down/up/interval/hold) ---
    const pageMainEl = document.getElementById('pageMain');
const kPickBtn = document.getElementById('pickKeyBtn');
    const kResetBtn = document.getElementById('resetKeyBtn');
    const kState = document.getElementById('customKeyState');

    const kUI = {
      down: document.getElementById('kDown'),
      up: document.getElementById('kUp'),
      dbl: document.getElementById('kDbl'),
      thrInput: document.getElementById('kThresholdInput'),
      ddCurr: document.getElementById('kDDCurr'),
      ddMin: document.getElementById('kDDMin'),
      ddAvg: document.getElementById('kDDAvg'),
      duCurr: document.getElementById('kDUCurr'),
      duMin: document.getElementById('kDUMin'),
      duAvg: document.getElementById('kDUAvg'),
    };

    const kStats = {
      down: 0,
      up: 0,
      dbl: 0,
      lastDownT: NaN,
      isDown: false,
      downStartT: NaN,
      minDD: Infinity,
      minDU: Infinity,
      sumDD: 0,
      countDD: 0,
      sumDU: 0,
      countDU: 0,
      ddWin: [],
      duWin: [],
    };

// Custom-key detection: independent double-click threshold
// (affects this panel only).
function readKeyThreshold(){
  const v = parseFloat(kUI.thrInput && kUI.thrInput.value);
  if (Number.isFinite(v) && v > 1 && v < 1000) {
    kDblThreshold = v;
    if (kUI.thrInput) kUI.thrInput.classList.remove('error-threshold');
  } else {
    kDblThreshold = 80;
    if (kUI.thrInput) {
      kUI.thrInput.value = '80';
      kUI.thrInput.classList.add('error-threshold');
      setTimeout(()=> kUI.thrInput && kUI.thrInput.classList.remove('error-threshold'), 520);
    }
  }
}


    let kPickMode = false;
    let selectedKey = '';
    let selectedCode = '';

    let kDblThreshold = 80;

    function syncPickBtnLabel(){
      if(!kPickBtn) return;
      kPickBtn.textContent = kPickMode ? tr('退出','Exit') : tr('录入','Pick');
    }


    function normStr(s){ return (s || '').trim(); }

    function fmtSel(){
      const k = selectedKey ? `key=${JSON.stringify(selectedKey)}` : '';
      const c = selectedCode ? `code=${selectedCode}` : '';
      const t = [c, k].filter(Boolean).join('  ');
      return t || tr('未选择','Not selected');
    }

    function updateKeyState(text, isDown){
      if(!kState) return;
      kState.textContent = text;
      // Let CSS control pressed/shadow visuals; only toggle state class here.
      // Also clear old inline styles to avoid overriding CSS.
      kState.style.borderColor = '';
      kState.style.background = '';
      kState.style.color = '';
      kState.classList.toggle('is-down', !!isDown);
    }

    function resetCustomKeyStats(soft){
      kStats.down = 0; kStats.up = 0; kStats.dbl = 0;
      kStats.lastDownT = NaN;
      kStats.isDown = false;
      kStats.downStartT = NaN;
      kStats.minDD = Infinity;
      kStats.minDU = Infinity;
      kStats.sumDD = 0;
      kStats.countDD = 0;
      kStats.sumDU = 0;
      kStats.countDU = 0;
      kStats.ddWin = []; kStats.duWin = [];

      if(kUI.down) kUI.down.textContent = '0';
      if(kUI.up) kUI.up.textContent = '0';
      if(kUI.ddCurr) kUI.ddCurr.textContent = '--';
      if(kUI.ddMin) kUI.ddMin.textContent = '--';
      if(kUI.ddAvg) kUI.ddAvg.textContent = '--';
      if(kUI.duCurr) kUI.duCurr.textContent = '--';
      if(kUI.duMin) kUI.duMin.textContent = '--';
      if(kUI.duAvg) kUI.duAvg.textContent = '--';
      if(kUI.dbl) kUI.dbl.textContent = '0';
      if(!soft) updateKeyState(tr('状态：--','Status: --'), false);
    }
    window.resetCustomKeyStats = resetCustomKeyStats;

    function matchSelectedKey(e){
      if (selectedCode) return e.code === selectedCode;
      if (selectedKey) return e.key === selectedKey;
      return false;
    }

    function consumePick(e){
      if(!kPickMode) return false;
      if(e.key === 'Escape'){
        kPickMode = false;
        syncPickBtnLabel();
        updateKeyState(tr('状态：已取消录入','Status: Pick canceled'), false);
        return true;
      }
      const prevKey = selectedKey;
      const prevCode = selectedCode;
      selectedKey = e.key;
      selectedCode = e.code;
      const changed = (prevKey !== selectedKey) || (prevCode !== selectedCode);
      if (changed) resetCustomKeyStats(true);
      kPickMode = false;
      syncPickBtnLabel();
      updateKeyState(tr(`状态：已选择 ${selectedCode || selectedKey}`, `Status: Selected ${selectedCode || selectedKey}`), false);
      return true;
    }

    function handleKeyDown(e){
      if (typeof pollingOnly !== 'undefined' && pollingOnly) return;
      if (!pageMainEl || !pageMainEl.classList.contains('active')) return;

      if (consumePick(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
        return;
      }

      if (!matchSelectedKey(e)) return;
      e.preventDefault();

      const t = now();
      // key repeat: ignore repeated keydown while holding
      if (kStats.isDown) return;
      kStats.isDown = true;
      kStats.downStartT = t;

      if (Number.isFinite(kStats.lastDownT)) {
        const rawDD = t - kStats.lastDownT;
        const ddShow = Math.min(rawDD, 999);
        if (rawDD > 0.2 && rawDD < 3000) {
          kStats.ddWin.push(rawDD);
          if (kStats.ddWin.length > 9) kStats.ddWin.shift();
          const ddEst = robustMedian(kStats.ddWin);
          if (kUI.ddCurr){ kUI.ddCurr.textContent = fmtMs(ddShow); kUI.ddCurr.title = tr('平滑(中位数): ','Smoothed (median): ') + fmtMs(ddEst); }
          if (rawDD < kStats.minDD) {
            kStats.minDD = rawDD;
            if (kUI.ddMin) { kUI.ddMin.textContent = fmtMs(Math.min(rawDD, 999)); pulseValue(kUI.ddMin, true); }
          }
          kStats.sumDD += rawDD;
          kStats.countDD++;
          if (kUI.ddAvg) kUI.ddAvg.textContent = fmtMs(Math.min(kStats.sumDD / kStats.countDD, 999));
        } else {
          if (kUI.ddCurr){ kUI.ddCurr.textContent = fmtMs(ddShow); kUI.ddCurr.title = ''; }
        }

        if (rawDD > 0 && rawDD < kDblThreshold) {
          kStats.dbl++;
          if (kUI.dbl) kUI.dbl.textContent = String(kStats.dbl);
        }
      }

      kStats.down++;
      if (kUI.down) kUI.down.textContent = String(kStats.down);
      kStats.lastDownT = t;
      updateKeyState(tr(`状态：按下（${fmtSel()}）${kStats.dbl?`  双击：${kStats.dbl}`:''}`, `Status: Down (${fmtSel()})${kStats.dbl?`  Double: ${kStats.dbl}`:''}`), true);
    }

    function handleKeyUp(e){
      if (typeof pollingOnly !== 'undefined' && pollingOnly) return;
      if (!pageMainEl || !pageMainEl.classList.contains('active')) return;
      if (!matchSelectedKey(e)) return;
      e.preventDefault();

      const t = now();
      const downT = kStats.downStartT;
      if (kStats.isDown && Number.isFinite(downT)) {
        const rawDU = t - downT;
        if (rawDU > 0.2 && rawDU < 5000) {
          kStats.duWin.push(rawDU);
          if (kStats.duWin.length > 9) kStats.duWin.shift();
          const duEst = robustMedian(kStats.duWin);
          if (kUI.duCurr){ kUI.duCurr.textContent = fmtMs(rawDU); kUI.duCurr.title = tr('平滑(中位数): ','Smoothed (median): ') + fmtMs(duEst); }
          if (rawDU < kStats.minDU) {
            kStats.minDU = rawDU;
            if (kUI.duMin) { kUI.duMin.textContent = fmtMs(rawDU); pulseValue(kUI.duMin, true); }
          }
          kStats.sumDU += rawDU;
          kStats.countDU++;
          if (kUI.duAvg) kUI.duAvg.textContent = fmtMs(kStats.sumDU / kStats.countDU);
        } else {
          if (kUI.duCurr){ kUI.duCurr.textContent = fmtMs(rawDU); kUI.duCurr.title = ''; }
        }
      }

      kStats.isDown = false;
      kStats.downStartT = NaN;
      kStats.up++;
      if (kUI.up) kUI.up.textContent = String(kStats.up);
      updateKeyState(tr(`状态：抬起（${fmtSel()}）`, `Status: Up (${fmtSel()})`), false);
    }

    function resetKeyDownStateOnly(){
      kStats.isDown = false;
      kStats.downStartT = NaN;
      updateKeyState(tr('状态：--','Status: --'), false);
    }

    if (kPickBtn){
      kPickBtn.addEventListener('click', ()=>{
        kPickMode = !kPickMode;
        if(kPickMode){
          updateKeyState(tr('状态：录入中（按一次键；ESC 取消）','Status: Picking (press a key once; ESC cancels)'), false);
          try{ /* no-op */ }catch(_){ }
        }else{
          updateKeyState(tr('状态：已退出录入','Status: Exited picking'), false);
        }
        syncPickBtnLabel();
      });
    }
    if (kResetBtn){
      kResetBtn.addEventListener('click', ()=>{
        // Reset: clear statistics and release/clear the currently picked key.
        selectedKey = '';
        selectedCode = '';
        kPickMode = false;
        syncPickBtnLabel();
        resetCustomKeyStats(false);
      });
    }


if (kUI.thrInput){
  // Initialize and bind listeners
  readKeyThreshold();
  kUI.thrInput.addEventListener('input', readKeyThreshold);
  kUI.thrInput.addEventListener('blur', readKeyThreshold);
}

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', resetKeyDownStateOnly);
    document.addEventListener('visibilitychange', ()=>{
      if(!isTestToolsActive()) return;
      if (document.visibilityState !== 'visible') resetKeyDownStateOnly();
    });

    resetCustomKeyStats(false);
    syncPickBtnLabel();

    function flashIcon(item) {
      item.val++;
      item.el.textContent = item.val;
      item.icon.style.color = 'var(--accent-blue)';
      item.icon.style.transform = 'scale(1.2)';
      clearTimeout(item.timer);
      item.timer = setTimeout(() => {
        item.icon.style.color = '';
        item.icon.style.transform = '';
      }, 150);
    }

    window.addEventListener('wheel', (e) => {
      if(!isTestToolsActive()) return;
      if (!isMainActive()) return;
      if (typeof pollingOnly !== 'undefined' && pollingOnly) return;
      if (isUiControlTarget(e.target)) return;
      e.preventDefault();

      const dy = e.deltaY;
      if (dy < 0) flashIcon(sUI.up);
      if (dy > 0) flashIcon(sUI.down);
    }, { passive: false });

    // --- Polling Rate (higher accuracy via coalesced-event timestamp sequence) ---
    const rateBox = document.getElementById('rateBox');
    const stopPollBtn = document.getElementById('stopPoll');
    const hzDisp = document.getElementById('hzDisplay');
    const hzHint = document.getElementById('hzHint');
    const hzPeak = document.getElementById('hzPeak');
    const hzAvg = document.getElementById('hzAvg');
    const hzJit = document.getElementById('hzJit');
    const hzSamples = document.getElementById('hzSamples');
    const pollRing = document.getElementById('pollRing');
    const hzChart = document.getElementById('hzChart');
    const hzCtx = hzChart ? hzChart.getContext('2d') : null;
    const hist = []; // {t, v}
    const HIST_MS = 3000;

    let locked = false;
    let endRequested = false; // 点击“结束”触发：退出锁定后清空数据
    let peakRate = 0;

    // Polling-rate focus mode: block other stats/wheel features while active.
    let pollingOnly = false;

    // Keep raw input-report timestamps inside the window (from coalesced events).
    const tsRing = [];
    let lastUiUpdate = 0;

    let uiTimer = null;
    let lastUsedCoalesced = true;
    let lastIngestAt = 0;

    // Longer windows are steadier, shorter windows are more responsive.
    // Current setting converges quickly even at 8k.
    const WINDOW_MS = 250;
    const MIN_SPAN_MS = 180;
    const UI_UPDATE_MS = 80;

    // Common USB polling tiers used for slight snapping
    // to avoid tiny over-shoot readings like 4.1k for 4k.
    const COMMON_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];
    const SNAP_TOL = 0.015; // 6%
    const MULTI_DEVICE_WARN_THRESHOLD = 8500;
    let multiDeviceWarned = false;

    function resetMultiDeviceWarning() {
      multiDeviceWarned = false;
    }

    function showMultiDeviceWarning(rate) {
      if (multiDeviceWarned) return;
      if (!Number.isFinite(rate) || rate <= MULTI_DEVICE_WARN_THRESHOLD) return;

      multiDeviceWarned = true;
      const warningText = tr(
        '检测到轮询率异常，可能存在多设备同时上报。请断开其他设备后重测。',
        'Multiple devices may be reporting at once. Disconnect other devices and test again.'
      );

      hzHint.textContent = warningText;
      alert(warningText);
    }

    function normTimeStamp(ts) {
      if (!Number.isFinite(ts)) return NaN;
      // In some environments timeStamp may be near epoch-ms; convert once.
      if (ts > 1e12 && Number.isFinite(performance.timeOrigin)) return ts - performance.timeOrigin;
      return ts;
    }

    function pushStamp(t) {
      if (!Number.isFinite(t)) return;
      const last = tsRing.length ? tsRing[tsRing.length - 1] : -Infinity;
      // Spec expects monotonic coalesced timestamps, but some implementations
      // may regress slightly. Clamp to last to avoid shortened span and inflated rate.
      tsRing.push(t < last ? last : t);
    }

    function ingest(e) {
      let usedCoalesced = false;

      if (typeof e.getCoalescedEvents === 'function') {
        try {
          const list = e.getCoalescedEvents();
          if (list && list.length) {
            usedCoalesced = true;
            for (let i = 0; i < list.length; i++) {
              pushStamp(normTimeStamp(list[i].timeStamp));
            }
          }
        } catch (_) {}
      }

      if (!usedCoalesced) {
        // Fallback: without coalescedEvents, only parent-event timestamp is available
        // (high polling rates can be notably underestimated).
        pushStamp(normTimeStamp(e.timeStamp));
      }

      // purge old samples
      if (tsRing.length >= 2) {
        const newest = tsRing[tsRing.length - 1];
        const cutoff = newest - WINDOW_MS;
        // Keep at least two points and keep first point near cutoff
        // to avoid oversized span and slow response.
        while (tsRing.length > 2 && tsRing[1] < cutoff) tsRing.shift();
      }

      return usedCoalesced;
    }
    function pruneByNow(now) {
      // If no new events arrive for a while, advance the window with "now"
      // so the rate naturally decays to 0.
      const cutoff = now - WINDOW_MS;
      if (tsRing.length && tsRing[tsRing.length - 1] < cutoff) {
        tsRing.length = 0;
        return;
      }
      while (tsRing.length && tsRing[0] < cutoff) tsRing.shift();
    }

    function tryUpdateUi(now) {
      if (now - lastUiUpdate < UI_UPDATE_MS) return;
      lastUiUpdate = now;
      pruneByNow(now);

      const r = computeRate();
      if (r == null) {
        hzDisp.textContent = '0';
        hzDisp.style.color = '';
        updateExtraStats(0);
        // Do not update peak.
        return;
      }

      const disp = snapRate(r);
      hzDisp.textContent = String(disp);
      applyColor(disp);
      updateExtraStats(disp);
      showMultiDeviceWarning(disp);

      if (disp > peakRate) {
        peakRate = disp;
        hzPeak.textContent = `${peakRate} Hz`;
      }

      if (!lastUsedCoalesced && !multiDeviceWarned) {
        hzHint.textContent = tr('浏览器未提供 coalesced 数据：高回报率可能被低估（建议 HTTPS/Chrome/Edge）', 'Coalesced events not available: high polling rates may be underestimated (try HTTPS + Chrome/Edge).');
      }
    }


    function computeRate() {
      if (tsRing.length < 2) return null;
      const span = tsRing[tsRing.length - 1] - tsRing[0];
      if (span < MIN_SPAN_MS) return null;

      const reports = tsRing.length - 1;
      const rate = reports * 1000 / span;
      // Extreme guard: block NaN/Infinity and implausible spikes.
      if (!Number.isFinite(rate) || rate <= 0) return null;
      return Math.min(rate, 20000);
    }

    function snapRate(rate) {
      // Mild snapping only when very close to a known tier,
      // to avoid misclassifying real 6k as 8k.
      let best = COMMON_RATES[0];
      let bestRel = Infinity;
      for (const r of COMMON_RATES) {
        const rel = Math.abs(rate - r) / r;
        if (rel < bestRel) { bestRel = rel; best = r; }
      }
      if (bestRel <= SNAP_TOL) return best;
      return Math.round(rate);
    }

    // ===== Tier color (soft + hysteresis + smooth) =====
const TIER_LEVELS = [1000, 2000, 4000, 8000];
const TIER_BOUNDS = [1500, 3000, 6000]; // midpoints between tiers
const TIER_HYS = 0.10;      // hysteresis band around bounds (prevents flicker)
const TIER_HOLD_MS = 220;   // minimum hold time before switching again

// Light theme: higher polling rates use deeper gray (light -> black).
const LIGHT_TIER_RGB = {
  1000: [180, 180, 180],
  2000: [120, 120, 120],
  4000: [60, 60, 60],
  8000: [0, 0, 0],
};

// Dark theme: reverse to brighter tones (gray -> white) for visibility.
const DARK_TIER_RGB = {
  1000: [150, 150, 150],
  2000: [188, 188, 188],
  4000: [224, 224, 224],
  8000: [255, 255, 255],
};

function isDarkTheme() {
  return !!(document.body && document.body.classList.contains('dark'));
}

function currentTierRgbMap() {
  return isDarkTheme() ? DARK_TIER_RGB : LIGHT_TIER_RGB;
}

function tierRgbFor(level) {
  const map = currentTierRgbMap();
  return (map[level] || map[1000]).slice();
}

let tierState = 1000;
let tierHoldUntil = 0;

// Smooth color transition (lag) to avoid flashing
let tierRgbCur = tierRgbFor(1000);
let tierRgbTgt = tierRgbFor(1000);
let tierThemeDark = isDarkTheme();

function rgba(rgb, a){
  return `rgba(${rgb[0].toFixed(0)},${rgb[1].toFixed(0)},${rgb[2].toFixed(0)},${a})`;
}

function syncTierTheme() {
  const dark = isDarkTheme();
  if (dark === tierThemeDark) return;
  tierThemeDark = dark;
  const nextRgb = tierRgbFor(tierState);
  tierRgbCur = nextRgb.slice();
  tierRgbTgt = nextRgb.slice();
}

function tierFor(rate){
  // Choose a tier by midpoints (no hysteresis; used only as a helper)
  if (rate >= TIER_BOUNDS[2]) return 8000;
  if (rate >= TIER_BOUNDS[1]) return 4000;
  if (rate >= TIER_BOUNDS[0]) return 2000;
  return 1000;
}

function updateTierHys(rate, now){
  // State machine with hysteresis + hold time
  if (now < tierHoldUntil) return tierState;

  const b12 = TIER_BOUNDS[0], b24 = TIER_BOUNDS[1], b48 = TIER_BOUNDS[2];
  const up12 = b12*(1+TIER_HYS), dn12 = b12*(1-TIER_HYS);
  const up24 = b24*(1+TIER_HYS), dn24 = b24*(1-TIER_HYS);
  const up48 = b48*(1+TIER_HYS), dn48 = b48*(1-TIER_HYS);

  let next = tierState;

  if (tierState === 1000){
    if (rate > up12) next = 2000;
  } else if (tierState === 2000){
    if (rate > up24) next = 4000;
    else if (rate < dn12) next = 1000;
  } else if (tierState === 4000){
    if (rate > up48) next = 8000;
    else if (rate < dn24) next = 2000;
  } else { // 8000
    if (rate < dn48) next = 4000;
  }

  if (next !== tierState){
    tierState = next;
    tierHoldUntil = now + TIER_HOLD_MS;
    tierRgbTgt = tierRgbFor(tierState);
    pollRing && (pollRing.dataset.tier = String(tierState));
  }

  return tierState;
}

function tickTierColor(dt){
  // Lower frequency/longer easing to avoid "flashing" on abrupt changes
  const k = 1 - Math.exp(-dt * 5.5);
  for (let i = 0; i < 3; i++){
    tierRgbCur[i] += (tierRgbTgt[i] - tierRgbCur[i]) * k;
  }
}

function softColor(alpha = 0.90){ return rgba(tierRgbCur, alpha); }

function tierColor(_tier){ return softColor(isDarkTheme() ? 0.94 : 0.88); }
function tierTrack(_tier){ return softColor(isDarkTheme() ? 0.22 : 0.14); }

function applyColor(rate) {
  syncTierTheme();
  // Update tier state with hysteresis (visual color is smoothed in tickRing)
  updateTierHys(rate, performance.now());
  hzDisp.style.color = softColor(0.92);
  // ring reads pollRing.dataset.tier; keep it updated
  pollRing && (pollRing.dataset.tier = String(tierState));
}

/* ====== Ring (Canvas, anti-aliased + smooth) ====== */
const ringCanvas = document.getElementById('ringCanvas');
const ringCtx = ringCanvas ? ringCanvas.getContext('2d', { alpha: true }) : null;
const pagePollEl = document.getElementById('pagePoll');
let ringTargetRate = 0;
let ringSmoothRate = 0;
let ringLastT = performance.now();
let ringNeedsDraw = true;
let histSampleAt = 0;
const HIST_SAMPLE_MS = 16; // ~60fps curve sampling for smoother visuals

function resizeCanvasToCSS(canvas, ctx, maxDpr=2){
  if(!canvas || !ctx) return {w:0,h:0,dpr:1};
  const cssW = canvas.clientWidth || canvas.width || 1;
  const cssH = canvas.clientHeight || canvas.height || 1;
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(2, Math.floor(cssW * dpr));
  const h = Math.max(2, Math.floor(cssH * dpr));
  if(canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
  return {w,h,dpr};
}

function drawRing(){
  if(!ringCtx || !ringCanvas) return;
  syncTierTheme();
  const {w,h,dpr} = resizeCanvasToCSS(ringCanvas, ringCtx, 2);
  const cx = w*0.5, cy = h*0.5;
  const rOuter = Math.min(w,h)*0.5;
  const pad = 18*dpr;
  const radius = Math.max(10, rOuter - pad);
  const lw = Math.max(10*dpr, radius*0.14);
  const start = -Math.PI/2;
  const max = 8000;
  const pct = Math.max(0, Math.min(1, ringSmoothRate / max));
  const end = start + pct * Math.PI * 2;

  ringCtx.clearRect(0,0,w,h);
  ringCtx.save();
  ringCtx.lineCap = 'round';
  ringCtx.lineJoin = 'round';
  ringCtx.lineWidth = lw;

  // track
  const tier = parseInt(pollRing?.dataset?.tier || '1000', 10) || 1000;
  ringCtx.strokeStyle = tierTrack(tier);
  ringCtx.beginPath();
  ringCtx.arc(cx, cy, radius, 0, Math.PI*2);
  ringCtx.stroke();

  // glow under arc
  if(pct > 0.001){
    const dark = isDarkTheme();
    ringCtx.save();
    ringCtx.shadowBlur = 18*dpr;
    ringCtx.shadowColor = softColor(0.26);
    ringCtx.strokeStyle = softColor(0.34);
    ringCtx.beginPath();
    ringCtx.arc(cx, cy, radius, start, end);
    ringCtx.stroke();
    ringCtx.restore();

    // main arc (crisp)
    ringCtx.strokeStyle = tierColor(tier);
    ringCtx.beginPath();
    ringCtx.arc(cx, cy, radius, start, end);
    ringCtx.stroke();

    // tiny highlight tip
    ringCtx.save();
    ringCtx.shadowBlur = 10*dpr;
    ringCtx.shadowColor = dark ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.35)';
    ringCtx.strokeStyle = dark ? 'rgba(255,255,255,0.34)' : 'rgba(255,255,255,0.22)';
    ringCtx.lineWidth = lw*0.55;
    ringCtx.beginPath();
    ringCtx.arc(cx, cy, radius, Math.max(start, end-0.16), end);
    ringCtx.stroke();
    ringCtx.restore();
  }

  ringCtx.restore();
}

function tickRing(now){
  if(!isTestToolsActive()){
    setTimeout(() => requestAnimationFrame(tickRing), 250);
    return;
  }

  if(pagePollEl && !pagePollEl.classList.contains('active')){ requestAnimationFrame(tickRing); return; }
  const dt = Math.min(0.05, Math.max(0.001, (now - ringLastT) / 1000));
  ringLastT = now;
  syncTierTheme();
  // Tier hysteresis + smooth color (use smoothed rate to avoid flashing)
  updateTierHys(ringSmoothRate, now);
  tickTierColor(dt);
  if (hzDisp) hzDisp.style.color = softColor(0.92);
  // smooth (fast response, no jitter)
  const k = 1 - Math.exp(-dt * 14);
  ringSmoothRate += (ringTargetRate - ringSmoothRate) * k;
  // snap very close
  if(Math.abs(ringTargetRate - ringSmoothRate) < 0.5) ringSmoothRate = ringTargetRate;
  ringNeedsDraw = ringNeedsDraw || (locked && (now - lastIngestAt) < 1200) || (Math.abs(ringTargetRate - ringSmoothRate) > 0.5);
  if(ringNeedsDraw){
    drawRing();
    ringNeedsDraw = false;
  }

  // smooth chart: sample at ~30fps using the smoothed value
  if(locked && hzCtx && (now - histSampleAt) >= HIST_SAMPLE_MS){
    histSampleAt = now;
    pushHist(ringSmoothRate, now);
    drawChart(now);
  } else if(!locked && hzCtx){
    // paused: still redraw occasionally on resize
  }

  requestAnimationFrame(tickRing);
}
requestAnimationFrame(tickRing);


function computeJitterMs(){
  if(tsRing.length < 3) return null;
  const d = [];
  for(let i=1;i<tsRing.length;i++){
    const dt = tsRing[i] - tsRing[i-1];
    if(dt > 0 && dt < 50) d.push(dt);
  }
  if(d.length < 4) return null;
  const mean = d.reduce((a,b)=>a+b,0)/d.length;
  const var_ = d.reduce((a,b)=>a+(b-mean)*(b-mean),0)/d.length;
  return Math.sqrt(var_);
}

function updateExtraStats(rate){
  if(hzSamples) hzSamples.textContent = tsRing.length ? tr(`${tsRing.length} 点`, `${tsRing.length} pts`) : '--';
  const avg = computeRate();
  if(hzAvg) hzAvg.textContent = (avg==null) ? '-- Hz' : `${Math.round(avg)} Hz`;
  const j = computeJitterMs();
  if(hzJit) hzJit.textContent = (j==null) ? '-- ms' : `${j.toFixed(2)} ms`;
  ringTargetRate = rate;
  ringNeedsDraw = true;
}

function pushHist(v, now){
  if(!hzCtx) return;
  hist.push({t: now, v});
  const cutoff = now - HIST_MS;
  while(hist.length && hist[0].t < cutoff) hist.shift();
}

function chartPalette() {
  if (isDarkTheme()) {
    return {
      grid: 'rgba(255,255,255,0.14)',
      labels: 'rgba(255,255,255,0.72)',
      curve: 'rgba(255,255,255,0.9)',
      point: 'rgba(255,255,255,0.96)',
    };
  }
  return {
    grid: 'rgba(0,0,0,0.08)',
    labels: 'rgba(0,0,0,0.55)',
    curve: 'rgba(0,0,0,0.85)',
    point: 'rgba(0,0,0,0.92)',
  };
}

function drawChart(now){
  if(!hzCtx || !hzChart) return;
  const palette = chartPalette();

  const cssW = hzChart.clientWidth || 800;
  const cssH = hzChart.clientHeight || 320;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(2, Math.floor(cssW * dpr));
  const h = Math.max(2, Math.floor(cssH * dpr));
  if(hzChart.width !== w || hzChart.height !== h){
    hzChart.width = w; hzChart.height = h;
  }

  // Dynamic Y-axis: pick 1k/2k/4k/8k by peak range (capped at 8k).
  function axisMaxFor(peak){
    if(!Number.isFinite(peak) || peak <= 0) return 1000;
    if(peak <= 1200) return 1000;
    if(peak <= 2600) return 2000;
    if(peak <= 5200) return 4000;
    return 8000;
  }
  const peakNow = Math.max(peakRate || 0, ringTargetRate || 0, ringSmoothRate || 0);
  const axisMax = axisMaxFor(peakNow);

  const padL = Math.round(52 * dpr);
  const padR = Math.round(12 * dpr);
  const padT = Math.round(10 * dpr);
  const padB = Math.round(22 * dpr);
  const pw = Math.max(10, w - padL - padR);
  const ph = Math.max(10, h - padT - padB);

  hzCtx.clearRect(0,0,w,h);
  hzCtx.lineJoin = 'round';
  hzCtx.lineCap = 'round';
  hzCtx.imageSmoothingEnabled = true;

  // Background grid (horizontal tick lines)
  hzCtx.save();
  hzCtx.strokeStyle = palette.grid;
  hzCtx.lineWidth = Math.max(1, Math.floor(1*dpr));
  const gridTicks = [0, 1000, 2000, 4000, 8000].filter(v => v <= axisMax);
  for(const val of gridTicks){
    const yy = 1 - (val / axisMax);
    const y = padT + yy * ph;
    hzCtx.beginPath();
    hzCtx.moveTo(padL, y);
    hzCtx.lineTo(padL + pw, y);
    hzCtx.stroke();
  }
  // Vertical grid (6 segments)
  for(let i=0;i<=6;i++){
    const x = padL + (pw * (i/6));
    hzCtx.beginPath();
    hzCtx.moveTo(x, padT);
    hzCtx.lineTo(x, padT + ph);
    hzCtx.stroke();
  }

  // Y-axis labels (fixed ticks: 1000, 2000, 4000, 8000)
  const fmt = (v)=> (v>=1000 ? (v/1000)+'k' : String(v));
  hzCtx.fillStyle = palette.labels;
  hzCtx.font = `${Math.round(11*dpr)}px var(--font-stack)`;
  hzCtx.textAlign = 'right';
  hzCtx.textBaseline = 'middle';
  const tickValues = [0, 1000, 2000, 4000, 8000].filter(v => v <= axisMax);
  for(const val of tickValues){
    const yy = 1 - (val / axisMax);
    const y = padT + yy * ph;
    hzCtx.fillText(fmt(val), padL - Math.round(10*dpr), y);
  }
  hzCtx.restore();

  if(hist.length < 2) return;

  // Time window
  const t1 = now;
  const t0 = t1 - HIST_MS;

  // Curve (pure black, smoothed with Bezier)
  hzCtx.save();
  hzCtx.strokeStyle = palette.curve;
  hzCtx.lineWidth = Math.max(2*dpr, 2.2*dpr);
  hzCtx.beginPath();

  // Compute all visible point coordinates first.
  const pts = [];
  for(const p of hist){
    if(p.t < t0) continue;
    const x = padL + ((p.t - t0) / HIST_MS) * pw;
    const yy = Math.max(0, Math.min(1, p.v / axisMax));
    const y = padT + (1 - yy) * ph;
    pts.push({x, y});
  }

  // Use quadratic Bezier curves to smooth links between points.
  if(pts.length >= 2){
    hzCtx.moveTo(pts[0].x, pts[0].y);
    for(let i = 0; i < pts.length - 1; i++){
      const p0 = pts[i];
      const p1 = pts[i + 1];
      // Use midpoint control/endpoints for smooth transitions.
      const midX = (p0.x + p1.x) / 2;
      const midY = (p0.y + p1.y) / 2;
      hzCtx.quadraticCurveTo(p0.x, p0.y, midX, midY);
    }
    // Final segment connects to the end point.
    const lastPt = pts[pts.length - 1];
    hzCtx.lineTo(lastPt.x, lastPt.y);
    hzCtx.stroke();
  } else if(pts.length === 1){
    hzCtx.moveTo(pts[0].x, pts[0].y);
  }

  // Latest point (pure black)
  const last = hist[hist.length-1];
  if(last){
    const x = padL + ((last.t - t0) / HIST_MS) * pw;
    const yy = Math.max(0, Math.min(1, last.v / axisMax));
    const y = padT + (1 - yy) * ph;
    hzCtx.beginPath();
    hzCtx.arc(x, y, Math.max(2.5*dpr, 3.0*dpr), 0, Math.PI*2);
    hzCtx.fillStyle = palette.point;
    hzCtx.fill();
  }
  hzCtx.restore();
}

    function pollHandler(e) {
      lastUsedCoalesced = ingest(e);
      lastIngestAt = performance.now();
      tryUpdateUi(lastIngestAt);
    }

    function attachPolling() {
      tsRing.length = 0;
      hist.length = 0;
      histSampleAt = 0;
      ringTargetRate = 0;
      ringSmoothRate = 0;
      ringNeedsDraw = true;
      lastUiUpdate = 0;
      peakRate = 0;
      hzPeak.textContent = '-- Hz';
lastUsedCoalesced = true;
lastIngestAt = performance.now();
resetMultiDeviceWarning();

// Refresh UI periodically even with no movement
// so polling rate can decay back to 0.
if (uiTimer) clearInterval(uiTimer);
uiTimer = setInterval(() => {
  if (!locked) return;
  tryUpdateUi(performance.now());
}, UI_UPDATE_MS);

// Initial display is 0 Hz (no movement => 0).
hzDisp.textContent = '0';
hzDisp.style.color = '';

      // Prefer pointerrawupdate (more raw), then pointermove, then mousemove.
      if ('onpointerrawupdate' in document) {
        document.addEventListener('pointerrawupdate', pollHandler, { passive: true });
      } else if ('PointerEvent' in window) {
        document.addEventListener('pointermove', pollHandler, { passive: true });
      } else {
        document.addEventListener('mousemove', pollHandler, { passive: true });
      }
    }

    function detachPolling() {
      document.removeEventListener('pointerrawupdate', pollHandler);
      document.removeEventListener('pointermove', pollHandler);
      document.removeEventListener('mousemove', pollHandler);
      if (uiTimer) { clearInterval(uiTimer); uiTimer = null; }
      tsRing.length = 0;
      lastUiUpdate = 0;
    }


    // --- Focus block: polling-rate focus mode
    // Right click ends test; all other interactions are blocked.
    function blockIfPollingOnly(e){
      if(!isTestToolsActive()) return;
      if (!pollingOnly) return;

      // Right click: end test (exit PointerLock).
      if (e.type === 'mousedown' && e.button === 2) {
        e.preventDefault();
        e.stopImmediatePropagation();
        document.exitPointerLock();
        return;
      }

      // Swallow all other inputs to avoid triggering main-panel
      // button/wheel statistics while focused.
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function attachFocusBlock(){
      // Intercept in capture phase so window-level listeners also miss these events.
      document.addEventListener('mousedown', blockIfPollingOnly, true);
      document.addEventListener('mouseup', blockIfPollingOnly, true);
      document.addEventListener('wheel', blockIfPollingOnly, true);
      document.addEventListener('contextmenu', blockIfPollingOnly, true);
      document.addEventListener('keydown', blockIfPollingOnly, true);
    }

    function detachFocusBlock(){
      document.removeEventListener('mousedown', blockIfPollingOnly, true);
      document.removeEventListener('mouseup', blockIfPollingOnly, true);
      document.removeEventListener('wheel', blockIfPollingOnly, true);
      document.removeEventListener('contextmenu', blockIfPollingOnly, true);
      document.removeEventListener('keydown', blockIfPollingOnly, true);
    }

    // Pointer Lock toggle
    if(rateBox) rateBox.addEventListener('click', () => {
      const lockEl = rateBox;
      if (!lockEl) return;
      if (!locked) {
        // unadjustedMovement can reduce extra processing on some browsers,
        // but is optional.
        try { lockEl.requestPointerLock({ unadjustedMovement: true }); }
        catch (_) { lockEl.requestPointerLock(); }
      } else {
        document.exitPointerLock();
      }
    });


    function hardResetPollingUI(){
      // Clear all data and restore initial UI state (used by "Stop" button).
      tsRing.length = 0;
      hist.length = 0;
      peakRate = 0;
      hzDisp.textContent = '--';
      hzDisp.style.color = '';
      hzPeak.textContent = '-- Hz';
      hzAvg.textContent = '-- Hz';
      hzJit.textContent = '-- ms';
      hzSamples.textContent = '--';
      ringTargetRate = 0;
      ringSmoothRate = 0;
      ringNeedsDraw = true;
      lastUiUpdate = 0;
      // Redraw empty ring/chart.
      drawRing();
      drawChart(performance.now());
      hzHint.classList.remove('polling','paused');
      hzHint.textContent = tr('点击“开始测试”锁定光标以开始测量','Click “Start” to lock the cursor and begin measuring.');
      resetMultiDeviceWarning();
    }

    // "Stop" button: exit lock and reset current-session data.
    if(stopPollBtn){
      stopPollBtn.addEventListener('click', ()=>{
        if(locked){
          endRequested = true;
          try{ document.exitPointerLock(); } catch(_){}
        }else{
          hardResetPollingUI();
        }
      });
    }


    const stopBtn = document.getElementById('stopPoll');
    if(stopBtn) stopBtn.addEventListener('click', ()=>{ if(document.pointerLockElement) document.exitPointerLock(); });

    document.addEventListener('pointerlockchange', () => {
      const lockEl = rateBox;
      locked = (document.pointerLockElement === lockEl);
if (locked) {
        rateBox.classList.add('locked');
        hzHint.classList.add('polling'); hzHint.classList.remove('paused');
        hzHint.innerHTML = tr('尽量快速匀速画圆；若数值偏低，请尝试使用 <b>Edge/Chrome</b>。<span class="hint-hot">右键结束</span>', 'Draw fast, steady circles; if values look low, try <b>Edge/Chrome</b>. <span class="hint-hot">Right-click to exit</span>');
        hzDisp.textContent = '0';
        hzDisp.style.color = '';
        pollingOnly = true;
        attachFocusBlock();
        attachPolling();
      } else {
        rateBox.classList.remove('locked');
        // Pause: keep current reading and current peak (do not clear display).
        const endedByButton = !!endRequested;
        if(endedByButton) endRequested = false;

        if(!endedByButton){
          hzHint.classList.remove('polling'); hzHint.classList.add('paused');
          hzHint.innerHTML = tr('已暂停（保留暂停时刻读数与峰值）。点击“开始测试”继续；点击“结束”清空', 'Paused (keeps the reading & peak). Click “Start” to continue; click “Stop” to clear.');
          // Freeze UI by keeping ring/chart on the last frame.
          ringTargetRate = ringTargetRate; ringNeedsDraw = true;
        }

        detachPolling();
        detachFocusBlock();
        pollingOnly = false;

        // If ended by "Stop", clear data and return to initial state
        // without showing paused text.
        if(endedByButton){
          hardResetPollingUI();
        }
      }
    });

})();
