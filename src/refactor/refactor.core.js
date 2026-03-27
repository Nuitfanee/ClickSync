/**
 * refactor.core.js: protocol-neutral standard-key core.
 *
 * Responsibilities:
 * - Define shared AppConfig ranges/timings/utilities.
 * - Provide common key maps/transforms helpers.
 * - Expose DeviceReader/DeviceWriter standard interfaces.
 *
 * Architecture layering:
 * - refactor.core.js: standard-key contracts and shared utilities.
 * - refactor.profiles.js: per-device overrides (keyMap/transforms/actions/features/ui).
 * - refactor.ui.js: rendering and layout orchestration only.
 * - app.js: runtime binding, connection choreography, write queue.
 *
 * Standard-key contract:
 * - UI and app.js read/write only stdKeys.
 * - Profiles map stdKeys to protocol fields and optional actions.
 * - DeviceWriter first applies transform/action, then keyMap + setFeature fallback.
 *
 * Adding a new standard key:
 * 1) Add key to KEYMAP_COMMON only if broadly shared; otherwise add in profile override.
 * 2) Add transform in TRANSFORMS_COMMON or per-profile transforms.
 * 3) Bind UI in app.js via enqueueDevicePatch({ stdKey: value }).
 * 4) Add readback setter in applyConfigToUi().
 * 5) Add semantic DOM + refactor.ui rendering only when UI structure changes.
 *
 * Invariants:
 * - transform.read returning undefined means do not override current UI state.
 * - Writer/Reader must stay protocol-agnostic; no DOM operations here.
 */

// ============================================================
// Shared DPI Step Segments
// ============================================================
const ATK_DPI_STEP_SEGMENTS = [
  { min: 50, max: 10000, step: 10 },
  { min: 10000, max: 30000, step: 50 },
  { min: 30000, max: 42000, step: 100 },
];

const LOGITECH_DPI_STEP_SEGMENTS = Object.freeze([
  { min: 100, max: 200, step: 1 },
  { min: 200, max: 500, step: 2 },
  { min: 500, max: 1000, step: 5 },
  { min: 1000, max: 2000, step: 10 },
  { min: 2000, max: 5000, step: 20 },
  { min: 5000, max: 10000, step: 50 },
  { min: 10000, max: 20000, step: 100 },
  { min: 20000, max: 32000, step: 125 },
  { min: 32000, max: 44000, step: 200 },
]);

// ============================================================
// 1) AppConfig: shared ranges, timings, and text metadata
// ============================================================
(function () {
  /**
   * Clamp a numeric value to a target range.
   * Purpose: keep write parameters inside device-allowed bounds.
   *
   * @param {number} n - Value to process.
   * @param {number} min - Lower bound.
   * @param {number} max - Upper bound.
   * @returns {number} Clamped value.
   */
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  /**
   * Build select-option HTML string.
   * Purpose: centralize option template generation and reduce inconsistent inline markup.
   *
   * @param {Array<number|string>} values - Candidate value list.
   * @param {(value: number|string) => string} label - Label builder.
   * @returns {string} HTML fragment.
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
            low:   { color: "#00A86B", text: "均衡模式，游戏娱乐，开心无虑" },
            hp:    { color: "#000000", text: "火力模式，电竞游戏，轻松拿捏" },
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
          stepSegments: ATK_DPI_STEP_SEGMENTS,
          policy: {
            mode: "segmented",
            step: 10,
            stepSegments: ATK_DPI_STEP_SEGMENTS,
          },
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
          advancedCycleStateMeta: {
            receiverLightEffect: {
              region: "dual-right",
              values: {
                1: {
                  desc: "当鼠标连接到接收器时按照不同回报率对应的颜色点亮",
                },
                2: {
                  desc: "电池状态：绿色100%，黄色75%，红色15%。",
                },
                3: {
                  desc: "电池警告（始终保持熄灭，仅在鼠标低电量时红色闪烁）",
                },
              },
            },
          },


          perfMode: {
            low:   { color: "#00A86B", text: "基础模式,续航长,适合日常办公" },
            hp:    { color: "#000000", text: "绝鲨竞技固件,扫描频率高,操控更跟手" },
            sport: { color: "#FF4500", text: "绝鲨竞技固件 " },
            oc:    { color: "#4F46E5", text: "绝鲨竞技固件MAX,静态扫描帧率≥20000,延迟进一步降低,移动轨迹更精准" },
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
      ninjutso: {
        power: {
          sleepSeconds: Array.from({ length: 15 }, (_, i) => (i + 1) * 60),
          debounceMs: [2, 5, 10],
        },
        sensor: {
          angleDeg: { min: 25, max: 100, step: 25, hint: "Range 25 - 100", name: "灯光亮度", sub: "Range 25 - 100", unit: "%" },
          feel: { min: 0, max: 20, step: 1, unit: "", name: "灯效速度", sub: "Range 0 - 20" },
        },
        dpi: {
          step: 1,
        },
        polling: {
          basicHz: [1000, 2000, 4000, 8000],
          advHz: [1000, 2000, 4000, 8000],
        },
        texts: {
          landingTitle: "NINJUTSO",
          landingCaption: "stare into the void to connect (NINJUTSO)",
          lod: { code: "005 // Burst", title: "Burst 模式", desc: "burst 模式微调更准，功耗更高" },
          led: { code: "006 // Hyper Click", title: "Hyper Click", desc: "可降低按键延迟" },
          ledMaster: { code: "007 // LED Master", title: "灯光开关", desc: "Enable LED related controls" },
          perfMode: {
            hp: { color: "#000000", text: "高速模式" },
            sport: { color: "#FF4500", text: "竞技模式" },
            oc: { color: "#4F46E5", text: "竞技+模式" },
          },
          lightCycles: {
            dpi: { code: "008 // MARA Mode", title: "灯效模式", desc: "点击切换常亮与跑马模式" },
          },
          staticLedColor: { code: "009 // Static Color", title: "常亮颜色", desc: "点击选择常亮模式颜色" },
      advancedSectionHeaders: {
        power: "01 // 休眠和防误触",
        sensor: "02 // LED灯效参数",
      },
          lights: {
            dpi: [
              { val: 0, label: "Static", cls: "atk-mode-0" },
              { val: 1, label: "MARA", cls: "atk-mode-1" },
            ],
            receiver: [
              { val: 25, label: "25%", cls: "atk-mode-0" },
              { val: 50, label: "50%", cls: "atk-mode-1" },
              { val: 75, label: "75%", cls: "atk-mode-2" },
              { val: 100, label: "100%", cls: "atk-mode-3" },
            ],
          },
        },
      },
      razer: {
        power: {
          sleepSeconds: Array.from({ length: 15 }, (_, i) => (i + 1) * 60),

          debounceMs: null,
          lowPowerThresholdPercent: { min: 5, max: 100, step: 5 },
        },
        sensor: {
          angleDeg: { min: -44, max: 44, step: 1, hint: "范围 -44° ~ 44°" },
          smartTrackingLevel: { min: 0, max: 2, step: 1, hint: "范围 0 - 2" },
          smartTrackingLiftDistance: { min: 2, max: 26, step: 1, hint: "范围 2 - 26" },
          smartTrackingLandingDistance: { min: 1, max: 25, step: 1, hint: "范围 1 - 25" },
        },
        dynamicSensitivity: {
          modes: [0, 1, 2],
        },
        dpi: {
          step: 1,
          policy: {
            mode: "fixed",
            step: 1,
          },
        },
        polling: {
          basicHz: [125, 250, 500, 1000, 2000, 4000, 8000],
          advHz: [125, 250, 500, 1000, 2000, 4000, 8000],
        },
        texts: {
          perfMode: {
            hyperspeed: { color: "#44d62c", text: "HYPERSPEED" },
          },
          smartTrackingLevelLabels: {
            "0": "低",
            "1": "中",
            "2": "高",
          },
          smartTrackingLevelHint: "对称模式档位 低 / 中 / 高",
          lowPowerThresholdLockedHint: "回报率达到 2000Hz 及以上时，该功能不启用且无法修改",
          advancedCycleStateMeta: {
            hyperpollingIndicator: {
              region: "single",
              values: {
                1: {
                  desc: "只有当设备接到接收器时才会点亮并保持白色常亮",
                },
                2: {
                  desc: "根据设备当前的电池电量，从绿色(100%)、黄色(66%)、橙色(33%)和红色(0%)逐渐变化。",
                },
                3: {
                  desc: "始终保持熄灭，仅在设备需要充电时闪烁红色",
                },
              },
            },
          },
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
// 2) Core Runtime: tools / transforms / read-write
// ============================================================
(function () {
  // ============================================================
  // Base Utilities
  // ============================================================
  const clamp = window.AppConfig?.utils?.clamp || ((n, min, max) => Math.min(max, Math.max(min, n)));

  /**
   * Normalize device ID.
   * Purpose: unify the device-ID entrypoint and avoid alias-driven branching/drift.
   *
   * @param {string} id - Device identifier.
   * @returns {string} Normalized device identifier.
   */
  const DEFAULT_DEVICE_ID = String(window.DeviceRuntime?.DEFAULT_DEVICE_ID || "chaos").trim().toLowerCase() || "chaos";
  const VALID_DEVICE_IDS = Object.freeze(
    (Array.isArray(window.DeviceRuntime?.VALID_DEVICE_IDS) && window.DeviceRuntime.VALID_DEVICE_IDS.length
      ? window.DeviceRuntime.VALID_DEVICE_IDS
      : [DEFAULT_DEVICE_ID, "rapoo", "atk", "ninjutso", "logitech", "razer"])
      .map((deviceId) => String(deviceId || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const VALID_DEVICE_ID_SET = new Set(VALID_DEVICE_IDS);

  const normalizeDeviceId = (id) => {
    const runtimeNormalize = window.DeviceRuntime?.normalizeDeviceId;
    if (typeof runtimeNormalize === "function") {
      const normalized = String(runtimeNormalize(id) || "").trim().toLowerCase();
      return normalized || DEFAULT_DEVICE_ID;
    }
    const x = String(id || "").trim().toLowerCase();
    return VALID_DEVICE_ID_SET.has(x) ? x : DEFAULT_DEVICE_ID;
  };

  /**
   * Safely convert input to number.
   * Purpose: filter NaN/invalid values before protocol-layer consumption.
   *
   * @param {unknown} v - Value to convert.
   * @returns {number|undefined} Valid number or undefined.
   */
  const toNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  /**
   * Safely convert input to boolean.
   * Purpose: normalize boolean mapping consistently for 0/1 and true/false.
   *
   * @param {unknown} raw - Raw value.
   * @returns {boolean|undefined} Boolean value or undefined.
   */
  const readBool = (raw) => (raw == null ? undefined : !!raw);

  /**
   * Safely convert input to number (read path).
   * Purpose: filter invalid readback values to avoid propagating null/undefined into UI.
   *
   * @param {unknown} raw - Raw value.
   * @returns {number|undefined} Valid number or undefined.
   */
  const readNumber = (raw) => (raw == null ? undefined : toNumber(raw));

  // ============================================================
  // Normalization
  // ============================================================
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

  const normalizeButtonMappingPatch = (raw, { maxButtons = 6 } = {}) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const capRaw = toNumber(maxButtons);
    const cap = Number.isFinite(capRaw) ? Math.max(1, Math.round(capRaw)) : 6;
    const out = {};
    for (const [rawBtn, action] of Object.entries(raw)) {
      const btnRaw = Number(rawBtn);
      if (!Number.isFinite(btnRaw)) continue;
      const btn = Math.trunc(btnRaw);
      if (btn < 1 || btn > cap) continue;
      if (typeof action === "string") {
        out[btn] = action;
        continue;
      }
      if (action && typeof action === "object" && !Array.isArray(action)) {
        out[btn] = action;
      }
    }
    return Object.keys(out).length ? out : undefined;
  };

  // ============================================================
  // DPI / Stage Transforms
  // ============================================================
  const snapDpiByStep = (raw, min, max, step) => {
    const safeMin = Number.isFinite(Number(min)) ? Number(min) : 100;
    const safeMax = Number.isFinite(Number(max)) ? Number(max) : safeMin;
    const value = Number.isFinite(Number(raw)) ? Number(raw) : safeMin;
    const safeStep = Number.isFinite(Number(step)) && Number(step) > 0 ? Number(step) : 50;
    const clampedVal = clamp(value, safeMin, safeMax);
    const snapped = safeMin + Math.round((clampedVal - safeMin) / safeStep) * safeStep;
    return clamp(snapped, safeMin, safeMax);
  };

  const snapDpiBySegments = (raw, min, max, segments, fallbackStep = 50) => {
    const safeMin = Number.isFinite(Number(min)) ? Number(min) : 100;
    const safeMax = Number.isFinite(Number(max)) ? Number(max) : safeMin;
    const value = Number.isFinite(Number(raw)) ? Number(raw) : safeMin;
    const clampedVal = clamp(value, safeMin, safeMax);
    const rules = Array.isArray(segments) ? segments : [];

    for (const seg of rules) {
      const segMinRaw = Number(seg?.min);
      const segMaxRaw = Number(seg?.max);
      const segStepRaw = Number(seg?.step);
      if (!Number.isFinite(segMinRaw) || !Number.isFinite(segMaxRaw) || !Number.isFinite(segStepRaw) || segStepRaw <= 0) {
        continue;
      }
      const segMin = clamp(segMinRaw, safeMin, safeMax);
      const segMax = clamp(segMaxRaw, segMin, safeMax);
      if (clampedVal < segMin || clampedVal > segMax) continue;
      const snapped = segMin + Math.round((clampedVal - segMin) / segStepRaw) * segStepRaw;
      return clamp(snapped, segMin, segMax);
    }

    return snapDpiByStep(clampedVal, safeMin, safeMax, fallbackStep);
  };

  const defaultDpiSnapper = ({ x, y, min, max, step, stepSegments, dpiPolicy }) => {
    const policy = (dpiPolicy && typeof dpiPolicy === "object") ? dpiPolicy : {};
    const mode = String(policy.mode || "").trim().toLowerCase();
    const segs = Array.isArray(policy.stepSegments) ? policy.stepSegments : stepSegments;
    const baseStep = Number.isFinite(Number(policy.step)) ? Number(policy.step) : step;
    const useSegments = mode !== "fixed" && Array.isArray(segs) && segs.length > 0;
    if (!useSegments) {
      return {
        x: snapDpiByStep(x, min, max, baseStep),
        y: snapDpiByStep(y, min, max, baseStep),
      };
    }
    return {
      x: snapDpiBySegments(x, min, max, segs, baseStep),
      y: snapDpiBySegments(y, min, max, segs, baseStep),
    };
  };

  const RAZER_MAX_DPI_STAGES = 5;

  const clampRazerStageCount = (raw, fallback = 1) => {
    const n = Number(raw);
    const safe = Number.isFinite(n) ? Math.round(n) : Number(fallback);
    return clamp(safe, 1, RAZER_MAX_DPI_STAGES);
  };

  const readRazerStages = (raw) => {
    if (!Array.isArray(raw)) return undefined;
    const out = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const xRaw = toNumber(item?.x ?? item?.X ?? item?.dpiX ?? item?.dpi_x);
      const yRaw = toNumber(item?.y ?? item?.Y ?? item?.dpiY ?? item?.dpi_y ?? xRaw);
      if (!Number.isFinite(xRaw) && !Number.isFinite(yRaw)) continue;
      const x = Number.isFinite(xRaw) ? Math.max(1, Math.round(xRaw)) : Math.max(1, Math.round(yRaw));
      const y = Number.isFinite(yRaw) ? Math.max(1, Math.round(yRaw)) : x;
      out.push({ x, y });
    }
    return out.length ? out : undefined;
  };

  const stagesToDpiSlotsX = (raw) => {
    const stages = readRazerStages(raw);
    if (!stages) return undefined;
    const out = stages.map((stage) => stage.x);
    while (out.length < RAZER_MAX_DPI_STAGES) out.push(800);
    if (out.length > RAZER_MAX_DPI_STAGES) out.length = RAZER_MAX_DPI_STAGES;
    return out;
  };

  const stagesToDpiSlotsY = (raw) => {
    const stages = readRazerStages(raw);
    if (!stages) return undefined;
    const out = stages.map((stage) => stage.y);
    while (out.length < RAZER_MAX_DPI_STAGES) out.push(800);
    if (out.length > RAZER_MAX_DPI_STAGES) out.length = RAZER_MAX_DPI_STAGES;
    return out;
  };

  const stagesToDpiSlots = (raw) => {
    const stages = readRazerStages(raw);
    if (!stages) return undefined;
    const out = stages.map((stage) => stage.x);
    while (out.length < RAZER_MAX_DPI_STAGES) out.push(800);
    if (out.length > RAZER_MAX_DPI_STAGES) out.length = RAZER_MAX_DPI_STAGES;
    return out;
  };

  const stagesToSlotCount = (raw) => {
    const stages = readRazerStages(raw);
    return stages ? stages.length : undefined;
  };

  const NINJUTSO_LED_BRIGHTNESS_LEVELS = [25, 50, 75, 100];
  const nearestFromList = (raw, list, fallback = list?.[0]) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Array.isArray(list) || !list.length) return fallback;
    return list.reduce((best, cur) => (Math.abs(cur - n) < Math.abs(best - n) ? cur : best), list[0]);
  };
  const toNinjutsoLedMode = (value) => {
    const s = String(value || "").trim().toLowerCase();
    if (s === "marquee") return "marquee";
    if (s === "static") return "static";
    return Number(value) === 1 ? "marquee" : "static";
  };
  const fromNinjutsoLedMode = (raw) => (toNinjutsoLedMode(raw) === "marquee" ? 1 : 0);
  const toNinjutsoLedBrightness = (value) => nearestFromList(value, NINJUTSO_LED_BRIGHTNESS_LEVELS, 100);
  const fromNinjutsoLedBrightness = (raw) => nearestFromList(raw, NINJUTSO_LED_BRIGHTNESS_LEVELS, 100);
  const normalizeHexColor = (raw, fallback = "#11119A") => {
    const fb = String(fallback || "#11119A").trim().toUpperCase();
    let s = String(raw == null ? "" : raw).trim().toUpperCase();
    if (!s) return fb;
    if (!s.startsWith("#")) s = `#${s}`;
    return /^#[0-9A-F]{6}$/.test(s) ? s : fb;
  };

  // ============================================================
  // Compatibility Fallbacks
  // ============================================================
  const MAX_CONFIG_SLOT_COUNT = 5;

  /**
   * Compatibility fallback for reading surface-feel level.
   * Purpose: infer from legacy fields when direct field is missing.
   *
   * @param {unknown} raw - Direct raw read value.
   * @param {Object} ctx - Context (contains cfg).
   * @returns {number|undefined} Normalized level.
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

  // ============================================================
  // Shared Mapping
  // ============================================================
  const rapooTexts = window.AppConfig?.ranges?.rapoo?.texts || {};
  const atkTexts = window.AppConfig?.ranges?.atk?.texts || {};
  const ninjutsoTexts = window.AppConfig?.ranges?.ninjutso?.texts || {};
  const razerTexts = window.AppConfig?.ranges?.razer?.texts || {};

  /**
   * Shared standard-key mapping across all adapters.
   * Purpose: stabilize semantic-slot to firmware-key mapping
   * and support array-based multi-key fallback/compatibility.
   */
  const KEYMAP_COMMON = {
    pollingHz: ["pollingHz", "polling_rate"],
    pollingWirelessHz: "pollingWirelessHz",
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
   * Shared value transformers (single-semantic normalization).
   * Purpose: centralize conversion between human-readable units and protocol encoding.
   * Protocol layer commonly requires bytes/bitfields/enums.
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
    buttonMappingPatch: {
      write: (v, ctx) => {
        const capRaw = toNumber(ctx?.adapter?.features?.keymapButtonCount);
        const maxButtons = Number.isFinite(capRaw) ? Math.max(1, Math.round(capRaw)) : 6;
        return normalizeButtonMappingPatch(v, { maxButtons });
      },
    },
  };

  // ============================================================
  // Read / Write Chain
  // ============================================================
  /**
   * Normalize keyMap mapping value into an array.
   * Purpose: unify single/multi-key mapping shape for simpler read/write flow.
   *
   * @param {string|string[]|null|undefined} mapVal - Mapping value.
   * @returns {string[]} Normalized key list.
   */
  const normalizeKeyList = (mapVal) => {
    if (!mapVal) return [];
    if (Array.isArray(mapVal)) return mapVal.filter(Boolean);
    return [mapVal];
  };

  /**
   * Read one standard key from raw config by adapter profile contract.
   *
   * Read order:
   * 1) Resolve protocol key list via adapter.keyMap[stdKey].
   * 2) Probe cfg.deviceState/state first, then top-level cfg fallback.
   * 3) Apply adapter.transforms[stdKey].read(raw, ctx) when defined.
   *
   * Returning undefined from transform.read means value not available / keep UI state.
   */
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
   * Write a standard-key patch into firmware space through adapter mapping.
   * Purpose: centralize the write entrypoint for consistent conversion and auditability.
   *
   * @param {Object} args
   * @param {Object} args.hidApi - WebHID wrapper (must expose setFeature).
   * @param {Object} args.adapter - Adapter providing keyMap/transforms.
   * @param {Object} args.payload - UI-layer standard-key patch.
   * @returns {Promise<Object>} Write-result metadata.
   */
  async function invokeAdapterAction({ hidApi, action, value, stdKey, payload, adapter }) {
    if (!hidApi || !action) return false;
    if (typeof action === "function") {
      await action({ hidApi, value, stdKey, payload, adapter });
      return true;
    }

    const methodName = typeof action?.method === "string" ? action.method : "";
    if (!methodName) return false;
    const fn = hidApi?.[methodName];
    if (typeof fn !== "function") return false;

    await fn.call(hidApi, value);
    return true;
  }

  /**
   * Write a standard-key patch to protocol layer.
   *
   * Write order per stdKey:
   * 1) transform.write(value, ctx)
   * 2) adapter action (if declared)
   * 3) keyMap + hidApi.setFeature fallback
   *
   * This keeps app.js protocol-agnostic and allows device-unique writes to live in profiles.
   */
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

  // Reader facade for app.js. Runtime bootstrap/read strategy still belongs to protocol_api_*.
  async function requestConfig({ hidApi }) {
    if (!hidApi) return false;
    const fn = hidApi.requestConfig;
    if (typeof fn !== "function") return false;
    await fn.call(hidApi);
    return true;
  }

  // Optional cached config read used by app.js to avoid null-state flicker on reconnect.
  function getCachedConfig({ hidApi }) {
    if (!hidApi) return null;
    const getter = hidApi.getCachedConfig;
    if (typeof getter === "function") {
      try { return getter.call(hidApi) || null; } catch (_) { return null; }
    }
    return null;
  }

  const ADVANCED_PANEL_REGIONS = Object.freeze(["dual-left", "dual-right", "single"]);
  const ADVANCED_PANEL_REGION_SET = new Set(ADVANCED_PANEL_REGIONS);
  const ADVANCED_PANEL_RULE_DEFAULTS = Object.freeze({
    sleepSeconds: Object.freeze({ regions: Object.freeze(["dual-left", "single"]), requiresFeatures: Object.freeze([]), requiresCapabilities: Object.freeze([]) }),
    debounceMs: Object.freeze({ regions: Object.freeze(["dual-left"]), requiresFeatures: Object.freeze([]), requiresCapabilities: Object.freeze([]) }),
    sensorAngle: Object.freeze({ regions: Object.freeze(["dual-left", "single"]), requiresFeatures: Object.freeze(["hasSensorAngle"]), requiresCapabilities: Object.freeze([]) }),
    surfaceFeel: Object.freeze({ regions: Object.freeze(["dual-left"]), requiresFeatures: Object.freeze(["hasSurfaceFeel"]), requiresCapabilities: Object.freeze([]) }),
    motionSync: Object.freeze({ regions: Object.freeze(["dual-right"]), requiresFeatures: Object.freeze(["hasMotionSync"]), requiresCapabilities: Object.freeze([]) }),
    linearCorrection: Object.freeze({ regions: Object.freeze(["dual-right"]), requiresFeatures: Object.freeze(["hasLinearCorrection"]), requiresCapabilities: Object.freeze([]) }),
    rippleControl: Object.freeze({ regions: Object.freeze(["dual-right"]), requiresFeatures: Object.freeze(["hasRippleControl"]), requiresCapabilities: Object.freeze([]) }),
    secondarySurfaceToggle: Object.freeze({ regions: Object.freeze(["dual-right"]), requiresFeatures: Object.freeze(["hasSecondarySurfaceToggle"]), requiresCapabilities: Object.freeze([]) }),
    keyScanningRate: Object.freeze({ regions: Object.freeze(["dual-right"]), requiresFeatures: Object.freeze(["hasKeyScanRate"]), requiresCapabilities: Object.freeze([]) }),
    surfaceModePrimary: Object.freeze({ regions: Object.freeze(["dual-right"]), requiresFeatures: Object.freeze(["hasPrimarySurfaceToggle"]), requiresCapabilities: Object.freeze([]) }),
    primaryLedFeature: Object.freeze({ regions: Object.freeze(["dual-right"]), requiresFeatures: Object.freeze(["hasPrimaryLedFeature"]), requiresCapabilities: Object.freeze([]) }),
    dpiLightEffect: Object.freeze({ regions: Object.freeze(["dual-right"]), requiresFeatures: Object.freeze(["hasDpiLightCycle"]), requiresCapabilities: Object.freeze([]) }),
    receiverLightEffect: Object.freeze({ regions: Object.freeze(["dual-right"]), requiresFeatures: Object.freeze(["hasReceiverLightCycle"]), requiresCapabilities: Object.freeze([]) }),
    longRangeMode: Object.freeze({ regions: Object.freeze(["dual-right"]), requiresFeatures: Object.freeze(["hasLongRange"]), requiresCapabilities: Object.freeze([]) }),
    onboardMemory: Object.freeze({ regions: Object.freeze(["single"]), requiresFeatures: Object.freeze(["hasOnboardMemoryMode"]), requiresCapabilities: Object.freeze([]) }),
    lightforceSwitch: Object.freeze({ regions: Object.freeze(["single"]), requiresFeatures: Object.freeze(["hasLightforceSwitch"]), requiresCapabilities: Object.freeze([]) }),
    surfaceMode: Object.freeze({ regions: Object.freeze(["single"]), requiresFeatures: Object.freeze(["hasSurfaceMode"]), requiresCapabilities: Object.freeze([]) }),
    bhopToggle: Object.freeze({ regions: Object.freeze(["single"]), requiresFeatures: Object.freeze(["hasBhopDelay"]), requiresCapabilities: Object.freeze([]) }),
    bhopDelay: Object.freeze({ regions: Object.freeze(["single"]), requiresFeatures: Object.freeze(["hasBhopDelay"]), requiresCapabilities: Object.freeze([]) }),
    dynamicSensitivityComposite: Object.freeze({ regions: Object.freeze(["single"]), requiresFeatures: Object.freeze([]), requiresCapabilities: Object.freeze([]) }),
    smartTrackingComposite: Object.freeze({ regions: Object.freeze(["single"]), requiresFeatures: Object.freeze([]), requiresCapabilities: Object.freeze([]) }),
    lowPowerThresholdPercent: Object.freeze({ regions: Object.freeze(["single"]), requiresFeatures: Object.freeze([]), requiresCapabilities: Object.freeze([]) }),
    hyperpollingIndicator: Object.freeze({ regions: Object.freeze(["single"]), requiresFeatures: Object.freeze([]), requiresCapabilities: Object.freeze([]) }),
  });

  function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function normalizeAdvancedPanelKeyList(raw) {
    if (!Array.isArray(raw)) return Object.freeze([]);
    return Object.freeze(raw.map((value) => String(value || "").trim()).filter(Boolean));
  }

  function normalizeAdvancedPanelRegions(raw) {
    const next = Array.isArray(raw)
      ? raw.map((value) => String(value || "").trim().toLowerCase()).filter((value) => ADVANCED_PANEL_REGION_SET.has(value))
      : [];
    return Object.freeze(next);
  }

  function normalizeAdvancedPanelRule(itemKey, baseRule, overrideRule) {
    const base = isPlainObject(baseRule) ? baseRule : {};
    const override = isPlainObject(overrideRule) ? overrideRule : {};
    const enabled = Object.prototype.hasOwnProperty.call(override, "enabled")
      ? override.enabled
      : base.enabled;
    const regions = normalizeAdvancedPanelRegions(
      Object.prototype.hasOwnProperty.call(override, "regions") ? override.regions : base.regions
    );
    const requiresFeatures = normalizeAdvancedPanelKeyList(
      Object.prototype.hasOwnProperty.call(override, "requiresFeatures") ? override.requiresFeatures : base.requiresFeatures
    );
    const requiresCapabilities = normalizeAdvancedPanelKeyList(
      Object.prototype.hasOwnProperty.call(override, "requiresCapabilities") ? override.requiresCapabilities : base.requiresCapabilities
    );
    const order = Object.prototype.hasOwnProperty.call(override, "order") ? override.order : base.order;
    return Object.freeze({
      itemKey: String(itemKey || "").trim(),
      enabled: enabled === undefined ? undefined : !!enabled,
      regions,
      requiresFeatures,
      requiresCapabilities,
      order,
    });
  }

  function mergeAdvancedPanelRules(baseRules, profileRules) {
    const base = isPlainObject(baseRules) ? baseRules : {};
    const profile = isPlainObject(profileRules) ? profileRules : {};
    const keys = Array.from(new Set([...Object.keys(base), ...Object.keys(profile)]));
    const next = {};
    keys.forEach((itemKey) => {
      next[itemKey] = normalizeAdvancedPanelRule(itemKey, base[itemKey], profile[itemKey]);
    });
    return Object.freeze(next);
  }

  function resolveAdvancedPanelRegistry(adapter) {
    const profileRules = isPlainObject(adapter?.ui?.advancedPanels) ? adapter.ui.advancedPanels : {};
    return mergeAdvancedPanelRules(ADVANCED_PANEL_RULE_DEFAULTS, profileRules);
  }

  function evaluateAdvancedPanelVisibility(rule, ctx = {}) {
    const nextRule = isPlainObject(rule) ? rule : {};
    const features = isPlainObject(ctx?.features) ? ctx.features : {};
    const capabilities = isPlainObject(ctx?.capabilities) ? ctx.capabilities : {};
    const enabledPass = nextRule.enabled !== false;
    const featurePass = !Array.isArray(nextRule.requiresFeatures) || !nextRule.requiresFeatures.length
      ? true
      : nextRule.requiresFeatures.every((key) => !!features[key]);
    const capabilityPass = !Array.isArray(nextRule.requiresCapabilities) || !nextRule.requiresCapabilities.length
      ? true
      : nextRule.requiresCapabilities.every((key) => !!capabilities[key]);
    return enabledPass && featurePass && capabilityPass;
  }

  // ============================================================
  // Exports
  // ============================================================
  // Internal shared namespace for split files (core -> profiles).
  window.__DeviceRefactorCore = {
    clamp,
    DEFAULT_DEVICE_ID,
    VALID_DEVICE_IDS,
    normalizeDeviceId,
    toNumber,
    readBool,
    readNumber,
    normalizeDpiSlotArray,
    normalizeDpiLodValue,
    normalizeDpiLodArray,
    normalizeButtonMappingPatch,
    rapooTexts,
    atkTexts,
    ninjutsoTexts,
    razerTexts,
    KEYMAP_COMMON,
    TRANSFORMS_COMMON,
    readSurfaceFeelFallback,
    MAX_CONFIG_SLOT_COUNT,
    readEnabledConfigSlotCount,
    readActiveConfigSlotIndex,
    clampRazerStageCount,
    readRazerStages,
    stagesToDpiSlotsX,
    stagesToDpiSlotsY,
    stagesToDpiSlots,
    stagesToSlotCount,
    snapDpiByStep,
    defaultDpiSnapper,
    LOGITECH_DPI_STEP_SEGMENTS,
    snapDpiBySegments,
    NINJUTSO_LED_BRIGHTNESS_LEVELS,
    nearestFromList,
    toNinjutsoLedMode,
    fromNinjutsoLedMode,
    toNinjutsoLedBrightness,
    fromNinjutsoLedBrightness,
    normalizeHexColor,
    ADVANCED_PANEL_REGIONS,
    ADVANCED_PANEL_RULE_DEFAULTS,
    mergeAdvancedPanelRules,
    evaluateAdvancedPanelVisibility,
    resolveAdvancedPanelRegistry,
  };

  window.DeviceWriter = { writePatch };
  window.DeviceReader = { requestConfig, getCachedConfig, readStandardValue };
})();


