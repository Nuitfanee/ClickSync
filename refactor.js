
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
        dpi: {
          step: 50,
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
        dpi: {
          step: 10,
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
        dpi: {
          step: 10,
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
    if (x === "logitech") return "logitech";
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

  const normalizeDpiSlotArray = (raw) => {
    if (Array.isArray(raw)) {
      return raw
        .map((item) => toNumber(item))
        .filter((item) => Number.isFinite(item));
    }
    const single = toNumber(raw);
    if (Number.isFinite(single)) return [single];
    return undefined;
  };

  const normalizeDpiLodValue = (raw, fallback = undefined) => {
    const lod = String(raw || "").trim().toLowerCase();
    if (lod === "low") return "low";
    if (lod === "mid" || lod === "middle" || lod === "medium") return "mid";
    if (lod === "high") return "high";
    return fallback;
  };

  const normalizeDpiLodArray = (raw, { fallback = undefined } = {}) => {
    if (!Array.isArray(raw)) return undefined;
    const out = raw
      .map((item) => normalizeDpiLodValue(item, fallback))
      .filter((item) => item !== undefined);
    return out.length ? out : undefined;
  };

  const rapooTexts = window.AppConfig?.ranges?.rapoo?.texts || {};
  const atkTexts = window.AppConfig?.ranges?.atk?.texts || {};

  /**
   * 所有适配器共享的标准 Key 映射。
   * 目的：稳定语义槽位到固件 Key 的映射，
   * 支持数组以实现多 Key 回退/兼容。
   */
  const KEYMAP_COMMON = {
    pollingHz: ["pollingHz", "polling_rate", "pollingRateHz", "reportRateHz", "reportHz", "polling"],
    pollingWirelessHz: ["pollingWirelessHz", "polling_wireless_hz"],
    dpiSlots: ["dpiSlots", "dpi_slots"],
    dpiSlotsX: ["dpiSlotsX", "dpi_slots_x", "dpiSlots"],
    dpiSlotsY: ["dpiSlotsY", "dpi_slots_y", "dpiSlotsX", "dpiSlots"],
    dpiSlotCount: ["currentSlotCount", "dpiSlotCount"],
    activeDpiSlotIndex: ["currentDpiIndex", "activeDpiSlotIndex"],
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
    pollingWirelessHz: {
      write: (v) => toNumber(v),
      read: (raw) => readNumber(raw),
    },
    dpiSlots: {
      write: (v) => normalizeDpiSlotArray(v),
      read: (raw) => normalizeDpiSlotArray(raw),
    },
    dpiSlotsX: {
      write: (v) => normalizeDpiSlotArray(v),
      read: (raw) => normalizeDpiSlotArray(raw),
    },
    dpiSlotsY: {
      write: (v) => normalizeDpiSlotArray(v),
      read: (raw) => normalizeDpiSlotArray(raw),
    },
    dpiSlotCount: {
      write: (v) => toNumber(v),
      read: (raw) => readNumber(raw),
    },
    activeDpiSlotIndex: {
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

  const MAX_CONFIG_SLOT_COUNT = 5;

  const readEnabledConfigSlotCount = (raw, ctx) => {
    const directCount = toNumber(raw);
    if (Number.isFinite(directCount)) {
      return clamp(Math.round(directCount), 1, MAX_CONFIG_SLOT_COUNT);
    }

    const statesRaw = Array.isArray(raw)
      ? raw
      : (ctx?.cfg?.profileSlotStates ?? ctx?.state?.profileSlotStates);
    if (Array.isArray(statesRaw)) {
      const enabled = statesRaw
        .slice(0, MAX_CONFIG_SLOT_COUNT)
        .reduce((sum, flag) => (flag ? sum + 1 : sum), 0);
      if (enabled > 0) return clamp(enabled, 1, MAX_CONFIG_SLOT_COUNT);
    }

    const fallbackCount = toNumber(ctx?.cfg?.enabledProfileSlotCount ?? ctx?.state?.enabledProfileSlotCount);
    if (Number.isFinite(fallbackCount)) {
      return clamp(Math.round(fallbackCount), 1, MAX_CONFIG_SLOT_COUNT);
    }

    return 1;
  };

  const readActiveConfigSlotIndex = (raw, ctx) => {
    const idxRaw = raw ?? ctx?.cfg?.activeProfileSlotIndex ?? ctx?.state?.activeProfileSlotIndex;
    const idx = toNumber(idxRaw);
    if (!Number.isFinite(idx)) return undefined;
    const slotCount = readEnabledConfigSlotCount(undefined, ctx);
    return clamp(Math.round(idx), 0, Math.max(0, slotCount - 1));
  };

  const snapDpiByStep = (raw, min, max, step) => {
    const safeMin = Number.isFinite(Number(min)) ? Number(min) : 100;
    const safeMax = Number.isFinite(Number(max)) ? Number(max) : safeMin;
    const value = Number.isFinite(Number(raw)) ? Number(raw) : safeMin;
    const safeStep = Number.isFinite(Number(step)) && Number(step) > 0 ? Number(step) : 50;
    const clampedVal = clamp(value, safeMin, safeMax);
    const snapped = safeMin + Math.round((clampedVal - safeMin) / safeStep) * safeStep;
    return clamp(snapped, safeMin, safeMax);
  };

  const defaultDpiSnapper = ({ x, y, min, max, step }) => ({
    x: snapDpiByStep(x, min, max, step),
    y: snapDpiByStep(y, min, max, step),
  });

  const atkToU8 = (n) => clamp(Math.trunc(Number(n) || 0), 0, 0xff);
  const atkClampDpiRange = (value, min, max, fallback) => {
    const safeMin = clamp(Math.trunc(Number(min) || 1), 1, 60000);
    const safeMax = clamp(Math.trunc(Number(max) || safeMin), safeMin, 60000);
    const v = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : Math.trunc(Number(fallback) || safeMin);
    return clamp(v, safeMin, safeMax);
  };

  const decodeAtkDpiScalarLocal = (byte, modeByte) => {
    const b = atkToU8(byte);
    const m = atkToU8(modeByte);
    if (m === 0x22 || m === 0x66 || m === 0x33) {
      const step = m === 0x22 ? b : (m === 0x66 ? b + 256 : b + 401);
      return 10050 + step * 50;
    }
    const codeHigh = Math.round(m / 0x44);
    const code = (codeHigh << 8) | b;
    return (code + 1) * 10;
  };

  const encodeAtkDpiScalarLocal = (dpi, min, max) => {
    const d = atkClampDpiRange(dpi, min, max, min);
    if (d <= 10000) {
      const code = Math.floor(d / 10) - 1;
      return {
        byte: atkToU8(code),
        modeByte: atkToU8((code >> 8) * 0x44),
      };
    }
    const adjusted = Math.max(10050, d);
    const step = Math.floor((adjusted - 10050) / 50);
    if (step <= 255) return { byte: atkToU8(step), modeByte: 0x22 };
    if (step <= 400) return { byte: atkToU8(step - 256), modeByte: 0x66 };
    return { byte: atkToU8(step - 401), modeByte: 0x33 };
  };

  const quantizeAtkDpiByModeLocal = (target, modeByte, min, max) => {
    const safeMin = clamp(Math.trunc(Number(min) || 1), 1, 60000);
    const safeMax = clamp(Math.trunc(Number(max) || safeMin), safeMin, 60000);
    const wanted = atkClampDpiRange(target, safeMin, safeMax, safeMin);
    const mode = atkToU8(modeByte);
    if (mode === 0x22 || mode === 0x66 || mode === 0x33) {
      let step = Math.round((wanted - 10050) / 50);
      if (mode === 0x22) step = clamp(step, 0, 255);
      else if (mode === 0x66) step = clamp(step, 256, 400);
      else step = clamp(step, 401, 656);
      const byte = mode === 0x22 ? step : (mode === 0x66 ? step - 256 : step - 401);
      const dpi = clamp(10050 + step * 50, safeMin, safeMax);
      return { byte: atkToU8(byte), dpi };
    }
    const codeHigh = Math.round(mode / 0x44);
    const wantedCode = Math.round(wanted / 10) - 1;
    const low = clamp(wantedCode - (codeHigh << 8), 0, 0xff);
    const dpi = clamp(decodeAtkDpiScalarLocal(low, mode), safeMin, safeMax);
    return { byte: atkToU8(low), dpi };
  };

  const atkDpiSnapper = ({ x, y, min, max }) => {
    const safeMin = clamp(Math.trunc(Number(min) || 1), 1, 60000);
    const safeMax = clamp(Math.trunc(Number(max) || safeMin), safeMin, 60000);
    const xTarget = atkClampDpiRange(x, safeMin, safeMax, safeMin);
    const yTarget = atkClampDpiRange(y, safeMin, safeMax, xTarget);
    const seed = encodeAtkDpiScalarLocal(xTarget, safeMin, safeMax);
    const qx = clamp(decodeAtkDpiScalarLocal(seed.byte, seed.modeByte), safeMin, safeMax);
    const qy = quantizeAtkDpiByModeLocal(yTarget, seed.modeByte, safeMin, safeMax).dpi;
    return { x: qx, y: qy };
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
    dpiSnapper: defaultDpiSnapper,
    features: {
      hasPrimarySurfaceToggle: true,
      hasSecondarySurfaceToggle: false,
      hasPrimaryLedFeature: true,
      hasPerformanceMode: true,
      hasConfigSlots: false,
      hasDualPollingRates: false,
      hideBasicSynapse: false,
      hideBasicFooterSecondaryText: false,
      hasMotionSync: true,
      hasLinearCorrection: true,
      hasRippleControl: true,
      hasKeyScanRate: true,
      hasWirelessStrategy: true,
      hasCommProtocol: true,
      hasLongRange: false,
      hasAtkLights: false,
      hasDpiColors: false,
      hasDpiLods: false,
      hasDpiAdvancedAxis: true,
      showHeightViz: true,
      hideSportPerfMode: false,
      hasLogitechAdvancedPanel: false,
      hasOnboardMemoryMode: false,
      warnOnDisableOnboardMemoryMode: false,
      autoEnableOnboardMemoryOnConnect: false,
      hasLightforceSwitch: false,
      hasSurfaceMode: false,
      hasBhopDelay: false,
      supportsBatteryRequest: false,
      batteryPollMs: 120000,
      batteryPollTag: "2min",
      enterDelayMs: 0,
    },
  };

  const RapooProfile = {
    ...BaseRapooProfile,
    id: "rapoo",
    dpiSnapper: atkDpiSnapper,
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
    dpiSnapper: atkDpiSnapper,
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
    dpiSnapper: defaultDpiSnapper,
    features: {
      hasPrimarySurfaceToggle: true,
      hasSecondarySurfaceToggle: true,
      hasPrimaryLedFeature: true,
      hasPerformanceMode: true,
      hasConfigSlots: false,
      hasDualPollingRates: false,
      hideBasicSynapse: false,
      hideBasicFooterSecondaryText: false,
      hasMotionSync: true,
      hasLinearCorrection: true,
      hasRippleControl: true,
      hasKeyScanRate: false,
      hasWirelessStrategy: false,
      hasCommProtocol: false,
      hasLongRange: false,
      hasAtkLights: false,
      hasDpiColors: false,
      hasDpiAdvancedAxis: false,
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
  const LogitechProfile = {
    ...BaseRapooProfile,
    id: "logitech",
    ui: {
      ...BaseRapooProfile.ui,
      pollingThemeByWirelessHz: {
        125: "#065F46",
        250: "#00A86B",
        500: "#2563EB",
        1000: "#000000",
        2000: "#1E3A8A",
        4000: "#6B21A8",
        8000: "#4F46E5",
      },
      keymap: {
        imageSrc: "./image/GPW.png",
        variants: [
          {
            deviceNames: ["PRO X 2 DEX"],
            imageSrc: "./image/GPW_DEX.png",
            // 占位点位：后续可按实际示意图继续微调
            points: {
              1: { x: 32, y: 20, side: "left" },
              2: { x: 65, y: 38, side: "right" },
              3: { x: 49.3, y: 24, side: "right" },
              4: { x: 23, y: 36, side: "left" },
              5: { x: 25, y: 47, side: "left" },
              6: { x: 52, y: 70, side: "right" },
            },
          },
        ],
      },
      basicFooterTypography: {
        footerJustifyContent: "flex-start",
        footerAlignItems: "baseline",
        footerGap: "clamp(8px, 1.1vw, 14px)",
        footerPadding: "30px 40px 22px 200px",
        tickerFontSize: "clamp(14px, 1.2vw, 18px)",
        tickerFontWeight: "600",
        tickerOpacity: "0.7",
        tickerLineHeight: "1.24",
        tickerLetterSpacing: "0.008em",
        tickerGap: "clamp(12px, 1.4vw, 20px)",
        labelFontSize: "clamp(14px, 1.2vw, 18px)",
        labelFontWeight: "500",
        labelLetterSpacing: "0.008em",
      },
      onboardMemoryDisableConfirmText: "是否关闭板载内存模式，关闭后驱动设置不保证可用",
    },
    ranges: {
      ...(window.AppConfig?.ranges?.rapoo || {}),
      polling: {
        ...(window.AppConfig?.ranges?.rapoo?.polling || {}),
        wiredHz: [125, 250, 500, 1000],
        wirelessHz: [125, 250, 500, 1000, 2000, 4000, 8000],
      },
      dpi: {
        ...((window.AppConfig?.ranges?.rapoo?.dpi) || {}),
        step: 20,
      },
    },
    keyMap: {
      ...BaseRapooProfile.keyMap,
      performanceMode: null,
      pollingWirelessHz: "pollingWirelessHz",
      dpiLods: ["dpiLods", "dpi_lods", "lods"],
      configSlotCount: ["enabledProfileSlotCount", "profileSlotStates"],
      activeConfigSlotIndex: "activeProfileSlotIndex",
      onboardMemoryMode: "onboardMemoryMode",
      lightforceSwitch: "lightforceSwitch",
      surfaceMode: "surfaceMode",
      bhopMs: "bhopMs",
    },
    transforms: {
      ...BaseRapooProfile.transforms,
      dpiLods: {
        write: (v) => normalizeDpiLodArray(v),
        read: (raw) => normalizeDpiLodArray(raw, { fallback: "mid" }),
      },
      onboardMemoryMode: { write: (v) => !!v, read: readBool },
      lightforceSwitch: {
        write: (v) => {
          const mode = String(v || "").trim().toLowerCase();
          return mode === "hybrid" ? "hybrid" : "optical";
        },
        read: (raw) => {
          if (raw == null) return undefined;
          const mode = String(raw).trim().toLowerCase();
          return mode === "hybrid" ? "hybrid" : "optical";
        },
      },
      surfaceMode: {
        write: (v) => {
          const mode = String(v || "").trim().toLowerCase();
          if (mode === "on") return "on";
          if (mode === "off") return "off";
          return "auto";
        },
        read: (raw) => {
          if (raw == null) return undefined;
          const mode = String(raw).trim().toLowerCase();
          if (mode === "on") return "on";
          if (mode === "off") return "off";
          return "auto";
        },
      },
      bhopMs: {
        write: (v) => {
          const n = toNumber(v);
          if (!Number.isFinite(n)) return undefined;
          const clamped = clamp(Math.round(n), 0, 1000);
          return Math.round(clamped / 100) * 100;
        },
        read: (raw) => {
          const n = toNumber(raw);
          if (!Number.isFinite(n)) return undefined;
          return clamp(Math.round(n), 0, 1000);
        },
      },
      configSlotCount: {
        write: (v) => {
          const n = toNumber(v);
          if (!Number.isFinite(n)) return undefined;
          return clamp(Math.round(n), 1, MAX_CONFIG_SLOT_COUNT);
        },
        read: (raw, ctx) => readEnabledConfigSlotCount(raw, ctx),
      },
      activeConfigSlotIndex: {
        write: (v, ctx) => {
          const n = toNumber(v);
          if (!Number.isFinite(n)) return undefined;
          const slotCountRaw = toNumber(ctx?.payload?.configSlotCount);
          const slotCount = Number.isFinite(slotCountRaw)
            ? clamp(Math.round(slotCountRaw), 1, MAX_CONFIG_SLOT_COUNT)
            : MAX_CONFIG_SLOT_COUNT;
          return clamp(Math.round(n), 0, Math.max(0, slotCount - 1));
        },
        read: (raw, ctx) => readActiveConfigSlotIndex(raw, ctx),
      },
    },
    actions: {
      activeConfigSlotIndex: { method: "setActiveProfileSlot" },
      onboardMemoryMode: { method: "setOnboardMemoryMode" },
      lightforceSwitch: { method: "setLightforceSwitch" },
      surfaceMode: { method: "setSurfaceMode" },
      bhopMs: async ({ hidApi, value }) => {
        if (typeof hidApi?.setBatchFeatures !== "function") return;
        await hidApi.setBatchFeatures({ bhopMs: value });
      },
    },
    features: {
      ...BaseRapooProfile.features,
      hasPerformanceMode: false,
      hasConfigSlots: true,
      hasDualPollingRates: true,
      hideBasicSynapse: true,
      hideBasicFooterSecondaryText: true,
      hasDpiLods: true,
      keymapButtonCount: 5,
      hasMotionSync: false,
      hasLinearCorrection: false,
      hasRippleControl: false,
      hasPrimarySurfaceToggle: false,
      hasSecondarySurfaceToggle: false,
      hasPrimaryLedFeature: false,
      hasKeyScanRate: false,
      hasLogitechAdvancedPanel: true,
      hasOnboardMemoryMode: true,
      warnOnDisableOnboardMemoryMode: true,
      autoEnableOnboardMemoryOnConnect: true,
      hasLightforceSwitch: true,
      hasSurfaceMode: true,
      hasBhopDelay: true,
    },
  };

  const DEVICE_PROFILES = {
    chaos: ChaosProfile,
    rapoo: RapooProfile,
    atk: AtkProfile,
    logitech: LogitechProfile,
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
      actions: profile.actions || {},
      dpiSnapper: typeof profile.dpiSnapper === "function" ? profile.dpiSnapper : null,
      features: profile.features || {},
    };
  }

  const adapters = {
    chaos: createAdapter(DEVICE_PROFILES.chaos),
    rapoo: createAdapter(DEVICE_PROFILES.rapoo),
    atk: createAdapter(DEVICE_PROFILES.atk),
    logitech: createAdapter(DEVICE_PROFILES.logitech),
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

  function readStandardValue({ cfg, adapter, key }) {
    if (!cfg || !adapter || !key) return undefined;
    const st = cfg?.deviceState || cfg?.state || {};
    const keys = normalizeKeyList(adapter?.keyMap?.[key]);
    let raw;
    for (const k of keys) {
      if (st && Object.prototype.hasOwnProperty.call(st, k) && st[k] !== undefined) {
        raw = st[k];
        break;
      }
      if (Object.prototype.hasOwnProperty.call(cfg, k) && cfg[k] !== undefined) {
        raw = cfg[k];
        break;
      }
    }
    const transformer = adapter?.transforms?.[key];
    return transformer?.read ? transformer.read(raw, { cfg, state: st, adapter }) : raw;
  }


  /**
   * 将标准 Key 的补丁通过适配器写入固件空间。
   * 目的：将标准写入入口集中化，确保统一转换与审计。
   *
   * @param {Object} args
   * @param {Object} args.hidApi - WebHID 包装器（需提供 setFeature）。
   * @param {Object} args.adapter - 提供 keyMap/transforms 的适配器。
   * @param {Object} args.payload - UI 层标准 Key 补丁。
   * @returns {Promise<Object>} 写入结果元信息。
   */
  async function invokeAdapterAction({ hidApi, action, value, stdKey, payload, adapter }) {
    if (!hidApi || !action) return false;
    if (typeof action === "function") {
      await action({ hidApi, value, stdKey, payload, adapter });
      return true;
    }

    const methodName =
      typeof action === "string"
        ? action
        : (typeof action?.method === "string" ? action.method : "");
    if (!methodName) return false;
    const fn = hidApi?.[methodName];
    if (typeof fn !== "function") return false;

    const args = Array.isArray(action?.args) ? action.args : [value];
    await fn.apply(hidApi, args);
    return true;
  }

  async function writePatch({ hidApi, adapter, payload }) {
    const emptyResult = { writtenStdPatch: {}, mappedPatch: {} };
    if (!payload || typeof payload !== "object") return emptyResult;
    if (!hidApi) return emptyResult;
    if (!adapter) return emptyResult;

    const canSetFeature = typeof hidApi.setFeature === "function";

    const mappedPatch = {};
    const writtenStdPatch = {};
    for (const [stdKey, v] of Object.entries(payload)) {
      const transformer = adapter?.transforms?.[stdKey];
      const outVal = transformer?.write ? transformer.write(v, { payload, adapter }) : v;
      if (outVal === undefined) continue;

      const action = adapter?.actions?.[stdKey];
      if (action) {
        const handled = await invokeAdapterAction({
          hidApi,
          action,
          value: outVal,
          stdKey,
          payload,
          adapter,
        });
        if (handled) {
          writtenStdPatch[stdKey] = outVal;
          continue;
        }
      }

      const keys = normalizeKeyList(adapter?.keyMap?.[stdKey]);
      if (!keys.length || !canSetFeature) continue;
      mappedPatch[keys[0]] = outVal;
      writtenStdPatch[stdKey] = outVal;
    }

    for (const [k, v] of Object.entries(mappedPatch)) {
      await hidApi.setFeature(k, v);
    }
    return { writtenStdPatch, mappedPatch };
  }

  async function requestConfig({ hidApi }) {
    if (!hidApi) return false;
    const fn =
      hidApi.requestConfig ||
      hidApi.requestConfiguration ||
      hidApi.getConfig ||
      hidApi.readConfig ||
      hidApi.requestDeviceConfig;
    if (typeof fn !== "function") return false;
    await fn.call(hidApi);
    return true;
  }

  function getCachedConfig({ hidApi }) {
    if (!hidApi) return null;
    const getter =
      hidApi.getCachedConfig ||
      hidApi.getConfigSnapshot ||
      hidApi.peekConfig;
    if (typeof getter === "function") {
      try { return getter.call(hidApi) || null; } catch (_) { return null; }
    }
    return null;
  }

  window.DeviceWriter = { writePatch };
  window.DeviceReader = { requestConfig, getCachedConfig, readStandardValue };
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

  function ensureBasicFooterVariantStyle(docRef) {
    const hostDoc = docRef?.nodeType === 9 ? docRef : (docRef?.ownerDocument || document);
    if (!hostDoc || hostDoc.getElementById("basicFooterVariantStyle")) return;
    const styleEl = hostDoc.createElement("style");
    styleEl.id = "basicFooterVariantStyle";
    styleEl.textContent = `
#basicMonolith.basicFooterSingleDesc .basicFooter{
  justify-content: var(--basic-footer-justify-content, flex-start);
  align-items: var(--basic-footer-align-items, center);
  gap: var(--basic-footer-gap, 12px);
  padding: var(--basic-footer-padding, 34px 40px 26px 200px);
}
#basicMonolith.basicFooterSingleDesc #basicStatusText{
  display: none;
}
#basicMonolith.basicFooterSingleDesc .basicTicker{
  font-size: var(--basic-footer-ticker-size, clamp(24px, 2.6vw, 34px));
  font-weight: var(--basic-footer-ticker-weight, 500);
  opacity: var(--basic-footer-ticker-opacity, 1);
  line-height: var(--basic-footer-ticker-line-height, 1.08);
  letter-spacing: var(--basic-footer-ticker-letter-spacing, 0.02em);
  align-items: center;
  flex-wrap: wrap;
  column-gap: var(--basic-footer-ticker-gap, 10px);
  row-gap: 4px;
}
#basicMonolith.basicFooterSingleDesc .basicTicker .ticker-label{
  font-size: inherit;
  font-weight: inherit;
  line-height: inherit;
  letter-spacing: inherit;
  color: inherit;
  margin-right: 0;
  transform: none;
}
`;
    hostDoc.head?.appendChild(styleEl);
  }

  function applyBasicFooterVariant({ doc, ui, features }) {
    const basicMonolith = doc.getElementById("basicMonolith");
    const basicStatusText = doc.getElementById("basicStatusText");
    const hideSecondaryText = !!features.hideBasicFooterSecondaryText;

    if (basicStatusText) {
      if (basicStatusText.dataset.__orig_display == null) {
        basicStatusText.dataset.__orig_display = String(basicStatusText.style.display ?? "");
      }
      basicStatusText.style.display = hideSecondaryText
        ? "none"
        : (basicStatusText.dataset.__orig_display || "");
      basicStatusText.setAttribute("aria-hidden", hideSecondaryText ? "true" : "false");
    }

    if (!basicMonolith) return;
    ensureBasicFooterVariantStyle(doc);
    basicMonolith.classList.toggle("basicFooterSingleDesc", hideSecondaryText);

    const typography = (ui?.basicFooterTypography && typeof ui.basicFooterTypography === "object")
      ? ui.basicFooterTypography
      : {};
    const vars = {
      "--basic-footer-justify-content": typography.footerJustifyContent,
      "--basic-footer-align-items": typography.footerAlignItems,
      "--basic-footer-gap": typography.footerGap,
      "--basic-footer-padding": typography.footerPadding,
      "--basic-footer-ticker-size": typography.tickerFontSize,
      "--basic-footer-ticker-weight": typography.tickerFontWeight,
      "--basic-footer-ticker-opacity": typography.tickerOpacity,
      "--basic-footer-ticker-line-height": typography.tickerLineHeight,
      "--basic-footer-ticker-letter-spacing": typography.tickerLetterSpacing,
      "--basic-footer-ticker-gap": typography.tickerGap,
      "--basic-footer-label-size": typography.labelFontSize,
      "--basic-footer-label-weight": typography.labelFontWeight,
      "--basic-footer-label-spacing": typography.labelLetterSpacing,
    };

    Object.entries(vars).forEach(([name, value]) => {
      if (value == null || String(value).trim() === "") {
        basicMonolith.style.removeProperty(name);
        return;
      }
      basicMonolith.style.setProperty(name, String(value));
    });
  }

  /**
   * 安装滑轨刻度的自动对齐逻辑。
   * 目的：按范围/步长设置刻度节奏，保证可读性与反馈一致。
   *
   * @param {Document|HTMLElement} root - 作用域根节点。
   * @returns {void} 无返回值。
   */
  const normalizeDeviceDisplayName = (name) =>
    String(name || "").trim().replace(/\s+/g, " ").toUpperCase();

  function resolveKeymapVariant({ ui, deviceName }) {
    const keymapCfg = (ui?.keymap && typeof ui.keymap === "object") ? ui.keymap : {};
    const baseImageSrc = typeof keymapCfg.imageSrc === "string" ? keymapCfg.imageSrc : "";
    const basePoints = (keymapCfg.points && typeof keymapCfg.points === "object")
      ? keymapCfg.points
      : {};
    const normalizedName = normalizeDeviceDisplayName(deviceName);
    const variants = Array.isArray(keymapCfg.variants) ? keymapCfg.variants : [];
    const matched = variants.find((variant) => {
      if (!normalizedName) return false;
      const names = Array.isArray(variant?.deviceNames)
        ? variant.deviceNames
        : (variant?.deviceName ? [variant.deviceName] : []);
      return names.some((name) => normalizeDeviceDisplayName(name) === normalizedName);
    }) || null;
    if (!matched) {
      return {
        imageSrc: baseImageSrc,
        points: basePoints,
      };
    }
    const variantImageSrc = typeof matched.imageSrc === "string" ? matched.imageSrc : baseImageSrc;
    const variantPointsRaw = (matched.points && typeof matched.points === "object")
      ? matched.points
      : {};
    const mergedPoints = { ...basePoints };
    Object.entries(variantPointsRaw).forEach(([btnId, point]) => {
      if (!point || typeof point !== "object") return;
      const prev = (mergedPoints[btnId] && typeof mergedPoints[btnId] === "object")
        ? mergedPoints[btnId]
        : {};
      mergedPoints[btnId] = { ...prev, ...point };
    });
    return {
      imageSrc: variantImageSrc,
      points: mergedPoints,
    };
  }

  function applyKeymapVariant({ doc, ui, deviceName }) {
    const keymapScene = resolveKeymapVariant({ ui, deviceName });
    const img = doc.querySelector("#keys .kmImg");
    let changed = false;
    if (img) {
      if (img.dataset.__orig_src == null) {
        img.dataset.__orig_src = String(img.getAttribute("src") || "");
      }
      if (!img.dataset.__variant_load_hooked) {
        img.dataset.__variant_load_hooked = "1";
        img.addEventListener("load", () => {
          try { window.dispatchEvent(new Event("resize")); } catch (_) {}
        }, { passive: true });
      }
      const originalSrc = img.dataset.__orig_src || "";
      const nextSrc = String(keymapScene?.imageSrc || "").trim() || originalSrc;
      const curSrc = String(img.getAttribute("src") || "");
      if (nextSrc && curSrc !== nextSrc) {
        img.setAttribute("src", nextSrc);
        changed = true;
      }
    }

    const pointMap = (keymapScene?.points && typeof keymapScene.points === "object")
      ? keymapScene.points
      : {};
    const points = Array.from(doc.querySelectorAll("#keys .kmPoint"));
    points.forEach((point) => {
      if (point.dataset.__orig_x == null) {
        point.dataset.__orig_x = String(point.style.getPropertyValue("--x") || "");
      }
      if (point.dataset.__orig_y == null) {
        point.dataset.__orig_y = String(point.style.getPropertyValue("--y") || "");
      }
      if (point.dataset.__orig_side == null) {
        point.dataset.__orig_side = point.classList.contains("bubble-left")
          ? "left"
          : (point.classList.contains("bubble-right") ? "right" : "");
      }
      const btnId = String(point.getAttribute("data-btn") || "");
      const pointCfg = pointMap[btnId] || pointMap[Number(btnId)] || null;
      const x = Number(pointCfg?.x);
      const y = Number(pointCfg?.y);
      const side = String(pointCfg?.side || "").trim().toLowerCase();
      const nextX = Number.isFinite(x) ? String(x) : String(point.dataset.__orig_x || "");
      const nextY = Number.isFinite(y) ? String(y) : String(point.dataset.__orig_y || "");
      const prevX = String(point.style.getPropertyValue("--x") || "");
      const prevY = String(point.style.getPropertyValue("--y") || "");
      if (nextX) {
        if (prevX !== nextX) {
          point.style.setProperty("--x", nextX);
          changed = true;
        }
      } else if (prevX) {
        point.style.removeProperty("--x");
        changed = true;
      }
      if (nextY) {
        if (prevY !== nextY) {
          point.style.setProperty("--y", nextY);
          changed = true;
        }
      } else if (prevY) {
        point.style.removeProperty("--y");
        changed = true;
      }
      const nextSide = (side === "left" || side === "right")
        ? side
        : String(point.dataset.__orig_side || "");
      const prevSide = point.classList.contains("bubble-left")
        ? "left"
        : (point.classList.contains("bubble-right") ? "right" : "");
      if (prevSide !== nextSide) {
        point.classList.remove("bubble-left", "bubble-right");
        if (nextSide === "left" || nextSide === "right") {
          point.classList.add(`bubble-${nextSide}`);
        }
        changed = true;
      }
    });
    if (changed) {
      try { window.dispatchEvent(new Event("resize")); } catch (_) {}
    }
  }

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
  function applyVariant({ deviceId, adapter, root, deviceName = "", keymapOnly = false }) {
    const doc = root || document;
    const cfg = adapter?.ranges || window.AppConfig?.ranges?.chaos;
    const ui = adapter?.ui || {};
    const features = adapter?.features || {};
    if (keymapOnly) {
      applyKeymapVariant({ doc, ui, deviceName });
      return;
    }

    const landingLayer = doc.getElementById("landing-layer");
    const landingCaption = landingLayer?.querySelector(".caption");
    const verticalTitle = landingLayer?.querySelector(".vertical-title");
    if (verticalTitle && ui?.landingTitle) verticalTitle.textContent = ui.landingTitle;
    if (landingCaption && ui?.landingCaption) landingCaption.textContent = ui.landingCaption;

    const wiredPollingRates =
      (Array.isArray(cfg?.polling?.wiredHz) && cfg.polling.wiredHz.length)
        ? cfg.polling.wiredHz
        : (Array.isArray(cfg?.polling?.basicHz) && cfg.polling.basicHz.length ? cfg.polling.basicHz : null);
    const wirelessPollingRates =
      (Array.isArray(cfg?.polling?.wirelessHz) && cfg.polling.wirelessHz.length)
        ? cfg.polling.wirelessHz
        : (Array.isArray(cfg?.polling?.basicHz) && cfg.polling.basicHz.length ? cfg.polling.basicHz : wiredPollingRates);

    const pollingSelect = doc.getElementById("pollingSelect");
    const pollingWirelessSelect = doc.getElementById("pollingSelectWireless");
    if (pollingSelect) cacheInnerHtml(pollingSelect, "pollingSelect");
    if (pollingWirelessSelect) cacheInnerHtml(pollingWirelessSelect, "pollingSelectWireless");
    if (pollingSelect && Array.isArray(wiredPollingRates)) {
      applySelectOptions(pollingSelect, wiredPollingRates, (hz) => (hz >= 1000 ? `${hz / 1000}k` : String(hz)));
    } else if (pollingSelect) {
      restoreInnerHtml(pollingSelect, "pollingSelect");
    }
    if (pollingWirelessSelect && Array.isArray(wirelessPollingRates)) {
      applySelectOptions(pollingWirelessSelect, wirelessPollingRates, (hz) => (hz >= 1000 ? `${hz / 1000}k` : String(hz)));
    } else if (pollingWirelessSelect) {
      restoreInnerHtml(pollingWirelessSelect, "pollingSelectWireless");
    }

    const basicModeColumn = doc.getElementById("basicModeColumn");
    if (basicModeColumn) cacheInnerHtml(basicModeColumn, "basicModeColumn");
    if (basicModeColumn && features.hasDualPollingRates && Array.isArray(wirelessPollingRates)) {
      const rates = wirelessPollingRates.map(Number).filter(Number.isFinite);
      const selectedHz = Number(pollingWirelessSelect?.value ?? rates[0] ?? 1000);
      basicModeColumn.innerHTML = rates
        .map((hz) => {
          const active = String(hz) === String(selectedHz) ? " active" : "";
          return `<div class="basicItem${active}" role="button" tabindex="0" data-hz="${hz}">${hz} Hz<div class="basicAnchor"></div></div>`;
        })
        .join("");
    } else if (basicModeColumn) {
      restoreInnerHtml(basicModeColumn, "basicModeColumn");
    }

    const basicHzColumn = doc.getElementById("basicHzColumn");
    if (basicHzColumn) cacheInnerHtml(basicHzColumn, "basicHzColumn");
    if (basicHzColumn && Array.isArray(wiredPollingRates)) {
      const rates = wiredPollingRates.map(Number).filter(Number.isFinite);
      const selectedHz = Number(pollingSelect?.value ?? rates[0] ?? 1000);
      basicHzColumn.innerHTML = rates
        .map((hz) => {
          const active = String(hz) === String(selectedHz) ? " active" : "";
          return `<div class="basicItem${active}" role="button" tabindex="0" data-hz="${hz}"><div class="basicAnchor"></div> ${hz} Hz</div>`;
        })
        .join("");
    } else if (basicHzColumn) {
      restoreInnerHtml(basicHzColumn, "basicHzColumn");
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
    const dpiEditorHint = doc.querySelector("#dpi .card-dpi-editor .cardhead .sub");
    const ledItem = doc.getElementById("ledToggle")?.closest(".advShutterItem");
    const advancedPanel = doc.getElementById("advancedPanel");
    const advancedLegacyLeft = doc.getElementById("advancedLegacyLeft");
    const advancedLegacyRight = doc.getElementById("advancedLegacyRight");
    const advancedLogitechColumn = doc.getElementById("advancedLogitechColumn");

    const b6 = doc.getElementById("bit6");
    const b6Item = b6?.closest("label.advShutterItem");

    const rapooPollingCycle = doc.getElementById("rapooPollingCycle");
    const dpiAdvancedMeta = doc.getElementById("dpiAdvancedMeta");

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

    if (dpiEditorHint) {
      if (dpiEditorHint.dataset.__orig_text == null) {
        dpiEditorHint.dataset.__orig_text = String(dpiEditorHint.textContent ?? "");
      }
      const isLogitech = String(adapter?.id || deviceId || "").trim().toLowerCase() === "logitech";
      dpiEditorHint.textContent = isLogitech
        ? "光学引擎抬起距离"
        : "在下方面板直接拖动或输入修改DPI";
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

    const showLogitechAdvancedPanel = !!features.hasLogitechAdvancedPanel;
    if (advancedPanel) {
      advancedPanel.classList.toggle("is-logitech", showLogitechAdvancedPanel);
      advancedPanel.setAttribute("aria-hidden", "false");
    }
    if (advancedLegacyLeft) {
      advancedLegacyLeft.style.display = showLogitechAdvancedPanel ? "none" : "";
      advancedLegacyLeft.setAttribute("aria-hidden", showLogitechAdvancedPanel ? "true" : "false");
    }
    if (advancedLegacyRight) {
      advancedLegacyRight.style.display = showLogitechAdvancedPanel ? "none" : "";
      advancedLegacyRight.setAttribute("aria-hidden", showLogitechAdvancedPanel ? "true" : "false");
    }
    if (advancedLogitechColumn) {
      advancedLogitechColumn.style.display = showLogitechAdvancedPanel ? "" : "none";
      advancedLogitechColumn.setAttribute("aria-hidden", showLogitechAdvancedPanel ? "false" : "true");
    }

    if (lodItem) lodItem.style.display = features.hasPrimarySurfaceToggle ? "" : "none";
    if (ledItem) ledItem.style.display = features.hasPrimaryLedFeature ? "" : "none";
    if (b6Item) b6Item.style.display = features.hasSecondarySurfaceToggle ? "" : "none";
    if (rapooPollingCycle) rapooPollingCycle.style.display = features.hasKeyScanRate ? "block" : "none";
    if (dpiAdvancedMeta) {
      if (dpiAdvancedMeta.dataset.__orig_display == null) {
        dpiAdvancedMeta.dataset.__orig_display = String(dpiAdvancedMeta.style.display ?? "");
      }
      dpiAdvancedMeta.style.display = features.hasDpiAdvancedAxis
        ? (dpiAdvancedMeta.dataset.__orig_display || "")
        : "none";
    }

    const rapooSwitches = doc.getElementById("basicRapooSwitches");
    if (rapooSwitches) {
      rapooSwitches.style.display = (features.hasWirelessStrategy || features.hasCommProtocol) ? "" : "none";
    }

    const basicSynapseLayer = doc.getElementById("basicSynapseLayer");
    if (basicSynapseLayer) {
      if (basicSynapseLayer.dataset.__orig_display == null) {
        basicSynapseLayer.dataset.__orig_display = String(basicSynapseLayer.style.display ?? "");
      }
      basicSynapseLayer.style.display = features.hideBasicSynapse ? "none" : (basicSynapseLayer.dataset.__orig_display || "");
    }
    applyBasicFooterVariant({ doc, ui, features });

    const atkDpiLight = doc.getElementById("atkDpiLightCycle");
    const atkRxLight = doc.getElementById("atkReceiverLightCycle");
    const atkLongRange = doc.getElementById("atkLongRangeModeItem");

    if (atkDpiLight) atkDpiLight.style.display = features.hasAtkLights ? "block" : "none";
    if (atkRxLight) atkRxLight.style.display = features.hasAtkLights ? "block" : "none";
    if (atkLongRange) atkLongRange.style.display = features.hasLongRange ? "block" : "none";

    const keymapButtons = Array.from(doc.querySelectorAll('#keys .kmPoint'));
    const keymapBtnCount = Number(features.keymapButtonCount);
    if (Number.isFinite(keymapBtnCount)) {
      keymapButtons.forEach((p) => {
        if (!p.dataset.__orig_display) p.dataset.__orig_display = String(p.style.display ?? "");
        const btnId = Number(p.getAttribute("data-btn"));
        p.style.display = (Number.isFinite(btnId) && btnId > keymapBtnCount)
          ? "none"
          : (p.dataset.__orig_display || "");
      });
    } else if (keymapButtons.length) {
      keymapButtons.forEach((p) => {
        if (p.dataset.__orig_display != null) {
          p.style.display = p.dataset.__orig_display || "";
        }
      });
    }
    applyKeymapVariant({ doc, ui, deviceName });

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
