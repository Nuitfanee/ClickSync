

(async () => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // 为嵌入式测试工具提供 i18n 存根函数（默认使用中文）
  window.tr = window.tr || ((zh, en) => zh);

  // ====== 设备运行时环境 ======
  // 获取设备运行时管理器（支持 Chaos / Rapoo / ATK 等设备类型）
  const DeviceRuntime = window.DeviceRuntime;
  const SELECTED_DEVICE = DeviceRuntime?.getSelectedDevice?.() || "chaos";

  // ====== 设备身份识别（解耦设计，可组合） ======
  // 设计目标：
  // - 逻辑层：保留"类 Rapoo "（rapoo + atk）的兼容行为（IS_RAPOO 标志）
  // - 样式层：rapoo / atk / chaos 三者完全隔离，各自拥有独立的 CSS 命名空间
  const __DeviceEnv = window.DeviceEnv;
  const DEVICE_ID = (typeof __DeviceEnv?.normalize === "function")
    ? __DeviceEnv.normalize(SELECTED_DEVICE)
    : (SELECTED_DEVICE || "chaos");
  const DEVICE_FAMILY = (typeof __DeviceEnv?.familyOf === "function")
    ? __DeviceEnv.familyOf(DEVICE_ID)
    : ((DEVICE_ID === "rapoo" || DEVICE_ID === "atk") ? "rapoo" : "chaos");

  // 遗留兼容标志：用于逻辑层兼容（rapoo + atk 共享部分行为）
  const IS_RAPOO = (DEVICE_FAMILY === "rapoo");
  const IS_ATK = (DEVICE_ID === "atk");

  // 样式隔离：为每个设备类型设置独立的 CSS 类名，避免样式污染
  document.body.dataset.device = DEVICE_ID;
  document.body.classList.toggle("device-rapoo", DEVICE_ID === "rapoo");
  document.body.classList.toggle("device-atk", DEVICE_ID === "atk");
  document.body.classList.toggle("device-chaos", DEVICE_ID === "chaos");

  // ====== 获取设备适配器 ======
  // 用于全局配置和 UI 变体应用
  const adapter = window.DeviceAdapters?.getAdapter?.(DEVICE_ID) || window.DeviceAdapters?.getAdapter?.(SELECTED_DEVICE);

  // ====== 设备运行时初始化 ======
  // 注意：设备选择器已移除，改为基于 HID 设备特征自动识别

  // ====== 起始页层管理 ======
  // 起始页：设备未连接前的覆盖层，采用 SPA 架构覆盖在主应用之上
  const __landingLayer = document.getElementById("landing-layer");
  const __appLayer = document.getElementById("app-layer");
  const __landingCaption = document.getElementById("landingCaption") || __landingLayer?.querySelector(".center-caption");
  const __triggerZone = document.getElementById("trigger-zone");
  const __landingCanvas = document.getElementById("surreal-canvas"); // 遗留元素（已在 Optical Slice 版本中移除）
  const __landingLiquid = __landingLayer?.querySelector(".liquid-overlay"); // 遗留元素（已在 Optical Slice 版本中移除）

  // ====== 设备特定 UI 变体应用 ======
  // 仅影响 Rapoo 设备的 UI 配置
  function __applyDeviceVariantOnce() {
    // UI 变体仅负责"UI 配置/文案/范围/可见性"等展示层逻辑，不涉及任何设备写入操作
    try {
      const registry = window.DeviceAdapters;
      const adapter = registry?.getAdapter?.(DEVICE_ID) || registry?.getAdapter?.(SELECTED_DEVICE);
      window.DeviceUI?.applyVariant?.({
        deviceId: DEVICE_ID,
        family: DEVICE_FAMILY,
        adapter,
        root: document,
      });
    } catch (err) {
      console.warn("[variant] apply failed", err);
    }
  }

  __applyDeviceVariantOnce();

  // ====== Rapoo 按键扫描率循环按钮 ======
  // 提供循环切换按键扫描率的功能，带有平滑的滑动动画效果
  const POLLING_RATES = [1000, 2000, 4000, 8000];
  const RATE_COLORS = {
    1000: 'rate-color-1000',
    2000: 'rate-color-2000',
    4000: 'rate-color-4000',
    8000: 'rate-color-8000'
  };

  /**
   * 更新按键扫描率循环按钮的 UI 状态
   * @param {number} rate - 目标扫描率值
   * @param {boolean} animate - 是否播放动画（默认 true）
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
      // 初始化或静默更新：直接设置状态，不播放动画
      baseLayer.className = 'shutter-bg-base ' + colorClass;
      textEl.textContent = displayRate;
      if (selectEl) selectEl.value = rate;
      return;
    }

    // 播放滑动动画流程：
    // 1. 设置下一层的背景颜色
    nextLayer.className = 'shutter-bg-next ' + colorClass;
    
    // 2. 添加动画类，触发 CSS transition 过渡效果
    container.classList.add('is-animating');

    // 3. 动画结束后更新最终状态
    setTimeout(() => {
      textEl.textContent = displayRate;
      // 将当前背景层更新为新颜色
      baseLayer.className = 'shutter-bg-base ' + colorClass;
      // 移除动画类，重置滑块位置
      container.classList.remove('is-animating');
      // 同步更新隐藏的 select 元素值
      if (selectEl) selectEl.value = rate;
    }, 500); // 与 CSS transition 持续时间保持一致
  }

  /**
   * 初始化 Rapoo 按键扫描率循环按钮
   * 点击按钮时循环切换预设的扫描率值
   */
  function initRapooPollingCycle() {
    const cycleBtn = document.getElementById('rapooPollingCycle');
    if (!cycleBtn || !IS_RAPOO) return;

    cycleBtn.addEventListener('click', () => {
      // 获取当前选中的扫描率值（从隐藏的 select 元素或内存中读取）
      const selectEl = document.getElementById('rapooPollingSelectAdv');
      const currentHz = Number(selectEl?.value || 1000);
      let nextIdx = POLLING_RATES.indexOf(currentHz) + 1;
      if (nextIdx >= POLLING_RATES.length) nextIdx = 0;
      
      const nextHz = POLLING_RATES[nextIdx];
      
      // 执行 UI 动画更新
      updatePollingCycleUI(nextHz, true);
      
      // 写入设备：通过统一的设备补丁队列机制
      // 仅修改按键扫描率，不影响回报率设置
      if (typeof enqueueDevicePatch === 'function') {
        enqueueDevicePatch({ keyScanningRate: nextHz });
      }
    });
  }

  // 初始化循环按钮
  initRapooPollingCycle();

  // ====== ATK 设备灯效循环控制 ======
  // 定义灯效选项与对应的 CSS 颜色类
  // 优先从 refactor.js 的设备适配器中读取配置，否则使用默认值
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
   * 更新 ATK 灯效循环按钮的 UI 状态
   * @param {string} id - 按钮容器元素 ID
   * @param {number} value - 目标灯效值
   * @param {Array} options - 灯效选项数组
   * @param {boolean} animate - 是否播放动画（默认 true）
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
          // 初始化/回显模式：直接设置 Base 层颜色，不播放动画
          baseLayer.className = 'shutter-bg-base ' + colorClass;
          textEl.textContent = opt.label;
          container.dataset.value = value;
          return;
      }

      // 交互模式：播放滑动动画
      // 流程：Next 层设置新颜色 -> 滑入动画 -> 动画结束后重置状态
      nextLayer.className = 'shutter-bg-next ' + colorClass;
      container.classList.add('is-animating');
      
      setTimeout(() => {
          textEl.textContent = opt.label;
          baseLayer.className = 'shutter-bg-base ' + colorClass;
          container.classList.remove('is-animating');
          container.dataset.value = value;
      }, 500); // 与 CSS transition 持续时间（0.5s）保持一致
  }

  /**
   * 初始化 ATK 灯效循环按钮
   * 为 DPI 灯效和接收器灯效分别绑定循环切换逻辑
   */
  function initAtkLightCycles() {
      /**
       * 为指定按钮绑定循环切换逻辑
       * @param {string} id - 按钮元素 ID
       * @param {string} key - 设备配置键名
       * @param {Array} options - 灯效选项数组
       */
      const bindCycle = (id, key, options) => {
          const btn = document.getElementById(id);
          if (!btn) return;
          
          btn.addEventListener('click', () => {
              const cur = Number(btn.dataset.value || 0);
              const curIdx = options.findIndex(o => o.val === cur);
              // 循环切换逻辑：到达末尾后回到第一个选项
              const nextIdx = (curIdx + 1) % options.length;
              const nextVal = options[nextIdx].val;
              
              // 1. 更新 UI 动画效果
              updateAtkCycleUI(id, nextVal, options, true);
              // 2. 发送设备配置指令
              enqueueDevicePatch({ [key]: nextVal });
          });
      };

      // 绑定 DPI 灯效和接收器灯效循环按钮
      bindCycle('atkDpiLightCycle', 'dpiLightEffect', ATK_DPI_LIGHT_OPTS);
      bindCycle('atkReceiverLightCycle', 'receiverLightEffect', ATK_RX_LIGHT_OPTS);
  }

  // 初始化灯效循环按钮监听
  initAtkLightCycles();


  // 记录转场动画的起点坐标（鼠标点击位置），用于液体转场效果的中心点定位
  let __landingClickOrigin = null;

  // 自动检测到的已授权设备（仅用于 UI 提示和预选，不会自动触发连接）
  let __autoDetectedDevice = null;

  // ====== 手动连接保护锁 ======
  // 用途：用户主动发起连接时，短时间内忽略 WebHID connect 事件，避免重复自动连接
  // 原理：浏览器在 requestDevice() 授权成功后也会触发一次 navigator.hid 的 connect 事件，
  //      这会被热插拔监听器捕获并触发 initAutoConnect，导致"黑色扩张动画"重复播放
  let __manualConnectGuardUntil = 0;
  /**
   * 激活手动连接保护锁
   * @param {number} ms - 保护持续时间（毫秒），默认 3000ms
   */
  const __armManualConnectGuard = (ms = 3000) => {
    const dur = Math.max(0, Number(ms) || 0);
    __manualConnectGuardUntil = Date.now() + dur;
  };
  /**
   * 检查手动连接保护锁是否处于激活状态
   * @returns {boolean} 是否在保护期内
   */
  const __isManualConnectGuardOn = () => Date.now() < __manualConnectGuardUntil;


  function __setAppInert(inert) {
    if (!__appLayer) return;
    try { __appLayer.inert = inert; } catch (_) {}
    __appLayer.setAttribute("aria-hidden", inert ? "true" : "false");
  }

  function __setLandingCaption(text) {
    if (!__landingCaption) return;
    __landingCaption.textContent = text;
  }

  function __resetLandingLiquidInstant() {
    if (!__landingLiquid) return;

    // 回到初始态：遮罩为 0%，不透明；清掉 inline，让 CSS class 负责动画
    const prevTransition = __landingLiquid.style.transition;
    const prevDelay = __landingLiquid.style.transitionDelay;

    __landingLiquid.style.transition = "none";
    __landingLiquid.style.transitionDelay = "0s";
    __landingLiquid.style.opacity = "1";
    __landingLiquid.style.clipPath = "circle(0% at 50% 50%)";

    // force reflow
    void __landingLiquid.offsetHeight;

    __landingLiquid.style.clipPath = "";
    __landingLiquid.style.transition = prevTransition || "";
    __landingLiquid.style.transitionDelay = prevDelay || "";
  }


/**
 * 显示起始页
 * 用于设备断开连接或初始化时显示起始页覆盖层
 * @param {string} reason - 显示原因（用于调试，可选）
 */
function showLanding(reason = "") {
    if (!__landingLayer) return;

    // 清理所有起始页状态类（Optical Slice 设计）
    document.body.classList.remove("landing-cover", "landing-reveal", "landing-covered", "landing-hovering", "landing-drop");
    document.body.classList.remove("landing-precharge", "landing-charging", "landing-system-ready", "landing-ready-zoom", "landing-ready-out", "landing-holding");
    document.body.classList.add("landing-active");

    __landingLayer.style.display = "";
    __landingLayer.setAttribute("aria-hidden", "false");

    // 起始页覆盖期间禁用主应用交互，避免误操作
    __setAppInert(true);

    // 恢复触发区域的可点击状态
    if (__triggerZone) __triggerZone.style.pointerEvents = "";

    // 重置提示文案：连接失败或断开后回到默认提示
    __setLandingCaption("Hold to Initiate System");

    // 清空转场动画起点坐标
    __landingClickOrigin = null;
  }


/**
 * 通过液体转场动画进入主应用
 * 注意：保留此函数名以便在 connectHid 中复用"连接成功后进入主应用"的调用点
 * @param {Object|null} origin - 转场动画起点坐标（可选）
 */
function enterAppWithLiquidTransition(origin = null) {
    if (!__landingLayer) return;
    if (__landingLayer.getAttribute("aria-hidden") === "true") return;

    // 防抖处理：如果已经在"系统就绪"状态，则不再重复执行
    if (document.body.classList.contains("landing-system-ready")) return;

    // 禁用起始页触发区域，避免用户连续点击
    if (__triggerZone) __triggerZone.style.pointerEvents = "none";

    // 进入"系统就绪"过场动画：让主应用在后台恢复清晰（由 flash 遮罩覆盖）
    document.body.classList.remove("landing-ready-zoom", "landing-ready-out");
    document.body.classList.add("landing-system-ready", "landing-reveal");
    document.body.classList.remove("landing-precharge", "landing-charging", "landing-holding");

    __setLandingCaption("SYSTEM READY");

    // 过场动画期间主应用仍保持 inert 状态，避免误操作
    __setAppInert(true);

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

      // 恢复触发区（下次断开还会用到）
      if (__triggerZone) __triggerZone.style.pointerEvents = "";

      __landingClickOrigin = null;
    };

    const runTransition = () => {
      // 毫秒数完全保持原版 720/520/220/560 比例
      window.setTimeout(() => {
        try { document.body.classList.add("landing-ready-zoom"); } catch (_) {}
      }, 720);

      window.setTimeout(() => {
        try { document.body.classList.add("landing-ready-out"); } catch (_) {}
      }, 1240); // 720 + 520

      window.setTimeout(() => {
        try { document.body.classList.add("landing-drop"); } catch (_) {}
      }, 1500); // 1240 + 220 + 40

      window.setTimeout(finish, 2140); // 1500 + 560 + 80
    };

    // 配置读取的门闩逻辑：在 runTransition 之前等待，但不改变内部动画的执行节奏
    const gateP = window.__LANDING_ENTER_GATE_PROMISE__;
    const waitP = (gateP && typeof gateP.then === "function") ? gateP : Promise.resolve();

    Promise.race([
      waitP.catch(() => {}),
      new Promise((r) => setTimeout(r, 6000)), // 稳健超时
    ]).then(runTransition, runTransition);
  }


  // ====== Landing canvas engine ======

  function initLandingCanvasEngine() {
    // Re-purposed: Optical Slice landing engine (no canvas).
    if (!__landingLayer) return null;

    const layerSolid = document.getElementById("layer-solid");
    const layerOutline = document.getElementById("layer-outline");
    const cursorRing = document.getElementById("cursorRing");
    const cursorDot = document.getElementById("cursorDot");

    if (!layerSolid) return null;

    // Mouse position
    let mouseX = window.innerWidth / 2;
    let mouseY = window.innerHeight / 2;

    // Smooth follow
    let currentX = mouseX;
    let currentY = mouseY;

    // Mask radius
    let maskRadius = 150;
    let targetRadius = 150;

    let holding = false;

    // Click/Tap: auto wipe to full black before opening WebHID chooser
    // { start, dur, from, to, cx, cy, onDone }
    let autoWipe = null;

    // 空闲停帧后由事件唤醒 RAF（避免起始页偶发丢帧/高 CPU）
    let __wakeLoop = () => {};

    const isLandingVisible = () => __landingLayer.getAttribute("aria-hidden") !== "true";

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

    const endHold = () => {
      if (autoWipe) return;
      holding = false;
      document.body.classList.remove("landing-holding");
      targetRadius = 150;
      __wakeLoop();
    };

    // opts:
    // - durationMs: number
    // - toRadius: number (optional, if provided will animate to this radius instead of full-screen maxR)
    // - endFullCover: boolean (default true). If false, do NOT force full cover at the end.
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

      // Lock center to click point
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

    // Pointer events (bind on trigger-zone so it feels like “press to charge”)
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

    // RAF loop（优化：空闲自动停帧 + 减少重复 style 写入）
    let __rafId = 0;
    let __paused = false;

    // Cache: 避免每帧重复写同样的 style（会触发样式计算）
    let __lastClip = "";
    let __lastOutlineT = "";
    let __lastRingT = "";
    let __lastDotT = "";
    let __lastRingOp = "";
    let __lastDotOp = "";

    const __setClip = (v) => {
      if (v !== __lastClip) {
        layerSolid.style.clipPath = v;
        __lastClip = v;
      }
    };
    const __setOutlineT = (v) => {
      if (!layerOutline) return;
      if (v !== __lastOutlineT) {
        layerOutline.style.transform = v;
        __lastOutlineT = v;
      }
    };
    const __setRingT = (v) => {
      if (!cursorRing) return;
      if (v !== __lastRingT) {
        cursorRing.style.transform = v;
        __lastRingT = v;
      }
    };
    const __setDotT = (v) => {
      if (!cursorDot) return;
      if (v !== __lastDotT) {
        cursorDot.style.transform = v;
        __lastDotT = v;
      }
    };
    const __setRingOpacity = (v) => {
      if (!cursorRing) return;
      if (v !== __lastRingOp) {
        cursorRing.style.opacity = v;
        __lastRingOp = v;
      }
    };
    const __setDotOpacity = (v) => {
      if (!cursorDot) return;
      if (v !== __lastDotOp) {
        cursorDot.style.opacity = v;
        __lastDotOp = v;
      }
    };

    const __isChargingOrReady = () =>
      document.body.classList.contains("landing-charging") || document.body.classList.contains("landing-system-ready");

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

    const __startLoop = () => {
      if (__paused) return;
      if (__rafId) return;
      if (!isLandingVisible() || document.hidden) return;
      __rafId = requestAnimationFrame(__tick);
    };

    const __stopLoop = () => {
      if (__rafId) cancelAnimationFrame(__rafId);
      __rafId = 0;
    };

    // 让事件（pointermove/hold/autoWipe）可唤醒动画
    __wakeLoop = __startLoop;

    function __tick() {
      __rafId = 0;

      if (!__shouldKeepRunning()) {
        // 空闲：停止 RAF（下一次事件会唤醒）
        return;
      }

      // Charging / ready: full cover
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

      // Auto wipe (click/tap)
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

      // 1) Smooth cursor follow
      currentX += (mouseX - currentX) * 0.15;
      currentY += (mouseY - currentY) * 0.15;

      const rx = Math.round(currentX * 10) / 10;
      const ry = Math.round(currentY * 10) / 10;
      const mx = Math.round(mouseX * 10) / 10;
      const my = Math.round(mouseY * 10) / 10;

      __setRingT(`translate(${rx}px, ${ry}px) translate(-50%, -50%)`);
      __setDotT(`translate(${mx}px, ${my}px) translate(-50%, -50%)`);

      // 2) Radius easing
      if (holding) {
        maskRadius += (targetRadius - maskRadius) * 0.018;
        layerSolid.style.transform = "none";
      } else {
        maskRadius += (targetRadius - maskRadius) * 0.12;
        layerSolid.style.transform = "none";
      }

      const rr = Math.round(maskRadius * 10) / 10;
      __setClip(`circle(${rr}px at ${rx}px ${ry}px)`);

      // 3) Subtle parallax (skip on holding)
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

    // 首帧启动（后续空闲会自动停帧）
    __startLoop();

    // aria-hidden / tab 切换时停止动画，避免后台耗电
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

  // 起始页：从“CONNECTING(全屏黑)”反向回到初始态（用于 WebHID 选择器点了取消/未选择设备）
  function __reverseLandingToInitial(origin = null, opts = {}) {
    if (!__landingLayer) return;
    if (__landingLayer.getAttribute("aria-hidden") === "true") return;

    // 先解除 charging 对 clip-path 的强制覆盖
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

    // 反向动画期间先禁用点击，结束后再恢复
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

    // 兜底：如果引擎不可用/启动失败，直接回到初始态
    if (!ok) {
      try { __landingFx?.reset?.(); } catch (_) {}
      __setLandingCaption("Hold to Initiate System");
      if (__triggerZone) __triggerZone.style.pointerEvents = "";
    }
  }

  // 起始页交互：点击 -> 立即变黑（全屏充能）并弹出连接窗口
  if (__triggerZone && __landingLayer) {
    const beginPrecharge = () => {
      // 进入“充能/连接中”视觉（蓝色提示等），但不强制 clipPath 直接全屏。
      // 这样透镜扩张还能正常播放，且不会出现“全屏后白字停着”的阶段。
      document.body.classList.add("landing-precharge");
      document.body.classList.remove("landing-holding");
      __setLandingCaption("CONNECTING...");
    };

    const beginCharging = () => {
      // 扩张结束态 = 充能/连接中态（全黑覆盖 + 蓝色提示）
      document.body.classList.remove("landing-precharge");
      document.body.classList.add("landing-charging");
      document.body.classList.remove("landing-holding");
      __setLandingCaption("CONNECTING...");
    };

    __triggerZone.addEventListener("click", (e) => {
      // 手动连接：打开选择器前先上锁，避免授权产生的 connect 事件触发二次自动连接
      __armManualConnectGuard(3000);
      // 记录点击位置（仍保留变量，便于后续扩展）
      if (e && e.clientX) __landingClickOrigin = { x: e.clientX, y: e.clientY };

      // 先做一次“透镜扩张到全屏”过渡（更慢、无抖动）。
      // 注意：扩张期间就进入“连接中”视觉；扩张结束后立即 connectHid（不再额外等待）。
      if (__triggerZone) __triggerZone.style.pointerEvents = "none";
      beginPrecharge();

      const cx = (e && Number.isFinite(e.clientX)) ? e.clientX : window.innerWidth / 2;
      const cy = (e && Number.isFinite(e.clientY)) ? e.clientY : window.innerHeight / 2;

      const startOk = __landingFx?.beginAutoWipe?.(cx, cy, () => {
        // 扩张结束：立即进入全黑“充能/连接中”状态，并立刻触发 WebHID 连接窗口
        beginCharging();
        // 用 0ms 排队，避免在 RAF 清理同帧里触发造成状态竞争；体感仍是“结束就弹窗”。
        setTimeout(() => connectHid(true, false), 0);
      }, { durationMs: 100 });

      // Fallback：如果视觉引擎没初始化成功，就用定时器兜底
      if (!startOk) {
        setTimeout(() => {
          beginCharging();
          setTimeout(() => connectHid(true, false), 0);
        }, 1400);
      }
    });

    // 键盘可达性：Enter/Space 触发点击
    __triggerZone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " ) {
        e.preventDefault();
        __triggerZone.click();
      }
    });
  }



  // ====== xSelect 自定义下拉组件 ======
  // 自绘下拉菜单，采用玻璃卡片风格设计
  // 使用 Portal 模式挂载到 body，避免被父容器的 overflow 或圆角裁剪
  const xSelectMap = new WeakMap();
  const xSelectOpen = new Set();
  let xSelectGlobalHooksInstalled = false;

  function closeAllXSelect(exceptWrap = null) {
    for (const inst of Array.from(xSelectOpen)) {
      if (exceptWrap && inst.wrap === exceptWrap) continue;
      inst.close();
    }
  }

  function repositionOpenXSelect() {
    for (const inst of Array.from(xSelectOpen)) inst.position();
  }

  function createXSelect(selectEl) {
    if (!selectEl || xSelectMap.has(selectEl)) return;
    const parent = selectEl.parentNode;
    if (!parent) return;

    // 容器（仍在原位置，负责布局/焦点/箭头样式）
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

    // 下拉菜单：挂到 body（portal），避免被任何 overflow/圆角裁剪
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

        // Portal 菜单使用 position:fixed（见 CSS），因此直接用 viewport 坐标
        let left = r.left;
        let top = r.bottom + gap;
        const width = Math.max(120, r.width);

        // 先设置基础尺寸，便于测量高度
        menu.style.width = `${width}px`;
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;

        // 视口边界处理（需要先确保显示）
        const mr = menu.getBoundingClientRect();
        const viewportW = window.innerWidth;
        const viewportH = window.innerHeight;

        // 横向溢出就向左挪
        const overflowRight = mr.right - (viewportW - gap);
        if (overflowRight > 0) {
          left = Math.max(gap, left - overflowRight);
          menu.style.left = `${left}px`;
        }
        // 横向过左
        const overflowLeft = gap - mr.left;
        if (overflowLeft > 0) {
          left = left + overflowLeft;
          menu.style.left = `${left}px`;
        }

        // 纵向：如果下面放不下且上面空间足够，则向上翻转
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
        // 让 DPI 顶部面板在选择下拉项时依旧保持“悬浮”效果
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
        // 关闭时移除“悬浮”锁定
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

    // option 变化时自动刷新（例如动态填充）
    const mo = new MutationObserver(() => inst.refresh());
    mo.observe(selectEl, { childList: true });

    // 原生 select value 变化时同步（例如外部触发了 change）
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

    // 全局：点击空白关闭；滚动/缩放时重定位（不再直接关闭）
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

  function initXSelects() {
    $$("select.input").forEach((sel) => createXSelect(sel));
  }

  
        const navLinks = $("#navLinks");
  const langBtn = $("#langBtn"); // 兼容：旧语言切换按钮(新UI中可能不存在)
  const themeBtn = $("#themeBtn");
  const themePath = $("#themePath");

// 初始化自绘下拉（替代原生 select 下拉菜单）
  initXSelects();

  // ====== 顶部设备卡片(直接连接) ======
  // 说明：已移除弹出式“设备连接面板”，点击卡片即开始连接；连接后可再次点击以断开(会二次确认)。
  const deviceWidget = $("#deviceWidget");
  const deviceStatusDot = $("#deviceStatusDot");
  const widgetDeviceName = $("#widgetDeviceName");
  const widgetDeviceMeta = $("#widgetDeviceMeta"); // 新UI中可能不存在

  // 用于在无面板的情况下保存状态（供电量/固件回包更新 UI）
  let currentDeviceName = "";
  let currentBatteryText = "";
  let currentFirmwareText = "";

  // ====== HID 连接状态管理 ======
  // 仅在收到 config 回包后才算"真正连接"
  // 避免鼠标未连接时误显示 HID 已连接状态
  let hidLinked = false;
  let hidConnecting = false;

  // ====== 电量自动读取机制 ======
  // 策略：进入页面/刷新时读取一次，之后定时刷新（仅在设备连接时才会请求）
  let batteryTimer = null;
  /**
   * 安全地请求设备电量信息
   * @param {string} reason - 请求原因（用于日志记录，可选）
   */
  async function requestBatterySafe(reason = "") {
    if (!isHidReady()) return;
    try {
      await hidApi.requestBattery();
      if (reason) log(`已刷新电量(${reason})`);
    } catch (e) {
      // 不打断主流程：偶发失败允许下次再试
      logErr(e, "请求电量失败");
    }
  }
  /**
   * 启动电量自动读取定时器
   * Rapoo：状态包为被动上报，每 2 分钟做一次"电量刷新"（从最近一次状态包解析值同步到 UI）
   * Chaos：保持 60 秒间隔
   */
  function startBatteryAutoRead() {
    if (batteryTimer) return;
    // 进入页面/刷新或连接完成时先读取一次
    requestBatterySafe("首次");
    // 根据设备类型设置不同的刷新间隔
    const intervalMs = IS_RAPOO ? 120_000 : 60_000;
    batteryTimer = setInterval(() => requestBatterySafe(IS_RAPOO ? "2min" : "60s"), intervalMs);
  }
  /**
   * 停止电量自动读取定时器
   */
  function stopBatteryAutoRead() {
    if (batteryTimer) clearInterval(batteryTimer);
    batteryTimer = null;
  }
  // ====== 设备状态更新函数 ======
  /**
   * 更新顶部设备卡片的状态显示
   * @param {boolean} connected - 是否已连接
   * @param {string} deviceName - 设备名称（可选）
   * @param {string} battery - 电量信息（可选）
   * @param {string} firmware - 固件版本信息（可选）
   */
  function updateDeviceStatus(connected, deviceName = "", battery = "", firmware = "") {
    // 更新设备卡片的状态指示器
    if (connected) {
      deviceStatusDot?.classList.add("connected");

      // 构建状态后缀文本
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

    // 保存当前状态，供后续电量/固件回包刷新 UI 时使用
    if (connected) {
      if (deviceName) currentDeviceName = deviceName;
      if (battery) currentBatteryText = battery;
      if (firmware) currentFirmwareText = firmware;
    } else {
      // 断开连接时清空所有状态
      currentDeviceName = "";
      currentBatteryText = "";
      currentFirmwareText = "";
    }
  }

  // ====== UI 同步辅助工具 ======
  // UI 锁定机制：防止用户正在编辑时被设备回包覆盖
  const uiLocks = new Set();
  // 写入防抖器：避免短时间内多次写入操作
  const writeDebouncers = new Map();
  // 操作链：确保设备操作按顺序执行，避免并发冲突
  let opChain = Promise.resolve();
  let opInFlight = false;

  /**
   * 使用互斥锁执行异步任务
   * 确保设备操作按顺序执行，避免并发写入导致的状态冲突
   * @param {Function} task - 要执行的异步任务函数
   * @returns {Promise} 任务执行结果的 Promise
   */
  function withMutex(task) {
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
   * 检查 HID 设备是否已打开
   * @returns {boolean} 设备是否已打开
   */
  function isHidOpened() {
    return !!(hidApi && hidApi.device && hidApi.device.opened);
  }

  /**
   * 检查 HID 设备是否已就绪（已打开且已收到配置回包）
   * @returns {boolean} 设备是否已就绪
   */
  function isHidReady() {
    return isHidOpened() && hidLinked;
  }
function lockEl(el) {
    if (!el) return;
    if (!el.id) el.id = `__autogen_${Math.random().toString(36).slice(2, 10)}`;
    uiLocks.add(el.id);
  }
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

  function safeSetValue(el, value) {
    if (!el) return;
    if (el.id && uiLocks.has(el.id)) return;
    const v = String(value ?? "");
    if (el.value !== v) el.value = v;
    if (el.tagName === "SELECT") xSelectMap.get(el)?.sync?.();
  }
  function safeSetChecked(el, checked) {
    if (!el) return;
    if (el.id && uiLocks.has(el.id)) return;
    el.checked = !!checked;
  }

  function debounceKey(key, ms, fn) {
    if (writeDebouncers.has(key)) clearTimeout(writeDebouncers.get(key));
    const t = setTimeout(() => {
      writeDebouncers.delete(key);
      fn();
    }, ms);
    writeDebouncers.set(key, t);
  }

  // ---- Theme ----
  const THEME_KEY = "mouse_console_theme";
  const prefersDark =
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const savedTheme = localStorage.getItem(THEME_KEY);

  function applyTheme(theme) {
    // 强制 dark 为 false，确保不会给 body 添加 "dark" class
    const dark = false; 
    document.body.classList.toggle("dark", dark);

    // 始终显示太阳（亮色）图标的路径数据
    themePath?.setAttribute(
      "d",
      "M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"
    );
  }

  // 核心：强制调用 light
  // 无论系统偏好或上次存储如何，强制初始化为亮色模式
  applyTheme("light");

  // 禁用按钮点击，防止误触进入暗色
  // 注释掉这段代码以禁用点击切换功能
  /*
  themeBtn?.addEventListener("click", () => {
    const next = document.body.classList.contains("dark") ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
  */

  // ---- Language (zh/en) ----
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

  function applyLang(lang) {
    const pack = dict[lang] || dict.zh;
    const _heroTitleEl = $("#heroTitle");
    if (_heroTitleEl) _heroTitleEl.textContent = pack.heroTitle;

    const _heroSubEl = $("#heroSub");
    if (_heroSubEl) _heroSubEl.textContent = pack.heroSub;

    $$(".sidebar .nav-item").forEach((a) => {
      const k = a.getAttribute("data-key");
      // 只更新 .nav-text 的内容，避免覆盖图标 svg
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

  // === 导航逻辑适配 (.nav-item) ===
  // 选择 sidebar 内的 items
  const sidebarItems = $$(".sidebar .nav-item");

  // 替换 setActiveByHash 函数
  function setActiveByHash() {
    let key = (location.hash || "#keys").replace("#", "") || "keys";
    if (key === "tuning") key = "basic";
    if (!document.getElementById(key)) key = "keys";

    // 更新侧边栏状态
    sidebarItems.forEach((item) => {
      const itemKey = item.getAttribute("data-key");
      const isActive = itemKey === key;

      // 切换 active 类
      if (isActive) {
          item.classList.add("active");
          // 设置主题色变量 (根据 data-color)
          const color = item.getAttribute("data-color") || "#000000";
          document.documentElement.style.setProperty('--theme-color', color);
      } else {
          item.classList.remove("active");
      }
    });

    // 切换页面显示
    $$("#stageBody > section.page").forEach((p) => p.classList.toggle("active", p.id === key));

    // 页面特定类名
    document.body.classList.toggle("page-keys", key === "keys");
    document.body.classList.toggle("page-dpi", key === "dpi");
    document.body.classList.toggle("page-basic", key === "basic");
    document.body.classList.toggle("page-advanced", key === "advanced");
    document.body.classList.toggle("page-testtools", key === "testtools");

    // leaving test tools: make sure PointerLock is released
    if (key !== "testtools") {
      try {
        const pl = document.pointerLockElement;
        if (pl && (pl.id === "rateBox" || pl.id === "lockTarget" || pl.id === "rotLockTarget")) {
          document.exitPointerLock();
        }
      } catch (_) {}
      document.body.classList.remove("tt-pointerlock");
    }

    // notify embedded tools (optional)
    try {
      window.dispatchEvent(new CustomEvent("testtools:active", { detail: { active: key === "testtools" } }));
    } catch (_) {}

    if (key === "basic" && typeof syncBasicMonolithUI === "function") {
      syncBasicMonolithUI();
    }


    
    const sb = $("#stageBody");
    if (sb) sb.scrollTop = 0;
  }

  // ====== 基础性能页：性能模式 & 回报率（MONOLITH 交互） ======
  let __basicMonolithInited = false;
  let __basicModeItems = [];
  let __basicHzItems = [];
  let __basicSvgLayer = null;
  let __basicSvgPath = null;
  let __basicActiveModeEl = null;
  let __basicActiveHzEl = null;
  let __startLineAnimation = null; // 用于外部调用的连线动画启动函数

  // 默认性能模式配置（作为兜底）
  const __defaultPerfConfig = {
    low:  { color: "#00A86B", text: "低功耗模式 传感器帧率 1000~5000 AutoFPS" },
    hp:   { color: "#000000", text: "标准模式 传感器帧率 1000~20000 AutoFPS" },
    sport:{ color: "#FF4500", text: "竞技模式 传感器帧率 10800 FPS" },
    oc:   { color: "#4F46E5", text: "超频模式 传感器帧率 25000 FPS " },
  };

  // 优先读取 refactor.js 中的配置，否则使用默认值
  const __basicModeConfig = adapter?.ui?.perfMode || __defaultPerfConfig;

  function syncBasicMonolithUI() {
    const root = document.getElementById("basicMonolith");
    if (!root) return;

    const perf = document.querySelector('input[name="perfMode"]:checked')?.value || "low";
    const hz = document.getElementById("pollingSelect")?.value || "1000";

    // 左列：性能模式
    __basicActiveModeEl = null;
    __basicModeItems.forEach((el) => {
      const on = el.dataset.perf === perf;
      el.classList.toggle("active", on);
      if (on) __basicActiveModeEl = el;
    });

    // 右列：回报率
    __basicActiveHzEl = null;
    __basicHzItems.forEach((el) => {
      const on = String(el.dataset.hz) === String(hz);
      el.classList.toggle("active", on);
      if (on) __basicActiveHzEl = el;
    });

    // 底部 ticker / status
    const ticker = document.getElementById("basicHzTicker");
    if (ticker) ticker.innerHTML = '<span class="ticker-label">轮询率：</span>' + String(hz) + " HZ";

    const st = document.getElementById("basicStatusText");
    const cfg = __basicModeConfig[perf] || __basicModeConfig.low;
    if (st) st.textContent = cfg.text;

    // 主题色：仅在基础性能页时改变（避免影响其它页面）
    if (document.body.classList.contains("page-basic")) {
      document.documentElement.style.setProperty("--theme-color", cfg.color);
    }

    // 触发连线动画更新（当用户点击切换模式时）
    if (typeof __startLineAnimation === 'function') {
      __startLineAnimation(600);
    }
  }

  function __basicSetPerf(perf) {
    const r = document.querySelector(`input[name="perfMode"][value="${perf}"]`);
    if (!r) return;
    r.checked = true;
    r.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function __basicSetHz(hz) {
    const sel = document.getElementById("pollingSelect");
    if (!sel) return;
    sel.value = String(hz);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function __basicBindItem(el, handler) {
    el.addEventListener("click", (e) => {
      const t = e.target;
      // 如果点击的是内部的原生控件，让它自己处理，不再重复调用 handler
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

  function initBasicMonolithUI() {
    if (__basicMonolithInited) return;
    const root = document.getElementById("basicMonolith");
    if (!root) return;

    __basicMonolithInited = true;

    __basicModeItems = Array.from(root.querySelectorAll("#basicModeColumn .basicItem[data-perf]"));
    __basicHzItems = Array.from(root.querySelectorAll("#basicHzColumn .basicItem[data-hz]"));
    __basicSvgLayer = root.querySelector("#basicSynapseLayer");
    __basicSvgPath = root.querySelector("#basicSynapseLayer .basicConnectionPath");

    // Wrap the visible text content so we can align the curve to the actual glyph box.
    // IMPORTANT: handle whitespace text nodes correctly (right column has anchor first).
    const ensureLabelSpan = (item, side) => {
      if (!item || item.querySelector(":scope > .basicLabel")) return;

      const anchor = item.querySelector(":scope > .basicAnchor") || item.querySelector(".basicAnchor");
      // Extract visible text (avoid being affected by whitespace / newlines in HTML).
      const text = (item.textContent || "").replace(/\s+/g, " ").trim();

      const label = document.createElement("span");
      label.className = "basicLabel";
      label.textContent = text;

      // Clear all nodes (including stray whitespace), then rebuild in a deterministic order.
      // Keep the existing anchor element so styles remain unchanged.
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

    // Keep SVG user units mapped to pixels 1:1 for stable math.
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

    // 当隐藏表单控件被外部逻辑更新时（例如设备回包 applyConfigToUi），同步 UI
    document.getElementById("pollingSelect")?.addEventListener("change", syncBasicMonolithUI);
    document.querySelectorAll('input[name="perfMode"]').forEach((r) => {
      r.addEventListener("change", syncBasicMonolithUI);
    });

    // 连线动画实现：
    // 1) 使用文字 glyph 的 bounding box，而不是 1px anchor 点
    // 2) 使用 SVG 的屏幕坐标变换矩阵，把 client 坐标精确映射到 SVG 坐标，避免任何 transform/scale 造成的漂移
    // 3) 端点始终落在文字外侧，绝不压在字下
    const clientToSvg = (x, y) => {
      if (!__basicSvgLayer || !__basicSvgLayer.getScreenCTM) return { x, y };
      const ctm = __basicSvgLayer.getScreenCTM();
      if (!ctm) return { x, y };
      const inv = ctm.inverse();
      // DOMPoint is widely supported; fall back to SVGPoint.
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

    const getAttachPoint = (item, side) => {
      const label = item?.querySelector(".basicLabel") || item;
      if (!label) return null;
      const r = label.getBoundingClientRect();
      if (!r || !isFinite(r.left) || !isFinite(r.top)) return null;

      const isActive = item.classList.contains("active");
      // pad scales with font size and adds extra room for text-shadow on active items
      const basePad = Math.max(16, Math.min(44, r.height * 0.24));
      const pad = basePad + (isActive ? 14 : 0);

      // active glyphs feel vertically lower due to big text-shadow; bias slightly upward
      const yBias = isActive ? 0.50 : 0.54;
      const y = r.top + r.height * yBias;
      const x = side === "left" ? r.right + pad : r.left - pad;
      return { x, y };
    };

    // --- 优化开始：移除无限循环，改为按需动画 ---
    let lineRafId = 0;
    
    // 执行一次连线更新
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
        
        // 仅当路径实际变化时才写入 DOM
        if (__basicSvgPath.getAttribute("d") !== d) {
            __basicSvgPath.setAttribute("d", d);
        }
      }
    };

    // 启动动画循环（持续 duration 毫秒后自动停止）
    const startLineAnimation = (duration = 800) => {
      if (lineRafId) cancelAnimationFrame(lineRafId);
      const start = performance.now();
      
      const loop = (now) => {
        updateLineOnce();
        // 如果时间未到，或者侧边栏/选中项仍在过渡动画中，继续下一帧
        if (now - start < duration) {
          lineRafId = requestAnimationFrame(loop);
        } else {
          lineRafId = 0;
        }
      };
      lineRafId = requestAnimationFrame(loop);
    };

    // 将函数暴露到全局，供 syncBasicMonolithUI 调用
    __startLineAnimation = startLineAnimation;

    // 事件监听：仅在必要时触发动画
    // 1. 窗口大小改变时（快速更新）
    window.addEventListener("resize", () => startLineAnimation(100));
    
    // 2. 侧边栏过渡结束时（布局稳定后校准一次）
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        sidebar.addEventListener('transitionend', () => startLineAnimation(100));
    }

    // 初始运行一次
    startLineAnimation(100);
    
    // --- 优化结束 ---

    // 初始同步
    syncBasicMonolithUI();
  }


  // =========================================
  // Advanced Panel UI (匹配“高级参数UI样式.html”)
  // - 休眠/防抖：滑块离散档位（同步到隐藏 select，保留原写入逻辑）
  // - 数码读数：angle/feel
  // =========================================

  let __advancedPanelInited = false;

  function __optList(selectEl) {
    if (!selectEl) return [];
    const opts = Array.from(selectEl.options || []);
    return opts.map((o) => ({
      val: String(o.value ?? ""),
      rawLabel: String(o.textContent ?? o.label ?? o.value ?? "")
    }));
  }

  function __formatSleepLabel(valStr, rawLabel) {
    const raw = String(rawLabel || "");

    // 若 label 已包含单位（如 2m/10m/120m），提取数值部分
    if (/[a-zA-Z]/.test(raw) && raw.trim().length <= 8) {
      const numMatch = raw.match(/^(\d+)/);
      if (numMatch) return numMatch[1];
      return raw.trim();
    }

    // 形如：900(15m) -> 提取数值
    const m = raw.match(/\(([^)]+)\)/);
    if (m && m[1]) {
      const numMatch = m[1].match(/^(\d+)/);
      if (numMatch) return numMatch[1];
      return m[1].trim();
    }

    const v = Number(valStr);
    if (!Number.isFinite(v)) return raw || (valStr || "-");

    // 返回纯数值（不包含单位）
    if (v >= 3600 && v % 3600 === 0) return String(v / 3600);
    if (v >= 60 && v % 60 === 0 && v < 3600) return String(v / 60);
    return String(v);
  }

  function __getSleepUnit(valStr) {
    const v = Number(valStr);
    if (!Number.isFinite(v)) return "";
    
    // 小于60秒显示"s"，大于等于60秒显示"min"
    if (v < 60) return "s";
    return "min";
  }

  function __formatDebounceLabel(valStr, rawLabel) {
    const v = Number(valStr);
    if (Number.isFinite(v)) return String(v);
    return String(rawLabel || valStr || "-");
  }

  function __clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

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
      // 如果有单位函数，设置单位
      if (getUnit && typeof getUnit === 'function') {
        dispEl.setAttribute('data-unit', getUnit(String(o.val)));
      }
    }
    return { opts, idx };
  }

  // 仅更新休眠时间鳍片UI（不触发其他同步，避免在input事件中重置滑块值）
  function updateSleepFins() {
    const sleepInput = document.getElementById("sleepInput");
    const sleepFinDisplay = document.getElementById("sleepFinDisplay");

    if (sleepInput && sleepFinDisplay) {
      // 获取实际的范围值
      const currentIdx = parseInt(sleepInput.value) || 0;
      const minIdx = parseInt(sleepInput.min) || 0;
      const maxIdx = parseInt(sleepInput.max) || 6;
      
      // 计算当前值在范围内的比例 (0.0 ~ 1.0)
      let progress = 0;
      if (maxIdx > minIdx) {
        progress = (currentIdx - minIdx) / (maxIdx - minIdx);
        progress = Math.max(0, Math.min(1, progress)); // 确保在 0-1 范围内
      } else if (currentIdx >= minIdx) {
        progress = 1; // 如果最大值等于最小值，且当前值等于它们，则显示全部
      }
      
      const fins = sleepFinDisplay.querySelectorAll(".fin");
      const totalFins = fins.length; // 总共7个鳍片
      
      // 根据比例计算应该激活的鳍片数量
      // 使用 Math.ceil 确保至少显示1个（当值不为最小值时）
      // 或者使用 Math.round 更精确，但最小值时可能不显示
      // 这里使用 Math.ceil，但特殊处理最小值情况
      let activeCount = 0;
      if (progress > 0) {
        // 非最小值时，向上取整，确保有视觉反馈
        activeCount = Math.ceil(progress * totalFins);
      }
      // 如果 progress === 0，activeCount 保持为 0（最小值时不显示任何鳍片）

      fins.forEach((fin, index) => {
        // 逻辑：根据 activeCount 来决定哪些鳍片应该激活
        if (index < activeCount) {
          fin.classList.add("active");
          // 增加微小的延迟偏移，产生那种"咔咔咔"逐个翻转的机械感
          fin.style.transitionDelay = `${index * 0.03}s`;
        } else {
          fin.classList.remove("active");
          fin.style.transitionDelay = "0s";
        }
      });
    }
  }

  function syncAdvancedPanelUi() {
    const root = document.getElementById("advancedPanel");
    if (!root) return;

    // 休眠 / 防抖：select <-> range(离散索引) 同步
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

    // 防抖同步逻辑：宽幅稳定器
    const debounceInput = document.getElementById("debounceInput");
    const debounceBar = document.getElementById("debounceBar");

    if (debounceInput && debounceBar) {
      const val = parseFloat(debounceInput.value) || 0;
      const min = parseFloat(debounceInput.min) || 0;
      const max = parseFloat(debounceInput.max) || 10; 
      
      // 归一化进度 (0.0 ~ 1.0)
      let pct = (val - min) / (max - min);
      if (isNaN(pct)) pct = 0;
      if (max === min) pct = 0;
      
      // 驱动宽条
      // 最小宽度 4px (保留一根线，不消失)
      // 最大宽度 100px (视窗总宽120px，左右留白10px)
      const minW = 4;
      const maxW = 100; 
      const widthPx = minW + (pct * (maxW - minW));
      
      debounceBar.style.width = `${widthPx}px`;
    }

    // 角度同步：水平仪逻辑
    const angleInput = document.getElementById("angleInput");
    const angleDisp = document.getElementById("angle_disp");
    const horizonLine = document.getElementById("horizonLine"); // 获取水平线元素

    if (angleInput) {
      const val = Number(angleInput.value ?? 0);
      
      // 更新文字读数
      if (angleDisp) angleDisp.textContent = String(val);
      
      // 更新水平线旋转
      // 注意：正值通常代表顺时针旋转，负值逆时针，符合视觉直觉
      if (horizonLine) {
        horizonLine.style.transform = `translateY(-50%) rotate(${val}deg)`;
      }
    }

    // 高度/手感同步逻辑
    const feelInput = document.getElementById("feelInput");
    const feelDisp = document.getElementById("feel_disp");
    const heightBlock = document.getElementById("heightBlock"); // 获取悬浮块

    if (feelInput) {
      const val = parseFloat(feelInput.value) || 0;
      
      // 动态获取当前 min/max (兼容 Rapoo 0.7-1.7 和 Chaos 0-60)
      const min = parseFloat(feelInput.min) || 0;
      // 这是一个防呆保护，防止除以0
      const max = parseFloat(feelInput.max) === min ? (min + 100) : parseFloat(feelInput.max); 
      
      // 更新文字
      if (feelDisp) feelDisp.textContent = String(val);

      // 更新悬浮块位置
      if (heightBlock) {
        // 1. 计算当前进度的百分比 (0.0 ~ 1.0)
        let pct = (val - min) / (max - min);
        pct = Math.max(0, Math.min(1, pct));
        
        // 2. 映射到像素高度
        // 最低点: bottom: 6px (贴在地面线上)
        // 最高点: bottom: 30px (接近顶部，预留缓冲)
        // 行程: 24px
        const bottomPx = 6 + (pct * 24);
        
        heightBlock.style.bottom = `${bottomPx}px`;
      }
    }

    // 移动到函数底部：确保 sleepInput.value 已经被 __syncDiscreteSlider 更新后，再渲染百叶窗鳍片
    updateSleepFins();
  }

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

    // range -> select（保留原写入逻辑：依然监听 select.change）
    if (sleepInput) {
      sleepInput.addEventListener("input", () => {
        const opts = __optList(sleepSel);
        const idx = __clamp(Number(sleepInput.value) || 0, 0, Math.max(0, opts.length - 1));
        const o = opts[idx] || { val: sleepSel?.value ?? "", rawLabel: "" };
        if (sleepDisp) {
          sleepDisp.textContent = __formatSleepLabel(o.val, o.rawLabel);
          sleepDisp.setAttribute('data-unit', __getSleepUnit(o.val));
        }
        // 实时更新鳍片UI（仅UI变化，不触发写入，不重置滑块值）
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
        
        // 实时更新防抖条宽度（仅UI变化）
        const debounceBar = document.getElementById("debounceBar");
        if (debounceBar) {
          const val = parseFloat(debounceInput.value) || 0;
          const min = parseFloat(debounceInput.min) || 0;
          const max = parseFloat(debounceInput.max) || 10;
          
          // 归一化进度 (0.0 ~ 1.0)
          let pct = (val - min) / (max - min);
          if (isNaN(pct)) pct = 0;
          if (max === min) pct = 0;
          
          // 驱动宽条
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

    // 当 select 被外部逻辑更新（例如 applyConfigToUi）时，同步到滑块/读数
    sleepSel?.addEventListener("change", syncAdvancedPanelUi);
    debounceSel?.addEventListener("change", syncAdvancedPanelUi);

    // 滑条读数同步（写入逻辑在原有 angleInput/feelInput 监听中）
    const angleInput = document.getElementById("angleInput");
    const feelInput = document.getElementById("feelInput");
    angleInput?.addEventListener("input", syncAdvancedPanelUi);
    feelInput?.addEventListener("input", syncAdvancedPanelUi);

    // 初始同步一次
    syncAdvancedPanelUi();
  }



  // 为新的 nav-item 添加点击事件
  sidebarItems.forEach(item => {
      item.addEventListener('click', () => {
          const key = item.getAttribute("data-key");
          if (key) location.hash = "#" + key;
      });
  });

  // 确保初始化时调用
  window.removeEventListener("hashchange", setActiveByHash); // 移除旧监听(如果有)
  window.addEventListener("hashchange", setActiveByHash);
  setActiveByHash();
  initBasicMonolithUI();
  initAdvancedPanelUI();

  // 兼容：旧 profileBtn 可能不存在
  $("#profileBtn")?.addEventListener("click", () => {
    location.hash = "#keys";
  });

  // ====== Logger ======
  const logBox = $("#logBox");
  function log(...args) {
    const line = args
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
      .join(" ");
    const ts = new Date().toLocaleTimeString();
    
    // 增加判空检查，防止页面元素不存在时报错
    if (logBox) {
      logBox.textContent += `[${ts}] ${line}\n`;
      logBox.scrollTop = logBox.scrollHeight;
    } else {
      // 备用：如果界面上没有日志框，则输出到控制台方便调试
      console.log(`[${ts}] ${line}`);
    }
  }
  function logErr(err, prefix = "错误") {
    const msg = err?.message || String(err);
    log(`${prefix}: ${msg}`);
    console.error(err);
  }

  // 使用 ?. (可选链) 防止按钮不存在时报错
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


  // ====== ProtocolApi wiring ======
  try { await DeviceRuntime?.whenProtocolReady?.(); } catch (e) {}
  const ProtocolApi = window.ProtocolApi;
  if (!ProtocolApi) {
    log("未找到 ProtocolApi：请确认 protocol_api_chaos.js / protocol_api_rapoo.js 已正确加载。");
    return;
  }


  // 替换原来的"先 close 再 new"逻辑
  let hidApi = window.__HID_API_INSTANCE__;
  if (!hidApi) {
    hidApi = new ProtocolApi.MouseMouseHidApi();
    window.__HID_API_INSTANCE__ = hidApi;
  }

  // ====== 页面卸载时强制关闭连接（防止刷新后句柄仍被占用）======
  // 注意：beforeunload/pagehide 回调里无法可靠 await，但依然是 best effort
  if (!window.__HID_UNLOAD_HOOKED__) {
    window.__HID_UNLOAD_HOOKED__ = true;

    const safeClose = () => {
      try { void window.__HID_API_INSTANCE__?.close(); } catch (_) {}
    };

    window.addEventListener("beforeunload", safeClose);
    // pagehide 对移动端/现代浏览器更友好
    window.addEventListener("pagehide", safeClose);
  }


  // ====== 设备配置管理 ======
  // 策略：单次读取 + 回包同步（不进行自动轮询，避免对鼠标造成性能卡顿）
  let __lastConfigRequestAt = 0;

  // ====== 写入权限控制 ======
  // 写入开关机制：
  // - 刷新页面时，UI 初始化阶段可能会触发一些程序化的 change 事件（例如基础页的 dispatchEvent）
  // - 在收到"第一包 config"之前，禁止任何 setFeature/setBatchFeatures 写入操作
  //   避免将默认 UI 状态错误下发到设备，导致设备配置被覆盖
  let __writesEnabled = false;

  // ====== 起始页进入主应用的门闩机制 ======
  // 必须等到"首次配置已成功应用到 UI"后才允许揭幕进入主应用
  // 确保用户看到的是从设备读取的真实配置，而非默认值
  let __firstConfigAppliedResolve = null;
  let __firstConfigAppliedPromise = Promise.resolve();
  let __firstConfigAppliedDone = false;

function __resetFirstConfigAppliedGate() {
  __firstConfigAppliedDone = false;
  __firstConfigAppliedPromise = new Promise((resolve) => { __firstConfigAppliedResolve = resolve; });
}

async function __waitForUiRefresh() {
  // 等两帧，确保 DOM 已按配置刷新完成（避免进入主页后再“跳变”）
  await new Promise((r) => requestAnimationFrame(() => r()));
  await new Promise((r) => requestAnimationFrame(() => r()));
}

// Chaos：用于 modeByte 增量写入的 base（防止只改一个开关时把其他 bit 覆盖掉）
let __lastChaosModeByte = null;

/**
 * 请求设备配置（单次读取）
 * 采用轻量节流机制，避免用户频繁切页/重复点击导致连续请求
 * @param {string} reason - 请求原因（用于日志记录，可选）
 */
async function requestConfigOnce(reason = "") {
  if (!isHidOpened()) return;
  const now = Date.now();
  // 节流：800ms 内不重复请求
  if (now - __lastConfigRequestAt < 800) return;
  __lastConfigRequestAt = now;

  // 尝试多种可能的配置读取接口名称（兼容不同协议实现）
  const fn =
    hidApi.requestConfig ||
    hidApi.requestConfiguration ||
    hidApi.getConfig ||
    hidApi.readConfig ||
    hidApi.requestDeviceConfig;

  if (typeof fn !== "function") {
    // 不抛错，避免影响连接流程
    log("当前 ProtocolApi 未暴露配置读取接口，无法读取设备配置。");
    return;
  }

  try {
    await fn.call(hidApi);
    if (reason) log(`已请求配置(${reason})`);

    // Rapoo 设备：状态包为被动上报
    // 读取配置后仅做一次"电量显示刷新"（同步最近一次状态包解析值）
    if (IS_RAPOO) await requestBatterySafe("config");
  } catch (e) {
    logErr(e, "请求配置失败");
  }
}

// 监听配置回包：用于刷新所有页面 UI（基础性能页也会跟随更新）
hidApi.onConfig((cfg) => {
  try {
    applyConfigToUi(cfg);
    // 收到配置即代表链路可用（用于 isHidReady 的兜底）
    hidLinked = true;

    // 只有拿到 config 并成功应用到 UI 后，才允许写入
    __writesEnabled = true;

    // 通知：已拿到并应用第一包配置（供起始页 SYSTEM READY 阶段等待）
    if (!__firstConfigAppliedDone && typeof __firstConfigAppliedResolve === "function") {
      __firstConfigAppliedDone = true;
      try { __firstConfigAppliedResolve(cfg); } catch (_) {}
    }

    // 记录 Chaos 的 base modeByte（用于后续增量写）
    if (!IS_RAPOO) {
      const mb = cfg?.modeByte ?? cfg?.mode_byte ?? cfg?.deviceState?.modeByte ?? cfg?.deviceState?.mode_byte;
      const n = Number(mb);
      if (Number.isFinite(n)) __lastChaosModeByte = n & 0xff;
    }
  } catch (e) {
    logErr(e, "应用配置失败");
  }
});

  // ---- Auto reconnect (WebHID) ----
  const LAST_HID_KEY = "mouse.lastHid";

  function saveLastHidDevice(dev) {
    try {
      localStorage.setItem(LAST_HID_KEY, JSON.stringify({
        vendorId: dev.vendorId,
        productId: dev.productId,
        productName: dev.productName || "",
        ts: Date.now()
      }));
    } catch (_) {}
  }

  function loadLastHidDevice() {
    try {
      return JSON.parse(localStorage.getItem(LAST_HID_KEY) || "null");
    } catch (_) {
      return null;
    }
  }

  function isMouseHidDevice(dev) {
    try {
      const pairs = ProtocolApi?.MOUSE_HID?.vendorProductIds || [];
      return pairs.some(([vid, pid]) => dev.vendorId === vid && dev.productId === pid);
    } catch (_) {
      return false;
    }
  }

  // ====== 自动检测逻辑 ======
  /**
   * 自动检测已授权且在线的设备对象
   * 返回最合适的设备用于自动连接
   * @returns {Promise<HIDDevice|null>} 检测到的设备对象，未找到则返回 null
   */
  async function autoConnectHidOnce() {
    if (!navigator.hid) return null;
    if (hidConnecting || __connectInFlight) return null;
    if (isHidOpened()) return null;

    let devs = [];
    try {
      // getDevices 只会返回满足以下条件的设备：
      // 1. 用户曾经授权过
      // 2. 当前正插在电脑上
      devs = await navigator.hid.getDevices();
    } catch (e) {
      return null;
    }

    // 过滤设备：确保是我们要的设备接口
      // 在过滤条件中包含 c.usagePage === 65290，确保 Chaos 设备的 Vendor Collection 被视为有效设备
    const validDevs = devs.filter(d => {
      const isRapoo = d.vendorId === 0x24ae;
      if (isRapoo) {
        // 硬编码规则：雷柏只接受 0xFF00 且 Usage 为 14 或 15 的接口
        return d.collections.some(c => c.usagePage === 0xff00 && (c.usage === 14 || c.usage === 15));
      }
      // 其他品牌设备：支持多种 usagePage（标准鼠标、Vendor Collection、Chaos Vendor 等）
      return d.collections && d.collections.some(c => 
        c.usagePage === 0x0001 || c.usagePage === 0xff00 || c.usagePage === 0x000c || c.usagePage === 65290
      );
    });

    if (validDevs.length === 0) {
        __autoDetectedDevice = null;
        return null;
    }

    // 预选设备策略：优先 Vendor Collection（更可能支持写入 report / 解锁指令），再考虑上次连接记录
    const saved = loadLastHidDevice();

    /**
     * 检查设备是否包含任意 Vendor Page（0xFF00-0xFFFF）
     * @param {HIDDevice} d - 设备对象
     * @returns {boolean} 是否包含 Vendor Page
     */
    const hasAnyVendorPage = (d) => {
      const cols = d?.collections || [];
      return Array.isArray(cols) && cols.some((c) => {
        const p = Number(c?.usagePage);
        return Number.isFinite(p) && p >= 0xFF00 && p <= 0xFFFF;
      });
    };
    /**
     * 检查设备是否包含指定的 usagePage
     * @param {HIDDevice} d - 设备对象
     * @param {number} page - 目标 usagePage
     * @returns {boolean} 是否包含指定 usagePage
     */
    const hasUsagePage = (d, page) => {
      const cols = d?.collections || [];
      return Array.isArray(cols) && cols.some((c) => Number(c?.usagePage) === Number(page));
    };
    /**
     * 检查设备是否包含指定的 output report ID
     * @param {HIDDevice} d - 设备对象
     * @param {number} rid - 目标 report ID
     * @returns {boolean} 是否包含指定 report ID
     */
    const hasOutRid = (d, rid) => {
      const cols = d?.collections || [];
      return Array.isArray(cols) && cols.some((c) => Array.isArray(c?.outputReports) && c.outputReports.some((r) => Number(r?.reportId) === Number(rid)));
    };

    /**
     * 为设备打分，用于选择最合适的设备
     * 评分规则：Vendor Collection > 上次连接记录 > 设备类型匹配 > 非标准接口
     * @param {HIDDevice} d - 设备对象
     * @returns {number} 设备评分（分数越高优先级越高）
     */
    const scoreDev = (d) => {
      let s = 0;
      if (!d) return s;
      const t = (() => { try { return DeviceRuntime.identifyDeviceType(d); } catch (_) { return null; } })();
      const cur = (() => { try { return DeviceRuntime.getSelectedDevice(); } catch (_) { return null; } })();

      // Vendor Collection 权重最高（支持写入和协议解锁）
      if (hasUsagePage(d, 65290)) s += 900;      // 0xFF0A（Chaos 设备常见）
      if (hasUsagePage(d, 0xFF00)) s += 600;     // 0xFF00（通用 Vendor）
      if (hasAnyVendorPage(d)) s += 300;         // 其它 Vendor Page

      // Rapoo 设备：协议解锁需要用到 rid=6 的 output report
      if (hasOutRid(d, 6)) s += 1200;

      // 设备类型轻微加权：优先当前驱动类型（避免频繁 autoSwitch/reload）
      if (t && cur && t === cur) s += 50;

      // 上次连接记录（加权小于 Vendor Collection）
      if (saved && d.vendorId === saved.vendorId && d.productId === saved.productId) s += 200;

      // 保底分数：非标准鼠标接口（usagePage != 0x0001）
      if (Array.isArray(d?.collections) && d.collections.some((c) => Number(c?.usagePage) !== 0x0001)) s += 30;
      return s;
    };

    let picked = null;
    try {
      picked = [...validDevs].sort((a, b) => scoreDev(b) - scoreDev(a))[0] || null;
    } catch (_) {
      picked = validDevs[0] || null;
    }

    __autoDetectedDevice = picked;

    // UI 提示更新
    if (picked) {
      document.body.classList.add("landing-has-device");
      const name = ProtocolApi.resolveMouseDisplayName(
        picked.vendorId,
        picked.productId,
        picked.productName || "HID Device"
      );
      // 如果正在自动连接，文案会稍后由 connectHid 更新，这里仅作兜底
      __setLandingCaption(`检测到设备：${name}`);
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

  // 顶部状态胶囊：仅在“鼠标真正连上(握手成功)”后显示。
  // 仅插接收器 / 鼠标未开机 / 未配对时：顶部什么都不显示。
  function setHeaderChipsVisible(visible) {
    [hdrBattery, hdrHid, hdrFw].forEach((el) => {
      if (!el) return;
      el.style.display = visible ? "" : "none";
    });
  }

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

  function formatFwForChip(fwText) {
    if (!fwText) return "-";
    // 兼容两种格式：Mouse:1.0.0 · RX:1.0.0 / Mouse 1.0.0 · RX 1.0.0
    return fwText
      .replace("Mouse:", "Mouse ")
      .replace("RX:", "RX ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // 默认隐藏顶部胶囊（只有握手成功才显示）
  resetHeaderChipValues();
  setHeaderChipsVisible(false);

  const dpiList = $("#dpiList");
  const dpiMinSelect = $("#dpiMinSelect");
  const dpiMaxSelect = $("#dpiMaxSelect");

  const DPI_ABS_MIN = 100;
  const DPI_ABS_MAX = 44000; // 固件绝对上限（保留）
  let DPI_UI_MAX = 26000;  // UI 允许的最大可选值（由 capabilities 注入）
  const DPI_STEP = 50;


// ====== Capabilities 注入：所有硬件限制/枚举由后端回包决定 ======
// 仅作为 UI 渲染依据，不做任何协议/寄存器/位运算。
let __capabilities = {
  dpiSlotCount: 6,
  maxDpi: DPI_UI_MAX,
  pollingRates: null, // e.g. [125, 500, 1000]
};

function getCapabilities() {
  return __capabilities || {};
}

function getDpiSlotCap() {
  const n = Number(getCapabilities().dpiSlotCount);
  return Math.max(1, Number.isFinite(n) ? Math.trunc(n) : 6);
}

function clampSlotCountToCap(n, fallback = 6) {
  const cap = getDpiSlotCap();
  const v = Number(n);
  const vv = Number.isFinite(v) ? Math.trunc(v) : fallback;
  return Math.max(1, Math.min(cap, vv));
}

function applyCapabilitiesToUi(cap) {
  const incoming = (cap && typeof cap === "object") ? cap : {};
  const prevCap = getCapabilities();

  // 合并能力配置
  const next = {
    dpiSlotCount: Number.isFinite(Number(incoming.dpiSlotCount)) ? Math.trunc(Number(incoming.dpiSlotCount)) : (prevCap.dpiSlotCount ?? 6),
    maxDpi: Number.isFinite(Number(incoming.maxDpi)) ? Math.trunc(Number(incoming.maxDpi)) : (prevCap.maxDpi ?? DPI_UI_MAX),
    pollingRates: Array.isArray(incoming.pollingRates)
      ? incoming.pollingRates.map(Number).filter(Number.isFinite)
      : (prevCap.pollingRates ?? null),
  };

  __capabilities = next;

  // ---- 1. 更新 DPI Max ----
  if (Number.isFinite(next.maxDpi) && next.maxDpi > 0) {
    DPI_UI_MAX = next.maxDpi;
    
    // 重新生成列表并补齐最大值
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

  // ---- 2. 更新 DPI 档位数 ----
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

  // ---- 3. 更新回报率选项 & 显隐基础性能页按钮 ----
  const pollingSel = $("#pollingSelect");
  if (pollingSel && Array.isArray(next.pollingRates) && next.pollingRates.length) {
    const cur = Number(pollingSel.value || next.pollingRates[0]);
    
    // A. 更新下拉框 (虽然界面上被 Monolith UI 遮盖，但作为数据源很重要)
    pollingSel.innerHTML = next.pollingRates
      .map((hz) => `<option value="${hz}">${hz}Hz</option>`)
      .join("");

    // B. 值校验：如果当前值(如4000)不在新列表中(切回有线)，自动降级到 1000 或列表首项
    let validVal = cur;
    if (!next.pollingRates.includes(cur)) {
        validVal = next.pollingRates.includes(1000) ? 1000 : next.pollingRates[0];
    }
    safeSetValue(pollingSel, validVal);

    // C. 控制基础性能页 2K/4K/8K 按钮的显示/隐藏
    if (__basicHzItems && __basicHzItems.length) {
      // 将允许的 Hz 转为字符串 Set，方便查找
      const allowed = new Set(next.pollingRates.map(String));
      
      __basicHzItems.forEach((el) => {
        const h = el.dataset.hz; // 按钮上的 data-hz="4000"
        if (allowed.has(String(h))) {
          el.style.display = ""; // 显示
        } else {
          el.style.display = "none"; // 隐藏
        }
      });
      
      // 立即刷新选中状态连线
      syncBasicMonolithUI();
    }
  }

  // ---- 4. 重建 DPI 编辑器 (如果行数变了) ----
  if (typeof buildDpiEditor === "function") {
    const needRebuild = (Number(prevCap?.dpiSlotCount) || 6) !== capSlots;
    if (needRebuild) buildDpiEditor();
  }
}


  // DPI范围最小值：保留   用档位（不超过 UI_MAX）
  const DPI_MIN_OPTIONS = [
    100, 200, 400, 800, 1200, 1600,
  ];

  // DPI范围最大值：4000 ~ 26000（步进 50）
  function makeSeq(start, end, step) {
    const out = [];
    for (let v = start; v <= end; v += step) out.push(v);
    return out;
  }
  let DPI_MAX_OPTIONS = makeSeq(4000, DPI_UI_MAX, 4000);
  if (DPI_MAX_OPTIONS[DPI_MAX_OPTIONS.length - 1] !== DPI_UI_MAX) {
    DPI_MAX_OPTIONS.push(DPI_UI_MAX);
  }

  function fillSelect(el, values, defVal) {
    if (!el) return;
    el.innerHTML = values
      .map((v) => `<option value="${v}">${v}</option>`)
      .join("");
    safeSetValue(el, defVal);
  }

  function getDpiMinMax() {
    const min = Number(dpiMinSelect?.value ?? 100);
    // 读取下拉框当前选中的值，而不是强制返回硬件最大值 DPI_UI_MAX
    const max = Number(dpiMaxSelect?.value ?? DPI_UI_MAX);
    return { min, max };
  }

  function normalizeDpiMinMax() {
    if (!dpiMinSelect || !dpiMaxSelect) return;
    let { min, max } = getDpiMinMax();

    // 1. 校验并限制 Max (UI层面限制)
    // 确保 Max 有效，且在 [4000, 硬件上限] 之间
    if (!Number.isFinite(max) || max <= 0) max = DPI_UI_MAX;
    max = Math.max(4000, Math.min(DPI_UI_MAX, max));

    // 2. 校验并限制 Min
    if (!Number.isFinite(min) || min <= 0) min = 100;
    
    // Min 必须小于 Max (至少留出 DPI_STEP 的空间)
    const minCap = max - DPI_STEP; 
    
    // 确保 Min 不低于绝对最小值，且不超过 (Max - Step)
    min = Math.max(DPI_ABS_MIN, Math.min(min, minCap));

    // 3. 极端情况兜底：如果计算后 min >= max，则强制推高 max
    if (min >= max) {
       max = min + DPI_STEP;
       // 如果推高后超过硬件上限，则反向压低 min
       if (max > DPI_UI_MAX) {
          max = DPI_UI_MAX;
          min = max - DPI_STEP;
       }
    }

    // 4. 将校验后的值写回 UI
    safeSetValue(dpiMinSelect, min);
    // 写回用户选择的 max，而不是 DPI_UI_MAX
    safeSetValue(dpiMaxSelect, max);
  }

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

  function clamp(v, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  // DPI 选中档位（UI 状态）：用于本地即时高亮 + 与按键映射一致的选中效果
  let uiCurrentDpiSlot = 1; // 1..6
  let dpiAnimReady = false; // 避免首次渲染就触发选中动效

  // ====== Patch v4: DPI 滑条数值气泡（跟随 thumb） ======
  let dpiBubbleListenersReady = false;
  let dpiDraggingSlot = null;
  let dpiDraggingEl = null;

  // Patch v6.1: 仅在滑轨“上下区域”支持拖动，左右空白仍保持点击切换档位
  let dpiRowDragState = null; // { slot, range, pointerId, moved, lastX, lastY }
  let dpiRowDragBlockClickUntil = 0;

  function getDpiBubble(slot) {
    return $("#dpiBubble" + slot);
  }

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

    // thumb 尺寸：尽量从 CSS 变量解析，失败则回退
    const cssThumb = parseFloat(getComputedStyle(range).getPropertyValue("--dpiThumb"));
    const thumb = Number.isFinite(cssThumb) && cssThumb > 0 ? cssThumb : 22;

    const trackW = rangeRect.width;
    const x = pct * Math.max(0, (trackW - thumb)) + thumb / 2;

    // 使用 portal（body）+ fixed 定位，避免被面板 overflow 裁剪
    const pageX = rangeRect.left + x;
    const pageY = rangeRect.top + rangeRect.height / 2;

    // 轻微边缘约束，避免贴边看不清
    const margin = 10;
    const clampedX = Math.max(margin, Math.min(window.innerWidth - margin, pageX));

    bubble.style.left = clampedX + "px";
    bubble.style.top = pageY + "px";

    // 如果在视口顶部空间不足，则翻转到下方显示
    bubble.classList.remove("flip");
    const bRect = bubble.getBoundingClientRect();
    if (bRect.top < 6) bubble.classList.add("flip");
  }

  function showDpiBubble(slot) {
    const bubble = getDpiBubble(slot);
    if (!bubble) return;
    bubble.classList.add("show");
    requestAnimationFrame(() => updateDpiBubble(slot));
  }

  function hideDpiBubble(slot) {
    const bubble = getDpiBubble(slot);
    if (!bubble) return;
    bubble.classList.remove("show");
  }

  function updateVisibleDpiBubbles() {
    for (let i = 1; i <= getDpiSlotCap(); i++) {
      const b = getDpiBubble(i);
      if (b?.classList.contains("show")) updateDpiBubble(i);
    }
  }



  function getSlotCountUi() {
    const el = $("#slotCountSelect");
    const n = Number(el?.value ?? getDpiSlotCap());
    return clampSlotCountToCap(n, getDpiSlotCap());
  }

  function setActiveDpiSlot(slot, slotCountOverride) {
    const prev = uiCurrentDpiSlot;
    const slotCount = clampSlotCountToCap(Number(slotCountOverride ?? getSlotCountUi()), getDpiSlotCap());
    const s = Math.max(1, Math.min(slotCount, Number(slot) || 1));
    uiCurrentDpiSlot = s;

    // summary
    const sum = $("#dpiSummary");
    if (sum) sum.textContent = `当前:${s} 档 · 共 ${slotCount} 档`;

    const changed = s !== prev;

    // highlight + selected animation
    for (let i = 1; i <= getDpiSlotCap(); i++) {
      const row = dpiList?.querySelector?.(`.dpiSlotRow[data-slot="${i}"]`);
      if (!row) continue;
      const hidden = row.classList.contains("hidden");
      const isActive = !hidden && i === s;

      row.classList.toggle("active", isActive);
      if (!isActive) row.classList.remove("active-anim");

      // 仅当档位真正发生变化时播放一次动效
      if (isActive && dpiAnimReady && changed) {
        row.classList.remove("active-anim");
        void row.offsetWidth; // 强制重排，保证可重复播放
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
  function setDpiRowsEnabledCount(count) {
    const n = clampSlotCountToCap(Number(count), getDpiSlotCap());
    for (let i = 1; i <= getDpiSlotCap(); i++) {
      const row = dpiList?.querySelector(`.dpiSlotRow[data-slot="${i}"]`);
      const hidden = i > n;

      // 不需要的档位直接隐藏（而不是变灰）
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

  function initDpiRangeControls() {
    if (!dpiMinSelect || !dpiMaxSelect) return;
    if (dpiMinSelect.options.length) return;
    fillSelect(dpiMinSelect, DPI_MIN_OPTIONS, 100);
    fillSelect(dpiMaxSelect, DPI_MAX_OPTIONS, 16000);
    normalizeDpiMinMax();
    applyDpiRangeToRows();

    const onChange = () => {
      normalizeDpiMinMax();
      applyDpiRangeToRows();

      // 若当前值超出范围，则夹紧到范围内（只更新 UI，不强制写入设备）
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

  // ====== Color Picker Engine (ATK DPI Color) ======
  let __colorPicker = null;

  function initColorPicker() {
    if (__colorPicker) return __colorPicker;

    // 1. 创建 DOM
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

    // 2. 绘制色轮
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
      
      // 中心白色渐变（饱和度）
      const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grd.addColorStop(0, 'white');
      grd.addColorStop(1, 'transparent');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    };
    drawWheel();

    // 3. 状态管理
    let currentCallback = null;
    let isDragging = false;

    const setColor = (hex) => {
      preview.style.background = hex;
      hexInput.value = hex;
      if (currentCallback) currentCallback(hex);
    };

    const pickColor = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // 映射到 canvas 尺寸
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      
      const p = ctx.getImageData(x * scaleX, y * scaleY, 1, 1).data;
      // 简单防空：如果是全透明（圆外），忽略
      if (p[3] === 0) return;
      
      const hex = "#" + [p[0], p[1], p[2]].map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase();
      setColor(hex);
    };

    // 交互事件
    canvas.addEventListener("pointerdown", (e) => {
      isDragging = true;
      canvas.setPointerCapture(e.pointerId);
      pickColor(e);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (isDragging) pickColor(e);
    });
    canvas.addEventListener("pointerup", () => isDragging = false);

    const close = () => {
      wrap.classList.remove("open");
      currentCallback = null; // 解绑
    };

    btnClose.addEventListener("click", close);

    // 点击外部关闭
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
        // 定位
        const r = anchorEl.getBoundingClientRect();
        // 尝试放在按钮左侧，如果不够则放右侧
        let left = r.left - 280;
        if (left < 10) left = r.right + 20;
        
        let top = r.top - 100;
        // 边界检查
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

  function buildDpiEditor() {
    if (!dpiList) return;
    const dpiSlotCap = getDpiSlotCap();
    initDpiRangeControls();

    // Patch v5.1: DPI 气泡使用 portal（挂到 body），先清理旧节点避免重复
    for (let i = 1; i <= dpiSlotCap; i++) {
      const old = document.body.querySelector(`#dpiBubble${i}.dpiBubblePortal`);
      if (old) old.remove();
    }

    dpiList.innerHTML = "";

    const barColors = [
      "rgba(156,163,175,.55)",
      "#f97316", // orange
      "#22c55e", // green
      "#facc15", // yellow
      "#ec4899", // pink
      "#a855f7", // purple
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

    // Patch v5.1: 将气泡节点移动到 body（避免 overflow 裁剪）
    for (let i = 1; i <= dpiSlotCap; i++) {
      const b = $("#dpiBubble" + i);
      if (!b) continue;
      b.classList.add("dpiBubblePortal");
      document.body.appendChild(b);
    }

    // 事件代理：滑条/数值同步（拖动时只更新 UI，不立即写入；松手后再写入）
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

      // 这里不写入设备。写入逻辑放到 change(松手/完成编辑) 事件里。
    });


    // DPI 数值/滑块：松手( change )后才真正写入设备，拖动过程中仅更新 UI。
    dpiList.addEventListener("change", (e) => {
      const t = e.target;

      const isRange = t.matches("input.dpiRange");
      const isNum = t.matches("input.dpiNum");
      if (!isRange && !isNum) return;

      const id = t.id || "";
      const slot = Number(id.replace(/\D+/g, ""));
      if (!(slot >= 1 && slot <= dpiSlotCap)) return;

      const { min, max } = getDpiMinMax();

      // 解析输入值
      let val = Number(t.value);
      if (!Number.isFinite(val)) val = min;

      // 自动吸附到 DPI_STEP（默认 50）
      const step = (typeof DPI_STEP !== "undefined") ? DPI_STEP : 50;
      val = Math.round(val / step) * step;

      // 限制范围
      val = Math.max(min, Math.min(max, val));

      // 同步 UI
      const inp = $("#dpiInput" + slot);
      const rng = $("#dpiRange" + slot);
      if (inp) safeSetValue(inp, val);
      if (rng) safeSetValue(rng, val);
      updateDpiBubble(slot);

      // 松手后防抖写入（避免短时间内多次 change）
      debounceKey(`dpi:${slot}`, 80, async () => {
        if (!isHidReady()) return;
        try {
          await withMutex(async () => {
            // 只有当修改的 slot 等于当前 UI 记录的激活档位 uiCurrentDpiSlot 时，
            // 才传递 select: true。否则传递 false。
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














    // 点击整个档位行：写入并切换到该档
    dpiList.addEventListener("click", (e) => {
      const t = e.target;

      if (Date.now() < dpiRowDragBlockClickUntil) return;

      // DPI 数字输入：自绘步进按钮（替代原生上下小三角）
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

      // 右侧菱形按钮：同样执行"写入并切换到该档"
      const selectBtn = t.closest?.("button.dpiSelectBtn");
      if (selectBtn) {
        const row = selectBtn.closest?.(".dpiSlotRow");
        if (!row || row.classList.contains("hidden")) return;

        const slot = Number(row.dataset.slot);
        if (!(slot >= 1 && slot <= dpiSlotCap)) return;

        const inp = $("#dpiInput" + slot);
        const v = Number(inp?.value);
        if (!Number.isFinite(v) || v <= 0) return;

        // ATK 设备逻辑：点击菱形打开调色盘，不切换档位
        if (DEVICE_ID === 'atk' && isHidReady()) {
            const picker = initColorPicker();
            // 获取当前颜色（从按钮背景样式读取，或从缓存读取）
            const currentColor = selectBtn.style.getPropertyValue("--btn-bg") || "#FF0000";
            
            picker.open(selectBtn, currentColor, (newHex) => {
                // 1. 实时更新 UI 预览
                selectBtn.style.setProperty("--btn-bg", newHex);
                
                // 2. 防抖写入设备
                debounceKey(`dpiColor:${slot}`, 150, async () => {
                    try {
                        await withMutex(async () => {
                            // 调用 setDpi，传入 color 参数，select: false (不切换档位)
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
            return; // 拦截结束，不再执行下面的切换逻辑
        }

        // [原有逻辑] 切换 DPI
        setActiveDpiSlot(slot);
        if (!isHidReady()) return;

        withMutex(async () => {
          await hidApi.setDpi(slot, v, { select: true });
        }).catch((err) => logErr(err, "切换 DPI 档失败"));
        return;
      }

      // 如果点击的是 input 或其它按钮，不处理行点击
      if (t.closest("input") || t.closest("button")) return;
      
      const row = e.target.closest?.(".dpiSlotRow");
      if (!row || row.classList.contains("hidden")) return;
      
      const slot = Number(row.dataset.slot);
      if (!(slot >= 1 && slot <= dpiSlotCap)) return;
      
      const inp = $("#dpiInput" + slot);
      const v = Number(inp?.value);
      if (!Number.isFinite(v) || v <= 0) return;

      // 立即给出“已选中”视觉反馈（设备回包后会再次同步校准）
      setActiveDpiSlot(slot);

      // 未连接时，只做本地高亮即可
      if (!isHidReady()) return;
      
      withMutex(async () => {
        await hidApi.setDpi(slot, v, { select: true });
      }).catch((err) => logErr(err, "切换 DPI 档失败"));
    });

    // 初始化：按下拉框档位数量隐藏多余行，并同步当前选中高亮
    const sc = getSlotCountUi();
    setDpiRowsEnabledCount(sc);
    setActiveDpiSlot(uiCurrentDpiSlot, sc);

    // Patch v4: DPI 滑条数值气泡交互（hover / drag 跟随）
    for (let i = 1; i <= dpiSlotCap; i++) updateDpiBubble(i);

    if (!dpiBubbleListenersReady) {
      dpiBubbleListenersReady = true;

      // hover 显示（仅在 thumb 圆圈上悬停时显示）
      const THUMB_HIT_PAD = 6; // 命中区域额外扩展（px）
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

      function handleDpiThumbHover(e) {
        const t = e.target;
        const range = t.closest?.("input.dpiRange");
        if (!range) return;

        const slot = Number((range.id || "").replace(/\D+/g, ""));
        if (!(slot >= 1 && slot <= dpiSlotCap)) return;

        // 正在拖动其它档位时不打扰
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

      // 使用 pointermove 做“命中检测”，避免在滑轨任意位置 hover 都显示
      dpiList.addEventListener("pointermove", handleDpiThumbHover);

      // 进入时也检测一次（不需要用户先移动鼠标）
      dpiList.addEventListener("pointerover", handleDpiThumbHover);

      // 离开该 range 或离开 dpiList 时隐藏（非拖动中）
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
        // 隐藏所有可见气泡（保险）
        for (let i = 1; i <= dpiSlotCap; i++) hideDpiBubble(i);
      });

      // drag 显示（pointer）

      // drag：开始拖动时锁定该 range，防止自动轮询/回包 UI 覆盖导致“偶发拖不动/禁用光标”
      function endDpiDrag() {
        if (!dpiDraggingSlot) return;
        const slot = dpiDraggingSlot;
        dpiDraggingSlot = null;

        // 若是“滑轨上下空白拖动”，拖动结束后短时间内屏蔽 click（避免误触发切换档位）
        if (dpiRowDragState) {
          if (dpiRowDragState.moved) dpiRowDragBlockClickUntil = Date.now() + 350;
          dpiRowDragState = null;
        }

        if (dpiDraggingEl) {
          unlockEl(dpiDraggingEl);
          dpiDraggingEl = null;
        }

        // 稍微延迟，避免松手瞬间抖动
        setTimeout(() => hideDpiBubble(slot), 150);
      }

      // 禁止 DPI 面板内触发浏览器原生 drag&drop（会出现 🚫）
      dpiList.addEventListener("dragstart", (e) => {
        if (e.target && e.target.closest?.(".dpiSlotRow")) e.preventDefault();
      });

      // 自定义拖动：只在“滑轨的 X 范围内”（滑轨上下空白）启用拖动；
      // 滑轨左右空白保持点击切换档位（不影响点击切换档位）
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

        // 1) 直接在 range 上拖动：走原逻辑
        const directRange = t.closest?.("input.dpiRange");
        if (directRange) {
          const slot = Number((directRange.id || "").replace(/\D+/g, ""));
          if (!(slot >= 1 && slot <= dpiSlotCap)) return;

          dpiDraggingSlot = slot;
          dpiDraggingEl = directRange;

          // 拖动期间：暂停轮询 & 锁 UI，避免回包把 range 置灰/重建导致拖动中断
          lockEl(directRange);
          showDpiBubble(slot);
          return;
        }

        // 2) 在档位行空白处：仅当位于滑轨 X 范围内（滑轨上下区域）才启用拖动
        const row = t.closest?.(".dpiSlotRow");
        if (!row || row.classList.contains("hidden") || row.classList.contains("disabled")) return;

        // 输入/按钮/选择控件依旧保持原交互
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
        // 仅当按下点的 X 落在滑轨左右边界内时，才认为是"滑轨上下空白拖动"
        if (!(e.clientX >= rect.left && e.clientX <= rect.right)) return; // 左右空白：仍然靠 click 切换档位

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

        // 避免选中文本/触发原生拖拽状态（🚫）
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

      // 视口变化时重定位（只更新正在显示的气泡）
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

  // ---- Keys: 从设备配置同步按键映射（若固件回包包含映射信息） ----
  let applyKeymapFromCfg = null;
  function buildKeymapEditor() {
    // 视觉化按键映射：点击热点 → 右侧抽屉选择动作
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

    // ====== 窗口尺寸变化时热点与图片对齐处理 ======
    // 现状：kmPoint 使用百分比相对 kmCanvas 定位；当图片 object-fit:contain 产生留白时，
    //       百分比基准会偏离实际图片区域，导致缩放/改变窗口大小后热点漂移。
    // 方案：按“图片在 canvas 内的真实显示区域”计算每个热点的像素坐标，并在 resize/布局变动时重算。
    function __clamp01(v){ return v < 0 ? 0 : (v > 1 ? 1 : v); }

    // 计算 object-fit 后“真实图片内容”在 img 元素内的显示矩形（支持 contain/cover/fill/none/scale-down）
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
      } // fill/其它：保持 r.width/r.height

      const leftoverX = r.width - dispW;
      const leftoverY = r.height - dispH;

      const parts = pos.split(/\s+/).filter(Boolean);
      const xTok = parts[0] || "50%";
      const yTok = parts[1] || "50%";

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

    const scheduleLayoutKmPoints = () => {
      // 连续几帧重算，直到布局稳定（解决窄屏/断点切换时 img 尺寸仍在变化导致的漂移）
      let tries = 0;
      let lastSig = "";
      layoutKmPoints.__token = (layoutKmPoints.__token || 0) + 1;
      const token = layoutKmPoints.__token;

      const step = () => {
        if (token !== layoutKmPoints.__token) return; // 被更新的调度打断
        tries++;

        // 计算当前“布局签名”：只要 canvas 或图片内容区还在变，就继续下一帧
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

      // 起步至少等一帧，让本次 resize / media query / font reflow 落地
      requestAnimationFrame(step);
    };


    // 图片加载完成后再计算（首次进入页面/刷新）
    if (img && !img.complete) {
      img.addEventListener("load", scheduleLayoutKmPoints, { passive: true });
    }

    // 监听窗口尺寸变化
    window.addEventListener("resize", scheduleLayoutKmPoints, { passive: true });

    // 监听页面切换（hash 变化时 keys 可能从 display:none 变为 block）
    window.addEventListener("hashchange", scheduleLayoutKmPoints, { passive: true });

    // 监听 canvas/img 自身尺寸变化（包含抽屉打开/关闭导致的布局变化）
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => scheduleLayoutKmPoints());
      if (canvas) ro.observe(canvas);
      if (img) ro.observe(img);
    }

    // 首次布局
    scheduleLayoutKmPoints();

    const ACTIONS = ProtocolApi.KEYMAP_ACTIONS || {};
    const allLabels = Object.keys(ACTIONS).filter((l) => l && l !== "MODIFIER_ONLY");

    // 分组逻辑：协议层的 type 已经与 UI 对齐（mouse / keyboard / system）
    // 优先使用协议层提供的 listKeyActionsByType()，避免 UI 端再做“硬切”。
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

// 将 (funckey,keycode) 反查为 UI 的 Select 文本：交给协议层（前端不做位运算）
function labelFromFunckeyKeycode(funckey, keycode) {
  try {
    const fn = ProtocolApi.labelFromFunckeyKeycode;
    return typeof fn === "function" ? fn(funckey, keycode) : null;
  } catch {
    return null;
  }
}


    // 仅保留三个分类：鼠标按键 / 键盘按键 / 系统
    const tabDefs = [
      { cat: "mouse", label: "鼠标按键" },
      { cat: "keyboard", label: "键盘按键" },
      { cat: "system", label: "系统" },
    ];

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

    /** @type {Record<number,string>} */
    const mapping = { ...defaultMap };

    let activeBtn = 1;
    let activeCat = tabDefs[0]?.cat || "mouse";

    function setActivePoint(btn) {
      points.forEach((p) => p.classList.toggle("active", Number(p.getAttribute("data-btn")) === btn));
    }

    // 检查按键是否被修改
    function isButtonModified(btn) {
      return mapping[btn] !== defaultMap[btn];
    }

    // 为单个按键恢复默认值
    async function resetSingleButton(btn) {
      if (btn === 1) {
        alert("为防止误操作，主按键（左键）已被锁定，不可修改。");
        return;
      }
      
      mapping[btn] = defaultMap[btn];
      updateBubble(btn);

      // 若连接中，顺便写入设备
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

    function updateBubble(btn) {
      const el = $(`#kmLabel${btn}`);
      if (!el) return;
      el.textContent = mapping[btn] || "-";
      
      // 更新恢复默认按钮的显示状态
      const point = $(`.kmPoint[data-btn="${btn}"]`);
      if (!point) return;
      
      const bubble = point.querySelector(".kmBubble");
      if (!bubble) return;
      
      // 查找或创建恢复默认按钮
      let resetBtn = bubble.querySelector(".kmResetBtn");
      const isModified = isButtonModified(btn);
      
      // 根据是否修改，同步切换 kmModified 类名
      // 这将触发 CSS 中的 opacity: 0.9 让按钮显示，并加深气泡边框
      point.classList.toggle("kmModified", isModified);
      
      if (isModified && !resetBtn) {
        // 创建恢复默认按钮
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
        // 移除恢复默认按钮
        resetBtn.remove();
      }
    }

    function updateAllBubbles() {
      for (let i = 1; i <= 6; i++) updateBubble(i);
    }

     // 从设备回包同步按键映射（如果 cfg.buttonMappings 存在）
     function applyKeymapFromDeviceCfg(cfg) {
       const arr = cfg?.buttonMappings;
       // 只有确保有 6 个按键的数据才进行同步
       if (!arr || !Array.isArray(arr) || arr.length < 6) return;

       for (let i = 1; i <= 6; i++) {
         const it = arr[i - 1];
         if (!it) continue;
         const label = labelFromFunckeyKeycode(it.funckey, it.keycode);
         // 即使 label 相同，我们也更新 mapping 对象以确保数据一致性
         if (label) {
           mapping[i] = label;
         }
       }
       // 强制刷新所有 UI 气泡，不依赖 changed 变量
       updateAllBubbles();
     }

     // 暴露给 applyConfigToUi 使用（保持与其他页面一致：连上设备后自动读取配置）
     applyKeymapFromCfg = applyKeymapFromDeviceCfg;

    
    let __focusTimer = null;
    function deferFocusSearch() {
      if (!search) return;

      // 避免在抽屉过渡开始时立刻 focus 导致某些环境触发 viewport/布局二次计算，
      // 进而在动画过程中重算 transform 目标值（出现“过冲→回弹”错位）。
      // 策略：等待抽屉过渡结束(transitionend)，再 focus；并提供超时兜底。
      if (__focusTimer) {
        clearTimeout(__focusTimer);
        __focusTimer = null;
      }

      const doFocus = () => {
        // 如果抽屉已关闭就不再 focus
        if (!drawer.classList.contains("open")) return;
        try {
          // preventScroll 在部分浏览器可用，可降低额外滚动/重排风险
          search.focus({ preventScroll: true });
        } catch (e) {
          search.focus?.();
        }
        // 只在真正 focus 之后再 select，避免触发布局波动
        try { search.select?.(); } catch (e) {}
      };

      const prefersReduced =
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (prefersReduced) {
        // 无动画环境：延后一帧即可
        requestAnimationFrame(doFocus);
        return;
      }

      let fired = false;
      const onEnd = (e) => {
        if (e.target !== drawer) return;
        // 只关心 transform/opacity 的结束
        if (e.propertyName && e.propertyName !== "transform" && e.propertyName !== "opacity") return;
        if (fired) return;
        fired = true;
        drawer.removeEventListener("transitionend", onEnd);
        // 再延后一帧，让浏览器完成最后一次合成
        requestAnimationFrame(() => requestAnimationFrame(doFocus));
      };

      drawer.addEventListener("transitionend", onEnd, { passive: true });

      // 兜底：如果没有触发 transitionend（例如被中断/不同浏览器实现），按动画时长稍后 focus
      __focusTimer = setTimeout(() => {
        if (fired) return;
        fired = true;
        drawer.removeEventListener("transitionend", onEnd);
        requestAnimationFrame(() => requestAnimationFrame(doFocus));
      }, 260); // 与 CSS 过渡时长(0.22s)对齐并略加缓冲
    }
function openDrawer(btn) {
      activeBtn = btn;
      setActivePoint(btn);

      // 自动切换到当前映射所属分类（鼠标/键盘/系统）
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

    function closeDrawer() {
      if (__focusTimer) { clearTimeout(__focusTimer); __focusTimer = null; }
      drawer.classList.remove("open");
      drawer.setAttribute("aria-hidden", "true");
      backdrop?.classList.remove("show");
      backdrop?.setAttribute("aria-hidden", "true");
      points.forEach((p) => p.classList.remove("active"));
      document.body.classList.remove("km-drawer-open");
    }

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

    async function choose(label) {
      if (activeBtn === 1) {
         alert("为防止误操作，主按键（左键）已被锁定，不可修改。");
         return;
      }

      mapping[activeBtn] = label;
      updateBubble(activeBtn);

      // 写入设备（若已连接）
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

    // 事件：点击热点 / 气泡都打开抽屉
    points.forEach((p) => {
      const btn = Number(p.getAttribute("data-btn"));
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

    // 初始化显示
    updateAllBubbles();

    // 暴露给 applyConfigToUi 使用
    applyKeymapFromCfg = applyKeymapFromDeviceCfg;

    if (hidApi && hidApi._cfg) {
        setTimeout(() => {
            applyKeymapFromDeviceCfg(hidApi._cfg);
        }, 100);
    }
  }



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

  // ---- 实时写入:无需"应用"按钮 ----
  const slotSel = $("#slotCountSelect");
  if (slotSel) {
    slotSel.addEventListener("change", () => {
      const nextCount = Number(slotSel.value);
      
      // 无需判断增减，UI 立即响应显示/隐藏行
      setDpiRowsEnabledCount(nextCount);
      setActiveDpiSlot(uiCurrentDpiSlot, nextCount);

      debounceKey("slotCount", 120, async () => {
        if (!isHidReady()) return;
        try {
          await withMutex(async () => {
            await hidApi.setSlotCount(nextCount);
          });
          // 写入成功后，协议层内部会处理 DPI 专用回读并触发第二次 emitConfig 校验
        } catch (e) {
          logErr(e, "档位数量写入失败");
          // 仅在彻底失败时回滚 UI
        }
      });
    });
  }

  // ====== 设备状态写入队列 ======
  // 策略：回报率/性能模式/开关等共享同一个防抖队列，避免频繁写入
  let __pendingDevicePatch = null;

  /**
   * 将设备配置变更加入写入队列
   * 采用防抖机制，将多个配置变更合并为一次写入操作
   * @param {Object} patch - 要写入的配置补丁对象
   */
  function enqueueDevicePatch(patch) {
    if (!patch || typeof patch !== "object") return;

    // 防止"刷新/初始化阶段"把默认 UI 状态写回设备
    // 必须先收到一包 config（applyConfigToUi 成功）后才允许写入
    if (!__writesEnabled) return;
    if (!__pendingDevicePatch) __pendingDevicePatch = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      __pendingDevicePatch[k] = v;
    }

    // 使用防抖机制，延迟执行写入操作
    debounceKey("deviceState", (window.AppConfig?.timings?.debounceMs?.deviceState ?? 200), async () => {
      if (!isHidReady()) return;
      const payload = __pendingDevicePatch;
      __pendingDevicePatch = null;
      if (!payload || !Object.keys(payload).length) return;

      try {
        await withMutex(async () => {
          // 设备写入策略：抽离为可扩展的 Writer（采用策略/适配器模式）
          const writer = window.DeviceWriter;
          if (writer?.writePatch) {
            await writer.writePatch({
              hidApi,
              ProtocolApi,
              payload,
              deviceId: DEVICE_ID,
              deviceFamily: DEVICE_FAMILY,
              getLastChaosModeByte: () => __lastChaosModeByte,
              setLastChaosModeByte: (v) => { __lastChaosModeByte = v; },
            });
          } else {
            // 降级处理：如果外部未加载 writer，跳过写入以免破坏设备状态
            console.warn("[writer] missing, skip writePatch");
          }
});

        if (payload.polling_rate != null) log(`回报率已写入:${payload.polling_rate}Hz`);
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
      // 只发 polling_rate；协议层会归一到 pollingHz（含别名映射）
      enqueueDevicePatch({ polling_rate: hz });
    });
  }

  const sleepSel = $("#sleepSelect");
  if (sleepSel) {
    sleepSel.addEventListener("change", () => {
      debounceKey("sleep", (window.AppConfig?.timings?.debounceMs?.sleep ?? 120), async () => {
        if (!isHidReady()) return;
        const sec = Number(sleepSel.value);
        try {
          await withMutex(async () => {
            await hidApi.setFeature("sleep_timeout", sec);
          });
          log(`休眠已写入:${sec}s`);
        } catch (e) {
          logErr(e, "休眠写入失败");
        }
      });
    });
  }

  const debounceSel = $("#debounceSelect");
  if (debounceSel) {
    debounceSel.addEventListener("change", () => {
      debounceKey("debounce", (window.AppConfig?.timings?.debounceMs?.debounce ?? 120), async () => {
        if (!isHidReady()) return;
        const ms = Number(debounceSel.value);
        try {
          await withMutex(async () => {
            await hidApi.setFeature("debounce_ms", ms);
          });
          log(`防抖已写入:${ms}ms`);
        } catch (e) {
          logErr(e, "防抖写入失败");
        }
      });
    });
  }

  // ====== 修正 LED 开关监听 ======
  const ledToggle = $("#ledToggle");
  if (ledToggle) {
    ledToggle.addEventListener("change", () => {
      debounceKey("led", (window.AppConfig?.timings?.debounceMs?.led ?? 80), async () => {
        if (!isHidReady()) return;
        const on = !!ledToggle.checked;
        try {
          await withMutex(async () => {
            if (IS_RAPOO) {
              // Rapoo 下发 ledLowBattery
              // 这里使用 setFeature 单发，或者由 setBatchFeatures 自动路由
              // 由于 protocol_api_rapoo.js 中 setFeature 会调用 setBatchFeatures -> planner -> spec
              // 所以这里只要 key 对即可
              await hidApi.setFeature("ledLowBattery", on);
            } else {
              // Chaos 原有逻辑
              await hidApi.setFeature("rgb_switch", on);
            }
          });
          log(`LED 设置已写入:${on ? "开" : "关"}`);
        } catch (e) {
          logErr(e, "LED 写入失败");
        }
      });
    });
  }

  // ---- perfMode/toggles: minimal patch; all go through enqueueDevicePatch ----
  const perfRadios = $$('input[name="perfMode"]');
  perfRadios.forEach((r) => {
    r.addEventListener("change", () => {
      const v = document.querySelector('input[name="perfMode"]:checked')?.value;
      if (!v) return;
      // perf mode 仅在用户切换 perfMode 时才写入 performanceMode
      enqueueDevicePatch({ performanceMode: v });
    });
  });

  const lodEl = $("#bitLOD");
  if (lodEl) {
    lodEl.addEventListener("change", () => {
      if (IS_RAPOO) {
        // Rapoo: bitLOD 重映射为“玻璃模式”
        enqueueDevicePatch({ glassMode: !!lodEl.checked });
      } else {
        // Chaos: 保持原逻辑（LOD 静默高度）
        enqueueDevicePatch({ lodHeight: lodEl.checked ? "low" : "high" });
      }
    });
  }


  const bit1 = $("#bit1");
  if (bit1) bit1.addEventListener("change", () => enqueueDevicePatch({ motionSync: !!bit1.checked }));

  const bit2 = $("#bit2");
  if (bit2) bit2.addEventListener("change", () => enqueueDevicePatch({ linearCorrection: !!bit2.checked }));

  const bit3 = $("#bit3");
  if (bit3) bit3.addEventListener("change", () => enqueueDevicePatch({ rippleControl: !!bit3.checked }));

  const bit6 = $("#bit6");
  if (bit6) {
    bit6.addEventListener("change", () => {
      if (IS_RAPOO) return;
      // Chaos: 保持原逻辑（此开关在旧协议中对应 glassMode/辅助功能）
      enqueueDevicePatch({ glassMode: !!bit6.checked });
    });
  }

  const rapooPollingSelectAdv = $("#rapooPollingSelectAdv");
  if (rapooPollingSelectAdv) {
    rapooPollingSelectAdv.addEventListener("change", () => {
      if (!IS_RAPOO) return;
      const hz = Number(rapooPollingSelectAdv.value);
      if (!Number.isFinite(hz)) return;
      // 发送 keyScanningRate 而不是 polling_rate
      enqueueDevicePatch({ keyScanningRate: hz });
    });
  }

  // ====== Rapoo: 基础性能页底部开关 ======
  // 无线策略 wirelessStrategy: smart <-> full
  const wirelessStrategyToggle = $("#wirelessStrategyToggle");
  if (wirelessStrategyToggle) {
    wirelessStrategyToggle.addEventListener("change", () => {
      if (!IS_RAPOO) return;
      const v = wirelessStrategyToggle.checked ? "full" : "smart";
      enqueueDevicePatch({ wirelessStrategy: v });
      try { syncRapooBasicExtraSwitchState(); } catch (_) {}
    });
  }

  // 通信协议 commProtocol: efficient <-> initial
  const commProtocolToggle = $("#commProtocolToggle");
  if (commProtocolToggle) {
    commProtocolToggle.addEventListener("change", () => {
      if (!IS_RAPOO) return;
      const v = commProtocolToggle.checked ? "initial" : "efficient";
      enqueueDevicePatch({ commProtocol: v });
      try { syncRapooBasicExtraSwitchState(); } catch (_) {}
    });
  }

  // ====== ATK Long Range Mode Logic ======
  const longRangeToggle = $("#longRangeModeToggle");
  if (longRangeToggle) {
    longRangeToggle.addEventListener("change", () => {
      // 调用原有写入队列，key 必须与 protocol_api_atk.js 中的 SPEC 一致
      enqueueDevicePatch({ longRangeMode: !!longRangeToggle.checked });
    });
  }

  const angleInput = $("#angleInput");
  if (angleInput) {
    // 拖动时只更新读数（syncAdvancedPanelUi 已在别处监听 input）
    // 松手后才真正下发设置，避免拖动过程中频繁写入。
    const commitAngle = () => {
      const v = Number(angleInput.value);
      if (!Number.isFinite(v)) return;
      enqueueDevicePatch({ sensorAngle: v });
    };
    angleInput.addEventListener("change", commitAngle);
    // 兼容部分设备：pointerup/touchend 也触发一次提交（不会影响 change 正常触发）
    angleInput.addEventListener("pointerup", commitAngle);
    angleInput.addEventListener("touchend", commitAngle);
  }


  const feelInput = $("#feelInput");
  if (feelInput) {
    // 拖动时只更新读数（syncAdvancedPanelUi 已在别处监听 input）
    // 松手后才真正下发设置，避免拖动过程中频繁写入。
    const commitFeel = () => {
      const v = Number(feelInput.value);
      if (!Number.isFinite(v)) return;
      if (IS_RAPOO) {
        // 统一发送挡位字段
        enqueueDevicePatch({ opticalEngineLevel: v });
      } else {
        // Chaos: 保持原逻辑（传感器手感）
        enqueueDevicePatch({ sensorFeel: v });
      }
    };
    feelInput.addEventListener("change", commitFeel);
    feelInput.addEventListener("pointerup", commitFeel);
    feelInput.addEventListener("touchend", commitFeel);
  }


  // ---- Config -> UI ----

  // Rapoo: 基础性能页底部开关状态文案同步（仅展示，不影响写入）
  function syncRapooBasicExtraSwitchState() {
    const wsToggle = $("#wirelessStrategyToggle");
    const wsState = $("#wirelessStrategyState");
    if (wsToggle && wsState) wsState.textContent = wsToggle.checked ? "满格射频" : "智能调节";

    const cpToggle = $("#commProtocolToggle");
    const cpState = $("#commProtocolState");
    if (cpToggle && cpState) cpState.textContent = cpToggle.checked ? "初始" : "高效";
  }

  function setRadio(name, value) {
    const ae = document.activeElement;
    if (ae && ae.name === name) return;
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el && !(el.id && uiLocks.has(el.id))) el.checked = true;
  }

  /**
   * 将设备配置应用到 UI
   * 这是配置同步的核心函数，负责将所有设备配置值反映到界面元素上
   * @param {Object} cfg - 设备配置对象
   */
  function applyConfigToUi(cfg) {
    // capabilities 优先来自后端回包，用于动态渲染 UI（如 DPI 上限、回报率选项等）
    try { applyCapabilitiesToUi(cfg?.capabilities); } catch (_) {}
    const dpiSlotCap = getDpiSlotCap();
    const slots = cfg.dpiSlots || [];
    
    // 同步 DPI 档位颜色（ATK 设备支持）
    const colors = cfg.dpiColors || []; // 示例：["#FF0000", "#00FF00", ...]

    for (let i = 1; i <= dpiSlotCap; i++) {
      const v = slots[i - 1];
      const input = $(`#dpiInput${i}`);
      const range = $(`#dpiRange${i}`);
      if (input && typeof v === "number") safeSetValue(input, v);
      if (range && typeof v === "number") safeSetValue(range, v);

      // 渲染按钮颜色
      const btn = dpiList?.querySelector(`.dpiSlotRow[data-slot="${i}"] .dpiSelectBtn`);
      if (btn && colors[i-1]) {
          // 使用 CSS 变量传递颜色，配合 style.css 中的 background: var(--btn-bg)
          btn.style.setProperty("--btn-bg", colors[i-1]);
      }
    }

    const slotCount = clampSlotCountToCap(cfg.currentSlotCount ?? dpiSlotCap, dpiSlotCap);
    safeSetValue($("#slotCountSelect"), slotCount);
    setDpiRowsEnabledCount(slotCount);

    const curIdx1 = (Number(cfg.currentDpiIndex ?? 0) || 0) + 1;
    setActiveDpiSlot(curIdx1, slotCount);

    // 同步按键扫描率到高级面板下拉框
    if (IS_RAPOO && cfg.keyScanningRate) {
       // 假设 UI 中 rapooPollingSelectAdv 的 value 就是 1000/2000/4000/8000
       safeSetValue($("#rapooPollingSelectAdv"), cfg.keyScanningRate);
       // 同步到循环按钮 UI（静默更新，不触发动画）
       if (typeof updatePollingCycleUI === 'function') {
         updatePollingCycleUI(cfg.keyScanningRate, false);
       }
    }

    const pollingHz = cfg.pollingHz ?? cfg.pollingRateHz ?? cfg.reportRateHz ?? cfg.reportHz ?? cfg.polling;
    if (pollingHz) {
      // Rapoo 设备支持完整的回报率选项：125, 250, 500, 1000, 2000, 4000, 8000
      const rapooRates = [125, 250, 500, 1000, 2000, 4000, 8000];
      const picked = IS_RAPOO ? rapooRates.reduce((best, x) => (Math.abs(x - pollingHz) < Math.abs(best - pollingHz) ? x : best), rapooRates[0]) : pollingHz;
      safeSetValue($("#pollingSelect"), picked);
    }


    // 优先使用 cfg.sleepSeconds (ATK/Rapoo 标准)，若无则回退到旧版 sleep16 (Chaos)
    if (cfg.sleepSeconds != null) {
      safeSetValue($("#sleepSelect"), cfg.sleepSeconds);
    } else {
      const sleep16 = Number(cfg.sleep16 ?? 0);
      const map = ProtocolApi.MOUSE_HID.sleepCodeToSeconds || {};
      const secondsList = Object.values(map);
      if (secondsList.includes(sleep16)) {
        safeSetValue($("#sleepSelect"), sleep16);
      } else if (map[String(sleep16)]) {
        $("#sleepSelect").value = String(map[String(sleep16)]);
      }
    }

    if (cfg.debounceMs != null) safeSetValue($("#debounceSelect"), cfg.debounceMs);


// 设备状态：使用语义化字段（由协议层解析），前端不做任何位运算
const st = cfg?.deviceState || cfg?.state || cfg || {};
const pm = st.performanceMode || cfg.performanceMode || "low";
setRadio("perfMode", pm);

	const lod = st.lodHeight || st.lod || cfg.lodHeight || "high";
	const lodLow = String(lod).toLowerCase() === "low";
	const elLod = $("#bitLOD");
	if (elLod && !(elLod.id && uiLocks.has(elLod.id))) {
	  if (IS_RAPOO) {
	    // 玻璃模式同步
	    const gm = cfg.glassMode; // 协议层已读取 0xC5
	    elLod.checked = !!gm;
	  } else {
	    elLod.checked = lodLow;
	  }
	}


const setCb = (id, v) => {
  const el = $(id);
  if (!el) return;
  if (el.id && uiLocks.has(el.id)) return;
  el.checked = !!v;
};

// LED 状态回显
// setCb 是之前定义的辅助函数：setCb("#bit1", ...)
// cfg.ledRaw 是 Chaos 的旧字段，cfg.rgb_switch 也可以
if (IS_RAPOO) {
  setCb("#ledToggle", cfg.ledLowBattery);
} else {
  setCb("#ledToggle", !!cfg.ledRaw); 
}

	setCb("#bit1", st.motionSync ?? st.motion_sync ?? cfg.motionSync);
	setCb("#bit2", st.linearCorrection ?? st.linear_correction ?? cfg.linearCorrection);
	setCb("#bit3", st.rippleControl ?? st.ripple_control ?? cfg.rippleControl);
	if (!IS_RAPOO) setCb("#bit6", st.glassMode ?? st.glass_mode ?? cfg.glassMode);

// Rapoo: 基础性能页底部开关回显
if (IS_RAPOO) {
  const ws = (st.wirelessStrategy ?? cfg.wirelessStrategy ?? cfg.wireless_strategy);
  if (ws != null) setCb("#wirelessStrategyToggle", String(ws).toLowerCase() === "full");

  const cp = (st.commProtocol ?? cfg.commProtocol ?? cfg.comm_protocol);
  if (cp != null) setCb("#commProtocolToggle", String(cp).toLowerCase() === "initial");

  try { syncRapooBasicExtraSwitchState(); } catch (_) {}
}

// ATK 配置回显
if (DEVICE_ID === 'atk') {
    // 超远距离模式回显
    if (cfg.longRangeMode !== undefined) {
        setCb("#longRangeModeToggle", cfg.longRangeMode);
    }
}

// 仅用于展示（可选）：若后端仍提供 raw modeByte，可直接显示；否则展示为 "-"
const mbRaw = st.modeByte ?? st.modeByteRaw ?? cfg.modeByte ?? cfg.modeByteRaw;
const mbNum = Number.isFinite(Number(mbRaw)) ? Math.max(0, Math.min(255, Math.trunc(Number(mbRaw)))) : null;
const mbText = mbNum == null ? "-" : `0x${mbNum.toString(16).padStart(2, "0").toUpperCase()}`;
const mbEl = $("#modeByteText");
if (mbEl) mbEl.textContent = mbText;

	    if (cfg.sensorAngle != null) safeSetValue($("#angleInput"), cfg.sensorAngle);

	    // 光学引擎挡位同步
	    if (IS_RAPOO) {
	      // 优先从 opticalEngineLevel 读取，如果没有则读取寄存器原始值
	      const level = cfg.opticalEngineLevel ?? cfg.lodHeightRaw;
	      if (level != null) {
	        safeSetValue($("#feelInput"), level);
	      } else {
	        // 兜底：如果没有 opticalEngineLevel，尝试从 opticalEngineHeightMm 推断
	        const mm = cfg.opticalEngineHeightMm;
	        if (mm != null) {
	          // 反算公式: level = (mm * 10) - 6
	          const levelFallback = Math.round(mm * 10) - 6;
	          safeSetValue($("#feelInput"), Math.max(1, Math.min(11, levelFallback)));
	        } else {
	          // 最后兜底：从 lodHeight 推断
	          const lh = String(cfg.lodHeight || "mid").toLowerCase();
	          const mmFallback = lh === "low" ? 0.7 : (lh === "high" ? 1.7 : 1.2);
	          const levelFallback = Math.round(mmFallback * 10) - 6;
	          safeSetValue($("#feelInput"), Math.max(1, Math.min(11, levelFallback)));
	        }
	      }
	    } else {
	      if (cfg.sensorFeel != null) safeSetValue($("#feelInput"), cfg.sensorFeel);
	    }


    // 同步高级参数页自定义 UI（分段快门/数码读数）
    // safeSetValue 不会触发事件，这里手动刷新一次可视层。
    syncAdvancedPanelUi();

    const mouseV = cfg.mouseFw ?? (cfg.mouseFwRaw != null ? ProtocolApi.uint8ToVersion(cfg.mouseFwRaw) : "-");
    const rxV = cfg.receiverFw ?? (cfg.receiverFwRaw != null ? ProtocolApi.uint8ToVersion(cfg.receiverFwRaw) : "-");
    const fwText = `Mouse:${mouseV} · RX:${rxV}`;

    // 保存固件文本，供顶部设备卡片/电量回包刷新显示
    currentFirmwareText = fwText;
    if (isHidReady()) {
      updateDeviceStatus(true, currentDeviceName || "已连接", currentBatteryText || "", currentFirmwareText);
    }
    syncBasicMonolithUI();

    // Keys 页面：若固件回包包含按键映射，则同步左侧显示
    try { applyKeymapFromCfg?.(cfg); } catch (_) {}

    // ATK 灯效配置回显
    if (DEVICE_ID === 'atk') {
        if (cfg.dpiLightEffect != null) {
            updateAtkCycleUI('atkDpiLightCycle', cfg.dpiLightEffect, ATK_DPI_LIGHT_OPTS, false);
        }
        if (cfg.receiverLightEffect != null) {
            updateAtkCycleUI('atkReceiverLightCycle', cfg.receiverLightEffect, ATK_RX_LIGHT_OPTS, false);
        }
    }

    
  }
  // ====== HID events ======
  hidApi.onBattery((bat) => {
    const p = Number(bat?.batteryPercent);
    // -1 或 NaN 表示"未知电量"：先显示占位符，等设备首次状态包上报后再刷新
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

    // 更新顶部设备卡片的电量信息
    currentBatteryText = batteryText;
    updateDeviceStatus(true, currentDeviceName || "已连接", batteryText, currentFirmwareText || "");

    log(`收到电量包:${p}%`);
  });

  hidApi.onRawReport((raw) => {
    // 调试用
  });

  /**
   * 等待一次配置回包（用于连接握手）
   * 关键：使用 replay:false，确保只等待"下一次"设备回包，不被旧缓存配置直接满足
   * @param {number} timeoutMs - 超时时间（毫秒），默认 1600ms
   * @returns {Promise<Object>} 配置对象
   */
  function waitForNextConfig(timeoutMs = 1600) {
    return new Promise((resolve, reject) => {
      let done = false;
      // 关键：replay:false，确保只等待"下一次"设备回包，不被旧缓存 cfg 直接满足
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
   * 等待一次电量回包（用于连接握手）
   * 注意：仅保留电量读取，不再读取配置
   * @param {number} timeoutMs - 超时时间（毫秒），默认 1600ms
   * @returns {Promise<Object>} 电量对象
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


  // ====== 连接互斥控制 ======
  // 避免设备模式切换/多次 autoConnect 并发 open/close 导致 InvalidStateError
  // - __connectInFlight: 当前是否正在执行一次 connectHid 操作
  // - __connectPending: 若连接中又来了新请求，记住最后一次请求，待本次结束后立即再执行（latest-wins 策略）
  let __connectInFlight = false;
  let __connectPending = null;

  // ====== 主连接流程 ======
  /**
   * 连接 HID 设备的主函数
   * @param {boolean|object} mode - 连接模式：
   *   - true: 强制弹窗让用户选择设备
   *   - false: 自动查找已授权设备
   *   - object: 直接传入设备对象（用于自动重连）
   * @param {boolean} isSilent - 是否静默模式：
   *   - true: 静默模式，失败不弹窗 alert
   *   - false: 常规模式，失败时弹窗提示
   * @returns {Promise<void>}
   */
  async function connectHid(mode = false, isSilent = false) {
    // 防并发处理：如果连接中又来了新的连接请求，记住最后一次请求，等本次完成后再自动执行
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

      // 连接兜底：当设备模式切换(2.4G/有线/蓝牙)时，页面里缓存的 __autoDetectedDevice
      // 很可能还是“旧接口/旧PID”，会导致 sendReport 写入失败或一直等不到回包。
      // 这里准备一个候选列表：优先尝试当前 dev，失败后自动尝试其他已授权设备。
      const collectCandidates = async (primary, preferType, { pinPrimary = false } = {}) => {
        const uniq = [];
        const push = (d) => {
          if (!d) return;
          if (uniq.includes(d)) return;
          uniq.push(d);
        };

        push(primary);
        try {
          const devs = await navigator.hid.getDevices();
          for (const d of (devs || [])) push(d);
        } catch (_) {}

        // 过滤成同一类型（如果能识别）
        const t = preferType || null;
        let list = uniq;
        if (t) {
          list = uniq.filter((d) => {
            try { return DeviceRuntime.identifyDeviceType(d) === t; } catch (_) { return false; }
          });
          // 如果过滤后为空，退回原列表（避免误判导致无候选）
          if (!list.length) list = uniq;
        }

        // 打分：优先 Vendor Collection + Rapoo rid=6 output report（协议解锁用到）
        const hasUsagePage = (d, page) => {
          const cols = d?.collections || [];
          return Array.isArray(cols) && cols.some((c) => Number(c?.usagePage) === Number(page));
        };
        const hasAnyVendorPage = (d) => {
          const cols = d?.collections || [];
          return Array.isArray(cols) && cols.some((c) => {
            const p = Number(c?.usagePage);
            return Number.isFinite(p) && p >= 0xFF00 && p <= 0xFFFF;
          });
        };
        const hasOutRid = (d, rid) => {
          const cols = d?.collections || [];
          return Array.isArray(cols) && cols.some((c) => Array.isArray(c?.outputReports) && c.outputReports.some((r) => Number(r?.reportId) === Number(rid)));
        };

        const score = (d) => {
          let s = 0;
          if (!d) return s;

          // 通用 Vendor 优先
          if (hasUsagePage(d, 65290)) s += 900;  // 0xFF0A
          if (hasUsagePage(d, 0xFF00)) s += 600; // 0xFF00
          if (hasAnyVendorPage(d)) s += 300;

          // Rapoo：rid=6 output report 权重最高（_unlockDevice 用到）
          if (hasOutRid(d, 6)) s += 1200;

          if (t === "chaos") {
            if (hasUsagePage(d, 65290)) s += 200;
            if (hasUsagePage(d, 65280)) s += 80;
          } else if (t === "rapoo") {
            if (hasUsagePage(d, 0xFF00)) s += 200;
          }

          // 保底：优先非标准鼠标接口（usagePage!=0x0001）
          if (Array.isArray(d?.collections) && d.collections.some((c) => Number(c?.usagePage) !== 0x0001)) s += 30;
          return s;
        };

        // 根据分数排序。若 pinPrimary=true（用户刚手动选了设备），则保留 primary 在首位。
        const sorted = [...list].sort((a, b) => score(b) - score(a));
        if (pinPrimary && primary) {
          return [primary, ...sorted.filter((d) => d !== primary)];
        }
        return sorted;
      };

      // 1. 确定设备对象
      if (typeof mode === 'object' && mode.vendorId) {
          // A. 直接传入了设备对象 (自动重连用)
          dev = mode;
      } else if (mode === true) {
          // B. 强制弹窗 (用户点击了按钮)
          try {
            __armManualConnectGuard(3000);
            dev = await DeviceRuntime.requestDevice();
            // 兼容：某些实现里 connect 事件可能在 promise resolve 后才触发，刷新一次锁窗口
            __armManualConnectGuard(3000);
          } catch (e) {
            // 用户在 WebHID 选择器点了取消/未选择设备：反向动画回到初始态
            try { __reverseLandingToInitial(__landingClickOrigin); } catch (_) {}
            return;
          }
          // 有些实现（或特定浏览器版本）在用户取消时不会 throw，而是返回 null/undefined
          if (!dev) {
            try { __reverseLandingToInitial(__landingClickOrigin); } catch (_) {}
            return;
          }
      } else {
          // C. 兜底逻辑
          dev = __autoDetectedDevice;
          // 如果没有预选设备，尝试从 getDevices() 里拿已授权设备（不需要用户手势）
          // 仍拿不到才退出（浏览器会拦截非手势的 requestDevice）。
          if (!dev) {
            try {
              const devs = await navigator.hid.getDevices();
              dev = devs?.[0] || null;
              if (dev) __autoDetectedDevice = dev;
            } catch (_) {}
          }
          if (!dev) return;
      }
      
      if (!dev) return;

      // ============================================================
      // 2. 自动识别类型并切换后端
      // ============================================================
      const detectedType = DeviceRuntime.identifyDeviceType(dev);
      const currentType = DeviceRuntime.getSelectedDevice();

      if (detectedType && detectedType !== currentType) {
        console.log(`[AutoSwitch] 识别到 ${detectedType} (当前 ${currentType})，正在切换...`);
        // 切换后端并刷新，刷新后 initAutoConnect 会再次触发此流程
        DeviceRuntime.setSelectedDevice(detectedType, { reload: true });
        return; 
      }
      // ============================================================

      // 3. 准备候选列表（模式切换时可自动从"旧接口"切换到"新接口"）
      const preferType = detectedType || currentType || null;
      const pinPrimary = (mode === true);
      let candidates = [];

      if (preferType === 'rapoo') {
        // 【硬编码】雷柏直接获取所有已授权设备，只保留 0xFF00 厂商接口
        const all = await navigator.hid.getDevices();
        candidates = all.filter(d => 
          d.vendorId === 0x24ae && 
          d.collections.some(c => c.usagePage === 0xff00 && (c.usage === 14 || c.usage === 15))
        );
        // 排序：优先选 Usage 14 (OUT 接口) 用于初始化握手
        candidates.sort((a, b) => {
          const ua = a.collections.find(c => c.usagePage === 0xff00)?.usage || 0;
          const ub = b.collections.find(c => c.usagePage === 0xff00)?.usage || 0;
          return (ua === 14) ? -1 : (ub === 14 ? 1 : 0);
        });
        // 如果 primary 存在且不在列表中，添加到首位
        if (pinPrimary && dev && !candidates.includes(dev)) {
          candidates.unshift(dev);
        }
      } else {
        // ATK/Chaos 保留原有评分逻辑
        candidates = await collectCandidates(dev, preferType, { pinPrimary });
      }
      
      hidConnecting = true;
      hidLinked = false;
      if (!isSilent) __setLandingCaption("INITIATE SYNCHRONIZATION...");

      // 4. 握手流程
      const performHandshake = async (targetDev) => {
        if (!targetDev) throw new Error("No HID device selected.");
        // 强制复位僵死句柄
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

        // 获取配置并显式写入 UI
        const cfgP = waitForNextConfig(2500); 
        const reqFn = hidApi.requestConfig || hidApi.getConfig;
        if (reqFn) await reqFn.call(hidApi);
        
        // 捕获握手阶段收到的配置包
        const cfg = await cfgP; 
        
        // 显式调用 UI 同步（避免重连后全局 Listener 可能失效导致 UI 不刷新的问题）
        applyConfigToUi(cfg);
        
        // 恢复写入权限
        __writesEnabled = true;

        // 同步 Chaos 设备的 ModeByte，确保后续写入正确
        if (!IS_RAPOO) {
           const mb = cfg?.modeByte ?? cfg?.mode_byte ?? cfg?.deviceState?.modeByte ?? cfg?.deviceState?.mode_byte;
           const n = Number(mb);
           if (Number.isFinite(n)) __lastChaosModeByte = n & 0xff;
        }
        
        if (typeof applyKeymapFromCfg === 'function') {
          applyKeymapFromCfg(hidApi._cfg);
        }
        return displayName;
      };

      // 重试逻辑：
      // - 先尝试候选[0]（通常是 __autoDetectedDevice 或用户刚选的设备）
      // - 若失败（写入失败/无回包），依次尝试其他已授权设备（常见于 2.4G->有线 切换）
      let lastErr = null;
      let displayName = "";
      let chosenDev = null;

      for (const cand of candidates) {
        for (let i = 0; i < 2; i++) {
          try {
            if (i > 0) {
              try {
                // Chaos: close({clearListeners:false})；Rapoo: close()
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

        // 候选失败：确保释放句柄后再尝试下一个
        try {
          await hidApi.close?.({ clearListeners: false });
        } catch (_) {
          try { await hidApi.close?.(); } catch (_) {}
        }
        await new Promise(r => setTimeout(r, 120));
      }

      if (!displayName) throw lastErr;

      // 5. 连接成功处理
      hidLinked = true;
      hidConnecting = false;
      currentDeviceName = displayName;
      
      // 连接完成后立即拉取一次电量（Rapoo 会通过状态包更新）
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
      // 记录实际成功的设备（模式切换时可能与最初 dev 不同）
      if (chosenDev) dev = chosenDev;
      // 记录本次真正握手成功的 HID 设备，避免下次仍优先选到“旧接口/旧模式”
      const finalDev = chosenDev || dev;
      __autoDetectedDevice = finalDev;
      saveLastHidDevice(finalDev);
      startBatteryAutoRead();
      
      try { 
        if (document.body.classList.contains("landing-active")) {
          // 使用之前记录的点击位置，如果没有则默认中心
          // 进入主页前：在 SYSTEM READY 阶段等待“配置读取+UI刷新”完成；ATK 额外等待 120ms
          window.__LANDING_ENTER_GATE_PROMISE__ = (async () => {
            try {
              await __firstConfigAppliedPromise;
              await __waitForUiRefresh();
              if (IS_ATK) await new Promise((r) => setTimeout(r, 120));
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
      
      // 只有非静默模式（用户主动点击）才弹窗报错
      // 自动连接失败通常是因为设备被独占或未开机，静默失败即可，保留在起始页
      if (!isSilent && err && err.message && !err.message.includes("cancel")) {
         alert(`连接失败：${err.message}\n请尝试重新插拔设备或重启页面。`);
      }
    }
  } finally {
    __connectInFlight = false;
    const pend = __connectPending;
    __connectPending = null;
    // 若连接过程中又插拔/切换了模式，自动执行最后一次请求（避免必须刷新页面）
    if (pend && !hidConnecting && !isHidOpened()) {
      setTimeout(() => connectHid(pend.mode, pend.isSilent), 0);
    }
  }



  }

  /**
   * 断开 HID 设备连接
   * 清理所有连接状态，停止自动读取，并返回起始页
   */
  async function disconnectHid() {
    if (!hidApi || !hidApi.device) return;
    try {
      // 断开时取消任何排队的自动连接请求
      __connectPending = null;
      hidConnecting = false;
      hidLinked = false;

      await hidApi.close();
      hidApi.device = null;           // 清空 API 内部设备引用
      __autoDetectedDevice = null;    // 清空自动检测到的设备缓存

      // 更新 UI 状态
      updateDeviceStatus(false);
      stopBatteryAutoRead();
      resetHeaderChipValues();
      setHeaderChipsVisible(false);

      log("HID 已断开");
      // 断开/未连接：返回到起始页
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

  

  // Initial state
  updateDeviceStatus(false);
  // 未连接时默认显示起始页（成功握手后会自动转场进入主应用）
  try { showLanding("init"); } catch (_) {}
  // ====== 页面加载初始化 ======
  // 策略：只要有已授权的设备，就自动连接！
  /**
   * 初始化自动连接
   * 检测已授权的设备并自动建立连接
   */
  const initAutoConnect = async () => {
      const detectedDev = await autoConnectHidOnce();
      if (detectedDev) {
        connectHid(detectedDev, true);
      }
  };

  // ====== 启动页动画保护机制 ======
  // 启动页动画期间，部分异步任务（枚举 HID / 读电量等）可能抢占主线程导致"偶发丢帧"
  // 策略：在任务执行时短暂停帧（不影响交互），执行完再恢复
  /**
   * 安全执行重量级任务
   * 在执行任务期间暂停启动页动画，避免丢帧
   * @param {Function} task - 要执行的异步任务
   * @returns {Promise} 任务执行结果的 Promise
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
    // 监听 HID 断开
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
      // 监听 HID 插入：支持热插拔自动连
      navigator.hid.addEventListener("connect", (e) => {
         // 手动连接保护锁：在用户主动连接的短窗口内忽略 connect（权限授予也会触发 connect）
         if (__isManualConnectGuardOn()) return;
         // 稍微延迟，等待设备就绪
         setTimeout(() => {
             if (!isHidOpened()) __runHeavyTaskSafely(initAutoConnect);
         }, 500);
      });
    }
    requestIdleCallback(() => __runHeavyTaskSafely(initAutoConnect), { timeout: 1600 });
  } else {
    setTimeout(() => __runHeavyTaskSafely(initAutoConnect), 300);
  }

  // 进入/刷新页面后尝试读取一次电量（已连接时才会生效）
  // Rapoo 设备不执行此操作
  if (!IS_RAPOO) {
    setTimeout(() => __runHeavyTaskSafely(() => requestBatterySafe("页面进入")), 1400);
  }

  log("页面已加载。点击页面顶部设备卡片开始连接设备。");

  // ====== 侧边栏管理（稳健版） ======
  // 策略：防抖全域展开 / 延迟收缩，优化性能和用户体验
  const sidebar = document.querySelector('.sidebar');
  let sidebarTimer = null;
  let __navRafId = 0;

  // JS 帧对齐优化：把 class 切换放到每一帧的起点，并合并同帧的多次调用
  /**
   * 设置侧边栏折叠状态
   * @param {boolean} collapsed - 是否折叠
   */
  const setNavCollapsed = (collapsed) => {
    if (__navRafId) cancelAnimationFrame(__navRafId);
    __navRafId = requestAnimationFrame(() => {
      __navRafId = 0;
      document.body.classList.toggle('nav-collapsed', !!collapsed);
    });
  };
  /**
   * 切换侧边栏折叠状态
   */
  const toggleNavCollapsed = () => {
    if (__navRafId) cancelAnimationFrame(__navRafId);
    __navRafId = requestAnimationFrame(() => {
      __navRafId = 0;
      document.body.classList.toggle('nav-collapsed');
    });
  };

  if (sidebar) {
    // 【核心优化】监听 CSS 过渡结束事件
    // 只有当宽度变化动画彻底完成后，才触发一次 resize 刷新 DPI 连线等坐标
    sidebar.addEventListener('transitionend', (e) => {
      if (e.propertyName === 'width') {
        window.dispatchEvent(new Event('resize'));
      }
    });

    // 针对原有切换按钮的兼容
    const sidebarToggle = document.getElementById('sidebarToggle');
    if (sidebarToggle) {
      sidebarToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleNavCollapsed();
        // 点击切换时由于是主动操作，可以不等待直接 resize 或等待 transitionend
      });
    }
  }

})();

