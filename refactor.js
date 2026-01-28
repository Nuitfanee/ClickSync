

/* ===== refactor.js (merged) ===== */

/**
 * 全局配置中心（Centralization）
 * - 统一管理：防抖、休眠阈值、UI 离散档位、默认轮询率等
 * - 仅存放“数据/常量/纯函数”，不包含任何业务逻辑与 DOM 操作
 */
(function () {
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  /**
   * 生成下拉框选项列表
   * @param {number[]} values - 选项值数组
   * @param {(v:number)=>string} label - 标签生成函数
   * @returns {string} HTML 字符串
   */
  function buildSelectOptions(values, label) {
    return values.map((v) => `<option value="${v}">${label(v)}</option>`).join("");
  }

  const AppConfig = {
    timings: {
      // UI 到设备写入的防抖延迟（毫秒）
      debounceMs: {
        slotCount: 120,
        deviceState: 200,
        sleep: 120,
        debounce: 120,
        led: 80,
      },
    },

    // 设备能力范围（纯数据）
    ranges: {
      chaos: {
        power: {
          // Chaos 设备休眠时间选项（7 档，与 index.html 默认选项一致）
          sleepSeconds: [10, 30, 50, 60, 120, 900, 1800],
          debounceMs: [1, 2, 4, 8, 15],
        },
        sensor: {
          // Chaos 传感器配置（不强制覆盖，保持旧设备兼容性）
          angleDeg: { min: -20, max: 20, step: 1, hint: "" },
          feel: null,
        },
      },

      rapoo: {
        power: {
          // Rapoo 设备休眠时间选项：2 分钟到 120 分钟（秒）
          sleepSeconds: Array.from({ length: 119 }, (_, i) => (i + 2) * 60),
          // Rapoo 设备防抖选项：0ms 到 32ms
          debounceMs: Array.from({ length: 33 }, (_, i) => i),
        },
        sensor: {
          angleDeg: { min: -30, max: 30, step: 1, hint: "范围 -30° ~ 30°" },
          feel: { min: 1, max: 11, step: 1, unit: "挡", name: "引擎高度", sub: "范围 1 - 11 挡" },
        },
        polling: {
          basicHz: [125, 250, 500, 1000, 2000, 4000, 8000],
          // 高级面板轮询循环按钮的候选值（若设备或固件有限制，可在适配器中覆盖）
          advHz: [1000, 2000, 4000, 8000],
        },
        texts: {
          landingTitle: "RAPOO",
          landingCaption: "stare into the void to connect (Rapoo)",
          lod: { code: "005 // Glass Mode", title: "玻璃模式", desc: "适配玻璃表面" },
          led: { code: "006 // Low Batt Warn", title: "LED低电量提示", desc: "当低电量时，有led指示灯提示" },

          // 性能模式描述
          perfMode: {
            low:   { color: "#00A86B", text: "均衡模式， 游戏娱乐，开心无虑" },
            hp:    { color: "#000000", text: "火力模式， 电竞游戏，轻松拿捏" },
            sport: { color: "#FF4500", text: "竞技超核模式，传感器帧率大于13000 FPS" },
            oc:    { color: "#4F46E5", text: "狂暴竞技模式，传感器帧率大于20000 FPS " },
          },
        },
      },

      atk: {
        power: {
          // ATK 设备休眠时间选项：30s, 1m, 2m, 3m, 5m, 20m, 25m, 30m
          sleepSeconds: [30, 60, 120, 180, 300, 1200, 1500, 1800],
          // ATK 设备防抖选项：0, 1, 2, 4, 8, 15, 20
          debounceMs: [0, 1, 2, 4, 8, 15, 20],
        },
        sensor: {
          // ATK 传感器配置（复用 Rapoo 的传感器范围）
          angleDeg: { min: -30, max: 30, step: 1, hint: "范围 -30° ~ 30°" },
          feel: { min: 1, max: 11, step: 1, unit: "挡", name: "引擎高度", sub: "范围 1 - 11 挡" },
        },
        polling: {
          // ATK 设备回报率选项：125 - 8000
          basicHz: [125, 250, 500, 1000, 2000, 4000, 8000],
          advHz: [1000, 2000, 4000, 8000],
        },
        texts: {
          landingTitle: "ATK",
          landingCaption: "stare into the void to connect (ATK)",
          lod: { code: "005 // Glass Mode", title: "玻璃模式", desc: "适配玻璃表面，开启后状态会同步至设备" },
          led: { code: "006 // Low Batt Warn", title: "LED低电量提示", desc: "当低电量时，鼠标灯效会频繁闪烁" },

          // 性能模式描述
          perfMode: {
            low:   { color: "#00A86B", text: "基础模式，该模式下鼠标传感器处于低性能状态,续航长,适合日常办公" },
            hp:    { color: "#000000", text: "ATK绝杀竞技固件，该模式下鼠标传感器处于高性能状态,扫描频率高,操控更跟手 " },
            sport: { color: "#FF4500", text: "ATK绝杀竞技固件 " },
            oc:    { color: "#4F46E5", text: "ATK绝杀竞技固件MAX，该模式下传感器性能将达到极限,静态扫描帧率≥20000,延迟进一步降低,移动轨迹更精准 " },
          },

          // ATK 灯效配置
          lights: {
            dpi: [
              { val: 0, label: "关闭", cls: "atk-mode-0" },
              { val: 1, label: "常亮", cls: "atk-mode-1" },
              { val: 2, label: "呼吸", cls: "atk-mode-2" }
            ],
            receiver: [
              { val: 0, label: "关闭", cls: "atk-mode-0" },
              { val: 1, label: "回报率模式", cls: "atk-mode-1" },
              { val: 2, label: "电量梯度", cls: "atk-mode-2" },
              { val: 3, label: "低电压模式", cls: "atk-mode-3" }
            ]
          }
        },
      },
    },

    utils: {
      clamp,
      buildSelectOptions,
    },
  };

  window.AppConfig = AppConfig;
})();

/**
 * 设备适配层（Decoupling + Extensibility）
 * - DeviceEnv：设备识别与族群归一
 * - DeviceAdapters：数据驱动的 UI 适配器注册表（策略/适配器模式）
 * - DeviceWriter：写入策略抽离（保持后端接口兼容）
 */
(function () {
  const normalize = (id) => {
    const x = String(id || "").toLowerCase();
    if (x === "rapoo") return "rapoo";
    if (x === "atk") return "atk";
    return "chaos";
  };

  const familyOf = (id) => {
    const x = normalize(id);
    return (x === "rapoo" || x === "atk") ? "rapoo" : "chaos";
  };

  window.DeviceEnv = { normalize, familyOf };

  function createAdapter(deviceId) {
    const id = normalize(deviceId);
    const cfg = window.AppConfig?.ranges?.[id] || window.AppConfig?.ranges?.chaos;

    return {
      id,
      family: familyOf(id),

      // 纯数据：UI 文案/范围/选项
      ui: {
        landingTitle: cfg?.texts?.landingTitle,
        landingCaption: cfg?.texts?.landingCaption,
        lod: cfg?.texts?.lod,
        led: cfg?.texts?.led,
        perfMode: cfg?.texts?.perfMode,
        lights: cfg?.texts?.lights,
      },

      ranges: cfg,
    };
  }

  const adapters = {
    chaos: createAdapter("chaos"),
    rapoo: createAdapter("rapoo"),
    atk: createAdapter("atk"),
  };

  window.DeviceAdapters = {
    getAdapter(id) {
      return adapters[normalize(id)] || adapters.chaos;
    },
  };

  /**
   * 设备配置写入策略
   * 保持与 hidApi 和 ProtocolApi 的接口协议兼容
   * 
   * 写入规则：
   * - Chaos 设备：非 modeByte 类键使用 setFeature；modeByte 使用 setBatchFeatures（需提供 base）
   * - Rapoo 家族：全部使用 setFeature（避免 setBatchFeatures 行为差异）
   * 
   * @param {Object} params - 写入参数
   * @param {Object} params.hidApi - HID API 实例
   * @param {Object} params.ProtocolApi - 协议 API 对象
   * @param {Object} params.payload - 要写入的配置对象
   * @param {string} params.deviceId - 设备 ID
   * @param {string} params.deviceFamily - 设备家族
   * @param {Function} params.getLastChaosModeByte - 获取 Chaos 设备最后 modeByte 的函数
   * @param {Function} params.setLastChaosModeByte - 设置 Chaos 设备 modeByte 的函数
   */
  async function writePatch({
    hidApi,
    ProtocolApi,
    payload,
    deviceId,
    deviceFamily,
    getLastChaosModeByte,
    setLastChaosModeByte,
  }) {
    if (!payload || typeof payload !== "object") return;
    if (!hidApi) return;

    // 协议层别名归一化处理
    try {
      ProtocolApi?.normalizeKeyAliases?.(payload, [
        "pollingRate", "polling_rate",
        "sleepTimeout", "sleep_timeout",
        "debounceMs", "debounce_ms",
        "dpi", "dpi1", "dpi2", "dpi3", "dpi4", "dpi5",
        "ledEnabled", "led_enabled",
        "sensorAngle", "sensor_angle",
        "feel", "feelValue",
        "rippleControl", "ripple_control",
        "glassMode", "glass_mode",
        "modeByte", "mode_byte",
        "performanceMode", "performance_mode",
        "lodHeight", "lod_height",
        "motionSync", "motion_sync",
        "linearCorrection", "linear_correction",
      ]);
    } catch (e) {
      // ignore
    }

    if (deviceFamily === "rapoo") {
      if (typeof hidApi.setFeature !== "function") return;
      for (const [k, v] of Object.entries(payload)) {
        await hidApi.setFeature(k, v);
      }
      return;
    }

    // Chaos 写入策略：将 modeByte 相关键与其他键分离
    const modeKeys = new Set([
      // modeByte 本身
      "modeByte",
      "mode_byte",

      // 性能模式位（bit4/5/7）
      "performanceMode",
      "performance_mode",

      // LOD 位（bit0）
      "lodHeight",
      "lod",
      "lod_height",

      // 功能开关位（bit1/2/3）
      "motionSync",
      "motion_sync",
      "linearCorrection",
      "linear_correction",
      "rippleControl",
      "ripple_control",

      // 玻璃模式位（bit6）
      "glassMode",
      "glass_mode",
    ]);

    const modePatch = {};
    const otherPatch = {};
    for (const [k, v] of Object.entries(payload)) {
      if (modeKeys.has(k)) modePatch[k] = v;
      else otherPatch[k] = v;
    }

    // 步骤 1：先写入其他键（避免批量写入覆盖某些特性）
    if (typeof hidApi.setFeature === "function") {
      for (const [k, v] of Object.entries(otherPatch)) {
        await hidApi.setFeature(k, v);
      }
    }

    // 步骤 2：再写入 modeByte 相关键（需提供 base，避免刷新或误操作导致开关状态错误）
    if (Object.keys(modePatch).length && typeof hidApi.setBatchFeatures === "function") {
      const base = (typeof getLastChaosModeByte === "function") ? getLastChaosModeByte() : null;
      if (base != null && !("modeByte" in modePatch) && !("mode_byte" in modePatch)) {
        modePatch.modeByte = base;
      }

      await hidApi.setBatchFeatures(modePatch);

      // 更新 base 值，确保连续操作多个开关时状态一致
      try {
        const nextMb = ProtocolApi?.encodeModeByteFromState?.(modePatch);
        const n = Number(nextMb);
        if (!Number.isNaN(n) && typeof setLastChaosModeByte === "function") {
          setLastChaosModeByte(n);
        }
      } catch (e) {
        // 忽略编码错误
      }
    }
  }

  window.DeviceWriter = { writePatch };
})();

/**
 * UI 变体层（Decoupling）
 * - 仅做“UI配置/DOM 映射/可见性/文案/范围”
 * - 不进行任何 hid 写入，不依赖业务逻辑状态
 */
(function () {
  const { buildSelectOptions } = window.AppConfig?.utils || {};

  /**
   * 缓存元素的原始 HTML 内容
   * @param {HTMLElement} el - 目标元素
   * @param {string} key - 缓存键名
   */
  function cacheInnerHtml(el, key) {
    if (!el) return;
    const k = `__orig_${key}`;
    if (!el.dataset[k]) el.dataset[k] = el.innerHTML;
  }

  /**
   * 恢复元素的原始 HTML 内容
   * @param {HTMLElement} el - 目标元素
   * @param {string} key - 缓存键名
   */
  function restoreInnerHtml(el, key) {
    if (!el) return;
    const k = `__orig_${key}`;
    if (el.dataset[k]) el.innerHTML = el.dataset[k];
  }

  /**
   * 应用下拉框选项
   * @param {HTMLSelectElement} selectEl - 下拉框元素
   * @param {number[]} values - 选项值数组
   * @param {Function} labelFn - 标签生成函数
   */
  function applySelectOptions(selectEl, values, labelFn) {
    if (!selectEl || !Array.isArray(values)) return;
    selectEl.innerHTML = buildSelectOptions(values, labelFn);
  }

  /**
   * 自动设置滑块轨道间隔
   * 根据最大值、最小值和步进自动计算刻度密度，确保视觉上不拥挤
   * 
   * @param {HTMLElement} root - 根元素容器
   */
  function installAutoTrackInterval(root) {
    /**
     * 更新单个滑块的轨道间隔
     * @param {HTMLInputElement} input - 滑块输入元素
     * @param {HTMLElement} customTrack - 自定义轨道元素
     */
    const updateTrackInterval = (input, customTrack) => {
      if (!input || !customTrack) return;
      const min = parseFloat(input.min) || 0;
      const max = parseFloat(input.max) || 100;
      const step = parseFloat(input.step) || 1;
      const range = max - min;
      if (range <= 0) return;

      // 根据步进计算密度：如果总步数过多，则倍增步进直到视觉上不拥挤（限制在约 20 个刻度内）
      let effectiveStep = step;
      let count = range / effectiveStep;

      while (count > 20) {
        effectiveStep *= 2;
        count = range / effectiveStep;
      }
      
      if (count < 1) count = 1;

      // 转换为百分比并设置 CSS 变量
      const interval = (effectiveStep / range) * 100;
      customTrack.style.setProperty("--track-interval", `${interval}%`);
    };

    const sliders = root.querySelectorAll('#advancedPanel input[type="range"]');
    sliders.forEach((slider) => {
      const track = slider.closest(".range-wrap")?.querySelector(".custom-track");
      if (!track) return;
      updateTrackInterval(slider, track);

      const observer = new MutationObserver(() => updateTrackInterval(slider, track));
      observer.observe(slider, { attributes: true, attributeFilter: ["min", "max", "step"] });
    });
  }

  /**
   * 应用设备 UI 变体
   * 根据设备类型调整 UI 配置、文案、范围和可见性
   * 
   * @param {Object} params - 变体参数
   * @param {string} params.deviceId - 设备 ID
   * @param {string} params.family - 设备家族
   * @param {Object} params.adapter - 设备适配器对象
   * @param {HTMLElement} params.root - 根元素容器
   */
  function applyVariant({ deviceId, family, adapter, root }) {
    const doc = root || document;
    const cfg = adapter?.ranges || window.AppConfig?.ranges?.chaos;

    // 起始页标题和提示文案
    const landingLayer = doc.getElementById("landing-layer");
    const landingCaption = landingLayer?.querySelector(".caption");
    const verticalTitle = landingLayer?.querySelector(".vertical-title");
    if (verticalTitle && adapter?.ui?.landingTitle) verticalTitle.textContent = adapter.ui.landingTitle;
    if (landingCaption && adapter?.ui?.landingCaption) landingCaption.textContent = adapter.ui.landingCaption;

    // 基础性能页：回报率下拉框（缓存原始内容）
    const pollingSelect = doc.getElementById("pollingSelect");
    if (pollingSelect) cacheInnerHtml(pollingSelect, "pollingSelect");

      // 高级面板：传感器手感（Chaos）或光学引擎高度（Rapoo 家族）
      const feelInput = doc.getElementById("feelInput");
    const feelDisp = doc.getElementById("feel_disp");
    const feelCard = feelInput?.closest(".slider-card");
    const feelName = feelCard?.querySelector(".slider-name");
    const feelSub = feelCard?.querySelector(".slider-sub");

    // 缓存 Feel 滑块原始文案和范围，避免设备切换时互相污染
    if (feelInput && !feelInput.dataset.__orig_min) {
      feelInput.dataset.__orig_min = String(feelInput.min ?? "");
      feelInput.dataset.__orig_max = String(feelInput.max ?? "");
      feelInput.dataset.__orig_step = String(feelInput.step ?? "");
    }
    if (feelName && feelName.dataset.__orig_text == null) feelName.dataset.__orig_text = feelName.textContent ?? "";
    if (feelSub && feelSub.dataset.__orig_text == null) feelSub.dataset.__orig_text = feelSub.textContent ?? "";
    if (feelDisp && feelDisp.dataset.__orig_unit == null) {
      feelDisp.dataset.__orig_unit = String(feelDisp.dataset.unit ?? "");
    }

    // 引擎高度可视化：Rapoo 家族显示，Chaos 设备隐藏（Chaos 使用传感器手感）
    const heightBlock = doc.getElementById("heightBlock");
    const heightVizWrap = heightBlock?.closest?.(".height-viz") || heightBlock?.parentElement || null;
    const __setHeightVizVisible = (visible) => {
      const target = (heightVizWrap && heightVizWrap !== feelCard) ? heightVizWrap : heightBlock;
      if (!target) return;
      if (target.dataset.__orig_display == null) target.dataset.__orig_display = String(target.style.display ?? "");
      target.style.display = visible ? (target.dataset.__orig_display || "") : "none";
    };

    // 高级面板：LOD 开关（bitLOD）
    const lodInput = doc.getElementById("bitLOD");
    const lodItem = lodInput?.closest("label.advShutterItem");
    const lodCode = lodItem?.querySelector(".label-code");
    const lodTitle = lodItem?.querySelector(".label-title");
    const lodDesc = lodItem?.querySelector(".label-desc");

    // 高级面板：bit6 项（Chaos 设备使用，Rapoo 家族隐藏）
    const b6 = doc.getElementById("bit6");
    const b6Item = b6?.closest("label.advShutterItem");

    const rapooPollingCycle = doc.getElementById("rapooPollingCycle");

    // 休眠和防抖下拉框（隐藏控件，由滑块同步）
    const sleepSel = doc.getElementById("sleepSelect");
    const sleepInput = doc.getElementById("sleepInput");
    const debounceSel = doc.getElementById("debounceSelect");
    const debounceInput = doc.getElementById("debounceInput");

    if (sleepSel) cacheInnerHtml(sleepSel, "sleepSelect");
    if (debounceSel) cacheInnerHtml(debounceSel, "debounceSelect");

    if (family === "rapoo") {
      __setHeightVizVisible(true);
      // 基础性能页：回报率选项
      if (pollingSelect && cfg?.polling?.basicHz) {
        applySelectOptions(pollingSelect, cfg.polling.basicHz, (hz) => (hz >= 1000 ? `${hz/1000}k` : String(hz)));
      }

      // 高级面板：手感滑块（Rapoo 家族显示为"引擎高度"）
      const feelCfg = cfg?.sensor?.feel;
      if (feelInput && feelCfg) {
        feelInput.min = String(feelCfg.min);
        feelInput.max = String(feelCfg.max);
        feelInput.step = String(feelCfg.step || 1);
        if (feelName) feelName.textContent = feelCfg.name || "引擎高度";
        if (feelSub) feelSub.textContent = feelCfg.sub || "";
        if (feelDisp) feelDisp.dataset.unit = feelCfg.unit || "";
      }

      // LOD 开关文案
      if (adapter?.ui?.lod) {
        if (lodCode) lodCode.textContent = adapter.ui.lod.code || "";
        if (lodTitle) lodTitle.textContent = adapter.ui.lod.title || "";
        if (lodDesc) lodDesc.textContent = adapter.ui.lod.desc || "";
      }

      // 隐藏 Chaos 的 bit6 项，显示 Rapoo 轮询循环按钮
      if (b6Item) b6Item.style.display = "none";
      if (rapooPollingCycle) rapooPollingCycle.style.display = "block";

      // Power: sleep
      const sleepSeconds = cfg?.power?.sleepSeconds;
      if (sleepSel && Array.isArray(sleepSeconds)) {
        // 智能显示单位：小于 60 秒显示 s，否则显示 m
        applySelectOptions(sleepSel, sleepSeconds, (sec) => {
            return sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}m`;
        });

        if (sleepInput) {
          sleepInput.min = "0";
          sleepInput.max = String(Math.max(0, sleepSeconds.length - 1));
          sleepInput.step = "1";
        }
        // 更新休眠范围描述文案
        const sleepCard = sleepInput?.closest(".slider-card");
        const sub = sleepCard?.querySelector(".slider-sub");
        if (sub) {
            const minS = sleepSeconds[0];
            const maxS = sleepSeconds[sleepSeconds.length-1];
            const minT = minS < 60 ? `${minS}s` : `${minS/60}min`;
            const maxT = maxS < 60 ? `${maxS}s` : `${maxS/60}min`;
            sub.textContent = `范围 ${minT} - ${maxT}`;
        }
      }

      // Power: debounce
      const debounceMs = cfg?.power?.debounceMs;
      if (debounceSel && Array.isArray(debounceMs)) {
        applySelectOptions(debounceSel, debounceMs, (ms) => String(ms));
        if (debounceInput) {
             debounceInput.min = "0";
             debounceInput.max = String(Math.max(0, debounceMs.length - 1));
             debounceInput.step = "1";
        }
        // 更新防抖范围描述文案
        const debCard = debounceInput?.closest(".slider-card");
        const sub = debCard?.querySelector(".slider-sub");
        if (sub && debounceMs.length > 0) {
            sub.textContent = `范围 ${debounceMs[0]}ms - ${debounceMs[debounceMs.length-1]}ms`;
        }
      }

      // 传感器角度范围
      const angleCfg = cfg?.sensor?.angleDeg;
      const angleInput = doc.getElementById("angleInput");
      if (angleInput && angleCfg) {
        angleInput.min = String(angleCfg.min);
        angleInput.max = String(angleCfg.max);
        if (angleCfg.step != null) angleInput.step = String(angleCfg.step);
        const angleCard = angleInput.closest(".slider-card");
        const angleSub = angleCard?.querySelector(".slider-sub");
        if (angleSub && angleCfg.hint) angleSub.textContent = angleCfg.hint;
      }

      // LED 开关文案
      if (adapter?.ui?.led) {
        const ledItem = doc.getElementById("ledToggle")?.closest(".advShutterItem");
        if (ledItem) {
          const title = ledItem.querySelector(".label-title");
          const desc = ledItem.querySelector(".label-desc");
          const code = ledItem.querySelector(".label-code");
          if (title) title.textContent = adapter.ui.led.title || "";
          if (desc) desc.textContent = adapter.ui.led.desc || "";
          if (code) code.textContent = adapter.ui.led.code || "";
        }
      }

      // ATK 设备专属显隐逻辑
      const isAtk = (deviceId === 'atk');
      
      // 获取需要控制显隐的元素
      const lodItem = doc.getElementById("bitLOD")?.closest(".advShutterItem");
      const ledItem = doc.getElementById("ledToggle")?.closest(".advShutterItem");
      
      const atkDpiLight = doc.getElementById("atkDpiLightCycle");
      const atkRxLight = doc.getElementById("atkReceiverLightCycle");
      const atkLongRange = doc.getElementById("atkLongRangeModeItem");

      if (isAtk) {
          // ATK: 隐藏不兼容的功能
          if (rapooPollingCycle) rapooPollingCycle.style.display = "none";
          if (lodItem) lodItem.style.display = "none";
          if (ledItem) ledItem.style.display = "none";

          // ATK: 显示专属功能
          if (atkDpiLight) atkDpiLight.style.display = "block";
          if (atkRxLight) atkRxLight.style.display = "block";
          if (atkLongRange) atkLongRange.style.display = "block";
          
          // ATK: 隐藏 Basic 页面的 Sport 模式
          const sportItem = doc.querySelector('.basicItem[data-perf="sport"]');
          if (sportItem) sportItem.style.display = 'none';

      } else {
          // Rapoo: 恢复默认显示
          if (rapooPollingCycle) rapooPollingCycle.style.display = "block";
          if (lodItem) lodItem.style.display = "block";
          if (ledItem) ledItem.style.display = "block";

          // Rapoo: 隐藏 ATK 专属功能
          if (atkDpiLight) atkDpiLight.style.display = "none";
          if (atkRxLight) atkRxLight.style.display = "none";
          if (atkLongRange) atkLongRange.style.display = "none";
          
          // Rapoo: 恢复 Sport 模式
          const sportItem = doc.querySelector('.basicItem[data-perf="sport"]');
          if (sportItem) sportItem.style.display = '';
      }

    } else {
      // Chaos：恢复被 Rapoo 家族修改过的内容，确保设备切换时状态正确

      // Feel 滑块：恢复原始文案和范围，避免从 Rapoo 家族切回时残留"引擎高度"配置
      if (feelInput && feelInput.dataset.__orig_min != null) {
        feelInput.min = feelInput.dataset.__orig_min;
        feelInput.max = feelInput.dataset.__orig_max;
        if (feelInput.dataset.__orig_step != null) feelInput.step = feelInput.dataset.__orig_step;
      }
      if (feelName && feelName.dataset.__orig_text != null) feelName.textContent = feelName.dataset.__orig_text;
      if (feelSub && feelSub.dataset.__orig_text != null) feelSub.textContent = feelSub.dataset.__orig_text;
      if (feelDisp && feelDisp.dataset.__orig_unit != null) feelDisp.dataset.unit = feelDisp.dataset.__orig_unit;

      // Chaos 设备不显示"引擎高度可视化"组件（Chaos 使用传感器手感）
      __setHeightVizVisible(false);

      if (pollingSelect) restoreInnerHtml(pollingSelect, "pollingSelect");
      if (b6Item) b6Item.style.display = "";
      if (rapooPollingCycle) rapooPollingCycle.style.display = "none";

      if (sleepSel) restoreInnerHtml(sleepSel, "sleepSelect");
      if (debounceSel) restoreInnerHtml(debounceSel, "debounceSelect");
      
      const sportItem = doc.querySelector('.basicItem[data-perf="sport"]');
      if (sportItem) sportItem.style.display = '';
    }

    installAutoTrackInterval(doc);
  }

  window.DeviceUI = { applyVariant };
})();
