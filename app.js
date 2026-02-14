
/**
 * Manifesto: UI Layer & Orchestration
 * 本文件负责 UI 交互与数据调度，严禁包含任何设备协议细节，
 * 所有设备差异必须由适配器表达。
 *
 * 禁止事项：
 * - UI 中禁止直接使用固件 Key，必须走 adapter keyMap。
 * - UI 中禁止设备 if 分支，只能用 feature 能力开关。
 * - 设备写入必须走 enqueueDevicePatch 以实现防抖与并发保护。
 */

// ============================================================
// 1) 启动与适配器解析（无设备逻辑）
// ============================================================
/**
 * 应用启动入口（IIFE）。
 * 目的：避免泄露全局变量，并确保启动顺序在模块加载时立即执行。
 *
 * @returns {Promise<void>} 启动完成的 Promise。
 */
(async () => {
  /**
   * 查询单个 DOM 元素。
   * 目的：集中 DOM 查询入口，避免重复调用 querySelector。
   * @param {any} sel - 参数 sel。
   * @returns {any} 返回结果。
   */
  const $ = (sel) => document.querySelector(sel);
  /**
   * 查询 DOM 元素列表。
   * 目的：集中 DOM 列表查询入口，减少分散查询。
   * @param {any} sel - 参数 sel。
   * @returns {any} 返回结果。
   */
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let __connectInFlight = false;
  let __connectPending = null;


  /**
   * 兜底翻译函数。
   * 目的：在多语言模块未就绪时提供最小可用文本，避免 UI 空白。
   *
   * @param {string} zh - 中文文本。
   * @param {string} en - 英文文本。
   * @returns {string} 兜底文本（默认中文）。
   */
  window.tr = window.tr || ((zh, en) => zh);


  const DeviceRuntime = window.DeviceRuntime;
  const SELECTED_DEVICE = DeviceRuntime?.getSelectedDevice?.() || "chaos";


  const DEVICE_ID = SELECTED_DEVICE || "chaos";


  const adapter = window.DeviceAdapters?.getAdapter?.(DEVICE_ID) || window.DeviceAdapters?.getAdapter?.(SELECTED_DEVICE);
  const adapterFeatures = adapter?.features || {};
  /**
   * 检查能力开关。
   * 目的：用于判断能力开关状态，避免分散判断。
   * @param {any} key - 参数 key。
   * @returns {any} 返回结果。
   */
  const hasFeature = (key) => !!adapterFeatures[key];


  const resolvedDeviceId = adapter?.id || DEVICE_ID;
  if (document.body) {
    document.body.dataset.device = resolvedDeviceId;
    Array.from(document.body.classList)
      .filter((cls) => cls.startsWith("device-"))
      .forEach((cls) => document.body.classList.remove(cls));
    document.body.classList.add(`device-${resolvedDeviceId}`);
  }

  // ============================================================
  // 2) 标准语义读取（由 refactor.js 下沉实现）
  // ============================================================
  /**
   * 读取标准 Key 的配置值。
   * 目的：屏蔽协议字段差异，保证 UI 读取一致性。
   * @param {any} cfg - 参数 cfg。
   * @param {any} key - 参数 key。
   * @returns {any} 返回结果。
   */
  const readStandardValue = (cfg, key) => {
    const reader = window.DeviceReader;
    return reader?.readStandardValue?.({ cfg, adapter, key });
  };


  // ============================================================
  // 3) Landing 层与过渡编排（仅 UI）
  // ============================================================
  const __landingLayer = document.getElementById("landing-layer");
  const __appLayer = document.getElementById("app-layer");
  const __landingCaption = document.getElementById("landingCaption") || __landingLayer?.querySelector(".center-caption");
  const __triggerZone = document.getElementById("trigger-zone");


  /**
   * 内部应用设备。
   * 目的：集中应用配置，确保入口一致。
   * @returns {any} 返回结果。
   */
  function __applyDeviceVariantOnce({ deviceName = "", cfg = null, keymapOnly = false } = {}) {

    try {
      const registry = window.DeviceAdapters;
      const runtimeDeviceId = window.DeviceRuntime?.getSelectedDevice?.() || DEVICE_ID;
      const adapter = registry?.getAdapter?.(runtimeDeviceId) || registry?.getAdapter?.(DEVICE_ID) || registry?.getAdapter?.(SELECTED_DEVICE);
      window.DeviceUI?.applyVariant?.({
        deviceId: runtimeDeviceId,
        adapter,
        root: document,
        deviceName: String(deviceName || cfg?.deviceName || "").trim(),
        keymapOnly: !!keymapOnly,
      });
    } catch (err) {
      console.warn("[variant] apply failed", err);
    }
  }

  __applyDeviceVariantOnce();


  // ============================================================
  // 4) 能力驱动的 UI 循环控件（适配器门控）
  // ============================================================
  const POLLING_RATES = [1000, 2000, 4000, 8000];
  const RATE_COLORS = {
    1000: 'rate-color-1000',
    2000: 'rate-color-2000',
    4000: 'rate-color-4000',
    8000: 'rate-color-8000'
  };
  const CYCLE_ANIM_DURATION_MS = 500;
  const CYCLE_ANIM_FALLBACK_MS = CYCLE_ANIM_DURATION_MS + 80;
  const POLLING_CROSSHAIR_STEP_DEG = 90;
  const cycleAnimStateMap = new WeakMap();

  function getCycleAnimState(container) {
    let state = cycleAnimStateMap.get(container);
    if (!state) {
      state = { token: 0, timerId: null, onEnd: null, nextLayer: null };
      cycleAnimStateMap.set(container, state);
    }
    return state;
  }

  function getCycleVisualParts(container) {
    return {
      baseLayer: container?.querySelector('.shutter-bg-base'),
      nextLayer: container?.querySelector('.shutter-bg-next'),
      textEl: container?.querySelector('.cycle-text'),
    };
  }

  function cancelCycleAnim(container) {
    if (!container) return;
    const state = getCycleAnimState(container);
    state.token += 1;
    if (state.timerId != null) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
    if (state.nextLayer && state.onEnd) {
      state.nextLayer.removeEventListener('transitionend', state.onEnd);
    }
    state.onEnd = null;
    state.nextLayer = null;
    container.classList.remove('is-animating');
  }

  function commitCycleVisual(container, value, label, colorClass, syncForm) {
    if (!container) return;
    const { baseLayer, nextLayer, textEl } = getCycleVisualParts(container);
    cancelCycleAnim(container);
    if (nextLayer) nextLayer.className = 'shutter-bg-next ' + colorClass;
    if (baseLayer) baseLayer.className = 'shutter-bg-base ' + colorClass;
    if (textEl) textEl.textContent = label;
    if (typeof syncForm === 'function') syncForm(value);
  }

  function animateCycleVisual(container, value, label, colorClass, syncForm) {
    if (!container) return;
    const { baseLayer, nextLayer, textEl } = getCycleVisualParts(container);
    if (!baseLayer || !nextLayer || !textEl) {
      commitCycleVisual(container, value, label, colorClass, syncForm);
      return;
    }

    cancelCycleAnim(container);
    if (typeof syncForm === 'function') syncForm(value);

    const state = getCycleAnimState(container);
    const token = state.token + 1;
    state.token = token;

    nextLayer.className = 'shutter-bg-next ' + colorClass;
    void nextLayer.offsetWidth;
    container.classList.add('is-animating');

    const finalize = () => {
      const activeState = cycleAnimStateMap.get(container);
      if (!activeState || activeState.token !== token) return;
      if (activeState.timerId != null) {
        clearTimeout(activeState.timerId);
        activeState.timerId = null;
      }
      if (activeState.nextLayer && activeState.onEnd) {
        activeState.nextLayer.removeEventListener('transitionend', activeState.onEnd);
      }
      activeState.onEnd = null;
      activeState.nextLayer = null;
      textEl.textContent = label;
      baseLayer.className = 'shutter-bg-base ' + colorClass;
      container.classList.remove('is-animating');
    };

    const onEnd = (event) => {
      if (event.target !== nextLayer) return;
      if (event.propertyName && event.propertyName !== 'transform') return;
      finalize();
    };

    state.onEnd = onEnd;
    state.nextLayer = nextLayer;
    nextLayer.addEventListener('transitionend', onEnd, { passive: true });
    state.timerId = setTimeout(finalize, CYCLE_ANIM_FALLBACK_MS);
  }

  function rotateCycleCrosshair(container, stepDeg = POLLING_CROSSHAIR_STEP_DEG) {
    const crosshair = container?.querySelector('.crosshair');
    if (!crosshair) return;
    const prevDeg = Number(crosshair.dataset.rotateDeg || 0);
    const nextDeg = prevDeg + Number(stepDeg || 0);
    crosshair.dataset.rotateDeg = String(nextDeg);
    crosshair.style.transform = `rotate(${nextDeg}deg)`;
  }

  /**
   * 更新轮询率。
   * 目的：在轮询率变化时同步 UI 与配置，避免显示与实际值偏离。
   * @param {any} rate - 参数 rate。
   * @param {any} animate - 参数 animate。
   * @returns {any} 返回结果。
   */
  function updatePollingCycleUI(rate, animate = true) {
    const container = document.getElementById('rapooPollingCycle');
    if (!container) return;
    const selectEl = document.getElementById('rapooPollingSelectAdv');
    const parsedRate = Number(rate);
    const resolvedRate = POLLING_RATES.includes(parsedRate) ? parsedRate : POLLING_RATES[0];
    const colorClass = RATE_COLORS[resolvedRate] || RATE_COLORS[1000];
    const displayRate = resolvedRate >= 1000 ? (resolvedRate / 1000) + 'k' : String(resolvedRate);
    const syncForm = (nextValue) => {
      container.dataset.value = String(nextValue);
      container.classList.toggle('is-selected', Number(nextValue) !== POLLING_RATES[0]);
      if (selectEl) selectEl.value = String(nextValue);
    };

    if (!animate) {
      commitCycleVisual(container, resolvedRate, displayRate, colorClass, syncForm);
      return;
    }

    rotateCycleCrosshair(container);
    animateCycleVisual(container, resolvedRate, displayRate, colorClass, syncForm);
  }

  /**
   * 初始化轮询率。
   * 目的：在轮询率变化时同步 UI 与配置，避免显示与实际值偏离。
   * @returns {any} 返回结果。
   */
  function initRapooPollingCycle() {
    const cycleBtn = document.getElementById('rapooPollingCycle');
    if (!cycleBtn || !hasFeature("hasKeyScanRate")) return;

    cycleBtn.addEventListener('click', () => {
      const selectEl = document.getElementById('rapooPollingSelectAdv');
      const datasetHz = Number(cycleBtn.dataset.value);
      const selectHz = Number(selectEl?.value);
      const currentHz = Number.isFinite(datasetHz)
        ? datasetHz
        : (Number.isFinite(selectHz) ? selectHz : POLLING_RATES[0]);
      const currentIdx = POLLING_RATES.indexOf(currentHz);
      const nextIdx = ((currentIdx >= 0 ? currentIdx : 0) + 1) % POLLING_RATES.length;

      const nextHz = POLLING_RATES[nextIdx];

      cycleBtn.dataset.value = String(nextHz);
      if (selectEl) selectEl.value = String(nextHz);
      updatePollingCycleUI(nextHz, true);

      if (typeof enqueueDevicePatch === 'function') {
        enqueueDevicePatch({ keyScanningRate: nextHz });
      }
    });
  }


  initRapooPollingCycle();


  const ATK_DPI_LIGHT_OPTS = adapter?.ui?.lights?.dpi || [
      { val: 0, label: "关闭", cls: "atk-mode-0" },
      { val: 1, label: "常亮", cls: "atk-mode-1" },
      { val: 2, label: "呼吸", cls: "atk-mode-2" }
  ];
  const ATK_RX_LIGHT_OPTS = adapter?.ui?.lights?.receiver || [
      { val: 0, label: "关闭", cls: "atk-mode-0" },
      { val: 1, label: "回报率模式", cls: "atk-mode-1" },
      { val: 2, label: "电量梯度", cls: "atk-mode-2" },
      { val: 3, label: "低电压模式", cls: "atk-mode-3" }
  ];

  /**
   * 更新atk、cycle。
   * 目的：在状态变化时同步 UI 或数据，避免不一致。
   * @param {any} id - 参数 id。
   * @param {any} value - 参数 value。
   * @param {any} options - 参数 options。
   * @param {any} animate - 参数 animate。
   * @returns {any} 返回结果。
   */
  function updateAtkCycleUI(id, value, options, animate = true) {
      const container = document.getElementById(id);
      if (!container || !Array.isArray(options) || !options.length) return;

      const numericValue = Number(value);
      const opt = options.find(o => Number(o.val) === numericValue) || options[0];
      const defaultVal = Number(options[0]?.val);
      const colorClass = opt.cls;
      const syncForm = (nextValue) => {
          container.dataset.value = String(nextValue);
          container.classList.toggle('is-selected', Number(nextValue) !== defaultVal);
      };

      if (!animate) {
          commitCycleVisual(container, opt.val, opt.label, colorClass, syncForm);
          return;
      }

      animateCycleVisual(container, opt.val, opt.label, colorClass, syncForm);
  }

  /**
   * 初始化灯效。
   * 目的：集中初始化与事件绑定，避免重复绑定或顺序问题。
   * @returns {any} 返回结果。
   */
  function initAtkLightCycles() {
      if (!hasFeature("hasAtkLights")) return;
      /**
       * 处理bind、cycle逻辑。
       * 目的：统一处理bind、cycle相关流程，保证行为一致。
       * @param {any} id - 参数 id。
       * @param {any} key - 参数 key。
       * @param {any} options - 参数 options。
       * @returns {any} 返回结果。
       */
      const bindCycle = (id, key, options) => {
          const btn = document.getElementById(id);
          if (!btn) return;

          btn.addEventListener('click', () => {
              const datasetVal = Number(btn.dataset.value);
              const firstVal = Number(options[0]?.val);
              const cur = Number.isFinite(datasetVal)
                  ? datasetVal
                  : (Number.isFinite(firstVal) ? firstVal : 0);
              const curIdx = options.findIndex(o => Number(o.val) === cur);

              const nextIdx = ((curIdx >= 0 ? curIdx : 0) + 1) % options.length;
              const nextVal = options[nextIdx].val;

              btn.dataset.value = String(nextVal);
              updateAtkCycleUI(id, nextVal, options, true);

              enqueueDevicePatch({ [key]: nextVal });
          });
      };


      bindCycle('atkDpiLightCycle', 'dpiLightEffect', ATK_DPI_LIGHT_OPTS);
      bindCycle('atkReceiverLightCycle', 'receiverLightEffect', ATK_RX_LIGHT_OPTS);
  }


  initAtkLightCycles();


  let __landingClickOrigin = null;


  let __autoDetectedDevice = null;


  let __manualConnectGuardUntil = 0;
  /**
   * 内部处理arm、manual逻辑。
   * 目的：统一连接流程并处理并发保护，避免重复连接或状态错乱。
   * @param {any} ms - 参数 ms。
   * @returns {any} 返回结果。
   */
  const __armManualConnectGuard = (ms = 3000) => {
    const dur = Math.max(0, Number(ms) || 0);
    __manualConnectGuardUntil = Date.now() + dur;
  };
  /**
   * 内部检查manual、connect。
   * 目的：用于判断manual、connect状态，避免分散判断。
   * @returns {any} 返回结果。
   */
  const __isManualConnectGuardOn = () => Date.now() < __manualConnectGuardUntil;


  /**
   * 内部设置app、inert。
   * 目的：提供统一读写入口，降低耦合。
   * @param {any} inert - 参数 inert。
   * @returns {any} 返回结果。
   */
  function __setAppInert(inert) {
    if (!__appLayer) return;
    try { __appLayer.inert = inert; } catch (_) {}
    __appLayer.setAttribute("aria-hidden", inert ? "true" : "false");
  }

  /**
   * 内部设置Landing。
   * 目的：集中管理 Landing 状态切换与动画时序，避免交互状态冲突。
   * @param {any} text - 参数 text。
   * @returns {any} 返回结果。
   */
  function __setLandingCaption(text) {
    if (!__landingCaption) return;
    __landingCaption.textContent = text;
  }

/**
 * 显示Landing。
 * 目的：集中管理 Landing 状态切换与动画时序，避免交互状态冲突。
 * @param {any} reason - 参数 reason。
 * @returns {any} 返回结果。
 */
function showLanding(reason = "") {
    if (!__landingLayer) return;


    document.body.classList.remove("landing-cover", "landing-reveal", "landing-covered", "landing-hovering", "landing-drop");
    document.body.classList.remove("landing-precharge", "landing-charging", "landing-system-ready", "landing-ready-zoom", "landing-ready-out", "landing-holding");
    document.body.classList.add("landing-active");

    __landingLayer.style.display = "";
    __landingLayer.setAttribute("aria-hidden", "false");


    __setAppInert(true);


    if (__triggerZone) __triggerZone.style.pointerEvents = "";


    __setLandingCaption("Hold to Initiate System");


    __landingClickOrigin = null;
  }


/**
 * 处理enter、app逻辑。
 * 目的：统一处理enter、app相关流程，保证行为一致。
 * @param {any} origin - 参数 origin。
 * @returns {any} 返回结果。
 */
function enterAppWithLiquidTransition(origin = null) {
    if (!__landingLayer) return;
    if (__landingLayer.getAttribute("aria-hidden") === "true") return;


    if (document.body.classList.contains("landing-system-ready")) return;


    if (__triggerZone) __triggerZone.style.pointerEvents = "none";


    document.body.classList.remove("landing-ready-zoom", "landing-ready-out");
    document.body.classList.add("landing-system-ready", "landing-reveal");
    document.body.classList.remove("landing-precharge", "landing-charging", "landing-holding");

    __setLandingCaption("SYSTEM READY");


    __setAppInert(true);

    /**
     * 处理finish逻辑。
     * 目的：统一处理finish相关流程，保证行为一致。
     * @returns {any} 返回结果。
     */
    const finish = () => {
      if (!__landingLayer) return;

      __landingLayer.setAttribute("aria-hidden", "true");
      __landingLayer.style.display = "none";

      document.body.classList.remove(
        "landing-active",
        "landing-precharge",
        "landing-system-ready",
        "landing-ready-zoom",
        "landing-ready-out",
        "landing-charging",
        "landing-holding",
        "landing-reveal",
        "landing-drop"
      );

      __setAppInert(false);


      if (__triggerZone) __triggerZone.style.pointerEvents = "";

      __landingClickOrigin = null;
    };

    /**
     * 处理run、transition逻辑。
     * 目的：统一处理run、transition相关流程，保证行为一致。
     * @returns {any} 返回结果。
     */
    const runTransition = () => {

      window.setTimeout(() => {
        try { document.body.classList.add("landing-ready-zoom"); } catch (_) {}
      }, 720);

      window.setTimeout(() => {
        try { document.body.classList.add("landing-ready-out"); } catch (_) {}
      }, 1240);

      window.setTimeout(() => {
        try { document.body.classList.add("landing-drop"); } catch (_) {}
      }, 1500);

      window.setTimeout(finish, 2140);
    };


    const gateP = window.__LANDING_ENTER_GATE_PROMISE__;
    const waitP = (gateP && typeof gateP.then === "function") ? gateP : Promise.resolve();

    Promise.race([
      waitP.catch(() => {}),
      new Promise((r) => setTimeout(r, 6000)),
    ]).then(runTransition, runTransition);
  }


  /**
   * 初始化 Landing 画布引擎。
   * 目的：建立 Landing 交互渲染循环，确保过渡稳定。
   * @returns {any} 返回结果。
   */
  function initLandingCanvasEngine() {

    if (!__landingLayer) return null;

    const layerSolid = document.getElementById("layer-solid");
    const layerOutline = document.getElementById("layer-outline");
    const cursorRing = document.getElementById("cursorRing");
    const cursorDot = document.getElementById("cursorDot");

    if (!layerSolid) return null;


    let mouseX = window.innerWidth / 2;
    let mouseY = window.innerHeight / 2;


    let currentX = mouseX;
    let currentY = mouseY;


    let maskRadius = 150;
    let targetRadius = 150;

    let holding = false;


    let autoWipe = null;


    /**
     * 内部处理wake、loop逻辑。
     * 目的：统一处理wake、loop相关流程，保证行为一致。
     * @returns {any} 返回结果。
     */
    let __wakeLoop = () => {};

    /**
     * 检查Landing。
     * 目的：用于判断Landing状态，避免分散判断。
     * @returns {any} 返回结果。
     */
    const isLandingVisible = () => __landingLayer.getAttribute("aria-hidden") !== "true";

    /**
     * 启动hold。
     * 目的：统一处理hold相关流程，保证行为一致。
     * @returns {any} 返回结果。
     */
    const startHold = () => {
      if (!isLandingVisible()) return;
      if (document.body.classList.contains("landing-charging")) return;
      if (document.body.classList.contains("landing-system-ready")) return;
      if (autoWipe) return;
      holding = true;
      document.body.classList.add("landing-holding");
      targetRadius = 2000;
      __wakeLoop();
    };

    /**
     * 处理end、hold逻辑。
     * 目的：统一处理end、hold相关流程，保证行为一致。
     * @returns {any} 返回结果。
     */
    const endHold = () => {
      if (autoWipe) return;
      holding = false;
      document.body.classList.remove("landing-holding");
      targetRadius = 150;
      __wakeLoop();
    };


    /**
     * 处理自动流程逻辑。
     * 目的：统一处理自动流程相关流程，保证行为一致。
     * @param {any} cx - 参数 cx。
     * @param {any} cy - 参数 cy。
     * @param {any} onDone - 参数 onDone。
     * @param {any} opts - 参数 opts。
     * @returns {any} 返回结果。
     */
    const beginAutoWipe = (cx, cy, onDone, opts = {}) => {
      if (!isLandingVisible()) return false;
      if (document.body.classList.contains("landing-charging")) return false;
      if (document.body.classList.contains("landing-system-ready")) return false;
      if (autoWipe) return false;

      const dur = Number.isFinite(opts.durationMs) ? opts.durationMs : 900;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const d1 = Math.hypot(cx, cy);
      const d2 = Math.hypot(w - cx, cy);
      const d3 = Math.hypot(cx, h - cy);
      const d4 = Math.hypot(w - cx, h - cy);
      const maxR = Math.max(d1, d2, d3, d4) + 20;
      const toR = Number.isFinite(opts.toRadius) ? Number(opts.toRadius) : maxR;
      const endFullCover = (opts.endFullCover !== false);


      mouseX = cx; mouseY = cy;
      currentX = cx; currentY = cy;

      holding = true;
      document.body.classList.add("landing-holding");

      autoWipe = {
        start: performance.now(),
        dur,
        from: maskRadius,
        to: toR,
        cx,
        cy,
        onDone: typeof onDone === "function" ? onDone : null,
        endFullCover,
      };
      __wakeLoop();
      return true;
    };


    if (__triggerZone) {
      __triggerZone.addEventListener("pointerdown", (e) => {
        try { __triggerZone.setPointerCapture(e.pointerId); } catch (_) {}
        startHold();
      });
      __triggerZone.addEventListener("pointerup", endHold);
      __triggerZone.addEventListener("pointercancel", endHold);
      __triggerZone.addEventListener("pointerleave", endHold);
    } else {
      window.addEventListener("mousedown", startHold);
      window.addEventListener("mouseup", endHold);
    }

    window.addEventListener("pointermove", (e) => {
      if (!isLandingVisible()) return;
      if (document.body.classList.contains("landing-charging")) return;
      if (document.body.classList.contains("landing-system-ready")) return;
      mouseX = e.clientX;
      mouseY = e.clientY;
      __wakeLoop();
    }, { passive: true });


    let __rafId = 0;
    let __paused = false;


    let __lastClip = "";
    let __lastOutlineT = "";
    let __lastRingT = "";
    let __lastDotT = "";
    let __lastRingOp = "";
    let __lastDotOp = "";

    /**
     * 内部设置clip。
     * 目的：提供统一读写入口，降低耦合。
     * @param {any} v - 参数 v。
     * @returns {any} 返回结果。
     */
    const __setClip = (v) => {
      if (v !== __lastClip) {
        layerSolid.style.clipPath = v;
        __lastClip = v;
      }
    };
    /**
     * 内部设置outline。
     * 目的：提供统一读写入口，降低耦合。
     * @param {any} v - 参数 v。
     * @returns {any} 返回结果。
     */
    const __setOutlineT = (v) => {
      if (!layerOutline) return;
      if (v !== __lastOutlineT) {
        layerOutline.style.transform = v;
        __lastOutlineT = v;
      }
    };
    /**
     * 内部设置光环。
     * 目的：提供统一读写入口，降低耦合。
     * @param {any} v - 参数 v。
     * @returns {any} 返回结果。
     */
    const __setRingT = (v) => {
      if (!cursorRing) return;
      if (v !== __lastRingT) {
        cursorRing.style.transform = v;
        __lastRingT = v;
      }
    };
    /**
     * 内部设置指示点。
     * 目的：提供统一读写入口，降低耦合。
     * @param {any} v - 参数 v。
     * @returns {any} 返回结果。
     */
    const __setDotT = (v) => {
      if (!cursorDot) return;
      if (v !== __lastDotT) {
        cursorDot.style.transform = v;
        __lastDotT = v;
      }
    };
    /**
     * 内部设置光环。
     * 目的：提供统一读写入口，降低耦合。
     * @param {any} v - 参数 v。
     * @returns {any} 返回结果。
     */
    const __setRingOpacity = (v) => {
      if (!cursorRing) return;
      if (v !== __lastRingOp) {
        cursorRing.style.opacity = v;
        __lastRingOp = v;
      }
    };
    /**
     * 内部设置指示点。
     * 目的：提供统一读写入口，降低耦合。
     * @param {any} v - 参数 v。
     * @returns {any} 返回结果。
     */
    const __setDotOpacity = (v) => {
      if (!cursorDot) return;
      if (v !== __lastDotOp) {
        cursorDot.style.opacity = v;
        __lastDotOp = v;
      }
    };

    /**
     * 内部检查charging、or。
     * 目的：用于判断charging、or状态，避免分散判断。
     * @returns {any} 返回结果。
     */
    const __isChargingOrReady = () =>
      document.body.classList.contains("landing-charging") || document.body.classList.contains("landing-system-ready");

    /**
     * 内部检查keep、running。
     * 目的：用于判断keep、running状态，避免分散判断。
     * @returns {any} 返回结果。
     */
    const __shouldKeepRunning = () => {
      if (__paused) return false;
      if (!isLandingVisible() || document.hidden) return false;
      if (autoWipe) return true;
      if (__isChargingOrReady()) return true;
      if (holding) return true;
      const dx = mouseX - currentX;
      const dy = mouseY - currentY;
      if (Math.abs(dx) > 0.35 || Math.abs(dy) > 0.35) return true;
      if (Math.abs(targetRadius - maskRadius) > 0.35) return true;
      return false;
    };

    /**
     * 内部启动loop。
     * 目的：统一处理loop相关流程，保证行为一致。
     * @returns {any} 返回结果。
     */
    const __startLoop = () => {
      if (__paused) return;
      if (__rafId) return;
      if (!isLandingVisible() || document.hidden) return;
      __rafId = requestAnimationFrame(__tick);
    };

    /**
     * 内部停止loop。
     * 目的：统一处理loop相关流程，保证行为一致。
     * @returns {any} 返回结果。
     */
    const __stopLoop = () => {
      if (__rafId) cancelAnimationFrame(__rafId);
      __rafId = 0;
    };


    __wakeLoop = __startLoop;

    /**
     * 内部处理tick逻辑。
     * 目的：统一处理tick相关流程，保证行为一致。
     * @returns {any} 返回结果。
     */
    function __tick() {
      __rafId = 0;

      if (!__shouldKeepRunning()) {

        return;
      }


      if (__isChargingOrReady()) {
        layerSolid.style.transform = "none";
        __setClip("circle(150% at 50% 50%)");
        __setOutlineT("none");
        __setRingOpacity("0");
        __setDotOpacity("0");
        __startLoop();
        return;
      } else {
        __setRingOpacity("");
        __setDotOpacity("");
      }


      if (autoWipe) {
        const now = performance.now();
        const t = Math.min(1, (now - autoWipe.start) / autoWipe.dur);
        const e = t;

        currentX = autoWipe.cx;
        currentY = autoWipe.cy;
        mouseX = autoWipe.cx;
        mouseY = autoWipe.cy;

        const rx = Math.round(currentX * 10) / 10;
        const ry = Math.round(currentY * 10) / 10;
        const mx = Math.round(mouseX * 10) / 10;
        const my = Math.round(mouseY * 10) / 10;

        __setRingT(`translate(${rx}px, ${ry}px) translate(-50%, -50%)`);
        __setDotT(`translate(${mx}px, ${my}px) translate(-50%, -50%)`);

        maskRadius = autoWipe.from + (autoWipe.to - autoWipe.from) * e;
        const rr = Math.round(maskRadius * 10) / 10;

        layerSolid.style.transform = "none";
        __setClip(`circle(${rr}px at ${rx}px ${ry}px)`);
        __setOutlineT("none");

        if (t >= 1) {
          const cb = autoWipe.onDone;
          const endFull = autoWipe.endFullCover;
          autoWipe = null;
          holding = false;
          document.body.classList.remove("landing-holding");
          if (endFull) __setClip("circle(160% at 50% 50%)");
          if (cb) setTimeout(cb, 0);
        }

        __startLoop();
        return;
      }


      currentX += (mouseX - currentX) * 0.15;
      currentY += (mouseY - currentY) * 0.15;

      const rx = Math.round(currentX * 10) / 10;
      const ry = Math.round(currentY * 10) / 10;
      const mx = Math.round(mouseX * 10) / 10;
      const my = Math.round(mouseY * 10) / 10;

      __setRingT(`translate(${rx}px, ${ry}px) translate(-50%, -50%)`);
      __setDotT(`translate(${mx}px, ${my}px) translate(-50%, -50%)`);


      if (holding) {
        maskRadius += (targetRadius - maskRadius) * 0.018;
        layerSolid.style.transform = "none";
      } else {
        maskRadius += (targetRadius - maskRadius) * 0.12;
        layerSolid.style.transform = "none";
      }

      const rr = Math.round(maskRadius * 10) / 10;
      __setClip(`circle(${rr}px at ${rx}px ${ry}px)`);


      if (!holding) {
        const px = (window.innerWidth / 2 - currentX) * 0.02;
        const py = (window.innerHeight / 2 - currentY) * 0.02;
        const tx = Math.round(px * 10) / 10;
        const ty = Math.round(py * 10) / 10;
        __setOutlineT(`translate(${tx}px, ${ty}px)`);
      } else {
        __setOutlineT("none");
      }

      __startLoop();
    }


    __startLoop();


    try {
      const mo = new MutationObserver(() => {
        if (!isLandingVisible() || document.hidden || __paused) __stopLoop();
        else __startLoop();
      });
      mo.observe(__landingLayer, { attributes: true, attributeFilter: ["aria-hidden"] });
    } catch (_) {}

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) __stopLoop();
      else __startLoop();
    });

    return {
      reset() {
        holding = false; autoWipe = null; targetRadius = 150; maskRadius = 150; document.body.classList.remove("landing-holding");
      },
      setCharging(v) {
        document.body.classList.toggle("landing-charging", !!v);
        __wakeLoop();
      },
      beginAutoWipe,
      pause(v) {
        __paused = !!v;
        if (__paused) __stopLoop();
        else __wakeLoop();
      },
    };
  }

  const __landingFx = initLandingCanvasEngine();


  /**
   * 内部处理Landing逻辑。
   * 目的：集中管理 Landing 状态切换与动画时序，避免交互状态冲突。
   * @param {any} origin - 参数 origin。
   * @param {any} opts - 参数 opts。
   * @returns {any} 返回结果。
   */
  function __reverseLandingToInitial(origin = null, opts = {}) {
    if (!__landingLayer) return;
    if (__landingLayer.getAttribute("aria-hidden") === "true") return;


    document.body.classList.remove(
      "landing-precharge",
      "landing-charging",
      "landing-system-ready",
      "landing-ready-zoom",
      "landing-ready-out",
      "landing-drop",
      "landing-reveal",
      "landing-holding"
    );
    document.body.classList.add("landing-active");
    __setAppInert(true);


    if (__triggerZone) __triggerZone.style.pointerEvents = "none";

    const cx = Number.isFinite(origin?.x) ? origin.x : window.innerWidth / 2;
    const cy = Number.isFinite(origin?.y) ? origin.y : window.innerHeight / 2;
    const dur = Number.isFinite(opts.durationMs) ? opts.durationMs : 260;

    const ok = __landingFx?.beginAutoWipe?.(
      cx,
      cy,
      () => {
        try { __landingFx?.reset?.(); } catch (_) {}
        __setLandingCaption("Hold to Initiate System");
        if (__triggerZone) __triggerZone.style.pointerEvents = "";
      },
      { durationMs: dur, toRadius: 150, endFullCover: false }
    );


    if (!ok) {
      try { __landingFx?.reset?.(); } catch (_) {}
      __setLandingCaption("Hold to Initiate System");
      if (__triggerZone) __triggerZone.style.pointerEvents = "";
    }
  }


  if (__triggerZone && __landingLayer) {
    /**
     * 处理begin、precharge逻辑。
     * 目的：统一处理begin、precharge相关流程，保证行为一致。
     * @returns {any} 返回结果。
     */
    const beginPrecharge = () => {


      document.body.classList.add("landing-precharge");
      document.body.classList.remove("landing-holding");
      __setLandingCaption("CONNECTING...");
    };

    /**
     * 处理begin、charging逻辑。
     * 目的：统一处理begin、charging相关流程，保证行为一致。
     * @returns {any} 返回结果。
     */
    const beginCharging = () => {

      document.body.classList.remove("landing-precharge");
      document.body.classList.add("landing-charging");
      document.body.classList.remove("landing-holding");
      __setLandingCaption("CONNECTING...");
    };

    __triggerZone.addEventListener("click", (e) => {

      __armManualConnectGuard(3000);

      if (e && e.clientX) __landingClickOrigin = { x: e.clientX, y: e.clientY };


      if (__triggerZone) __triggerZone.style.pointerEvents = "none";
      beginPrecharge();

      const cx = (e && Number.isFinite(e.clientX)) ? e.clientX : window.innerWidth / 2;
      const cy = (e && Number.isFinite(e.clientY)) ? e.clientY : window.innerHeight / 2;

      const startOk = __landingFx?.beginAutoWipe?.(cx, cy, () => {

        beginCharging();

        setTimeout(() => connectHid(true, false), 0);
      }, { durationMs: 100 });


      if (!startOk) {
        setTimeout(() => {
          beginCharging();
          setTimeout(() => connectHid(true, false), 0);
        }, 1400);
      }
    });


    __triggerZone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " ) {
        e.preventDefault();
        __triggerZone.click();
      }
    });
  }


  const xSelectMap = new WeakMap();
  const xSelectOpen = new Set();
  let xSelectGlobalHooksInstalled = false;

  /**
   * 关闭all。
   * 目的：统一选项构建与应用，避免选项与值不匹配。
   * @param {any} exceptWrap - 参数 exceptWrap。
   * @returns {any} 返回结果。
   */
  function closeAllXSelect(exceptWrap = null) {
    for (const inst of Array.from(xSelectOpen)) {
      if (exceptWrap && inst.wrap === exceptWrap) continue;
      inst.close();
    }
  }

  /**
   * 处理reposition、open逻辑。
   * 目的：在尺寸或状态变化时重新计算布局，避免错位。
   * @returns {any} 返回结果。
   */
  function repositionOpenXSelect() {
    for (const inst of Array.from(xSelectOpen)) inst.position();
  }

  /**
   * 处理create逻辑。
   * 目的：统一选项构建与应用，避免选项与值不匹配。
   * @param {any} selectEl - 参数 selectEl。
   * @returns {any} 返回结果。
   */
  function createXSelect(selectEl) {
    if (!selectEl || xSelectMap.has(selectEl)) return;
    const parent = selectEl.parentNode;
    if (!parent) return;


    const wrap = document.createElement("div");
    wrap.className = "xSelectWrap";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "input xSelectTrigger";
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const valueEl = document.createElement("span");
    valueEl.className = "xSelectValue";
    trigger.appendChild(valueEl);


    const menu = document.createElement("div");
    menu.className = "xSelectMenu xSelectMenuPortal";
    menu.setAttribute("role", "listbox");
    menu.style.display = "none";
    document.body.appendChild(menu);

    parent.insertBefore(wrap, selectEl);
    wrap.appendChild(selectEl);
    wrap.appendChild(trigger);

    selectEl.classList.add("xSelectNative");
    selectEl.tabIndex = -1;
    selectEl.setAttribute("aria-hidden", "true");

    const inst = {
      wrap,
      trigger,
      menu,
      valueEl,
      _lastRect: null,
      position() {
        if (!menu.classList.contains("open")) return;
        if (!document.body.contains(menu) || !document.body.contains(trigger)) {
          inst.close();
          return;
        }

        const r = trigger.getBoundingClientRect();
        inst._lastRect = r;

        const gap = 8;


        let left = r.left;
        let top = r.bottom + gap;
        const width = Math.max(120, r.width);


        menu.style.width = `${width}px`;
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;


        const mr = menu.getBoundingClientRect();
        const viewportW = window.innerWidth;
        const viewportH = window.innerHeight;


        const overflowRight = mr.right - (viewportW - gap);
        if (overflowRight > 0) {
          left = Math.max(gap, left - overflowRight);
          menu.style.left = `${left}px`;
        }

        const overflowLeft = gap - mr.left;
        if (overflowLeft > 0) {
          left = left + overflowLeft;
          menu.style.left = `${left}px`;
        }


        const menuH = menu.offsetHeight || mr.height || 0;
        const spaceBelow = viewportH - r.bottom - gap;
        const spaceAbove = r.top - gap;

        if (menuH > 0 && spaceBelow < Math.min(menuH, 260) && spaceAbove > spaceBelow) {
          top = r.top - gap - menuH;
          menu.style.top = `${top}px`;
          menu.classList.add("flipY");
        } else {
          menu.classList.remove("flipY");
        }
      },
      refresh() {
        menu.innerHTML = "";
        const opts = Array.from(selectEl.options || []);
        for (const opt of opts) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "xSelectOption";
          btn.dataset.value = opt.value;
          btn.textContent = opt.textContent ?? opt.label ?? String(opt.value ?? "");
          btn.setAttribute("role", "option");
          btn.disabled = !!opt.disabled;

          btn.addEventListener("click", () => {
            if (btn.disabled) return;
            selectEl.value = btn.dataset.value ?? "";
            selectEl.dispatchEvent(new Event("change", { bubbles: true }));
            inst.sync();
            inst.close();
            trigger.focus({ preventScroll: true });
          });

          menu.appendChild(btn);
        }
        inst.sync();
        inst.position();
      },
      sync() {
        const selOpt = selectEl.selectedOptions?.[0] || selectEl.options?.[selectEl.selectedIndex];
        valueEl.textContent = selOpt?.textContent ?? selOpt?.label ?? "";

        const v = String(selectEl.value ?? "");
        Array.from(menu.querySelectorAll(".xSelectOption")).forEach((btn) => {
          const isSel = String(btn.dataset.value ?? "") === v;
          btn.setAttribute("aria-selected", isSel ? "true" : "false");
        });
      },
      open() {
        if (menu.classList.contains("open")) return;
        closeAllXSelect(wrap);
        wrap.classList.add("open");

        inst._hostPanel = wrap.closest?.(".dpiMetaItem") || null;
        if (inst._hostPanel) inst._hostPanel.classList.add("xSelectActive");
        trigger.setAttribute("aria-expanded", "true");
        menu.classList.add("open");
        menu.style.display = "block";
        xSelectOpen.add(inst);

        inst.position();

        const v = String(selectEl.value ?? "");
        const btn = menu.querySelector(`.xSelectOption[data-value="${CSS.escape(v)}"]`) || menu.querySelector(".xSelectOption");
        btn?.focus?.({ preventScroll: true });
      },
      close() {
        if (!menu.classList.contains("open")) return;
        wrap.classList.remove("open");

        if (inst._hostPanel) inst._hostPanel.classList.remove("xSelectActive");
        inst._hostPanel = null;
        trigger.setAttribute("aria-expanded", "false");
        menu.classList.remove("open");
        menu.style.display = "none";
        xSelectOpen.delete(inst);
      },
      toggle() {
        menu.classList.contains("open") ? inst.close() : inst.open();
      },
    };


    const mo = new MutationObserver(() => inst.refresh());
    mo.observe(selectEl, { childList: true });


    selectEl.addEventListener("change", () => inst.sync());

    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      inst.toggle();
    });

    trigger.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        inst.toggle();
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        inst.open();
      }
      if (e.key === "Escape") {
        inst.close();
      }
    });

    menu.addEventListener("keydown", (e) => {
      const cur = document.activeElement;
      if (!(cur instanceof HTMLElement) || !cur.classList.contains("xSelectOption")) return;
      const all = Array.from(menu.querySelectorAll(".xSelectOption"));
      const idx = all.indexOf(cur);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        all[Math.min(all.length - 1, idx + 1)]?.focus?.({ preventScroll: true });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        all[Math.max(0, idx - 1)]?.focus?.({ preventScroll: true });
      } else if (e.key === "Escape") {
        e.preventDefault();
        inst.close();
        trigger.focus({ preventScroll: true });
      }
    });

    xSelectMap.set(selectEl, inst);
    inst.refresh();


    if (!xSelectGlobalHooksInstalled) {
      xSelectGlobalHooksInstalled = true;

      document.addEventListener("click", (e) => {
        const t = e.target;
        if (t && t.closest) {
          if (t.closest(".xSelectWrap")) return;
          if (t.closest(".xSelectMenu")) return;
        }
        closeAllXSelect();
      });

      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeAllXSelect();
      });

      window.addEventListener("resize", () => {
        repositionOpenXSelect();
      });

      window.addEventListener(
        "scroll",
        () => {
          repositionOpenXSelect();
        },
        true
      );
    }
  }

  /**
   * 初始化selects。
   * 目的：集中初始化与事件绑定，避免重复绑定或顺序问题。
   * @returns {any} 返回结果。
   */
  function initXSelects() {
    $$("select.input").forEach((sel) => createXSelect(sel));
  }


        const navLinks = $("#navLinks");
  const disconnectBtn = $("#disconnectBtn");
  const langBtn = $("#langBtn");
  const langBtnLabel = $("#langBtnLabel");
  const themeBtn = $("#themeBtn");
  const themePath = $("#themePath");
  const topSlotBtns = $$(".topSlotBtn");
  const topDeviceName = $("#topDeviceName");
  const topBatteryWrap = $("#topBatteryWrap");
  const topBatteryPercent = $("#topBatteryPercent");
  const topBatteryFill = $("#topBatteryFill");


  initXSelects();


  const deviceStatusDot = $("#deviceStatusDot");
  const widgetDeviceName = $("#widgetDeviceName");
  const widgetDeviceMeta = $("#widgetDeviceMeta");


  let currentDeviceName = "";
  let currentBatteryText = "";
  let currentFirmwareText = "";


  let hidLinked = false;
  let hidConnecting = false;


  let batteryTimer = null;

  function parseBatteryPercent(rawBatteryText) {
    const txt = String(rawBatteryText ?? "").trim();
    if (!txt) return null;
    const numeric = Number(txt.replace(/[^\d.]+/g, ""));
    if (!Number.isFinite(numeric)) return null;
    return Math.max(0, Math.min(100, Math.round(numeric)));
  }

  function renderTopDeviceMeta(connected, deviceName = "", batteryText = "") {
    if (topDeviceName) {
      const name = connected ? (deviceName || "已连接设备") : "未连接设备";
      topDeviceName.textContent = name;
      topDeviceName.title = name;
    }

    const batteryPercent = parseBatteryPercent(batteryText);
    if (topBatteryPercent) {
      topBatteryPercent.textContent = batteryPercent == null ? "--%" : `${batteryPercent}%`;
    }
    if (topBatteryFill) {
      topBatteryFill.style.width = batteryPercent == null ? "0%" : `${batteryPercent}%`;
    }
    if (topBatteryWrap) {
      topBatteryWrap.classList.toggle("is-mid", batteryPercent != null && batteryPercent > 20 && batteryPercent <= 60);
      topBatteryWrap.classList.toggle("is-low", batteryPercent != null && batteryPercent <= 20);
    }
  }


  /**
   * 安全请求电量。
   * 目的：在连接状态可用时触发请求，避免无效调用。
   * @param {any} reason - 参数 reason。
   * @returns {Promise<any>} 异步结果。
   */
  async function requestBatterySafe(reason = "") {
    if (!isHidReady()) return;
    if (adapterFeatures.supportsBatteryRequest === false) return;
    try {
      await hidApi.requestBattery();
      if (reason) log(`已刷新电量(${reason})`);
    } catch (e) {

      logErr(e, "请求电量失败");
    }
  }


  /**
   * 启动电量、自动流程。
   * 目的：统一电量读取与展示节奏，避免频繁请求或状态滞后。
   * @returns {any} 返回结果。
   */
  function startBatteryAutoRead() {
    if (batteryTimer) return;
    if (adapterFeatures.supportsBatteryRequest === false) return;

    requestBatterySafe("首次");

    const intervalMs = Number.isFinite(Number(adapterFeatures.batteryPollMs))
      ? Number(adapterFeatures.batteryPollMs)
      : 360_000;
    const tag = adapterFeatures.batteryPollTag || "auto";
    batteryTimer = setInterval(() => requestBatterySafe(tag), intervalMs);
  }


  /**
   * 停止电量、自动流程。
   * 目的：统一电量读取与展示节奏，避免频繁请求或状态滞后。
   * @returns {any} 返回结果。
   */
  function stopBatteryAutoRead() {
    if (batteryTimer) clearInterval(batteryTimer);
    batteryTimer = null;
  }

  /**
   * 更新设备、状态。
   * 目的：在状态变化时同步 UI 或数据，避免不一致。
   * @param {any} connected - 参数 connected。
   * @param {any} deviceName - 参数 deviceName。
   * @param {any} battery - 参数 battery。
   * @param {any} firmware - 参数 firmware。
   * @returns {any} 返回结果。
   */
  function updateDeviceStatus(connected, deviceName = "", battery = "", firmware = "") {
    if (disconnectBtn) {
      disconnectBtn.disabled = !connected;
      disconnectBtn.setAttribute("aria-disabled", connected ? "false" : "true");
      disconnectBtn.title = connected ? "断开当前设备连接" : "当前无设备连接";
    }

    if (connected) {
      deviceStatusDot?.classList.add("connected");


      let statusSuffix = "";
      if (deviceName && deviceName.includes("有线")) {
        statusSuffix = " 充电中";
      } else if (battery) {
        statusSuffix = ` 电量 ${battery}`;
      }
      const nameText = (deviceName) + statusSuffix;

      if (widgetDeviceName) widgetDeviceName.textContent = nameText;
      if (widgetDeviceMeta) widgetDeviceMeta.textContent = "点击断开";
      renderTopDeviceMeta(true, deviceName || currentDeviceName || "", battery || currentBatteryText || "");
    } else {
      deviceStatusDot?.classList.remove("connected");
      if (widgetDeviceName) widgetDeviceName.textContent = "未连接设备";
      if (widgetDeviceMeta) widgetDeviceMeta.textContent = "点击连接";
      renderTopDeviceMeta(false, "", "");
    }


    if (connected) {
      if (deviceName) currentDeviceName = deviceName;
      if (battery) currentBatteryText = battery;
      if (firmware) currentFirmwareText = firmware;
    } else {

      currentDeviceName = "";
      currentBatteryText = "";
      currentFirmwareText = "";
    }
  }


  const uiLocks = new Set();

  const writeDebouncers = new Map();
  let __writeSeqCounter = 0;
  const __intentByKey = new Map();
  const __INTENT_TTL_MS = 3000;

  let opChain = Promise.resolve();
  let opInFlight = false;

  /**
   * 互斥执行任务。
   * 目的：串行化关键写入与读取，避免竞态。
   * @param {any} task - 参数 task。
   * @returns {any} 返回结果。
   */
  function withMutex(task) {
    /**
     * 处理run逻辑。
     * 目的：统一处理run相关流程，保证行为一致。
     * @returns {Promise<any>} 异步结果。
     */
    const run = async () => {
      opInFlight = true;
      try { return await task(); }
      finally { opInFlight = false; }
    };
    const p = opChain.then(run, run);
    opChain = p.catch(() => {});
    return p;
  }

  /**
   * 检查HID。
   * 目的：用于判断HID状态，避免分散判断。
   * @returns {any} 返回结果。
   */
  function isHidOpened() {
    return !!(hidApi && hidApi.device && hidApi.device.opened);
  }

  /**
   * 检查HID。
   * 目的：用于判断HID状态，避免分散判断。
   * @returns {any} 返回结果。
   */
  function isHidReady() {
    return isHidOpened() && hidLinked;
  }
/**
 * 锁定逻辑。
 * 目的：串行化关键操作，避免并发竞争导致状态不一致。
 * @param {any} el - 参数 el。
 * @returns {any} 返回结果。
 */
function lockEl(el) {
    if (!el) return;
    if (!el.id) el.id = `__autogen_${Math.random().toString(36).slice(2, 10)}`;
    uiLocks.add(el.id);
  }
  /**
   * 解锁逻辑。
   * 目的：统一处理逻辑相关流程，保证行为一致。
   * @param {any} el - 参数 el。
   * @returns {any} 返回结果。
   */
  function unlockEl(el) {
    if (!el || !el.id) return;
    uiLocks.delete(el.id);
  }
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (el && (el.matches("input,select,textarea"))) lockEl(el);
  });
  document.addEventListener("focusout", (e) => {
    const el = e.target;
    if (el && (el.matches("input,select,textarea"))) unlockEl(el);
  });

  /**
   * 安全设置输入值。
   * 目的：避免 UI 回填时触发额外事件或锁冲突。
   * @param {any} el - 参数 el。
   * @param {any} value - 参数 value。
   * @returns {any} 返回结果。
   */
  function safeSetValue(el, value) {
    if (!el) return;
    if (el.id && uiLocks.has(el.id)) return;
    const v = String(value ?? "");
    if (el.value !== v) el.value = v;
    if (el.tagName === "SELECT") xSelectMap.get(el)?.sync?.();
  }
  /**
   * 安全设置勾选状态。
   * 目的：避免 UI 回填时触发额外事件或锁冲突。
   * @param {any} el - 参数 el。
   * @param {any} checked - 参数 checked。
   * @returns {any} 返回结果。
   */
  function safeSetChecked(el, checked) {
    if (!el) return;
    if (el.id && uiLocks.has(el.id)) return;
    el.checked = !!checked;
  }

  /**
   * 按键维度执行防抖。
   * 目的：合并高频触发，降低写入抖动。
   * @param {any} key - 参数 key。
   * @param {any} ms - 参数 ms。
   * @param {any} fn - 参数 fn。
   * @returns {any} 返回结果。
   */
  function debounceKey(key, ms, fn) {
    if (writeDebouncers.has(key)) clearTimeout(writeDebouncers.get(key));
    const t = setTimeout(() => {
      writeDebouncers.delete(key);
      fn();
    }, ms);
    writeDebouncers.set(key, t);
  }


  const THEME_KEY = "mouse_console_theme";
  const prefersDark =
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const savedTheme = localStorage.getItem(THEME_KEY);

  /**
   * 应用主题。
   * 目的：集中应用配置，确保入口一致。
   * @param {any} theme - 参数 theme。
   * @returns {any} 返回结果。
   */
  function applyTheme(theme) {
    const dark = theme === "dark";
    document.body.classList.toggle("dark", dark);

    themePath?.setAttribute(
      "d",
      dark
        ? "M12 2v2m0 16v2m10-10h-2M4 12H2m15.07 7.07-1.41-1.41M8.34 8.34 6.93 6.93m0 10.14 1.41-1.41m8.73-8.73 1.41-1.41M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"
        : "M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"
    );
    themeBtn?.setAttribute("aria-label", dark ? "切换浅色模式" : "切换深色模式");
  }


  const initialTheme =
    savedTheme === "dark" || savedTheme === "light"
      ? savedTheme
      : (prefersDark ? "dark" : "light");
  applyTheme(initialTheme);
  themeBtn?.addEventListener("click", () => {
    const cur = document.body.classList.contains("dark") ? "dark" : "light";
    const next = cur === "dark" ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    applyTheme(next);
  });


  const LANG_KEY = "mouse_console_lang";
  const savedLang = localStorage.getItem(LANG_KEY) || "zh";

  const dict = {
    zh: {
      heroTitle: "CRODRAK",
      nav: { home: "连接", dpi: "DPI设置", basic: "基础性能", advanced: "高级参数", keys: "按键设置", logs: "运行日志" },
      foot: "Built with HTML/CSS/JS",
    },
    en: {
      heroTitle: "CRDRAKO",
      nav: { home: "Connect", dpi: "DPI", basic: "Basic", advanced: "Advanced", keys: "Keys", logs: "Logs" },
      foot: "Built with HTML/CSS/JS",
    },
  };

  /**
   * 应用语言。
   * 目的：集中应用配置，确保入口一致。
   * @param {any} lang - 参数 lang。
   * @returns {any} 返回结果。
   */
  function applyLang(lang) {
    const pack = dict[lang] || dict.zh;
    const _heroTitleEl = $("#heroTitle");
    if (_heroTitleEl) _heroTitleEl.textContent = pack.heroTitle;

    const _heroSubEl = $("#heroSub");
    if (_heroSubEl) _heroSubEl.textContent = pack.heroSub;

    $$(".sidebar .nav-item").forEach((a) => {
      const k = a.getAttribute("data-key");

      const span = a.querySelector('.nav-text');
      if (span && k && pack.nav[k]) {
          span.textContent = pack.nav[k];
      }
    });

    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    if (langBtnLabel) langBtnLabel.textContent = lang === "zh" ? "EN" : "中";
    langBtn?.setAttribute("aria-label", lang === "zh" ? "Switch to English" : "切换中文");
  }

  applyLang(savedLang);
  langBtn?.addEventListener("click", () => {
    const cur = document.documentElement.lang.startsWith("en") ? "en" : "zh";
    const next = cur === "zh" ? "en" : "zh";
    localStorage.setItem(LANG_KEY, next);
    applyLang(next);
  });


  const TOP_CONFIG_SLOT_LABELS = ["壹", "贰", "叁", "肆", "伍"];
  const __hasConfigSlots = hasFeature("hasConfigSlots");
  let __uiTopConfigSlotCount = 1;
  let __uiTopActiveConfigSlotIndex = 0;

  function renderTopConfigSlots({ slotCount = 1, activeIndex = 0 } = {}) {
    if (!topSlotBtns.length) return;

    if (!__hasConfigSlots) {
      __uiTopConfigSlotCount = 1;
      __uiTopActiveConfigSlotIndex = 0;
      topSlotBtns.forEach((btn, idx) => {
        const visible = idx === 0;
        btn.hidden = !visible;
        btn.style.display = visible ? "" : "none";
        btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
        btn.classList.toggle("active", visible);
        btn.setAttribute("aria-selected", visible ? "true" : "false");
        if (visible) btn.textContent = "当前配置";
      });
      return;
    }

    const maxCount = topSlotBtns.length;
    const rawCount = Number(slotCount);
    const nextCount = Number.isFinite(rawCount) ? clamp(Math.round(rawCount), 1, maxCount) : 1;
    const rawActive = Number(activeIndex);
    const nextActiveIdx = Number.isFinite(rawActive)
      ? clamp(Math.round(rawActive), 0, Math.max(0, nextCount - 1))
      : 0;

    __uiTopConfigSlotCount = nextCount;
    __uiTopActiveConfigSlotIndex = nextActiveIdx;

    topSlotBtns.forEach((btn, idx) => {
      const slotNo = idx + 1;
      const visible = slotNo <= nextCount;
      const isActive = visible && idx === nextActiveIdx;
      btn.hidden = !visible;
      btn.style.display = visible ? "" : "none";
      btn.disabled = !visible;
      btn.setAttribute("aria-disabled", visible ? "false" : "true");
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
      if (visible) {
        const label = TOP_CONFIG_SLOT_LABELS[idx] || String(slotNo);
        btn.textContent = `配置"${label}"`;
      }
    });
  }

  renderTopConfigSlots({ slotCount: 1, activeIndex: 0 });
  topSlotBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!__hasConfigSlots) return;
      if (btn.hidden || btn.disabled) return;

      const slotNo = Number(btn.dataset.configSlot);
      if (!Number.isInteger(slotNo)) return;
      const targetIndex = slotNo - 1;
      if (targetIndex < 0 || targetIndex >= __uiTopConfigSlotCount) return;
      if (targetIndex === __uiTopActiveConfigSlotIndex) return;

      if (!confirm("是否切换配置")) return;
      renderTopConfigSlots({ slotCount: __uiTopConfigSlotCount, activeIndex: targetIndex });
      enqueueDevicePatch({ activeConfigSlotIndex: targetIndex });
    });
  });


  const sidebarItems = $$(".sidebar .nav-item");
  const NAV_SWITCHING_CLASS = "nav-switching";
  const NAV_SWITCHING_MS = 180;
  let __navSwitchingTimer = null;

  function markNavSwitching() {
    document.body.classList.add(NAV_SWITCHING_CLASS);
    if (__navSwitchingTimer) clearTimeout(__navSwitchingTimer);
    __navSwitchingTimer = setTimeout(() => {
      __navSwitchingTimer = null;
      document.body.classList.remove(NAV_SWITCHING_CLASS);
    }, NAV_SWITCHING_MS);
  }


  /**
   * 设置active、by。
   * 目的：提供统一读写入口，降低耦合。
   * @returns {any} 返回结果。
   */
  function setActiveByHash(triggerNavSwitching = false) {
    if (triggerNavSwitching) markNavSwitching();
    let key = (location.hash || "#keys").replace("#", "") || "keys";
    if (key === "tuning") key = "basic";
    if (!document.getElementById(key)) key = "keys";


    sidebarItems.forEach((item) => {
      const itemKey = item.getAttribute("data-key");
      const isActive = itemKey === key;


      if (isActive) {
          item.classList.add("active");

          const color = item.getAttribute("data-color") || "#000000";
          document.documentElement.style.setProperty('--theme-color', color);
      } else {
          item.classList.remove("active");
      }
    });


    $$("#stageBody > section.page").forEach((p) => p.classList.toggle("active", p.id === key));


    document.body.classList.toggle("page-keys", key === "keys");
    document.body.classList.toggle("page-dpi", key === "dpi");
    document.body.classList.toggle("page-basic", key === "basic");
    document.body.classList.toggle("page-advanced", key === "advanced");
    document.body.classList.toggle("page-testtools", key === "testtools");


    if (key !== "testtools") {
      try {
        const pl = document.pointerLockElement;
        if (pl && (pl.id === "rateBox" || pl.id === "lockTarget" || pl.id === "rotLockTarget")) {
          document.exitPointerLock();
        }
      } catch (_) {}
      document.body.classList.remove("tt-pointerlock");
    }


    try {
      window.dispatchEvent(new CustomEvent("testtools:active", { detail: { active: key === "testtools" } }));
    } catch (_) {}

    if (key === "basic" && typeof syncBasicMonolithUI === "function") {
      syncBasicMonolithUI();
    }


    const sb = $("#stageBody");
    if (sb) sb.scrollTop = 0;
  }


  let __basicMonolithInited = false;
  let __basicModeItems = [];
  let __basicHzItems = [];
  let __basicSvgLayer = null;
  let __basicSvgPath = null;
  let __basicActiveModeEl = null;
  let __basicActiveHzEl = null;
  let __startLineAnimation = null;


  const __defaultPerfConfig = {
    low:  { color: "#00A86B", text: "低功耗模式 传感器帧率 1000~5000 AutoFPS" },
    hp:   { color: "#000000", text: "标准模式 传感器帧率 1000~20000 AutoFPS" },
    sport:{ color: "#FF4500", text: "竞技模式 传感器帧率 10800 FPS" },
    oc:   { color: "#4F46E5", text: "超频模式 传感器帧率 25000 FPS " },
  };


  const __basicModeConfig = adapter?.ui?.perfMode || __defaultPerfConfig;
  const __isDualPollingRates = hasFeature("hasDualPollingRates");
  const __hasPerformanceMode = hasFeature("hasPerformanceMode");
  const __hideBasicSynapse = hasFeature("hideBasicSynapse");
  const __hideBasicFooterSecondaryText = hasFeature("hideBasicFooterSecondaryText");
  const __dualPollingThemeMap =
    (adapter?.ui?.pollingThemeByWirelessHz && typeof adapter.ui.pollingThemeByWirelessHz === "object")
      ? adapter.ui.pollingThemeByWirelessHz
      : null;

  function __resolveDualPollingThemeColor(hz) {
    if (!__dualPollingThemeMap) return null;
    const direct = __dualPollingThemeMap[String(hz)];
    if (typeof direct === "string" && direct.trim()) return direct;

    const target = Number(hz);
    const entries = Object.entries(__dualPollingThemeMap)
      .map(([k, v]) => [Number(k), v])
      .filter(([rate, color]) => Number.isFinite(rate) && typeof color === "string" && color.trim());
    if (!entries.length) return null;
    if (!Number.isFinite(target)) return entries[0][1];

    let best = entries[0];
    for (const item of entries) {
      if (Math.abs(item[0] - target) < Math.abs(best[0] - target)) best = item;
    }
    return best[1];
  }

  /**
   * 刷新基础性能页项引用。
   * 目的：在 DOM 重建后重新抓取节点，避免使用失效引用。
   * @param {any} root - 参数 root。
   * @returns {any} 返回结果。
   */
  function __refreshBasicItemRefs(root = document.getElementById("basicMonolith")) {
    if (!root) {
      __basicModeItems = [];
      __basicHzItems = [];
      return;
    }
    const leftSelector = __isDualPollingRates
      ? "#basicModeColumn .basicItem[data-hz]"
      : "#basicModeColumn .basicItem[data-perf]";
    __basicModeItems = Array.from(root.querySelectorAll(leftSelector));
    __basicHzItems = Array.from(root.querySelectorAll("#basicHzColumn .basicItem[data-hz]"));
  }

  /**
   * 同步basic、monolith。
   * 目的：保持状态一致性，避免局部更新遗漏。
   * @returns {any} 返回结果。
   */
  function syncBasicMonolithUI() {
    const root = document.getElementById("basicMonolith");
    if (!root) return;
    __refreshBasicItemRefs(root);

    const perf = document.querySelector('input[name="perfMode"]:checked')?.value || "low";
    const wiredHz = document.getElementById("pollingSelect")?.value || "1000";
    const wirelessHz = document.getElementById("pollingSelectWireless")?.value || wiredHz;
    const hz = wiredHz;


    __basicActiveModeEl = null;
    if (__isDualPollingRates) {
      __basicModeItems.forEach((el) => {
        const on = String(el.dataset.hz) === String(wirelessHz);
        el.classList.toggle("active", on);
        if (on) __basicActiveModeEl = el;
      });
    } else {
      __basicModeItems.forEach((el) => {
        const on = el.dataset.perf === perf;
        el.classList.toggle("active", on);
        if (on) __basicActiveModeEl = el;
      });
    }


    __basicActiveHzEl = null;
    __basicHzItems.forEach((el) => {
      const on = String(el.dataset.hz) === String(wiredHz);
      el.classList.toggle("active", on);
      if (on) __basicActiveHzEl = el;
    });


    const ticker = document.getElementById("basicHzTicker");
    if (ticker) {
      ticker.innerHTML = '<span class="ticker-label">轮询率：</span>' + String(hz) + " HZ";
    }

    const st = document.getElementById("basicStatusText");
    const cfg = __basicModeConfig[perf] || __basicModeConfig.low;
    if (st) {
      st.textContent = __hideBasicFooterSecondaryText ? "" : cfg.text;
    }

    let themeColor = cfg.color;
    if (__isDualPollingRates) {
      const dualThemeColor = __resolveDualPollingThemeColor(wirelessHz);
      if (dualThemeColor) themeColor = dualThemeColor;
    }


    if (document.body.classList.contains("page-basic")) {
      document.documentElement.style.setProperty("--theme-color", themeColor);
    }

    if (__isDualPollingRates) {
      if (ticker) ticker.innerHTML = '<span class="ticker-label">回报率:</span>' + `无线 ${wirelessHz} HZ | 有线 ${wiredHz} HZ`;
      if (st && !__hideBasicFooterSecondaryText) {
        st.textContent = `无线 ${wirelessHz}Hz | 有线 ${wiredHz}Hz`;
      }
    }


    if (typeof __startLineAnimation === 'function') {
      __startLineAnimation(600);
    }
  }

  /**
   * 内部处理性能模式逻辑。
   * 目的：提供统一读写入口，降低耦合。
   * @param {any} perf - 参数 perf。
   * @returns {any} 返回结果。
   */
  function __basicSetPerf(perf) {
    const r = document.querySelector(`input[name="perfMode"][value="${perf}"]`);
    if (!r) return;
    r.checked = true;
    r.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * 内部处理basic、set逻辑。
   * 目的：提供统一读写入口，降低耦合。
   * @param {any} hz - 参数 hz。
   * @returns {any} 返回结果。
   */
  function __basicSetHz(hz) {
    const sel = document.getElementById("pollingSelect");
    if (!sel) return;
    sel.value = String(hz);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * 鍐呴儴澶勭悊basic鏃犵嚎鍥炴姤鐜囪缃€?
   * 鐩殑锛氬皢宸︿晶鍒楃偣鍑诲拰闅愯棌鎺т欢缁戝畾鍒版棤绾垮洖鎶ョ巼鍐欏叆娴佺▼銆?
   * @param {any} hz - 鍙傛暟 hz銆?
   * @returns {any} 杩斿洖缁撴灉銆?
   */
  function __basicSetWirelessHz(hz) {
    const sel = document.getElementById("pollingSelectWireless");
    if (!sel) return;
    sel.value = String(hz);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * 内部处理basic、bind逻辑。
   * 目的：统一处理basic、bind相关流程，保证行为一致。
   * @param {any} el - 参数 el。
   * @param {any} handler - 参数 handler。
   * @returns {any} 返回结果。
   */
  function __basicBindItem(el, handler) {
    if (!el || typeof handler !== "function") return;
    if (el.dataset.__basic_bound === "1") return;
    el.dataset.__basic_bound = "1";
    el.addEventListener("click", (e) => {
      const t = e.target;

      if (t && (t.closest('input[name="perfMode"]') || t.closest('#pollingSelect') || t.closest('#pollingSelectWireless'))) {
        return;
      }
      handler();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler();
      }
    });
  }

  /**
   * 初始化basic、monolith。
   * 目的：集中初始化与事件绑定，避免重复绑定或顺序问题。
   * @returns {any} 返回结果。
   */
  function initBasicMonolithUI() {
    if (__basicMonolithInited) return;
    const root = document.getElementById("basicMonolith");
    if (!root) return;

    __basicMonolithInited = true;

    __refreshBasicItemRefs(root);
    __basicSvgLayer = root.querySelector("#basicSynapseLayer");
    __basicSvgPath = root.querySelector("#basicSynapseLayer .basicConnectionPath");


    /**
     * 确保span。
     * 目的：统一处理span相关流程，保证行为一致。
     * @param {any} item - 参数 item。
     * @param {any} side - 参数 side。
     * @returns {any} 返回结果。
     */
    const ensureLabelSpan = (item, side) => {
      if (!item || item.querySelector(":scope > .basicLabel")) return;

      const anchor = item.querySelector(":scope > .basicAnchor") || item.querySelector(".basicAnchor");

      const text = (item.textContent || "").replace(/\s+/g, " ").trim();

      const label = document.createElement("span");
      label.className = "basicLabel";
      label.textContent = text;


      while (item.firstChild) item.removeChild(item.firstChild);
      if (anchor) anchor.remove();

      if (side === "right") {
        if (anchor) item.appendChild(anchor);
        item.appendChild(label);
      } else {
        item.appendChild(label);
        if (anchor) item.appendChild(anchor);
      }
    };

    __basicModeItems.forEach((it) => ensureLabelSpan(it, "left"));
    __basicHzItems.forEach((it) => ensureLabelSpan(it, "right"));


    /**
     * 同步svg、box。
     * 目的：保持状态一致性，避免局部更新遗漏。
     * @returns {any} 返回结果。
     */
    const syncSvgBox = () => {
      if (!__basicSvgLayer) return;
      const w = Math.max(1, Number(__basicSvgLayer.clientWidth || __basicSvgLayer.getBoundingClientRect().width || 1));
      const h = Math.max(1, Number(__basicSvgLayer.clientHeight || __basicSvgLayer.getBoundingClientRect().height || 1));
      __basicSvgLayer.setAttribute("viewBox", `0 0 ${w} ${h}`);
      __basicSvgLayer.setAttribute("preserveAspectRatio", "none");
    };
    syncSvgBox();
    window.addEventListener("resize", syncSvgBox);

    __basicModeItems.forEach((el) => {
      if (__isDualPollingRates) {
        __basicBindItem(el, () => __basicSetWirelessHz(el.dataset.hz));
      } else {
        __basicBindItem(el, () => __basicSetPerf(el.dataset.perf));
      }
    });
    __basicHzItems.forEach((el) => {
      __basicBindItem(el, () => __basicSetHz(el.dataset.hz));
    });

    const __observerTargetA = root.querySelector("#basicModeColumn");
    const __observerTargetB = root.querySelector("#basicHzColumn");
    if (window.MutationObserver) {
      const onMut = () => {
        __refreshBasicItemRefs(root);
        __basicModeItems.forEach((el) => {
          if (__isDualPollingRates) __basicBindItem(el, () => __basicSetWirelessHz(el.dataset.hz));
          else __basicBindItem(el, () => __basicSetPerf(el.dataset.perf));
        });
        __basicHzItems.forEach((el) => __basicBindItem(el, () => __basicSetHz(el.dataset.hz)));
        syncBasicMonolithUI();
      };
      const mo = new MutationObserver(onMut);
      if (__observerTargetA) mo.observe(__observerTargetA, { childList: true, subtree: true });
      if (__observerTargetB) mo.observe(__observerTargetB, { childList: true, subtree: true });
    }


    document.getElementById("pollingSelect")?.addEventListener("change", syncBasicMonolithUI);
    if (__isDualPollingRates) {
      document.getElementById("pollingSelectWireless")?.addEventListener("change", syncBasicMonolithUI);
    } else {
      document.querySelectorAll('input[name="perfMode"]').forEach((r) => {
        r.addEventListener("change", syncBasicMonolithUI);
      });
    }


    /**
     * 处理client、to逻辑。
     * 目的：处理指针交互与坐标映射，保证拖拽/命中判断准确。
     * @param {any} x - 参数 x。
     * @param {any} y - 参数 y。
     * @returns {any} 返回结果。
     */
    const clientToSvg = (x, y) => {
      const layerRect = __basicSvgLayer?.getBoundingClientRect();
      if (!layerRect) return { x, y };
      return {
        x: x - layerRect.left,
        y: y - layerRect.top,
      };
    };

    /**
     * 获取attach、point。
     * 目的：提供统一读写入口，降低耦合。
     * @param {any} item - 参数 item。
     * @param {any} side - 参数 side。
     * @returns {any} 返回结果。
     */
    const getAttachPoint = (item, side) => {
      const label = item?.querySelector(".basicLabel") || item;
      if (!label) return null;
      const r = label.getBoundingClientRect();
      if (!r || !isFinite(r.left) || !isFinite(r.top)) return null;

      const isActive = item.classList.contains("active");

      const basePad = Math.max(16, Math.min(44, r.height * 0.24));
      const pad = basePad + (isActive ? 14 : 0);


      const yBias = isActive ? 0.50 : 0.54;
      const y = r.top + r.height * yBias;
      const x = side === "left" ? r.right + pad : r.left - pad;
      return clientToSvg(x, y);
    };


    let lineRafId = 0;


    /**
     * 更新line、once。
     * 目的：在状态变化时同步 UI 或数据，避免不一致。
     * @returns {any} 返回结果。
     */
    const updateLineOnce = () => {
      if (!document.body.classList.contains("page-basic")) return;
      if (!__basicActiveModeEl || !__basicActiveHzEl || !__basicSvgPath) return;
      syncSvgBox();

      const a = getAttachPoint(__basicActiveModeEl, "left");
      const b = getAttachPoint(__basicActiveHzEl, "right");
      if (a && b) {
        const dx = Math.max(40, Math.abs(b.x - a.x) * 0.15);
        const d = `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} C ${(a.x + dx).toFixed(2)} ${a.y.toFixed(2)}, ${(b.x - dx).toFixed(2)} ${b.y.toFixed(2)}, ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;


        if (__basicSvgPath.getAttribute("d") !== d) {
            __basicSvgPath.setAttribute("d", d);
        }
      }
    };


    /**
     * 启动line、animation。
     * 目的：统一处理line、animation相关流程，保证行为一致。
     * @param {any} duration - 参数 duration。
     * @returns {any} 返回结果。
     */
    const startLineAnimation = (duration = 800) => {
      if (lineRafId) cancelAnimationFrame(lineRafId);
      const start = performance.now();

      /**
       * 处理loop逻辑。
       * 目的：统一处理loop相关流程，保证行为一致。
       * @param {any} now - 参数 now。
       * @returns {any} 返回结果。
       */
      const loop = (now) => {
        updateLineOnce();

        if (now - start < duration) {
          lineRafId = requestAnimationFrame(loop);
        } else {
          lineRafId = 0;
        }
      };
      lineRafId = requestAnimationFrame(loop);
    };


    if (__hideBasicSynapse) {
      __startLineAnimation = null;
    } else {
      __startLineAnimation = startLineAnimation;


      window.addEventListener("resize", () => startLineAnimation(100));


      const sidebar = document.querySelector('.sidebar');
      if (sidebar) {
          sidebar.addEventListener('transitionend', (e) => {
            if (!e || e.target !== sidebar) return;
            if (e.propertyName !== "width" && e.propertyName !== "padding-left") return;
            startLineAnimation(120);
          });
      }


      startLineAnimation(100);
    }


    syncBasicMonolithUI();
  }


  let __advancedPanelInited = false;
  let __logitechAdvancedUiInited = false;

  /**
   * 内部处理列表逻辑。
   * 目的：统一处理列表相关流程，保证行为一致。
   * @param {any} selectEl - 参数 selectEl。
   * @returns {any} 返回结果。
   */
  function __optList(selectEl) {
    if (!selectEl) return [];
    const opts = Array.from(selectEl.options || []);
    return opts.map((o) => ({
      val: String(o.value ?? ""),
      rawLabel: String(o.textContent ?? o.label ?? o.value ?? "")
    }));
  }

  /**
   * 内部格式化休眠。
   * 目的：统一展示格式，减少格式分散。
   * @param {any} valStr - 参数 valStr。
   * @param {any} rawLabel - 参数 rawLabel。
   * @returns {any} 返回结果。
   */
  function __formatSleepLabel(valStr, rawLabel) {
    const raw = String(rawLabel || "");


    if (/[a-zA-Z]/.test(raw) && raw.trim().length <= 8) {
      const numMatch = raw.match(/^(\d+)/);
      if (numMatch) return numMatch[1];
      return raw.trim();
    }


    const m = raw.match(/\(([^)]+)\)/);
    if (m && m[1]) {
      const numMatch = m[1].match(/^(\d+)/);
      if (numMatch) return numMatch[1];
      return m[1].trim();
    }

    const v = Number(valStr);
    if (!Number.isFinite(v)) return raw || (valStr || "-");


    if (v >= 3600 && v % 3600 === 0) return String(v / 3600);
    if (v >= 60 && v % 60 === 0 && v < 3600) return String(v / 60);
    return String(v);
  }

  /**
   * 内部获取休眠。
   * 目的：提供统一读写入口，降低耦合。
   * @param {any} valStr - 参数 valStr。
   * @returns {any} 返回结果。
   */
  function __getSleepUnit(valStr) {
    const v = Number(valStr);
    if (!Number.isFinite(v)) return "";


    if (v < 60) return "s";
    return "min";
  }

  /**
   * 内部格式化防抖。
   * 目的：合并高频触发，降低写入抖动与性能开销。
   * @param {any} valStr - 参数 valStr。
   * @param {any} rawLabel - 参数 rawLabel。
   * @returns {any} 返回结果。
   */
  function __formatDebounceLabel(valStr, rawLabel) {
    const v = Number(valStr);
    if (Number.isFinite(v)) return String(v);
    return String(rawLabel || valStr || "-");
  }

  /**
   * 内部钳制逻辑。
   * 目的：限制数值边界，防止越界。
   * @param {any} n - 参数 n。
   * @param {any} a - 参数 a。
   * @param {any} b - 参数 b。
   * @returns {any} 返回结果。
   */
  function __clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  /**
   * 内部同步滑块。
   * 目的：同步滑块与数值输入，避免 UI 与值不一致。
   * @param {any} selectEl - 参数 selectEl。
   * @param {any} rangeEl - 参数 rangeEl。
   * @param {any} dispEl - 参数 dispEl。
   * @param {any} formatLabel - 参数 formatLabel。
   * @param {any} getUnit - 参数 getUnit。
   * @returns {any} 返回结果。
   */
  function __syncDiscreteSlider(selectEl, rangeEl, dispEl, formatLabel, getUnit) {
    const opts = __optList(selectEl);
    if (rangeEl) {
      rangeEl.min = "0";
      rangeEl.max = String(Math.max(0, opts.length - 1));
      rangeEl.step = "1";
    }

    const cur = String(selectEl?.value ?? "");
    let idx = opts.findIndex((o) => String(o.val) === cur);
    if (idx < 0) idx = 0;
    idx = __clamp(idx, 0, Math.max(0, opts.length - 1));

    if (rangeEl && String(rangeEl.value) !== String(idx)) rangeEl.value = String(idx);
    const o = opts[idx] || { val: cur, rawLabel: cur };
    if (dispEl) {
      dispEl.textContent = formatLabel(String(o.val), String(o.rawLabel));

      if (getUnit && typeof getUnit === 'function') {
        dispEl.setAttribute('data-unit', getUnit(String(o.val)));
      }
    }
    return { opts, idx };
  }


  /**
   * 更新休眠。
   * 目的：在状态变化时同步 UI 或数据，避免不一致。
   * @returns {any} 返回结果。
   */
  function updateSleepFins() {
    const sleepInput = document.getElementById("sleepInput");
    const sleepFinDisplay = document.getElementById("sleepFinDisplay");

    if (sleepInput && sleepFinDisplay) {

      const currentIdx = parseInt(sleepInput.value) || 0;
      const minIdx = parseInt(sleepInput.min) || 0;
      const maxIdx = parseInt(sleepInput.max) || 6;


      let progress = 0;
      if (maxIdx > minIdx) {
        progress = (currentIdx - minIdx) / (maxIdx - minIdx);
        progress = Math.max(0, Math.min(1, progress));
      } else if (currentIdx >= minIdx) {
        progress = 1;
      }

      const fins = sleepFinDisplay.querySelectorAll(".fin");
      const totalFins = fins.length;


      let activeCount = 0;
      if (progress > 0) {

        activeCount = Math.ceil(progress * totalFins);
      }


      fins.forEach((fin, index) => {

        if (index < activeCount) {
          fin.classList.add("active");

          fin.style.transitionDelay = `${index * 0.03}s`;
        } else {
          fin.classList.remove("active");
          fin.style.transitionDelay = "0s";
        }
      });
    }
  }

  /**
   * 同步advanced、panel。
   * 目的：保持状态一致性，避免局部更新遗漏。
   * @returns {any} 返回结果。
   */
  function syncAdvancedPanelUi() {
    const root = document.getElementById("advancedPanel");
    if (!root) return;


    __syncDiscreteSlider(
      document.getElementById("sleepSelect"),
      document.getElementById("sleepInput"),
      document.getElementById("sleep_disp"),
      __formatSleepLabel,
      __getSleepUnit
    );

    __syncDiscreteSlider(
      document.getElementById("debounceSelect"),
      document.getElementById("debounceInput"),
      document.getElementById("debounce_disp"),
      __formatDebounceLabel
    );


    const debounceInput = document.getElementById("debounceInput");
    const debounceBar = document.getElementById("debounceBar");

    if (debounceInput && debounceBar) {
      const val = parseFloat(debounceInput.value) || 0;
      const min = parseFloat(debounceInput.min) || 0;
      const max = parseFloat(debounceInput.max) || 10;


      let pct = (val - min) / (max - min);
      if (isNaN(pct)) pct = 0;
      if (max === min) pct = 0;


      const minW = 4;
      const maxW = 100;
      const widthPx = minW + (pct * (maxW - minW));

      debounceBar.style.width = `${widthPx}px`;
    }


    const angleInput = document.getElementById("angleInput");
    const angleDisp = document.getElementById("angle_disp");
    const horizonLine = document.getElementById("horizonLine");

    if (angleInput) {
      const val = Number(angleInput.value ?? 0);


      if (angleDisp) angleDisp.textContent = String(val);


      if (horizonLine) {
        horizonLine.style.transform = `translateY(-50%) rotate(${val}deg)`;
      }
    }


    const feelInput = document.getElementById("feelInput");
    const feelDisp = document.getElementById("feel_disp");
    const heightBlock = document.getElementById("heightBlock");

    if (feelInput) {
      const val = parseFloat(feelInput.value) || 0;


      const min = parseFloat(feelInput.min) || 0;

      const max = parseFloat(feelInput.max) === min ? (min + 100) : parseFloat(feelInput.max);


      if (feelDisp) feelDisp.textContent = String(val);


      if (heightBlock) {

        let pct = (val - min) / (max - min);
        pct = Math.max(0, Math.min(1, pct));


        const bottomPx = 6 + (pct * 24);

        heightBlock.style.bottom = `${bottomPx}px`;
      }
    }


    updateSleepFins();
    syncLogitechAdvancedUi();
  }

  const LG_SURFACE_MODE_OPTS = [
    { val: "auto", label: "自动", cls: "lg-surface-mode-auto" },
    { val: "on", label: "打开", cls: "lg-surface-mode-on" },
    { val: "off", label: "关闭", cls: "lg-surface-mode-off" },
  ];

  function __normalizeLgSurfaceMode(rawValue) {
    const mode = String(rawValue || "").trim().toLowerCase();
    if (mode === "on") return "on";
    if (mode === "off") return "off";
    return "auto";
  }

  function updateLgSurfaceModeCycleUI(mode, animate = true) {
    const container = document.getElementById("lgSurfaceModeCycle");
    if (!container) return;
    const selectEl = document.getElementById("lgSurfaceModeSelect");
    const normalized = __normalizeLgSurfaceMode(mode);
    const opt = LG_SURFACE_MODE_OPTS.find((item) => item.val === normalized) || LG_SURFACE_MODE_OPTS[0];
    const syncForm = (nextValue) => {
      container.dataset.value = String(nextValue);
      container.classList.toggle("is-selected", nextValue !== "auto");
      if (selectEl) selectEl.value = nextValue;
    };

    if (!animate) {
      commitCycleVisual(container, opt.val, opt.label, opt.cls, syncForm);
      return;
    }

    rotateCycleCrosshair(container);
    animateCycleVisual(container, opt.val, opt.label, opt.cls, syncForm);
  }

  function __clampLgBhop(rawValue) {
    const n = Number(rawValue);
    if (!Number.isFinite(n)) return 0;
    const clamped = Math.max(0, Math.min(1000, Math.round(n)));
    return Math.round(clamped / 100) * 100;
  }

  function __clampLgBhopEnabled(rawValue) {
    const ms = __clampLgBhop(rawValue);
    return ms <= 0 ? 100 : ms;
  }

  let __pendingOnboardMemoryAutoEnableCheck = false;

  function __armOnboardMemoryAutoEnableCheck() {
    __pendingOnboardMemoryAutoEnableCheck = !!hasFeature("autoEnableOnboardMemoryOnConnect");
  }

  function __clearOnboardMemoryAutoEnableCheck() {
    __pendingOnboardMemoryAutoEnableCheck = false;
  }

  function __getOnboardMemoryDisableConfirmText() {
    const text = String(adapter?.ui?.onboardMemoryDisableConfirmText || "").trim();
    return text || "是否关闭板载内存模式，关闭后驱动设置不保证可用";
  }

  function __tryAutoEnableOnboardMemoryByConfig(cfg) {
    if (!__pendingOnboardMemoryAutoEnableCheck) return;
    __pendingOnboardMemoryAutoEnableCheck = false;
    if (!hasFeature("autoEnableOnboardMemoryOnConnect")) return;
    const onboardMemoryMode = readStandardValue(cfg, "onboardMemoryMode");
    if (onboardMemoryMode == null || !!onboardMemoryMode) return;
    enqueueDevicePatch({ onboardMemoryMode: true });
    log("检测到板载内存模式未开启，已自动开启。");
  }

  function syncLogitechAdvancedUi() {
    const surfaceModeSelect = document.getElementById("lgSurfaceModeSelect");
    if (surfaceModeSelect) {
      updateLgSurfaceModeCycleUI(surfaceModeSelect.value, false);
    }

    const bhopToggle = document.getElementById("lgBhopToggle");
    const bhopInput = document.getElementById("lgBhopInput");
    const bhopValue = document.getElementById("lgBhopValue");
    const bhopCard = document.getElementById("lgBhopSliderCard");
    const bhopBar = document.getElementById("lgBhopBar");
    if (!bhopInput || !bhopValue) return;
    const enabled = !!bhopToggle?.checked;
    const sliderMs = __clampLgBhopEnabled(bhopInput.value);
    if (String(sliderMs) !== String(bhopInput.value)) bhopInput.value = String(sliderMs);
    bhopInput.disabled = !enabled;
    if (bhopCard) bhopCard.classList.toggle("is-disabled", !enabled);
    const shownMs = enabled ? sliderMs : 0;
    bhopValue.textContent = String(shownMs);

    if (bhopBar) {
      const min = parseFloat(bhopInput.min) || 100;
      const max = parseFloat(bhopInput.max) || 1000;
      const pct = enabled && max > min
        ? Math.max(0, Math.min(1, (sliderMs - min) / (max - min)))
        : 0;
      const minW = 4;
      const maxW = 100;
      const widthPx = minW + (pct * (maxW - minW));
      bhopBar.style.width = `${widthPx}px`;
    }
  }

  function initLogitechAdvancedUi() {
    if (__logitechAdvancedUiInited) return;
    const root = document.getElementById("advancedLogitechColumn");
    if (!root) return;
    __logitechAdvancedUiInited = true;

    const onboardMemoryToggle = document.getElementById("lgOnboardMemoryToggle");
    const lightforceToggle = document.getElementById("lgLightforceToggle");
    const surfaceModeCycle = document.getElementById("lgSurfaceModeCycle");
    const surfaceModeSelect = document.getElementById("lgSurfaceModeSelect");
    const bhopToggle = document.getElementById("lgBhopToggle");
    const bhopInput = document.getElementById("lgBhopInput");

    if (surfaceModeSelect && !surfaceModeSelect.value) {
      surfaceModeSelect.value = "auto";
    }

    if (onboardMemoryToggle) {
      onboardMemoryToggle.addEventListener("change", () => {
        if (!hasFeature("hasOnboardMemoryMode")) return;
        const nextMode = !!onboardMemoryToggle.checked;
        if (!nextMode && hasFeature("warnOnDisableOnboardMemoryMode")) {
          const ok = confirm(__getOnboardMemoryDisableConfirmText());
          if (!ok) {
            onboardMemoryToggle.checked = true;
            return;
          }
        }
        enqueueDevicePatch({ onboardMemoryMode: nextMode });
      });
    }

    if (lightforceToggle) {
      lightforceToggle.addEventListener("change", () => {
        if (!hasFeature("hasLightforceSwitch")) return;
        enqueueDevicePatch({ lightforceSwitch: lightforceToggle.checked ? "optical" : "hybrid" });
      });
    }

    if (surfaceModeCycle && surfaceModeSelect) {
      const cycleSurfaceMode = () => {
        const current = __normalizeLgSurfaceMode(surfaceModeSelect.value || surfaceModeCycle.dataset.value);
        const curIdx = LG_SURFACE_MODE_OPTS.findIndex((item) => item.val === current);
        const nextOpt = LG_SURFACE_MODE_OPTS[(curIdx + 1 + LG_SURFACE_MODE_OPTS.length) % LG_SURFACE_MODE_OPTS.length];
        updateLgSurfaceModeCycleUI(nextOpt.val, true);
        if (!hasFeature("hasSurfaceMode")) return;
        enqueueDevicePatch({ surfaceMode: nextOpt.val });
      };

      surfaceModeCycle.addEventListener("click", cycleSurfaceMode);
      surfaceModeCycle.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          cycleSurfaceMode();
        }
      });
      surfaceModeSelect.addEventListener("change", () => {
        updateLgSurfaceModeCycleUI(surfaceModeSelect.value, false);
      });
    }

    if (bhopInput) {
      const commitBhop = () => {
        const enabled = !!bhopToggle?.checked;
        const nextMs = enabled ? __clampLgBhopEnabled(bhopInput.value) : 0;
        if (enabled) bhopInput.value = String(nextMs);
        syncLogitechAdvancedUi();
        if (!hasFeature("hasBhopDelay")) return;
        enqueueDevicePatch({ bhopMs: nextMs });
      };
      bhopInput.addEventListener("input", () => {
        if (!bhopToggle?.checked) return;
        syncLogitechAdvancedUi();
      });
      bhopInput.addEventListener("change", commitBhop);
      bhopInput.addEventListener("pointerup", commitBhop);
      bhopInput.addEventListener("touchend", commitBhop);
      bhopToggle?.addEventListener("change", () => {
        if (bhopToggle.checked) bhopInput.value = String(__clampLgBhopEnabled(bhopInput.value));
        commitBhop();
      });
    }

    syncLogitechAdvancedUi();
  }

  /**
   * 初始化advanced、panel。
   * 目的：集中初始化与事件绑定，避免重复绑定或顺序问题。
   * @returns {any} 返回结果。
   */
  function initAdvancedPanelUI() {
    if (__advancedPanelInited) return;
    const root = document.getElementById("advancedPanel");
    if (!root) return;
    __advancedPanelInited = true;

    const sleepSel = document.getElementById("sleepSelect");
    const sleepInput = document.getElementById("sleepInput");
    const sleepDisp = document.getElementById("sleep_disp");

    const debounceSel = document.getElementById("debounceSelect");
    const debounceInput = document.getElementById("debounceInput");
    const debounceDisp = document.getElementById("debounce_disp");


    if (sleepInput) {
      sleepInput.addEventListener("input", () => {
        const opts = __optList(sleepSel);
        const idx = __clamp(Number(sleepInput.value) || 0, 0, Math.max(0, opts.length - 1));
        const o = opts[idx] || { val: sleepSel?.value ?? "", rawLabel: "" };
        if (sleepDisp) {
          sleepDisp.textContent = __formatSleepLabel(o.val, o.rawLabel);
          sleepDisp.setAttribute('data-unit', __getSleepUnit(o.val));
        }

        updateSleepFins();
      });
      sleepInput.addEventListener("change", () => {
        const opts = __optList(sleepSel);
        const idx = __clamp(Number(sleepInput.value) || 0, 0, Math.max(0, opts.length - 1));
        const o = opts[idx];
        if (sleepSel && o) {
          sleepSel.value = String(o.val);
          sleepSel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        syncAdvancedPanelUi();
      });
    }

    if (debounceInput) {
      debounceInput.addEventListener("input", () => {
        const opts = __optList(debounceSel);
        const idx = __clamp(Number(debounceInput.value) || 0, 0, Math.max(0, opts.length - 1));
        const o = opts[idx] || { val: debounceSel?.value ?? "", rawLabel: "" };
        if (debounceDisp) debounceDisp.textContent = __formatDebounceLabel(o.val, o.rawLabel);


        const debounceBar = document.getElementById("debounceBar");
        if (debounceBar) {
          const val = parseFloat(debounceInput.value) || 0;
          const min = parseFloat(debounceInput.min) || 0;
          const max = parseFloat(debounceInput.max) || 10;


          let pct = (val - min) / (max - min);
          if (isNaN(pct)) pct = 0;
          if (max === min) pct = 0;


          const minW = 4;
          const maxW = 100;
          const widthPx = minW + (pct * (maxW - minW));

          debounceBar.style.width = `${widthPx}px`;
        }
      });
      debounceInput.addEventListener("change", () => {
        const opts = __optList(debounceSel);
        const idx = __clamp(Number(debounceInput.value) || 0, 0, Math.max(0, opts.length - 1));
        const o = opts[idx];
        if (debounceSel && o) {
          debounceSel.value = String(o.val);
          debounceSel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        syncAdvancedPanelUi();
      });
    }


    sleepSel?.addEventListener("change", syncAdvancedPanelUi);
    debounceSel?.addEventListener("change", syncAdvancedPanelUi);


    const angleInput = document.getElementById("angleInput");
    const feelInput = document.getElementById("feelInput");
    angleInput?.addEventListener("input", syncAdvancedPanelUi);
    feelInput?.addEventListener("input", syncAdvancedPanelUi);


    syncAdvancedPanelUi();
  }


  sidebarItems.forEach(item => {
      item.addEventListener('click', () => {
          const key = item.getAttribute("data-key");
          if (!key) return;
          markNavSwitching();
          location.hash = "#" + key;
      });
  });


  function onHashChange() {
    setActiveByHash(true);
  }
  window.removeEventListener("hashchange", onHashChange);
  window.addEventListener("hashchange", onHashChange);
  setActiveByHash();
  initBasicMonolithUI();
  initAdvancedPanelUI();
  initLogitechAdvancedUi();


  $("#profileBtn")?.addEventListener("click", () => {
    location.hash = "#keys";
  });


  const logBox = $("#logBox");
  /**
   * 记录逻辑。
   * 目的：统一日志输出，便于问题追踪。
   * @param {any} args - 参数 args。
   * @returns {any} 返回结果。
   */
  function log(...args) {
    const line = args
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
      .join(" ");
    const ts = new Date().toLocaleTimeString();


    if (logBox) {
      logBox.textContent += `[${ts}] ${line}\n`;
      logBox.scrollTop = logBox.scrollHeight;
    } else {

      console.log(`[${ts}] ${line}`);
    }
  }
  /**
   * 记录err。
   * 目的：统一日志输出，便于问题追踪。
   * @param {any} err - 参数 err。
   * @param {any} prefix - 参数 prefix。
   * @returns {any} 返回结果。
   */
  function logErr(err, prefix = "错误") {
    const msg = err?.message || String(err);
    log(`${prefix}: ${msg}`);
    console.error(err);
  }


  $("#btnCopyLogs")?.addEventListener("click", async () => {
    try {
      if (logBox) {
        await navigator.clipboard.writeText(logBox.textContent || "");
        log("日志已复制到剪贴板");
      }
    } catch (e) {
      logErr(e, "复制失败");
    }
  });

  $("#btnClearLogs")?.addEventListener("click", () => {
    if (logBox) logBox.textContent = "";
  });


  try { await DeviceRuntime?.whenProtocolReady?.(); } catch (e) {}
  const ProtocolApi = window.ProtocolApi;
  if (!ProtocolApi) {
    log("未找到 ProtocolApi：请确认 protocol_api_chaos.js / protocol_api_rapoo.js / protocol_api_logitech.js 已正确加载。");
    return;
  }


  let hidApi = window.__HID_API_INSTANCE__;
  if (!hidApi) {
    hidApi = new ProtocolApi.MouseMouseHidApi();
    window.__HID_API_INSTANCE__ = hidApi;
  }

  let __cachedDeviceConfig = null;
  async function requestDeviceConfig() {
    try {
      const reader = window.DeviceReader;
      if (typeof reader?.requestConfig === "function") {
        return !!(await reader.requestConfig({ hidApi, adapter }));
      }
      if (typeof hidApi?.requestConfig === "function") {
        await hidApi.requestConfig();
        return true;
      }
    } catch (_) {
      return false;
    }
    return false;
  }
  function getCachedDeviceConfig() {
    const reader = window.DeviceReader;
    if (typeof reader?.getCachedConfig === "function") {
      const cfg = reader.getCachedConfig({ hidApi, adapter });
      if (cfg && typeof cfg === "object") return cfg;
    }
    return (__cachedDeviceConfig && typeof __cachedDeviceConfig === "object")
      ? __cachedDeviceConfig
      : null;
  }


  if (!window.__HID_UNLOAD_HOOKED__) {
    window.__HID_UNLOAD_HOOKED__ = true;

    /**
     * 安全关闭逻辑。
     * 目的：集中控制可见性或开关状态，避免多处直接修改。
     * @returns {any} 返回结果。
     */
    const safeClose = () => {
      try { void window.__HID_API_INSTANCE__?.close(); } catch (_) {}
    };

    window.addEventListener("beforeunload", safeClose);

    window.addEventListener("pagehide", safeClose);
  }


  let __lastConfigRequestAt = 0;


  let __writesEnabled = false;


  let __firstConfigAppliedResolve = null;
  let __firstConfigAppliedPromise = Promise.resolve();
  let __firstConfigAppliedDone = false;

/**
 * 内部重置配置。
 * 目的：统一处理配置相关流程，保证行为一致。
 * @returns {any} 返回结果。
 */
function __resetFirstConfigAppliedGate() {
  __firstConfigAppliedDone = false;
  __firstConfigAppliedPromise = new Promise((resolve) => { __firstConfigAppliedResolve = resolve; });
}

/**
 * 内部等待for、refresh。
 * 目的：封装等待与超时处理，避免监听悬挂。
 * @returns {Promise<any>} 异步结果。
 */
async function __waitForUiRefresh() {

  await new Promise((r) => requestAnimationFrame(() => r()));
  await new Promise((r) => requestAnimationFrame(() => r()));
}


/**
 * 请求配置。
 * 目的：封装请求与异常处理，保证行为一致。
 * @param {any} reason - 参数 reason。
 * @returns {Promise<any>} 异步结果。
 */
async function requestConfigOnce(reason = "") {
  if (!isHidOpened()) return;
  const now = Date.now();

  if (now - __lastConfigRequestAt < 800) return;
  __lastConfigRequestAt = now;


  if (!(await requestDeviceConfig())) {

    log("当前 ProtocolApi 未暴露配置读取接口，无法读取设备配置。");
    return;
  }

  try {
    if (reason) log(`已请求配置(${reason})`);


    await requestBatterySafe("config");
  } catch (e) {
    logErr(e, "请求配置失败");
  }
}


hidApi.onConfig((cfg) => {
  try {
    if (cfg && typeof cfg === "object") __cachedDeviceConfig = cfg;
    const cfgDeviceName = String(cfg?.deviceName || "").trim();
    if (cfgDeviceName) currentDeviceName = cfgDeviceName;
    __applyDeviceVariantOnce({ deviceName: cfgDeviceName || currentDeviceName, cfg, keymapOnly: true });
    applyConfigToUi(cfg);

    hidLinked = true;


    __writesEnabled = true;
    __tryAutoEnableOnboardMemoryByConfig(cfg);


    if (!__firstConfigAppliedDone && typeof __firstConfigAppliedResolve === "function") {
      __firstConfigAppliedDone = true;
      try { __firstConfigAppliedResolve(cfg); } catch (_) {}
    }

  } catch (e) {
    logErr(e, "应用配置失败");
  }
});


  /**
   * 处理HID、设备逻辑。
   * 目的：统一处理HID、设备相关流程，保证行为一致。
   * @param {any} dev - 参数 dev。
   * @returns {any} 返回结果。
   */
  const saveLastHidDevice = (dev) => {
    try { DeviceRuntime?.saveLastHidDevice?.(dev); } catch (_) {}
  };


  /**
   * 执行一次自动连接探测。
   * 目的：复用已授权设备句柄，提高自动连接成功率。
   * @returns {Promise<any>} 异步结果。
   */
  async function autoConnectHidOnce() {
    if (!navigator.hid) return null;
    if (hidConnecting || __connectInFlight) return null;
    if (isHidOpened()) return null;

    let picked = null;
    try {
      const res = await DeviceRuntime?.autoConnect?.({
        preferredType: DeviceRuntime?.getSelectedDevice?.(),
      });
      picked = res?.device || null;
    } catch (_) {}

    __autoDetectedDevice = picked;


    if (picked) {
      document.body.classList.add("landing-has-device");
      const name = ProtocolApi.resolveMouseDisplayName(
        picked.vendorId,
        picked.productId,
        picked.productName || "HID Device"
      );
      __setLandingCaption(`Detected: ${name}`);
    } else {
      document.body.classList.remove("landing-has-device");
      __setLandingCaption("stare into the void to connect");
    }

    return picked;
  }


  const hdrHid = $("#hdrHid");
  const hdrHidVal = $("#hdrHidVal");
  const hdrBattery = $("#hdrBattery");
  const hdrBatteryVal = $("#hdrBatteryVal");
  const hdrFw = $("#hdrFw");
  const hdrFwVal = $("#hdrFwVal");


  /**
   * 设置header、chips。
   * 目的：提供统一读写入口，降低耦合。
   * @param {any} visible - 参数 visible。
   * @returns {any} 返回结果。
   */
  function setHeaderChipsVisible(visible) {
    [hdrBattery, hdrHid, hdrFw].forEach((el) => {
      if (!el) return;
      el.style.display = visible ? "" : "none";
    });
  }

  /**
   * 重置header、chip。
   * 目的：统一处理header、chip相关流程，保证行为一致。
   * @returns {any} 返回结果。
   */
  function resetHeaderChipValues() {
    if (hdrHidVal) {
      hdrHidVal.textContent = "";
      hdrHidVal.classList.remove("connected");
    }
    if (hdrBatteryVal) {
      hdrBatteryVal.textContent = "";
      hdrBatteryVal.classList.remove("connected");
    }
    if (hdrFwVal) {
      hdrFwVal.textContent = "";
      hdrFwVal.classList.remove("connected");
    }
  }

  /**
   * 格式化固件。
   * 目的：统一展示格式，减少格式分散。
   * @param {any} fwText - 参数 fwText。
   * @returns {any} 返回结果。
   */
  function formatFwForChip(fwText) {
    if (!fwText) return "-";

    return fwText
      .replace("Mouse:", "Mouse ")
      .replace("RX:", "RX ")
      .replace(/\s+/g, " ")
      .trim();
  }


  resetHeaderChipValues();
  setHeaderChipsVisible(false);

  const dpiList = $("#dpiList");
  const dpiMinSelect = $("#dpiMinSelect");
  const dpiMaxSelect = $("#dpiMaxSelect");
  const dpiAdvancedToggle = $("#dpiAdvancedToggle");
  const dpiAdvancedTitleHint = $("#dpiAdvancedTitleHint");

  const DPI_ABS_MIN = 100;
  const DPI_ABS_MAX = 44000;
  const DPI_MIN_DEFAULT = 100;
  const DPI_MAX_DEFAULT = 8000;
  let DPI_UI_MAX = 26000;
  let DPI_STEP = Math.max(1, Number(adapter?.ranges?.dpi?.step) || 50);


let __capabilities = {
  dpiSlotCount: 6,
  maxDpi: DPI_UI_MAX,
  dpiStep: DPI_STEP,
  pollingRates: null,
};

/**
 * 获取能力。
 * 目的：提供统一读写入口，降低耦合。
 * @returns {any} 返回结果。
 */
function getCapabilities() {
  return __capabilities || {};
}

function resolveRuntimeDpiAdapter() {
  const runtimeDeviceId = window.DeviceRuntime?.getSelectedDevice?.() || DEVICE_ID;
  return window.DeviceAdapters?.getAdapter?.(runtimeDeviceId) || adapter;
}

function resolveRuntimeDpiStep(fallbackStep = 50) {
  const runtimeAdapter = resolveRuntimeDpiAdapter();
  const raw = Number(runtimeAdapter?.ranges?.dpi?.step ?? fallbackStep);
  if (!Number.isFinite(raw) || raw <= 0) return 50;
  return Math.max(1, Math.trunc(raw));
}

/**
 * 获取DPI、槽位。
 * 目的：保持 DPI 数值与槽位状态一致，避免错位或跳变。
 * @returns {any} 返回结果。
 */
function getDpiSlotCap() {
  const n = Number(getCapabilities().dpiSlotCount);
  return Math.max(1, Number.isFinite(n) ? Math.trunc(n) : 6);
}

/**
 * 钳制槽位、能力。
 * 目的：限制数值边界，防止越界。
 * @param {any} n - 参数 n。
 * @param {any} fallback - 参数 fallback。
 * @returns {any} 返回结果。
 */
function clampSlotCountToCap(n, fallback = 6) {
  const cap = getDpiSlotCap();
  const v = Number(n);
  const vv = Number.isFinite(v) ? Math.trunc(v) : fallback;
  return Math.max(1, Math.min(cap, vv));
}


/**
 * 应用能力开关到 UI。
 * 目的：按设备能力控制 UI 可用性，避免无效操作。
 * @param {any} cap - 参数 cap。
 * @returns {any} 返回结果。
 */
function applyCapabilitiesToUi(cap) {
  const incoming = (cap && typeof cap === "object") ? cap : {};
  const prevCap = getCapabilities();
  const runtimeStep = Number(resolveRuntimeDpiStep(DPI_STEP));
  const fallbackStep = Number(
    Number.isFinite(runtimeStep) && runtimeStep > 0
      ? runtimeStep
      : (prevCap?.dpiStep ?? DPI_STEP)
  );
  const incomingStep = Number(incoming.dpiStep);
  const dpiStep = Number.isFinite(incomingStep) && incomingStep > 0
    ? Math.max(1, Math.trunc(incomingStep))
    : (Number.isFinite(fallbackStep) && fallbackStep > 0 ? Math.max(1, Math.trunc(fallbackStep)) : 50);


  const next = {
    dpiSlotCount: Number.isFinite(Number(incoming.dpiSlotCount)) ? Math.trunc(Number(incoming.dpiSlotCount)) : (prevCap.dpiSlotCount ?? 6),
    maxDpi: Number.isFinite(Number(incoming.maxDpi)) ? Math.trunc(Number(incoming.maxDpi)) : (prevCap.maxDpi ?? DPI_UI_MAX),
    dpiStep,
    pollingRates: Array.isArray(incoming.pollingRates)
      ? incoming.pollingRates.map(Number).filter(Number.isFinite)
      : (prevCap.pollingRates ?? null),
  };

  __capabilities = next;
  DPI_STEP = dpiStep;


  if (Number.isFinite(next.maxDpi) && next.maxDpi > 0) {
    DPI_UI_MAX = next.maxDpi;


    DPI_MAX_OPTIONS = buildDpiMaxOptions(DPI_UI_MAX);

    if (dpiMaxSelect) {
      const current = Number(dpiMaxSelect.value || DPI_MAX_DEFAULT);
      const wanted = Math.min(current || DPI_MAX_DEFAULT, DPI_UI_MAX);
      const defVal = DPI_MAX_OPTIONS.includes(wanted)
        ? wanted
        : (DPI_MAX_OPTIONS.includes(DPI_MAX_DEFAULT)
          ? DPI_MAX_DEFAULT
          : DPI_MAX_OPTIONS[DPI_MAX_OPTIONS.length - 1]);
      fillSelect(dpiMaxSelect, DPI_MAX_OPTIONS, defVal);
    }
    normalizeDpiMinMax();
    applyDpiRangeToRows();
  }


  const capSlots = getDpiSlotCap();
  const slotSel = $("#slotCountSelect");
  if (slotSel) {
    const cur = Number(slotSel.value || capSlots);
    slotSel.innerHTML = Array.from({ length: capSlots }, (_, i) => {
      const v = i + 1;
      return `<option value="${v}">${v}</option>`;
    }).join("");
    safeSetValue(slotSel, clampSlotCountToCap(cur, capSlots));
  }


  const applyPollingRatesToSelect = (selectEl) => {
    if (!selectEl) return null;
    const cur = Number(selectEl.value || next.pollingRates[0]);
    selectEl.innerHTML = next.pollingRates
      .map((hz) => `<option value="${hz}">${hz}Hz</option>`)
      .join("");
    let validVal = cur;
    if (!next.pollingRates.includes(cur)) {
      validVal = next.pollingRates.includes(1000) ? 1000 : next.pollingRates[0];
    }
    safeSetValue(selectEl, validVal);
    return validVal;
  };

  const pollingSel = $("#pollingSelect");
  const pollingWirelessSel = $("#pollingSelectWireless");
  if (Array.isArray(next.pollingRates) && next.pollingRates.length && !__isDualPollingRates) {
    applyPollingRatesToSelect(pollingSel);
    applyPollingRatesToSelect(pollingWirelessSel);
    __refreshBasicItemRefs();

    const hasRightCol = !!(__basicHzItems && __basicHzItems.length);
    const hasLeftDualCol = __isDualPollingRates && !!(__basicModeItems && __basicModeItems.length);
    if (hasRightCol || hasLeftDualCol) {
      const allowed = new Set(next.pollingRates.map(String));

      if (hasRightCol) {
        __basicHzItems.forEach((el) => {
          const h = el.dataset.hz;
          el.style.display = allowed.has(String(h)) ? "" : "none";
        });
      }

      if (hasLeftDualCol) {
        __basicModeItems.forEach((el) => {
          const h = el.dataset.hz;
          el.style.display = allowed.has(String(h)) ? "" : "none";
        });
      }

      syncBasicMonolithUI();
    }
  }


  if (typeof buildDpiEditor === "function") {
    const needRebuild = (Number(prevCap?.dpiSlotCount) || 6) !== capSlots;
    if (needRebuild) buildDpiEditor();
  }
  if (!hasDpiAdvancedAxis()) dpiAdvancedEnabled = false;
  applyDpiAdvancedUiState();
}


  const DPI_MIN_OPTIONS = [100, 400, 800, 1200, 1600, 1800];
  const DPI_MAX_PRESET_OPTIONS = [2000, 4000, 8000, 12000, 18000, 26000];


  /**
   * 生成seq。
   * 目的：统一处理seq相关流程，保证行为一致。
   * @param {any} start - 参数 start。
   * @param {any} end - 参数 end。
   * @param {any} step - 参数 step。
   * @returns {any} 返回结果。
   */
  function buildDpiMaxOptions(maxDpi) {
    const upper = Math.max(2000, Math.trunc(Number(maxDpi) || 26000));
    const capUpper = Math.min(26000, upper);
    const out = Array.from(new Set(
      DPI_MAX_PRESET_OPTIONS
        .map((v) => Math.trunc(Number(v)))
        .filter((v) => Number.isFinite(v) && v >= 2000 && v <= capUpper)
    )).sort((a, b) => a - b);
    return out.length ? out : [2000];
  }

  let DPI_MAX_OPTIONS = buildDpiMaxOptions(DPI_UI_MAX);

  /**
   * 填充逻辑。
   * 目的：统一选项构建与应用，避免选项与值不匹配。
   * @param {any} el - 参数 el。
   * @param {any} values - 参数 values。
   * @param {any} defVal - 参数 defVal。
   * @returns {any} 返回结果。
   */
  function fillSelect(el, values, defVal) {
    if (!el) return;
    el.innerHTML = values
      .map((v) => `<option value="${v}">${v}</option>`)
      .join("");
    safeSetValue(el, defVal);
  }

  /**
   * 获取DPI。
   * 目的：保持 DPI 数值与槽位状态一致，避免错位或跳变。
   * @returns {any} 返回结果。
   */
  function getDpiMinMax() {
    const min = Number(dpiMinSelect?.value ?? 100);

    const max = Number(dpiMaxSelect?.value ?? DPI_UI_MAX);
    return { min, max };
  }

  function getDpiStep() {
    const capStep = Number(getCapabilities().dpiStep);
    if (Number.isFinite(capStep) && capStep > 0) return Math.max(1, Math.trunc(capStep));
    if (Number.isFinite(DPI_STEP) && DPI_STEP > 0) return Math.max(1, Math.trunc(DPI_STEP));
    return 50;
  }

  function snapDpiValueToStep(rawValue, min, max, stepOverride) {
    const stepRaw = Number(stepOverride);
    const step = Number.isFinite(stepRaw) && stepRaw > 0 ? stepRaw : getDpiStep();
    const clampedVal = clamp(rawValue, min, max);
    const snapped = min + Math.round((clampedVal - min) / step) * step;
    return clamp(snapped, min, max);
  }

  function snapDpiPairByAdapter({ slot, axis, x, y, min, max }) {
    const runtimeAdapter = resolveRuntimeDpiAdapter();
    const step = getDpiStep();
    const fallbackX = snapDpiValueToStep(x, min, max, step);
    const fallbackY = snapDpiValueToStep(y, min, max, step);
    const snapper = runtimeAdapter?.dpiSnapper;
    if (typeof snapper !== "function") {
      return { x: fallbackX, y: fallbackY };
    }
    try {
      const snapped = snapper({
        slot,
        axis,
        x,
        y,
        min,
        max,
        step,
        state: {
          slotCount: getSlotCountUi(),
          activeSlot: uiCurrentDpiSlot,
        },
      }) || {};
      const sx = Number(snapped.x);
      const sy = Number(snapped.y);
      return {
        x: Number.isFinite(sx) ? clamp(sx, min, max) : fallbackX,
        y: Number.isFinite(sy) ? clamp(sy, min, max) : fallbackY,
      };
    } catch (_) {
      return { x: fallbackX, y: fallbackY };
    }
  }

  /**
   * 处理DPI逻辑。
   * 目的：保持 DPI 数值与槽位状态一致，避免错位或跳变。
   * @returns {any} 返回结果。
   */
  function normalizeDpiMinMax() {
    if (!dpiMinSelect || !dpiMaxSelect) return;
    let { min, max } = getDpiMinMax();
    const dpiStep = getDpiStep();


    if (!Number.isFinite(max) || max <= 0) max = DPI_UI_MAX;
    max = Math.max(2000, Math.min(DPI_UI_MAX, max));


    if (!Number.isFinite(min) || min <= 0) min = 100;


    const minCap = max - dpiStep;


    min = Math.max(DPI_ABS_MIN, Math.min(min, minCap));


    if (min >= max) {
       max = min + dpiStep;

       if (max > DPI_UI_MAX) {
          max = DPI_UI_MAX;
          min = max - dpiStep;
       }
    }


    safeSetValue(dpiMinSelect, min);

    safeSetValue(dpiMaxSelect, max);
  }

  /**
   * 应用DPI、范围。
   * 目的：保持 DPI 数值与槽位状态一致，避免错位或跳变。
   * @returns {any} 返回结果。
   */
  function applyDpiRangeToRows() {
    const { min, max } = getDpiMinMax();
    const dpiStep = getDpiStep();
    for (let i = 1; i <= getDpiSlotCap(); i++) {
      const controls = [
        $("#dpiRange" + i),
        $("#dpiInput" + i),
        $("#dpiRangeX" + i),
        $("#dpiInputX" + i),
        $("#dpiRangeY" + i),
        $("#dpiInputY" + i),
      ];
      for (const ctrl of controls) {
        if (!ctrl) continue;
        ctrl.min = String(min);
        ctrl.max = String(max);
        ctrl.step = String(dpiStep);
      }
      const xVal = setUiDpiAxisValue(i, "x", getUiDpiAxisValue(i, "x", min));
      const yVal = setUiDpiAxisValue(i, "y", getUiDpiAxisValue(i, "y", xVal));
      syncDpiRowInputs(i);
    }
  }

  /**
   * 钳制逻辑。
   * 目的：限制数值边界，防止越界。
   * @param {any} v - 参数 v。
   * @param {any} min - 参数 min。
   * @param {any} max - 参数 max。
   * @returns {any} 返回结果。
   */
  function clamp(v, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  function hasDpiAdvancedAxis() {
    return hasFeature("hasDpiAdvancedAxis");
  }

  function isDpiAdvancedUiEnabled() {
    return hasDpiAdvancedAxis() && !!dpiAdvancedEnabled;
  }

  function getUiDpiAxisValue(slot, axis, fallback = 800) {
    const idx = Math.max(0, Number(slot) - 1);
    const source = axis === "y" ? uiDpiSlotsY : uiDpiSlotsX;
    const val = Number(source?.[idx]);
    if (Number.isFinite(val)) return val;
    return fallback;
  }

  function setUiDpiAxisValue(slot, axis, rawValue) {
    const idx = Math.max(0, Number(slot) - 1);
    const { min, max } = getDpiMinMax();
    const safe = clamp(rawValue, min, max);
    if (axis === "y") uiDpiSlotsY[idx] = safe;
    else uiDpiSlotsX[idx] = safe;
    return safe;
  }

  function setUiDpiSingleValue(slot, rawValue) {
    const safeX = setUiDpiAxisValue(slot, "x", rawValue);
    const safeY = setUiDpiAxisValue(slot, "y", rawValue);
    return { x: safeX, y: safeY };
  }

  function normalizeUiDpiLod(value, fallback = "mid") {
    const lod = String(value || "").trim().toLowerCase();
    if (lod === "low") return "low";
    if (lod === "mid" || lod === "middle" || lod === "medium") return "mid";
    if (lod === "high") return "high";
    return fallback;
  }

  function getUiDpiLod(slot, fallback = "mid") {
    const idx = Math.max(0, Number(slot) - 1);
    return normalizeUiDpiLod(uiDpiLods?.[idx], fallback);
  }

  function setUiDpiLod(slot, value) {
    const idx = Math.max(0, Number(slot) - 1);
    const safe = normalizeUiDpiLod(value, "mid");
    uiDpiLods[idx] = safe;
    return safe;
  }

  function buildUiDpiLodsPayload() {
    const out = [];
    const dpiSlotCap = getDpiSlotCap();
    for (let i = 1; i <= dpiSlotCap; i++) {
      out.push(getUiDpiLod(i, "mid"));
    }
    return out;
  }

  function syncDpiLodRow(slot) {
    const row = dpiList?.querySelector?.(`.dpiSlotRow[data-slot="${slot}"]`);
    if (!row) return;
    const wrap = row.querySelector(".dpiLodSwitch");
    if (!wrap) return;
    const current = getUiDpiLod(slot, "mid");
    const buttons = wrap.querySelectorAll("button.dpiLodBtn");
    buttons.forEach((btn) => {
      const lod = normalizeUiDpiLod(btn.dataset.lod, "");
      const active = lod === current;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function syncDpiRowInputs(slot) {
    const xVal = getUiDpiAxisValue(slot, "x", 100);
    const yVal = getUiDpiAxisValue(slot, "y", xVal);
    const singleVal = xVal;

    const singleInput = $("#dpiInput" + slot);
    const singleRange = $("#dpiRange" + slot);
    const xInput = $("#dpiInputX" + slot);
    const xRange = $("#dpiRangeX" + slot);
    const yInput = $("#dpiInputY" + slot);
    const yRange = $("#dpiRangeY" + slot);

    if (singleInput) safeSetValue(singleInput, singleVal);
    if (singleRange) safeSetValue(singleRange, singleVal);
    if (xInput) safeSetValue(xInput, xVal);
    if (xRange) safeSetValue(xRange, xVal);
    if (yInput) safeSetValue(yInput, yVal);
    if (yRange) safeSetValue(yRange, yVal);
    syncDpiLodRow(slot);
  }

  function collectDpiAxisMismatchSlots(slotCountOverride) {
    const slotCount = clampSlotCountToCap(
      Number(slotCountOverride ?? getDpiSlotCap()),
      getDpiSlotCap()
    );
    const out = [];
    for (let i = 1; i <= slotCount; i++) {
      const xVal = Number(getUiDpiAxisValue(i, "x", NaN));
      const yVal = Number(getUiDpiAxisValue(i, "y", xVal));
      if (!Number.isFinite(xVal) || !Number.isFinite(yVal)) continue;
      if (xVal !== yVal) out.push(i);
    }
    return out;
  }

  async function syncDpiSlotsToSingleAxisIfNeeded(slotCountOverride) {
    if (!hasDpiAdvancedAxis()) return;
    const mismatchSlots = collectDpiAxisMismatchSlots(slotCountOverride);
    if (!mismatchSlots.length) return;

    for (const slot of mismatchSlots) {
      const xVal = getUiDpiAxisValue(slot, "x", 800);
      setUiDpiAxisValue(slot, "y", xVal);
      syncDpiRowInputs(slot);
      updateDpiBubble(slot);
    }

    if (!isHidReady()) return;
    dpiSyncingToSingleMode = true;
    try {
      await withMutex(async () => {
        for (const slot of mismatchSlots) {
          const xVal = getUiDpiAxisValue(slot, "x", 800);
          await hidApi.setDpi(slot, { x: xVal, y: xVal }, {
            select: slot === uiCurrentDpiSlot,
          });
        }
      });
    } catch (err) {
      logErr(err, "DPI 高级模式关闭同步失败");
    } finally {
      dpiSyncingToSingleMode = false;
    }
  }

  function applyDpiAdvancedUiState() {
    const canAdvanced = hasDpiAdvancedAxis();
    if (!canAdvanced) dpiAdvancedEnabled = false;
    const on = canAdvanced && dpiAdvancedEnabled;

    if (dpiList) {
      dpiList.classList.toggle("dpiAdvancedMode", on);
    }

    if (dpiAdvancedTitleHint) {
      dpiAdvancedTitleHint.classList.toggle("is-visible", on);
    }

    if (dpiAdvancedToggle) {
      dpiAdvancedToggle.disabled = !canAdvanced;
      dpiAdvancedToggle.setAttribute("aria-pressed", on ? "true" : "false");
      const stateEl = dpiAdvancedToggle.querySelector(".dpiAdvancedToggleState");
      if (stateEl) stateEl.textContent = on ? "开启" : "关闭";
    }
  }


  let uiCurrentDpiSlot = 1;
  let dpiAdvancedEnabled = false;
  let dpiAdvancedToggleBusy = false;
  let dpiSyncingToSingleMode = false;
  let uiDpiSlotsX = [];
  let uiDpiSlotsY = [];
  let uiDpiLods = [];
  let dpiAnimReady = false;


  let dpiBubbleListenersReady = false;
  let __dpiEditorDelegatesReady = false;
  let dpiDraggingSlot = null;
  let dpiDraggingEl = null;
  let dpiHoverRafId = 0;
  let dpiHoverPending = null;
  let dpiRangeSlotCache = new WeakMap();
  let dpiThumbSizeCache = new WeakMap();


  let dpiRowDragState = null;
  let dpiRowDragDirty = false;
  let dpiRowDragBlockClickUntil = 0;

  /**
   * 获取DPI、气泡提示。
   * 目的：保持 DPI 数值与槽位状态一致，避免错位或跳变。
   * @param {any} slot - 参数 slot。
   * @returns {any} 返回结果。
   */
  function getDpiBubble(slot) {
    return $("#dpiBubble" + slot);
  }

  /**
   * 获取DPI、槽位编号。
   * 目的：减少重复字符串解析，避免高频路径额外开销。
   * @param {any} range - 参数 range。
   * @returns {any} 返回结果。
   */
  function getDpiRangeSlot(range) {
    if (!range) return NaN;
    const cached = dpiRangeSlotCache.get(range);
    if (Number.isFinite(cached)) return cached;
    const slot = Number((range.id || "").replace(/\D+/g, ""));
    dpiRangeSlotCache.set(range, slot);
    return slot;
  }

  /**
   * 获取DPI、拇指尺寸。
   * 目的：缓存静态样式读取，降低 pointermove 期间布局与样式计算压力。
   * @param {any} range - 参数 range。
   * @returns {any} 返回结果。
   */
  function getDpiThumbSize(range) {
    if (!range) return 22;
    const cached = dpiThumbSizeCache.get(range);
    if (Number.isFinite(cached) && cached > 0) return cached;
    const cssThumb = parseFloat(getComputedStyle(range).getPropertyValue("--dpiThumb"));
    const thumb = Number.isFinite(cssThumb) && cssThumb > 0 ? cssThumb : 22;
    dpiThumbSizeCache.set(range, thumb);
    return thumb;
  }

  /**
   * 更新DPI、气泡提示。
   * 目的：保持 DPI 数值与槽位状态一致，避免错位或跳变。
   * @param {any} slot - 参数 slot。
   * @returns {any} 返回结果。
   */
  function getDpiBubbleRange(slot, preferredRange) {
    if (preferredRange?.isConnected) return preferredRange;
    const bubble = getDpiBubble(slot);
    const anchoredRange = bubble?._rangeEl;
    if (anchoredRange?.isConnected) return anchoredRange;

    const singleRange = $("#dpiRange" + slot);
    const xRange = $("#dpiRangeX" + slot);
    const yRange = $("#dpiRangeY" + slot);
    if (isDpiAdvancedUiEnabled()) return xRange || yRange || singleRange;
    return singleRange || xRange || yRange;
  }

  function updateDpiBubble(slot, preferredRange) {
    const range = getDpiBubbleRange(slot, preferredRange);
    const bubble = getDpiBubble(slot);
    if (!range || !bubble) return;
    bubble._rangeEl = range;

    const val = Number(range.value);
    const valEl = bubble.querySelector(".dpiBubbleVal");
    if (valEl) valEl.textContent = String(val);

    const min = Number(range.min);
    const max = Number(range.max);
    const denom = (max - min) || 1;
    const pct = (val - min) / denom;

    const rangeRect = range.getBoundingClientRect();


    const thumb = getDpiThumbSize(range);

    const trackW = rangeRect.width;
    const x = pct * Math.max(0, (trackW - thumb)) + thumb / 2;

    const pageX = rangeRect.left + x;
    const pageY = rangeRect.top + rangeRect.height / 2;


    const margin = 10;
    const clampedX = Math.max(margin, Math.min(window.innerWidth - margin, pageX));

    bubble.style.left = clampedX + "px";
    bubble.style.top = pageY + "px";


    bubble.classList.remove("flip");
    const bRect = bubble.getBoundingClientRect();
    if (bRect.top < 6) bubble.classList.add("flip");
  }

  /**
   * 显示DPI、气泡提示。
   * 目的：保持 DPI 数值与槽位状态一致，避免错位或跳变。
   * @param {any} slot - 参数 slot。
   * @returns {any} 返回结果。
   */
  function showDpiBubble(slot, preferredRange) {
    const bubble = getDpiBubble(slot);
    if (!bubble) return;
    if (preferredRange?.isConnected) bubble._rangeEl = preferredRange;
    if (!bubble.classList.contains("show")) bubble.classList.add("show");
    requestAnimationFrame(() => updateDpiBubble(slot, preferredRange));
  }

  /**
   * 隐藏DPI、气泡提示。
   * 目的：保持 DPI 数值与槽位状态一致，避免错位或跳变。
   * @param {any} slot - 参数 slot。
   * @returns {any} 返回结果。
   */
  function hideDpiBubble(slot) {
    const bubble = getDpiBubble(slot);
    if (!bubble) return;
    if (!bubble.classList.contains("show")) return;
    bubble._rangeEl = null;
    bubble.classList.remove("show");
  }

  /**
   * 更新DPI。
   * 目的：保持 DPI 数值与槽位状态一致，避免错位或跳变。
   * @returns {any} 返回结果。
   */
  function updateVisibleDpiBubbles() {
    for (let i = 1; i <= getDpiSlotCap(); i++) {
      const b = getDpiBubble(i);
      if (b?.classList.contains("show")) updateDpiBubble(i);
    }
  }


  /**
   * 获取槽位。
   * 目的：提供统一读写入口，降低耦合。
   * @returns {any} 返回结果。
   */
  function getSlotCountUi() {
    const el = $("#slotCountSelect");
    const n = Number(el?.value ?? getDpiSlotCap());
    return clampSlotCountToCap(n, getDpiSlotCap());
  }

  /**
   * 设置DPI、槽位。
   * 目的：保持 DPI 数值与槽位状态一致，避免错位或跳变。
   * @param {any} slot - 参数 slot。
   * @param {any} slotCountOverride - 参数 slotCountOverride。
   * @returns {any} 返回结果。
   */
  function setActiveDpiSlot(slot, slotCountOverride) {
    const prev = uiCurrentDpiSlot;
    const slotCount = clampSlotCountToCap(Number(slotCountOverride ?? getSlotCountUi()), getDpiSlotCap());
    const s = Math.max(1, Math.min(slotCount, Number(slot) || 1));
    uiCurrentDpiSlot = s;


    const changed = s !== prev;


    for (let i = 1; i <= getDpiSlotCap(); i++) {
      const row = dpiList?.querySelector?.(`.dpiSlotRow[data-slot="${i}"]`);
      if (!row) continue;
      const hidden = row.classList.contains("hidden");
      const isActive = !hidden && i === s;

      row.classList.toggle("active", isActive);
      if (!isActive) row.classList.remove("active-anim");


      if (isActive && dpiAnimReady && changed) {
        row.classList.remove("active-anim");
        void row.offsetWidth;
        row.classList.add("active-anim");
        row.addEventListener(
          "animationend",
          () => row.classList.remove("active-anim"),
          { once: true }
        );
      }
    }

    dpiAnimReady = true;
  }
  /**
   * 设置DPI。
   * 目的：保持 DPI 数值与槽位状态一致，避免错位或跳变。
   * @param {any} count - 参数 count。
   * @returns {any} 返回结果。
   */
  function setDpiRowsEnabledCount(count) {
    const n = clampSlotCountToCap(Number(count), getDpiSlotCap());
    for (let i = 1; i <= getDpiSlotCap(); i++) {
      const row = dpiList?.querySelector(`.dpiSlotRow[data-slot="${i}"]`);
      const hidden = i > n;


      if (row) {
        row.classList.toggle("hidden", hidden);
        row.classList.toggle("disabled", false);
      }

      const controls = [
        $("#dpiRange" + i),
        $("#dpiInput" + i),
        $("#dpiRangeX" + i),
        $("#dpiInputX" + i),
        $("#dpiRangeY" + i),
        $("#dpiInputY" + i),
      ];
      for (const ctrl of controls) {
        if (ctrl) ctrl.disabled = hidden;
      }
      const lodBtns = row?.querySelectorAll?.("button.dpiLodBtn") || [];
      lodBtns.forEach((btn) => {
        btn.disabled = hidden;
      });
    }
  }

  /**
   * 初始化DPI、范围。
   * 目的：保持 DPI 数值与槽位状态一致，避免错位或跳变。
   * @returns {any} 返回结果。
   */
  function initDpiRangeControls() {
    if (!dpiMinSelect || !dpiMaxSelect) return;
    if (dpiMinSelect.options.length) return;
    fillSelect(dpiMinSelect, DPI_MIN_OPTIONS, DPI_MIN_DEFAULT);
    fillSelect(dpiMaxSelect, DPI_MAX_OPTIONS, DPI_MAX_DEFAULT);
    normalizeDpiMinMax();
    applyDpiRangeToRows();

    /**
     * 处理on、change逻辑。
     * 目的：统一处理on、change相关流程，保证行为一致。
     * @returns {any} 返回结果。
     */
    const onChange = () => {
      normalizeDpiMinMax();
      applyDpiRangeToRows();


      const { min, max } = getDpiMinMax();
      for (let i = 1; i <= getDpiSlotCap(); i++) {
        const singleNum = $("#dpiInput" + i);
        const xNum = $("#dpiInputX" + i);
        const yNum = $("#dpiInputY" + i);

        const xRaw = Number(xNum?.value ?? singleNum?.value ?? getUiDpiAxisValue(i, "x", min));
        const yRaw = Number(yNum?.value ?? singleNum?.value ?? getUiDpiAxisValue(i, "y", xRaw));

        setUiDpiAxisValue(i, "x", Number.isFinite(xRaw) ? xRaw : min);
        setUiDpiAxisValue(i, "y", Number.isFinite(yRaw) ? yRaw : min);
        syncDpiRowInputs(i);
        updateDpiBubble(i);
      }
    };
    dpiMinSelect.addEventListener("change", onChange);
    dpiMaxSelect.addEventListener("change", onChange);
  }


  let __colorPicker = null;

  /**
   * 初始化颜色。
   * 目的：集中初始化与事件绑定，避免重复绑定或顺序问题。
   * @returns {any} 返回结果。
   */
  function initColorPicker() {
    if (__colorPicker) return __colorPicker;


    const wrap = document.createElement("div");
    wrap.className = "color-picker-popover";
    wrap.innerHTML = `
      <canvas class="cp-wheel" width="200" height="200"></canvas>
      <div class="cp-controls">
        <div class="cp-preview"></div>
        <input class="cp-hex" type="text" value="#FF0000" maxlength="7" />
        <button class="cp-btn-close">OK</button>
      </div>
    `;
    document.body.appendChild(wrap);

    const canvas = wrap.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    const preview = wrap.querySelector(".cp-preview");
    const hexInput = wrap.querySelector(".cp-hex");
    const btnClose = wrap.querySelector(".cp-btn-close");


    /**
     * 处理draw、wheel逻辑。
     * 目的：统一处理draw、wheel相关流程，保证行为一致。
     * @returns {any} 返回结果。
     */
    const drawWheel = () => {
      const w = canvas.width, h = canvas.height;
      const cx = w / 2, cy = h / 2, r = w / 2;
      ctx.clearRect(0, 0, w, h);

      for (let i = 0; i < 360; i++) {
        const startAngle = (i - 90) * Math.PI / 180;
        const endAngle = (i + 1 - 90) * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = `hsl(${i}, 100%, 50%)`;
        ctx.fill();
      }


      const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grd.addColorStop(0, 'white');
      grd.addColorStop(1, 'transparent');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    };
    drawWheel();


    let currentCallback = null;
    let isDragging = false;

    /**
     * 设置颜色。
     * 目的：提供统一读写入口，降低耦合。
     * @param {any} hex - 参数 hex。
     * @returns {any} 返回结果。
     */
    const setColor = (hex) => {
      preview.style.background = hex;
      hexInput.value = hex;
      if (currentCallback) currentCallback(hex);
    };

    /**
     * 处理颜色逻辑。
     * 目的：统一处理颜色相关流程，保证行为一致。
     * @param {any} e - 参数 e。
     * @returns {any} 返回结果。
     */
    const pickColor = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;

      const p = ctx.getImageData(x * scaleX, y * scaleY, 1, 1).data;

      if (p[3] === 0) return;

      const hex = "#" + [p[0], p[1], p[2]].map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase();
      setColor(hex);
    };


    canvas.addEventListener("pointerdown", (e) => {
      isDragging = true;
      canvas.setPointerCapture(e.pointerId);
      pickColor(e);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (isDragging) pickColor(e);
    });
    canvas.addEventListener("pointerup", () => isDragging = false);

    /**
     * 关闭逻辑。
     * 目的：集中控制可见性或开关状态，避免多处直接修改。
     * @returns {any} 返回结果。
     */
    const close = () => {
      wrap.classList.remove("open");
      currentCallback = null;
    };

    btnClose.addEventListener("click", close);


    document.addEventListener("pointerdown", (e) => {
      if (wrap.classList.contains("open") && !wrap.contains(e.target) && !e.target.closest(".dpiSelectBtn")) {
        close();
      }
    });

    hexInput.addEventListener("change", () => {
        let val = hexInput.value;
        if (!val.startsWith("#")) val = "#" + val;
        if (/^#[0-9A-Fa-f]{6}$/.test(val)) setColor(val);
    });

    __colorPicker = {
      open: (anchorEl, initialColor, onColorChange) => {

        const r = anchorEl.getBoundingClientRect();

        let left = r.left - 280;
        if (left < 10) left = r.right + 20;

        let top = r.top - 100;

        if (top + 280 > window.innerHeight) top = window.innerHeight - 290;
        if (top < 10) top = 10;

        wrap.style.left = `${left}px`;
        wrap.style.top = `${top}px`;

        setColor(initialColor || "#FF0000");
        currentCallback = onColorChange;

        wrap.classList.add("open");
      },
      close
    };
    return __colorPicker;
  }

  /**
   * 构建DPI。
   * 目的：保持 DPI 数值与槽位状态一致，避免错位或跳变。
   * @returns {any} 返回结果。
   */
  function buildDpiEditor() {
    if (!dpiList) return;
    const dpiSlotCap = getDpiSlotCap();
    initDpiRangeControls();


    for (let i = 1; i <= dpiSlotCap; i++) {
      const old = document.body.querySelector(`#dpiBubble${i}.dpiBubblePortal`);
      if (old) old.remove();
    }

    dpiList.innerHTML = "";

    const barColors = [
      "rgba(156,163,175,.55)",
      "#f97316",
      "#22c55e",
      "#facc15",
      "#ec4899",
      "#a855f7",
    ];

    const { min, max } = getDpiMinMax();
    const dpiStep = getDpiStep();

    for (let i = 1; i <= dpiSlotCap; i++) {
      const row = document.createElement("div");
      row.className = "dpiSlotRow";
      row.dataset.slot = String(i);
      row.style.setProperty("--bar", barColors[i - 1] || barColors[0]);
      const xInit = getUiDpiAxisValue(i, "x", 100);
      const yInit = getUiDpiAxisValue(i, "y", xInit);
      const lodInit = getUiDpiLod(i, "mid");
      const lodSwitchHtml = hasFeature("hasDpiLods")
        ? `
          <div class="dpiLodSwitch" role="group" aria-label="DPI档位${i} LOD">
            <button class="dpiLodBtn${lodInit === "low" ? " is-active" : ""}" type="button" data-lod="low" aria-pressed="${lodInit === "low" ? "true" : "false"}">低</button>
            <button class="dpiLodBtn${lodInit === "mid" ? " is-active" : ""}" type="button" data-lod="mid" aria-pressed="${lodInit === "mid" ? "true" : "false"}">中</button>
            <button class="dpiLodBtn${lodInit === "high" ? " is-active" : ""}" type="button" data-lod="high" aria-pressed="${lodInit === "high" ? "true" : "false"}">高</button>
          </div>
        `
        : "";
      row.innerHTML = `
        <div class="dpiSlotBar" aria-hidden="true"></div>
        <div class="dpiSlotHead">
          <div class="dpiSlotNum">${i}</div>
        </div>

        <div class="dpiRangeWrap">
          <input class="dpiRange" id="dpiRange${i}" type="range" min="${min}" max="${max}" step="${dpiStep}" value="100" />
          <div class="dpiBubble" id="dpiBubble${i}" aria-hidden="true">
            <div class="dpiBubbleInner"><span class="dpiBubbleVal">100</span></div>
          </div>
        </div>

        <div class="dpiNumWrap">
          <input class="dpiNum" id="dpiInput${i}" type="number" min="${min}" max="${max}" step="${dpiStep}" value="100" />
          <div class="dpiSpin" aria-hidden="true">
            <button class="dpiSpinBtn up" type="button" tabindex="-1" aria-label="增加"></button>
            <button class="dpiSpinBtn down" type="button" tabindex="-1" aria-label="减少"></button>
          </div>
        </div>

        <button class="dpiSelectBtn" type="button" aria-label="切换到档位 ${i}" title="切换到该档"></button>
      `;
      dpiList.appendChild(row);
      if (lodSwitchHtml) {
        row.insertAdjacentHTML("beforeend", lodSwitchHtml);
      }

      const singleRange = row.querySelector(`#dpiRange${i}`);
      const singleInput = row.querySelector(`#dpiInput${i}`);
      if (singleRange) {
        singleRange.dataset.slot = String(i);
        safeSetValue(singleRange, xInit);
      }
      if (singleInput) {
        singleInput.dataset.slot = String(i);
        safeSetValue(singleInput, xInit);
      }

      const rangeWrap = singleRange?.closest?.(".dpiRangeWrap");
      const numWrap = singleInput?.closest?.(".dpiNumWrap");
      const selectBtn = row.querySelector(".dpiSelectBtn");
      if (rangeWrap && numWrap && selectBtn) {
        const slotMain = document.createElement("div");
        slotMain.className = "dpiSlotMain";

        const axisSingle = document.createElement("div");
        axisSingle.className = "dpiAxisSingle";
        axisSingle.appendChild(rangeWrap);
        axisSingle.appendChild(numWrap);

        const axisDual = document.createElement("div");
        axisDual.className = "dpiAxisDual";
        axisDual.innerHTML = `
          <div class="dpiAxisPair dpiAxisPairX">
            <div class="dpiAxisTag">X</div>
            <div class="dpiRangeWrap">
              <input class="dpiRange" id="dpiRangeX${i}" data-slot="${i}" data-axis="x" type="range" min="${min}" max="${max}" step="${dpiStep}" value="${xInit}" />
            </div>
            <div class="dpiNumWrap">
              <input class="dpiNum" id="dpiInputX${i}" data-slot="${i}" data-axis="x" type="number" min="${min}" max="${max}" step="${dpiStep}" value="${xInit}" />
            </div>
          </div>
          <div class="dpiAxisPair dpiAxisPairY">
            <div class="dpiAxisTag">Y</div>
            <div class="dpiRangeWrap">
              <input class="dpiRange" id="dpiRangeY${i}" data-slot="${i}" data-axis="y" type="range" min="${min}" max="${max}" step="${dpiStep}" value="${yInit}" />
            </div>
            <div class="dpiNumWrap">
              <input class="dpiNum" id="dpiInputY${i}" data-slot="${i}" data-axis="y" type="number" min="${min}" max="${max}" step="${dpiStep}" value="${yInit}" />
            </div>
          </div>
        `;

        slotMain.appendChild(axisSingle);
        slotMain.appendChild(axisDual);
        row.insertBefore(slotMain, selectBtn);
      }
      syncDpiLodRow(i);
    }


    for (let i = 1; i <= dpiSlotCap; i++) {
      const b = $("#dpiBubble" + i);
      if (!b) continue;
      b.classList.add("dpiBubblePortal");
      document.body.appendChild(b);
    }


    const __isDpiSlotInCap = (slot) => {
      const n = Number(slot);
      return Number.isFinite(n) && n >= 1 && n <= getDpiSlotCap();
    };

    if (!__dpiEditorDelegatesReady) {
      __dpiEditorDelegatesReady = true;

      dpiList.addEventListener("input", (e) => {
      const t = e.target;
      const ctrl = t.closest?.("input.dpiRange, input.dpiNum");
      if (!ctrl) return;
      const isNumInput = ctrl.matches("input.dpiNum");
      if (isNumInput) return;

      const slot = Number(ctrl.dataset.slot || (ctrl.id || "").replace(/\D+/g, ""));
      if (!__isDpiSlotInCap(slot)) return;
      const axis = ctrl.dataset.axis === "y" ? "y" : (ctrl.dataset.axis === "x" ? "x" : "single");

      const { min: mn, max: mx } = getDpiMinMax();
      const val = clamp(ctrl.value, mn, mx);

      if (axis === "single") {
        setUiDpiSingleValue(slot, val);
      } else {
        setUiDpiAxisValue(slot, axis, val);
      }
      syncDpiRowInputs(slot);
      const rangeForBubble = ctrl.matches("input.dpiRange") ? ctrl : null;
      updateDpiBubble(slot, rangeForBubble);

      });

      dpiList.addEventListener("keydown", (e) => {
      const t = e.target;
      const input = t.closest?.("input.dpiNum");
      if (!input) return;
      if (e.key !== "Enter") return;
      e.preventDefault();
      input.blur();
      });


      dpiList.addEventListener("change", (e) => {
      const t = e.target;

      const isRange = t.matches("input.dpiRange");
      const isNum = t.matches("input.dpiNum");
      if (!isRange && !isNum) return;

      const slot = Number(t.dataset.slot || (t.id || "").replace(/\D+/g, ""));
      if (!__isDpiSlotInCap(slot)) return;
      const axis = t.dataset.axis === "y" ? "y" : (t.dataset.axis === "x" ? "x" : "single");

      const { min, max } = getDpiMinMax();


      let rawVal = Number(t.value);
      if (!Number.isFinite(rawVal)) rawVal = min;

      const prevX = getUiDpiAxisValue(slot, "x", rawVal);
      const prevY = getUiDpiAxisValue(slot, "y", prevX);
      const nextRawX = axis === "single" ? rawVal : (axis === "x" ? rawVal : prevX);
      const nextRawY = axis === "single" ? rawVal : (axis === "y" ? rawVal : prevY);
      const snappedPair = snapDpiPairByAdapter({
        slot,
        axis,
        x: nextRawX,
        y: nextRawY,
        min,
        max,
      });
      const committedVal = axis === "y" ? snappedPair.y : snappedPair.x;
      if (isNum && t.value !== String(committedVal)) {
        t.value = String(committedVal);
      }

      setUiDpiAxisValue(slot, "x", snappedPair.x);
      setUiDpiAxisValue(slot, "y", snappedPair.y);
      syncDpiRowInputs(slot);
      const rangeForBubble = t.matches("input.dpiRange") ? t : null;
      updateDpiBubble(slot, rangeForBubble);


      debounceKey(`dpi:${slot}`, 80, async () => {
        if (!isHidReady()) return;
        try {
          await withMutex(async () => {


            const isCurrentActive = (slot === uiCurrentDpiSlot);
            const xVal = getUiDpiAxisValue(slot, "x", committedVal);
            const yVal = getUiDpiAxisValue(slot, "y", xVal);
            const payload = hasDpiAdvancedAxis()
              ? { x: xVal, y: (isDpiAdvancedUiEnabled() ? yVal : xVal) }
              : xVal;

            await hidApi.setDpi(slot, payload, {
              select: isCurrentActive
            });
          });
        } catch (err) {
          logErr(err, "DPI 写入失败");
        }
      });
      });


      dpiList.addEventListener("click", (e) => {
      const t = e.target;

      if (Date.now() < dpiRowDragBlockClickUntil) return;


      const spinBtn = t.closest?.("button.dpiSpinBtn");
      if (spinBtn) {
        const wrap = spinBtn.closest?.(".dpiNumWrap");
        const inp = wrap?.querySelector?.("input.dpiNum");
        if (!inp) return;

        const step = Number(inp.step) || getDpiStep();
        const dir = spinBtn.classList.contains("up") ? 1 : -1;
        const mn = Number(inp.min) || 0;
        const mx = Number(inp.max) || 999999;
        const cur = Number(inp.value);

        const next = clamp((Number.isFinite(cur) ? cur : mn) + dir * step, mn, mx);
        inp.value = String(next);
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.focus({ preventScroll: true });
        return;
      }

      const lodBtn = t.closest?.("button.dpiLodBtn");
      if (lodBtn) {
        const row = lodBtn.closest?.(".dpiSlotRow");
        if (!row || row.classList.contains("hidden")) return;
        const slot = Number(row.dataset.slot);
        if (!__isDpiSlotInCap(slot)) return;
        const nextLod = normalizeUiDpiLod(lodBtn.dataset.lod, "");
        if (!nextLod) return;
        setUiDpiLod(slot, nextLod);
        syncDpiLodRow(slot);
        if (!isHidReady()) return;
        enqueueDevicePatch({ dpiLods: buildUiDpiLodsPayload() });
        return;
      }


      const selectBtn = t.closest?.("button.dpiSelectBtn");
      if (selectBtn) {
        const row = selectBtn.closest?.(".dpiSlotRow");
        if (!row || row.classList.contains("hidden")) return;

        const slot = Number(row.dataset.slot);
        if (!__isDpiSlotInCap(slot)) return;
        const xVal = getUiDpiAxisValue(slot, "x", Number($("#dpiInput" + slot)?.value));
        const yVal = getUiDpiAxisValue(slot, "y", xVal);
        if (!Number.isFinite(xVal) || xVal <= 0) return;


        if (hasFeature("hasDpiColors") && isHidReady()) {
            if (!Number.isFinite(xVal) || xVal <= 0) return;
            const picker = initColorPicker();

            const currentColor = selectBtn.style.getPropertyValue("--btn-bg") || "#FF0000";

            picker.open(selectBtn, currentColor, (newHex) => {

                selectBtn.style.setProperty("--btn-bg", newHex);


                debounceKey(`dpiColor:${slot}`, 150, async () => {
                    try {
                        await withMutex(async () => {
                            const payload = hasDpiAdvancedAxis()
                              ? { x: xVal, y: (isDpiAdvancedUiEnabled() ? yVal : xVal) }
                              : xVal;
                            await hidApi.setDpi(slot, payload, {
                                color: newHex,
                                select: false
                            });
                        });
                    } catch (e) {
                        logErr(e, "颜色写入失败");
                    }
                });
            });
            return;
        }


        setActiveDpiSlot(slot);
        if (!isHidReady()) return;
        enqueueDevicePatch({ activeDpiSlotIndex: slot - 1 });
        return;
      }


      if (t.closest("input") || t.closest("button")) return;

      const row = e.target.closest?.(".dpiSlotRow");
      if (!row || row.classList.contains("hidden")) return;

      const slot = Number(row.dataset.slot);
      if (!__isDpiSlotInCap(slot)) return;

      setActiveDpiSlot(slot);
      if (!isHidReady()) return;
      enqueueDevicePatch({ activeDpiSlotIndex: slot - 1 });
      });
    }


    const sc = getSlotCountUi();
    setDpiRowsEnabledCount(sc);
    setActiveDpiSlot(uiCurrentDpiSlot, sc);
    applyDpiAdvancedUiState();


    for (let i = 1; i <= dpiSlotCap; i++) updateDpiBubble(i);

    if (!dpiBubbleListenersReady) {
      dpiBubbleListenersReady = true;


      const THUMB_HIT_PAD = 6;
      const TRACK_HIT_HALF_Y = 8;
      /**
       * 检查DPI、拖拽点。
       * 目的：用于判断DPI、拖拽点状态，避免分散判断。
       * @param {any} range - 参数 range。
       * @param {any} clientX - 参数 clientX。
       * @returns {any} 返回结果。
       */
      function isPointerOnDpiThumb(range, clientX) {
        try {
          const val = Number(range.value);
          const min = Number(range.min);
          const max = Number(range.max);
          const denom = (max - min) || 1;
          const pct = (val - min) / denom;

          const rect = range.getBoundingClientRect();
          const cssThumb = parseFloat(getComputedStyle(range).getPropertyValue("--dpiThumb"));
          const thumb = Number.isFinite(cssThumb) && cssThumb > 0 ? cssThumb : 22;

          const trackW = rect.width;
          const thumbCenterX = pct * Math.max(0, (trackW - thumb)) + thumb / 2;

          const pointerX = clientX - rect.left;
          return Math.abs(pointerX - thumbCenterX) <= (thumb / 2 + THUMB_HIT_PAD);
        } catch {
          return false;
        }
      }

      /**
       * 设置 DPI 滑块拖动态视觉。
       * 目的：行级模拟拖动时与原生 :active 视觉保持一致。
       * @param {HTMLInputElement|null} range
       * @param {boolean} dragging
       */
      function setDpiRangeDragVisual(range, dragging) {
        if (!range) return;
        range.classList.toggle("dpiRangeDragging", !!dragging);
      }

      /**
       * 处理DPI、拖拽点逻辑。
       * 目的：处理指针交互与坐标映射，保证拖拽/命中判断准确。
       * @param {any} e - 参数 e。
       * @returns {any} 返回结果。
       */
      function handleDpiThumbHover(e) {
        const t = e.target;
        const range = t.closest?.("input.dpiRange");
        if (!range) return;

        const slot = Number(range.dataset.slot || (range.id || "").replace(/\D+/g, ""));
        if (!__isDpiSlotInCap(slot)) return;


        if (dpiDraggingSlot && dpiDraggingSlot !== slot) return;

        if (dpiDraggingSlot === slot) {
          showDpiBubble(slot, dpiDraggingEl || range);
          return;
        }

        if (isPointerOnDpiThumb(range, e.clientX)) {
          showDpiBubble(slot, range);
        } else {
          hideDpiBubble(slot);
        }
      }


      dpiList.addEventListener("pointermove", handleDpiThumbHover);


      dpiList.addEventListener("pointerover", handleDpiThumbHover);


      dpiList.addEventListener("pointerout", (e) => {
        const t = e.target;
        const range = t.closest?.("input.dpiRange");
        if (!range) return;

        const related = e.relatedTarget;
        if (related && (related === range || related.closest?.("input.dpiRange") === range)) return;

        const slot = Number(range.dataset.slot || (range.id || "").replace(/\D+/g, ""));
        if (!__isDpiSlotInCap(slot)) return;
        if (dpiDraggingSlot === slot) return;
        hideDpiBubble(slot);
      });

      dpiList.addEventListener("pointerleave", () => {
        if (dpiDraggingSlot) return;

        for (let i = 1; i <= getDpiSlotCap(); i++) hideDpiBubble(i);
      });


      /**
       * 处理DPI逻辑。
       * 目的：处理指针交互与坐标映射，保证拖拽/命中判断准确。
       * @returns {any} 返回结果。
       */
      function endDpiDrag() {
        if (!dpiDraggingSlot) return;
        const slot = dpiDraggingSlot;
        const dragEl = dpiDraggingEl;
        dpiDraggingSlot = null;


        if (dpiRowDragState) {
          if (dpiRowDragState.moved) dpiRowDragBlockClickUntil = Date.now() + 350;
          dpiRowDragState = null;
        }

        if (dragEl) {
          setDpiRangeDragVisual(dragEl, false);
          if (dpiRowDragDirty) {
            dragEl.dispatchEvent(new Event("change", { bubbles: true }));
          }
          unlockEl(dragEl);
          dpiDraggingEl = null;
        }
        dpiRowDragDirty = false;


        setTimeout(() => hideDpiBubble(slot), 150);
      }


      dpiList.addEventListener("dragstart", (e) => {
        if (e.target && e.target.closest?.(".dpiSlotRow")) e.preventDefault();
      });


      /**
       * 内部处理DPI、值逻辑。
       * 目的：处理指针交互与坐标映射，保证拖拽/命中判断准确。
       * @param {any} rangeEl - 参数 rangeEl。
       * @param {any} clientX - 参数 clientX。
       * @returns {any} 返回结果。
       */
      function __dpiValueFromClientX(rangeEl, clientX) {
        const rect = rangeEl.getBoundingClientRect();
        const min = Number(rangeEl.min);
        const max = Number(rangeEl.max);
        const step = Number(rangeEl.step) || 1;
        const w = rect.width || 1;
        const pct = Math.min(1, Math.max(0, (clientX - rect.left) / w));
        const raw = min + pct * (max - min);
        const snapped = Math.round(raw / step) * step;
        return clamp(snapped, min, max);
      }

      dpiList.addEventListener("pointerdown", (e) => {
        const t = e.target;

        const directRange = t.closest?.("input.dpiRange");
        if (directRange) {
          const slot = Number(directRange.dataset.slot || (directRange.id || "").replace(/\D+/g, ""));
          if (!__isDpiSlotInCap(slot)) return;

          setDpiRangeDragVisual(directRange, true);
          dpiRowDragDirty = false;
          dpiDraggingSlot = slot;
          dpiDraggingEl = directRange;


          lockEl(directRange);
          showDpiBubble(slot, directRange);
          return;
        }


        const row = t.closest?.(".dpiSlotRow");
        if (!row || row.classList.contains("hidden") || row.classList.contains("disabled")) return;


        if (
          t.closest("input") ||
          t.closest("button") ||
          t.closest("select") ||
          t.closest("textarea") ||
          t.closest(".xSelect")
        )
          return;

        const slot = Number(row.dataset.slot);
        if (!__isDpiSlotInCap(slot)) return;

        const range = $("#dpiRange" + slot);
        if (!range) return;

        const rect = range.getBoundingClientRect();

        if (!(e.clientX >= rect.left && e.clientX <= rect.right)) return;
        const centerY = rect.top + rect.height / 2;
        if (Math.abs(e.clientY - centerY) > TRACK_HIT_HALF_Y) return;

        const nextVal = __dpiValueFromClientX(range, e.clientX);
        if (Number(range.value) !== nextVal) {
          range.value = String(nextVal);
          range.dispatchEvent(new Event("input", { bubbles: true }));
          dpiRowDragDirty = true;
        } else {
          dpiRowDragDirty = false;
        }

        dpiRowDragState = {
          slot,
          range,
          pointerId: e.pointerId,
          moved: false,
          lastX: e.clientX,
          lastY: e.clientY,
        };

        dpiDraggingSlot = slot;
        dpiDraggingEl = range;

        setDpiRangeDragVisual(range, true);
        lockEl(range);
        showDpiBubble(slot, range);


        e.preventDefault();
      });

      document.addEventListener(
        "pointermove",
        (e) => {
          if (!dpiRowDragState) return;
          if (e.pointerId !== dpiRowDragState.pointerId) return;

          const { range, slot } = dpiRowDragState;
          if (!range) return;

          const dx = Math.abs(e.clientX - dpiRowDragState.lastX);
          const dy = Math.abs(e.clientY - dpiRowDragState.lastY);
          if (!dpiRowDragState.moved) {
            if (dx + dy <= 2) return;
            dpiRowDragState.moved = true;
          }

          dpiRowDragState.lastX = e.clientX;
          dpiRowDragState.lastY = e.clientY;

          const v = __dpiValueFromClientX(range, e.clientX);
          if (Number(range.value) !== v) {
            range.value = String(v);
            range.dispatchEvent(new Event("input", { bubbles: true }));
            dpiRowDragDirty = true;
          }
          showDpiBubble(slot, range);

          e.preventDefault();
        },
        { passive: false }
      );

      document.addEventListener("pointerup", endDpiDrag, { passive: true });
      document.addEventListener("pointercancel", endDpiDrag, { passive: true });
      window.addEventListener("blur", endDpiDrag);


      window.addEventListener(
        "resize",
        () => requestAnimationFrame(updateVisibleDpiBubbles),
        { passive: true }
      );
      window.addEventListener(
        "scroll",
        () => requestAnimationFrame(updateVisibleDpiBubbles),
        true
      );
    }

  }


  let applyKeymapFromCfg = null;
  /**
   * 构建按键映射。
   * 目的：集中按键映射的渲染与编辑，避免多处修改导致冲突。
   * @returns {any} 返回结果。
   */
  function buildKeymapEditor() {

    const points = $$("#keys .kmPoint");
    const drawer = $("#kmDrawer");
    const drawerTitle = $("#kmDrawerTitle");
    const drawerClose = $("#kmDrawerClose");
    const backdrop = $("#kmBackdrop");
    const tabs = $("#kmTabs");
    const list = $("#kmList");
    const search = $("#kmSearch");
    const canvas = $("#kmCanvas");
    const img = $("#keys .kmImg");

    if (!points.length || !drawer || !tabs || !list || !search) return;


    /**
     * 内部钳制01。
     * 目的：限制数值边界，防止越界。
     * @param {any} v - 参数 v。
     * @returns {any} 返回结果。
     */
    function __clamp01(v){ return v < 0 ? 0 : (v > 1 ? 1 : v); }


    /**
     * 获取img、content。
     * 目的：提供统一读写入口，降低耦合。
     * @param {any} imgEl - 参数 imgEl。
     * @returns {any} 返回结果。
     */
    function getImgContentRect(imgEl){
      const nw = imgEl.naturalWidth || 0;
      const nh = imgEl.naturalHeight || 0;
      const boxW = imgEl.clientWidth || imgEl.offsetWidth || 0;
      const boxH = imgEl.clientHeight || imgEl.offsetHeight || 0;
      if (!boxW || !boxH || !nw || !nh) return null;

      const cs = getComputedStyle(imgEl);
      const fit = (cs.objectFit || "fill").trim();
      const pos = (cs.objectPosition || "50% 50%").trim();

      let dispW = boxW, dispH = boxH;

      if (fit === "contain" || fit === "scale-down") {
        const scale = Math.min(boxW / nw, boxH / nh);
        dispW = nw * scale;
        dispH = nh * scale;
      } else if (fit === "cover") {
        const scale = Math.max(boxW / nw, boxH / nh);
        dispW = nw * scale;
        dispH = nh * scale;
      } else if (fit === "none") {
        dispW = nw;
        dispH = nh;
      }

      const leftoverX = boxW - dispW;
      const leftoverY = boxH - dispH;

      const parts = pos.split(/\s+/).filter(Boolean);
      const xTok = parts[0] || "50%";
      const yTok = parts[1] || "50%";

      /**
       * 处理parse、pos逻辑。
       * 目的：统一处理parse、pos相关流程，保证行为一致。
       * @param {any} tok - 参数 tok。
       * @param {any} axis - 参数 axis。
       * @returns {any} 返回结果。
       */
      const parsePos = (tok, axis) => {
        const t = String(tok).toLowerCase();
        if (t === "center") return 0.5;
        if (t === "left") return axis === "x" ? 0 : 0.5;
        if (t === "right") return axis === "x" ? 1 : 0.5;
        if (t === "top") return axis === "y" ? 0 : 0.5;
        if (t === "bottom") return axis === "y" ? 1 : 0.5;
        if (t.endsWith("%")) {
          const v = parseFloat(t);
          return Number.isFinite(v) ? __clamp01(v / 100) : 0.5;
        }
        if (t.endsWith("px")) {
          const px = parseFloat(t);
          const left = axis === "x" ? leftoverX : leftoverY;
          if (!Number.isFinite(px) || !left) return 0.5;
          return __clamp01(px / left);
        }
        return 0.5;
      };

      const fx = parsePos(xTok, "x");
      const fy = parsePos(yTok, "y");

      return {
        left: (imgEl.offsetLeft || 0) + leftoverX * fx,
        top: (imgEl.offsetTop || 0) + leftoverY * fy,
        width: dispW,
        height: dispH,
      };
    }

    /**
     * 处理layout、km逻辑。
     * 目的：在尺寸或状态变化时重新计算布局，避免错位。
     * @returns {any} 返回结果。
     */
    function layoutKmPoints() {
      if (!canvas || !img) return;
      const content = getImgContentRect(img);
      if (!content || !content.width || !content.height) return;

      for (const p of points) {
        const cs = getComputedStyle(p);
        const x = parseFloat(cs.getPropertyValue("--x")) || 0;
        const y = parseFloat(cs.getPropertyValue("--y")) || 0;
        const left = content.left + (x / 100) * content.width;
        const top = content.top + (y / 100) * content.height;
        p.style.left = `${left}px`;
        p.style.top = `${top}px`;
      }
    }

    /**
     * 处理schedule、layout逻辑。
     * 目的：在尺寸或状态变化时重新计算布局，避免错位。
     * @returns {any} 返回结果。
     */
    const scheduleLayoutKmPoints = () => {

      let tries = 0;
      let lastSig = "";
      layoutKmPoints.__token = (layoutKmPoints.__token || 0) + 1;
      const token = layoutKmPoints.__token;

      /**
       * 处理逻辑。
       * 目的：统一处理逻辑相关流程，保证行为一致。
       * @returns {any} 返回结果。
       */
      const step = () => {
        if (token !== layoutKmPoints.__token) return;
        tries++;


        const content = img ? getImgContentRect(img) : null;
        const canvasW = Number(canvas?.clientWidth || canvas?.offsetWidth || 0);
        const canvasH = Number(canvas?.clientHeight || canvas?.offsetHeight || 0);

        const sig = content
          ? [
              canvasW, canvasH,
              content.left, content.top, content.width, content.height
            ].map(v => Math.round(v * 10) / 10).join(",")
          : "";

        layoutKmPoints();

        if (tries >= 10 || (sig && sig === lastSig)) return;
        lastSig = sig;
        requestAnimationFrame(step);
      };


      requestAnimationFrame(step);
    };


    if (img && !img.complete) {
      img.addEventListener("load", scheduleLayoutKmPoints, { passive: true });
    }


    window.addEventListener("resize", scheduleLayoutKmPoints, { passive: true });


    window.addEventListener("hashchange", scheduleLayoutKmPoints, { passive: true });


    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => scheduleLayoutKmPoints());
      if (canvas) ro.observe(canvas);
      if (img) ro.observe(img);
    }


    scheduleLayoutKmPoints();

    const ACTIONS = ProtocolApi.KEYMAP_ACTIONS || {};
    const allLabels = Object.keys(ACTIONS).filter((l) => l && l !== "MODIFIER_ONLY");


    let groups = { mouse: [], keyboard: [], system: [] };
    try {
      const fn = ProtocolApi.listKeyActionsByType;
      if (typeof fn === "function") {
        const arr = fn() || [];
        for (const g of arr) {
          const t = g?.type;
          if (t === "mouse" || t === "keyboard" || t === "system") {
            groups[t] = (g.items || []).filter((l) => l && l !== "MODIFIER_ONLY");
          }
        }
      } else {
        groups = {
          mouse: allLabels.filter((l) => ACTIONS[l]?.type === "mouse"),
          keyboard: allLabels.filter((l) => ACTIONS[l]?.type === "keyboard"),
          system: allLabels.filter((l) => ACTIONS[l]?.type === "system"),
        };
      }
    } catch {
      groups = {
        mouse: allLabels.filter((l) => ACTIONS[l]?.type === "mouse"),
        keyboard: allLabels.filter((l) => ACTIONS[l]?.type === "keyboard"),
        system: allLabels.filter((l) => ACTIONS[l]?.type === "system"),
      };
    }


/**
 * 生成标签from、funckey。
 * 目的：统一处理from、funckey相关流程，保证行为一致。
 * @param {any} funckey - 参数 funckey。
 * @param {any} keycode - 参数 keycode。
 * @returns {any} 返回结果。
 */
function labelFromFunckeyKeycode(funckey, keycode) {
  try {
    const fn = ProtocolApi.labelFromFunckeyKeycode;
    return typeof fn === "function" ? fn(funckey, keycode) : null;
  } catch {
    return null;
  }
}


    const tabDefs = [
      { cat: "mouse", label: "鼠标按键" },
      { cat: "keyboard", label: "键盘按键" },
      { cat: "system", label: "系统" },
    ];

    /**
     * 处理group、of逻辑。
     * 目的：统一处理group、of相关流程，保证行为一致。
     * @param {any} label - 参数 label。
     * @returns {any} 返回结果。
     */
    function groupOfLabel(label) {
      const t = ACTIONS[label]?.type;
      return (t === "mouse" || t === "keyboard" || t === "system") ? t : "system";
    }

const defaultMap = {
      1: "左键",
      2: "右键",
      3: "中键",
      4: "前进",
      5: "后退",
      6: "DPI循环",
    };
    const mapping = { ...defaultMap };

    /**
     * 设置active、point。
     * 目的：提供统一读写入口，降低耦合。
     * @param {any} btn - 参数 btn。
     * @returns {any} 返回结果。
     */
    function setActivePoint(btn) {
      points.forEach((p) => p.classList.toggle("active", Number(p.getAttribute("data-btn")) === btn));
    }


    /**
     * 检查按钮。
     * 目的：用于判断按钮状态，避免分散判断。
     * @param {any} btn - 参数 btn。
     * @returns {any} 返回结果。
     */
    function isButtonModified(btn) {
      return mapping[btn] !== defaultMap[btn];
    }


    /**
     * 重置按钮。
     * 目的：统一处理按钮相关流程，保证行为一致。
     * @param {any} btn - 参数 btn。
     * @returns {Promise<any>} 异步结果。
     */
    async function resetSingleButton(btn) {
      if (btn === 1) {
        alert("为防止误操作，主按键（左键）已被锁定，不可修改。");
        return;
      }

      mapping[btn] = defaultMap[btn];
      updateBubble(btn);


      if (!isHidReady()) return;
      try {
        await withMutex(async () => {
          await hidApi.setButtonMappingBySelect(btn, mapping[btn], {});
        });
        log(`按键 ${btn} 已恢复默认: "${mapping[btn]}"`);
      } catch (err) {
        logErr(err, `恢复按键 ${btn} 默认值失败`);
      }
    }

    /**
     * 更新气泡提示。
     * 目的：在状态变化时同步 UI 或数据，避免不一致。
     * @param {any} btn - 参数 btn。
     * @returns {any} 返回结果。
     */
    function updateBubble(btn) {
      const el = $(`#kmLabel${btn}`);
      if (!el) return;
      el.textContent = mapping[btn] || "-";


      const point = $(`.kmPoint[data-btn="${btn}"]`);
      if (!point) return;

      const bubble = point.querySelector(".kmBubble");
      if (!bubble) return;


      let resetBtn = bubble.querySelector(".kmResetBtn");
      const isModified = isButtonModified(btn);


      point.classList.toggle("kmModified", isModified);

      if (isModified && !resetBtn) {

        resetBtn = document.createElement("button");
        resetBtn.className = "kmResetBtn";
        resetBtn.type = "button";
        resetBtn.setAttribute("aria-label", `恢复按键${btn}默认值`);
        resetBtn.innerHTML = "↺";
        resetBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          resetSingleButton(btn);
        });
        bubble.appendChild(resetBtn);
      } else if (!isModified && resetBtn) {

        resetBtn.remove();
      }
    }

    /**
     * 更新all、bubbles。
     * 目的：在状态变化时同步 UI 或数据，避免不一致。
     * @returns {any} 返回结果。
     */
    function updateAllBubbles() {
      for (let i = 1; i <= 6; i++) updateBubble(i);
    }


     /**
      * 应用按键映射、设备。
      * 目的：集中按键映射的渲染与编辑，避免多处修改导致冲突。
      * @param {any} cfg - 参数 cfg。
      * @returns {any} 返回结果。
      */
     function applyKeymapFromDeviceCfg(cfg) {
       const arr = cfg?.buttonMappings;

       if (!arr || !Array.isArray(arr) || arr.length < 6) return;

       for (let i = 1; i <= 6; i++) {
         const it = arr[i - 1];
         if (!it) continue;
         const label = labelFromFunckeyKeycode(it.funckey, it.keycode);

         if (label) {
           mapping[i] = label;
         }
       }

       updateAllBubbles();
     }


     applyKeymapFromCfg = applyKeymapFromDeviceCfg;


    let __focusTimer = null;
    /**
     * 延迟focus、search。
     * 目的：统一处理focus、search相关流程，保证行为一致。
     * @returns {any} 返回结果。
     */
    function deferFocusSearch() {
      if (!search) return;


      if (__focusTimer) {
        clearTimeout(__focusTimer);
        __focusTimer = null;
      }

      /**
       * 处理do、focus逻辑。
       * 目的：统一处理do、focus相关流程，保证行为一致。
       * @returns {any} 返回结果。
       */
      const doFocus = () => {

        if (!drawer.classList.contains("open")) return;
        try {

          search.focus({ preventScroll: true });
        } catch (e) {
          search.focus?.();
        }

        try { search.select?.(); } catch (e) {}
      };

      const prefersReduced =
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (prefersReduced) {

        requestAnimationFrame(doFocus);
        return;
      }

      let fired = false;
      /**
       * 处理on、end逻辑。
       * 目的：统一处理on、end相关流程，保证行为一致。
       * @param {any} e - 参数 e。
       * @returns {any} 返回结果。
       */
      const onEnd = (e) => {
        if (e.target !== drawer) return;

        if (e.propertyName && e.propertyName !== "transform" && e.propertyName !== "opacity") return;
        if (fired) return;
        fired = true;
        drawer.removeEventListener("transitionend", onEnd);

        requestAnimationFrame(() => requestAnimationFrame(doFocus));
      };

      drawer.addEventListener("transitionend", onEnd, { passive: true });


      __focusTimer = setTimeout(() => {
        if (fired) return;
        fired = true;
        drawer.removeEventListener("transitionend", onEnd);
        requestAnimationFrame(() => requestAnimationFrame(doFocus));
      }, 260);
    }
/**
 * 打开抽屉。
 * 目的：集中控制可见性或开关状态，避免多处直接修改。
 * @param {any} btn - 参数 btn。
 * @returns {any} 返回结果。
 */
function openDrawer(btn) {
      activeBtn = btn;
      setActivePoint(btn);


      const cur = mapping[btn];
      activeCat = groupOfLabel(cur) || activeCat;

      if (drawerTitle) drawerTitle.textContent = `按键 ${btn} 映射`;
      drawer.classList.add("open");
      drawer.setAttribute("aria-hidden", "false");
      backdrop?.classList.add("show");
      backdrop?.setAttribute("aria-hidden", "false");

      document.body.classList.add("km-drawer-open");

      renderTabs();
      renderList();
      deferFocusSearch();
    }

    /**
     * 关闭抽屉。
     * 目的：集中控制可见性或开关状态，避免多处直接修改。
     * @returns {any} 返回结果。
     */
    function closeDrawer() {
      if (__focusTimer) { clearTimeout(__focusTimer); __focusTimer = null; }
      drawer.classList.remove("open");
      drawer.setAttribute("aria-hidden", "true");
      backdrop?.classList.remove("show");
      backdrop?.setAttribute("aria-hidden", "true");
      points.forEach((p) => p.classList.remove("active"));
      document.body.classList.remove("km-drawer-open");
    }

    /**
     * 渲染tabs。
     * 目的：集中渲染入口，减少分散更新。
     * @returns {any} 返回结果。
     */
    function renderTabs() {
      tabs.innerHTML = "";
      for (const t of tabDefs) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "kmTab" + (t.cat === activeCat ? " active" : "");
        b.textContent = t.label;
        b.setAttribute("role", "tab");
        b.addEventListener("click", () => {
          activeCat = t.cat;
          renderTabs();
          renderList();
        });
        tabs.appendChild(b);
      }
    }

    /**
     * 渲染列表。
     * 目的：集中渲染入口，减少分散更新。
     * @returns {any} 返回结果。
     */
    function renderList() {
      const q = (search.value || "").trim().toLowerCase();
      const items0 = groups[activeCat] || [];
      const items = items0.filter((x) => !q || String(x).toLowerCase().includes(q));

      list.innerHTML = "";
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "hint";
        empty.textContent = "无匹配结果";
        list.appendChild(empty);
        return;
      }

      const current = mapping[activeBtn];

      for (const label of items) {
        const row = document.createElement("div");
        row.className = "kmItem" + (label === current ? " selected" : "");
        row.setAttribute("role", "listitem");
        row.innerHTML = `<div>${escapeHtml(label)}</div><div style="opacity:.55;font-weight:800;">→</div>`;
        row.addEventListener("click", () => choose(label));
        list.appendChild(row);
      }
    }

    /**
     * 选择逻辑。
     * 目的：统一处理逻辑相关流程，保证行为一致。
     * @param {any} label - 参数 label。
     * @returns {Promise<any>} 异步结果。
     */
    async function choose(label) {
      if (activeBtn === 1) {
         alert("为防止误操作，主按键（左键）已被锁定，不可修改。");
         return;
      }

      mapping[activeBtn] = label;
      updateBubble(activeBtn);


      debounceKey(`km:${activeBtn}`, 120, async () => {
        if (!isHidReady()) return;
        try {
          await withMutex(async () => {
            await hidApi.setButtonMappingBySelect(activeBtn, label, {});
          });
          log(`按键映射已写入:btn=${activeBtn}, action="${label}"`);
        } catch (err) {
          logErr(err, "按键映射写入失败");
        }
      });

      closeDrawer();
    }


    points.forEach((p) => {
      const btn = Number(p.getAttribute("data-btn"));
      /**
       * 处理handler逻辑。
       * 目的：统一处理handler相关流程，保证行为一致。
       * @param {any} e - 参数 e。
       * @returns {any} 返回结果。
       */
      const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openDrawer(btn);
      };
      p.querySelector(".kmDotBtn")?.addEventListener("click", handler);
      p.querySelector(".kmBubble")?.addEventListener("click", handler);
    });

    drawerClose?.addEventListener("click", closeDrawer);
    backdrop?.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && drawer.classList.contains("open")) closeDrawer();
    });

    search.addEventListener("input", () => renderList());


    updateAllBubbles();


    applyKeymapFromCfg = applyKeymapFromDeviceCfg;

    const cachedCfg = getCachedDeviceConfig();
    if (cachedCfg) {
        setTimeout(() => {
            applyKeymapFromDeviceCfg(cachedCfg);
        }, 100);
    }
  }


    /**
     * 转义逻辑。
     * 目的：统一处理逻辑相关流程，保证行为一致。
     * @param {any} s - 参数 s。
     * @returns {any} 返回结果。
     */
    function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  buildDpiEditor();
  buildKeymapEditor();
  applyDpiAdvancedUiState();

  if (dpiAdvancedToggle) {
    dpiAdvancedToggle.addEventListener("click", async () => {
      if (!hasDpiAdvancedAxis()) return;
      if (dpiAdvancedToggleBusy) return;
      const nextEnabled = !dpiAdvancedEnabled;
      dpiAdvancedEnabled = nextEnabled;
      applyDpiAdvancedUiState();

      if (nextEnabled) return;
      dpiAdvancedToggleBusy = true;
      try {
        await syncDpiSlotsToSingleAxisIfNeeded();
      } finally {
        dpiAdvancedToggleBusy = false;
      }
    });
  }


  const slotSel = $("#slotCountSelect");
  if (slotSel) {
    slotSel.addEventListener("change", () => {
      const nextCount = Number(slotSel.value);


      setDpiRowsEnabledCount(nextCount);
      setActiveDpiSlot(uiCurrentDpiSlot, nextCount);

      enqueueDevicePatch({ dpiSlotCount: nextCount });
    });
  }


  // ============================================================
  // 6) 设备写入队列（防抖 + 适配器驱动）
  // ============================================================
  let __pendingDevicePatch = null;

  function __nextWriteSeq() {
    __writeSeqCounter += 1;
    return __writeSeqCounter;
  }

  function __cleanupExpiredIntents(now = Date.now()) {
    for (const [key, intent] of __intentByKey.entries()) {
      if (!intent || (now - Number(intent.ts || 0)) > __INTENT_TTL_MS) {
        __intentByKey.delete(key);
      }
    }
  }

  function __setWriteIntent(key, value) {
    const intent = {
      seq: __nextWriteSeq(),
      value,
      ts: Date.now(),
    };
    __intentByKey.set(key, intent);
    return intent;
  }

  function __getWriteIntent(key) {
    __cleanupExpiredIntents();
    return __intentByKey.get(key) || null;
  }

  function __clearWriteIntent(key, seq) {
    const cur = __intentByKey.get(key);
    if (!cur) return;
    if (seq == null || cur.seq === seq) {
      __intentByKey.delete(key);
    }
  }

  function __isSameStandardValue(a, b) {
    if (Object.is(a, b)) return true;
    if (a == null || b == null) return false;
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
    return String(a) === String(b);
  }

  function readStandardValueWithIntent(cfg, key) {
    const deviceValue = readStandardValue(cfg, key);
    const intent = __getWriteIntent(key);
    if (!intent) return deviceValue;
    if (__isSameStandardValue(deviceValue, intent.value)) {
      __clearWriteIntent(key, intent.seq);
      return deviceValue;
    }
    return intent.value;
  }


  /**
   * 加入设备写入队列。
   * 目的：合并高频写入并通过适配器统一转换路径，降低竞态风险。
   * @param {any} patch - 参数 patch。
   * @returns {any} 返回结果。
   */
  function enqueueDevicePatch(patch) {
    if (!patch || typeof patch !== "object") return;


    if (!__writesEnabled) return;
    if (!__pendingDevicePatch) __pendingDevicePatch = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      __pendingDevicePatch[k] = v;
      __setWriteIntent(k, v);
    }


    debounceKey("deviceState", (window.AppConfig?.timings?.debounceMs?.deviceState ?? 200), async () => {
      if (!isHidReady()) return;
      const payload = __pendingDevicePatch;
      __pendingDevicePatch = null;
      if (!payload || !Object.keys(payload).length) return;

      const attemptSeqByKey = {};
      for (const k of Object.keys(payload)) {
        const intent = __getWriteIntent(k);
        if (!intent) continue;
        attemptSeqByKey[k] = intent.seq;
      }

      try {
        await withMutex(async () => {
          const writer = window.DeviceWriter;
          if (writer?.writePatch) {
            const result = await writer.writePatch({
              hidApi,
              adapter,
              payload,
            });
            const writtenStdPatch = result?.writtenStdPatch || {};
            for (const key of Object.keys(payload)) {
              if (Object.prototype.hasOwnProperty.call(writtenStdPatch, key)) continue;
              __clearWriteIntent(key, attemptSeqByKey[key]);
            }
          } else {
            console.warn("[writer] missing, skip writePatch");
            for (const key of Object.keys(payload)) {
              __clearWriteIntent(key, attemptSeqByKey[key]);
            }
          }
        });

        if (payload.pollingHz != null) log(`回报率已写入:${payload.pollingHz}Hz`);
        if (payload.performanceMode != null) log(`性能模式已写入:${payload.performanceMode}`);
        if (payload.linearCorrection != null) log(`直线修正已写入:${payload.linearCorrection ? "开" : "关"}`);
        if (payload.rippleControl != null) log(`纹波修正已写入:${payload.rippleControl ? "开" : "关"}`);
      } catch (e) {
        for (const key of Object.keys(payload)) {
          __clearWriteIntent(key, attemptSeqByKey[key]);
        }
        logErr(e, "设备状态写入失败");
        requestConfigOnce("write-failure-reconcile").catch(() => {});
      }
    });
  }

  const pollingSel = $("#pollingSelect");
  if (pollingSel) {
    pollingSel.addEventListener("change", () => {
      const hz = Number(pollingSel.value);
      if (!Number.isFinite(hz)) return;
      enqueueDevicePatch({ pollingHz: hz });
    });
  }

  const pollingWirelessSel = $("#pollingSelectWireless");
  if (pollingWirelessSel) {
    pollingWirelessSel.addEventListener("change", () => {
      if (!__isDualPollingRates) return;
      const hz = Number(pollingWirelessSel.value);
      if (!Number.isFinite(hz)) return;
      enqueueDevicePatch({ pollingWirelessHz: hz });
    });
  }

  const sleepSel = $("#sleepSelect");
  if (sleepSel) {
    sleepSel.addEventListener("change", () => {
      const sec = Number(sleepSel.value);
      if (!Number.isFinite(sec)) return;
      enqueueDevicePatch({ sleepSeconds: sec });
    });
  }

  const debounceSel = $("#debounceSelect");
  if (debounceSel) {
    debounceSel.addEventListener("change", () => {
      const ms = Number(debounceSel.value);
      if (!Number.isFinite(ms)) return;
      enqueueDevicePatch({ debounceMs: ms });
    });
  }


  const ledToggle = $("#ledToggle");
  if (ledToggle) {
    ledToggle.addEventListener("change", () => {
      if (!hasFeature("hasPrimaryLedFeature")) return;
      const on = !!ledToggle.checked;
      enqueueDevicePatch({ primaryLedFeature: on });
    });
  }


  const perfRadios = $$('input[name="perfMode"]');
  perfRadios.forEach((r) => {
    r.addEventListener("change", () => {
      if (!__hasPerformanceMode) return;
      const v = document.querySelector('input[name="perfMode"]:checked')?.value;
      if (!v) return;

      enqueueDevicePatch({ performanceMode: v });
    });
  });

  const lodEl = $("#bitLOD");
  if (lodEl) {
    lodEl.addEventListener("change", () => {
      if (!hasFeature("hasPrimarySurfaceToggle")) return;
      enqueueDevicePatch({ surfaceModePrimary: !!lodEl.checked });
    });
  }


  const bit1 = $("#bit1");
  if (bit1) bit1.addEventListener("change", () => {
    if (!hasFeature("hasMotionSync")) return;
    enqueueDevicePatch({ motionSync: !!bit1.checked });
  });

  const bit2 = $("#bit2");
  if (bit2) bit2.addEventListener("change", () => {
    if (!hasFeature("hasLinearCorrection")) return;
    enqueueDevicePatch({ linearCorrection: !!bit2.checked });
  });

  const bit3 = $("#bit3");
  if (bit3) bit3.addEventListener("change", () => {
    if (!hasFeature("hasRippleControl")) return;
    enqueueDevicePatch({ rippleControl: !!bit3.checked });
  });

  const bit6 = $("#bit6");
  if (bit6) {
    bit6.addEventListener("change", () => {
      if (!hasFeature("hasSecondarySurfaceToggle")) return;
      enqueueDevicePatch({ surfaceModeSecondary: !!bit6.checked });
    });
  }

  const rapooPollingSelectAdv = $("#rapooPollingSelectAdv");
  if (rapooPollingSelectAdv) {
    rapooPollingSelectAdv.addEventListener("change", () => {
      if (!hasFeature("hasKeyScanRate")) return;
      const hz = Number(rapooPollingSelectAdv.value);
      if (!Number.isFinite(hz)) return;

      enqueueDevicePatch({ keyScanningRate: hz });
    });
  }


  const wirelessStrategyToggle = $("#wirelessStrategyToggle");
  if (wirelessStrategyToggle) {
    wirelessStrategyToggle.addEventListener("change", () => {
      if (!hasFeature("hasWirelessStrategy")) return;
      enqueueDevicePatch({ wirelessStrategyMode: !!wirelessStrategyToggle.checked });
      try { syncBasicExtraSwitchState(); } catch (_) {}
    });
  }


  const commProtocolToggle = $("#commProtocolToggle");
  if (commProtocolToggle) {
    commProtocolToggle.addEventListener("change", () => {
      if (!hasFeature("hasCommProtocol")) return;
      enqueueDevicePatch({ commProtocolMode: !!commProtocolToggle.checked });
      try { syncBasicExtraSwitchState(); } catch (_) {}
    });
  }


  const longRangeToggle = $("#longRangeModeToggle");
  if (longRangeToggle) {
    longRangeToggle.addEventListener("change", () => {
      if (!hasFeature("hasLongRange")) return;
      enqueueDevicePatch({ longRangeMode: !!longRangeToggle.checked });
    });
  }

  const angleInput = $("#angleInput");
  if (angleInput) {


    /**
     * 处理角度逻辑。
     * 目的：统一处理角度相关流程，保证行为一致。
     * @returns {any} 返回结果。
     */
    const commitAngle = () => {
      const v = Number(angleInput.value);
      if (!Number.isFinite(v)) return;
      enqueueDevicePatch({ sensorAngle: v });
    };
    angleInput.addEventListener("change", commitAngle);

    angleInput.addEventListener("pointerup", commitAngle);
    angleInput.addEventListener("touchend", commitAngle);
  }


  const feelInput = $("#feelInput");
  if (feelInput) {


    /**
     * 处理手感逻辑。
     * 目的：统一处理手感相关流程，保证行为一致。
     * @returns {any} 返回结果。
     */
    const commitFeel = () => {
      const v = Number(feelInput.value);
      if (!Number.isFinite(v)) return;
      enqueueDevicePatch({ surfaceFeel: v });
    };
    feelInput.addEventListener("change", commitFeel);
    feelInput.addEventListener("pointerup", commitFeel);
    feelInput.addEventListener("touchend", commitFeel);
  }


  /**
   * 同步basic、extra。
   * 目的：保持状态一致性，避免局部更新遗漏。
   * @returns {any} 返回结果。
   */
  function syncBasicExtraSwitchState() {
    const wsToggle = $("#wirelessStrategyToggle");
    const wsState = $("#wirelessStrategyState");
    if (wsToggle && wsState) wsState.textContent = wsToggle.checked ? "满格射频" : "智能调节";

    const cpToggle = $("#commProtocolToggle");
    const cpState = $("#commProtocolState");
    if (cpToggle && cpState) cpState.textContent = cpToggle.checked ? "初始" : "高效";
  }

  /**
   * 设置radio。
   * 目的：提供统一读写入口，降低耦合。
   * @param {any} name - 参数 name。
   * @param {any} value - 参数 value。
   * @returns {any} 返回结果。
   */
  function setRadio(name, value) {
    const ae = document.activeElement;
    if (ae && ae.name === name) return;
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el && !(el.id && uiLocks.has(el.id))) el.checked = true;
  }


  // ============================================================
  // 7) 配置 -> UI 同步（单向数据流）
  // ============================================================
  /**
   * 将设备配置映射到 UI。
   * 目的：保持设备回包到 UI 的单向数据流，避免回写回路。
   * @param {any} cfg - 参数 cfg。
   * @returns {any} 返回结果。
   */
  function applyConfigToUi(cfg) {

    try { applyCapabilitiesToUi(cfg?.capabilities); } catch (_) {}
    __cleanupExpiredIntents();
    const readMerged = (key) => readStandardValueWithIntent(cfg, key);
    const topConfigSlotCount = readMerged("configSlotCount");
    const topActiveConfigSlotIndex = readMerged("activeConfigSlotIndex");
    renderTopConfigSlots({
      slotCount: topConfigSlotCount,
      activeIndex: topActiveConfigSlotIndex,
    });
    const dpiSlotCap = getDpiSlotCap();
    const slotsXRaw = readMerged("dpiSlotsX");
    const slotsCompat = readMerged("dpiSlots");
    const slotsYRaw = readMerged("dpiSlotsY");
    const slotsX = Array.isArray(slotsXRaw)
      ? slotsXRaw
      : (Array.isArray(slotsCompat) ? slotsCompat : (Array.isArray(cfg.dpiSlots) ? cfg.dpiSlots : []));
    const slotsY = Array.isArray(slotsYRaw)
      ? slotsYRaw
      : slotsX;
    const lodsRaw = hasFeature("hasDpiLods") ? readMerged("dpiLods") : [];
    const lods = Array.isArray(lodsRaw) ? lodsRaw : [];

    const slotCount = clampSlotCountToCap(
      Number(readMerged("dpiSlotCount") ?? dpiSlotCap),
      dpiSlotCap
    );
    let hasAxisDiff = false;


    const supportsDpiColors = hasFeature("hasDpiColors");
    const colors = supportsDpiColors ? (cfg.dpiColors || []) : [];

    for (let i = 1; i <= dpiSlotCap; i++) {
      const xVal = Number(slotsX[i - 1]);
      const yValRaw = Number(slotsY[i - 1]);
      const xSafe = Number.isFinite(xVal) ? xVal : getUiDpiAxisValue(i, "x", 800);
      const ySafe = Number.isFinite(yValRaw) ? yValRaw : xSafe;
      setUiDpiAxisValue(i, "x", xSafe);
      setUiDpiAxisValue(i, "y", ySafe);
      setUiDpiLod(i, lods[i - 1]);
      if (xSafe !== ySafe) hasAxisDiff = true;
      syncDpiRowInputs(i);
      updateDpiBubble(i);


      const btn = dpiList?.querySelector(`.dpiSlotRow[data-slot="${i}"] .dpiSelectBtn`);
      if (btn) {
        if (supportsDpiColors) {
          if (colors[i - 1]) btn.style.setProperty("--btn-bg", colors[i - 1]);
        } else {
          btn.style.removeProperty("--btn-bg");
        }
      }
    }

    safeSetValue($("#slotCountSelect"), slotCount);
    setDpiRowsEnabledCount(slotCount);

    const activeDpiIndex = Number(readMerged("activeDpiSlotIndex") ?? 0);
    const curIdx1 = (Number.isFinite(activeDpiIndex) ? activeDpiIndex : 0) + 1;
    setActiveDpiSlot(curIdx1, slotCount);
    if (hasDpiAdvancedAxis() && hasAxisDiff && !dpiSyncingToSingleMode) {
      dpiAdvancedEnabled = true;
    }
    applyDpiAdvancedUiState();

    const keyScanRate = readMerged("keyScanningRate");
    if (hasFeature("hasKeyScanRate") && keyScanRate != null) {
      safeSetValue($("#rapooPollingSelectAdv"), keyScanRate);
      if (typeof updatePollingCycleUI === "function") {
        updatePollingCycleUI(keyScanRate, false);
      }
    }

    const pickNearestPollingValue = (selectEl, value) => {
      if (!selectEl || value == null) return;
      const opts = Array.from(selectEl.options)
        .map((o) => Number(o.value))
        .filter(Number.isFinite);
      const picked = opts.length
        ? opts.reduce((best, x) => (Math.abs(x - value) < Math.abs(best - value) ? x : best), opts[0])
        : value;
      safeSetValue(selectEl, picked);
    };

    const pollingHz = readMerged("pollingHz");
    if (pollingHz != null) {
      pickNearestPollingValue($("#pollingSelect"), pollingHz);
    }

    const pollingWirelessHz = readMerged("pollingWirelessHz");
    if (__isDualPollingRates) {
      const wirelessValue = pollingWirelessHz != null ? pollingWirelessHz : pollingHz;
      if (wirelessValue != null) {
        pickNearestPollingValue($("#pollingSelectWireless"), wirelessValue);
      }
    }

    const sleepSeconds = readMerged("sleepSeconds");
    if (sleepSeconds != null) safeSetValue($("#sleepSelect"), sleepSeconds);

    const debounceMs = readMerged("debounceMs");
    if (debounceMs != null) safeSetValue($("#debounceSelect"), debounceMs);

    if (__hasPerformanceMode) {
      const perfMode = readMerged("performanceMode") || "low";
      setRadio("perfMode", perfMode);
    }

    /**
     * 设置逻辑。
     * 目的：提供统一读写入口，降低耦合。
     * @param {any} id - 参数 id。
     * @param {any} v - 参数 v。
     * @returns {any} 返回结果。
     */
    const setCb = (id, v) => {
      const el = $(id);
      if (!el) return;
      if (el.id && uiLocks.has(el.id)) return;
      el.checked = !!v;
    };

    const primarySurface = readMerged("surfaceModePrimary");
    if (primarySurface != null) setCb("#bitLOD", primarySurface);

    const primaryLed = readMerged("primaryLedFeature");
    if (primaryLed != null) setCb("#ledToggle", primaryLed);

    const motionSync = readMerged("motionSync");
    if (motionSync != null) setCb("#bit1", motionSync);

    const linearCorrection = readMerged("linearCorrection");
    if (linearCorrection != null) setCb("#bit2", linearCorrection);

    const rippleControl = readMerged("rippleControl");
    if (rippleControl != null) setCb("#bit3", rippleControl);

    const secondarySurface = readMerged("surfaceModeSecondary");
    if (secondarySurface != null) setCb("#bit6", secondarySurface);

    const wirelessMode = readMerged("wirelessStrategyMode");
    if (wirelessMode != null) setCb("#wirelessStrategyToggle", wirelessMode);

    const commMode = readMerged("commProtocolMode");
    if (commMode != null) setCb("#commProtocolToggle", commMode);

    if (hasFeature("hasWirelessStrategy") || hasFeature("hasCommProtocol")) {
      try { syncBasicExtraSwitchState(); } catch (_) {}
    }

    const longRangeMode = readMerged("longRangeMode");
    if (longRangeMode != null) setCb("#longRangeModeToggle", longRangeMode);

    const angleVal = readMerged("sensorAngle");
    if (angleVal != null) safeSetValue($("#angleInput"), angleVal);

    const feelVal = readMerged("surfaceFeel");
    if (feelVal != null) safeSetValue($("#feelInput"), feelVal);

    const onboardMemoryMode = readMerged("onboardMemoryMode");
    if (onboardMemoryMode != null) {
      setCb("#lgOnboardMemoryToggle", onboardMemoryMode);
    }

    const lightforceSwitch = readMerged("lightforceSwitch");
    if (lightforceSwitch != null) {
      const lightforceToggle = $("#lgLightforceToggle");
      if (lightforceToggle && !(lightforceToggle.id && uiLocks.has(lightforceToggle.id))) {
        lightforceToggle.checked = String(lightforceSwitch || "").trim().toLowerCase() === "optical";
      }
    }

    const surfaceMode = readMerged("surfaceMode");
    if (surfaceMode != null) {
      safeSetValue($("#lgSurfaceModeSelect"), __normalizeLgSurfaceMode(surfaceMode));
    }

    const bhopMs = readMerged("bhopMs");
    if (bhopMs != null) {
      const normalizedBhopMs = __clampLgBhop(bhopMs);
      const bhopEnabled = normalizedBhopMs > 0;
      setCb("#lgBhopToggle", bhopEnabled);
      safeSetValue($("#lgBhopInput"), bhopEnabled ? __clampLgBhopEnabled(normalizedBhopMs) : 100);
    }


    syncAdvancedPanelUi();
    syncLogitechAdvancedUi();

    const mouseV = cfg.mouseFw ?? (cfg.mouseFwRaw != null ? ProtocolApi.uint8ToVersion(cfg.mouseFwRaw) : "-");
    const rxV = cfg.receiverFw ?? (cfg.receiverFwRaw != null ? ProtocolApi.uint8ToVersion(cfg.receiverFwRaw) : "-");
    const fwText = `Mouse:${mouseV} / RX:${rxV}`;


    currentFirmwareText = fwText;
    if (isHidReady()) {
      updateDeviceStatus(true, currentDeviceName || "Unknown", currentBatteryText || "", currentFirmwareText);
    }
    syncBasicMonolithUI();


    try { applyKeymapFromCfg?.(cfg); } catch (_) {}


    if (hasFeature("hasAtkLights")) {
      const dpiLight = readMerged("dpiLightEffect");
      if (dpiLight != null) {
        updateAtkCycleUI("atkDpiLightCycle", dpiLight, ATK_DPI_LIGHT_OPTS, false);
      }
      const rxLight = readMerged("receiverLightEffect");
      if (rxLight != null) {
        updateAtkCycleUI("atkReceiverLightCycle", rxLight, ATK_RX_LIGHT_OPTS, false);
      }
    }
  }

  hidApi.onBattery((bat) => {
    const p = Number(bat?.batteryPercent);

    if (!Number.isFinite(p) || p < 0) {
      if (hdrBatteryVal) {
        hdrBatteryVal.textContent = "...";
        hdrBatteryVal.classList.remove("connected");
      }
      renderTopDeviceMeta(true, currentDeviceName || "已连接", "");
      return;
    }

    const batteryText = `${p}%`;
    if (hdrBatteryVal) {
      hdrBatteryVal.textContent = batteryText;
      hdrBatteryVal.classList.add("connected");
    }


    currentBatteryText = batteryText;
    updateDeviceStatus(true, currentDeviceName || "已连接", batteryText, currentFirmwareText || "");

    log(`收到电量包:${p}%`);
  });

  hidApi.onRawReport((raw) => {

  });


  /**
   * 等待下一次配置回包。
   * 目的：统一等待与超时处理，避免监听泄漏。
   * @param {any} timeoutMs - 参数 timeoutMs。
   * @returns {any} 返回结果。
   */
  function waitForNextConfig(timeoutMs = 1600) {
    return new Promise((resolve, reject) => {
      let done = false;

      const off = hidApi.onConfig((cfg) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        try { off(); } catch {}
        resolve(cfg);
      }, { replay: false });
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        try { off(); } catch {}
        reject(new Error("未收到配置回包（鼠标可能未开机/未配对/未连接）。"));
      }, timeoutMs);
    });
  }


  /**
   * 等待下一次电量回包。
   * 目的：统一等待与超时处理，避免监听泄漏。
   * @param {any} timeoutMs - 参数 timeoutMs。
   * @returns {any} 返回结果。
   */
  function waitForNextBattery(timeoutMs = 1600) {
    return new Promise((resolve, reject) => {
      let done = false;
      const off = hidApi.onBattery((bat) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        try { off(); } catch {}
        resolve(bat);
      });
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        try { off(); } catch {}
        reject(new Error("未收到电量回包（鼠标可能未开机/未配对/未连接）。"));
      }, timeoutMs);
    });
  }


  // ============================================================
  // 5) WebHID 连接编排（运行期而非设备逻辑）
  // ============================================================
  /**
   * 建立 HID 连接并完成配置拉取。
   * 目的：统一握手流程与状态清理，避免并发连接冲突。
   * @param {any} mode - 参数 mode。
   * @param {any} isSilent - 参数 isSilent。
   * @returns {Promise<any>} 异步结果。
   */
  async function connectHid(mode = false, isSilent = false) {

    if (__connectInFlight) {
      __connectPending = { mode, isSilent };
      return;
    }
    __connectInFlight = true;
    __clearOnboardMemoryAutoEnableCheck();
    try {
      if (hidConnecting) return;
      if (isHidOpened()) return;

      try {
        if (!navigator.hid) throw new Error("当前浏览器不支持 WebHID。");

      let dev = null;
      let candidates = [];
      let detectedType = null;

      const pinPrimary = (mode === true);

      if (mode === true) __armManualConnectGuard(3000);

      try {
        const res = await DeviceRuntime.connect(mode, {
          primaryDevice: __autoDetectedDevice,
          preferredType: DeviceRuntime?.getSelectedDevice?.(),
          pinPrimary,
        });
        if (mode === true) __armManualConnectGuard(3000);
        dev = res?.device || null;
        candidates = Array.isArray(res?.candidates) ? res.candidates : [];
        detectedType = res?.detectedType || null;
      } catch (e) {
        if (mode === true) {
          try { __reverseLandingToInitial(__landingClickOrigin); } catch (_) {}
        }
        return;
      }

      if (!dev) {
        if (mode === true) {
          try { __reverseLandingToInitial(__landingClickOrigin); } catch (_) {}
        }
        return;
      }

      const currentType = DeviceRuntime.getSelectedDevice();
      if (detectedType && detectedType !== currentType) {
        console.log(`[AutoSwitch] switching to ${detectedType} (from ${currentType})...`);
        DeviceRuntime.setSelectedDevice(detectedType, { reload: true });
        return;
      }

      if (!candidates.length) candidates = [dev];

      hidConnecting = true;
      hidLinked = false;
      if (!isSilent) __setLandingCaption("INITIATE SYNCHRONIZATION...");


      /**
       * 处理perform、handshake逻辑。
       * 目的：统一处理perform、handshake相关流程，保证行为一致。
       * [优化] 将"视觉进场"与"数据握手"解耦并行，提升用户体验。
       * @param {any} targetDev - 参数 targetDev。
       * @returns {Promise<any>} 异步结果。
       */
      const performHandshake = async (targetDev) => {
        if (!targetDev) throw new Error("No HID device selected.");

        // 1. 先关闭旧连接
        try {
          if (targetDev.opened) {
            await targetDev.close();
            // [优化] 减少硬编码等待，微任务队列足够处理关闭清理
            await new Promise(r => setTimeout(r, 50));
          }
        } catch (_) {}

        hidApi.device = targetDev;
        try { applyCapabilitiesToUi(hidApi.capabilities); } catch {}

        // 2. 打开设备
        await hidApi.open();
        // [优化] 减少握手前等待，从 200ms 降至 50ms
        await new Promise(r => setTimeout(r, 50));

        let displayName = ProtocolApi.resolveMouseDisplayName(targetDev.vendorId, targetDev.productId, targetDev.productName || "HID Device");
        console.log("HID Open, Handshaking:", displayName);

        __writesEnabled = false;
        __resetFirstConfigAppliedGate();
        __armOnboardMemoryAutoEnableCheck();

        // ============================================================
        // [核心优化逻辑] 
        // 这里的改动将"等待配置"和"进入主页"改为并行执行
        // ============================================================
        
        // 3. 立即触发 UI 进场（视觉欺骗）：
        // 不等待 Config 回包，直接解除 Landing 页面的锁定。
        // 利用进场动画的 1.5~2秒 时间在后台加载数据，用户感知就是"秒进"。
        
        if (document.body.classList.contains("landing-active")) {
            // 解除对 __firstConfigAppliedPromise 的强依赖
            window.__LANDING_ENTER_GATE_PROMISE__ = Promise.resolve(); 
            
            // 立即开始动画
            enterAppWithLiquidTransition(__landingClickOrigin);
            
            // 更新 UI 状态为"连接中"，避免显示空白数据
            if (widgetDeviceName) widgetDeviceName.textContent = displayName;
            if (widgetDeviceMeta) widgetDeviceMeta.textContent = "正在读取配置...";
        }

        // 4. 后台并行请求数据
        // 使用 Promise.allSettled 避免某个请求失败导致整个流程卡死
        
        // 启动配置请求（不 await 也不阻塞 UI 线程）
        const configTask = (async () => {
             // 关键：先挂一次性监听，再发请求，避免错过同一轮 onConfig 回包
             const nextConfig = waitForNextConfig(2500);
             const requested = await requestDeviceConfig();
             if (!requested) throw new Error("requestConfig unavailable");
             return await nextConfig; // 维持原有超时
        })();

        // 5. 等待数据返回并刷新 UI
        try {
            const cfg = await configTask;
            applyConfigToUi(cfg);
            const cfgDeviceName = String(cfg?.deviceName || "").trim();
            if (cfgDeviceName) {
                displayName = cfgDeviceName;
                if (widgetDeviceName) widgetDeviceName.textContent = displayName;
            }
            // 数据加载完成，更新 UI 提示
            if (widgetDeviceMeta) widgetDeviceMeta.textContent = "点击断开";
            if (typeof updatePollingCycleUI === "function") {
                // 强制刷新一次 UI 动画状态以确保数据同步
                const rate = readStandardValueWithIntent(cfg, "keyScanningRate") || 1000;
                updatePollingCycleUI(rate, false);
              }
        } catch (e) {
            console.warn("Config load delayed or failed, using defaults:", e);
            const recoveredName = String(getCachedDeviceConfig()?.deviceName || currentDeviceName || "").trim();
            if (recoveredName) {
                displayName = recoveredName;
                if (widgetDeviceName) widgetDeviceName.textContent = displayName;
            }
            // 即使配置失败，因为设备已 open，我们依然保持连接状态，
            // 允许用户后续手动点击刷新，而不是把用户踢回 Landing 页。
        }

        __writesEnabled = true;

        // 应用键位映射
        if (typeof applyKeymapFromCfg === 'function') {
          const cachedCfg = getCachedDeviceConfig();
          if (cachedCfg) applyKeymapFromCfg(cachedCfg);
        }
        return displayName;
      };


      let lastErr = null;
      let displayName = "";
      let chosenDev = null;

      for (const cand of candidates) {
        for (let i = 0; i < 2; i++) {
          try {
            if (i > 0) {
              try {

                await hidApi.close?.({ clearListeners: false });
              } catch (_) {
                try { await hidApi.close?.(); } catch (_) {}
              }
              await new Promise(r => setTimeout(r, 500));
            }

            displayName = await performHandshake(cand);
            chosenDev = cand;
            break;
          } catch (err) {
            lastErr = err;
            console.warn(`Handshake failed (cand=${cand?.vendorId?.toString?.(16)}:${cand?.productId?.toString?.(16)} attempt=${i+1}):`, err);
          }
        }
        if (displayName) break;


        try {
          await hidApi.close?.({ clearListeners: false });
        } catch (_) {
          try { await hidApi.close?.(); } catch (_) {}
        }
        await new Promise(r => setTimeout(r, 120));
      }

      if (!displayName) throw lastErr;


      hidLinked = true;
      hidConnecting = false;
      currentDeviceName = displayName;


      requestBatterySafe("connect");

      setHeaderChipsVisible(true);
      if (hdrBatteryVal) {
        hdrBatteryVal.textContent = currentBatteryText || "-";
        hdrBatteryVal.classList.toggle("connected", !!currentBatteryText);
      }
      if (hdrHidVal) {
        hdrHidVal.textContent = `已连接 · ${displayName}`;
        hdrHidVal.classList.add("connected");
      }
      updateDeviceStatus(true, displayName, currentBatteryText || "", currentFirmwareText || "");

      if (chosenDev) dev = chosenDev;

      const finalDev = chosenDev || dev;
      __autoDetectedDevice = finalDev;
      saveLastHidDevice(finalDev);
      startBatteryAutoRead();

      // [优化] UI 进场逻辑已移至 performHandshake 内部，实现并行加载
      // 此处不再需要重复处理

    } catch (err) {
      __clearOnboardMemoryAutoEnableCheck();
      hidConnecting = false;
      hidLinked = false;
      try { await hidApi.close(); } catch {}
      updateDeviceStatus(false);
      __applyDeviceVariantOnce({ keymapOnly: true });
      stopBatteryAutoRead();
      resetHeaderChipValues();
      setHeaderChipsVisible(false);

      logErr(err, "连接失败");
      try { document.body.classList.remove("landing-charging", "landing-holding", "landing-drop", "landing-system-ready", "landing-ready-out", "landing-reveal"); } catch (_) {}
      try { if (__triggerZone) __triggerZone.style.pointerEvents = ""; } catch (_) {}
       __setLandingCaption("CONNECTION SEVERED");


      if (!isSilent && err && err.message && !err.message.includes("cancel")) {
         alert(`连接失败：${err.message}\n请尝试重新插拔设备或重启页面。`);
      }
    }
  } finally {
    __connectInFlight = false;
    const pend = __connectPending;
    __connectPending = null;

    if (pend && !hidConnecting && !isHidOpened()) {
      setTimeout(() => connectHid(pend.mode, pend.isSilent), 0);
    }
  }


  }


  /**
   * 断开HID。
   * 目的：集中释放连接资源并同步 UI，避免残留状态。
   * @returns {Promise<any>} 异步结果。
   */
  async function disconnectHid() {
    if (!hidApi || !hidApi.device) return;
    try {

      __clearOnboardMemoryAutoEnableCheck();
      __connectPending = null;
      hidConnecting = false;
      hidLinked = false;

      await hidApi.close();
      hidApi.device = null;
      __autoDetectedDevice = null;


      updateDeviceStatus(false);
      __applyDeviceVariantOnce({ keymapOnly: true });
      stopBatteryAutoRead();
      resetHeaderChipValues();
      setHeaderChipsVisible(false);

      log("HID 已断开");

      try { showLanding("disconnect"); } catch (_) {}
    } catch (err) {
      logErr(err, "断开失败");
    }
  }

  disconnectBtn?.addEventListener("click", async () => {
    if (!isHidOpened()) return;
    if (!confirm("确定要断开当前设备连接吗?")) return;
    await disconnectHid();
  });


  updateDeviceStatus(false);

  try { showLanding("init"); } catch (_) {}


  /**
   * 初始化自动流程。
   * 目的：统一连接流程并处理并发保护，避免重复连接或状态错乱。
   * @returns {Promise<any>} 异步结果。
   */
  const initAutoConnect = async () => {
      const detectedDev = await autoConnectHidOnce();
      if (detectedDev) {
        connectHid(detectedDev, true);
      }
  };


  /**
   * 内部处理run、heavy逻辑。
   * 目的：统一处理run、heavy相关流程，保证行为一致。
   * @param {any} task - 参数 task。
   * @returns {any} 返回结果。
   */
  const __runHeavyTaskSafely = (task) => {
    const landingVisible = !!(__landingLayer && __landingLayer.getAttribute("aria-hidden") !== "true");
    if (landingVisible) {
      try { __landingFx?.pause?.(true); } catch (_) {}
    }
    return Promise.resolve()
      .then(task)
      .catch(() => {})
      .finally(() => {
        if (landingVisible) {
          try { __landingFx?.pause?.(false); } catch (_) {}
        }
      });
  };


  if ("requestIdleCallback" in window) {

    if (!window.__HID_EVENT_HOOKED__ && navigator.hid?.addEventListener) {
      window.__HID_EVENT_HOOKED__ = true;
      navigator.hid.addEventListener("disconnect", (e) => {
        try {
          const api = window.__HID_API_INSTANCE__;
          if (api?.device && e?.device === api.device) {
            disconnectHid().catch(() => {});
          }
        } catch {}
      });

      navigator.hid.addEventListener("connect", (e) => {

         if (__isManualConnectGuardOn()) return;

         // [优化] 缩短延迟，快速响应用户操作
         setTimeout(() => {
             if (!isHidOpened()) __runHeavyTaskSafely(initAutoConnect);
         }, 150);
      });
    }
    requestIdleCallback(() => __runHeavyTaskSafely(initAutoConnect), { timeout: 1600 });
  } else {
    setTimeout(() => __runHeavyTaskSafely(initAutoConnect), 300);
  }


  if (adapterFeatures.supportsBatteryRequest !== false) {
    setTimeout(() => __runHeavyTaskSafely(() => requestBatterySafe("页面进入")), 1400);
  }

  log("页面已加载。点击页面顶部设备卡片开始连接设备。");


  const sidebar = document.querySelector('.sidebar');
  const NAV_COLLAPSE_KEY = "mouse_console_nav_collapsed";
  const NAV_COLLAPSE_RATIO_BASE = 1.7;
  const NAV_COLLAPSE_MIN_WIDTH = 980;
  const NAV_COLLAPSE_MAX_WIDTH = 1480;
  const NAV_TRANSITIONING_CLASS = "nav-transitioning";
  const NAV_TRANSITION_TIMEOUT_MS = 760;
  let sidebarTimer = null;
  let __navRafId = 0;
  let __navPreferredCollapsed = null;
  let __navLastIsNarrow = null;
  let __navTransitionTimer = null;

  const readNavCollapsedPreference = () => {
    try {
      const raw = localStorage.getItem(NAV_COLLAPSE_KEY);
      if (raw === "1") return true;
      if (raw === "0") return false;
    } catch (_) {}
    return null;
  };

  const writeNavCollapsedPreference = (collapsed) => {
    try {
      localStorage.setItem(NAV_COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch (_) {}
  };

  const getAdaptiveCollapseWidth = () => {
    const height = Math.max(1, Number(window.innerHeight || 0));
    const byRatio = Math.round(height * NAV_COLLAPSE_RATIO_BASE);
    return Math.max(NAV_COLLAPSE_MIN_WIDTH, Math.min(NAV_COLLAPSE_MAX_WIDTH, byRatio));
  };

  const isNarrowViewport = () => {
    const width = Number(window.innerWidth || 0);
    if (width <= 0) return false;
    return width <= getAdaptiveCollapseWidth();
  };

  const clearNavTransitioning = () => {
    if (__navTransitionTimer) {
      clearTimeout(__navTransitionTimer);
      __navTransitionTimer = null;
    }
    document.body.classList.remove(NAV_TRANSITIONING_CLASS);
  };

  const markNavTransitioning = () => {
    document.body.classList.add(NAV_TRANSITIONING_CLASS);
    if (__navTransitionTimer) clearTimeout(__navTransitionTimer);
    __navTransitionTimer = setTimeout(() => {
      __navTransitionTimer = null;
      document.body.classList.remove(NAV_TRANSITIONING_CLASS);
    }, NAV_TRANSITION_TIMEOUT_MS);
  };


  /**
   * 设置导航。
   * 目的：提供统一读写入口，降低耦合。
   * @param {any} collapsed - 参数 collapsed。
   * @returns {any} 返回结果。
   */
  const setNavCollapsed = (collapsed) => {
    if (__navRafId) cancelAnimationFrame(__navRafId);
    const nextCollapsed = !!collapsed;
    const prevCollapsed = document.body.classList.contains('nav-collapsed');
    if (prevCollapsed === nextCollapsed) return;
    markNavTransitioning();
    __navRafId = requestAnimationFrame(() => {
      __navRafId = 0;
      document.body.classList.toggle('nav-collapsed', nextCollapsed);
      if (document.body.classList.contains("page-basic") && typeof __startLineAnimation === "function") {
        __startLineAnimation(720);
      }
    });
  };
  /**
   * 处理导航逻辑。
   * 目的：统一处理导航相关流程，保证行为一致。
   * @returns {any} 返回结果。
   */
  const applyNavCollapsedPolicy = (force = false) => {
    const isNarrow = isNarrowViewport();
    if (!force && __navLastIsNarrow === isNarrow) return;
    __navLastIsNarrow = isNarrow;
    const shouldCollapse = isNarrow ? true : (__navPreferredCollapsed ?? false);
    setNavCollapsed(shouldCollapse);
  };

  const toggleNavCollapsed = () => {
    const nextCollapsed = !document.body.classList.contains('nav-collapsed');
    __navPreferredCollapsed = nextCollapsed;
    writeNavCollapsedPreference(nextCollapsed);
    setNavCollapsed(nextCollapsed);
  };

  if (sidebar) {
    __navPreferredCollapsed = readNavCollapsedPreference();
    applyNavCollapsedPolicy(true);


    sidebar.addEventListener('transitionend', (e) => {
      if (!e || e.target !== sidebar) return;
      if (e.propertyName !== 'width') return;
      clearNavTransitioning();
      window.dispatchEvent(new Event('resize'));
    });

    sidebar.addEventListener('transitioncancel', (e) => {
      if (!e || e.target !== sidebar) return;
      if (e.propertyName !== 'width') return;
      clearNavTransitioning();
    });

    window.addEventListener('resize', () => {
      if (sidebarTimer) clearTimeout(sidebarTimer);
      sidebarTimer = setTimeout(() => {
        sidebarTimer = null;
        applyNavCollapsedPolicy(false);
      }, 120);
    }, { passive: true });


    const sidebarToggle = document.getElementById('sidebarToggle');
    if (sidebarToggle) {
      sidebarToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleNavCollapsed();

      });
    }
  }

})();
