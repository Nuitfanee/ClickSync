
/**
 * Manifesto: Registry & Adapter
 * 本模块定义语义槽位、设备画像与映射规则，是配置与转换的单一事实来源。
 * 目标是保持 UI 与 Runtime 解耦，所有协议差异通过 profile/adapter 统一表达。
 *
 * 禁止事项：
 * - 这里不做 WebHID 调用；仅做映射、归一化与安全转换。
 * - UI 不得写设备分支；差异必须落在 profile/adapter。
 * - 禁止绕过 keyMap/transforms 直连协议键。
 */

// ============================================================
// 1) AppConfig：公共范围、时序与文案
// ============================================================
(function () {
  /**
   * 将数值钳制在指定区间内。
   * 目的：确保写入参数落在设备允许范围内，避免越界写入。
   *
   * @param {number} n - 待处理的数值。
   * @param {number} min - 下界。
   * @param {number} max - 上界。
   * @returns {number} 被钳制后的数值。
   */
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  /**
   * 生成 select 的 HTML 选项字符串。
   * 目的：集中生成选项模板，减少分散拼接带来的不一致。
   *
   * @param {Array<number|string>} values - 可选值列表。
   * @param {(value: number|string) => string} label - 展示文案构造器。
   * @returns {string} HTML 片段。
   */
  function buildSelectOptions(values, label) {
    return values.map((v) => `<option value="${v}">${label(v)}</option>`).join("");
  }

  const AppConfig = {
    timings: {

      debounceMs: {
        slotCount: 120,
        deviceState: 200,
        sleep: 120,
        debounce: 120,
        led: 80,
      },
    },


    ranges: {
      chaos: {
        power: {

          sleepSeconds: [10, 30, 50, 60, 120, 900, 1800],
          debounceMs: [1, 2, 4, 8, 15],
        },
        sensor: {

          angleDeg: { min: -20, max: 20, step: 1, hint: "" },
          feel: null,
        },
      },

      rapoo: {
        power: {

          sleepSeconds: Array.from({ length: 119 }, (_, i) => (i + 2) * 60),

          debounceMs: Array.from({ length: 33 }, (_, i) => i),
        },
        sensor: {
          angleDeg: { min: -30, max: 30, step: 1, hint: "范围 -30° ~ 30°" },
          feel: { min: 1, max: 11, step: 1, unit: "挡", name: "引擎高度", sub: "范围 1 - 11 挡" },
        },
        polling: {
          basicHz: [125, 250, 500, 1000, 2000, 4000, 8000],

          advHz: [1000, 2000, 4000, 8000],
        },
        texts: {
          landingTitle: "RAPOO",
          landingCaption: "stare into the void to connect (Rapoo)",
          lod: { code: "005 // Glass Mode", title: "玻璃模式", desc: "适配玻璃表面" },
          led: { code: "006 // Low Batt Warn", title: "LED低电量提示", desc: "当低电量时，有led指示灯提示" },


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

          sleepSeconds: [30, 60, 120, 180, 300, 1200, 1500, 1800],

          debounceMs: [0, 1, 2, 4, 8, 15, 20],
        },
        sensor: {

          angleDeg: { min: -30, max: 30, step: 1, hint: "范围 -30° ~ 30°" },
          feel: { min: 1, max: 11, step: 1, unit: "挡", name: "引擎高度", sub: "范围 1 - 11 挡" },
        },
        polling: {

          basicHz: [125, 250, 500, 1000, 2000, 4000, 8000],
          advHz: [1000, 2000, 4000, 8000],
        },
        texts: {
          landingTitle: "ATK",
          landingCaption: "stare into the void to connect (ATK)",
          lod: { code: "005 // Glass Mode", title: "玻璃模式", desc: "适配玻璃表面，开启后状态会同步至设备" },
          led: { code: "006 // Low Batt Warn", title: "LED低电量提示", desc: "当低电量时，鼠标灯效会频繁闪烁" },


          perfMode: {
            low:   { color: "#00A86B", text: "基础模式，该模式下鼠标传感器处于低性能状态,续航长,适合日常办公" },
            hp:    { color: "#000000", text: "ATK绝杀竞技固件，该模式下鼠标传感器处于高性能状态,扫描频率高,操控更跟手 " },
            sport: { color: "#FF4500", text: "ATK绝杀竞技固件 " },
            oc:    { color: "#4F46E5", text: "ATK绝杀竞技固件MAX，该模式下传感器性能将达到极限,静态扫描帧率≥20000,延迟进一步降低,移动轨迹更精准 " },
          },


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


// ============================================================
// 2) 设备画像与适配器（注册表 + 翻译）
// ============================================================
(function () {
  const clamp = window.AppConfig?.utils?.clamp || ((n, min, max) => Math.min(max, Math.max(min, n)));

  /**
   * 规范化设备 ID。
   * 目的：统一设备 ID 入口，避免别名导致的分支与漂移。
   *
   * @param {string} id - 设备标识。
   * @returns {string} 规范化后的设备标识。
   */
  const normalizeDeviceId = (id) => {
    const x = String(id || "").toLowerCase();
    if (x === "rapoo") return "rapoo";
    if (x === "atk") return "atk";
    return "chaos";
  };

  /**
   * 将输入安全转换为 number。
   * 目的：过滤 NaN/非法值，避免协议层接收不可预期数据。
   *
   * @param {unknown} v - 待转换的值。
   * @returns {number|undefined} 合法数值或 undefined。
   */
  const toNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  /**
   * 将输入安全转换为 boolean。
   * 目的：统一布尔归一化，保持 0/1 与 true/false 的一致映射。
   *
   * @param {unknown} raw - 原始值。
   * @returns {boolean|undefined} 布尔值或 undefined。
   */
  const readBool = (raw) => (raw == null ? undefined : !!raw);

  /**
   * 将输入安全转换为 number（只读）。
   * 目的：读取回包时过滤无效值，避免 UI 接收 null/undefined。
   *
   * @param {unknown} raw - 原始值。
   * @returns {number|undefined} 合法数值或 undefined。
   */
  const readNumber = (raw) => (raw == null ? undefined : toNumber(raw));

  const rapooTexts = window.AppConfig?.ranges?.rapoo?.texts || {};
  const atkTexts = window.AppConfig?.ranges?.atk?.texts || {};

  /**
   * 所有适配器共享的标准 Key 映射。
   * 目的：稳定语义槽位到固件 Key 的映射，
   * 支持数组以实现多 Key 回退/兼容。
   */
  const KEYMAP_COMMON = {
    pollingHz: ["pollingHz", "polling_rate", "pollingRateHz", "reportRateHz", "reportHz", "polling"],
    sleepSeconds: ["sleepSeconds", "sleep_timeout"],
    debounceMs: ["debounceMs", "debounce_ms"],
    performanceMode: "performanceMode",
    motionSync: "motionSync",
    linearCorrection: "linearCorrection",
    rippleControl: "rippleControl",
    sensorAngle: "sensorAngle",
  };

  /**
   * 共享的值转换器（单位/语义归一化）。
   * 目的：统一人类可读单位与协议编码之间的转换，
   * 协议层常要求字节/位域/枚举，必须集中转换。
   */
  const TRANSFORMS_COMMON = {
    pollingHz: {
      write: (v) => toNumber(v),
      read: (raw) => readNumber(raw),
    },
    sleepSeconds: {
      write: (v) => toNumber(v),
      read: (raw) => readNumber(raw),
    },
    debounceMs: {
      write: (v) => toNumber(v),
      read: (raw) => readNumber(raw),
    },
    motionSync: { write: (v) => !!v, read: readBool },
    linearCorrection: { write: (v) => !!v, read: readBool },
    rippleControl: { write: (v) => !!v, read: readBool },
    sensorAngle: {
      write: (v) => toNumber(v),
      read: (raw) => readNumber(raw),
    },
  };


  /**
   * 读取表面手感的兼容降级逻辑。
   * 目的：在字段缺失时通过历史字段推算，保证兼容。
   *
   * @param {unknown} raw - 直接读取的原始值。
   * @param {Object} ctx - 上下文（包含 cfg）。
   * @returns {number|undefined} 归一化后的等级。
   */
  const readSurfaceFeelFallback = (raw, ctx) => {
    const direct = readNumber(raw);
    if (direct != null) return direct;

    const mm = toNumber(ctx?.cfg?.opticalEngineHeightMm);
    if (mm != null) {
      const level = Math.round(mm * 10) - 6;
      return clamp(level, 1, 11);
    }

    const lh = ctx?.cfg?.lodHeight;
    if (lh != null) {
      const l = String(lh).toLowerCase();
      const mmFallback = l === "low" ? 0.7 : (l === "high" ? 1.7 : 1.2);
      const level = Math.round(mmFallback * 10) - 6;
      return clamp(level, 1, 11);
    }

    return undefined;
  };

  const BaseRapooProfile = {
    id: "rapoo",
    ui: {
      landingTitle: rapooTexts.landingTitle,
      landingCaption: rapooTexts.landingCaption,
      lod: rapooTexts.lod,
      led: rapooTexts.led,
      perfMode: rapooTexts.perfMode,
      lights: rapooTexts.lights,
    },
    ranges: window.AppConfig?.ranges?.rapoo,
    keyMap: {
      ...KEYMAP_COMMON,
      surfaceModePrimary: "glassMode",
      surfaceModeSecondary: null,
      primaryLedFeature: "ledLowBattery",
      surfaceFeel: "opticalEngineLevel",
      keyScanningRate: "keyScanningRate",
      wirelessStrategyMode: "wirelessStrategy",
      commProtocolMode: "commProtocol",
    },
    transforms: {
      ...TRANSFORMS_COMMON,
      surfaceModePrimary: { write: (v) => !!v, read: readBool },
      primaryLedFeature: { write: (v) => !!v, read: readBool },
      surfaceFeel: { write: (v) => toNumber(v), read: readSurfaceFeelFallback },
      keyScanningRate: { write: (v) => toNumber(v), read: readNumber },
      wirelessStrategyMode: {
        write: (v) => (!!v ? "full" : "smart"),
        read: (raw) => {
          if (raw == null) return undefined;
          if (typeof raw === "string") return raw.toLowerCase() === "full";
          return !!raw;
        },
      },
      commProtocolMode: {
        write: (v) => (!!v ? "initial" : "efficient"),
        read: (raw) => {
          if (raw == null) return undefined;
          if (typeof raw === "string") return raw.toLowerCase() === "initial";
          return !!raw;
        },
      },
    },
    features: {
      hasPrimarySurfaceToggle: true,
      hasSecondarySurfaceToggle: false,
      hasPrimaryLedFeature: true,
      hasMotionSync: true,
      hasLinearCorrection: true,
      hasRippleControl: true,
      hasKeyScanRate: true,
      hasWirelessStrategy: true,
      hasCommProtocol: true,
      hasLongRange: false,
      hasAtkLights: false,
      hasDpiColors: false,
      showHeightViz: true,
      hideSportPerfMode: false,
      supportsBatteryRequest: false,
      batteryPollMs: 120000,
      batteryPollTag: "2min",
      enterDelayMs: 0,
    },
  };

  const AtkProfile = {
    ...BaseRapooProfile,
    id: "atk",
    ui: {
      ...BaseRapooProfile.ui,
      landingTitle: atkTexts.landingTitle,
      landingCaption: atkTexts.landingCaption,
      lod: atkTexts.lod,
      led: atkTexts.led,
      perfMode: atkTexts.perfMode,
      lights: atkTexts.lights,
    },
    ranges: window.AppConfig?.ranges?.atk,
    keyMap: {
      ...BaseRapooProfile.keyMap,
      surfaceModePrimary: null,
      primaryLedFeature: null,
      keyScanningRate: null,
      wirelessStrategyMode: null,
      commProtocolMode: null,
      longRangeMode: "longRangeMode",
      dpiLightEffect: "dpiLightEffect",
      receiverLightEffect: "receiverLightEffect",
    },
    transforms: {
      ...BaseRapooProfile.transforms,
      longRangeMode: { write: (v) => !!v, read: readBool },
      dpiLightEffect: { write: (v) => toNumber(v), read: readNumber },
      receiverLightEffect: { write: (v) => toNumber(v), read: readNumber },
    },
    features: {
      ...BaseRapooProfile.features,
      hasPrimarySurfaceToggle: false,
      hasSecondarySurfaceToggle: false,
      hasPrimaryLedFeature: false,
      hasKeyScanRate: false,
      hasWirelessStrategy: false,
      hasCommProtocol: false,
      hasLongRange: true,
      hasAtkLights: true,
      hasDpiColors: true,
      hideSportPerfMode: true,
      supportsBatteryRequest: true,
      batteryPollMs: 60000,
      batteryPollTag: "60s",
      enterDelayMs: 120,
    },
  };

  const ChaosProfile = {
    id: "chaos",
    ui: {},
    ranges: window.AppConfig?.ranges?.chaos,
    keyMap: {
      ...KEYMAP_COMMON,
      surfaceModePrimary: "lodHeight",
      surfaceModeSecondary: "glassMode",
      primaryLedFeature: ["ledEnabled", "rgb_switch", "ledRaw"],
      surfaceFeel: "sensorFeel",
    },
    transforms: {
      ...TRANSFORMS_COMMON,
      surfaceModePrimary: {
        write: (v) => (!!v ? "low" : "high"),
        read: (raw) => {
          if (raw == null) return undefined;
          if (typeof raw === "string") return raw.toLowerCase() === "low";
          return !!raw;
        },
      },
      surfaceModeSecondary: { write: (v) => !!v, read: readBool },
      primaryLedFeature: { write: (v) => !!v, read: readBool },
      surfaceFeel: { write: (v) => toNumber(v), read: readNumber },
      sleepSeconds: {
        write: (v) => toNumber(v),
        read: (raw, ctx) => {
          const direct = readNumber(raw);
          if (direct != null) return direct;
          const legacy = toNumber(ctx?.cfg?.sleep16);
          if (legacy == null) return undefined;
          const map = window.ProtocolApi?.MOUSE_HID?.sleepCodeToSeconds || {};
          if (map[String(legacy)] != null) return map[String(legacy)];
          const values = Object.values(map);
          if (values.includes(legacy)) return legacy;
          return legacy;
        },
      },
    },
    features: {
      hasPrimarySurfaceToggle: true,
      hasSecondarySurfaceToggle: true,
      hasPrimaryLedFeature: true,
      hasMotionSync: true,
      hasLinearCorrection: true,
      hasRippleControl: true,
      hasKeyScanRate: false,
      hasWirelessStrategy: false,
      hasCommProtocol: false,
      hasLongRange: false,
      hasAtkLights: false,
      hasDpiColors: false,
      showHeightViz: false,
      hideSportPerfMode: false,
      supportsBatteryRequest: true,
      batteryPollMs: 60000,
      batteryPollTag: "60s",
      enterDelayMs: 0,
    },
  };

  /**
   * DEVICE_PROFILES 是跨品牌能力复用的继承树。
   * 目的：通过组合/覆盖复用能力配置，保持 UI 槽位稳定并隔离品牌差异。
   */
  const DEVICE_PROFILES = {
    chaos: ChaosProfile,
    rapoo: BaseRapooProfile,
    atk: AtkProfile,
  };


  /**
   * 从设备画像创建运行期适配器。
   * 目的：提供面向 UI 的只读快照，隔离内部配置结构。
   *
   * @param {Object} profile - 设备画像。
   * @returns {Object} 适配器对象。
   */
  function createAdapter(profile) {
    const cfg = profile?.ranges || window.AppConfig?.ranges?.chaos;
    return {
      id: profile.id,
      ui: profile.ui || {},
      ranges: cfg,
      keyMap: profile.keyMap || {},
      transforms: profile.transforms || {},
      features: profile.features || {},
    };
  }

  const adapters = {
    chaos: createAdapter(DEVICE_PROFILES.chaos),
    rapoo: createAdapter(DEVICE_PROFILES.rapoo),
    atk: createAdapter(DEVICE_PROFILES.atk),
  };

  window.DeviceAdapters = {
    /**
     * 获取指定设备的适配器。
     * 目的：提供统一适配器入口，避免 UI 直接依赖 profile。
     *
     * @param {string} id - 设备标识。
     * @returns {Object} 适配器实例。
     */
    getAdapter(id) {
      return adapters[normalizeDeviceId(id)] || adapters.chaos;
    },
  };

  /**
   * 规范化 keyMap 的映射值为数组。
   * 目的：统一单值/多值映射形态，简化写入与读取流程。
   *
   * @param {string|string[]|null|undefined} mapVal - 映射值。
   * @returns {string[]} 规范化后的 key 列表。
   */
  const normalizeKeyList = (mapVal) => {
    if (!mapVal) return [];
    if (Array.isArray(mapVal)) return mapVal.filter(Boolean);
    return [mapVal];
  };


  /**
   * 将标准 Key 的补丁通过适配器写入固件空间。
   * 目的：将标准写入入口集中化，确保统一转换与审计。
   *
   * @param {Object} args
   * @param {Object} args.hidApi - WebHID 包装器（需提供 setFeature）。
   * @param {Object} args.adapter - 提供 keyMap/transforms 的适配器。
   * @param {Object} args.payload - UI 层标准 Key 补丁。
   * @returns {Promise<void>} 写入完成的 Promise。
   */
  async function writePatch({ hidApi, adapter, payload }) {
    if (!payload || typeof payload !== "object") return;
    if (!hidApi || typeof hidApi.setFeature !== "function") return;
    if (!adapter) return;

    const mapped = {};
    for (const [stdKey, v] of Object.entries(payload)) {
      const keys = normalizeKeyList(adapter?.keyMap?.[stdKey]);
      if (!keys.length) continue;
      const transformer = adapter?.transforms?.[stdKey];
      const outVal = transformer?.write ? transformer.write(v, { payload, adapter }) : v;
      if (outVal === undefined) continue;
      mapped[keys[0]] = outVal;
    }

    for (const [k, v] of Object.entries(mapped)) {
      await hidApi.setFeature(k, v);
    }
  }

  window.DeviceWriter = { writePatch };
})();


// ============================================================
// 3) DeviceUI：语义槽位 -> 视图变体
// ============================================================
(function () {
  const { buildSelectOptions } = window.AppConfig?.utils || {};

  /**
   * 缓存元素原始 innerHTML。
   * 目的：保留初始模板以支持可逆切换。
   *
   * @param {HTMLElement|null} el - 目标元素。
   * @param {string} key - 缓存键。
   * @returns {void} 无返回值。
   */
  function cacheInnerHtml(el, key) {
    if (!el) return;
    const k = `__orig_${key}`;
    if (!el.dataset[k]) el.dataset[k] = el.innerHTML;
  }

  /**
   * 恢复元素原始 innerHTML。
   * 目的：恢复初始模板，避免多次切换造成 DOM 污染。
   *
   * @param {HTMLElement|null} el - 目标元素。
   * @param {string} key - 缓存键。
   * @returns {void} 无返回值。
   */
  function restoreInnerHtml(el, key) {
    if (!el) return;
    const k = `__orig_${key}`;
    if (el.dataset[k]) el.innerHTML = el.dataset[k];
  }

  /**
   * 将数值列表应用到 select 元素。
   * 目的：统一选项渲染出口，避免配置分散。
   *
   * @param {HTMLSelectElement|null} selectEl - 下拉框。
   * @param {Array<number|string>} values - 值列表。
   * @param {(value: number|string) => string} labelFn - 文案生成函数。
   * @returns {void} 无返回值。
   */
  function applySelectOptions(selectEl, values, labelFn) {
    if (!selectEl || !Array.isArray(values)) return;
    selectEl.innerHTML = buildSelectOptions(values, labelFn);
  }

  /**
   * 安装滑轨刻度的自动对齐逻辑。
   * 目的：按范围/步长设置刻度节奏，保证可读性与反馈一致。
   *
   * @param {Document|HTMLElement} root - 作用域根节点。
   * @returns {void} 无返回值。
   */
  function installAutoTrackInterval(root) {
    /**
     * 计算并写入滑轨刻度间距。
     * 目的：控制刻度密度，平衡性能与可读性。
     *
     * @param {HTMLInputElement} input - range 输入。
     * @param {HTMLElement} customTrack - 轨道元素。
     * @returns {void} 无返回值。
     */
    const updateTrackInterval = (input, customTrack) => {
      if (!input || !customTrack) return;
      const min = parseFloat(input.min) || 0;
      const max = parseFloat(input.max) || 100;
      const step = parseFloat(input.step) || 1;
      const range = max - min;
      if (range <= 0) return;

      let effectiveStep = step;
      let count = range / effectiveStep;

      while (count > 20) {
        effectiveStep *= 2;
        count = range / effectiveStep;
      }

      if (count < 1) count = 1;

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
   * 按语义槽位与能力开关应用 UI 变体。
   * 目的：以能力标记驱动 UI 变体，避免设备分支进入 UI。
   *
   * @param {Object} args
   * @param {string} args.deviceId - 规范化设备 ID。
   * @param {Object} args.adapter - 适配器（包含 UI/feature 配置）。
   * @param {Document|HTMLElement} args.root - DOM 根节点。
   * @returns {void} 无返回值。
   */
  function applyVariant({ deviceId, adapter, root }) {
    const doc = root || document;
    const cfg = adapter?.ranges || window.AppConfig?.ranges?.chaos;
    const ui = adapter?.ui || {};
    const features = adapter?.features || {};

    const landingLayer = doc.getElementById("landing-layer");
    const landingCaption = landingLayer?.querySelector(".caption");
    const verticalTitle = landingLayer?.querySelector(".vertical-title");
    if (verticalTitle && ui?.landingTitle) verticalTitle.textContent = ui.landingTitle;
    if (landingCaption && ui?.landingCaption) landingCaption.textContent = ui.landingCaption;

    const pollingSelect = doc.getElementById("pollingSelect");
    if (pollingSelect) cacheInnerHtml(pollingSelect, "pollingSelect");
    if (pollingSelect && cfg?.polling?.basicHz) {
      applySelectOptions(pollingSelect, cfg.polling.basicHz, (hz) => (hz >= 1000 ? `${hz / 1000}k` : String(hz)));
    } else if (pollingSelect) {
      restoreInnerHtml(pollingSelect, "pollingSelect");
    }

    const feelInput = doc.getElementById("feelInput");
    const feelDisp = doc.getElementById("feel_disp");
    const feelCard = feelInput?.closest(".slider-card");
    const feelName = feelCard?.querySelector(".slider-name");
    const feelSub = feelCard?.querySelector(".slider-sub");

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

    const heightBlock = doc.getElementById("heightBlock");
    const heightVizWrap = heightBlock?.closest?.(".height-viz") || heightBlock?.parentElement || null;
    /**
     * 切换高度可视化模块显示状态。
     * 目的：按能力显示/隐藏高度可视化，避免无效提示。
     *
     * @param {boolean} visible - 是否显示。
     * @returns {void} 无返回值。
     */
    const __setHeightVizVisible = (visible) => {
      const target = (heightVizWrap && heightVizWrap !== feelCard) ? heightVizWrap : heightBlock;
      if (!target) return;
      if (target.dataset.__orig_display == null) target.dataset.__orig_display = String(target.style.display ?? "");
      target.style.display = visible ? (target.dataset.__orig_display || "") : "none";
    };

    const lodInput = doc.getElementById("bitLOD");
    const lodItem = lodInput?.closest("label.advShutterItem");
    const lodCode = lodItem?.querySelector(".label-code");
    const lodTitle = lodItem?.querySelector(".label-title");
    const lodDesc = lodItem?.querySelector(".label-desc");
    const ledItem = doc.getElementById("ledToggle")?.closest(".advShutterItem");

    const b6 = doc.getElementById("bit6");
    const b6Item = b6?.closest("label.advShutterItem");

    const rapooPollingCycle = doc.getElementById("rapooPollingCycle");

    const sleepSel = doc.getElementById("sleepSelect");
    const sleepInput = doc.getElementById("sleepInput");
    const debounceSel = doc.getElementById("debounceSelect");
    const debounceInput = doc.getElementById("debounceInput");

    if (sleepSel) cacheInnerHtml(sleepSel, "sleepSelect");
    if (debounceSel) cacheInnerHtml(debounceSel, "debounceSelect");

    const feelCfg = cfg?.sensor?.feel;
    if (feelInput && feelCfg) {
      feelInput.min = String(feelCfg.min);
      feelInput.max = String(feelCfg.max);
      feelInput.step = String(feelCfg.step || 1);
      if (feelName) feelName.textContent = feelCfg.name || "";
      if (feelSub) feelSub.textContent = feelCfg.sub || "";
      if (feelDisp) feelDisp.dataset.unit = feelCfg.unit || "";
    } else if (feelInput && feelInput.dataset.__orig_min != null) {
      feelInput.min = feelInput.dataset.__orig_min;
      feelInput.max = feelInput.dataset.__orig_max;
      if (feelInput.dataset.__orig_step != null) feelInput.step = feelInput.dataset.__orig_step;
      if (feelName && feelName.dataset.__orig_text != null) feelName.textContent = feelName.dataset.__orig_text;
      if (feelSub && feelSub.dataset.__orig_text != null) feelSub.textContent = feelSub.dataset.__orig_text;
      if (feelDisp && feelDisp.dataset.__orig_unit != null) feelDisp.dataset.unit = feelDisp.dataset.__orig_unit;
    }

    __setHeightVizVisible(!!features.showHeightViz);

    if (ui?.lod) {
      if (lodCode) lodCode.textContent = ui.lod.code || "";
      if (lodTitle) lodTitle.textContent = ui.lod.title || "";
      if (lodDesc) lodDesc.textContent = ui.lod.desc || "";
    }

    if (ui?.led) {
      if (ledItem) {
        const title = ledItem.querySelector(".label-title");
        const desc = ledItem.querySelector(".label-desc");
        const code = ledItem.querySelector(".label-code");
        if (title) title.textContent = ui.led.title || "";
        if (desc) desc.textContent = ui.led.desc || "";
        if (code) code.textContent = ui.led.code || "";
      }
    }

    if (lodItem) lodItem.style.display = features.hasPrimarySurfaceToggle ? "" : "none";
    if (ledItem) ledItem.style.display = features.hasPrimaryLedFeature ? "" : "none";
    if (b6Item) b6Item.style.display = features.hasSecondarySurfaceToggle ? "" : "none";
    if (rapooPollingCycle) rapooPollingCycle.style.display = features.hasKeyScanRate ? "block" : "none";

    const rapooSwitches = doc.getElementById("basicRapooSwitches");
    if (rapooSwitches) {
      rapooSwitches.style.display = (features.hasWirelessStrategy || features.hasCommProtocol) ? "" : "none";
    }

    const atkDpiLight = doc.getElementById("atkDpiLightCycle");
    const atkRxLight = doc.getElementById("atkReceiverLightCycle");
    const atkLongRange = doc.getElementById("atkLongRangeModeItem");

    if (atkDpiLight) atkDpiLight.style.display = features.hasAtkLights ? "block" : "none";
    if (atkRxLight) atkRxLight.style.display = features.hasAtkLights ? "block" : "none";
    if (atkLongRange) atkLongRange.style.display = features.hasLongRange ? "block" : "none";

    const sportItem = doc.querySelector('.basicItem[data-perf="sport"]');
    if (sportItem) sportItem.style.display = features.hideSportPerfMode ? "none" : "";

    const sleepSeconds = cfg?.power?.sleepSeconds;
    if (sleepSel && Array.isArray(sleepSeconds)) {
      applySelectOptions(sleepSel, sleepSeconds, (sec) => {
        return sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}m`;
      });

      if (sleepInput) {
        sleepInput.min = "0";
        sleepInput.max = String(Math.max(0, sleepSeconds.length - 1));
        sleepInput.step = "1";
      }
      const sleepCard = sleepInput?.closest(".slider-card");
      const sub = sleepCard?.querySelector(".slider-sub");
      if (sub) {
        const minS = sleepSeconds[0];
        const maxS = sleepSeconds[sleepSeconds.length - 1];
        const minT = minS < 60 ? `${minS}s` : `${minS / 60}min`;
        const maxT = maxS < 60 ? `${maxS}s` : `${maxS / 60}min`;
        sub.textContent = `范围：${minT} - ${maxT}`;
      }
    } else if (sleepSel) {
      restoreInnerHtml(sleepSel, "sleepSelect");
    }

    const debounceMs = cfg?.power?.debounceMs;
    if (debounceSel && Array.isArray(debounceMs)) {
      applySelectOptions(debounceSel, debounceMs, (ms) => String(ms));
      if (debounceInput) {
        debounceInput.min = "0";
        debounceInput.max = String(Math.max(0, debounceMs.length - 1));
        debounceInput.step = "1";
      }
      const debCard = debounceInput?.closest(".slider-card");
      const sub = debCard?.querySelector(".slider-sub");
      if (sub && debounceMs.length > 0) {
        sub.textContent = `范围：${debounceMs[0]}ms - ${debounceMs[debounceMs.length - 1]}ms`;
      }
    } else if (debounceSel) {
      restoreInnerHtml(debounceSel, "debounceSelect");
    }

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

    installAutoTrackInterval(doc);
  }

  window.DeviceUI = { applyVariant };
})();
