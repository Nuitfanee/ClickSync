
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
  const adapterKeyMap = adapter?.keyMap || {};
  const adapterTransforms = adapter?.transforms || {};
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
  // 2) 适配器 Key 翻译辅助
  // ============================================================
  /**
   * 解析标准 Key 对应的固件 Key 列表。
   * 目的：统一多 Key 回退与兼容顺序，避免分散判断。
   * @param {any} key - 参数 key。
   * @returns {any} 返回结果。
   */
  const resolveStandardKeys = (key) => {
    const map = adapterKeyMap?.[key];
    if (!map) return [];
    if (Array.isArray(map)) return map.filter(Boolean);
    return [map];
  };


  /**
   * 读取标准 Key 的配置值。
   * 目的：屏蔽协议字段差异，保证 UI 读取一致性。
   * @param {any} cfg - 参数 cfg。
   * @param {any} key - 参数 key。
   * @returns {any} 返回结果。
   */
  const readStandardValue = (cfg, key) => {
    if (!cfg) return undefined;
    const st = cfg?.deviceState || cfg?.state || {};
    const keys = resolveStandardKeys(key);
    let raw;
    for (const k of keys) {
      if (st && st[k] !== undefined) { raw = st[k]; break; }
      if (cfg && cfg[k] !== undefined) { raw = cfg[k]; break; }
    }
    const transform = adapterTransforms?.[key]?.read;
    return transform ? transform(raw, { cfg, state: st, adapter }) : raw;
  };


  // ============================================================
  // 3) Landing 层与过渡编排（仅 UI）
  // ============================================================
  const __landingLayer = document.getElementById("landing-layer");
  const __appLayer = document.getElementById("app-layer");
  const __landingCaption = document.getElementById("landingCaption") || __landingLayer?.querySelector(".center-caption");
  const __triggerZone = document.getElementById("trigger-zone");
  const __landingCanvas = document.getElementById("surreal-canvas");
  const __landingLiquid = __landingLayer?.querySelector(".liquid-overlay");


  /**
   * 内部应用设备。
   * 目的：集中应用配置，确保入口一致。
   * @returns {any} 返回结果。
   */
  function __applyDeviceVariantOnce() {

    try {
      const registry = window.DeviceAdapters;
      const adapter = registry?.getAdapter?.(DEVICE_ID) || registry?.getAdapter?.(SELECTED_DEVICE);
      window.DeviceUI?.applyVariant?.({
        deviceId: DEVICE_ID,
        adapter,
        root: document,
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

    const baseLayer = container.querySelector('.shutter-bg-base');
    const nextLayer = container.querySelector('.shutter-bg-next');
    const textEl = container.querySelector('.cycle-text');
    const selectEl = document.getElementById('rapooPollingSelectAdv');

    const colorClass = RATE_COLORS[rate] || RATE_COLORS[1000];
    const displayRate = rate >= 1000 ? (rate / 1000) + 'k' : rate;

    if (!animate) {
      baseLayer.className = 'shutter-bg-base ' + colorClass;
      textEl.textContent = displayRate;
      if (selectEl) selectEl.value = rate;
      return;
    }


    nextLayer.className = 'shutter-bg-next ' + colorClass;


    container.classList.add('is-animating');


    setTimeout(() => {
      textEl.textContent = displayRate;

      baseLayer.className = 'shutter-bg-base ' + colorClass;

      container.classList.remove('is-animating');

      if (selectEl) selectEl.value = rate;
    }, 500);
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
      const currentHz = Number(selectEl?.value || 1000);
      let nextIdx = POLLING_RATES.indexOf(currentHz) + 1;
      if (nextIdx >= POLLING_RATES.length) nextIdx = 0;

      const nextHz = POLLING_RATES[nextIdx];


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
      if (!container) return;

      const baseLayer = container.querySelector('.shutter-bg-base');
      const nextLayer = container.querySelector('.shutter-bg-next');
      const textEl = container.querySelector('.cycle-text');

      const opt = options.find(o => o.val === value) || options[0];
      const colorClass = opt.cls;

      if (!animate) {

          baseLayer.className = 'shutter-bg-base ' + colorClass;
          textEl.textContent = opt.label;
          container.dataset.value = value;
          return;
      }


      nextLayer.className = 'shutter-bg-next ' + colorClass;
      container.classList.add('is-animating');

      setTimeout(() => {
          textEl.textContent = opt.label;
          baseLayer.className = 'shutter-bg-base ' + colorClass;
          container.classList.remove('is-animating');
          container.dataset.value = value;
      }, 500);
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
              const cur = Number(btn.dataset.value || 0);
              const curIdx = options.findIndex(o => o.val === cur);

              const nextIdx = (curIdx + 1) % options.length;
              const nextVal = options[nextIdx].val;


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
   * 内部重置Landing。
   * 目的：集中管理 Landing 状态切换与动画时序，避免交互状态冲突。
   * @returns {any} 返回结果。
   */
  function __resetLandingLiquidInstant() {
    if (!__landingLiquid) return;


    const prevTransition = __landingLiquid.style.transition;
    const prevDelay = __landingLiquid.style.transitionDelay;

    __landingLiquid.style.transition = "none";
    __landingLiquid.style.transitionDelay = "0s";
    __landingLiquid.style.opacity = "1";
    __landingLiquid.style.clipPath = "circle(0% at 50% 50%)";


    void __landingLiquid.offsetHeight;

    __landingLiquid.style.clipPath = "";
    __landingLiquid.style.transition = prevTransition || "";
    __landingLiquid.style.transitionDelay = prevDelay || "";
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
  const langBtn = $("#langBtn");
  const themeBtn = $("#themeBtn");
  const themePath = $("#themePath");


  initXSelects();


  const deviceWidget = $("#deviceWidget");
  const deviceStatusDot = $("#deviceStatusDot");
  const widgetDeviceName = $("#widgetDeviceName");
  const widgetDeviceMeta = $("#widgetDeviceMeta");


  let currentDeviceName = "";
  let currentBatteryText = "";
  let currentFirmwareText = "";


  let hidLinked = false;
  let hidConnecting = false;


  let batteryTimer = null;


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
      : 60_000;
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
    } else {
      deviceStatusDot?.classList.remove("connected");
      if (widgetDeviceName) widgetDeviceName.textContent = "未连接设备";
      if (widgetDeviceMeta) widgetDeviceMeta.textContent = "点击连接";
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

    const dark = false;
    document.body.classList.toggle("dark", dark);


    themePath?.setAttribute(
      "d",
      "M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"
    );
  }


  applyTheme("light");


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

    const footNote = $("#footNote");
    if (footNote) footNote.innerHTML = `© <span id="year">${new Date().getFullYear()}</span> · ${pack.foot}`;
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
  }

  applyLang(savedLang);
  langBtn?.addEventListener("click", () => {
    const cur = document.documentElement.lang.startsWith("en") ? "en" : "zh";
    const next = cur === "zh" ? "en" : "zh";
    localStorage.setItem(LANG_KEY, next);
    applyLang(next);
  });


  const sidebarItems = $$(".sidebar .nav-item");


  /**
   * 设置active、by。
   * 目的：提供统一读写入口，降低耦合。
   * @returns {any} 返回结果。
   */
  function setActiveByHash() {
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

  /**
   * 同步basic、monolith。
   * 目的：保持状态一致性，避免局部更新遗漏。
   * @returns {any} 返回结果。
   */
  function syncBasicMonolithUI() {
    const root = document.getElementById("basicMonolith");
    if (!root) return;

    const perf = document.querySelector('input[name="perfMode"]:checked')?.value || "low";
    const hz = document.getElementById("pollingSelect")?.value || "1000";


    __basicActiveModeEl = null;
    __basicModeItems.forEach((el) => {
      const on = el.dataset.perf === perf;
      el.classList.toggle("active", on);
      if (on) __basicActiveModeEl = el;
    });


    __basicActiveHzEl = null;
    __basicHzItems.forEach((el) => {
      const on = String(el.dataset.hz) === String(hz);
      el.classList.toggle("active", on);
      if (on) __basicActiveHzEl = el;
    });


    const ticker = document.getElementById("basicHzTicker");
    if (ticker) ticker.innerHTML = '<span class="ticker-label">轮询率：</span>' + String(hz) + " HZ";

    const st = document.getElementById("basicStatusText");
    const cfg = __basicModeConfig[perf] || __basicModeConfig.low;
    if (st) st.textContent = cfg.text;


    if (document.body.classList.contains("page-basic")) {
      document.documentElement.style.setProperty("--theme-color", cfg.color);
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
   * 内部处理basic、bind逻辑。
   * 目的：统一处理basic、bind相关流程，保证行为一致。
   * @param {any} el - 参数 el。
   * @param {any} handler - 参数 handler。
   * @returns {any} 返回结果。
   */
  function __basicBindItem(el, handler) {
    el.addEventListener("click", (e) => {
      const t = e.target;

      if (t && (t.closest('input[name="perfMode"]') || t.closest('#pollingSelect'))) {
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

    __basicModeItems = Array.from(root.querySelectorAll("#basicModeColumn .basicItem[data-perf]"));
    __basicHzItems = Array.from(root.querySelectorAll("#basicHzColumn .basicItem[data-hz]"));
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
      const w = Math.max(1, window.innerWidth || 1);
      const h = Math.max(1, window.innerHeight || 1);
      __basicSvgLayer.setAttribute("viewBox", `0 0 ${w} ${h}`);
      __basicSvgLayer.setAttribute("preserveAspectRatio", "none");
    };
    syncSvgBox();
    window.addEventListener("resize", syncSvgBox);

    __basicModeItems.forEach((el) => {
      __basicBindItem(el, () => __basicSetPerf(el.dataset.perf));
    });
    __basicHzItems.forEach((el) => {
      __basicBindItem(el, () => __basicSetHz(el.dataset.hz));
    });


    document.getElementById("pollingSelect")?.addEventListener("change", syncBasicMonolithUI);
    document.querySelectorAll('input[name="perfMode"]').forEach((r) => {
      r.addEventListener("change", syncBasicMonolithUI);
    });


    /**
     * 处理client、to逻辑。
     * 目的：处理指针交互与坐标映射，保证拖拽/命中判断准确。
     * @param {any} x - 参数 x。
     * @param {any} y - 参数 y。
     * @returns {any} 返回结果。
     */
    const clientToSvg = (x, y) => {
      if (!__basicSvgLayer || !__basicSvgLayer.getScreenCTM) return { x, y };
      const ctm = __basicSvgLayer.getScreenCTM();
      if (!ctm) return { x, y };
      const inv = ctm.inverse();

      try {
        const p = new DOMPoint(x, y).matrixTransform(inv);
        return { x: p.x, y: p.y };
      } catch (_) {
        const pt = __basicSvgLayer.createSVGPoint();
        pt.x = x;
        pt.y = y;
        const p = pt.matrixTransform(inv);
        return { x: p.x, y: p.y };
      }
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
      return { x, y };
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

      const a = getAttachPoint(__basicActiveModeEl, "left");
      const b = getAttachPoint(__basicActiveHzEl, "right");
      if (a && b) {
        const A = clientToSvg(a.x, a.y);
        const B = clientToSvg(b.x, b.y);

        const dx = Math.max(40, Math.abs(B.x - A.x) * 0.15);
        const d = `M ${A.x.toFixed(2)} ${A.y.toFixed(2)} C ${(A.x + dx).toFixed(2)} ${A.y.toFixed(2)}, ${(B.x - dx).toFixed(2)} ${B.y.toFixed(2)}, ${B.x.toFixed(2)} ${B.y.toFixed(2)}`;


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


    __startLineAnimation = startLineAnimation;


    window.addEventListener("resize", () => startLineAnimation(100));


    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        sidebar.addEventListener('transitionend', () => startLineAnimation(100));
    }


    startLineAnimation(100);


    syncBasicMonolithUI();
  }


  let __advancedPanelInited = false;

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
          if (key) location.hash = "#" + key;
      });
  });


  window.removeEventListener("hashchange", setActiveByHash);
  window.addEventListener("hashchange", setActiveByHash);
  setActiveByHash();
  initBasicMonolithUI();
  initAdvancedPanelUI();


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
    log("未找到 ProtocolApi：请确认 protocol_api_chaos.js / protocol_api_rapoo.js 已正确加载。");
    return;
  }


  let hidApi = window.__HID_API_INSTANCE__;
  if (!hidApi) {
    hidApi = new ProtocolApi.MouseMouseHidApi();
    window.__HID_API_INSTANCE__ = hidApi;
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


  const fn =
    hidApi.requestConfig ||
    hidApi.requestConfiguration ||
    hidApi.getConfig ||
    hidApi.readConfig ||
    hidApi.requestDeviceConfig;

  if (typeof fn !== "function") {

    log("当前 ProtocolApi 未暴露配置读取接口，无法读取设备配置。");
    return;
  }

  try {
    await fn.call(hidApi);
    if (reason) log(`已请求配置(${reason})`);


    await requestBatterySafe("config");
  } catch (e) {
    logErr(e, "请求配置失败");
  }
}


hidApi.onConfig((cfg) => {
  try {
    applyConfigToUi(cfg);

    hidLinked = true;


    __writesEnabled = true;


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
   * 处理HID、设备逻辑。
   * 目的：统一处理HID、设备相关流程，保证行为一致。
   * @returns {any} 返回结果。
   */
  const loadLastHidDevice = () => {
    try { return DeviceRuntime?.loadLastHidDevice?.(); } catch (_) { return null; }
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
      const saved = loadLastHidDevice();
      const res = await DeviceRuntime?.autoConnect?.({
        preferredType: DeviceRuntime?.getSelectedDevice?.(),
        savedDevice: saved,
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

  const DPI_ABS_MIN = 100;
  const DPI_ABS_MAX = 44000;
  let DPI_UI_MAX = 26000;
  const DPI_STEP = 50;


let __capabilities = {
  dpiSlotCount: 6,
  maxDpi: DPI_UI_MAX,
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


  const next = {
    dpiSlotCount: Number.isFinite(Number(incoming.dpiSlotCount)) ? Math.trunc(Number(incoming.dpiSlotCount)) : (prevCap.dpiSlotCount ?? 6),
    maxDpi: Number.isFinite(Number(incoming.maxDpi)) ? Math.trunc(Number(incoming.maxDpi)) : (prevCap.maxDpi ?? DPI_UI_MAX),
    pollingRates: Array.isArray(incoming.pollingRates)
      ? incoming.pollingRates.map(Number).filter(Number.isFinite)
      : (prevCap.pollingRates ?? null),
  };

  __capabilities = next;


  if (Number.isFinite(next.maxDpi) && next.maxDpi > 0) {
    DPI_UI_MAX = next.maxDpi;


    DPI_MAX_OPTIONS = makeSeq(4000, DPI_UI_MAX, 4000);
    if (DPI_MAX_OPTIONS[DPI_MAX_OPTIONS.length - 1] !== DPI_UI_MAX) {
      DPI_MAX_OPTIONS.push(DPI_UI_MAX);
    }

    if (dpiMaxSelect) {
      const current = Number(dpiMaxSelect.value || 16000);
      fillSelect(dpiMaxSelect, DPI_MAX_OPTIONS, Math.min(current || 16000, DPI_UI_MAX));
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


  const pollingSel = $("#pollingSelect");
  if (pollingSel && Array.isArray(next.pollingRates) && next.pollingRates.length) {
    const cur = Number(pollingSel.value || next.pollingRates[0]);


    pollingSel.innerHTML = next.pollingRates
      .map((hz) => `<option value="${hz}">${hz}Hz</option>`)
      .join("");


    let validVal = cur;
    if (!next.pollingRates.includes(cur)) {
        validVal = next.pollingRates.includes(1000) ? 1000 : next.pollingRates[0];
    }
    safeSetValue(pollingSel, validVal);


    if (__basicHzItems && __basicHzItems.length) {

      const allowed = new Set(next.pollingRates.map(String));

      __basicHzItems.forEach((el) => {
        const h = el.dataset.hz;
        if (allowed.has(String(h))) {
          el.style.display = "";
        } else {
          el.style.display = "none";
        }
      });


      syncBasicMonolithUI();
    }
  }


  if (typeof buildDpiEditor === "function") {
    const needRebuild = (Number(prevCap?.dpiSlotCount) || 6) !== capSlots;
    if (needRebuild) buildDpiEditor();
  }
}


  const DPI_MIN_OPTIONS = [
    100, 200, 400, 800, 1200, 1600,
  ];


  /**
   * 生成seq。
   * 目的：统一处理seq相关流程，保证行为一致。
   * @param {any} start - 参数 start。
   * @param {any} end - 参数 end。
   * @param {any} step - 参数 step。
   * @returns {any} 返回结果。
   */
  function makeSeq(start, end, step) {
    const out = [];
    for (let v = start; v <= end; v += step) out.push(v);
    return out;
  }
  let DPI_MAX_OPTIONS = makeSeq(4000, DPI_UI_MAX, 4000);
  if (DPI_MAX_OPTIONS[DPI_MAX_OPTIONS.length - 1] !== DPI_UI_MAX) {
    DPI_MAX_OPTIONS.push(DPI_UI_MAX);
  }

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

  /**
   * 处理DPI逻辑。
   * 目的：保持 DPI 数值与槽位状态一致，避免错位或跳变。
   * @returns {any} 返回结果。
   */
  function normalizeDpiMinMax() {
    if (!dpiMinSelect || !dpiMaxSelect) return;
    let { min, max } = getDpiMinMax();


    if (!Number.isFinite(max) || max <= 0) max = DPI_UI_MAX;
    max = Math.max(4000, Math.min(DPI_UI_MAX, max));


    if (!Number.isFinite(min) || min <= 0) min = 100;


    const minCap = max - DPI_STEP;


    min = Math.max(DPI_ABS_MIN, Math.min(min, minCap));


    if (min >= max) {
       max = min + DPI_STEP;

       if (max > DPI_UI_MAX) {
          max = DPI_UI_MAX;
          min = max - DPI_STEP;
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
    for (let i = 1; i <= getDpiSlotCap(); i++) {
      const range = $("#dpiRange" + i);
      const num = $("#dpiInput" + i);
      if (range) {
        range.min = String(min);
        range.max = String(max);
        range.step = String(DPI_STEP);
      }
      if (num) {
        num.min = String(min);
        num.max = String(max);
        num.step = String(DPI_STEP);
      }
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


  let uiCurrentDpiSlot = 1;
  let dpiAnimReady = false;


  let dpiBubbleListenersReady = false;
  let dpiDraggingSlot = null;
  let dpiDraggingEl = null;


  let dpiRowDragState = null;
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
   * 更新DPI、气泡提示。
   * 目的：保持 DPI 数值与槽位状态一致，避免错位或跳变。
   * @param {any} slot - 参数 slot。
   * @returns {any} 返回结果。
   */
  function updateDpiBubble(slot) {
    const range = $("#dpiRange" + slot);
    const bubble = getDpiBubble(slot);
    if (!range || !bubble) return;

    const val = Number(range.value);
    const valEl = bubble.querySelector(".dpiBubbleVal");
    if (valEl) valEl.textContent = String(val);

    const min = Number(range.min);
    const max = Number(range.max);
    const denom = (max - min) || 1;
    const pct = (val - min) / denom;

    const rangeRect = range.getBoundingClientRect();


    const cssThumb = parseFloat(getComputedStyle(range).getPropertyValue("--dpiThumb"));
    const thumb = Number.isFinite(cssThumb) && cssThumb > 0 ? cssThumb : 22;

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
  function showDpiBubble(slot) {
    const bubble = getDpiBubble(slot);
    if (!bubble) return;
    bubble.classList.add("show");
    requestAnimationFrame(() => updateDpiBubble(slot));
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


    const sum = $("#dpiSummary");
    if (sum) sum.textContent = `当前:${s} 档 · 共 ${slotCount} 档`;

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

      const range = $("#dpiRange" + i);
      const num = $("#dpiInput" + i);
      if (range) range.disabled = hidden;
      if (num) num.disabled = hidden;
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
    fillSelect(dpiMinSelect, DPI_MIN_OPTIONS, 100);
    fillSelect(dpiMaxSelect, DPI_MAX_OPTIONS, 16000);
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
      for (let i = 1; i <= 6; i++) {
        const num = $("#dpiInput" + i);
        const range = $("#dpiRange" + i);
        if (!num || !range) continue;
        const v = clamp(num.value, min, max);
        safeSetValue(num, v);
        safeSetValue(range, v);
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

    for (let i = 1; i <= dpiSlotCap; i++) {
      const row = document.createElement("div");
      row.className = "dpiSlotRow";
      row.dataset.slot = String(i);
      row.style.setProperty("--bar", barColors[i - 1] || barColors[0]);
      row.innerHTML = `
        <div class="dpiSlotBar" aria-hidden="true"></div>
        <div class="dpiSlotHead">
          <div class="dpiSlotNum">${i}</div>
        </div>

        <div class="dpiRangeWrap">
          <input class="dpiRange" id="dpiRange${i}" type="range" min="${min}" max="${max}" step="${DPI_STEP}" value="100" />
          <div class="dpiBubble" id="dpiBubble${i}" aria-hidden="true">
            <div class="dpiBubbleInner"><span class="dpiBubbleVal">100</span></div>
          </div>
        </div>

        <div class="dpiNumWrap">
          <input class="dpiNum" id="dpiInput${i}" type="number" min="${min}" max="${max}" step="${DPI_STEP}" value="100" />
          <div class="dpiSpin" aria-hidden="true">
            <button class="dpiSpinBtn up" type="button" tabindex="-1" aria-label="增加"></button>
            <button class="dpiSpinBtn down" type="button" tabindex="-1" aria-label="减少"></button>
          </div>
        </div>

        <button class="dpiSelectBtn" type="button" aria-label="切换到档位 ${i}" title="切换到该档"></button>
      `;
      dpiList.appendChild(row);
    }


    for (let i = 1; i <= dpiSlotCap; i++) {
      const b = $("#dpiBubble" + i);
      if (!b) continue;
      b.classList.add("dpiBubblePortal");
      document.body.appendChild(b);
    }


    dpiList.addEventListener("input", (e) => {
      const t = e.target;
      const range = t.closest?.("input.dpiRange");
      const num = t.closest?.("input[id^='dpiInput']");
      if (!range && !num) return;

      const id = (range?.id || num?.id || "");
      const slot = Number(id.replace(/\D+/g, ""));
      if (!(slot >= 1 && slot <= dpiSlotCap)) return;

      const { min: mn, max: mx } = getDpiMinMax();
      const val = clamp(range ? range.value : num.value, mn, mx);

      const inp = $("#dpiInput" + slot);
      const rng = $("#dpiRange" + slot);
      if (inp) safeSetValue(inp, val);
      if (rng) safeSetValue(rng, val);
      updateDpiBubble(slot);


    });


    dpiList.addEventListener("change", (e) => {
      const t = e.target;

      const isRange = t.matches("input.dpiRange");
      const isNum = t.matches("input.dpiNum");
      if (!isRange && !isNum) return;

      const id = t.id || "";
      const slot = Number(id.replace(/\D+/g, ""));
      if (!(slot >= 1 && slot <= dpiSlotCap)) return;

      const { min, max } = getDpiMinMax();


      let val = Number(t.value);
      if (!Number.isFinite(val)) val = min;


      const step = (typeof DPI_STEP !== "undefined") ? DPI_STEP : 50;
      val = Math.round(val / step) * step;

      val = Math.max(min, Math.min(max, val));


      const inp = $("#dpiInput" + slot);
      const rng = $("#dpiRange" + slot);
      if (inp) safeSetValue(inp, val);
      if (rng) safeSetValue(rng, val);
      updateDpiBubble(slot);


      debounceKey(`dpi:${slot}`, 80, async () => {
        if (!isHidReady()) return;
        try {
          await withMutex(async () => {


            const isCurrentActive = (slot === uiCurrentDpiSlot);

            await hidApi.setDpi(slot, val, {
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

        const step = Number(inp.step) || DPI_STEP;
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


      const selectBtn = t.closest?.("button.dpiSelectBtn");
      if (selectBtn) {
        const row = selectBtn.closest?.(".dpiSlotRow");
        if (!row || row.classList.contains("hidden")) return;

        const slot = Number(row.dataset.slot);
        if (!(slot >= 1 && slot <= dpiSlotCap)) return;

        const inp = $("#dpiInput" + slot);
        const v = Number(inp?.value);
        if (!Number.isFinite(v) || v <= 0) return;


        if (hasFeature("hasDpiColors") && isHidReady()) {
            const picker = initColorPicker();

            const currentColor = selectBtn.style.getPropertyValue("--btn-bg") || "#FF0000";

            picker.open(selectBtn, currentColor, (newHex) => {

                selectBtn.style.setProperty("--btn-bg", newHex);


                debounceKey(`dpiColor:${slot}`, 150, async () => {
                    try {
                        await withMutex(async () => {

                            await hidApi.setDpi(slot, v, {
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

        withMutex(async () => {
          await hidApi.setDpi(slot, v, { select: true });
        }).catch((err) => logErr(err, "切换 DPI 档失败"));
        return;
      }


      if (t.closest("input") || t.closest("button")) return;

      const row = e.target.closest?.(".dpiSlotRow");
      if (!row || row.classList.contains("hidden")) return;

      const slot = Number(row.dataset.slot);
      if (!(slot >= 1 && slot <= dpiSlotCap)) return;

      const inp = $("#dpiInput" + slot);
      const v = Number(inp?.value);
      if (!Number.isFinite(v) || v <= 0) return;


      setActiveDpiSlot(slot);


      if (!isHidReady()) return;

      withMutex(async () => {
        await hidApi.setDpi(slot, v, { select: true });
      }).catch((err) => logErr(err, "切换 DPI 档失败"));
    });


    const sc = getSlotCountUi();
    setDpiRowsEnabledCount(sc);
    setActiveDpiSlot(uiCurrentDpiSlot, sc);


    for (let i = 1; i <= dpiSlotCap; i++) updateDpiBubble(i);

    if (!dpiBubbleListenersReady) {
      dpiBubbleListenersReady = true;


      const THUMB_HIT_PAD = 6;
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
       * 处理DPI、拖拽点逻辑。
       * 目的：处理指针交互与坐标映射，保证拖拽/命中判断准确。
       * @param {any} e - 参数 e。
       * @returns {any} 返回结果。
       */
      function handleDpiThumbHover(e) {
        const t = e.target;
        const range = t.closest?.("input.dpiRange");
        if (!range) return;

        const slot = Number((range.id || "").replace(/\D+/g, ""));
        if (!(slot >= 1 && slot <= dpiSlotCap)) return;


        if (dpiDraggingSlot && dpiDraggingSlot !== slot) return;

        if (dpiDraggingSlot === slot) {
          showDpiBubble(slot);
          return;
        }

        if (isPointerOnDpiThumb(range, e.clientX)) {
          showDpiBubble(slot);
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

        const slot = Number((range.id || "").replace(/\D+/g, ""));
        if (!(slot >= 1 && slot <= dpiSlotCap)) return;
        if (dpiDraggingSlot === slot) return;
        hideDpiBubble(slot);
      });

      dpiList.addEventListener("pointerleave", () => {
        if (dpiDraggingSlot) return;

        for (let i = 1; i <= dpiSlotCap; i++) hideDpiBubble(i);
      });


      /**
       * 处理DPI逻辑。
       * 目的：处理指针交互与坐标映射，保证拖拽/命中判断准确。
       * @returns {any} 返回结果。
       */
      function endDpiDrag() {
        if (!dpiDraggingSlot) return;
        const slot = dpiDraggingSlot;
        dpiDraggingSlot = null;


        if (dpiRowDragState) {
          if (dpiRowDragState.moved) dpiRowDragBlockClickUntil = Date.now() + 350;
          dpiRowDragState = null;
        }

        if (dpiDraggingEl) {
          unlockEl(dpiDraggingEl);
          dpiDraggingEl = null;
        }


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
          const slot = Number((directRange.id || "").replace(/\D+/g, ""));
          if (!(slot >= 1 && slot <= dpiSlotCap)) return;

          dpiDraggingSlot = slot;
          dpiDraggingEl = directRange;


          lockEl(directRange);
          showDpiBubble(slot);
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
        if (!(slot >= 1 && slot <= dpiSlotCap)) return;

        const range = $("#dpiRange" + slot);
        if (!range) return;

        const rect = range.getBoundingClientRect();

        if (!(e.clientX >= rect.left && e.clientX <= rect.right)) return;

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

        lockEl(range);
        showDpiBubble(slot);


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
          range.value = String(v);
          range.dispatchEvent(new Event("input", { bubbles: true }));
          showDpiBubble(slot);

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
      const r = imgEl.getBoundingClientRect();
      const nw = imgEl.naturalWidth || 0;
      const nh = imgEl.naturalHeight || 0;
      if (!r.width || !r.height || !nw || !nh) return null;

      const cs = getComputedStyle(imgEl);
      const fit = (cs.objectFit || "fill").trim();
      const pos = (cs.objectPosition || "50% 50%").trim();

      let dispW = r.width, dispH = r.height;

      if (fit === "contain" || fit === "scale-down") {
        const scale = Math.min(r.width / nw, r.height / nh);
        dispW = nw * scale;
        dispH = nh * scale;
      } else if (fit === "cover") {
        const scale = Math.max(r.width / nw, r.height / nh);
        dispW = nw * scale;
        dispH = nh * scale;
      } else if (fit === "none") {
        dispW = nw;
        dispH = nh;
      }

      const leftoverX = r.width - dispW;
      const leftoverY = r.height - dispH;

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
        left: r.left + leftoverX * fx,
        top: r.top + leftoverY * fy,
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
      const canvasRect = canvas.getBoundingClientRect();
      const content = getImgContentRect(img);
      if (!content || !content.width || !content.height) return;

      const offX = content.left - canvasRect.left;
      const offY = content.top - canvasRect.top;

      for (const p of points) {
        const cs = getComputedStyle(p);
        const x = parseFloat(cs.getPropertyValue("--x")) || 0;
        const y = parseFloat(cs.getPropertyValue("--y")) || 0;
        const left = offX + (x / 100) * content.width;
        const top = offY + (y / 100) * content.height;
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


        const cr = canvas?.getBoundingClientRect();
        const content = img ? getImgContentRect(img) : null;

        const sig = cr && content
          ? [
              cr.left, cr.top, cr.width, cr.height,
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

    if (hidApi && hidApi._cfg) {
        setTimeout(() => {
            applyKeymapFromDeviceCfg(hidApi._cfg);
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


  const slotSel = $("#slotCountSelect");
  if (slotSel) {
    slotSel.addEventListener("change", () => {
      const nextCount = Number(slotSel.value);


      setDpiRowsEnabledCount(nextCount);
      setActiveDpiSlot(uiCurrentDpiSlot, nextCount);

      debounceKey("slotCount", 120, async () => {
        if (!isHidReady()) return;
        try {
          await withMutex(async () => {
            await hidApi.setSlotCount(nextCount);
          });

        } catch (e) {
          logErr(e, "档位数量写入失败");

        }
      });
    });
  }


  // ============================================================
  // 6) 设备写入队列（防抖 + 适配器驱动）
  // ============================================================
  let __pendingDevicePatch = null;


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
    }


    debounceKey("deviceState", (window.AppConfig?.timings?.debounceMs?.deviceState ?? 200), async () => {
      if (!isHidReady()) return;
      const payload = __pendingDevicePatch;
      __pendingDevicePatch = null;
      if (!payload || !Object.keys(payload).length) return;

      try {
        await withMutex(async () => {

          const writer = window.DeviceWriter;
          if (writer?.writePatch) {
            await writer.writePatch({
              hidApi,
              adapter,
              payload,
            });
          } else {

            console.warn("[writer] missing, skip writePatch");
          }
});

        if (payload.pollingHz != null) log(`回报率已写入:${payload.pollingHz}Hz`);
        if (payload.performanceMode != null) log(`性能模式已写入:${payload.performanceMode}`);
        if (payload.linearCorrection != null) log(`直线修正已写入:${payload.linearCorrection ? "开" : "关"}`);
        if (payload.rippleControl != null) log(`纹波修正已写入:${payload.rippleControl ? "开" : "关"}`);
      } catch (e) {
        logErr(e, "设备状态写入失败");
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
    const dpiSlotCap = getDpiSlotCap();
    const slots = cfg.dpiSlots || [];


    const colors = cfg.dpiColors || [];

    for (let i = 1; i <= dpiSlotCap; i++) {
      const v = slots[i - 1];
      const input = $(`#dpiInput${i}`);
      const range = $(`#dpiRange${i}`);
      if (input && typeof v === "number") safeSetValue(input, v);
      if (range && typeof v === "number") safeSetValue(range, v);


      const btn = dpiList?.querySelector(`.dpiSlotRow[data-slot="${i}"] .dpiSelectBtn`);
      if (btn && colors[i - 1]) {

        btn.style.setProperty("--btn-bg", colors[i - 1]);
      }
    }

    const slotCount = clampSlotCountToCap(cfg.currentSlotCount ?? dpiSlotCap, dpiSlotCap);
    safeSetValue($("#slotCountSelect"), slotCount);
    setDpiRowsEnabledCount(slotCount);

    const curIdx1 = (Number(cfg.currentDpiIndex ?? 0) || 0) + 1;
    setActiveDpiSlot(curIdx1, slotCount);

    const keyScanRate = readStandardValue(cfg, "keyScanningRate");
    if (hasFeature("hasKeyScanRate") && keyScanRate != null) {
      safeSetValue($("#rapooPollingSelectAdv"), keyScanRate);
      if (typeof updatePollingCycleUI === "function") {
        updatePollingCycleUI(keyScanRate, false);
      }
    }

    const pollingHz = readStandardValue(cfg, "pollingHz");
    if (pollingHz != null) {
      const pollingSel = $("#pollingSelect");
      if (pollingSel) {
        const opts = Array.from(pollingSel.options)
          .map((o) => Number(o.value))
          .filter(Number.isFinite);
        const picked = opts.length
          ? opts.reduce((best, x) => (Math.abs(x - pollingHz) < Math.abs(best - pollingHz) ? x : best), opts[0])
          : pollingHz;
        safeSetValue(pollingSel, picked);
      }
    }

    const sleepSeconds = readStandardValue(cfg, "sleepSeconds");
    if (sleepSeconds != null) safeSetValue($("#sleepSelect"), sleepSeconds);

    const debounceMs = readStandardValue(cfg, "debounceMs");
    if (debounceMs != null) safeSetValue($("#debounceSelect"), debounceMs);

    const perfMode = readStandardValue(cfg, "performanceMode") || "low";
    setRadio("perfMode", perfMode);

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

    const primarySurface = readStandardValue(cfg, "surfaceModePrimary");
    if (primarySurface != null) setCb("#bitLOD", primarySurface);

    const primaryLed = readStandardValue(cfg, "primaryLedFeature");
    if (primaryLed != null) setCb("#ledToggle", primaryLed);

    const motionSync = readStandardValue(cfg, "motionSync");
    if (motionSync != null) setCb("#bit1", motionSync);

    const linearCorrection = readStandardValue(cfg, "linearCorrection");
    if (linearCorrection != null) setCb("#bit2", linearCorrection);

    const rippleControl = readStandardValue(cfg, "rippleControl");
    if (rippleControl != null) setCb("#bit3", rippleControl);

    const secondarySurface = readStandardValue(cfg, "surfaceModeSecondary");
    if (secondarySurface != null) setCb("#bit6", secondarySurface);

    const wirelessMode = readStandardValue(cfg, "wirelessStrategyMode");
    if (wirelessMode != null) setCb("#wirelessStrategyToggle", wirelessMode);

    const commMode = readStandardValue(cfg, "commProtocolMode");
    if (commMode != null) setCb("#commProtocolToggle", commMode);

    if (hasFeature("hasWirelessStrategy") || hasFeature("hasCommProtocol")) {
      try { syncBasicExtraSwitchState(); } catch (_) {}
    }

    const longRangeMode = readStandardValue(cfg, "longRangeMode");
    if (longRangeMode != null) setCb("#longRangeModeToggle", longRangeMode);

    const angleVal = readStandardValue(cfg, "sensorAngle");
    if (angleVal != null) safeSetValue($("#angleInput"), angleVal);

    const feelVal = readStandardValue(cfg, "surfaceFeel");
    if (feelVal != null) safeSetValue($("#feelInput"), feelVal);


    syncAdvancedPanelUi();

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
      const dpiLight = readStandardValue(cfg, "dpiLightEffect");
      if (dpiLight != null) {
        updateAtkCycleUI("atkDpiLightCycle", dpiLight, ATK_DPI_LIGHT_OPTS, false);
      }
      const rxLight = readStandardValue(cfg, "receiverLightEffect");
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
        const saved = loadLastHidDevice();
        const res = await DeviceRuntime.connect(mode, {
          primaryDevice: __autoDetectedDevice,
          preferredType: DeviceRuntime?.getSelectedDevice?.(),
          pinPrimary,
          savedDevice: saved,
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
       * @param {any} targetDev - 参数 targetDev。
       * @returns {Promise<any>} 异步结果。
       */
      const performHandshake = async (targetDev) => {
        if (!targetDev) throw new Error("No HID device selected.");

        try {
          if (targetDev.opened) {
            await targetDev.close();
            await new Promise(r => setTimeout(r, 100));
          }
        } catch (_) {}

        hidApi.device = targetDev;
        try { applyCapabilitiesToUi(hidApi.capabilities); } catch {}

        await hidApi.open();
        await new Promise(r => setTimeout(r, 200));

        const displayName = ProtocolApi.resolveMouseDisplayName(targetDev.vendorId, targetDev.productId, targetDev.productName || "HID Device");
        console.log("HID Open, Handshaking:", displayName);

        __writesEnabled = false;
        __resetFirstConfigAppliedGate();


        const cfgP = waitForNextConfig(2500);
        const reqFn = hidApi.requestConfig || hidApi.getConfig;
        if (reqFn) await reqFn.call(hidApi);


        const cfg = await cfgP;


        applyConfigToUi(cfg);


        __writesEnabled = true;

        if (typeof applyKeymapFromCfg === 'function') {
          applyKeymapFromCfg(hidApi._cfg);
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

      try {
        if (document.body.classList.contains("landing-active")) {


          window.__LANDING_ENTER_GATE_PROMISE__ = (async () => {
            try {
              await __firstConfigAppliedPromise;
              await __waitForUiRefresh();
              const enterDelay = Number(adapterFeatures.enterDelayMs || 0);
              if (enterDelay > 0) await new Promise((r) => setTimeout(r, enterDelay));
            } catch (_) {}
          })();

          enterAppWithLiquidTransition(__landingClickOrigin);
        }
      } catch (_) {}

    } catch (err) {
      hidConnecting = false;
      hidLinked = false;
      try { await hidApi.close(); } catch {}
      updateDeviceStatus(false);
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

      __connectPending = null;
      hidConnecting = false;
      hidLinked = false;

      await hidApi.close();
      hidApi.device = null;
      __autoDetectedDevice = null;


      updateDeviceStatus(false);
      stopBatteryAutoRead();
      resetHeaderChipValues();
      setHeaderChipsVisible(false);

      log("HID 已断开");

      try { showLanding("disconnect"); } catch (_) {}
    } catch (err) {
      logErr(err, "断开失败");
    }
  }

  deviceWidget?.addEventListener("click", async () => {
    if (!isHidOpened()) {
      await connectHid(true, false);
      return;
    }
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

         setTimeout(() => {
             if (!isHidOpened()) __runHeavyTaskSafely(initAutoConnect);
         }, 500);
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
  let sidebarTimer = null;
  let __navRafId = 0;


  /**
   * 设置导航。
   * 目的：提供统一读写入口，降低耦合。
   * @param {any} collapsed - 参数 collapsed。
   * @returns {any} 返回结果。
   */
  const setNavCollapsed = (collapsed) => {
    if (__navRafId) cancelAnimationFrame(__navRafId);
    __navRafId = requestAnimationFrame(() => {
      __navRafId = 0;
      document.body.classList.toggle('nav-collapsed', !!collapsed);
    });
  };
  /**
   * 处理导航逻辑。
   * 目的：统一处理导航相关流程，保证行为一致。
   * @returns {any} 返回结果。
   */
  const toggleNavCollapsed = () => {
    if (__navRafId) cancelAnimationFrame(__navRafId);
    __navRafId = requestAnimationFrame(() => {
      __navRafId = 0;
      document.body.classList.toggle('nav-collapsed');
    });
  };

  if (sidebar) {


    sidebar.addEventListener('transitionend', (e) => {
      if (e.propertyName === 'width') {
        window.dispatchEvent(new Event('resize'));
      }
    });


    const sidebarToggle = document.getElementById('sidebarToggle');
    if (sidebarToggle) {
      sidebarToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleNavCollapsed();

      });
    }
  }

})();
