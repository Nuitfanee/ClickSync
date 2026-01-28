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


    // 按键延迟计算：使用统一的高精度时间轴（自动对齐 e.timeStamp 与 performance.now），
    // 并引入"鲁棒估计"（中位数滤波）与"离群值剔除"，让数值更贴近真实手感/开关抖动。
    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

    // 统一使用 performance.now() 作为按钮延迟计时基准（单调递增，高精度）
    // event.timeStamp 在不同浏览器/系统下基准可能不同，容易导致 delta 异常
let __lastNow = 0;
function now() {
  const t = performance.now();
  // 极少数情况下可能出现轻微回退（例如实现差异/跨线程），做单调保护避免负延迟
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
      // 小于 10ms 显示 2 位小数，更利于观察开关抖动/极短间隔
      if (v < 10) return v.toFixed(2) + ' ms';
      return v.toFixed(1) + ' ms';
    }

    const btns = btnDefs.map(b => {
      // 现在按钮卡片在 HTML 中静态写好：这里直接按 class 取对应元素
      const div = container.querySelector(`.mouse-btn.${b.key}`);
      if(!div){
        console.warn('[mouse-main] Missing static button card:', b.key);
        return null;
      }

      // 可选：确保标题一致（HTML 已写好也没问题）
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
          duCurr: div.querySelector('.du-curr'),
          duMin: div.querySelector('.du-min'),
        },
        stats: {
          down: 0, up: 0, dbl: 0,
          lastDownT: NaN,
          isDown: false,
          downStartT: NaN,
          minDD: Infinity, minDU: Infinity,
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
      try{ if (typeof updateKeyMeta === 'function') updateKeyMeta(); }catch(_){}
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

    // 阻止滚轮在 number input 上改变值（避免"非直接输入"误改）
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
      // 只做“闪一下”的强调，不要改变最终常态颜色（浅色主题下白色会看不见，像“消失”）
      el.style.color = isMin ? 'var(--accent-blue)' : 'white';
      setTimeout(() => {
        // 清除 inline 样式，让其回到 CSS 默认颜色（如 .ttMini 的 var(--muted)）
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

      // 只对统计区域按键阻止默认，减少副作用
      e.preventDefault();

      btn.el.classList.add('active');
      flashTitle(btn);

      const nowT = now();

      // 防抖：同一按下周期内的重复 mousedown 忽略（避免覆盖 downStartT 导致按-抬延迟异常）
      if (btn.stats.isDown) return;
      btn.stats.isDown = true;
      btn.stats.downStartT = nowT;

      // Down-Down（连续按下间隔）
      if (!btn.first && Number.isFinite(btn.stats.lastDownT)) {
        const rawDD = nowT - btn.stats.lastDownT;
        const ddShow = Math.min(rawDD, 999);

        // 离群值剔除：极小值多半是时间戳量化/异常，极大值对“最小”没有意义
        if (rawDD > 0.2 && rawDD < 3000) {
          // 窗口用于鲁棒估计（中位数滤波）
          btn.stats.ddWin.push(rawDD);
          if (btn.stats.ddWin.length > 9) btn.stats.ddWin.shift();

          const ddEst = robustMedian(btn.stats.ddWin);

          // 当前值显示 raw（与“最小”同源，避免出现“当前显示 73 但最小更新到 52”这类困惑）
          btn.ui.ddCurr.textContent = fmtMs(ddShow);
          btn.ui.ddCurr.title = tr('平滑(中位数): ','Smoothed (median): ') + fmtMs(ddEst);

          if (rawDD < btn.stats.minDD) {
            btn.stats.minDD = rawDD;
            btn.ui.ddMin.textContent = fmtMs(Math.min(rawDD, 999));
            pulseValue(btn.ui.ddMin, true);
          }
        } else {
          // 即使不纳入统计，也显示当前（便于你看到异常情况）
          btn.ui.ddCurr.textContent = fmtMs(ddShow);
          btn.ui.ddCurr.title = '';
        }

        // Double Click 检测：用 rawDD（不经过滤波），更敏感地捕捉“误双击/抖动”
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

          // 当前值显示 raw（与“最小”同源，避免出现“当前显示 73 但最小更新到 52”这类困惑）
          btn.ui.duCurr.textContent = fmtMs(rawDU);
          btn.ui.duCurr.title = tr('平滑(中位数): ','Smoothed (median): ') + fmtMs(duEst);

          if (rawDU < btn.stats.minDU) {
            btn.stats.minDU = rawDU;
            btn.ui.duMin.textContent = fmtMs(rawDU);
            pulseValue(btn.ui.duMin, true);
          }
        } else {
          btn.ui.duCurr.textContent = fmtMs(rawDU);
          btn.ui.duCurr.title = '';
        }
      }

      // 结束一次按键周期：复位状态（防止丢失 mouseup 后卡死）
      btn.stats.isDown = false;
      btn.stats.downStartT = NaN;

      btn.stats.up++;
      btn.ui.up.textContent = btn.stats.up;
    });

    window.addEventListener('contextmenu', (e) => e.preventDefault());


    // 防止"按下后未收到 mouseup"（切换窗口/丢焦点/弹出菜单等）导致状态卡死
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
    // 1) 删除左右滚：只统计上下滚
    const sUI = {
      up:   { val: 0, el: document.getElementById('sUp'),   icon: document.getElementById('wrapUp').querySelector('.scroll-arrow') },
      down: { val: 0, el: document.getElementById('sDown'), icon: document.getElementById('wrapDown').querySelector('.scroll-arrow') },
    };

// 清零统计（双击检测页）
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
      b.stats.ddWin = []; b.stats.duWin = [];
      b.first = true;

      b.ui.dbl.textContent = '0';
      b.ui.dbl.classList.remove('warning');
      b.ui.down.textContent = '0';
      b.ui.up.textContent = '0';
      b.ui.ddCurr.textContent = '--';
      b.ui.ddMin.textContent = '--';
      b.ui.duCurr.textContent = '--';
      b.ui.duMin.textContent = '--';
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

    // --- Custom Key Test（键盘任意键：按下/抬起/间隔/按住） ---
    const pageMainEl = document.getElementById('pageMain');
const kPickBtn = document.getElementById('pickKeyBtn');
    const kResetBtn = document.getElementById('resetKeyBtn');
    const kMeta = document.getElementById('customKeyMeta');
    const kState = document.getElementById('customKeyState');

    const kUI = {
      down: document.getElementById('kDown'),
      up: document.getElementById('kUp'),
      dbl: document.getElementById('kDbl'),
      thrInput: document.getElementById('kThresholdInput'),
      ddCurr: document.getElementById('kDDCurr'),
      ddMin: document.getElementById('kDDMin'),
      duCurr: document.getElementById('kDUCurr'),
      duMin: document.getElementById('kDUMin'),
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
      ddWin: [],
      duWin: [],
    };

// 自定义键位检测：独立双击阈值（仅影响此面板）
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

    function updateKeyMeta(){
      if(!kMeta) return;
      const hint = kPickMode ? tr('（录入中：请按一次键…）','(Picking: press a key once...)') : '';
      const core = (selectedCode || selectedKey)
        ? tr(`当前：${fmtSel()}`, `Current: ${fmtSel()}`)
        : tr('当前：未选择（点击“录入”后按一次键）','Current: none (click “Pick”, then press a key once)');
      kMeta.textContent = core + hint;
    }

    function updateKeyState(text, isDown){
      if(!kState) return;
      kState.textContent = text;
      // 由 CSS 控制“下沉/阴影”效果；这里仅切换状态 class。
      // 同时清理旧的内联样式，避免覆盖 CSS。
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
      kStats.ddWin = []; kStats.duWin = [];

      if(kUI.down) kUI.down.textContent = '0';
      if(kUI.up) kUI.up.textContent = '0';
      if(kUI.ddCurr) kUI.ddCurr.textContent = '--';
      if(kUI.ddMin) kUI.ddMin.textContent = '--';
      if(kUI.duCurr) kUI.duCurr.textContent = '--';
      if(kUI.duMin) kUI.duMin.textContent = '--';
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
        updateKeyMeta();
        updateKeyState(tr('状态：已取消录入','Status: Pick canceled'), false);
        return true;
      }
      selectedKey = e.key;
      selectedCode = e.code;
      kPickMode = false;
      syncPickBtnLabel();
      updateKeyMeta();
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
        updateKeyMeta();
      });
    }
    if (kResetBtn){
      kResetBtn.addEventListener('click', ()=>{
        // 重置：不仅清零统计，也要“释放/清空”当前已录入的按键
        selectedKey = '';
        selectedCode = '';
        kPickMode = false;
        syncPickBtnLabel();
        updateKeyMeta();
        resetCustomKeyStats(false);
      });
    }


if (kUI.thrInput){
  // 初始化 + 监听
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

    updateKeyMeta();
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

    // --- Polling Rate（更准确：基于 coalesced events 的 timeStamp 序列） ---
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

    // 测轮询率专注模式：开启时屏蔽其他统计/滚轮等功能
    let pollingOnly = false;

    // 在窗口内保存“原始输入回报”的时间戳序列（来自 coalesced events）
    const tsRing = [];
    let lastUiUpdate = 0;

    let uiTimer = null;
    let lastUsedCoalesced = true;
    let lastIngestAt = 0;

    // 窗口越长越稳，越短越灵敏；这里 1.2s 在 8k 下也能很快稳定
    const WINDOW_MS = 250;
    const MIN_SPAN_MS = 180;
    const UI_UPDATE_MS = 80;

    // 常见 USB 轮询档位：用于“轻微吸附”，避免 4k 显示 4.1k 这类小幅超出
    const COMMON_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];
    const SNAP_TOL = 0.015; // 6%

    function normTimeStamp(ts) {
      if (!Number.isFinite(ts)) return NaN;
      // 部分环境 timeStamp 可能接近 epoch(ms)，做一次转换
      if (ts > 1e12 && Number.isFinite(performance.timeOrigin)) return ts - performance.timeOrigin;
      return ts;
    }

    function pushStamp(t) {
      if (!Number.isFinite(t)) return;
      const last = tsRing.length ? tsRing[tsRing.length - 1] : -Infinity;
      // 规范要求 coalesced timeStamp 单调递增；但某些实现可能出现轻微回退，直接钳到 last，避免 span 变小导致“虚高”
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
        // fallback：没有 coalescedEvents 时只能用 parent event 的 timeStamp（高回报率会被明显低估）
        pushStamp(normTimeStamp(e.timeStamp));
      }

      // purge old samples
      if (tsRing.length >= 2) {
        const newest = tsRing[tsRing.length - 1];
        const cutoff = newest - WINDOW_MS;
        // 保留至少 2 个点，且尽量让首点靠近 cutoff（避免 span 过大导致响应慢）
        while (tsRing.length > 2 && tsRing[1] < cutoff) tsRing.shift();
      }

      return usedCoalesced;
    }
    function pruneByNow(now) {
      // 如果长时间没有新事件，用“当前时间”驱动窗口前移，使数值能自然衰减到 0
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
        // 不更新峰值
        return;
      }

      const disp = snapRate(r);
      hzDisp.textContent = String(disp);
      applyColor(disp);
      updateExtraStats(disp);

      if (disp > peakRate) {
        peakRate = disp;
        hzPeak.textContent = `${peakRate} Hz`;
      }

      if (!lastUsedCoalesced) {
        hzHint.textContent = tr('浏览器未提供 coalesced 数据：高回报率可能被低估（建议 HTTPS/Chrome/Edge）', 'Coalesced events not available: high polling rates may be underestimated (try HTTPS + Chrome/Edge).');
      }
    }


    function computeRate() {
      if (tsRing.length < 2) return null;
      const span = tsRing[tsRing.length - 1] - tsRing[0];
      if (span < MIN_SPAN_MS) return null;

      const reports = tsRing.length - 1;
      const rate = reports * 1000 / span;
      // 极端保护：避免 NaN / Infinity 或异常虚高
      if (!Number.isFinite(rate) || rate <= 0) return null;
      return Math.min(rate, 20000);
    }

    function snapRate(rate) {
      // 轻微吸附：只在“非常接近档位”时吸附，避免把真实 6k 误判成 8k
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

// 灰度色阶：轮询率越高越深，从浅灰到纯黑
const TIER_RGB = {
  1000: [180, 180, 180], // 浅灰
  2000: [120, 120, 120], // 中灰
  4000: [60, 60, 60],    // 深灰
  8000: [0, 0, 0],       // 纯黑
};

let tierState = 1000;
let tierHoldUntil = 0;

// Smooth color transition (lag) to avoid flashing
let tierRgbCur = TIER_RGB[1000].slice();
let tierRgbTgt = TIER_RGB[1000].slice();

function rgba(rgb, a){
  return `rgba(${rgb[0].toFixed(0)},${rgb[1].toFixed(0)},${rgb[2].toFixed(0)},${a})`;
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
    tierRgbTgt = TIER_RGB[tierState].slice();
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

function tierColor(_tier){ return softColor(0.88); }
function tierTrack(_tier){ return softColor(0.14); }

function applyColor(rate) {
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
const HIST_SAMPLE_MS = 16; // ~60fps 曲线采样，观感更丝滑

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
    ringCtx.shadowColor = 'rgba(255,255,255,0.35)';
    ringCtx.strokeStyle = 'rgba(255,255,255,0.22)';
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

function drawChart(now){
  if(!hzCtx || !hzChart) return;

  const cssW = hzChart.clientWidth || 800;
  const cssH = hzChart.clientHeight || 320;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(2, Math.floor(cssW * dpr));
  const h = Math.max(2, Math.floor(cssH * dpr));
  if(hzChart.width !== w || hzChart.height !== h){
    hzChart.width = w; hzChart.height = h;
  }

  // 动态坐标轴：按峰值落在 1k/2k/4k/8k 档位（上限 8k）
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

  // 背景网格（横向按刻度画线）
  hzCtx.save();
  hzCtx.strokeStyle = 'rgba(0,0,0,0.08)';
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
  // 纵向网格（6 格）
  for(let i=0;i<=6;i++){
    const x = padL + (pw * (i/6));
    hzCtx.beginPath();
    hzCtx.moveTo(x, padT);
    hzCtx.lineTo(x, padT + ph);
    hzCtx.stroke();
  }

  // Y 轴刻度文字（固定刻度：1000, 2000, 4000, 8000）
  const fmt = (v)=> (v>=1000 ? (v/1000)+'k' : String(v));
  hzCtx.fillStyle = 'rgba(0,0,0,0.55)';
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

  // 时间窗口
  const t1 = now;
  const t0 = t1 - HIST_MS;

  // 曲线（纯黑色，使用贝塞尔曲线平滑）
  hzCtx.save();
  hzCtx.strokeStyle = 'rgba(0,0,0,0.85)';
  hzCtx.lineWidth = Math.max(2*dpr, 2.2*dpr);
  hzCtx.beginPath();

  // 先计算所有可见点的坐标
  const pts = [];
  for(const p of hist){
    if(p.t < t0) continue;
    const x = padL + ((p.t - t0) / HIST_MS) * pw;
    const yy = Math.max(0, Math.min(1, p.v / axisMax));
    const y = padT + (1 - yy) * ph;
    pts.push({x, y});
  }

  // 使用二次贝塞尔曲线平滑连接各点
  if(pts.length >= 2){
    hzCtx.moveTo(pts[0].x, pts[0].y);
    for(let i = 0; i < pts.length - 1; i++){
      const p0 = pts[i];
      const p1 = pts[i + 1];
      // 控制点取两点中点，终点也取中点，使曲线平滑过渡
      const midX = (p0.x + p1.x) / 2;
      const midY = (p0.y + p1.y) / 2;
      hzCtx.quadraticCurveTo(p0.x, p0.y, midX, midY);
    }
    // 最后一段连接到终点
    const lastPt = pts[pts.length - 1];
    hzCtx.lineTo(lastPt.x, lastPt.y);
    hzCtx.stroke();
  } else if(pts.length === 1){
    hzCtx.moveTo(pts[0].x, pts[0].y);
  }

  // 最新点（纯黑色）
  const last = hist[hist.length-1];
  if(last){
    const x = padL + ((last.t - t0) / HIST_MS) * pw;
    const yy = Math.max(0, Math.min(1, last.v / axisMax));
    const y = padT + (1 - yy) * ph;
    hzCtx.beginPath();
    hzCtx.arc(x, y, Math.max(2.5*dpr, 3.0*dpr), 0, Math.PI*2);
    hzCtx.fillStyle = 'rgba(0,0,0,0.92)';
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

// 即使鼠标不动，也要周期性刷新 UI，使轮询率能回到 0
if (uiTimer) clearInterval(uiTimer);
uiTimer = setInterval(() => {
  if (!locked) return;
  tryUpdateUi(performance.now());
}, UI_UPDATE_MS);

// 初始显示 0 Hz（未移动即 0）
hzDisp.textContent = '0';
hzDisp.style.color = '';

      // pointerrawupdate（更原始）优先，其次 pointermove，最后 mousemove
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


    // --- Focus block: 轮询率专注模式（右键结束；其余功能不响应） ---
    function blockIfPollingOnly(e){
      if(!isTestToolsActive()) return;
      if (!pollingOnly) return;

      // 右键：结束测试（退出 PointerLock）
      if (e.type === 'mousedown' && e.button === 2) {
        e.preventDefault();
        e.stopImmediatePropagation();
        document.exitPointerLock();
        return;
      }

      // 其他输入：全部吞掉，避免触发主面板的按键统计/滚轮统计等
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function attachFocusBlock(){
      // capture 阶段拦截，确保 window 级监听也拿不到事件
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
        // unadjustedMovement 在部分浏览器可减少额外处理，但不是必须
        try { lockEl.requestPointerLock({ unadjustedMovement: true }); }
        catch (_) { lockEl.requestPointerLock(); }
      } else {
        document.exitPointerLock();
      }
    });


    function hardResetPollingUI(){
      // 清空所有数据并恢复初始 UI（用于“结束”按钮）
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
      // 重新绘制空环/空图
      drawRing();
      drawChart(performance.now());
      hzHint.classList.remove('polling','paused');
      hzHint.textContent = tr('点击“开始测试”锁定光标以开始测量','Click “Start” to lock the cursor and begin measuring.');
    }

    // “结束”按钮：点击即退出锁定，并重置本次数据
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
        // 暂停：保留当前读数与本次峰值（不清空显示）
        const endedByButton = !!endRequested;
        if(endedByButton) endRequested = false;

        if(!endedByButton){
          hzHint.classList.remove('polling'); hzHint.classList.add('paused');
          hzHint.innerHTML = tr('已暂停（保留暂停时刻读数与峰值）。点击“开始测试”继续；点击“结束”清空', 'Paused (keeps the reading & peak). Click “Start” to continue; click “Stop” to clear.');
          // 冻结 UI：先把环/曲线停在最后一帧
          ringTargetRate = ringTargetRate; ringNeedsDraw = true;
        }

        detachPolling();
        detachFocusBlock();
        pollingOnly = false;

        // 点击“结束”则清空数据并回到初始态（不展示暂停文案）
        if(endedByButton){
          hardResetPollingUI();
        }
      }
    });

})();
